// PATCH /api/employees/account
//   { employeeId, email?, password?, generatePassword?, systems?: {lms, timecard, accounting} }
//
// メンバーのログイン情報と、使えるシステムを管理者が変える。
//
// ■ 4つのシステムは同じログインを使っている
//   グループウェア・無限道場・タイムカード・会計は、
//   ぜんぶ同じ auth.users の1つのアカウントで入る。
//   だからここでメールやパスワードを変えると、4つとも変わる。
//   「グループウェアのパスワードだけ変える」はできない。
//   画面にもそう書いてある（admin-members.html）。
//
// ■ パスワードは1回だけ返す
//   保存はしない。返した文字列を管理者が控えて、本人へ直接渡す。
//   メールで送る仕組みにしていないのは、送信設定に依存させないため。
//
// ■ グループウェアは切れない
//   名簿に行があること自体が利用。切りたいときは在籍の状態（退職）で閉じる。
//   ここで切れるのは 無限道場・タイムカード・会計 の3つ。
//
// ■ 記録を残す
//   誰が誰のログインを変えたかは、あとから必ず問われる。gw_audit に残す。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { setSystemAccess, randomPassword, findUserByEmail, SYSTEMS } from "../../lib/accounts.js";

const TOGGLEABLE = new Set(["lms", "timecard", "accounting"]);
const MIN_PASSWORD = 8;

export default async function handler(req, res) {
  if (req.method !== "PATCH") return methodNotAllowed(res, ["PATCH"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 管理者（または人事）。この会社にいるのは管理者とメンバーだけなので、
  // 管理者にはメンバー管理を全部できるようにしてある。
  // 権限をここで細かく割るより、誰が何をしたかを記録して追える形にする
  if (!canManageHr(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "メンバーの管理には管理者権限が必要です" });
  }

  const body = await readJson(req);
  const employeeId = body?.employeeId;
  if (!employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });

  const sb = admin();
  const { data: emp, error } = await sb
    .from("gw_employees")
    .select("id, display_name, email, user_id, employment_type, status")
    .eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!emp) return json(res, 404, { error: "employee_not_found" });

  if (!emp.user_id) {
    return json(res, 400, {
      error: "not_linked",
      hint: "この方はまだログインアカウントと結び付いていません。先に「アカウントを作る」を押してください",
    });
  }

  const out = { employeeId, systems: {} };

  // ---- メールアドレス --------------------------------------------------------
  if (body?.email !== undefined) {
    const addr = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      return json(res, 400, { error: "invalid_email", hint: "メールアドレスの形になっていません" });
    }
    if (addr !== String(emp.email || "").toLowerCase()) {
      // 他の人が使っていないか。使っていると、ログインが2人ぶん混ざる
      const otherId = await findUserByEmail(sb, addr);
      if (otherId && otherId !== emp.user_id) {
        return json(res, 409, {
          error: "email_taken",
          hint: "そのメールアドレスは別のアカウントで使われています",
        });
      }

      const { error: ae } = await sb.auth.admin.updateUserById(emp.user_id, {
        email: addr,
        email_confirm: true,   // 確認メールを待たずに使えるようにする
      });
      if (ae) return json(res, 502, { error: "auth_update_failed", detail: ae.message });

      await sb.from("gw_employees").update({ email: addr, updated_at: new Date().toISOString() })
        .eq("id", emp.id);
      out.email = addr;
      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id,
        action: "account.email_change",
        target: `employee:${emp.id}`,
        detail: { from: emp.email || null, to: addr, name: emp.display_name },
      });
    }
  }

  // ---- パスワード ------------------------------------------------------------
  if (body?.password !== undefined || body?.generatePassword) {
    const pw = body?.generatePassword ? randomPassword() : String(body.password || "");
    if (pw.length < MIN_PASSWORD) {
      return json(res, 400, {
        error: "weak_password",
        hint: `パスワードは${MIN_PASSWORD}文字以上にしてください`,
      });
    }
    const { error: pe } = await sb.auth.admin.updateUserById(emp.user_id, { password: pw });
    if (pe) return json(res, 502, { error: "auth_update_failed", detail: pe.message });

    // 保存はしない。ここで返す1回だけ
    out.password = pw;
    // パスワードそのものは残さない。誰のを変えたか、だけ
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id,
      action: "account.password_reset",
      target: `employee:${emp.id}`,
      detail: { name: emp.display_name },
    });
  }

  // ---- 使えるシステム --------------------------------------------------------
  if (body?.systems && typeof body.systems === "object") {
    for (const [key, on] of Object.entries(body.systems)) {
      if (!TOGGLEABLE.has(key)) {
        out.systems[key] = { ok: false, detail: "個別に切り替えられません" };
        continue;
      }
      const r = await setSystemAccess(sb, {
        tenantId: ctx.tenantId,
        userId: emp.user_id,
        system: key,
        on: !!on,
        name: emp.display_name,
        employmentType: emp.employment_type,
        clientId: body?.clientId,
      });
      out.systems[key] = r;
      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id,
        action: on ? "account.system_on" : "account.system_off",
        target: `employee:${emp.id}`,
        detail: { system: key, name: emp.display_name, result: r.ok ? r.action : r.detail },
      });
    }
  }

  return json(res, 200, { ok: true, ...out, all: SYSTEMS });
}
