// 営業アタック管理（/sales）。値の定義・正規化・状態の判定。
// db/088_sales.sql と1対1。api/sales/*.js から使う。
//
// ■ いちばん大事なこと（要件 §26）
//   「何社送ったか」ではなく「どの企業が反応したか」を次の営業行動につなげる。
//   だから一覧の並びも NEXT も、反応（クリック・返信）を先に出す。

import crypto from "node:crypto";

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

// 提案サービスの候補（自由記述。画面の候補表示にだけ使う）
export const SERVICES = ["AI / DX", "システム開発", "PCレンタル", "ホームページ改善", "地方創生", "ENGER", "その他"];
export const INDUSTRIES = ["製造", "不動産", "士業", "医療", "小売", "その他"];

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
  + "note, created_at, updated_at";

const COMPANY_TEXT = {
  name: ["name", 200], industry: ["industry", 100], region: ["region", 100], address: ["address", 300],
  size: ["size", 100], phone: ["phone", 50], service: ["service", 100],
  nextAction: ["next_action", 200], ngNote: ["ng_note", 500], note: ["note", 5000],
};

/**
 * 画面から来た値を、DBの列へ。渡された項目だけを返す（PATCHで他を消さない）
 * @param {object} body
 * @param {{partial?: boolean}} opts partial=false なら必須項目を確かめる
 */
export function normalizeCompany(body = {}, { partial = false } = {}) {
  const v = {};
  for (const [k, [col, max]] of Object.entries(COMPANY_TEXT)) {
    const s = str(body[k], max);
    if (s !== undefined) v[col] = s;
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
 */
export function recentApproach(approaches, now = new Date(), days = RECENT_DAYS) {
  const since = now.getTime() - days * 86400000;
  return (approaches || [])
    .filter((a) => a.sent_at && new Date(a.sent_at).getTime() >= since)
    .sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))[0] || null;
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

// リンクのプレビューを作りにくる機械。人のクリックとして数えない
// （Slack・Teams・メールのセキュリティ製品が、送った瞬間に URL を開きにくる）
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|preview|embedly|quora link|outbrain|pinterest|vkshare|w3c_validator|whatsapp|skypeuripreview|microsoft office|proofpoint|mimecast|barracuda|headless|python-requests|curl\/|wget|go-http-client|okhttp|java\//i;
export const isBot = (ua) => !ua || BOT_RE.test(String(ua));

/**
 * IPは持たない。日ごとの塩を混ぜたハッシュだけ（同じ日の連打を見分けるだけ）
 */
export function ipHash(ip, now = new Date()) {
  if (!ip) return null;
  const salt = `${process.env.SALES_IP_SALT || process.env.SUPABASE_URL || "sales"}:${todayJst(now)}`;
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

// ---- NEXT（次にやること）-----------------------------------------------------

/**
 * 一覧・ダッシュボード用の「次にやること」を1つ決める。
 *   ・未対応のクリックがあれば、それが最優先（反応した企業から追う）
 *   ・手で決めた NEXT があればそれ
 *   ・無ければ状態から決める
 * @returns {{key:string, label:string, due:string|null, overdue:boolean}}
 */
export function nextFor(c, last, today = todayJst()) {
  if (c.ng_reason) return { key: "ng", label: "営業禁止", due: null, overdue: false };
  if (CLOSED_STATUSES.includes(c.status)) return { key: "none", label: "—", due: null, overdue: false };

  if (hasUnhandledClick(c, last)) {
    return { key: "follow_click", label: "クリックあり → フォロー", due: today, overdue: false };
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
 *   lastService:string|null, lastApproachId:string|null, clickCount:number,
 *   first_click_at:string|null, last_click_at:string|null}>}
 */
export function aggregateApproaches(approaches) {
  const out = new Map();
  for (const a of approaches || []) {
    if (!a.sent_at && !(a.click_count > 0)) continue;
    let g = out.get(a.company_id);
    if (!g) {
      g = { attackCount: 0, lastSentAt: null, lastEmployeeId: null, lastService: null, lastApproachId: null,
        clickCount: 0, first_click_at: null, last_click_at: null };
      out.set(a.company_id, g);
    }
    const at = a.sent_at || a.prepared_at;
    if (a.sent_at) g.attackCount++;
    if (at && (!g.lastSentAt || at > g.lastSentAt)) {
      g.lastSentAt = at; g.lastEmployeeId = a.employee_id || null;
      g.lastService = a.service || null; g.lastApproachId = a.id;
    }
    g.clickCount += a.click_count || 0;
    if (a.first_click_at && (!g.first_click_at || a.first_click_at < g.first_click_at)) g.first_click_at = a.first_click_at;
    if (a.last_click_at && (!g.last_click_at || a.last_click_at > g.last_click_at)) g.last_click_at = a.last_click_at;
  }
  return out;
}
