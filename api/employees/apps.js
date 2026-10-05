// POST /api/employees/apps  { employeeId, app, grant }
// アプリ利用権限（どのアプリへ入れるか）の付け外し。メンバー一覧の4つのボタン（採用HR / Sales / Office / 経営）。
//
//   app = hr（採用HR）/ sales（Sales）/ office（Office）… gw_app_grants（db/119）に保存する
//   app = keiei（経営）… 経営者（owner）の付け外し。保存先は内部ロール owner（経営は owner から導出する）。
//                         経営者だけが操作できる・最後の経営者は外せない・履歴に残す、の規則は lib/role-change.js のまま
//
// ■ ボタンの ON は「そのアプリへ入れる」だけ
//   アプリの中で何ができるかは、内部ロール（POST /api/employees/roles。詳細設定）が決める。
//   Office を ON にしただけでは、人事・労務・経理・事務・月末月初のどれも使えない（lib/gw.js）。
//
// ■ 変更できない人
//   経営者（owner）は、全部のアプリを使える（行を作らない）。変更しようとしたら 409 owner_locked。
//
// ■ 表が無いとき（db/119 を流す前）
//   409 app_grants_unavailable。アプリは、内部ロールから同じ入口を出している（lib/app-grants.js）ので、権限は変わらない。
//
// 付け外しができるのは人事権限を持つ人だけ（RLS: gw_app_grants_hr_write）。会計側の権限（memberships.role）とは別軸。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { changeRole, afterChange } from "../../lib/role-change.js";
import { APP_KEYS, isAbsent } from "../../lib/app-grants.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  // 個人情報を返す。対象の人は二段階認証（強制日以降）
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "アプリ利用権限の変更には管理者権限が必要です" });
  }

  const body = await readJson(req);
  const { employeeId, app } = body || {};
  const grant = body?.grant !== false;
  if (!employeeId || !app) return json(res, 400, { error: "invalid_body", required: ["employeeId", "app"] });
  if (app !== "keiei" && !APP_KEYS.includes(app)) {
    return json(res, 400, { error: "invalid_app", detail: [...APP_KEYS, "keiei"].join(", ") });
  }
  const sb = userClient(req);

  // 経営 ＝ 経営者（owner）。保存先は内部ロール。経営者だけが操作できる等の規則は changeRole が持つ
  if (app === "keiei") {
    const r = await changeRole({ ctx, user, sb, employeeId, role: "owner", grant });
    if (r.status !== 200) return json(res, r.status, r.body);
    return json(res, 200, { ok: true, employeeId, app, granted: r.body.granted, ...(await afterChange(ctx.tenantId, r.target)) });
  }

  // 対象は、このテナントの社員であること
  const { data: target } = await admin()
    .from("gw_employees").select("id, display_name, status, user_id")
    .eq("tenant_id", ctx.tenantId).eq("id", employeeId).maybeSingle();
  if (!target) return json(res, 404, { error: "employee_not_found" });

  // 経営者は全部のアプリを使える。行を作っても意味がないので、変更できないことにする
  const { data: rs } = await admin().from("gw_role_grants").select("role").eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId);
  if ((rs || []).some((g) => g.role === "owner")) {
    return json(res, 409, { error: "owner_locked", hint: "経営者は、すべてのアプリを使えます。変更できません" });
  }

  const fail = (error, code) => {
    if (isAbsent(error)) {
      return json(res, 409, { error: "app_grants_unavailable", hint: "アプリ利用権限の表（db/119）が、まだ適用されていません" });
    }
    return json(res, error.code === "42501" ? 403 : 500, { error: code, detail: error.message });
  };

  if (grant) {
    const { error } = await sb
      .from("gw_app_grants")
      .upsert({ tenant_id: ctx.tenantId, employee_id: employeeId, app_key: app, granted_by: user.id },
        { onConflict: "employee_id,app_key", ignoreDuplicates: true });
    if (error) return fail(error, "db_insert_failed");
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "app.grant", target: `employee:${employeeId}`, detail: { app } });
  } else {
    const { error } = await sb
      .from("gw_app_grants")
      .delete()
      .eq("tenant_id", ctx.tenantId)
      .eq("employee_id", employeeId)
      .eq("app_key", app);
    if (error) return fail(error, "db_delete_failed");
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "app.revoke", target: `employee:${employeeId}`, detail: { app } });
  }
  return json(res, 200, { ok: true, employeeId, app, granted: grant, ...(await afterChange(ctx.tenantId, target)) });
}
