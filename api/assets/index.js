// GET    /api/assets            … 貸与品・アカウントの一覧
//          管理者・人事は全件、本人は自分に貸与されているものだけ（RLSが決める）
// POST   /api/assets            … 追加
// PATCH  /api/assets {id, ...}  … 更新（貸出・返却もここ）
// DELETE /api/assets?id=...     … 削除

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";

const KINDS = ["pc", "phone", "account", "key", "other"];
const STATUSES = ["in_stock", "assigned", "returned", "disposed"];

const FIELDS =
  "id, tenant_id, kind, name, identifier, assigned_to, assigned_on, returned_on, status, note, created_at";
const WITH_NAMES = `${FIELDS}, assignee:gw_employees(id, display_name, department)`;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const sb = userClient(req);

  if (req.method === "GET") {
    const { data, error } = await sb
      .from("gw_assets")
      .select(WITH_NAMES)
      .eq("tenant_id", ctx.tenantId)
      .order("status", { ascending: true })
      .order("name", { ascending: true })
      .limit(500);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
    return json(res, 200, { assets: data || [], canManage: canManageHr(ctx) });
  }

  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "POST") {
    const body = await readJson(req);
    const row = normalize(body);
    if (row.error) return json(res, 400, row);
    if (!row.value.name) return json(res, 400, { error: "invalid_body", detail: "name は必須です" });

    const { data, error } = await sb
      .from("gw_assets")
      .insert({ ...row.value, tenant_id: ctx.tenantId })
      .select(WITH_NAMES)
      .single();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    return json(res, 200, { asset: data });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
    const row = normalize(body, { partial: true });
    if (row.error) return json(res, 400, row);

    const { data, error } = await sb
      .from("gw_assets")
      .update({ ...row.value, updated_at: new Date().toISOString() })
      .eq("id", body.id)
      .eq("tenant_id", ctx.tenantId)
      .select(WITH_NAMES)
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "asset_not_found" });
    return json(res, 200, { asset: data });
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

    const { data, error } = await sb
      .from("gw_assets")
      .delete()
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .select("id")
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "asset_not_found" });
    return json(res, 200, { ok: true, id });
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("name")) v.name = String(body.name ?? "").trim();
  if (has("identifier")) v.identifier = body.identifier ? String(body.identifier).trim() : null;
  if (has("note")) v.note = body.note ? String(body.note) : null;
  if (has("assignedOn")) v.assigned_on = body.assignedOn || null;
  if (has("returnedOn")) v.returned_on = body.returnedOn || null;

  if (has("kind")) {
    if (!KINDS.includes(body.kind)) return { error: "invalid_kind", detail: KINDS.join(", ") };
    v.kind = body.kind;
  }
  if (has("status")) {
    if (!STATUSES.includes(body.status)) return { error: "invalid_status", detail: STATUSES.join(", ") };
    v.status = body.status;
  }
  // 貸出先が変わったら、状態と日付も自然な値に揃える
  if (has("assignedTo")) {
    v.assigned_to = body.assignedTo || null;
    if (!has("status")) v.status = body.assignedTo ? "assigned" : "in_stock";
    if (body.assignedTo && !has("assignedOn")) v.assigned_on = new Date().toISOString().slice(0, 10);
    if (!body.assignedTo && !has("returnedOn")) v.returned_on = new Date().toISOString().slice(0, 10);
  }
  return { value: v };
}
