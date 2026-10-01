// 二段階認証（TOTP）の決まり。誰に要るか、いつから止めるか。
//
// ■ 決めたこと（2026-09）
//
//   ・登録期間: 2026-09-30 まで
//   ・強制:     2026-10-01 から
//   ・対象:     管理者・人事/事務・社労士・個人情報を見られる権限
//               ＋ 経営者・責任者・経理（REQUIRED_ROLES）
//
//   いきなり強制すると、その日に誰も入れなくなる。
//   だから登録期間のあいだは止めず、画面の上に「いつまでに」と出すだけ。
//   期限を過ぎたら、対象の人は登録して認証するまで機密の API を通さない。
//
// ■ 一時停止（2026-10-01 に決めた）
//
//   全システムで MFA を必須にしない。環境変数 MFA_ENABLED が "true" のときだけ止める（下の mfaEnabled）。
//   本番は MFA_ENABLED=false。再開するときは MFA_ENABLED=true に戻すだけ（機能・登録済みの factor は残してある）。
//
// ■ Office は、MFA を要求しない（2026-09-30 に決めた）
//
//   /office と /api/office/*（月次一覧・勤務表の受領・AI読取・修正・確定・契約条件の閲覧と編集・ファイル閲覧）は、
//   経営者・責任者・経理の権限（lib/gw.js canAccessOffice）だけで通す。requireMfa を置かない。
//   置くと、強制日（2026-10-01）から、対象の役割は aal2 でないと入れなくなる（strict を付けなくても）。
//
//   MFA を残すのは、次のものを扱う API・画面
//     ・支払・振込の実行 ・給与・人件費 ・外部への請求書送信 ・権限の変更
//     ・MFA／パスワードのリセット ・金融・会計サービスへの確定送信
//     ・/keiei（経営情報。給与を含む）
//   Office には、いまこのどれも無い。Office に上のものを足すときは、その API にだけ requireMfa を置く。
//   test/mfatest.mjs が、Office に requireMfa が無いこと・上の API が MFA を通ることを見張る。
//
// ■ strict（requireMfa の第5引数）
//
//   強制日を待たず、最初から aal2 でないと通さない。登録期間の猶予を与える相手がいない新しい機能
//   （/keiei、これから作る支払・給与）で使う。既存の機密 API は、これまでどおり強制日から。
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

/**
 * 全体スイッチ（2026-10-01 に一時停止を決めた）。環境変数 MFA_ENABLED が "true" のときだけ MFA で止める。
 *
 *   MFA_ENABLED=true  … これまでどおり（強制日・strict・対象のロールで止める）
 *   それ以外（false・未設定）… 一時停止。requireMfa は常に通し、mfaState は required・blocked を false にする。
 *                       strict: true の API（/keiei など）も止めない。画面の登録案内・期限の警告・
 *                       /mypage.html#mfa への誘導も出ない（api/me・api/mfa の mfa.enabled=false を見る）
 *
 * 止めるのは「MFA による制限」だけ。MFA の機能（登録・認証・管理者のリセット・監査ログ）、
 * Supabase に登録済みの factor、Supabase Auth の設定には触れない。MFA_ENABLED=true に戻せば元どおり効く。
 * （MFA_ENFORCE_FROM を未来日にするだけでは strict: true の API が止まるので、それとは別にこのスイッチを持つ）
 *
 * 毎回読む（テストや設定の切り替えをそのまま反映するため）
 */
export const mfaEnabled = () => process.env.MFA_ENABLED === "true";

/** 登録期間の最終日と、強制の初日。環境変数で前倒し・後ろ倒しできる（試すため） */
export const ENROLL_UNTIL = process.env.MFA_ENROLL_UNTIL || "2026-09-30";
export const ENFORCE_FROM = process.env.MFA_ENFORCE_FROM || "2026-10-01";

/**
 * 対象のロール（gw_role_grants）
 *
 * 経営者（owner）・人事（hr）・社労士（labor_advisor）に加えて、責任者（manager）と経理（finance）。
 * 責任者・経理は、もとは Office のために足した。Office は MFA を要求しなくなった（上の「Office は…」）ので、
 * いま効くのは、個人情報を返す既存の API（強制日から）と、画面の登録案内だけ。
 * 支払・給与・請求書送信など、MFA を残す機能を作るときのために、対象に残している。
 * 外す・残すは別に決める（この変更では、対象のロールは変えていない）。
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
 * GoTrue の登録（POST /auth/v1/factors）の応答から、画面へ返す分だけを取り出す。欠けていれば null。
 *
 *   ・返すのは secret（手入力キー）と uri（otpauth://…。QR の元）だけ。
 *     GoTrue の qr_code は、生の SVG 文字列で、そのまま <img src> に入れると画像欠落になる（公式クライアントは
 *     先頭に data:image/svg+xml;utf-8, を付ける）。GoTrue の出力の形に頼らず、画面が uri から自分で QR を作る（js/qr.js）
 *   ・応答本文をそのまま返さない（想定外の項目・秘密の情報を、画面・ログへ漏らさない）
 *   ・uri が無くても、secret があれば手入力で登録できる（uri は null）
 */
export function enrollBody(body) {
  const t = body?.totp;
  if (!body?.id || !t?.secret) return null;
  return { id: body.id, totp: { secret: t.secret, uri: t.uri || null } };
}

/**
 * いまの状態。画面とゲートの両方がこれを見る
 *
 * strict … 強制日を待たずに止める（/keiei・これから作る支払・給与の API 用）。画面に出す enforced は
 *          日付のままで、strict は blocked にだけ効く
 * @returns {{enabled, required, enrolled, verified, enforced, enrollUntil, enforceFrom, blocked}}
 */
export function mfaState({ ctx, user, req, today = todayJst(), strict = false }) {
  const enrolled = enrolledOf(user);
  const verified = aalOf(req) === "aal2";
  // 一時停止中（MFA_ENABLED が "true" でない）：誰も止めない。案内も出さない（required=false・enforced=false）
  if (!mfaEnabled()) {
    return {
      enabled: false, required: false, enrolled, verified, enforced: false,
      enrollUntil: ENROLL_UNTIL, enforceFrom: ENFORCE_FROM, blocked: false,
    };
  }
  const required = needsMfa(ctx);
  const enforced = today >= ENFORCE_FROM;
  return {
    enabled: true, required, enrolled, verified, enforced,
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
 * { strict: true } … 強制日を待たずに止める。/keiei・これから作る支払・給与の API はこれを付ける
 * Office の API（/api/office/*）には置かない（上の「Office は、MFA を要求しない」）
 */
export async function requireMfa(req, res, ctx, user, { strict = false } = {}) {
  // 一時停止中は、strict: true の API も含めて常に通す（MFA_ENABLED=true で元に戻る）
  if (!mfaEnabled()) return true;
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
