// 退職証明書：雛形 → 社員情報の差し込み → PDF → 証明書用の会社印を合成 → 発行（本人への公開は retire.js の publish）。
//
// POST /api/employees/retire-cert {action:"draft", employeeId, templateId?, includeReason?}
//        … 差し込み済みの本文（編集できる）・会社の情報・雛形の一覧・証明書用の印鑑の名前（画像は返さない）
// POST /api/employees/retire-cert {action:"company", representative, address}
//        … 証明書に印字する代表者名・会社住所を保存（会社ごとに1行。db/122）
// POST /api/employees/retire-cert {action:"preview", employeeId, body, includeReason?}
//        … 印なし・「プレビュー（未発行）」の透かし入りの PDF（base64）。発行はしない・保存しない
// POST /api/employees/retire-cert {action:"issue", employeeId, body, includeReason?, issuedOn?, sealId?}
//        … PDF を作り、証明書用の会社印を合成して保存し、「発行済み」の新しい版にする（公開はしない）
//
// ■ 誰ができるか
//   下書き・プレビュー・会社情報 … 人事・管理者（canManageHr）
//   発行・押印                   … 経営者・管理者だけ（canManageSeals）。人事だけでは押せない。退職者本人・一般メンバーは押せない
//
// ■ 印影は、サーバーの中だけで扱う
//   証明書用の印鑑（seal_type = certificate）の画像を Storage から取り出して PDF に合成する。
//   画像・URL・パスは、応答にも操作ログにも出さない。契約書用の印鑑（代表者印・角印など）は、ここでは使えない。
//
// ■ 発行済みは上書きしない
//   発行のたびに新しい版（再発行）。古い版は置き換え済みで残る。本人に見えるのは、公開中の最新の版だけ。
//
// ■ 記録（操作ログ）
//   retire.cert_draft（作成）・retire.cert_preview・retire.cert_company・retire.issue / retire.reissue
//   本文・印影・URL は残さない。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr, canManageSeals } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { renderCertificatePdf } from "../../lib/pdf-jp.js";
import { reasonLabel } from "../../lib/retire.js";
import { DEFAULT_TEMPLATE, mergeCertificate, certValues, CERT_MAX_CHARS } from "../../lib/retire-cert.js";
import { viewDoc } from "../../lib/retire-store.js";
import { loadCompany, certificateSeals, issueCertificate } from "../../lib/retire-cert-issue.js";
import { ymd } from "../../lib/jst.js";

const SQL = "db/121_retire_docs.sql";
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = admin();
  try {
    return await act(req, res, sb, ctx, user);
  } catch (e) {
    const hint = dbSetupHint(e, `${SQL}・db/122_certificate_seal.sql`);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[employees/retire-cert]", e?.message || e);
    return json(res, 500, { error: "cert_failed" });
  }
}

async function loadEmployee(sb, ctx, id) {
  if (!id) return null;
  return must(sb.from("gw_employees")
    .select("id, tenant_id, display_name, employment_type, joined_on, left_on, status")
    .eq("id", String(id)).eq("tenant_id", ctx.tenantId).maybeSingle());
}

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  const action = String(body?.action || "");

  if (action === "company") {
    const representative = String(body.representative || "").trim().slice(0, 60);
    const address = String(body.address || "").trim().slice(0, 200);
    await must(sb.from("gw_retire_company").upsert({
      tenant_id: ctx.tenantId, representative: representative || null, address: address || null,
      updated_by: user.id, updated_at: new Date().toISOString(),
    }, { onConflict: "tenant_id" }).select("tenant_id").maybeSingle());
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "retire.cert_company", target: `tenant:${ctx.tenantId}`, detail: {} });
    return json(res, 200, { ok: true });
  }

  const emp = await loadEmployee(sb, ctx, body?.employeeId);
  if (!emp) return json(res, 404, { error: "not_found" });
  const includeReason = body.includeReason === true;

  // 退職理由の名前（構造化した理由だけ。社内向けの補足は使わない）
  const c = await sb.from("gw_retire_cases").select("reason_code").eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).maybeSingle();
  const reason = reasonLabel(c.data?.reason_code);

  if (action === "draft") {
    const company = await loadCompany(sb, ctx);
    let template = DEFAULT_TEMPLATE;
    if (body.templateId) {
      const t = await sb.from("gw_doc_templates").select("body, kind")
        .eq("id", String(body.templateId)).eq("tenant_id", ctx.tenantId).maybeSingle();
      if (!t.data || !["offboarding", "general"].includes(t.data.kind)) return json(res, 404, { error: "template_not_found" });
      template = t.data.body;
    }
    const m = mergeCertificate(template, certValues({
      employee: emp, reasonLabel: reason, company, issuedOn: ymd(), issuedNo: "（発行時に付番）", includeReason,
    }));
    const tpls = await sb.from("gw_doc_templates").select("id, name").eq("tenant_id", ctx.tenantId).eq("kind", "offboarding").order("name");
    const seals = await certificateSeals(sb, ctx);
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "retire.cert_draft", target: `employee:${emp.id}`, detail: { templateId: body.templateId || null, includeReason } });
    return json(res, 200, {
      body: m.text, unresolved: m.unresolved,
      employee: { id: emp.id, name: emp.display_name, leftOn: emp.left_on, status: emp.status },
      company: { name: company.name, representative: company.representative, address: company.address, ready: company.ready },
      reason: { code: c.data?.reason_code || null, label: reason },
      templates: (tpls.data || []).map((t) => ({ id: t.id, name: t.name })),
      seals: seals.map((x) => ({ id: x.id, name: x.name })),     // 名前だけ。画像・パスは返さない
      canStamp: canManageSeals(ctx),
    });
  }

  if (action === "preview" || action === "issue") {
    const text = String(body.body || "").trim();
    if (!text) return json(res, 400, { error: "no_body", hint: "本文を入れてください" });
    if (text.length > CERT_MAX_CHARS) return json(res, 400, { error: "body_too_long", hint: `本文は${CERT_MAX_CHARS}字までにしてください` });
    const company = await loadCompany(sb, ctx);

    if (action === "preview") {
      // 印なし・透かし入り。保存しない
      const r = await renderCertificatePdf({
        title: "退職証明書", body: text, company: company.name, address: company.address, representative: company.representative,
        issuedOn: certValues({ issuedOn: ymd() }).発行日, issuedNo: "（未発行）", seal: null, watermark: "プレビュー（未発行）",
      });
      await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "retire.cert_preview", target: `employee:${emp.id}`, detail: {} });
      return json(res, 200, { pdfBase64: Buffer.from(r.bytes).toString("base64") });
    }

    // ---- 発行・押印（lib/retire-cert-issue.js。本人の申請を承認して発行するときと同じ処理）----
    if (!canManageSeals(ctx)) {
      return json(res, 403, { error: "seal_forbidden", hint: "発行・押印は、経営者・管理者だけができます" });
    }
    const done = await issueCertificate(sb, ctx, user, emp, { text, includeReason, issuedOn: body.issuedOn, sealId: body.sealId });
    if (done.status) return json(res, done.status, done.body);
    const seal = done.seal;
    const { row, live } = done;
    // 記録：本文・印影・URL・パスは残さない
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: live?.state === "issued" ? "retire.reissue" : "retire.issue",
      target: `employee:${emp.id}`,
      detail: { docId: row.id, kind: "certificate", version: row.version, issuedNo: row.issued_no, includeReason, sealId: seal.id, supersedes: live?.id || null },
    });
    return json(res, 200, { document: viewDoc(row) });
  }

  return json(res, 400, { error: "invalid_action", detail: "draft, company, preview, issue" });
}
