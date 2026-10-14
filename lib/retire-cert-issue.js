// 退職証明書の発行・押印（PDF を作り、証明書用の会社印を合成して保存し、「発行済み」の新しい版にする）。
// api/employees/retire-cert.js（人事が本文を整えて発行）と api/employees/cert-request.js（本人の申請を承認して発行）が共有する。
//
// ■ 決まりごと（ここで守る）
//   発行・押印は経営者・管理者だけ（呼ぶ側で canManageSeals を確かめる）。退職手続き中・退職の人だけ。退職日が要る。
//   本文に {{…}} が残っていたら発行しない。会社名・代表者名・会社住所が要る。印は証明書用（seal_type = certificate）だけ。
//   印影の画像はサーバーの中だけで扱う（応答にも操作ログにも出さない）。発行済みは上書きせず、新しい版にする。

import crypto from "node:crypto";
import { renderCertificatePdf, sha256 } from "./pdf-jp.js";
import { retirePath, issuedNo as fmtNo } from "./retire.js";
import { certValues, leftoverFields } from "./retire-cert.js";
import { putIssued } from "./retire-store.js";
import { ymd } from "./jst.js";

const BUCKET = "hr";
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s));

/** 会社の情報（会社名は tenants.name、代表者名・住所は gw_retire_company）。db/122 が未適用でも、会社名だけで動かす */
export async function loadCompany(sb, ctx) {
  const t = await must(sb.from("tenants").select("name").eq("id", ctx.tenantId).maybeSingle());
  let c = null;
  const q = await sb.from("gw_retire_company").select("representative, address").eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!q.error) c = q.data;
  return { name: t?.name || "", representative: c?.representative || "", address: c?.address || "", ready: !q.error };
}

/** 証明書用の印鑑だけ（有効なもの）。契約書用の印鑑は、ここには出てこない */
export async function certificateSeals(sb, ctx) {
  const q = await sb.from("gw_seals")
    .select("id, name, seal_type, image_path, image_mime, image_sha256, is_active, sort_order")
    .eq("tenant_id", ctx.tenantId).eq("seal_type", "certificate").eq("is_active", true).order("sort_order");
  if (q.error) return [];
  return q.data || [];
}

/**
 * 発行・押印する。だめなときは {status, body}、できたら {row, live, seal}
 * @param {{text:string, includeReason:boolean, issuedOn?:string, sealId?:string, fileName?:string}} o
 */
export async function issueCertificate(sb, ctx, user, emp, o) {
  const text = String(o.text || "");
  if (!["leaving", "left"].includes(emp.status)) {
    return { status: 409, body: { error: "not_leaving", hint: "退職手続き中・退職の人だけ、証明書を発行できます" } };
  }
  if (!emp.left_on) return { status: 400, body: { error: "no_left_on", hint: "退職日を入れてから発行してください" } };
  const left = leftoverFields(text);
  if (left.length) return { status: 400, body: { error: "unresolved_fields", fields: left, hint: `差し込み項目が残っています：${left.join("、")}` } };
  const company = await loadCompany(sb, ctx);
  if (!company.name || !company.representative || !company.address) {
    return { status: 400, body: { error: "company_incomplete", hint: "会社名・代表者名・会社住所を入れてください（代表者名と住所は、証明書の画面で保存できます）" } };
  }
  const issuedOn = o.issuedOn ? String(o.issuedOn) : ymd();
  if (!isDate(issuedOn)) return { status: 400, body: { error: "invalid_date", hint: "発行日を日付で入れてください" } };

  const seals = await certificateSeals(sb, ctx);
  const seal = o.sealId ? seals.find((x) => x.id === String(o.sealId)) : seals[0];
  if (!seal) {
    return { status: 409, body: { error: "no_certificate_seal", hint: "証明書発行用の印鑑が登録されていません。署名の画面の「印鑑」で、種類「証明書発行用印」を登録してください" } };
  }
  const dl = await sb.storage.from(BUCKET).download(seal.image_path);
  if (dl.error || !dl.data) return { status: 500, body: { error: "seal_image_missing", hint: "印鑑の画像を読み出せませんでした" } };
  const sealBytes = Buffer.from(await dl.data.arrayBuffer());
  if (seal.image_sha256 && sha256(sealBytes) !== seal.image_sha256) {
    return { status: 500, body: { error: "seal_hash_mismatch", hint: "印鑑の画像が登録時と一致しません。印鑑を登録し直してください" } };
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
        path, sha256: sha256(bytes), size: bytes.length, issuedOn, fileName: o.fileName || `退職証明書_${emp.display_name}.pdf`,
        extra: { issued_no: no, include_reason: Boolean(o.includeReason), body_snapshot: text },
      });
    } catch (e) {
      await sb.storage.from(BUCKET).remove([path]);
      lastErr = e;
      if (e?.code !== "23505") break;      // 発行番号が重なったときだけ、番号を取り直す
    }
  }
  if (!done) throw lastErr || new Error("issue_failed");
  return { ...done, seal };
}
