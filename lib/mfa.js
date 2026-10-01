// 二段階認証（TOTP）。**任意**のセキュリティ設定。
//
// ■ 方針（2026-10-01 に変更。それまでは「対象の権限は必須・2026-10-01 から強制」だった）
//
//   ・二段階認証は、誰にも必須にしない。2026-10-01 以降の強制もしない
//   ・登録していないことを、エラー・警告にしない（画面の案内帯も出さない）
//   ・登録する機能（マイページ）は残す。使うかどうかは本人が決める。登録した人は、ログインのとき6桁を聞かれる
//   ・機密の画面・API（個人情報・給与・/keiei）を守るのは、**ロール**（owner・人事・管理者 など）の判定。
//     二段階認証は、守りに使わない
//   ・owner の保護（最後の owner を外せない・owner の付与は owner だけ・乗っ取り経路の遮断。db/099）は、
//     二段階認証とは別のしくみで、そのまま
//
// ■ いまの実装
//
//   requireMfa は、呼び出し側（個人情報を返す約30の API）を変えずに済むよう、関数として残してある。
//   **何も止めない**（常に通す）。各 API に残っている「強制日以降」「対象の人は二段階認証」のコメントは、昔のもの。
//   戻す（必須にする）ときは、この関数と mfaState の required / blocked を作り直す（履歴: 2026-09 の「必須」の版）。
//
// ■ 仕組み（登録した人の分）
//
//   Supabase Auth の TOTP をそのまま使う。
//   パスワードで入った直後のトークンは aal1。
//   認証アプリの6桁で確かめると aal2 のトークンに変わる。
//   サーバはトークンの aal だけを見る。自前で秘密を持たない。
//   自分で登録を外すときだけ、直前に6桁で確かめた aal2 を要る（パスワードだけで、登録を外されないように）

/**
 * 二段階認証が「要る」か。**誰にも要らない**（任意）。
 * 呼び出し側（api/me.js の mfaState など）が形を変えずに使えるよう、関数として残している
 */
export function needsMfa() {
  return false;
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
 * いまの状態（api/me.js・api/mfa.js が画面へ返す）。
 * required / enforced / blocked は、いつも false（任意。強制しない）。画面は、登録済みかどうか（enrolled）だけを使う
 * @returns {{required:false, enrolled:boolean, verified:boolean, enforced:false, enrollUntil:null, enforceFrom:null, blocked:false}}
 */
export function mfaState({ user, req } = {}) {
  return {
    required: false,
    enrolled: enrolledOf(user),
    verified: aalOf(req) === "aal2",
    enforced: false,
    enrollUntil: null,
    enforceFrom: null,
    blocked: false,
  };
}

/**
 * 自分で登録を外せるか。
 *
 *   直前に6桁で確かめた（aal2）ときだけ外せる。パスワードだけ（aal1）では外せない（再認証）。
 *   必須ではないので、「強制期間中は外せない」はない。
 *
 * 外すのは本人の操作。外したあとも、何も止まらない（二段階認証は任意）
 */
export function selfUnenroll({ req } = {}) {
  if (aalOf(req) !== "aal2") {
    return { ok: false, reason: "reauth",
      hint: "外す前に、認証アプリの6桁でもう一度確かめてください" };
  }
  return { ok: true };
}

/**
 * 呼び出し側（個人情報などを返す API の入口）に残してある。**何も止めない**（常に true）。
 * 二段階認証は任意で、機密の API を守るのは、各 API のロールの判定（canManageHr など）。
 * 引数は、昔の呼び出し（req, res, ctx, user, { strict }）のまま受け取って、使わない
 */
export async function requireMfa() {
  return true;
}
