// GET    /api/onboarding/orientation            … 教材の一覧（本人: 有効なもの＋自分の確認 / 人事: 全部）
// POST   /api/onboarding/orientation {confirm}  … 本人が「確認しました」
// POST   /api/onboarding/orientation {title…}   … 教材を登録（人事・管理者）
// PATCH  /api/onboarding/orientation {id, …}    … 教材を直す・無効にする（人事・管理者）
// DELETE /api/onboarding/orientation?id=…       … 教材を無効にする（消さない。確認の記録が付いている）
//
// ■ 個人情報は無い
//   教材の題名と URL、誰がいつ確認したか。requireMfa は置かない。
//   ここまで止めると、登録前の人が入社前に読むものまで開けなくなる。
//
// ■ 確認は本人だけが押せる
//   人事が代わりに押す口は作らない。押した記録は本人の行動の記録

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { advanceFor } from "../../lib/onboard-advance.js";
import { ORIENTATION_KINDS, normalizeItem, orientationState } from "../../lib/orientation.js";

const SQL = "db/071_onboarding_stage2.sql";
const FIELDS = "id, title, kind, url, body, description, required, sort_order, active, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  const hr = canManageHr(ctx);

  if (req.method === "GET") return list(res, ctx, hr);
  if (req.method === "POST") {
    const body = await readJson(req);
    if (body?.confirm) return confirm(res, ctx, user, body);
    if (!hr) return json(res, 403, { error: "forbidden" });
    return create(res, ctx, user, body);
  }
  if (req.method === "PATCH") {
    if (!hr) return json(res, 403, { error: "forbidden" });
    return update(res, ctx, user, await readJson(req));
  }
  if (req.method === "DELETE") {
    if (!hr) return json(res, 403, { error: "forbidden" });
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    return update(res, ctx, user, { id, active: false });
  }
  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

async function list(res, ctx, hr) {
  const sb = admin();
  let q = sb.from("gw_orientation_items").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).order("sort_order").order("created_at").limit(200);
  if (!hr) q = q.eq("active", true);
  const { data: items, error } = await q;
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  let checks = [];
  if (ctx.employee) {
    const { data } = await sb.from("gw_orientation_checks").select("item_id, confirmed_at")
      .eq("employee_id", ctx.employee.id);
    checks = data || [];
  }
  // 人事には、項目ごとに「何人が確認したか」も
  let confirmedCount = null;
  if (hr && items?.length) {
    const { data } = await sb.from("gw_orientation_checks").select("item_id")
      .eq("tenant_id", ctx.tenantId).limit(5000);
    confirmedCount = {};
    for (const c of data || []) confirmedCount[c.item_id] = (confirmedCount[c.item_id] || 0) + 1;
  }

  const state = orientationState(items || [], checks);
  return json(res, 200, {
    items: state.map((i) => ({
      ...i,
      active: (items || []).find((x) => x.id === i.id)?.active !== false,
      sortOrder: (items || []).find((x) => x.id === i.id)?.sort_order ?? 100,
      confirmedCount: confirmedCount ? (confirmedCount[i.id] || 0) : undefined,
    })),
    kinds: ORIENTATION_KINDS,
    done: state.filter((i) => i.required).every((i) => i.confirmed),
  });
}

async function confirm(res, ctx, user, body) {
  if (!ctx.employee) return json(res, 403, { error: "no_employee" });
  const sb = admin();
  const { data: item } = await sb.from("gw_orientation_items").select("id, title, active")
    .eq("id", String(body.confirm)).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!item || item.active === false) return json(res, 404, { error: "not_found" });

  const { error } = await sb.from("gw_orientation_checks").upsert({
    tenant_id: ctx.tenantId, employee_id: ctx.employee.id, item_id: item.id,
    confirmed_at: new Date().toISOString(),
  }, { onConflict: "employee_id,item_id", ignoreDuplicates: true });
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }
  // 段階が動くことがある（④ の blockers から外れる）
  await advanceFor(sb, ctx, ctx.employee.id);
  return json(res, 200, { ok: true, id: item.id });
}

async function create(res, ctx, user, body) {
  const row = normalizeItem(body);
  if (row.error) return json(res, 400, row);
  const sb = admin();
  const { data, error } = await sb.from("gw_orientation_items")
    .insert({ ...row.value, tenant_id: ctx.tenantId, created_by: user.id })
    .select(FIELDS).single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "orientation.create",
                target: `orientation:${data.id}`, detail: { title: data.title, kind: data.kind } });
  return json(res, 200, { item: data });
}

async function update(res, ctx, user, body) {
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const row = normalizeItem(body, { partial: true });
  if (row.error) return json(res, 400, row);
  const sb = admin();
  const { data, error } = await sb.from("gw_orientation_items")
    .update({ ...row.value, updated_at: new Date().toISOString() })
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).select(FIELDS).single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
                action: row.value.active === false ? "orientation.disable" : "orientation.update",
                target: `orientation:${data.id}`, detail: { title: data.title } });
  return json(res, 200, { item: data });
}
