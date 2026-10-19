// /sales 提案管理の設定（db/138 gw_sales_proposal_settings）
//
// GET   /api/sales/proposals/settings … いまの設定（無ければ既定値：9:00〜18:00・30分・3営業日・5営業日）
// PATCH /api/sales/proposals/settings { bizStart?, bizEnd?, firstCallMinutes?, refollowBizDays?, reviewBizDays?, extraHolidays? }
//         … 管理側だけ。変えた値は、これから作るタスクの期限に効く（作ったタスクの期限は変えない）

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { DEFAULT_SETTINGS, settingsOf, normalizeSettings, canManageProposals } from "../../../lib/sales-proposals.js";
import { SQL_FILE, loadPeople, salesMembers } from "../../../lib/sales-proposals-db.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });
  const sb = userClient(req);

  const { data: row, error } = await sb.from("gw_sales_proposal_settings").select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL_FILE);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_failed", detail: error.message });
  }
  if (req.method === "GET") {
    return json(res, 200, { settings: settingsOf(row), defaults: DEFAULT_SETTINGS, saved: Boolean(row), canEdit: canManageProposals(ctx) });
  }
  if (req.method !== "PATCH") return methodNotAllowed(res, ["GET", "PATCH"]);
  if (!canManageProposals(ctx)) return json(res, 403, { error: "forbidden", hint: "設定を変えられるのは管理者です" });

  const body = await readJson(req);
  const n = normalizeSettings(body, settingsOf(row));
  if (n.error) return json(res, 400, n);
  if (!Object.keys(n.value).length) return json(res, 400, { error: "nothing_to_update" });
  // Slack共有先のチームは在籍中・Sales利用可の社員だけ。
  if (n.value.cs_members || n.value.closing_members) {
    const people = await loadPeople(ctx.tenantId);
    const valid = new Set((await salesMembers(ctx.tenantId, people.employees)).map((m) => m.id));
    if ([...(n.value.cs_members || []), ...(n.value.closing_members || [])].some((id) => !valid.has(id))) {
      return json(res, 400, { error: "invalid_team_member", hint: "CS・クロージング担当は在籍中のSales利用者から選んでください" });
    }
  }
  const payload = { ...n.value, tenant_id: ctx.tenantId, updated_by: user.id, updated_at: new Date().toISOString() };
  const q = row
    ? sb.from("gw_sales_proposal_settings").update(payload).eq("tenant_id", ctx.tenantId).select("*").single()
    : sb.from("gw_sales_proposal_settings").insert(payload).select("*").single();
  const { data: saved, error: e1 } = await q;
  if (e1) return json(res, e1.code === "23514" ? 400 : e1.code === "42501" ? 403 : 500, { error: "db_failed", detail: e1.message });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.proposal_settings", target: `tenant:${ctx.tenantId}`,
    detail: { fields: Object.keys(n.value) } });
  return json(res, 200, { settings: settingsOf(saved), defaults: DEFAULT_SETTINGS, saved: true, canEdit: true });
}
