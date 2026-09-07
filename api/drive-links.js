// GET    /api/drive-links                … 自分が開けるフォルダ（本人）
// GET    /api/drive-links?all=1           … 全員ぶん（管理者）
// POST   /api/drive-links { employeeId?, label, url, note? }  … 足す
// PATCH  /api/drive-links { id, ... }     … 直す
// DELETE /api/drive-links?id=…            … 消す
//
// ■ ここに貼っても権限は増えない
//   入るのはリンクだけ。実際に開けるかどうかは Google ドライブ側の共有で決まる。
//   貼る前に、そのフォルダを本人へ共有しておく必要がある。
//   画面にもそう出す（開けなかったときに、mf を疑わせないため）。
//
// ■ 他人のフォルダは見せない
//   URLそのものが、その場所への案内になる。
//   本人向けと全員向けだけを返す（RLS でも同じ条件にしてある）。

import { json, readJson, methodNotAllowed } from "../lib/http.js";
import { requireUser } from "../lib/auth.js";
import { gwContext, canManageHr } from "../lib/gw.js";
import { admin } from "../lib/supabase.js";
import { folderIdFromUrl, linkOf } from "../lib/hr-drive.js";
import { gwLog } from "../lib/gw-audit.js";

const F = "id, employee_id, label, url, folder_id, note, sort_order, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  if (req.method === "GET") return read(req, res, ctx);

  // 足す・直す・消すは管理者だけ
  if (!canManageHr(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "フォルダの登録には管理者権限が必要です" });
  }
  if (req.method === "POST") return create(req, res, ctx, user);
  if (req.method === "PATCH") return update(req, res, ctx, user);
  if (req.method === "DELETE") return remove(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

async function read(req, res, ctx) {
  const all = new URL(req.url, "http://localhost").searchParams.get("all") === "1";
  const sb = admin();

  if (all) {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const { data, error } = await sb.from("gw_drive_links")
      .select(`${F}, employee:gw_employees(id, display_name)`)
      .eq("tenant_id", ctx.tenantId).order("sort_order").limit(500);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
    return json(res, 200, { links: data || [], canManage: true });
  }

  // 本人向け ＋ 全員向け
  const empId = ctx.employee?.id || null;
  let q = sb.from("gw_drive_links").select(F).eq("tenant_id", ctx.tenantId);
  q = empId ? q.or(`employee_id.is.null,employee_id.eq.${empId}`) : q.is("employee_id", null);
  const { data, error } = await q.order("sort_order").limit(100);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  return json(res, 200, {
    links: (data || []).map((l) => ({ ...l, forAll: !l.employee_id })),
    canManage: canManageHr(ctx),
  });
}

// URLからフォルダIDを取り出して、リンクの形をそろえる。
// ?usp=sharing が付いたままだと、貼った人によってURLが変わって見える
function clean(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  const id = folderIdFromUrl(raw);
  // フォルダ以外（スプレッドシート等）も貼れるようにする。
  // その場合はURLをそのまま使う（https で始まるものだけ）
  if (id) return { url: linkOf(id), folderId: id };
  return /^https:\/\//.test(raw) ? { url: raw.slice(0, 1000), folderId: null } : null;
}

async function create(req, res, ctx, user) {
  const body = await readJson(req);
  const label = String(body?.label || "").trim().slice(0, 80);
  const c = clean(body?.url);
  if (!label) return json(res, 400, { error: "invalid_body", hint: "名前を入れてください" });
  if (!c) return json(res, 400, { error: "invalid_url", hint: "https で始まるURLを貼ってください" });

  const sb = admin();
  // 誰かを指すなら、その人がこの会社にいるか確かめる
  let employeeId = body?.employeeId || null;
  if (employeeId) {
    const { data: emp } = await sb.from("gw_employees").select("id")
      .eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!emp) return json(res, 404, { error: "employee_not_found" });
  }

  const { data, error } = await sb.from("gw_drive_links").insert({
    tenant_id: ctx.tenantId,
    employee_id: employeeId,
    label,
    url: c.url,
    folder_id: c.folderId,
    note: String(body?.note || "").trim().slice(0, 300) || null,
    sort_order: Number.isFinite(Number(body?.sortOrder)) ? Number(body.sortOrder) : 0,
    created_by: user.id,
  }).select(F).single();
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: "drive_link.add",
    target: employeeId ? `employee:${employeeId}` : "all",
    detail: { label, url: c.url },
  });
  return json(res, 200, { link: data });
}

async function update(req, res, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const patch = { updated_at: new Date().toISOString() };
  if (body.label !== undefined) {
    const label = String(body.label).trim().slice(0, 80);
    if (!label) return json(res, 400, { error: "invalid_body", hint: "名前を入れてください" });
    patch.label = label;
  }
  if (body.url !== undefined) {
    const c = clean(body.url);
    if (!c) return json(res, 400, { error: "invalid_url", hint: "https で始まるURLを貼ってください" });
    patch.url = c.url;
    patch.folder_id = c.folderId;
  }
  if (body.note !== undefined) patch.note = String(body.note).trim().slice(0, 300) || null;
  if (body.sortOrder !== undefined && Number.isFinite(Number(body.sortOrder))) {
    patch.sort_order = Number(body.sortOrder);
  }

  const { data, error } = await admin().from("gw_drive_links")
    .update(patch).eq("id", body.id).eq("tenant_id", ctx.tenantId).select(F).maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: "drive_link.update", target: `link:${body.id}`, detail: patch,
  });
  return json(res, 200, { link: data });
}

async function remove(req, res, ctx, user) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const { error } = await admin().from("gw_drive_links")
    .delete().eq("id", id).eq("tenant_id", ctx.tenantId);
  if (error) return json(res, 500, { error: "db_delete_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: "drive_link.remove", target: `link:${id}`,
  });
  return json(res, 200, { ok: true });
}
