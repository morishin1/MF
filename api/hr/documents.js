// 採用の応募書類（履歴書・職務経歴書・スキルシート・その他）と、採用条件書類（内定通知書・労働条件通知書・承諾済みPDF）の状態
//
// GET    /api/hr/documents?applicantId=…            … 種類ごとの最新と、過去の版。conditionDocs＝採用条件書類の状態
//                                                    （オファー gw_hr_offers の列から出す。ファイルは持たない。lib/hr-condition-docs.js）
// GET    /api/hr/documents?id=…[&applicantId=…][&download=1]
//                                                  … 見る・保存するための URL（数分だけ有効）。
//                                                    書類プレビュー（hr/document.html・別タブ）もこれを使う
// POST   /api/hr/documents {action:"upload", applicantId, docType, mimeType, sizeBytes}
//                                                  … 置き場所（signed upload URL）を出す
// POST   /api/hr/documents {action:"attach", applicantId, docType, path, filename}
//                                                  … 置いた実体を確かめて登録する（差し替え＝新しい版）
// DELETE /api/hr/documents?id=…                     … 1つの版を消す（実体は消し、記録は残す）
//
// ■ 誰が使えるか
//   採用を扱える人（canRecruit：管理者・経営者・人事・採用担当）… 見る・登録・差し替え・削除。
//   Office の人事・労務（canOfficeHr。採用HRの権限は無い人）… 「Office へ引き渡された人」の書類を見るだけ（閲覧専用。readOnly）。
//     HR で登録した原本を Office で再登録させない（二重管理しない）ための口。service role で読むので、次をすべて API で確かめる：
//       ① 同一テナント（応募者・書類・オファーのどれも tenant_id で絞る）
//       ② 引き渡し済み（その応募者に handoff_at の入った版がある。承諾しただけ・育成枠は見せない）、または
//          早期引き渡し（db/143。機能フラグ HR_OFFICE_INTAKE が ON のとき）を受けた人（差し戻していない引き渡しがある）
//       ③ Office の人事権限（canOfficeHr）
//       ④ 対象の応募者本人の書類だけ（書類 → 応募者 → 引き渡し済み、の順にたどる。applicantId を渡したら、書類の持ち主と一致すること）
//     登録・差し替え・削除は 403（Office からはできない）。見せるのは各種類の最新の1つだけ（過去の版は HR で見る）。
//   営業だけの人（canSell のみ）には、一覧も URL も返さない。
//
// ■ 個人情報なので、公開URLを作らない
//   既存の private バケット hr の <tenant>/recruit/<applicant>/<uuid>.<ext> に置き、
//   見るときだけ短時間の signed URL を出す。操作ログには URL を入れない。

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit, canOfficeHr, canSeeSalary } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  DOC_TYPES, DOC_TYPE_KEYS, DOC_ACCEPT, DOC_MAX_BYTES, docTypeLabel,
  checkDeclaredDoc, checkDocBytes, cleanFilename, groupDocs,
} from "../../lib/hr-docs.js";
import { conditionDocsOf } from "../../lib/hr-condition-docs.js";
import { readHandoffOffers } from "../../lib/hire-handoff.js";
import { intakeEnabled, activeIntakeOf } from "../../lib/hr-office-intake.js";

const BUCKET = "hr";
const TTL = 60 * 5;
const SQL = "db/093_hr_documents.sql";
const SKILL_SQL = "db/135_hr_document_skill_sheet.sql";
const FIELDS = "id, tenant_id, applicant_id, doc_type, filename, storage_path, mime_type, size_bytes, sha256, "
  + "uploaded_by, deleted_at, created_at";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 採用書類は個人情報。採用を扱える人か、Office の人事・労務（引き渡された人の書類を見るだけ）以外には何も返さない（営業だけの人を含む）
  const recruit = canRecruit(ctx);
  const office = !recruit && canOfficeHr(ctx);
  if (!recruit && !office) return json(res, 403, { error: "forbidden" });
  // Office からは登録・差し替え・削除できない（HR で登録した原本を、Office は見るだけ）
  if (office && req.method !== "GET") {
    return json(res, 403, { error: "read_only", hint: "書類の登録・差し替え・削除は採用HRで行います。Office では見るだけです" });
  }

  const sb = admin();
  try {
    if (req.method === "GET") return await read(req, res, sb, ctx, user, office);
    if (req.method === "POST") return await act(req, res, sb, ctx, user);
    if (req.method === "DELETE") return await remove(req, res, sb, ctx, user);
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[hr/documents]", e?.message || e);
    return json(res, 500, { error: "documents_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST", "DELETE"]);
}

const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

async function loadApplicant(sb, ctx, id) {
  if (!id) return null;
  return must(sb.from("gw_hr_applicants").select("id, tenant_id, name")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle());
}

/**
 * Office から見てよい応募者か：引き渡した版（handoff_at が入っていて、承諾済みで、無効化・辞退でなく、育成枠でない）がある。
 * 同一テナントで読む（readHandoffOffers が tenant_id で絞る）。見てよければ、その版（最新の引き渡し）を返す。見てはいけなければ null
 */
async function handedOffOffer(sb, ctx, applicantId) {
  if (!applicantId) return null;
  const { ready, offers } = await readHandoffOffers(sb, ctx.tenantId, { applicantIds: [applicantId] });
  if (!ready) return null;
  return offers.find((o) => o.applicant_id === applicantId && o.tenant_id === ctx.tenantId) || null;
}
/**
 * 早期引き渡し（db/143）を受けた人か（フラグ ON のときだけ。差し戻した引き渡しは数えない。辞退・不成立のあとも履歴として見られる）。
 * 読めないときは見せない（null）
 */
async function intakeOf(sb, ctx, applicantId) {
  if (!applicantId || !intakeEnabled()) return null;
  try { return await activeIntakeOf(sb, ctx.tenantId, applicantId); } catch { return null; }
}
const notHandedOff = (res) => json(res, 403, { error: "not_handed_off", hint: "Office へ引き渡された方の書類だけ、Office から見られます（採用HRで引き渡しを済ませてください）" });

const view = (r, names) => ({
  id: r.id, docType: r.doc_type, docTypeLabel: docTypeLabel(r.doc_type),
  filename: r.filename, mimeType: r.mime_type, sizeBytes: r.size_bytes,
  uploadedAt: r.created_at, uploadedByName: names.get(r.uploaded_by) || null,
});

async function read(req, res, sb, ctx, user, office = false) {
  const q = new URL(req.url, "http://localhost").searchParams;
  if (q.get("id")) return fileUrl(res, sb, ctx, user, q.get("id"), q.get("download") === "1", q.get("applicantId"), office);

  const a = await loadApplicant(sb, ctx, q.get("applicantId"));
  if (!a) return json(res, 404, { error: "not_found" });
  // Office（閲覧専用）：引き渡された人だけ。引き渡した版の書類状態と、各種類の最新の1つだけを返す
  const handed = office ? await handedOffOffer(sb, ctx, a.id) : null;
  const intake = office && !handed ? await intakeOf(sb, ctx, a.id) : null;
  if (office && !handed && !intake) return notHandedOff(res);
  const rows = await must(sb.from("gw_hr_documents").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("applicant_id", a.id).order("created_at", { ascending: false }));

  // アップロードした人の名前（社員名簿の user_id から）
  const ids = [...new Set((rows || []).map((r) => r.uploaded_by).filter(Boolean))];
  const emps = ids.length ? await must(sb.from("gw_employees").select("user_id, display_name")
    .eq("tenant_id", ctx.tenantId).in("user_id", ids)) : [];
  const names = new Map((emps || []).map((e) => [e.user_id, e.display_name]));

  const g = groupDocs(rows);
  // 採用条件書類（内定通知書・労働条件通知書・承諾済みPDF）。オファーの列から出す。読めなくても応募書類は返す
  let conditionDocs = null;
  try {
    const offers = office && handed ? [handed]
      : await must(sb.from("gw_hr_offers").select("*").eq("tenant_id", ctx.tenantId).eq("applicant_id", a.id)
        .order("version", { ascending: false }));
    conditionDocs = conditionDocsOf(offers);
  } catch (e) { console.error("[hr/documents] condition docs", e?.message || e); }
  return json(res, 200, {
    applicant: { id: a.id, name: a.name },
    conditionDocs,
    // Office は見るだけ。条件通知書PDF・承諾済みPDF（給与・報酬が入る）は、給与を見られる人だけ開ける（api/hr/offers の file）
    ...(office ? { readOnly: true, salaryVisible: canSeeSalary(ctx), offerId: handed?.id || null, ...(intake ? { officeIntakeId: intake.id } : {}) } : {}),
    documents: DOC_TYPES.map((t) => ({
      docType: t.key, label: t.label, icon: t.icon,
      latest: g[t.key].latest ? view(g[t.key].latest, names) : null,
      history: office ? [] : g[t.key].history.map((r) => view(r, names)),
    })),
    types: DOC_TYPES,
    limits: { maxBytes: DOC_MAX_BYTES, accept: DOC_ACCEPT },
  });
}

async function fileUrl(res, sb, ctx, user, id, download, applicantId, office = false) {
  const r = await must(sb.from("gw_hr_documents").select(FIELDS).eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!r || r.deleted_at) return json(res, 404, { error: "not_found" });
  // プレビューのURL（?applicant=…&doc=…）で、別の応募者の書類を指していないか
  if (applicantId && r.applicant_id !== applicantId) return json(res, 404, { error: "not_found" });
  const a = await loadApplicant(sb, ctx, r.applicant_id);
  // Office（閲覧専用）：書類の持ち主（応募者）が、同一テナントで、Office へ引き渡された人であること。書類の ID だけでは見せない
  if (office && (!a || !((await handedOffOffer(sb, ctx, r.applicant_id)) || (await intakeOf(sb, ctx, r.applicant_id))))) return notHandedOff(res);
  const { data, error } = await sb.storage.from(BUCKET)
    .createSignedUrl(r.storage_path, TTL, download ? { download: r.filename } : undefined);
  if (error) return json(res, 404, { error: "file_missing", detail: error.message });
  // 誰がいつ見た・保存したか（URL は残さない）
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: download ? "hr.document.download" : "hr.document.view",
    target: `hr_applicant:${r.applicant_id}`, detail: { documentId: r.id, docType: r.doc_type, ...(office ? { via: "office" } : {}) },
  });
  return json(res, 200, {
    url: data.signedUrl, filename: r.filename, mimeType: r.mime_type, download, expiresIn: TTL,
    applicantId: r.applicant_id, applicantName: a?.name || null,
    docType: r.doc_type, docTypeLabel: docTypeLabel(r.doc_type),
  });
}

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  const a = await loadApplicant(sb, ctx, body?.applicantId);
  if (!a) return json(res, 404, { error: "not_found" });
  const docType = DOC_TYPE_KEYS.includes(body?.docType) ? body.docType : null;
  if (!docType) return json(res, 400, { error: "invalid_doc_type", hint: "書類の種類を選んでください" });

  if (body.action === "upload") {
    const d = checkDeclaredDoc(body);
    if (!d.ok) return json(res, 400, d);
    // 差し替えのたびに別のパス（上書きしない。前の版を残す）
    const path = `${ctx.tenantId}/recruit/${a.id}/${crypto.randomUUID()}.${d.ext}`;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) return json(res, 500, { error: "sign_failed", detail: error.message });
    return json(res, 200, { path, uploadUrl: data.signedUrl, token: data.token });
  }

  if (body.action === "attach") {
    const path = String(body.path || "");
    // 置き場所を自分で指定できてしまうと、他の応募者・他社・契約書のファイルを掴める
    const prefix = `${ctx.tenantId}/recruit/${a.id}/`;
    if (!path.startsWith(prefix) || !/^[\w-]+\.(pdf|doc|docx|jpg|png)$/.test(path.slice(prefix.length))) {
      return json(res, 403, { error: "forbidden" });
    }
    const dl = await sb.storage.from(BUCKET).download(path);
    if (dl.error || !dl.data) return json(res, 400, { error: "no_file", hint: "置いたファイルを読めませんでした" });
    const bytes = Buffer.from(await dl.data.arrayBuffer());
    const c = checkDocBytes(bytes);
    if (!c.ok) {
      await sb.storage.from(BUCKET).remove([path]);
      return json(res, 400, c);
    }
    const now = new Date().toISOString();
    const ins = await sb.from("gw_hr_documents").insert({
      tenant_id: ctx.tenantId, applicant_id: a.id, doc_type: docType,
      filename: cleanFilename(body.filename), storage_path: path, mime_type: c.mime,
      size_bytes: bytes.length, sha256: sha256(bytes), uploaded_by: user.id, created_at: now, updated_at: now,
    }).select(FIELDS).single();
    if (ins.error) {
      // スキルシートは db/135 で種類に加わった。まだ流していない環境では、CHECK（23514）で断られる
      if (docType === "skill_sheet" && ins.error.code === "23514") {
        await sb.storage.from(BUCKET).remove([path]);
        return json(res, 503, { error: "not_ready", message: `スキルシートを登録するには、${SKILL_SQL} を Supabase に流してください` });
      }
      throw ins.error;
    }
    const row = ins.data;
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "hr.document.upload",
      target: `hr_applicant:${a.id}`, detail: { documentId: row.id, docType, filename: row.filename, size: row.size_bytes },
    });
    return json(res, 200, { document: view(row, new Map()) });
  }

  return json(res, 400, { error: "invalid_action", detail: "upload, attach" });
}

async function remove(req, res, sb, ctx, user) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  const r = id ? await must(sb.from("gw_hr_documents").select(FIELDS).eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle()) : null;
  if (!r || r.deleted_at) return json(res, 404, { error: "not_found" });
  // 実体は消す（個人情報を残さない）。行は「誰がいつ消したか」のために残す
  await sb.storage.from(BUCKET).remove([r.storage_path]);
  const now = new Date().toISOString();
  await must(sb.from("gw_hr_documents").update({ deleted_at: now, deleted_by: user.id, updated_at: now })
    .eq("id", r.id).eq("tenant_id", ctx.tenantId).select("id").maybeSingle());
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.document.delete",
    target: `hr_applicant:${r.applicant_id}`, detail: { documentId: r.id, docType: r.doc_type, filename: r.filename },
  });
  return json(res, 200, { ok: true });
}
