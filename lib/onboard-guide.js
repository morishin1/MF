// 入社案内（経営者が作り、本人が確認する）の、純粋な部品。表も画面も知らない（test/onboardguide.mjs）。
//
// ■ 何を持つのか
//
//   案内は、初日に「いつ・どこへ・何を持って・誰に連絡するか」を伝える文書。
//   氏名・入社日・所属・役割は、名簿と入社手続きから写す（確定済みの値。AI は作らない）。
//   集合時間・場所・予定・持ち物・連絡先・担当者・メッセージは、経営者が書く。
//
// ■ 金額は載せない
//
//   給与・手当・交通費などの金額は、案内にも案内メールにも書かない。
//   労働条件は、本人が労働条件通知書（契約）で確認する（そこが唯一の正）。
//   書いてしまわないよう、金額らしき表記は保存の時点で断る（findMoneyMention）。
//
// ■ 発行した版は、あとから変わらない
//
//   発行のたびに、その時点の確定版（snapshot）を残す。下書きを直しても、本人が見ているものは変わらず、
//   もう一度発行して初めて、版が上がる（本人は確認し直す）。

/** 経営者が書く項目。key は gw_onboarding_guides の列 */
export const GUIDE_FIELDS = [
  { key: "meeting_time", label: "初日の集合時間", max: 60,   multiline: false, placeholder: "9:45" },
  { key: "start_time",   label: "勤務開始",       max: 60,   multiline: false, placeholder: "10:00" },
  { key: "location",     label: "勤務場所",       max: 200,  multiline: false, placeholder: "株式会社エイト 原宿オフィス" },
  { key: "schedule",     label: "初日の予定",     max: 2000, multiline: true,  placeholder: "会社説明・PC受取・アカウント設定・業務説明" },
  { key: "belongings",   label: "持ち物",         max: 1000, multiline: true,  placeholder: "印鑑・筆記用具" },
  { key: "contact",      label: "当日の連絡先",   max: 300,  multiline: false, placeholder: "03-0000-0000（人事 担当者）" },
  { key: "staff",        label: "担当者",         max: 200,  multiline: false, placeholder: "人事 山田" },
  { key: "message",      label: "会社からのメッセージ", max: 2000, multiline: true, placeholder: "" },
];
export const GUIDE_KEYS = GUIDE_FIELDS.map((f) => f.key);

/** 本人に見せるキー（名簿から写す4つ＋経営者が書く8つ）。これ以外は、本人に返さない */
export const GUIDE_VIEW_KEYS = ["name", "joinOn", "department", "position", "role", ...GUIDE_KEYS];

// 制御文字（改行とタブは、複数行の項目だけ許す）を除く
const clean = (v, max, multiline) => {
  let s = String(v ?? "").replace(/\r\n?/g, "\n");
  s = s.replace(multiline ? /[\u0000-\u0008\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, "");
  s = multiline ? s.split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n") : s;
  return s.trim().slice(0, max);
};

/**
 * 金額らしい表記を見つける（「30万円」「¥300,000」「月給30万」）。あれば、その部分の抜粋。
 * 「10時」「3日」のような数字は通す。円・¥・給与を表す語＋万 だけを見る。
 */
export function findMoneyMention(text) {
  const s = String(text ?? "");
  const m = s.match(/[0-9０-９][0-9０-９,，.]*\s*(?:万円|千円|円)|[¥￥]\s*[0-9０-９]|(?:給与|基本給|月給|年俸|時給|日給|手当|賞与|ボーナス)[^\n]{0,8}[0-9０-９][0-9０-９,，.]*\s*万/);
  return m ? m[0].slice(0, 30) : null;
}

/**
 * 画面から来た下書きを、保存できる形にそろえる。知らないキーは捨てる。
 * @returns {{ value?: object, error?: string, field?: string, hint?: string }}
 */
export function normalizeGuideInput(body) {
  const src = body && typeof body === "object" ? body : {};
  const value = {};
  for (const f of GUIDE_FIELDS) {
    if (!(f.key in src)) continue;
    const v = src[f.key];
    if (v !== null && v !== undefined && typeof v !== "string") {
      return { error: "invalid_body", field: f.key, hint: `${f.label}は文字で入力してください` };
    }
    const s = clean(v, f.max, f.multiline);
    const money = findMoneyMention(s);
    if (money) {
      return { error: "money_in_guide", field: f.key,
        hint: `${f.label}に金額（${money}）は書けません。給与・手当・費用の金額は、労働条件通知書で本人にお伝えします` };
    }
    value[f.key] = s || null;
  }
  return { value };
}

/**
 * 発行する確定版。名簿・手続きから写した値と、下書きの値をまとめる。金額は入れない。
 * @param {{employee:object, procedure?:object|null, draft:object}} p
 */
export function buildSnapshot({ employee, procedure, draft }) {
  const e = employee || {};
  const snap = {
    name: e.display_name || null,
    joinOn: procedure?.target_on || e.joined_on || null,
    department: e.department || null,
    position: e.position || null,
    role: e.initial_role || null,
  };
  for (const k of GUIDE_KEYS) snap[k] = (draft && draft[k]) || null;
  return snap;
}

/** 本人・案内URLの画面に返す形（許した項目だけ） */
export function guideView(snapshot) {
  const out = {};
  for (const k of GUIDE_VIEW_KEYS) out[k] = snapshot?.[k] ?? null;
  return out;
}

/** 発行前に足りないもの（必須にはしない。経営者に知らせるだけ） */
export function missingFields(draft, snapshot) {
  const need = [["meeting_time", "初日の集合時間"], ["location", "勤務場所"], ["contact", "当日の連絡先"]];
  const out = need.filter(([k]) => !draft?.[k]).map(([, l]) => l);
  if (!snapshot?.joinOn) out.push("入社日（入社手続きの入社予定日）");
  return out;
}

/** lib/onboard-six.js に渡す事実 */
export function guideFact(row) {
  if (!row) return null;
  return {
    status: (row.version || 0) > 0 ? "issued" : "draft",
    version: row.version || 0,
    confirmedVersion: row.confirmed_version ?? null,
    confirmedAt: row.confirmed_at || null,
  };
}

// ---- 案内URL --------------------------------------------------------------

export const INVITE_TTL_DAYS_DEFAULT = 7;
export const INVITE_TTL_DAYS_MAX = 30;

export function inviteExpiry(days, now = Date.now()) {
  const n = Number(days);
  const d = Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), INVITE_TTL_DAYS_MAX) : INVITE_TTL_DAYS_DEFAULT;
  return new Date(now + d * 86400000).toISOString();
}

/** 案内URLの基準。PUBLIC_BASE_URL があればそれ。無ければ、いま開いているホスト */
export function publicBaseUrl(req, env = process.env) {
  const explicit = String(env.PUBLIC_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = String(req?.headers?.["x-forwarded-host"] || req?.headers?.host || "").split(",")[0].trim();
  if (host && /^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) {
    const proto = /^(localhost|127\.)/.test(host) ? "http" : "https";
    return `${proto}://${host}`;
  }
  const vercel = String(env.VERCEL_URL || "").trim();
  return vercel ? `https://${vercel}` : "https://mf.8grp.co.jp";
}

export const inviteUrl = (base, token) => `${String(base).replace(/\/+$/, "")}/onboarding/?t=${encodeURIComponent(token)}`;

// ---- メール文面 -----------------------------------------------------------

const jpDate = (d) => {
  const m = String(d || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[2])}月${Number(m[3])}日` : null;
};
const jpDateTime = (iso) => {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  const j = new Date(t + 9 * 3600000);
  return `${j.getUTCFullYear()}年${j.getUTCMonth() + 1}月${j.getUTCDate()}日 ${String(j.getUTCHours()).padStart(2, "0")}:${String(j.getUTCMinutes()).padStart(2, "0")}`;
};

/**
 * 案内メールの文面（自動作成）。確定済みの値だけを使い、日付・期限・条件を作らない。
 * 長くしすぎず、「入社準備ページを開いてください」を中心にする。パスワードは書かない。
 *
 * @param {{companyName?:string, name:string, joinOn?:string|null, url:string, expiresAt:string, senderName?:string|null}} p
 * @returns {{subject:string, text:string}}
 */
export function renderInviteMail({ companyName, name, joinOn, url, expiresAt, senderName }) {
  const company = companyName || "株式会社エイト";
  const join = jpDate(joinOn);
  const until = jpDateTime(expiresAt);
  const lines = [
    `${name} 様`,
    "",
    join ? `${join}のご入社に向けて、` : "ご入社に向けて、",
    "入社準備のページをご用意しました。",
    "",
    "以下から、入社案内の確認、労働条件・契約の確認、入社情報の入力、",
    "必要書類の提出をお願いします。",
    "",
    "▼ 入社準備を始める",
    url,
    "",
    "・完了状況は保存されますので、一度にすべて行う必要はありません。",
    until ? `・このURLは ${until} まで有効です。期限が切れたら、担当者にご連絡ください。` : "・このURLには有効期限があります。期限が切れたら、担当者にご連絡ください。",
    "・ログイン情報（ID・パスワード）は、このメールには書いていません。担当者から、別の方法でお伝えします。",
    "・このメールに心当たりがない場合は、お手数ですが破棄してください。",
    "",
    company,
    ...(senderName ? [senderName] : []),
  ];
  return { subject: `【${company}】ご入社にあたってのご案内`, text: lines.join("\n") };
}
