// GET /api/hr/lead-watchers?category=mugendojo  … 新しいリードの通知先（運営担当）と、選べる社員
// PUT /api/hr/lead-watchers { category, employeeIds: [...] } … 通知先を、この一覧に置き換える
//
// ■ 個人IDをコードに書かない（db/118 の gw_hr_lead_watchers）
//   無限道場の運営担当など、リードの通知先は画面から設定する。誰も設定されていなければ、
//   採用HRの担当（経営者・人事・採用担当）へ届く（lib/hr-leads.js の leadRecipients）。
//
// ■ 権限
//   採用HRを使える人（canRecruit）。読み書きは userClient（RLS：gw_is_recruiting）。
//   変更は監査ログ（hr.lead_watchers_update）に残す。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { LEAD_CATEGORIES } from "../../lib/hr-leads.js";

const SQL = "db/118_hr_leads.sql";
const MAX_WATCHERS = 20;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  if (req.method === "GET") {
    const category = new URL(req.url || "/", "http://localhost").searchParams.get("category") || "mugendojo";
    if (!LEAD_CATEGORIES.includes(category)) return json(res, 400, { error: "invalid_query" });
    return list(res, sb, ctx, category);
  }
  if (req.method === "PUT") return replace(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "PUT"]);
}

async function list(res, sb, ctx, category) {
  const [{ data: watchers, error }, { data: employees }] = await Promise.all([
    sb.from("gw_hr_lead_watchers").select("employee_id").eq("tenant_id", ctx.tenantId).eq("lead_category", category),
    sb.from("gw_employees").select("id, display_name").eq("tenant_id", ctx.tenantId)
      .in("status", ["active", "invited"]).order("display_name").limit(300),
  ]);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { notReady: true, message: hint, category, employeeIds: [], employees: employees || [] });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  return json(res, 200, { category, employeeIds: (watchers || []).map((w) => w.employee_id), employees: employees || [] });
}

async function replace(req, res, sb, ctx, user) {
  const body = await readJson(req);
  const category = body?.category;
  if (!LEAD_CATEGORIES.includes(category)) return json(res, 400, { error: "invalid_body", detail: "category が不正です" });
  if (!Array.isArray(body.employeeIds)) return json(res, 400, { error: "invalid_body", detail: "employeeIds（配列）が必要です" });
  const wanted = [...new Set(body.employeeIds.map(String))];
  if (wanted.length > MAX_WATCHERS) return json(res, 400, { error: "invalid_body", detail: `通知先は${MAX_WATCHERS}人までです` });

  // 同じ会社の在籍者だけ（別テナントの社員IDや、退職者を通知先にしない）
  if (wanted.length) {
    const { data: ok } = await sb.from("gw_employees").select("id")
      .eq("tenant_id", ctx.tenantId).in("id", wanted).neq("status", "left");
    if ((ok || []).length !== wanted.length) {
      return json(res, 400, { error: "invalid_body", detail: "通知先に、この会社の在籍者ではない人が含まれています" });
    }
  }

  const { data: cur, error: cerr } = await sb.from("gw_hr_lead_watchers").select("id, employee_id")
    .eq("tenant_id", ctx.tenantId).eq("lead_category", category);
  if (cerr) {
    const hint = dbSetupHint(cerr, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: cerr.message });
  }
  const have = new Set((cur || []).map((w) => w.employee_id));
  const add = wanted.filter((id) => !have.has(id));
  const drop = (cur || []).filter((w) => !wanted.includes(w.employee_id)).map((w) => w.id);

  if (add.length) {
    const { error } = await sb.from("gw_hr_lead_watchers").insert(add.map((employee_id) => ({
      tenant_id: ctx.tenantId, lead_category: category, employee_id, created_by: user.id,
    })));
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }
  if (drop.length) {
    const { error } = await sb.from("gw_hr_lead_watchers").delete().eq("tenant_id", ctx.tenantId).in("id", drop);
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.lead_watchers_update",
    target: `hr_lead_watchers:${category}`, detail: { added: add, removed: drop.length, total: wanted.length },
  });
  return json(res, 200, { category, employeeIds: wanted });
}
