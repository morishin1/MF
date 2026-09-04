// GET    /api/spaces            … スペース一覧（社員は誰でも読める）
// POST   /api/spaces            … 追加（管理者・人事）
// PATCH  /api/spaces {id, ...}  … 更新（管理者・人事）
// DELETE /api/spaces?id=...     … 削除（管理者・人事）
//
// 予約が入っているスペースは削除できない。過去の予約の行き先が消えると、
// 誰がいつ何を押さえていたかが追えなくなるため、代わりに active を false にする。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";
import { isConfigured as gcalConfigured, defaultCalendarId } from "../../lib/gcal.js";

const FIELDS =
  "id, tenant_id, code, name, capacity, note, calendar_id, active, needs_approval, sort_order";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const sb = userClient(req);

  if (req.method === "GET") {
    const { data, error } = await sb
      .from("gw_spaces")
      .select(FIELDS)
      .eq("tenant_id", ctx.tenantId)
      .order("sort_order", { ascending: true })
      .order("code", { ascending: true })
      .limit(200);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    return json(res, 200, {
      spaces: data || [],
      canManage: canManageHr(ctx),
      calendar: {
        configured: gcalConfigured(),
        // カレンダーIDは社内の共有先そのものなので、管理者にだけ返す
        defaultCalendarId: canManageHr(ctx) ? defaultCalendarId() : undefined,
      },
    });
  }

  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "POST") {
    const body = await readJson(req);
    const row = normalize(body);
    if (row.error) return json(res, 400, row);
    if (!row.value.name) return json(res, 400, { error: "invalid_body", detail: "name は必須です" });
    if (!row.value.code) return json(res, 400, { error: "invalid_body", detail: "code は必須です" });

    const { data, error } = await sb
      .from("gw_spaces")
      .insert({ ...row.value, tenant_id: ctx.tenantId })
      .select(FIELDS)
      .single();
    if (error) {
      if (error.code === "23505") return json(res, 409, { error: "code_exists", hint: "同じ番号のスペースがすでにあります" });
      return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    }
    return json(res, 200, { space: data });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
    const row = normalize(body, { partial: true });
    if (row.error) return json(res, 400, row);

    const { data, error } = await sb
      .from("gw_spaces")
      .update({ ...row.value, updated_at: new Date().toISOString() })
      .eq("id", body.id)
      .eq("tenant_id", ctx.tenantId)
      .select(FIELDS)
      .maybeSingle();
    if (error) {
      if (error.code === "23505") return json(res, 409, { error: "code_exists", hint: "同じ番号のスペースがすでにあります" });
      return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
    }
    if (!data) return json(res, 404, { error: "space_not_found" });
    return json(res, 200, { space: data });
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

    const { count } = await sb
      .from("gw_bookings")
      .select("id", { count: "exact", head: true })
      .eq("space_id", id);
    if (count) {
      return json(res, 409, {
        error: "space_in_use",
        hint: "予約の履歴が残っています。削除ではなく「受付を止める」にしてください",
      });
    }

    const { data, error } = await sb
      .from("gw_spaces")
      .delete()
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .select("id")
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "space_not_found" });
    return json(res, 200, { ok: true, id });
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("code")) v.code = String(body.code ?? "").trim().slice(0, 40);
  if (!partial || has("name")) v.name = String(body.name ?? "").trim().slice(0, 120);
  if (has("note")) v.note = body.note ? String(body.note).slice(0, 500) : null;
  if (has("calendarId")) v.calendar_id = body.calendarId ? String(body.calendarId).trim() : null;
  if (has("active")) v.active = !!body.active;
  if (has("needsApproval")) v.needs_approval = !!body.needsApproval;

  if (has("capacity")) {
    if (body.capacity === null || body.capacity === "") v.capacity = null;
    else {
      const n = Number(body.capacity);
      if (!Number.isInteger(n) || n < 0 || n > 10000) return { error: "invalid_capacity" };
      v.capacity = n;
    }
  }
  if (has("sortOrder")) {
    const n = Number(body.sortOrder);
    if (!Number.isInteger(n)) return { error: "invalid_sort_order" };
    v.sort_order = n;
  }
  return { value: v };
}
