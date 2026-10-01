// 営業アタック管理（/sales）。値の定義・正規化・状態の判定。
// db/088_sales.sql（＋ 096_sales_channels.sql：非表示・チャネル・送信できなかった・連絡先）と1対1。api/sales/*.js から使う。
//
// ■ いちばん大事なこと（要件 §26）
//   「何社送ったか」ではなく「どの企業が反応したか」を次の営業行動につなげる。
//   だから一覧の並びも NEXT も、反応（クリック・返信）を先に出す。

import crypto from "node:crypto";
import { isBizDay, dateStr } from "./holidays.js";
import { INDUSTRIES, SERVICES, PREFECTURES, isIndustry, isService, isPrefecture, parsePrefecture, prefectureOf } from "./sales-master.js";

// 業種・提案サービス・都道府県は lib/sales-master.js（共通マスター）で定義する
export { INDUSTRIES, SERVICES, PREFECTURES, prefectureOf, parsePrefecture };

export const STATUSES = [
  { key: "untouched", label: "未アタック" },
  { key: "attacked", label: "アタック済" },
  { key: "clicked", label: "クリックあり" },
  { key: "replied", label: "返信あり" },
  { key: "meeting", label: "商談" },
  { key: "proposal", label: "提案" },
  { key: "won", label: "成約" },
  // 別系統
  { key: "reattack_wait", label: "再アタック待ち" },
  { key: "lost", label: "失注" },
  { key: "excluded", label: "対象外" },
];
export const STATUS_KEYS = STATUSES.map((s) => s.key);
export const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.key, s.label]));

// ステータスの前後関係。自動で進めるとき（送信完了・クリック）は、後ろへは戻さない
const RANK = { untouched: 0, reattack_wait: 0, attacked: 1, clicked: 2, replied: 3, meeting: 4, proposal: 5, won: 6 };
export const statusRank = (s) => RANK[s] ?? -1;

// もう営業行動の要らない状態。NEXT・期限の判定から除く
export const CLOSED_STATUSES = ["won", "lost", "excluded"];

export const NG_REASONS = [
  { key: "no_sales", label: "営業禁止" },
  { key: "unsubscribed", label: "配信停止希望" },
  { key: "no_form_sales", label: "問い合わせフォーム営業禁止" },
  { key: "partner", label: "取引先" },
  { key: "customer", label: "既存顧客" },
  { key: "competitor", label: "競合" },
  { key: "other", label: "その他" },
];
export const NG_KEYS = NG_REASONS.map((r) => r.key);
export const NG_LABEL = Object.fromEntries(NG_REASONS.map((r) => [r.key, r.label]));

// 営業履歴に手で足せる出来事
export const EVENT_KINDS = [
  { key: "follow", label: "フォロー" },
  { key: "call", label: "電話" },
  { key: "mail", label: "メール" },
  { key: "reply", label: "返信あり" },
  { key: "meeting", label: "商談" },
  { key: "memo", label: "メモ" },
];
export const EVENT_LABEL = Object.fromEntries(EVENT_KINDS.map((k) => [k.key, k.label]));
// その出来事で、ステータスをどこまで進めるか（後ろへは戻さない）
export const EVENT_ADVANCES = { reply: "replied", meeting: "meeting" };

// ---- チャネル（db/096） -------------------------------------------------------
//
// 送ったチャネル・返信が来たチャネル・いまやり取りしているチャネルは、どれも選択値で持つ
// （自由記述にしない。あとでチャネル別に送信数・返信率・面談化率を数えるため）。
export const CHANNEL_LABEL = {
  form: "お問い合わせフォーム", email: "メール", line: "LINE", instagram: "Instagram", x: "X",
  facebook: "Facebook", linkedin: "LinkedIn", sns_other: "その他SNS", phone: "電話", other: "その他",
};
const channels = (keys) => keys.map((key) => ({ key, label: CHANNEL_LABEL[key] }));
// 送信チャネル（送信完了のとき必ず選ぶ）
export const SEND_CHANNELS = channels(["form", "email", "line", "instagram", "x", "facebook", "linkedin", "sns_other", "other"]);
// 返信元（どこから返事が来たか）。フォームは「お問い合わせフォーム経由」
export const REPLY_CHANNELS = channels(["form", "email", "line", "instagram", "x", "facebook", "linkedin", "phone", "other"])
  .map((c) => (c.key === "form" ? { ...c, label: "お問い合わせフォーム経由" } : c));
// いまの連絡手段・連絡先の種類
export const CONTACT_CHANNELS = channels(["email", "line", "instagram", "x", "facebook", "linkedin", "phone", "other"]);
export const SEND_CHANNEL_KEYS = SEND_CHANNELS.map((c) => c.key);
export const REPLY_CHANNEL_KEYS = REPLY_CHANNELS.map((c) => c.key);
export const CONTACT_CHANNEL_KEYS = CONTACT_CHANNELS.map((c) => c.key);
export const channelLabel = (k) => (k ? CHANNEL_LABEL[k] || k : null);

// 非表示の理由（削除とは別。データは残し、一覧・アタック対象から外すだけ）
export const HIDE_REASONS = [
  { key: "link_broken", label: "リンク切れ" },
  { key: "no_info", label: "会社情報なし" },
  { key: "closed", label: "閉業" },
  { key: "not_target", label: "営業対象外" },
  { key: "duplicate", label: "重複" },
  { key: "other", label: "その他" },
];
export const HIDE_KEYS = HIDE_REASONS.map((r) => r.key);
export const HIDE_LABEL = Object.fromEntries(HIDE_REASONS.map((r) => [r.key, r.label]));

// 送信できなかった理由（必須。「その他」はメモ必須）
export const SEND_FAIL_REASONS = [
  { key: "no_form", label: "問い合わせフォームがない" },
  { key: "no_email", label: "メールアドレスがない" },
  { key: "form_error", label: "フォームエラー" },
  { key: "ng_notice", label: "営業禁止の記載あり" },
  { key: "link_broken", label: "URLリンク切れ" },
  { key: "login_required", label: "ログイン・会員登録が必要" },
  { key: "captcha", label: "CAPTCHA等で送信できない" },
  { key: "sns_only", label: "SNSしか連絡手段がない" },
  { key: "other", label: "その他" },
];
export const SEND_FAIL_KEYS = SEND_FAIL_REASONS.map((r) => r.key);
export const SEND_FAIL_LABEL = Object.fromEntries(SEND_FAIL_REASONS.map((r) => [r.key, r.label]));
// 送れなかったときの NEXT。「未対応」には戻さず、別チャネルで再アタックするかを決める
export const NEXT_AFTER_FAIL = "別チャネルで再アタックを検討";

/** 連絡先（{ email, line, instagram, … }）を、決めた種類・長さだけに整える。空欄の項目は null で返す（消す） */
export function normalizeContacts(v) {
  if (v === undefined) return { value: undefined };
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "bad_contacts" };
  const out = {};
  for (const k of CONTACT_CHANNEL_KEYS) {
    if (!(k in v)) continue;
    const s = v[k] === null ? "" : String(v[k]).trim().slice(0, 200);
    out[k] = s || null;
  }
  if (out.email && !/^[^\s@]+@[^\s@]+$/.test(out.email)) {
    return { error: "bad_email", hint: "メールアドレスの形が正しくありません" };
  }
  return { value: out };
}

/** 既存の連絡先に、変わった項目だけを重ねる（null は消す） */
export function mergeContacts(before, patch) {
  const out = { ...(before && typeof before === "object" ? before : {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v) out[k] = v; else delete out[k];
  }
  return out;
}


// 直近アタックの警告を出す日数（要件 §20）
export const RECENT_DAYS = 30;

// ---- 小さな道具 -------------------------------------------------------------

const str = (v, max = 2000) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v) => {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return DATE_RE.test(String(v)) ? String(v) : false;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => UUID_RE.test(String(v || ""));

/** http(s) のURLだけを通す。javascript: などを画面・リダイレクトに流さない */
export function safeUrl(v) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  let s = String(v).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.toString().slice(0, 2000);
  } catch { return false; }
}

/** 会社の同一判定に使うホスト名。www. は外す */
export function domainOf(url) {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return h || null;
  } catch { return null; }
}

/** 今日（日本時間）の YYYY-MM-DD */
export function todayJst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

// ---- 企業の正規化 -----------------------------------------------------------

export const COMPANY_FIELDS = "id, tenant_id, name, domain, site_url, form_url, industry, region, address, size, phone, "
  + "service, campaign_id, owner_id, status, next_action, next_action_on, followed_at, ng_reason, ng_note, "
  + "note, created_at, updated_at, "
  // db/096：非表示・いまの連絡手段・連絡先
  + "hidden_at, hidden_reason, hidden_note, current_contact_channel, current_contact_value, contacts, last_contact_at";

const COMPANY_TEXT = {
  name: ["name", 200], industry: ["industry", 100], region: ["region", 100], address: ["address", 300],
  size: ["size", 100], phone: ["phone", 50], service: ["service", 100],
  nextAction: ["next_action", 200], ngNote: ["ng_note", 500], note: ["note", 5000],
};

/**
 * 画面から来た値を、DBの列へ。渡された項目だけを返す（PATCHで他を消さない）
 * 業種・提案サービスは共通マスターの値だけ。地域は都道府県にする（「鹿児島県鹿屋市」→ 鹿児島県。
 * 所在地が空なら、元の文字列を所在地に入れる）。
 * @param {object} body
 * @param {{partial?: boolean, before?: object}} opts partial=false なら必須項目を確かめる。
 *   before … 編集前の会社。マスターに無い昔の値でも、変えていなければそのまま通す（他の項目の保存を止めない）
 */
export function normalizeCompany(body = {}, { partial = false, before = null } = {}) {
  const v = {};
  for (const [k, [col, max]] of Object.entries(COMPANY_TEXT)) {
    const s = str(body[k], max);
    if (s !== undefined) v[col] = s;
  }
  const kept = (col) => before && v[col] === before[col];
  if (v.industry && !isIndustry(v.industry) && !kept("industry")) {
    return { error: "bad_industry", hint: `業種は「${INDUSTRIES.join("・")}」から選んでください` };
  }
  if (v.service && !isService(v.service) && !kept("service")) {
    return { error: "bad_service", hint: `提案サービスは「${SERVICES.join("・")}」から選んでください` };
  }
  if (v.region && !isPrefecture(v.region) && !kept("region")) {
    const p = parsePrefecture(v.region);
    if (!p) return { error: "bad_region", hint: "地域は都道府県を選んでください" };
    // 「鹿児島県鹿屋市」のように市区町村まで来たら、所在地が空のときだけ元の文字列を所在地へ
    if (p.rest && !v.address && !before?.address) v.address = v.region;
    v.region = p.prefecture;
  }
  if (!partial && !v.name) return { error: "name_required", hint: "企業名を入力してください" };
  if (partial && "name" in v && !v.name) return { error: "name_required", hint: "企業名は空にできません" };

  for (const [k, col] of [["siteUrl", "site_url"], ["formUrl", "form_url"]]) {
    const u = safeUrl(body[k]);
    if (u === false) return { error: "bad_url", hint: `${k === "siteUrl" ? "企業サイト" : "フォーム"}のURLが正しくありません` };
    if (u !== undefined) v[col] = u;
  }
  if ("site_url" in v) v.domain = domainOf(v.site_url);

  const d = date(body.nextActionOn);
  if (d === false) return { error: "bad_date", hint: "NEXTの日付が正しくありません" };
  if (d !== undefined) v.next_action_on = d;

  if (body.status !== undefined) {
    if (!STATUS_KEYS.includes(body.status)) return { error: "bad_status" };
    v.status = body.status;
  }
  if (body.ngReason !== undefined) {
    if (body.ngReason !== null && body.ngReason !== "" && !NG_KEYS.includes(body.ngReason)) return { error: "bad_ng_reason" };
    v.ng_reason = body.ngReason || null;
  }
  for (const [k, col] of [["ownerId", "owner_id"], ["campaignId", "campaign_id"]]) {
    if (body[k] === undefined) continue;
    if (body[k] && !isUuid(body[k])) return { error: `bad_${col}` };
    v[col] = body[k] || null;
  }
  return { value: v };
}

export function shapeCompany(c) {
  return {
    id: c.id,
    name: c.name,
    domain: c.domain || null,
    siteUrl: c.site_url || null,
    formUrl: c.form_url || null,
    industry: c.industry || null,
    region: c.region || null,
    address: c.address || null,
    size: c.size || null,
    phone: c.phone || null,
    service: c.service || null,
    campaignId: c.campaign_id || null,
    ownerId: c.owner_id || null,
    status: c.status || "untouched",
    statusLabel: STATUS_LABEL[c.status || "untouched"] || c.status,
    nextAction: c.next_action || null,
    nextActionOn: c.next_action_on || null,
    followedAt: c.followed_at || null,
    ngReason: c.ng_reason || null,
    ngLabel: c.ng_reason ? NG_LABEL[c.ng_reason] || c.ng_reason : null,
    ngNote: c.ng_note || null,
    note: c.note || null,
    createdAt: c.created_at || null,
    updatedAt: c.updated_at || null,
    hidden: Boolean(c.hidden_at),
    hiddenAt: c.hidden_at || null,
    hiddenReason: c.hidden_reason || null,
    hiddenLabel: c.hidden_reason ? HIDE_LABEL[c.hidden_reason] || c.hidden_reason : null,
    hiddenNote: c.hidden_note || null,
    contactChannel: c.current_contact_channel || null,
    contactChannelLabel: channelLabel(c.current_contact_channel),
    contactValue: c.current_contact_value || null,
    contacts: c.contacts && typeof c.contacts === "object" ? c.contacts : {},
    lastContactAt: c.last_contact_at || null,
  };
}

// ---- アタック ---------------------------------------------------------------

export function shapeApproach(a) {
  return {
    id: a.id,
    companyId: a.company_id,
    campaignId: a.campaign_id || null,
    templateId: a.template_id || null,
    employeeId: a.employee_id || null,
    service: a.service || null,
    subject: a.subject || null,
    body: a.body || null,
    formUrl: a.form_url || null,
    trackingToken: a.tracking_token,
    destinationUrl: a.destination_url || null,
    preparedAt: a.prepared_at || null,
    sentAt: a.sent_at || null,
    forced: Boolean(a.forced),
    firstClickAt: a.first_click_at || null,
    lastClickAt: a.last_click_at || null,
    clickCount: a.click_count || 0,
    channel: a.channel || "form",
    channelLabel: channelLabel(a.channel || "form"),
    sendFrom: a.send_from || null,
    failedAt: a.failed_at || null,
    failedReason: a.send_failed_reason || null,
    failedLabel: a.send_failed_reason ? SEND_FAIL_LABEL[a.send_failed_reason] || a.send_failed_reason : null,
    failedNote: a.send_failed_note || null,
  };
}

// 専用URLのトークン。人が目で写すこともあるので、紛らわしい字（0/O・1/I/l）を外す。
// 10字で 31^10 ≒ 8×10^14 通り。総当たりで他社のURLを当てられる数ではない
const TOKEN_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const TOKEN_LEN = 10;
export function newTrackingToken() {
  const bytes = crypto.randomBytes(TOKEN_LEN);
  let s = "";
  for (const b of bytes) s += TOKEN_CHARS[b % TOKEN_CHARS.length];
  return s;
}
export const TRACKING_RE = /^[2-9A-HJ-NP-Z]{10}$/;

/**
 * 直近のアタック（送信済みのもの）を1件返す。無ければ null
 * @param {object[]} approaches 同じ会社のアタック
 * @param {string} [channel] 指定すると、そのチャネルで送ったものだけを見る。
 *   同じ会社に別のチャネル（フォーム → Instagram など）で送るのは止めない（要件：複数チャネル対応）
 */
export function recentApproach(approaches, now = new Date(), days = RECENT_DAYS, channel = undefined) {
  const since = now.getTime() - days * 86400000;
  return (approaches || [])
    .filter((a) => a.sent_at && new Date(a.sent_at).getTime() >= since)
    .filter((a) => !channel || (a.channel || "form") === channel)
    .sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))[0] || null;
}

/** 「3日前」「2時間前」（画面の SalesLayout.ago と同じ書き方） */
export function agoText(iso, now = new Date()) {
  if (!iso) return "";
  const ms = now.getTime() - new Date(iso).getTime();
  if (ms < 60000) return "たった今";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}分前`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}時間前`;
  return `${Math.floor(ms / 86400000)}日前`;
}

// ---- 営業文 ----------------------------------------------------------------

/**
 * テンプレートの差し込み。{{company}} {{sender}} {{url}} {{service}} だけを置き換える。
 * 知らない {{…}} はそのまま残す（消すと、書いた人が気づけない）
 */
export function renderTemplate(body, vars = {}) {
  return String(body || "").replace(/\{\{\s*(company|sender|url|service)\s*\}\}/g,
    (_, k) => (vars[k] ?? ""));
}

// ---- クリック ---------------------------------------------------------------
//
// ■ 記録（ログ）と「有効クリック」を分ける
//   専用URLへのアクセスは、機械のものも含めて全部 gw_sales_click_events に残す。
//   そのうえで、人のクリックと判断したものだけ is_valid=true にして数える
//   （回数・通知・ステータス・NEXT に効くのは有効クリックだけ）。
//   除外しすぎていたと分かっても、ログから数え直せる。

// リンクのプレビューを作りにくる機械（Slack・Teams・LINE・メールのセキュリティ製品など）。
// 人のブラウザの UA に入らない語だけを並べる（入る語を足すと、人のクリックが消える）
const BOT_RE = new RegExp([
  "bot\\b", "bot/", "crawl", "spider", "slurp", "facebookexternalhit", "embedly", "quora link",
  "outbrain", "pinterest", "vkshare", "w3c_validator", "whatsapp", "skypeuripreview", "linkpreview",
  "microsoft office", "ms-office", "proofpoint", "mimecast", "barracuda", "symantec", "trendmicro",
  "fireeye", "forcepoint", "ironport", "headlesschrome", "phantomjs", "python-requests", "python-urllib",
  "aiohttp", "curl/", "wget", "go-http-client", "okhttp", "java/", "apache-httpclient", "node-fetch",
  "axios/", "libwww", "scrapy",
].join("|"), "i");
// 「〜bot」で終わるが人の端末のもの（スマホのメーカー名など）。先に外してから見る
const HUMAN_RE = /\bcubot\b/gi;
export const isBot = (ua) => !ua || BOT_RE.test(String(ua).replace(HUMAN_RE, ""));

// 同じアタックへの、この秒数以内の2回目以降は、同じ人の連打・二重読み込みとして数えない
export const DEDUPE_SECONDS = 30;

/**
 * 1回のアクセスが、有効クリックかどうか。
 * @param {{method:string, ua:string, headers:object, duplicate:boolean}} x
 * @returns {{valid:boolean, reason:string|null}}
 *   reason … head（HEADリクエスト）/ prefetch（ブラウザ・メールの先読み）/
 *            no_ua（UAなし）/ bot（機械のUA）/ duplicate（短時間の連続）
 */
export function classifyClick({ method, ua, headers = {}, duplicate = false }) {
  if (String(method).toUpperCase() === "HEAD") return { valid: false, reason: "head" };
  const purpose = String(headers["sec-purpose"] || headers.purpose || headers["x-purpose"] || headers["x-moz"] || "");
  if (/prefetch|preview|prerender/i.test(purpose)) return { valid: false, reason: "prefetch" };
  if (!ua) return { valid: false, reason: "no_ua" };
  if (isBot(ua)) return { valid: false, reason: "bot" };
  if (duplicate) return { valid: false, reason: "duplicate" };
  return { valid: true, reason: null };
}

/**
 * IPは持たない。日ごとの塩を混ぜたハッシュだけ（同じ日の連打を見分けるだけ）
 */
export function ipHash(ip, now = new Date()) {
  if (!ip) return null;
  const salt = `${process.env.SALES_IP_SALT || process.env.SUPABASE_URL || "sales"}:${todayJst(now)}`;
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

// ---- 営業日 ------------------------------------------------------------------

/** YYYY-MM-DD の n 営業日後（土日・祝日を飛ばす。lib/holidays.js と同じ表） */
export function addBizDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBizDay(d)) left--;
  }
  return dateStr(d);
}

/** 今日が営業日ならその日、そうでなければ次の営業日 */
export function bizDayOnOrAfter(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  while (!isBizDay(d)) d.setUTCDate(d.getUTCDate() + 1);
  return dateStr(d);
}

// ---- NEXT の自動更新 ---------------------------------------------------------
//
// 相手の反応で NEXT を変える。一律「7日後」にはしない。
//
//   送信直後     … 「反応確認」         3営業日後
//   クリック     … 「クリックあり・要フォロー」 当日（営業日の17時まで）／それ以降・休日は翌営業日
//   返信あり     … 「返信対応」         当日（休日なら翌営業日）
//   商談化       … 「商談準備」         当日（休日なら翌営業日）
//   フォロー等   … 「反応確認」         3営業日後（NEXTを手で決めなかったとき）
//
// 自動で決めた NEXT は、人が決めた NEXT より後ろの段階へは上書きしない
// （例：商談中の会社がクリックしても「商談準備」は残す）。判断は呼ぶ側で statusRank を見る。
export const NEXT_LABEL = {
  sent: "反応確認", click: "クリックあり・要フォロー", reply: "返信対応", meeting: "商談準備", follow: "反応確認",
};
const CLICK_CUTOFF_HOUR = 17;

export function autoNext(kind, now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600000);
  const today = jst.toISOString().slice(0, 10);
  let due;
  if (kind === "sent" || kind === "follow") due = addBizDays(today, 3);
  else if (kind === "click") {
    const d = new Date(`${today}T00:00:00Z`);
    due = isBizDay(d) && jst.getUTCHours() < CLICK_CUTOFF_HOUR ? today : addBizDays(today, 1);
  } else due = bizDayOnOrAfter(today);
  return { next_action: NEXT_LABEL[kind], next_action_on: due };
}

// ---- NEXT（次にやること）-----------------------------------------------------

/**
 * 一覧・ダッシュボード用の「次にやること」を1つ決める。
 *   ・未対応のクリックがあれば、それが最優先（反応した企業から追う）
 *   ・NEXT（自動で決めたもの・人が決めたもの）があればそれ
 *   ・無ければ状態から決める
 * @returns {{key:string, label:string, due:string|null, overdue:boolean}}
 */
export function nextFor(c, last, today = todayJst()) {
  if (c.ng_reason) return { key: "ng", label: "営業禁止", due: null, overdue: false };
  if (CLOSED_STATUSES.includes(c.status)) return { key: "none", label: "—", due: null, overdue: false };

  if (hasUnhandledClick(c, last)) {
    // 期限はクリックの時点で決めたもの（当日〜翌営業日）。人が別の NEXT を入れていても、
    // 対応するまではクリックのフォローを先に出す
    const due = c.next_action === NEXT_LABEL.click && c.next_action_on ? c.next_action_on : today;
    return { key: "follow_click", label: NEXT_LABEL.click, due, overdue: due < today };
  }
  if (c.next_action || c.next_action_on) {
    const due = c.next_action_on || null;
    return {
      key: "manual",
      label: c.next_action || "NEXTを決める",
      due,
      overdue: Boolean(due && due < today),
    };
  }
  if (c.status === "untouched" || c.status === "reattack_wait") {
    return { key: "attack", label: "フォームアタック", due: null, overdue: false };
  }
  return { key: "decide", label: "NEXTを決める", due: null, overdue: false };
}

/** 対応していないクリックがあるか（followed_at より後のクリック） */
export function hasUnhandledClick(c, last) {
  if (!last?.last_click_at) return false;
  if (CLOSED_STATUSES.includes(c.status)) return false;
  return !c.followed_at || c.followed_at < last.last_click_at;
}

/**
 * 会社ごとに、アタックの数字をまとめる。一覧・ダッシュボード・反応一覧の元。
 * 送信完了を押していないアタックは数えない。ただしクリックされたものは数える
 * （押し忘れでも、実際に届いて開かれている＝反応を落とさないため）
 * @returns {Map<string, {attackCount:number, lastSentAt:string|null, lastEmployeeId:string|null,
 *   lastService:string|null, lastApproachId:string|null, lastChannel:string|null, clickCount:number,
 *   first_click_at:string|null, last_click_at:string|null}>}
 */
export function aggregateApproaches(approaches) {
  const out = new Map();
  for (const a of approaches || []) {
    if (!a.sent_at && !(a.click_count > 0)) continue;
    let g = out.get(a.company_id);
    if (!g) {
      g = { attackCount: 0, lastSentAt: null, lastEmployeeId: null, lastService: null, lastApproachId: null,
        lastChannel: null, clickCount: 0, first_click_at: null, last_click_at: null };
      out.set(a.company_id, g);
    }
    const at = a.sent_at || a.prepared_at;
    if (a.sent_at) g.attackCount++;
    if (at && (!g.lastSentAt || at > g.lastSentAt)) {
      g.lastSentAt = at; g.lastEmployeeId = a.employee_id || null;
      g.lastService = a.service || null; g.lastApproachId = a.id; g.lastChannel = a.channel || "form";
    }
    g.clickCount += a.click_count || 0;
    if (a.first_click_at && (!g.first_click_at || a.first_click_at < g.first_click_at)) g.first_click_at = a.first_click_at;
    if (a.last_click_at && (!g.last_click_at || a.last_click_at > g.last_click_at)) g.last_click_at = a.last_click_at;
  }
  return out;
}

// ---- 企業一覧：サーバー側の絞り込み・並べ替え・ページング（db/097） -----------------------
//
// 「100件表示」ではなく「100件だけ取得」する。DB で絞る → DB で並べる → DB で100件に切る。
// 並べ替えに使う最終アタック・クリック数は、gw_sales_companies の写し（last_sent_at・click_count。
// アタックの表が変わるとトリガーで取り直す）を使う。

export const LIST_LIMIT = 100;
export const EXPORT_MAX = 10000;

// 一覧に要る列だけ（長いメモ・連絡先・住所などは詳細を開いたときに取る）
export const LIST_FIELDS = "id, name, domain, site_url, industry, region, service, status, owner_id, "
  + "next_action, next_action_on, followed_at, ng_reason, hidden_at, hidden_reason, current_contact_channel, "
  + "last_sent_at, click_count, created_at";

// 並べ替えの見出し → 列。最後に必ず id を足して、同じ値のときもページ間で順番が揺れないようにする
//   owner … 担当者の表示名（view gw_sales_company_list の owner_name。db/098）
//   next  … 画面に出している実効 NEXT の急ぐ順（同 view の next_group → next_due。db/098）
//           未対応クリック（クリックあり・要フォロー）が先頭。lib/sales.js nextFor と同じ判定
export const LIST_SORTS = {
  name: ["name"], industry: ["industry"], region: ["region"], service: ["service"], status: ["status_rank"],
  last_sent: ["last_sent_at"], channel: ["current_contact_channel"], clicks: ["click_count"],
  next: ["next_group", "next_due"], owner: ["owner_name"], created: ["created_at"],
};
// この並べ替えだけは、担当者名・実効 NEXT を足した view から取る（それ以外は表のまま。098 が無くても動く）
const VIEW_SORTS = new Set(["owner", "next"]);
export const listSource = (f) => (VIEW_SORTS.has(f.sort) ? "gw_sales_company_list" : "gw_sales_companies");
const VISIBILITY = ["shown", "hidden", "all"];

/**
 * 一覧・CSV の条件を URL から読む。知らない値は 400 にする（黙って無視すると、画面の条件と結果がずれる）
 * @returns {{error?:string, hint?:string, page:number, limit:number, sort:string|null, order:"asc"|"desc",
 *   visibility:string, q:string, status:string, owner:string, service:string, industry:string, region:string,
 *   channel:string, attacked:string, clicked:string}}
 */
export function parseListQuery(sp) {
  const get = (k) => String(sp.get(k) || "").trim().slice(0, 200);
  const page = Math.max(1, Math.floor(Number(sp.get("page")) || 1));
  const limit = Math.min(LIST_LIMIT, Math.max(1, Math.floor(Number(sp.get("limit")) || LIST_LIMIT)));
  const sort = get("sort") || null;
  if (sort && !LIST_SORTS[sort]) return { error: "bad_sort", hint: "並べ替えの項目が正しくありません" };
  const order = get("order") === "desc" ? "desc" : "asc";
  const visibility = get("visibility") || "shown";
  if (!VISIBILITY.includes(visibility)) return { error: "bad_visibility" };
  const status = get("status");
  if (status && status !== "ng" && !STATUS_KEYS.includes(status)) return { error: "bad_status" };
  const owner = get("owner");
  if (owner && owner !== "me" && owner !== "none" && !isUuid(owner)) return { error: "bad_owner" };
  const region = get("region");
  if (region && !isPrefecture(region)) return { error: "bad_region", hint: "地域は都道府県で指定してください" };
  const channel = get("channel");
  if (channel && channel !== "none" && !CONTACT_CHANNEL_KEYS.includes(channel)) return { error: "bad_channel" };
  const yn = (k) => (["yes", "no"].includes(get(k)) ? get(k) : "");
  // 検索語。PostgREST の or() の区切り（, ( ) " ）と、like の記号（% _ \ *）は外す
  const q = get("q").replace(/[,()"'\\%_*]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return {
    page, limit, sort, order, visibility, q, status, owner, channel,
    service: get("service"), industry: get("industry"), region,
    attacked: yn("attacked"), clicked: yn("clicked"),
  };
}

/** 絞り込みを Supabase のクエリに足す（tenant は呼ぶ側で必ず先に入れる） */
export function applyListFilters(query, f, ctx) {
  let q = query;
  if (f.visibility === "shown") q = q.is("hidden_at", null);
  if (f.visibility === "hidden") q = q.not("hidden_at", "is", null);
  if (f.q) q = q.or(`name.ilike.%${f.q}%,domain.ilike.%${f.q}%,site_url.ilike.%${f.q}%`);
  if (f.status === "ng") q = q.not("ng_reason", "is", null);
  else if (f.status) q = q.eq("status", f.status);
  // 社員として登録の無い人の「自分」は、どの会社にも当たらない（null の担当＝未定と混ぜない）
  if (f.owner === "me") q = q.eq("owner_id", ctx.employee?.id || "00000000-0000-0000-0000-000000000000");
  else if (f.owner === "none") q = q.is("owner_id", null);
  else if (f.owner) q = q.eq("owner_id", f.owner);
  if (f.service) q = q.eq("service", f.service);
  if (f.industry) q = q.eq("industry", f.industry);
  // 地域は都道府県。昔の「鹿児島県鹿屋市」も鹿児島県に入れる（DB の gw_sales_prefecture() と同じ：先頭一致）
  if (f.region) q = q.like("region", `${f.region}%`);
  if (f.channel === "none") q = q.is("current_contact_channel", null);
  else if (f.channel) q = q.eq("current_contact_channel", f.channel);
  if (f.attacked === "yes") q = q.not("last_sent_at", "is", null);
  if (f.attacked === "no") q = q.is("last_sent_at", null);
  if (f.clicked === "yes") q = q.gt("click_count", 0);
  if (f.clicked === "no") q = q.eq("click_count", 0);
  return q;
}

/** 並べ替え。未指定は登録の新しい順。空の値は昇順・降順どちらでも最後に出す。最後に id で順番を固定 */
export function applyListSort(query, f) {
  const cols = f.sort ? LIST_SORTS[f.sort] : ["created_at"];
  const ascending = f.sort ? f.order === "asc" : false;
  let q = query;
  for (const col of cols) q = q.order(col, { ascending, nullsFirst: false });
  return q.order("id", { ascending: true });
}

// ---- CSV ---------------------------------------------------------------------

/** CSV の1セル。= + - @ で始まる値は Excel が式として実行するので、' を付けて文字にする */
export function csvCell(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 日本時間の「2026-09-29 14:05」 */
export function jstDateTime(iso) {
  if (!iso) return "";
  const d = new Date(new Date(iso).getTime() + 9 * 3600000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
}

export const CSV_COLUMNS = [
  ["企業名", (c) => c.name], ["URL", (c) => c.site_url], ["ドメイン", (c) => c.domain],
  ["業種", (c) => c.industry], ["地域", (c) => prefectureOf(c.region) || c.region], ["商材", (c) => c.service],
  ["ステータス", (c) => (c.ng_reason ? `${STATUS_LABEL[c.status] || c.status}（営業禁止：${NG_LABEL[c.ng_reason] || c.ng_reason}）` : STATUS_LABEL[c.status] || c.status)],
  ["担当", (c, x) => x.ownerName], ["最終アタック日時", (c) => jstDateTime(c.last_sent_at)],
  ["最終アタック実行者", (c, x) => x.lastAttackerName], ["送信チャネル", (c, x) => x.lastChannelLabel],
  ["現在の連絡手段", (c) => channelLabel(c.current_contact_channel)], ["クリック数", (c) => c.click_count ?? 0],
  ["NEXT", (c, x) => x.next], ["NEXT期限", (c, x) => x.nextDue],
  ["非表示状態", (c) => (c.hidden_at ? "非表示" : "表示中")],
  ["非表示理由", (c) => (c.hidden_reason ? HIDE_LABEL[c.hidden_reason] || c.hidden_reason : "")],
  ["登録日時", (c) => jstDateTime(c.created_at)],
];

/** UTF-8 BOM つき・CRLF の CSV 本文（日本の Excel で文字化けしない） */
export function companiesCsv(rows) {
  const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(",")];
  for (const { c, x } of rows) lines.push(CSV_COLUMNS.map(([, f]) => csvCell(f(c, x))).join(","));
  return `\ufeff${lines.join("\r\n")}\r\n`;
}
