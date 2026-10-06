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

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr, canManageSeals } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { renderCertificatePdf, sha256 } from "../../lib/pdf-jp.js";
import { reasonLabel, retirePath, issuedNo as fmtNo } from "../../lib/retire.js";
import { DEFAULT_TEMPLATE, mergeCertificate, certValues, leftoverFields, CERT_MAX_CHARS } from "../../lib/retire-cert.js";
import { putIssued, viewDoc } from "../../lib/retire-store.js";
import { ymd } from "../../lib/jst.js";

const BUCKET = "hr";
const SQL = "db/121_retire_docs.sql";
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s));

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

/** 会社の情報（会社名は tenants.name、代表者名・住所は gw_retire_company）。db/122 が未適用でも、会社名だけで動かす */
async function loadCompany(sb, ctx) {
  const t = await must(sb.from("tenants").select("name").eq("id", ctx.tenantId).maybeSingle());
  let c = null;
  const q = await sb.from("gw_retire_company").select("representative, address").eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!q.error) c = q.data;
  return { name: t?.name || "", representative: c?.representative || "", address: c?.address || "", ready: !q.error };
}

/** 証明書用の印鑑だけ（有効なもの）。契約書用の印鑑は、ここには出てこない */
async function certificateSeals(sb, ctx) {
  const q = await sb.from("gw_seals")
    .select("id, name, seal_type, image_path, image_mime, image_sha256, is_active, sort_order")
    .eq("tenant_id", ctx.tenantId).eq("seal_type", "certificate").eq("is_active", true).order("sort_order");
  if (q.error) return [];
  return q.data || [];
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

    // ---- 発行・押印 ----
    if (!canManageSeals(ctx)) {
      return json(res, 403, { error: "seal_forbidden", hint: "発行・押印は、経営者・管理者だけができます" });
    }
    if (!["leaving", "left"].includes(emp.status)) {
      return json(res, 409, { error: "not_leaving", hint: "退職手続き中・退職の人だけ、証明書を発行できます" });
    }
    if (!emp.left_on) return json(res, 400, { error: "no_left_on", hint: "退職日を入れてから発行してください" });
    const left = leftoverFields(text);
    if (left.length) return json(res, 400, { error: "unresolved_fields", fields: left, hint: `差し込み項目が残っています：${left.join("、")}` });
    if (!company.name || !company.representative || !company.address) {
      return json(res, 400, { error: "company_incomplete", hint: "会社名・代表者名・会社住所を入れてください（代表者名と住所は、証明書の画面で保存できます）" });
    }
    const issuedOn = body.issuedOn ? String(body.issuedOn) : ymd();
    if (!isDate(issuedOn)) return json(res, 400, { error: "invalid_date", hint: "発行日を日付で入れてください" });

    // 証明書用の印鑑（契約書用は使えない）。画像はサーバーの中だけで扱う
    const seals = await certificateSeals(sb, ctx);
    const seal = body.sealId ? seals.find((x) => x.id === String(body.sealId)) : seals[0];
    if (!seal) {
      return json(res, 409, { error: "no_certificate_seal", hint: "証明書発行用の印鑑が登録されていません。署名の画面の「印鑑」で、種類「証明書発行用印」を登録してください" });
    }
    const dl = await sb.storage.from(BUCKET).download(seal.image_path);
    if (dl.error || !dl.data) return json(res, 500, { error: "seal_image_missing", hint: "印鑑の画像を読み出せませんでした" });
    const sealBytes = Buffer.from(await dl.data.arrayBuffer());
    if (seal.image_sha256 && sha256(sealBytes) !== seal.image_sha256) {
      return json(res, 500, { error: "seal_hash_mismatch", hint: "印鑑の画像が登録時と一致しません。印鑑を登録し直してください" });
    }
    const sealMime = seal.image_mime === "image/jpeg" ? "image/jpeg" : "image/png";

    const year = issuedOn.slice(0, 4);
    let done = null, lastErr = null;
    for (let attempt = 0; attempt < 4 && !done; attempt++) {
      const rows = (await must(sb.from("gw_retire_docs").select("issued_no").eq("tenant_id", ctx.tenantId).eq("kind", "certificate"))) || [];
      const used = rows.map((r) => String(r.issued_no || "")).filter((n) => n.startsWith(`RET-${year}-`)).map((n) => Number(n.split("-")[2]) || 0);
      const no = fmtNo(year, Math.max(0, ...used) + 1 + attempt);
      const r = await renderCertificatePdf({
        title: "退職証明書", body: text, company: company.name, address: company.address, representative: company.representative,
        issuedOn: certValues({ issuedOn }).発行日, issuedNo: no, seal: { bytes: sealBytes, mime: sealMime },
      });
      const bytes = Buffer.from(r.bytes);
      const path = retirePath(ctx.tenantId, emp.id, "certificate", crypto.randomUUID());
      const up = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: false });
      if (up.error) { lastErr = up.error; break; }
      try {
        done = await putIssued(sb, ctx, user, emp, "certificate", {
          path, sha256: sha256(bytes), size: bytes.length, issuedOn, fileName: `退職証明書_${emp.display_name}.pdf`,
          extra: { issued_no: no, include_reason: includeReason, body_snapshot: text },
        });
      } catch (e) {
        await sb.storage.from(BUCKET).remove([path]);
        lastErr = e;
        if (e?.code !== "23505") break;      // 発行番号が重なったときだけ、番号を取り直す
      }
    }
    if (!done) throw lastErr || new Error("issue_failed");
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
