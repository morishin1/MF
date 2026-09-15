// 二段階認証（TOTP）の決まり。誰に要るか、いつから止めるか。
//
// ■ 決めたこと（2026-09）
//
//   ・登録期間: 2026-09-30 まで
//   ・強制:     2026-10-01 から
//   ・対象:     管理者・人事/事務・社労士・個人情報を見られる権限
//
//   いきなり強制すると、その日に誰も入れなくなる。
//   だから登録期間のあいだは止めず、画面の上に「いつまでに」と出すだけ。
//   期限を過ぎたら、対象の人は登録して認証するまで機密の API を通さない。
//
// ■ 仕組み
//
//   Supabase Auth の TOTP をそのまま使う。
//   パスワードで入った直後のトークンは aal1。
//   認証アプリの6桁で確かめると aal2 のトークンに変わる。
//   サーバはトークンの aal だけを見る。自前で秘密を持たない。
//
// ■ ここで「止める」のは、機密を返す API だけ
//
//   ホームやタスクまで止めると、登録のためにマイページへ行く道まで塞がる。
//   届出・書類・契約・名簿・端末の記録を返すところに requireMfa を置く。

import { json } from "./http.js";

/** 登録期間の最終日と、強制の初日。環境変数で前倒し・後ろ倒しできる（試すため） */
export const ENROLL_UNTIL = process.env.MFA_ENROLL_UNTIL || "2026-09-30";
export const ENFORCE_FROM = process.env.MFA_ENFORCE_FROM || "2026-10-01";

/** 対象のロール（gw_role_grants） */
export const REQUIRED_ROLES = ["owner", "hr", "labor_advisor"];

/** 日本時間の今日（YYYY-MM-DD） */
export const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

/**
 * この人に二段階認証が要るか。
 *   管理者（会計側 admin/staff）・経営者・人事・社労士。
 *   個人情報を見られる権限は、この4つに収まっている（RLS の gw_is_hr / gw_is_advisor）
 */
export function needsMfa(ctx) {
  if (!ctx) return false;
  if (ctx.isAdmin) return true;
  const roles = ctx.roles || [];
  return REQUIRED_ROLES.some((r) => roles.includes(r));
}

/** トークンの aal（aal1 / aal2）。読めなければ null */
export function aalOf(req) {
  const h = String(req?.headers?.authorization || "");
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const parts = tok.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return payload.aal || null;
  } catch {
    return null;
  }
}

/** 登録済みか（Supabase の user.factors に verified の TOTP があるか） */
export function enrolledOf(user) {
  return (user?.factors || []).some((f) => f.status === "verified"
    && (!f.factor_type || f.factor_type === "totp"));
}

/**
 * いまの状態。画面とゲートの両方がこれを見る
 * @returns {{required, enrolled, verified, enforced, enrollUntil, enforceFrom, blocked}}
 */
export function mfaState({ ctx, user, req, today = todayJst() }) {
  const required = needsMfa(ctx);
  const enrolled = enrolledOf(user);
  const verified = aalOf(req) === "aal2";
  const enforced = today >= ENFORCE_FROM;
  return {
    required, enrolled, verified, enforced,
    enrollUntil: ENROLL_UNTIL, enforceFrom: ENFORCE_FROM,
    // 止めるのは、対象で・強制日を過ぎていて・今回の入り方が aal2 でないとき
    blocked: required && enforced && !verified,
  };
}

/**
 * 機密の API の入口に置く。通せなければ 403 を返して false。
 * 画面は mfa_required を受けたらマイページの登録へ送る（js/api-client.js）
 */
export async function requireMfa(req, res, ctx, user) {
  const st = mfaState({ ctx, user, req });
  if (!st.blocked) return true;
  json(res, 403, {
    error: "mfa_required",
    hint: st.enrolled
      ? "二段階認証で確かめてから開いてください（ログインし直すと6桁の入力が出ます）"
      : "この画面を開くには二段階認証の登録が必要です。マイページで登録してください",
    enrolled: st.enrolled,
  });
  return false;
}
