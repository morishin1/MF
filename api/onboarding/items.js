// POST   /api/onboarding/items                    … 項目を追加（管理者・人事）
// PATCH  /api/onboarding/items {id, ...}          … 項目を更新（管理者・人事）
// DELETE /api/onboarding/items?id=...             … 項目を削除（管理者・人事）
//
// 本人の「提出しました」はここではなく api/onboarding/submit.js を使う。
// 本人に他の列（社労士への共有可否など）を触らせないため、口を分けている。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const CATEGORIES = ["document", "task", "account", "equipment"];
const OWNERS = ["employee", "hr", "labor_advisor"];
const STATUSES = ["todo", "submitted", "done", "na"];

const I_FIELDS =
  "id, procedure_id, title, category, owner, required, share_with_advisor, status, due_on, note, sort_order, document_id, completed_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "POST") {
    const body = await readJson(req);
    if (!body?.procedureId) return json(res, 400, { error: "invalid_body", required: ["procedureId", "title"] });
    const row = normalize(body);
    if (row.error) return json(res, 400, row);
    if (!row.value.title) return json(res, 400, { error: "invalid_body", detail: "title は必須です" });

    const { data, error } = await sb
      .from("gw_procedure_items")
      .insert({
        ...row.value,
        tenant_id: ctx.tenantId,
        procedure_id: body.procedureId,
        sort_order: Number.isFinite(body.sortOrder) ? body.sortOrder : 999,
      })
      .select(I_FIELDS)
      .single();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    return json(res, 200, { item: data });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
    const row = normalize(body, { partial: true });
    if (row.error) return json(res, 400, row);

    const patch = { ...row.value, updated_at: new Date().toISOString() };
    // 完了に変えたときだけ完了者と日時を記録する
    if (patch.status === "done" || patch.status === "na") {
      patch.completed_at = new Date().toISOString();
      patch.completed_by = user.id;
    } else if (patch.status) {
      patch.completed_at = null;
      patch.completed_by = null;
    }

    const { data, error } = await sb
      .from("gw_procedure_items")
      .update(patch)
      .eq("id", body.id)
      .eq("tenant_id", ctx.tenantId)
      .select(I_FIELDS)
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "item_not_found" });
    // 社外（社労士）に見せるかどうかの変更は必ず残す
    if (row.value.share_with_advisor !== undefined) {
      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id, action: "procedure.share_advisor",
        target: `item:${data.id}`,
        detail: { title: data.title, share: row.value.share_with_advisor },
      });
    }
    return json(res, 200, { item: data });
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

    const { data, error } = await sb
      .from("gw_procedure_items")
      .delete()
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .select("id")
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "item_not_found" });
    return json(res, 200, { ok: true, id });
  }

  return methodNotAllowed(res, ["POST", "PATCH", "DELETE"]);
}

function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("title")) v.title = String(body.title ?? "").trim();
  if (has("category")) {
    if (!CATEGORIES.includes(body.category)) return { error: "invalid_category", detail: CATEGORIES.join(", ") };
    v.category = body.category;
  }
  if (has("owner")) {
    if (!OWNERS.includes(body.owner)) return { error: "invalid_owner", detail: OWNERS.join(", ") };
    v.owner = body.owner;
  }
  if (has("status")) {
    if (!STATUSES.includes(body.status)) return { error: "invalid_status", detail: STATUSES.join(", ") };
    v.status = body.status;
  }
  if (has("required")) v.required = !!body.required;
  if (has("shareWithAdvisor")) v.share_with_advisor = !!body.shareWithAdvisor;
  if (has("dueOn")) v.due_on = body.dueOn || null;
  if (has("note")) v.note = body.note || null;
  if (has("sortOrder") && Number.isFinite(body.sortOrder)) v.sort_order = body.sortOrder;

  return { value: v };
}
