// 採用の応募書類（履歴書・職務経歴書・その他）
//
// GET    /api/hr/documents?applicantId=…            … 種類ごとの最新と、過去の版
// GET    /api/hr/documents?id=…[&download=1]        … 見る・保存するための URL（数分だけ有効）
// POST   /api/hr/documents {action:"upload", applicantId, docType, mimeType, sizeBytes}
//                                                  … 置き場所（signed upload URL）を出す
// POST   /api/hr/documents {action:"attach", applicantId, docType, path, filename}
//                                                  … 置いた実体を確かめて登録する（差し替え＝新しい版）
// DELETE /api/hr/documents?id=…                     … 1つの版を消す（実体は消し、記録は残す）
//
// ■ 誰が使えるか
//   採用を扱える人（canRecruit：管理者・経営者・人事・採用担当）だけ。
//   営業だけの人（canSell のみ）には、一覧も URL も返さない。
//
// ■ 個人情報なので、公開URLを作らない
//   既存の private バケット hr の <tenant>/recruit/<applicant>/<uuid>.<ext> に置き、
//   見るときだけ短時間の signed URL を出す。操作ログには URL を入れない。

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  DOC_TYPES, DOC_TYPE_KEYS, DOC_ACCEPT, DOC_MAX_BYTES, docTypeLabel,
  checkDeclaredDoc, checkDocBytes, cleanFilename, groupDocs,
} from "../../lib/hr-docs.js";

const BUCKET = "hr";
const TTL = 60 * 5;
const SQL = "db/093_hr_documents.sql";
const FIELDS = "id, tenant_id, applicant_id, doc_type, filename, storage_path, mime_type, size_bytes, sha256, "
  + "uploaded_by, deleted_at, created_at";
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 採用書類は個人情報。採用を扱えない人（営業だけの人を含む）には何も返さない
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = admin();
  try {
    if (req.method === "GET") return await read(req, res, sb, ctx);
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

const view = (r, names) => ({
  id: r.id, docType: r.doc_type, docTypeLabel: docTypeLabel(r.doc_type),
  filename: r.filename, mimeType: r.mime_type, sizeBytes: r.size_bytes,
  uploadedAt: r.created_at, uploadedByName: names.get(r.uploaded_by) || null,
});

async function read(req, res, sb, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  if (q.get("id")) return fileUrl(res, sb, ctx, q.get("id"), q.get("download") === "1");

  const a = await loadApplicant(sb, ctx, q.get("applicantId"));
  if (!a) return json(res, 404, { error: "not_found" });
  const rows = await must(sb.from("gw_hr_documents").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("applicant_id", a.id).order("created_at", { ascending: false }));

  // アップロードした人の名前（社員名簿の user_id から）
  const ids = [...new Set((rows || []).map((r) => r.uploaded_by).filter(Boolean))];
  const emps = ids.length ? await must(sb.from("gw_employees").select("user_id, display_name")
    .eq("tenant_id", ctx.tenantId).in("user_id", ids)) : [];
  const names = new Map((emps || []).map((e) => [e.user_id, e.display_name]));

  const g = groupDocs(rows);
  return json(res, 200, {
    applicant: { id: a.id, name: a.name },
    documents: DOC_TYPES.map((t) => ({
      docType: t.key, label: t.label, icon: t.icon,
      latest: g[t.key].latest ? view(g[t.key].latest, names) : null,
      history: g[t.key].history.map((r) => view(r, names)),
    })),
    types: DOC_TYPES,
    limits: { maxBytes: DOC_MAX_BYTES, accept: DOC_ACCEPT },
  });
}

async function fileUrl(res, sb, ctx, id, download) {
  const r = await must(sb.from("gw_hr_documents").select(FIELDS).eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!r || r.deleted_at) return json(res, 404, { error: "not_found" });
  const { data, error } = await sb.storage.from(BUCKET)
    .createSignedUrl(r.storage_path, TTL, download ? { download: r.filename } : undefined);
  if (error) return json(res, 404, { error: "file_missing", detail: error.message });
  return json(res, 200, { url: data.signedUrl, filename: r.filename, mimeType: r.mime_type, download, expiresIn: TTL });
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
    const row = await must(sb.from("gw_hr_documents").insert({
      tenant_id: ctx.tenantId, applicant_id: a.id, doc_type: docType,
      filename: cleanFilename(body.filename), storage_path: path, mime_type: c.mime,
      size_bytes: bytes.length, sha256: sha256(bytes), uploaded_by: user.id, created_at: now, updated_at: now,
    }).select(FIELDS).single());
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
