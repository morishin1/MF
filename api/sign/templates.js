// GET    /api/sign/templates            … 契約書の雛形一覧（人事・管理者）
// POST   /api/sign/templates            … 追加
// PATCH  /api/sign/templates {id, ...}  … 更新（本文を直すと版が1つ上がる）
// DELETE /api/sign/templates?id=…       … 削除
//
// 雛形を消しても、送信済み・署名済みの契約書は残る。
// 依頼の行が本文を丸ごと控えているため（db/046 の body_snapshot）。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { DOC_KINDS, DOC_KIND_KEYS, MERGE_FIELDS, STARTERS, usedFields } from "../../lib/esign.js";

const FIELDS =
  "id, tenant_id, name, doc_kind, body, note, version, due_days, active, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") {
    const { data, error } = await sb
      .from("gw_sign_templates").select(FIELDS)
      .eq("tenant_id", ctx.tenantId)
      .order("doc_kind").order("name").limit(200);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    return json(res, 200, {
      templates: (data || []).map((t) => ({ ...t, used: usedFields(t.body) })),
      // 画面の組み立てはサーバの定義から。同じ一覧を2か所に書かない
      kinds: DOC_KINDS,
      mergeFields: MERGE_FIELDS,
      starters: Object.fromEntries(
        Object.entries(STARTERS).map(([k, v]) => [k, { name: v.name, body: v.body }])),
    });
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const row = normalize(body);
    if (row.error) return json(res, 400, row);
    if (!row.value.name) return json(res, 400, { error: "invalid_body", hint: "名前を入れてください" });

    const { data, error } = await admin()
      .from("gw_sign_templates")
      .insert({ ...row.value, tenant_id: ctx.tenantId, version: 1, created_by: user.id })
      .select(FIELDS).single();
    if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "sign_template.create",
      target: `sign_template:${data.id}`, detail: { name: data.name, kind: data.doc_kind },
    });
    return json(res, 200, { template: { ...data, used: usedFields(data.body) } });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
    const row = normalize(body, { partial: true });
    if (row.error) return json(res, 400, row);

    const sbAdmin = admin();
    const { data: before } = await sbAdmin
      .from("gw_sign_templates").select("id, body, version")
      .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!before) return json(res, 404, { error: "template_not_found" });

    // 本文が変わったときだけ版を上げる。名前を直しただけで版が進むと、
    // 「第3版に署名した」が何を指すのか分からなくなる
    const patch = { ...row.value, updated_at: new Date().toISOString() };
    if (patch.body !== undefined && patch.body !== before.body) {
      patch.version = (before.version || 1) + 1;
    }

    const { data, error } = await sbAdmin
      .from("gw_sign_templates").update(patch)
      .eq("id", body.id).eq("tenant_id", ctx.tenantId)
      .select(FIELDS).maybeSingle();
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "template_not_found" });

    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "sign_template.update",
      target: `sign_template:${data.id}`, detail: { name: data.name, version: data.version },
    });
    return json(res, 200, { template: { ...data, used: usedFields(data.body) } });
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

    const { data, error } = await admin()
      .from("gw_sign_templates").delete()
      .eq("id", id).eq("tenant_id", ctx.tenantId).select("id, name").maybeSingle();
    if (error) return json(res, 500, { error: "db_delete_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "template_not_found" });

    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "sign_template.delete",
      target: `sign_template:${id}`, detail: { name: data.name },
    });
    return json(res, 200, { ok: true, id });
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;
  const text = (s, max) => {
    const t = String(s ?? "").trim();
    return t ? t.slice(0, max) : null;
  };

  if (!partial || has("name")) v.name = text(body.name, 120);
  if (has("body")) v.body = String(body.body ?? "").slice(0, 60000);
  if (has("note")) v.note = text(body.note, 500);
  if (has("active")) v.active = !!body.active;

  if (has("docKind")) {
    if (!DOC_KIND_KEYS.includes(body.docKind)) {
      return { error: "invalid_kind", detail: DOC_KIND_KEYS.join(", ") };
    }
    v.doc_kind = body.docKind;
  }
  if (has("dueDays")) {
    const n = Number(body.dueDays);
    if (!Number.isFinite(n) || n < 1 || n > 90) {
      return { error: "invalid_due_days", hint: "1〜90日にしてください" };
    }
    v.due_days = Math.round(n);
  }
  return { value: v };
}
