// 外部メンバー（ゲスト）招待。値の定義・トークン・状態の判定。
// db/078_external_guests.sql と1対1。api/guests/*.js から使う。
//
// ■ トークンは、端末ペアリング（lib/devices.js）と同じ考え方
//   平文は発行のときに1度だけ返す。DBには sha256 のハッシュだけを持つ

import crypto from "node:crypto";

export const RESOURCE_TYPES = ["project", "thread", "document", "task"];
export const RESOURCE_LABEL = { project: "プロジェクト", thread: "チャット", document: "資料", task: "タスク" };

export const INVITE_TTL_HOURS = 168; // 7日
export const STATUSES = ["invited", "active", "expired", "revoked"];
export const STATUS_LABEL = { invited: "招待済み", active: "登録完了", expired: "期限切れ", revoked: "無効" };

export const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
export const newInviteToken = () => crypto.randomBytes(32).toString("base64url");
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,200}$/;

/**
 * ゲスト1人の「いまの状態」を、本人の行と最新の招待から決める。
 * 招待は再発行のたびに新しい行ができるので、いちばん新しい1件だけを見る
 *
 * @param {object} guest    gw_guests の1行
 * @param {object|null} latestInvite  そのゲストの最新の gw_guest_invites（無ければ null）
 */
export function guestStatus(guest, latestInvite) {
  if (guest.disabled_at) return "revoked";
  if (guest.user_id) return "active";
  if (!latestInvite) return "invited"; // 招待の行を作る前の一瞬。通常は起きない
  if (latestInvite.revoked_at) return "revoked";
  if (new Date(latestInvite.expires_at).getTime() < Date.now()) return "expired";
  return "invited";
}

const str = (s, max) => { const t = String(s ?? "").trim(); return t ? t.slice(0, max) : null; };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 新規ゲストの入力チェック */
export function normalizeGuest(body) {
  const name = str(body?.displayName, 100);
  if (!name) return { error: "invalid_body", detail: "氏名は必須です" };
  const email = str(body?.email, 200);
  if (!email || !EMAIL_RE.test(email)) return { error: "invalid_body", detail: "メールアドレスの形が正しくありません" };
  return {
    value: {
      display_name: name,
      company_name: str(body?.companyName, 200),
      email: email.toLowerCase(),
    },
  };
}

/** 許可（gw_guest_grants）1件の入力チェック */
export function normalizeGrant(body) {
  if (!RESOURCE_TYPES.includes(body?.resourceType)) {
    return { error: "invalid_body", detail: `resourceType は ${RESOURCE_TYPES.join("/")} のいずれかです` };
  }
  const key = str(body?.resourceKey, 200);
  if (!key) return { error: "invalid_body", detail: "resourceKey は必須です" };
  return {
    value: {
      resource_type: body.resourceType,
      resource_key: key,
      resource_label: str(body?.resourceLabel, 200),
    },
  };
}
