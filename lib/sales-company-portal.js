// Sales の企業詳細「企業ポータル」「商談準備」の決まりごと（入力・状態・招待リンク）。
// DB は db/161_enger_company_portal.sql。画面は js/sales-company-portal-tabs.js。
// 企業ポータル本体は enger.jp/business（enger-lp）。招待リンクは enger-lp の /business/invite が受ける。

import crypto from "node:crypto";

export const PORTAL_TABLES = {
  members: "dx2_company_portal_members",
  invites: "dx2_company_portal_invites",
  links: "dx2_company_talent_links",
  saved: "dx2_company_portal_saved_talents",
  events: "dx2_company_portal_events",
};

// System-owned login alias for companies that have not supplied a contact email.
// This address is never a notification recipient; the customer logs in with their
// numeric company ID. Never accept this reserved namespace as user input.
const COMPANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_LOGIN_DOMAIN = "accounts.enger.jp";
export function companyIdOnlyEmail(companyId) {
  const id = String(companyId || "").trim().toLowerCase();
  return COMPANY_UUID.test(id) ? `company-${id}@${ID_LOGIN_DOMAIN}` : null;
}
export function isCompanyIdOnlyEmail(email) {
  const address = String(email || "").trim().toLowerCase();
  const prefix = "company-", suffix = "@" + ID_LOGIN_DOMAIN;
  return address.startsWith(prefix) && address.endsWith(suffix) &&
    COMPANY_UUID.test(address.slice(prefix.length, -suffix.length));
}
export function isReservedCompanyLoginEmail(email) {
  return String(email || "").trim().toLowerCase().endsWith("@" + ID_LOGIN_DOMAIN);
}

export const ROLES = { admin: "管理者", member: "一般" };
export const INVITE_TTL_DAYS = 1;
export const MEMBER_STATUS_LABEL = {
  active: "有効", invited: "招待中（初回ログイン待ち）", expired: "招待期限切れ", disabled: "停止中", not_invited: "招待リンク未発行",
};
export const LINK_STATUSES = { saved: "保存候補", planned: "提案予定", proposed: "提案済み", declined: "見送り" };

// 招待リンクの受け口（企業ポータル）。本番は enger.jp。プレビューで確かめるときだけ環境変数で替える
export function portalBaseUrl(env = process.env) {
  const raw = String(env.ENGER_PORTAL_BASE_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(raw) ? raw : "https://enger.jp";
}
export const inviteUrl = (token, env = process.env) => `${portalBaseUrl(env)}/business/invite?token=${encodeURIComponent(token)}`;
export const loginUrl = (env = process.env) => `${portalBaseUrl(env)}/business/login`;
export const resetUrl = (env = process.env) => `${portalBaseUrl(env)}/business/forgot`;

export const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
export const newInviteToken = () => crypto.randomBytes(32).toString("base64url");
/** Exactly 8 CSPRNG characters; initial/reset password is returned only once.
 * Guarantee upper/lower/digit/symbol so Supabase Auth complexity rules can accept it.
 * A cryptographic shuffle avoids predictable character positions.
 */
export function newTemporaryPassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@";
  const alphabet = upper + lower + digits + symbols;
  const chars = [upper[crypto.randomInt(upper.length)],lower[crypto.randomInt(lower.length)],
    digits[crypto.randomInt(digits.length)],symbols[crypto.randomInt(symbols.length)]];
  while (chars.length < 8) chars.push(alphabet[crypto.randomInt(alphabet.length)]);
  for (let i=chars.length-1;i>0;i--) {
    const j=crypto.randomInt(i+1);
    [chars[i],chars[j]]=[chars[j],chars[i]];
  }
  return chars.join("");
}

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const str = (v, max) => String(v ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);

/** 発行の入力。直せる誤りは { error, hint } */
export function inviteInput(body) {
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: "invalid_email", hint: "メールアドレスの形式が正しくありません。" };
  const displayName = str(body?.displayName, 100);
  if (!displayName) return { error: "invalid_name", hint: "企業担当者の氏名を入力してください。" };
  const role = Object.hasOwn(ROLES, body?.role) ? body.role : "member";
  return { value: { email, displayName, role, sendMail: body?.sendMail === true } };
}

/**
 * 利用者1人のいまの状態。招待は再発行のたびに新しい行ができるので、最新の1件だけを見る。
 */
export function memberStatus(member, latestInvite, now = Date.now()) {
  if (member?.disabled_at) return "disabled";
  if (member?.auth_user_id) return "active";
  if (!latestInvite || latestInvite.revoked_at || latestInvite.used_at) return "not_invited";
  if (Date.parse(latestInvite.expires_at) < now) return "expired";
  return "invited";
}

/** 画面に返す利用者の形。トークンのハッシュ・Auth の ID は返さない */
export function memberView(member, latestInvite, now = Date.now()) {
  const status = memberStatus(member, latestInvite, now);
  return {
    id: member.id,
    email: member.email,
    displayName: member.display_name,
    role: member.role,
    roleLabel: ROLES[member.role] || member.role,
    status,
    statusLabel: MEMBER_STATUS_LABEL[status],
    invitedAt: latestInvite?.created_at || null,
    inviteExpiresAt: status === "invited" || status === "expired" ? latestInvite?.expires_at || null : null,
    registeredAt: member.registered_at || null,
    lastLoginAt: member.last_login_at || null,
    disabledAt: member.disabled_at || null,
    disabledReason: member.disabled_reason || null,
    createdAt: member.created_at,
  };
}

/** 招待メールの本文（パスワード不要。送信先のメールに一回限りのリンクを送る） */
export function inviteMail({ companyName, displayName, url, expiresAt, senderName }) {
  const until = new Date(expiresAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return {
    subject: "【ENGER business】企業アカウントのご案内",
    text: [
      `${companyName} ${displayName} 様`,
      "",
      "株式会社エイトの ENGER です。貴社専用の企業アカウント（ENGER business）をご用意しました。",
      "下の専用リンクを開き、「企業ポータルを開く」を押してください。新規登録やパスワードの設定は不要です。",
      "",
      url,
      "",
      `リンクの有効期限：${until}（1回だけ使えます）`,
      "ENGERでは、IT人材・案件の検索、候補へのオファー、自社案件・所属人材の登録ができます。","貴社の人材確保や案件開拓にご活用ください。",
      "",
      "※ このメールに心当たりがない場合は、リンクを開かずに破棄してください。","今後のご案内が不要な場合は、このメールへの返信でお知らせください。","株式会社エイト／ENGER運営事務局",
      senderName ? `担当：${senderName}` : "",
    ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n"),
  };
}

/** 商談準備：保存の入力（人材は最大50人まで一度に） */
export function linkInput(body) {
  const ids = Array.isArray(body?.talentIds) ? [...new Set(body.talentIds.map(String))] : [];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!ids.length || ids.length > 50 || ids.some((id) => !UUID.test(id))) return { error: "invalid_talents", hint: "人材を1〜50人選んでください。" };
  const status = Object.hasOwn(LINK_STATUSES, body?.status) ? body.status : "saved";
  return { value: { ids, status } };
}

export function linkPatchInput(body) {
  const patch = {};
  if (body?.status !== undefined) {
    if (!Object.hasOwn(LINK_STATUSES, body.status)) return { error: "invalid_status", hint: "状態を選び直してください。" };
    patch.status = body.status;
  }
  if (body?.note !== undefined) {
    const note = String(body.note ?? "").slice(0, 1000);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(note)) return { error: "invalid_note", hint: "メモに使えない文字が含まれています。" };
    patch.note = note;
  }
  if (!Object.keys(patch).length) return { error: "empty_patch", hint: "変更する内容がありません。" };
  return { value: patch };
}

// 記録の表示名（画面の「利用履歴」）
export const EVENT_LABEL = {
  "member.invite": "アカウント発行（招待リンク）",
  "member.reinvite": "招待リンクの再発行",
  "member.temp_password": "一時パスワードを管理者が発行",
  "member.disable": "アカウント停止",
  "member.enable": "アカウント再開",
  "member.role": "権限の変更",
  "member.register": "初回設定（パスワード登録）",
  "member.link": "既存アカウントと紐づけ",
  "portal.login": "ログイン",
  "portal.blocked": "停止中のためログインを拒否",
  "talent.search": "人材検索",
  "talent.view": "人材詳細の閲覧",
  "talent.save": "人材を保存",
  "talent.unsave": "保存を解除",
  "prep.link": "商談準備：人材を紐づけ",
  "prep.update": "商談準備：状態・メモを変更",
};

const MISSING = new Set(["PGRST205", "42P01", "PGRST106"]);
export const isMissingTable = (error) => Boolean(error && (MISSING.has(error.code) || /does not exist|schema cache/i.test(error.message || "")));
export const NOT_READY = { error: "not_ready", hint: "企業ポータルの DB（db/161_enger_company_portal.sql）が未適用です。管理者に実行を依頼してください。" };
