// 二段階認証（TOTP）の決まり。誰に要るか、いつから止めるか。
//
// ■ 決めたこと（2026-09）
//
//   ・登録期間: 2026-09-30 まで
//   ・強制:     2026-10-01 から
//   ・対象:     管理者・人事/事務・社労士・個人情報を見られる権限
//               ＋ 金額を見られる権限（Office = 経営者・責任者・経理、/keiei = 経営者）
//
//   いきなり強制すると、その日に誰も入れなくなる。
//   だから登録期間のあいだは止めず、画面の上に「いつまでに」と出すだけ。
//   期限を過ぎたら、対象の人は登録して認証するまで機密の API を通さない。
//
// ■ Office・/keiei は、強制日を待たない（strict）
//
//   Office（単価・請求額・支払）と /keiei（経営情報）は新しい機能で、これまでの利用者がいない。
//   登録期間の猶予を与える相手がいないので、最初から aal2 でないと通さない
//   （requireMfa の第5引数 { strict: true }）。既存の機密 API は、これまでどおり強制日から。
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

/**
 * 対象のロール（gw_role_grants）
 *
 * 経営者（owner）・人事（hr）・社労士（labor_advisor）に加えて、
 * 責任者（manager）と経理（finance）。Office で単価・請求額・支払を見られる人（lib/gw.js OFFICE_ROLES）が
 * 二段階認証なしで入れないようにするため。/keiei（KEIEI_ROLES = 経営者のみ）も、ここに含まれる。
 * test/mfatest.mjs が、OFFICE_ROLES・KEIEI_ROLES がすべてここに入っていることを見る
 */
export const REQUIRED_ROLES = ["owner", "manager", "finance", "hr", "labor_advisor"];

/** 日本時間の今日（YYYY-MM-DD） */
export const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

/**
 * この人に二段階認証が要るか。
 *   管理者（会計側 admin/staff）・経営者・責任者・経理・人事・社労士。
 *   個人情報（RLS の gw_is_hr / gw_is_advisor）と金額（Office・/keiei）を見られる権限
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
 *
 * strict … 強制日を待たずに止める（Office・/keiei の API 用）。画面に出す enforced は
 *          日付のままで、strict は blocked にだけ効く
 * @returns {{required, enrolled, verified, enforced, enrollUntil, enforceFrom, blocked}}
 */
export function mfaState({ ctx, user, req, today = todayJst(), strict = false }) {
  const required = needsMfa(ctx);
  const enrolled = enrolledOf(user);
  const verified = aalOf(req) === "aal2";
  const enforced = today >= ENFORCE_FROM;
  return {
    required, enrolled, verified, enforced,
    enrollUntil: ENROLL_UNTIL, enforceFrom: ENFORCE_FROM,
    // 止めるのは、対象で・（強制日を過ぎている、または strict）で・今回の入り方が aal2 でないとき
    blocked: required && (enforced || strict) && !verified,
  };
}

/**
 * 自分で登録を外せるか。
 *
 *   強制日より前        … 外せる（ただし直前に6桁で確かめた aal2 のときだけ＝再認証）
 *   強制日以降・対象の人 … 外せない。管理者のリセット（api/mfa.js action=reset）だけ
 *   強制日以降・対象外   … 外せる（再認証つき）
 *
 * 「外せない」のは画面で隠すためではない。api/mfa.js がここを見て 403 を返す。
 * 本人が Supabase を直接叩いて外したとしても、次の要求は aal1 なので
 * requireMfa が機密の API を止める。守りはそちら
 */
export function selfUnenroll({ ctx, req, today = todayJst() }) {
  const st = mfaState({ ctx, user: { factors: [] }, req, today });
  if (st.required && st.enforced) {
    return { ok: false, reason: "locked",
      hint: "強制期間中は自分では外せません。外す必要があるときは管理者にリセットを依頼してください" };
  }
  if (!st.verified) {
    return { ok: false, reason: "reauth",
      hint: "外す前に、認証アプリの6桁でもう一度確かめてください" };
  }
  return { ok: true };
}

/**
 * 機密の API の入口に置く。通せなければ 403 を返して false。
 * 画面は mfa_required を受けたらマイページの登録へ送る（js/api-client.js）
 *
 * { strict: true } … 強制日を待たずに止める。Office・/keiei の API はこれを付ける
 */
export async function requireMfa(req, res, ctx, user, { strict = false } = {}) {
  const st = mfaState({ ctx, user, req, strict });
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
