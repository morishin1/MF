// GET    /api/employees          … 社員名簿の一覧（管理者・人事）
// POST   /api/employees          … 社員を追加（入社予定者は user_id なしで登録できる）
// PATCH  /api/employees {id,...} … 社員情報を更新
// DELETE /api/employees?id=…     … 社員を名簿から消す（記録が無い人だけ）
//
// 可視範囲・書き込み可否は RLS（db/005_groupware_core.sql）が決める。
// ここでの分岐は入口の親切表示のため。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  readAccounts, setAccountsActive, removeAccountingAccess, attachAccount, SYSTEMS,
} from "../../lib/accounts.js";

// 退職・退職手続き中は、どのシステムにも入れない状態にする
const LEFT = ["leaving", "left"];

const EMPLOYMENT_TYPES = ["正社員", "契約社員", "パート", "アルバイト", "業務委託", "役員", "その他"];
const STATUSES = ["invited", "active", "leaving", "left"];

const FIELDS =
  "id, tenant_id, user_id, display_name, email, department, position, employment_type, joined_on, left_on, work_location, status, created_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const sb = userClient(req);

  if (req.method === "GET") {
    const { data, error } = await sb
      .from("gw_employees")
      .select(FIELDS)
      .eq("tenant_id", ctx.tenantId)
      .order("status", { ascending: true })
      .order("display_name", { ascending: true })
      .limit(500);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    // 社内ロールを添える。読めない立場（メンバー等）では空のまま返る
    const { data: grants } = await sb
      .from("gw_role_grants")
      .select("employee_id, role")
      .eq("tenant_id", ctx.tenantId);
    const byEmployee = new Map();
    for (const g of grants || []) {
      if (!byEmployee.has(g.employee_id)) byEmployee.set(g.employee_id, []);
      byEmployee.get(g.employee_id).push(g.role);
    }

    // どの社内システムに登録されていて、入れる状態か。
    // 「名簿にはいるが、どこにも入れない人」を一覧で見つけられるようにする。
    // 読めない表があっても一覧そのものは返す
    let accounts = new Map();
    if (canManageHr(ctx)) {
      try {
        accounts = await readAccounts(admin(), (data || []).map((e) => e.user_id));
      } catch { /* 添え物なので、取れなければ空のままにする */ }
    }

    return json(res, 200, {
      employees: (data || []).map((e) => ({
        ...e,
        roles: byEmployee.get(e.id) || [],
        accounts: e.user_id ? (accounts.get(e.user_id) || {}) : null,
      })),
      canManage: canManageHr(ctx),
      canGrantRoles: ctx.isHr,
      systems: SYSTEMS,
    });
  }

  if (req.method === "POST") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const body = await readJson(req);
    const row = normalize(body);
    if (row.error) return json(res, 400, row);

    const { data, error } = await sb
      .from("gw_employees")
      .insert({ ...row.value, tenant_id: ctx.tenantId })
      .select(FIELDS)
      .single();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "employee.create",
      target: `employee:${data.id}`,
      detail: { name: data.display_name, department: data.department, employment_type: data.employment_type },
    });

    // メールを入れてあれば、ここでログインアカウントまで用意する。
    // 名簿に足す → アカウントを作る → 紐づける、と分かれていたせいで
    // 「名簿にはいるが、どこにも入れない人」が残っていたため1手にした。
    let account = null;
    if (body?.email && body?.createAccount !== false) {
      if (!ctx.isHr) {
        account = { ok: false, error: "forbidden", hint: "アカウントの作成には人事権限が必要です" };
      } else {
        const r = await attachAccount(admin(), {
          tenantId: ctx.tenantId, employee: data, email: body.email, clientId: body.clientId,
        });
        account = r;
        if (r.ok) {
          await gwLog({
            tenantId: ctx.tenantId, actorId: user.id,
            action: r.createdPassword ? "account.create" : "account.link",
            target: `employee:${data.id}`, detail: { email: body.email, name: data.display_name },
          });
          data.user_id = r.userId;
        }
      }
    }

    return json(res, 200, { employee: data, account });
  }

  if (req.method === "PATCH") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const body = await readJson(req);
    if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
    const row = normalize(body, { partial: true });
    if (row.error) return json(res, 400, row);

    // 状態が変わるかどうかを、書き換える前に見ておく
    const { data: before } = await sb
      .from("gw_employees").select("status, user_id")
      .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();

    const { data, error } = await sb
      .from("gw_employees")
      .update({ ...row.value, updated_at: new Date().toISOString() })
      .eq("id", body.id)
      .eq("tenant_id", ctx.tenantId)
      .select(FIELDS)
      .maybeSingle();
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
    if (!data) return json(res, 404, { error: "employee_not_found" });

    // 在籍状態は退職処理につながるので、変更を残す
    let systems = null;
    if (row.value.status) {
      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id, action: "employee.status",
        target: `employee:${data.id}`, detail: { name: data.display_name, status: row.value.status },
      });

      // 退職にしたら、社内システムの入口をまとめて閉じる。
      // ここを手作業に残すと、辞めた人が無限道場やタイムカードに入れる状態が
      // そのまま残る。逆に在籍へ戻したら開け直す。
      const wasOut = LEFT.includes(before?.status);
      const isOut = LEFT.includes(data.status);
      if (data.user_id && wasOut !== isOut) {
        const sbAdmin = admin();
        systems = await setAccountsActive(sbAdmin, data.user_id, !isOut);
        // 会計は「止める」ではなく本当に外す。止まった行を残すと戻したとき気づけない
        if (isOut) systems.accounting = await removeAccountingAccess(sbAdmin, ctx.tenantId, data.user_id);
        await gwLog({
          tenantId: ctx.tenantId, actorId: user.id,
          action: isOut ? "account.suspend" : "account.resume",
          target: `employee:${data.id}`, detail: { name: data.display_name, systems },
        });
      }
    }
    return json(res, 200, { employee: data, systems });
  }

  if (req.method === "DELETE") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

    const { data: target } = await sb
      .from("gw_employees").select("id, display_name, user_id")
      .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!target) return json(res, 404, { error: "employee_not_found" });

    // 自分を消すと、その場で名簿を触れなくなる
    if (ctx.employee?.id === id) {
      return json(res, 400, { error: "cannot_delete_self", hint: "自分自身は削除できません" });
    }

    // 経費や申請が紐づいている人を消すと、その記録ごと消える（外部キーが cascade）。
    // 過去の申請・承認の記録は会社として残すものなので、消させずに退職を勧める。
    const blockers = await relatedRecords(sb, ctx.tenantId, id);
    if (blockers.length) {
      return json(res, 409, {
        error: "employee_has_records",
        blockers,
        hint: `${blockers.map((b) => `${b.label}${b.count}件`).join("・")}が残っています。` +
              "消すとこの記録も一緒に消えるため、状態を「退職」に変えてください。",
      });
    }

    const { error } = await sb
      .from("gw_employees").delete().eq("id", id).eq("tenant_id", ctx.tenantId);
    if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });

    // ログインアカウント（auth.users）は消さない。同じアカウントを
    // 無限道場・タイムカード・事務ポータルも使っていて、消すと向こうの記録まで消える。
    // ただし名簿から外した以上、社内システムには入れないようにしておく。
    let systems = null;
    if (target.user_id) {
      const sbAdmin = admin();
      systems = await setAccountsActive(sbAdmin, target.user_id, false);
      systems.accounting = await removeAccountingAccess(sbAdmin, ctx.tenantId, target.user_id);
    }

    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "employee.delete",
      target: `employee:${id}`, detail: { name: target.display_name, had_login: !!target.user_id, systems },
    });
    return json(res, 200, { ok: true, id, authUserKept: !!target.user_id, systems });
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

// 消すと道連れになる記録を数える。0件のものは返さない
async function relatedRecords(sb, tenantId, employeeId) {
  const targets = [
    { table: "gw_expense_reports", column: "employee_id", label: "経費申請" },
    { table: "gw_requests",        column: "employee_id", label: "有給・稟議" },
    { table: "gw_bookings",        column: "employee_id", label: "設備予約" },
    { table: "gw_procedures",      column: "employee_id", label: "入退社手続き" },
    { table: "gw_messages",        column: "sender_id",   label: "チャット" },
  ];
  const out = [];
  for (const t of targets) {
    // まだ流していないマイグレーションの表があっても、削除の判定を止めない
    const { count, error } = await sb
      .from(t.table).select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq(t.column, employeeId);
    if (error) continue;
    if (count) out.push({ label: t.label, count });
  }
  return out;
}

function normalize(body, { partial = false } = {}) {
  const v = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has("display_name")) {
    const name = String(body.display_name ?? "").trim();
    if (!name) return { error: "invalid_body", detail: "display_name は必須です" };
    v.display_name = name;
  }
  if (has("email")) v.email = String(body.email || "").trim() || null;
  if (has("department")) v.department = String(body.department || "").trim() || null;
  if (has("position")) v.position = String(body.position || "").trim() || null;
  if (has("work_location")) v.work_location = String(body.work_location || "").trim() || null;
  if (has("joined_on")) v.joined_on = body.joined_on || null;
  if (has("left_on")) v.left_on = body.left_on || null;

  if (has("employment_type") && body.employment_type) {
    if (!EMPLOYMENT_TYPES.includes(body.employment_type)) {
      return { error: "invalid_employment_type", detail: EMPLOYMENT_TYPES.join(", ") };
    }
    v.employment_type = body.employment_type;
  }
  if (has("status") && body.status) {
    if (!STATUSES.includes(body.status)) return { error: "invalid_status", detail: STATUSES.join(", ") };
    v.status = body.status;
  }
  // user_id はここでは受け付けない。他人のアカウントに紐づけ替えられてしまうため、
  // 招待の受け入れ（アカウントとの紐づけ）は別の口で扱う。
  return { value: v };
}
