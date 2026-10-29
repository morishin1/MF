// GET    /api/office-professionals/file?fileId=…  … 担当者だけに5分間の閲覧URL
// POST   /api/office-professionals/file          … 添付アップロードURL発行
// PATCH  /api/office-professionals/file          … アップロード完了を記録

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import * as GW from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { requireMfa } from "../../lib/mfa.js";
import { gwLog } from "../../lib/gw-audit.js";
import { canUsePortal, canSeeTask, isAdvisor, isSharedProcedureTask, safeText } from "../../lib/professional-tasks.js";

const SQL = "db/146_office_professional_tasks.sql";
const TTL = 300;
const MAX = 10 * 1024 * 1024;
const MIME = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const taskFields = "id, tenant_id, kind, assignee_employee_id, procedure_item_id, created_by";
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await GW.gwContext(user.id);
  if (!ctx.tenantId || !ctx.employee || !canUsePortal(ctx, GW)) return json(res, 403, { error: "forbidden" });
  if (!(await requireMfa(req, res, ctx, user))) return;
  try {
    if (req.method === "GET") return await getFile(req, res, ctx, user);
    if (req.method === "POST") return await createFile(req, res, ctx, user);
    if (req.method === "PATCH") return await confirmFile(req, res, ctx, user);
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[office-professional-file]", e?.message || e);
    return json(res, 500, { error: "professional_file_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

async function getFile(req, res, ctx, user) {
  const sb = admin();
  const fileId = new URL(req.url || "/", "http://localhost").searchParams.get("fileId");
  const file = fileId ? await must(sb.from("gw_professional_task_files").select("id, task_id, filename, storage_path, uploaded_at")
    .eq("id", fileId).eq("tenant_id", ctx.tenantId).maybeSingle()) : null;
  if (!file?.uploaded_at) return json(res, 404, { error: "not_found" });
  const task = await loadTask(sb, ctx.tenantId, file.task_id);
  if (!task || !canSeeTask(ctx, user.id, task, GW) || (isAdvisor(ctx) && !await isSharedProcedureTask(sb, ctx.tenantId, task))) return json(res, 404, { error: "not_found" });
  const { data, error } = await sb.storage.from("professional-tasks").createSignedUrl(file.storage_path, TTL);
  if (error) return json(res, 404, { error: "file_missing" });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "professional_task.file_view", target: task.id,
    detail: { fileId: file.id, kind: task.kind } });
  return json(res, 200, { url: data.signedUrl, filename: file.filename, expiresInSec: TTL });
}

async function createFile(req, res, ctx, user) {
  const body = await readJson(req);
  const sb = admin();
  const task = body?.taskId ? await loadTask(sb, ctx.tenantId, String(body.taskId)) : null;
  if (!task || !canSeeTask(ctx, user.id, task, GW) || (isAdvisor(ctx) && !await isSharedProcedureTask(sb, ctx.tenantId, task))) return json(res, 404, { error: "not_found" });
  // HR の共有書類は既存 hr バケットから参照する。専門家添付で同じ書類を複製しない。
  if (task.procedure_item_id) return json(res, 403, { error: "use_shared_procedure_file", hint: "入退社書類は「共有書類」から確認してください" });
  const filenameText = safeText(body.filename, 255);
  const filename = filenameText.value || "";
  const mimeType = String(body.mimeType || "");
  const sizeBytes = Number(body.sizeBytes);
  if (filenameText.error || !filename || !MIME.has(mimeType) || !Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX) {
    return json(res, 400, { error: "invalid_file", hint: filenameText.error || "PDF・画像・Word・Excel（10MBまで）を選んでください" });
  }
  // 社労士が取り扱うマイナンバー関連書類を汎用タスク添付へ置かない。
  if (/マイナンバー|個人番号|基礎年金番号|番号確認/i.test(filename)) return json(res, 400, { error: "sensitive_file", hint: "個人番号・番号確認書類はこのタスクに添付できません" });
  const ext = /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1]?.toLowerCase() || "bin";
  const fileId = crypto.randomUUID();
  const storagePath = `${ctx.tenantId}/${task.id}/${fileId}.${ext}`;
  const { error: ie } = await sb.from("gw_professional_task_files").insert({
    id: fileId, tenant_id: ctx.tenantId, task_id: task.id, filename, mime_type: mimeType,
    size_bytes: sizeBytes, storage_path: storagePath, uploaded_by: user.id,
  });
  if (ie) return json(res, 500, { error: "db_insert_failed" });
  const { data, error } = await sb.storage.from("professional-tasks").createSignedUploadUrl(storagePath);
  if (error) {
    await sb.from("gw_professional_task_files").delete().eq("id", fileId);
    return json(res, 500, { error: "sign_failed" });
  }
  return json(res, 200, { fileId, uploadUrl: data.signedUrl, storagePath, token: data.token });
}

async function confirmFile(req, res, ctx, user) {
  const body = await readJson(req);
  const sb = admin();
  const file = body?.fileId ? await must(sb.from("gw_professional_task_files").select("id, task_id, filename")
    .eq("id", String(body.fileId)).eq("tenant_id", ctx.tenantId).maybeSingle()) : null;
  if (!file) return json(res, 404, { error: "not_found" });
  const task = await loadTask(sb, ctx.tenantId, file.task_id);
  if (!task || !canSeeTask(ctx, user.id, task, GW) || (isAdvisor(ctx) && !await isSharedProcedureTask(sb, ctx.tenantId, task))) return json(res, 404, { error: "not_found" });
  await must(sb.from("gw_professional_task_files").update({ uploaded_at: new Date().toISOString() }).eq("id", file.id));
  await sb.from("gw_professional_task_events").insert({ tenant_id: ctx.tenantId, task_id: task.id,
    kind: "file", actor_id: user.id, actor_name: ctx.employee.display_name, detail: { fileId: file.id } });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "professional_task.file_upload", target: task.id,
    detail: { fileId: file.id, kind: task.kind } });
  return json(res, 200, { ok: true, fileId: file.id });
}

async function loadTask(sb, tenantId, id) {
  const { data } = await sb.from("gw_professional_tasks").select(taskFields).eq("id", id).eq("tenant_id", tenantId).maybeSingle();
  return data || null;
}
