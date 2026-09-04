// GET    /api/templates            … 書類の雛形一覧（管理者・人事のみ／RLSが決める）
// POST   /api/templates            … 追加
// PATCH  /api/templates {id, ...}  … 更新
// DELETE /api/templates?id=...     … 削除
//
// 差し込み（{{氏名}} などの置換）は画面側で行う。雛形そのものだけを持つ。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";

const KINDS = ["onboarding", "offboarding", "general"];
const EMPLOYMENT_TYPES = ["正社員", "契約社員", "パート", "アルバイト", "業務委託", "役員", "その他"];

const FIELDS =
  "id, tenant_id, name, kind, employment_types, body, note, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const sb = userClient(req);

  if (req.method === "GET") {
    const { data, error } = await sb
      .from("gw_doc_templates")
      .select(FIELDS)
      .eq("tenant_id", ctx.tenantId)
      .order("kind", { ascending: true })
      .order("name", { ascending: true })
      .limit(200);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
    return json(res, 200, { templates: data || [], canManage: canManageHr(ctx) });
  }

  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "POST") {
    const body = await readJson(req);
    const row = normalize(body);
    if (row.error) return json(res, 400, row);
    if (!row.value.name || !row.value.body) {
      return json(res, 400, { error: "invalid_body", detail: "名前と本文は必須です" });
    }

    const { data, error } = await sb
      .from("gw_doc_templates")
      .insert({ ...row.value, tenant_id: ctx.tenantId, created_by: user.id })
      .select(FIELDS)
      .single();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    return json(res, 200, { template: data });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
    const row = normalize(body, { partial: true });
    if (row.error) return json(res, 400, row);

    const { data, error } = await sb
      .from("gw_doc_templates")
      .update({ ...row.value, updated_at: new Date().toISOString() })
      .eq("id", body.id)
      .eq("tenant_id", ctx.tenantId)
      .select(FIELDS)
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "template_not_found" });
    return json(res, 200, { template: data });
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

    const { data, error } = await sb
      .from("gw_doc_templates")
      .delete()
      .eq("id", id)
      .eq("tenant_id", ctx.tenantId)
      .select("id")
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "template_not_found" });
    return json(res, 200, { ok: true, id });
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("name")) v.name = String(body.name ?? "").trim();
  if (!partial || has("body")) v.body = String(body.body ?? "").trim();
  if (has("note")) v.note = body.note ? String(body.note) : null;
  if (has("kind")) {
    if (!KINDS.includes(body.kind)) return { error: "invalid_kind", detail: KINDS.join(", ") };
    v.kind = body.kind;
  }
  if (has("employmentTypes")) {
    if (!Array.isArray(body.employmentTypes)) {
      return { error: "invalid_employment_types", detail: "配列で指定してください" };
    }
    const list = body.employmentTypes.map((t) => String(t).trim()).filter(Boolean);
    const bad = list.find((t) => !EMPLOYMENT_TYPES.includes(t));
    if (bad) return { error: "invalid_employment_type", detail: `${bad} は雇用区分にありません` };
    v.employment_types = list;
  }
  return { value: v };
}
