// GET  /api/hr/offers/public?token=…
//        … 候補者本人が、確定した合格通知（そのtokenに紐づくoffer versionだけ）を見る。
//          ログイン不要。gwContext() は使わない（README Stage 6 §16）
// POST /api/hr/offers/public { token, action, declineReason? }
//        "accept"  … 本人が承諾する
//        "decline" … 本人が辞退する（理由は任意）
//   ログイン不要。「承諾した」だけで gw_employees は作らない（README Stage 7）。
//   本採用へ進めるのは、HRが「本採用へ進める」を押してから（次のステージ）
//
// ■ 本人には、送った時点のスナップショットだけを返す
//   gw_hr_applicants の最新値ではなく gw_hr_offers を見る。ランク・5項目評価・
//   社内メモ・推薦理由・CEO REVIEWコメント・employee_id・tenant内部IDは
//   絶対に含めない（README Stage 6 §17・§21）。理由を問わず「開けません」で
//   統一する（billing-submission/publicと同じ考え方。在職/期限切れ/無効化を
//   外の人に区別させない）。採用担当の連絡先（氏名・メール）だけは例外
//   （本人が質問で連絡できることが目的そのものなので。README Stage 7）
//
// ■ 初回閲覧の記録
//   viewed_atが空なら、この時点でviewed_atを立てる。sent_atが（HRの押し忘れで）
//   まだ空でも、実際に開けた＝届いた証拠なのでここで一緒に埋める

import { json, readJson, dbSetupHint } from "../../../lib/http.js";
import { admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { notify } from "../../../lib/notify.js";
import { sha256, TOKEN_RE, shapePublicOffer, decisionMakerEmployeeIds } from "../../../lib/hr.js";

const SQL = "db/081_hr_recruiting.sql";
const CANT_OPEN = { error: "invalid_token", hint: "このURLは開けません。採用担当までお問い合わせください。" };
const EXPIRED = { error: "expired", hint: "このご案内の回答期限を過ぎています。恐れ入りますが、採用担当までお問い合わせください。" };

export default async function handler(req, res) {
  if (req.method === "GET") return view(req, res);
  if (req.method === "POST") return respond(req, res);
  return json(res, 405, { error: "method_not_allowed" });
}

// token → { offer, applicant, tenant, recruiter } を引く。無効な理由は問わず
// CANT_OPEN / EXPIRED のどちらかに統一する（呼び出し側で使い分ける）
async function findByToken(sb, token) {
  if (!TOKEN_RE.test(token)) return { deny: CANT_OPEN };

  const { data: offer, error } = await sb.from("gw_hr_offers").select("*")
    .eq("token_hash", sha256(token)).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return { deny: { status: 503, body: { error: "not_ready", message: hint } } };
    return { deny: { status: 500, body: { error: "db_query_failed" } } };
  }
  if (!offer || offer.revoked_at) return { deny: CANT_OPEN };
  if (new Date(offer.expires_at).getTime() < Date.now()) return { deny: EXPIRED, status: 410 };

  const { data: applicant } = await sb.from("gw_hr_applicants")
    .select("id, tenant_id, name, recruiter_id")
    .eq("id", offer.applicant_id).maybeSingle();
  if (!applicant) return { deny: CANT_OPEN };

  const [{ data: tenant }, { data: recruiter }] = await Promise.all([
    sb.from("tenants").select("name").eq("id", applicant.tenant_id).maybeSingle(),
    applicant.recruiter_id
      ? sb.from("gw_employees").select("display_name, email").eq("id", applicant.recruiter_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return { offer, applicant, tenant, recruiter };
}

async function view(req, res) {
  const token = new URL(req.url, "http://localhost").searchParams.get("token") || "";
  const sb = admin();

  const found = await findByToken(sb, token);
  if (found.deny) return json(res, found.status || 404, found.deny);
  const { offer, applicant, tenant, recruiter } = found;

  if (!offer.viewed_at) {
    const now = new Date().toISOString();
    await sb.from("gw_hr_offers").update({ viewed_at: now, sent_at: offer.sent_at || now }).eq("id", offer.id);
    // 閲覧できた＝以後は「本人の回答を待っています」（承諾待ち）。
    // 「閲覧した」という事実そのものはoffer.viewed_at・選考タイムラインに残す
    await sb.from("gw_hr_applicants").update({ status: "offer_response_pending", updated_at: now })
      .eq("id", applicant.id).eq("tenant_id", applicant.tenant_id);
    await sb.from("gw_hr_timeline").insert({
      tenant_id: applicant.tenant_id, applicant_id: applicant.id, event_key: "offer_viewed",
      label: "本人が合格通知を確認", detail: `第${offer.version}版`, created_by: null,
    });
    await gwLog({
      tenantId: applicant.tenant_id, actorId: null, action: "hr.offer_viewed",
      target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id },
    });
    offer.viewed_at = now; // レスポンスにも反映する
  }

  return json(res, 200, shapePublicOffer(offer, applicant, tenant, recruiter));
}

const DECLINE_REASON_MAX = 500;

async function respond(req, res) {
  const body = await readJson(req);
  const sb = admin();

  const found = await findByToken(sb, body?.token);
  if (found.deny) return json(res, found.status || 404, found.deny);
  const { offer, applicant } = found;

  // 本人の対応（承諾/辞退）を、担当（いなければ判断できる人）へ知らせる。
  // 通知は増やしすぎない：本人の動きのうち、ここだけ（README Stage 4と同じ考え方）
  const notifyOnResponse = async (title) => {
    const targets = applicant.recruiter_id
      ? [applicant.recruiter_id]
      : await decisionMakerEmployeeIds(sb, applicant.tenant_id);
    await notify(targets.map((employeeId) => ({
      tenantId: applicant.tenant_id, employeeId, kind: "hr", title,
      body: applicant.name, link: "/hr/applicants.html", dedupeKey: `hr_offer_response:${offer.id}`,
    })));
  };

  if (!["accept", "decline"].includes(body?.action)) {
    return json(res, 400, { error: "invalid_body", detail: "actionはaccept/declineのいずれかです" });
  }
  if (offer.accepted_at || offer.declined_at) {
    return json(res, 409, { error: "already_responded", hint: "すでに回答済みです" });
  }

  const now = new Date().toISOString();
  if (body.action === "accept") {
    await sb.from("gw_hr_offers").update({ accepted_at: now }).eq("id", offer.id);
    await sb.from("gw_hr_applicants").update({ status: "accepted", updated_at: now })
      .eq("id", applicant.id).eq("tenant_id", applicant.tenant_id);
    await sb.from("gw_hr_timeline").insert({
      tenant_id: applicant.tenant_id, applicant_id: applicant.id, event_key: "offer_accepted",
      label: "本人が承諾", detail: `第${offer.version}版`, created_by: null,
    });
    await gwLog({
      tenantId: applicant.tenant_id, actorId: null, action: "hr.offer_accepted",
      target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id },
    });
    await notifyOnResponse("候補者が合格通知を承諾しました");
  } else {
    const reason = String(body.declineReason ?? "").trim().slice(0, DECLINE_REASON_MAX) || null;
    await sb.from("gw_hr_offers").update({ declined_at: now, decline_reason: reason }).eq("id", offer.id);
    await sb.from("gw_hr_applicants").update({ status: "declined", updated_at: now })
      .eq("id", applicant.id).eq("tenant_id", applicant.tenant_id);
    await sb.from("gw_hr_timeline").insert({
      tenant_id: applicant.tenant_id, applicant_id: applicant.id, event_key: "offer_declined",
      label: "本人が辞退", detail: reason, created_by: null,
    });
    await gwLog({
      tenantId: applicant.tenant_id, actorId: null, action: "hr.offer_declined",
      target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id, hasReason: Boolean(reason) },
    });
    await notifyOnResponse("候補者が合格通知を辞退しました");
  }

  return json(res, 200, { ok: true, responseStatus: body.action === "accept" ? "accepted" : "declined" });
}
