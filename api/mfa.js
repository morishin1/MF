// GET  /api/mfa                       … いまの状態（要るか・登録済みか・自分で外せるか・リセット中か）
// POST /api/mfa {action:"enroll"}     … 登録を始める（QR と手入力キーが返る）
// POST /api/mfa {action:"verify", factorId, code} … 6桁で確かめて登録を終える（aal2 のトークンが返る）
// POST /api/mfa {action:"unenroll", factorId}     … 自分で外す（再認証つき。強制期間中の対象者は不可）
// POST /api/mfa {action:"reset", employeeId}      … 管理者・経営者が外す（本人は登録し直す）。
//                                                   経営者（owner）のぶんは、経営者だけが外せる
//
// ■ なぜ Supabase を直接ではなく、ここを通すのか
//
//   登録・解除・リセット・再登録を、ぜんぶ gw_activity_log に残すため。
//   画面から Supabase を直接叩くと、外したことがどこにも残らない。
//   ログインのときの6桁の確認だけは、画面から直接（記録が要るのは登録の出入りだけ）。
//
// ■ 守りは UI ではなく API
//
//   本人が Supabase を直接叩いて外すことはできる（それを止める設定は無い）。
//   ただ、外した瞬間からその人のトークンは aal1 になり、
//   機密の API は requireMfa（lib/mfa.js）で止まる。「外しても何も見られない」が守り。
//   ここで 403 を返すのは、正しい道（管理者のリセット）を案内するため。
//
// ■ リセットは管理者だけ・自分のはできない
//   自分で自分をリセットできると、強制の意味が無い。別の管理者に頼む。
//
// ■ 経営者（owner）の二段階認証は、経営者だけがリセットできる
//   管理者・人事が owner の認証を外せると、パスワードを知っている人が、
//   管理者を経由して自分の認証アプリに差し替えられる（経営の画面は認証さえ通れば開く）。
//   だから
//     経営者 → 一般ユーザー    可
//     経営者 → ほかの経営者    可（二段階認証は任意。実行する経営者に aal2 は要らない。owner のロールの判定だけ）
//     管理者・人事 → 経営者    不可（403 owner_only）。試みたことは記録に残す
//     経営者 → 自分            不可（自分では外せない）
//   経営者が1人だけで、その人が認証アプリを失ったときは、画面からは復旧できない
//   （二段階認証は任意なので、登録していなければ、パスワードで入れる）。
//   Supabase の SQL による緊急復旧（docs/keiei-owner-recovery.md）で行う。
//   通常の画面に、経営者を乗っ取れる経路は残さない。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../lib/http.js";
import { requireUser } from "../lib/auth.js";
import { gwContext, canManageHr, isOwner } from "../lib/gw.js";
import { admin } from "../lib/supabase.js";
import { enrollBody } from "../lib/mfa.js";
import { gwLog } from "../lib/gw-audit.js";
import { notify } from "../lib/notify.js";
import { mfaState, selfUnenroll, requireMfa, enrolledOf } from "../lib/mfa.js";
import { isOwnerEmployee, guardOwnerTarget, INACTIVE } from "../lib/owner-guard.js";

const RESET_WINDOW_DAYS = 7;
const SQL = "db/071_onboarding_stage2.sql";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);

  if (req.method === "GET") return status(req, res, ctx, user);
  if (req.method === "POST") {
    const body = await readJson(req);
    switch (body?.action) {
      case "enroll":   return enroll(req, res, ctx, user);
      case "verify":   return verify(req, res, ctx, user, body);
      case "unenroll": return unenroll(req, res, ctx, user, body);
      case "reset":    return reset(req, res, ctx, user, body);
      default: return json(res, 400, { error: "unknown_action" });
    }
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 状態 ---------------------------------------------------------------------
async function status(req, res, ctx, user) {
  const st = mfaState({ ctx, user, req });
  const un = selfUnenroll({ ctx, req });
  const open = await openReset(user.id);
  return json(res, 200, {
    ...st,
    factors: (user.factors || []).filter((f) => !f.factor_type || f.factor_type === "totp")
      .map((f) => ({ id: f.id, status: f.status, name: f.friendly_name || null })),
    // 自分で外せるか。locked なら管理者のリセットだけ
    selfUnenroll: un.ok ? "ok" : un.reason,
    selfUnenrollHint: un.ok ? null : un.hint,
    reset: open ? { at: open.reset_at, expiresAt: open.expires_at } : null,
  });
}

// ---- 登録 ---------------------------------------------------------------------
async function enroll(req, res, ctx, user) {
  // 途中でやめた未確認の登録が残っていると、Supabase は新しい登録を断る。先に片付ける
  const sb = admin();
  for (const f of user.factors || []) {
    if (f.status !== "verified") await sb.auth.admin.mfa.deleteFactor({ id: f.id, userId: user.id }).catch(() => {});
  }
  const r = await gotrue(req, "/factors", { method: "POST",
    body: { factor_type: "totp", friendly_name: "エイト" } });
  if (!r.ok) {
    const notEnabled = /not enabled|disabled/i.test(r.body?.msg || r.body?.message || "") || r.status === 422;
    return json(res, r.status === 422 ? 409 : 502, {
      error: notEnabled ? "mfa_not_enabled" : "auth_failed",
      hint: notEnabled
        ? "Supabase 側で MFA（TOTP）が有効になっていません。管理者に Authentication → Multi-Factor の設定を依頼してください"
        : (r.body?.msg || r.body?.message || "始められませんでした"),
    });
  }
  // 応答が欠けていたら、中身を出さずに断る（セットアップキーが無いと登録できない。応答本文は、そのまま返さない）
  const out = enrollBody(r.body);
  if (!out) return json(res, 502, { error: "auth_failed", hint: "登録用の情報を受け取れませんでした。もう一度お試しください" });
  // 監査ログには、要素の ID だけを残す。秘密の情報（secret・uri・QR）は、ログにも監査ログにも入れない
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "mfa.enroll_start",
                target: `user:${user.id}`, detail: { factorId: out.id } });
  // 画面に渡すのは secret と uri だけ（lib/mfa.js enrollBody）。GoTrue の qr_code（生の SVG）は渡さない。
  // QR は、画面が uri から自分で作る（js/qr.js）。この応答は、端末にもプロキシにも残さない
  res.setHeader("Cache-Control", "no-store");
  return json(res, 200, out);
}

async function verify(req, res, ctx, user, body) {
  const factorId = String(body?.factorId || "");
  const code = String(body?.code || "").trim();
  if (!factorId || !/^\d{6}$/.test(code)) return json(res, 400, { error: "bad_request", hint: "6桁の数字を入れてください" });

  const wasEnrolled = enrolledOf(user);
  const ch = await gotrue(req, `/factors/${factorId}/challenge`, { method: "POST" });
  if (!ch.ok) return json(res, 502, { error: "auth_failed", hint: ch.body?.msg || "確認を始められませんでした" });
  const v = await gotrue(req, `/factors/${factorId}/verify`, { method: "POST",
    body: { challenge_id: ch.body.id, code } });
  if (!v.ok) {
    return json(res, 400, { error: "mfa_code_invalid",
      hint: "コードが合いません。アプリの表示が変わるのを待って、もう一度入れてください" });
  }

  // 登録か、登録し直しか。リセットの窓が開いていれば閉じる
  const sb = admin();
  const open = await openReset(user.id);
  if (open) {
    await sb.from("gw_mfa_resets").update({ used_at: new Date().toISOString() }).eq("id", open.id);
  }
  const prior = await hadEnrolled(sb, user.id);
  const action = (open || prior || wasEnrolled) ? "mfa.reenroll" : "mfa.enroll";
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action,
                target: `user:${user.id}`, detail: { factorId, afterReset: !!open } });

  // aal2 のセッション。画面はこれを覚え直す
  const s = v.body || {};
  return json(res, 200, {
    ok: true, action,
    session: s.access_token ? {
      access_token: s.access_token, refresh_token: s.refresh_token,
      expires_in: s.expires_in, expires_at: s.expires_at, token_type: s.token_type,
    } : null,
  });
}

// ---- 解除（自分で） -----------------------------------------------------------
async function unenroll(req, res, ctx, user, body) {
  const factorId = String(body?.factorId || "");
  if (!factorId) return json(res, 400, { error: "bad_request", required: ["factorId"] });
  const un = selfUnenroll({ ctx, req });
  if (!un.ok) {
    return json(res, 403, { error: un.reason === "locked" ? "mfa_locked" : "mfa_reauth", hint: un.hint });
  }
  const mine = (user.factors || []).some((f) => f.id === factorId);
  if (!mine) return json(res, 404, { error: "not_found" });

  const sb = admin();
  const { error } = await sb.auth.admin.mfa.deleteFactor({ id: factorId, userId: user.id });
  if (error) return json(res, 502, { error: "auth_failed", hint: error.message });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "mfa.unenroll",
                target: `user:${user.id}`, detail: { factorId, self: true } });
  return json(res, 200, { ok: true });
}

// ---- リセット（管理者） -------------------------------------------------------
async function reset(req, res, ctx, user, body) {
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden", hint: "管理者だけができます" });
  // 管理者自身が二段階認証を済ませていること（強制日以降）
  if (!(await requireMfa(req, res, ctx, user))) return;

  const employeeId = String(body?.employeeId || "");
  if (!employeeId) return json(res, 400, { error: "bad_request", required: ["employeeId"] });
  const sb = admin();
  const { data: emp } = await sb.from("gw_employees").select("id, display_name, user_id")
    .eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found" });
  if (!emp.user_id) return json(res, 400, { error: "not_linked", hint: "ログインアカウントがありません" });
  if (emp.user_id === user.id) {
    return json(res, 403, { error: "self_reset", hint: isOwner(ctx)
      ? "自分の二段階認証は自分でリセットできません。ほかの経営者に依頼してください（経営者が1人だけのときは docs/keiei-owner-recovery.md の緊急復旧）"
      : "自分の二段階認証は自分でリセットできません。別の管理者に依頼してください" });
  }

  // 経営者の認証は、経営者だけが外せる。管理者・人事は、試みた記録だけを残して断る
  const targetIsOwner = await isOwnerEmployee(sb, ctx.tenantId, emp.id);
  if (targetIsOwner) {
    const blocked = await guardOwnerTarget(sb, ctx, emp.id, "二段階認証のリセット");
    if (blocked) {
      await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "mfa.reset_denied",
                    target: `employee:${emp.id}`, detail: { name: emp.display_name, reason: "owner_only" } });
      return json(res, blocked.status, blocked.body);
    }
  }

  const { data: fl, error: le } = await sb.auth.admin.mfa.listFactors({ userId: emp.user_id });
  if (le) return json(res, 502, { error: "auth_failed", hint: le.message });
  const factors = fl?.factors || [];
  let removed = 0;
  for (const f of factors) {
    const { error } = await sb.auth.admin.mfa.deleteFactor({ id: f.id, userId: emp.user_id });
    if (!error) removed++;
  }

  const now = new Date();
  const expires = new Date(now.getTime() + RESET_WINDOW_DAYS * 86400000).toISOString();
  const { error: ie } = await sb.from("gw_mfa_resets").insert({
    tenant_id: ctx.tenantId, user_id: emp.user_id, employee_id: emp.id,
    reset_by: user.id, expires_at: expires, note: body?.note ? String(body.note).slice(0, 300) : null,
  });
  if (ie) {
    const hint = dbSetupHint(ie, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: ie.message });
  }

  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "mfa.reset",
                target: `employee:${emp.id}`,
                detail: { name: emp.display_name, removed, expiresAt: expires, ownerTarget: targetIsOwner } });
  const notices = [{
    tenantId: ctx.tenantId, employeeId: emp.id, kind: "blocker",
    title: "二段階認証をリセットしました",
    body: targetIsOwner
      ? "経営者がリセットしました。心当たりがない場合は、すぐに別の経営者へ連絡してください。マイページから、認証アプリで登録し直してください。"
      : "管理者がリセットしました。マイページから、認証アプリで登録し直してください。",
    link: "mypage.html#mfa", dedupeKey: `mfa-reset:${emp.id}`,
  }];
  // 経営者のリセットは、ほかの在籍中の経営者にも知らせる（なりすましに気づけるように）
  if (targetIsOwner) notices.push(...(await otherOwnerNotices(sb, ctx, emp)));
  await notify(notices);
  return json(res, 200, { ok: true, removed, expiresAt: expires });
}

// ---- 小物 ---------------------------------------------------------------------

/** 対象の経営者と、実行した人を除く、在籍中の経営者への知らせ */
async function otherOwnerNotices(sb, ctx, target) {
  try {
    const { data: grants } = await sb.from("gw_role_grants").select("employee_id")
      .eq("tenant_id", ctx.tenantId).eq("role", "owner");
    const ids = [...new Set((grants || []).map((g) => g.employee_id))]
      .filter((id) => id && id !== target.id && id !== ctx.employee?.id);
    if (!ids.length) return [];
    const { data: emps } = await sb.from("gw_employees").select("id, status")
      .eq("tenant_id", ctx.tenantId).in("id", ids);
    return (emps || []).filter((e) => !INACTIVE.includes(e.status)).map((e) => ({
      tenantId: ctx.tenantId, employeeId: e.id, kind: "blocker",
      title: "経営者の二段階認証がリセットされました",
      body: `${target.display_name} さんの二段階認証を、${ctx.employee?.display_name || "経営者"} さんがリセットしました。心当たりがない場合は確認してください。`,
      link: "admin-members.html", dedupeKey: `mfa-reset-owner:${target.id}:${e.id}`,
    }));
  } catch { return []; }
}

/** GoTrue を、本人のトークンで呼ぶ */
async function gotrue(req, path, { method = "GET", body } = {}) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const auth = req.headers["authorization"] || req.headers["Authorization"] || "";
  const r = await fetch(`${url}/auth/v1${path}`, {
    method,
    headers: { apikey: anon, Authorization: auth, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: data };
}

/** 開いているリセットの窓（期限内・未使用） */
async function openReset(userId) {
  try {
    const { data } = await admin().from("gw_mfa_resets")
      .select("id, reset_at, expires_at, used_at")
      .eq("user_id", userId).is("used_at", null)
      .order("reset_at", { ascending: false }).limit(1);
    const r = (data || [])[0];
    if (!r) return null;
    return r.expires_at > new Date().toISOString() ? r : null;
  } catch { return null; }
}

/** 前に登録したことがあるか（記録から） */
async function hadEnrolled(sb, userId) {
  try {
    const { data } = await sb.from("gw_activity_log").select("id")
      .eq("actor_id", userId).in("action", ["mfa.enroll", "mfa.reenroll"]).limit(1);
    return (data || []).length > 0;
  } catch { return false; }
}
