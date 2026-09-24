// GET  /api/billing-submission/public?token=…
//        … 窓口の中身（本人名・会社名・対象の現場契約）を確認する
// POST /api/billing-submission/public { token, targetMonth, kind, siteContractId,
//                                        filename, mimeType, sizeBytes }
//        … 届け先を用意する。返る uploadUrl へPDFをPUTすればアップロード完了
//
// ログイン不要（外部会社・BPが対象）。トークンが「誰の、どの契約の分か」を
// 保証する。1回使ったら終わりの招待（gw_guest_invites）とは違い、
// 同じ窓口を毎月使い回す。
//
// アップロードは署名付きURL方式（api/messages/upload.js と同じ考え方）。
// 見ず知らずの相手に service_role の権限は渡さず、この1件・この経路だけ
// 書き込める短い署名だけを渡す。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  sha256, TOKEN_RE, linkStatus, normalizeSubmission, PROGRESS_STAGE,
} from "../../lib/billing-submission.js";

const SQL = "db/080_billing_submission.sql";
const BUCKET = "billing-submissions";

export default async function handler(req, res) {
  if (req.method === "GET") return preview(req, res);
  if (req.method === "POST") return submit(req, res);
  return methodNotAllowed(res, ["GET", "POST"]);
}

// 有効な窓口を1件だけ引く。理由を問わず「使えません」で統一する
// （在職/退職・期限切れ・無効化のどれも、外の人には区別させない）
async function findLink(sb, token) {
  if (!TOKEN_RE.test(String(token || ""))) return null;
  const { data: link } = await sb.from("gw_submission_links")
    .select("id, tenant_id, employee_id, expires_at, revoked_at")
    .eq("token_hash", sha256(token)).limit(1).maybeSingle();
  if (!link || linkStatus(link) !== "active") return null;
  return link;
}

async function preview(req, res) {
  const token = new URL(req.url, "http://localhost").searchParams.get("token") || "";
  const sb = admin();

  let link;
  try {
    link = await findLink(sb, token);
  } catch (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    throw error;
  }
  if (!link) return json(res, 404, { error: "invalid_token", hint: "このURLは使えません。発行者に再発行を依頼してください" });

  const [{ data: emp }, { data: tenant }, { data: contracts }] = await Promise.all([
    sb.from("gw_employees").select("display_name, status").eq("id", link.employee_id).maybeSingle(),
    sb.from("tenants").select("name").eq("id", link.tenant_id).maybeSingle(),
    sb.from("gw_site_contracts")
      .select("id, engagement_kind, site_company, prime_company, period_from, period_to")
      .eq("employee_id", link.employee_id).order("period_from", { ascending: false }).limit(20),
  ]);
  if (!emp) return json(res, 404, { error: "invalid_token" });

  return json(res, 200, {
    displayName: emp.display_name,
    tenantName: tenant?.name || null,
    contracts: (contracts || []).map((c) => ({
      id: c.id, siteCompany: c.site_company, primeCompany: c.prime_company,
      engagementKind: c.engagement_kind,
      active: !c.period_to || c.period_to >= new Date().toISOString().slice(0, 10),
    })),
  });
}

async function submit(req, res) {
  const body = await readJson(req);
  const sb = admin();

  let link;
  try {
    link = await findLink(sb, body?.token);
  } catch (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    throw error;
  }
  if (!link) return json(res, 404, { error: "invalid_token", hint: "このURLは使えません。発行者に再発行を依頼してください" });

  const row = normalizeSubmission(body);
  if (row.error) return json(res, 400, row);
  const v = row.value;

  // 渡された契約が、本当にこの窓口の本人のものか確かめる。
  // ここを飛ばすと、他人の契約IDを渡して紐付け先を差し替えられてしまう
  const { data: contract } = await sb.from("gw_site_contracts").select("id")
    .eq("id", v.siteContractId).eq("employee_id", link.employee_id).maybeSingle();
  if (!contract) return json(res, 400, { error: "invalid_contract", hint: "対象の現場契約が見つかりません" });

  const ext = v.filename.includes(".") ? v.filename.split(".").pop().toLowerCase().slice(0, 8) : "bin";
  const submissionId = crypto.randomUUID();
  const storagePath = `${link.tenant_id}/${link.employee_id}/${submissionId}.${ext}`;

  const { error: ie } = await sb.from("gw_submissions").insert({
    id: submissionId, tenant_id: link.tenant_id, employee_id: link.employee_id,
    site_contract_id: v.siteContractId, target_month: v.targetMonth, kind: v.kind,
    file_name: v.filename, mime_type: v.mimeType, size_bytes: v.sizeBytes, storage_path: storagePath,
  });
  if (ie) {
    const hint = dbSetupHint(ie, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: ie.message });
  }

  const { data: signed, error: se } = await sb.storage.from(BUCKET).createSignedUploadUrl(storagePath);
  if (se) {
    await sb.from("gw_submissions").delete().eq("id", submissionId);
    return json(res, 500, { error: "sign_failed", detail: se.message });
  }

  // 既存の月次請求進捗（gw_billing_progress、db/077）へつなぐ。
  // 届いた＝その印を立てるだけ。進捗の段階じたいは増やさない
  const stage = PROGRESS_STAGE[v.kind];
  const now = new Date().toISOString();
  const { data: existing } = await sb.from("gw_billing_progress").select("id")
    .eq("tenant_id", link.tenant_id).eq("employee_id", link.employee_id)
    .eq("site_contract_id", v.siteContractId).eq("billing_month", v.targetMonth).maybeSingle();
  if (existing) {
    await sb.from("gw_billing_progress")
      .update({ [stage]: true, [`${stage}_at`]: now, updated_at: now }).eq("id", existing.id);
  } else {
    await sb.from("gw_billing_progress").insert({
      tenant_id: link.tenant_id, employee_id: link.employee_id,
      site_contract_id: v.siteContractId, billing_month: v.targetMonth,
      [stage]: true, [`${stage}_at`]: now,
    });
  }

  await gwLog({
    tenantId: link.tenant_id, actorId: null, action: "billing_submission.received",
    target: `submission:${submissionId}`,
    detail: { employeeId: link.employee_id, kind: v.kind, targetMonth: v.targetMonth, fileName: v.filename },
  });

  return json(res, 200, { submissionId, uploadUrl: signed.signedUrl, token: signed.token });
}
