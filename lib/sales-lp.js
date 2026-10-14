// MGNDigital の LP（https://8grp.co.jp/lp/）と /sales をつなぐ部品（Phase 1）。
//
//   アタック → 営業リンク /r/<token> → LP（?sr=<token> を付けて飛ばす）→ LP の申込フォーム
//   → 既存の受信箱（contact_public_submit・Slack）に加えて /api/sales/lp-lead へも送る
//   → 同じトークンのアタックの会社を「MGNDigital申込あり」（返信ありと同じ段階）にする
//
// 表は増やさない（DB変更なし）。申込は営業履歴（gw_sales_events）に出来事として残す：
//   lp_apply      … トークンで会社が決まった申込（正式リード）
//   lp_candidate  … トークンが無く、メールのドメインが1社だけ一致した（人が確認するまで状態は動かさない）
//   lp_reject     … 候補を「別の会社」と判断した
// 中身は営業履歴の detail（テキスト）に1行ずつ書く。表示はその行を読み直す（parseLpDetail）。

export const LP_EVENT = { apply: "lp_apply", candidate: "lp_candidate", reject: "lp_reject" };
export const LP_EVENT_KEYS = Object.values(LP_EVENT);
export const LP_LABEL = {
  lp_apply: "MGNDigital申込あり",
  lp_candidate: "MGNDigital申込（既存企業候補・要確認）",
  lp_reject: "MGNDigital申込候補：別の会社と判断",
};
// 申込のあとの NEXT（期限は当日。休日なら次の営業日）
export const LP_NEXT = "商談を予定する";
export const LP_SOURCE = "mgndigital_lp";

// 短時間の連続送信の歯止め（lib/hr-leads.js の PER_LEAD_LIMIT・NEW_LEAD_LIMIT と同じ考え方：
// 表を増やさず、すでにある記録を時間の窓で数える）
//   sender  … 同じ送信元（IPの日替わりハッシュ。IPそのものは持たない）：60秒に3回まで。
//             関数のインスタンスごとのメモリで数える（記録の表を足さないため。完全ではない歯止め）
//   company … 同じ会社への申込の記録：10分に3件まで（超えたぶんは黙って記録しない）
//   global  … 全体の申込の記録：10分に30件まで（荒らされたときの歯止め。超えたら 429）
export const LP_RATE = {
  sender: { windowSec: 60, max: 3 },
  company: { windowMin: 10, max: 3 },
  global: { windowMin: 10, max: 30 },
};

/**
 * 送信元ごとの回数（メモリ）。true なら受けてよい。
 * @param {Map<string, number[]>} store
 */
export function senderAllowed(store, key, now = Date.now(), rule = LP_RATE.sender) {
  if (!key) return true;
  const from = now - rule.windowSec * 1000;
  const hits = (store.get(key) || []).filter((t) => t > from);
  if (hits.length >= rule.max) { store.set(key, hits); return false; }
  hits.push(now);
  store.set(key, hits);
  // 古い送信元を捨てる（メモリを増やし続けない）
  if (store.size > 5000) {
    for (const [k, v] of store) if (!v.some((t) => t > from)) store.delete(k);
  }
  return true;
}

/** LP のホスト（env SALES_LP_HOSTS=カンマ区切り。既定 8grp.co.jp）。申込の口の Origin もこれで絞る */
export function lpHosts(env = process.env) {
  const list = String(env.SALES_LP_HOSTS || "8grp.co.jp").split(",")
    .map((s) => s.trim().toLowerCase().replace(/^www\./, "")).filter(Boolean);
  return list.length ? list : ["8grp.co.jp"];
}
const hostOf = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; }
};
export function isLpHost(url, env = process.env) {
  const h = hostOf(url);
  return Boolean(h) && lpHosts(env).some((d) => h === d || h.endsWith(`.${d}`));
}
/** MGNDigital の LP か（LP のホストで、パスが /lp/ から始まる。env SALES_LP_PATH で変えられる） */
export function isMgnLp(url, env = process.env) {
  if (!isLpHost(url, env)) return false;
  const want = String(env.SALES_LP_PATH || "/lp/");
  try {
    const p = new URL(url).pathname;
    return p === want.replace(/\/$/, "") || p.startsWith(want.endsWith("/") ? want : `${want}/`);
  } catch { return false; }
}

/**
 * MGNDigital の LP へ飛ばすときだけ、sr=<token> を付ける（LP が申込と一緒に送り返す）。
 * それ以外のページ・サイトにはトークンを渡さない（同じホストのほかのページも）。既に sr があれば上書きする。
 */
export function withSalesRef(url, token, env = process.env) {
  if (!url || !token || !isMgnLp(url, env)) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("sr", token);
    return u.toString();
  } catch { return url; }
}

// 会社のドメインと照合しない（だれでも使えるメール）
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.co.jp", "yahoo.com", "ymail.ne.jp", "hotmail.com", "hotmail.co.jp",
  "outlook.com", "outlook.jp", "live.jp", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
  "docomo.ne.jp", "ezweb.ne.jp", "au.com", "softbank.ne.jp", "i.softbank.jp", "nifty.com", "biglobe.ne.jp",
  "ocn.ne.jp", "so-net.ne.jp", "excite.co.jp", "aol.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com",
]);
const EMAIL_RE = /^[^\s@<>()"',;]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i;

/** メールのドメイン（会社の照合用）。フリーメールは null */
export function companyDomainOfEmail(email) {
  const m = EMAIL_RE.exec(String(email || "").trim());
  if (!m) return null;
  const d = m[1].toLowerCase().replace(/^www\./, "");
  return FREEMAIL.has(d) ? null : d;
}

const TOKEN_RE = /^[2-9A-HJ-NP-Z]{10}$/;
const SUBMISSION_RE = /^[A-Za-z0-9-]{8,64}$/;
const clip = (v, n) => {
  const s = String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return s ? s.slice(0, n) : null;
};

/**
 * LP からの申込を確かめる。だれでも呼べる口なので、形が悪いものは全部捨てる。
 * @returns {{error:string}|{value:{token:string|null, submissionId:string, company:string|null, name:string|null,
 *   email:string, phone:string|null, size:string|null, services:string[], campaign:string|null, source:string}}}
 */
export function normalizeLpLead(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_body" };
  const token = body.sr ? String(body.sr).trim().toUpperCase() : null;
  if (token && !TOKEN_RE.test(token)) return { error: "bad_token" };
  const submissionId = String(body.submissionId || "").trim();
  if (!SUBMISSION_RE.test(submissionId)) return { error: "bad_submission" };
  const email = String(body.email || "").trim().slice(0, 200);
  if (!EMAIL_RE.test(email)) return { error: "bad_email" };
  const phone = clip(body.tel ?? body.phone, 30);
  if (phone && !/^[0-9０-９+()（）\-‐－ー\s]{6,30}$/.test(phone)) return { error: "bad_phone" };
  const services = (Array.isArray(body.services) ? body.services : [])
    .map((s) => clip(s, 40)).filter(Boolean).slice(0, 10);
  const utm = body.attribution && typeof body.attribution === "object" ? body.attribution : {};
  return {
    value: {
      token, submissionId, email, phone,
      company: clip(body.company, 120), name: clip(body.name, 60), size: clip(body.size, 40),
      services: [...new Set(services)],
      campaign: clip(body.campaign ?? utm.utm_campaign, 100),
      source: clip(body.source ?? utm.utm_source, 100) || LP_SOURCE,
    },
  };
}

/** 営業履歴の detail に書く文（1行1項目）。申込IDは二重登録を止めるのに使う */
export function lpEventDetail(v, { via } = {}) {
  return [
    v.services.length ? `希望サービス：${v.services.join("、")}` : "希望サービス：未選択（相談したい）",
    v.company ? `会社名（フォーム）：${v.company}` : null,
    v.name ? `お名前：${v.name}` : null,
    `メール：${v.email}`,
    v.phone ? `電話：${v.phone}` : null,
    v.size ? `従業員規模：${v.size}` : null,
    `流入元：${v.source}${v.campaign ? `／${v.campaign}` : ""}`,
    via ? `照合：${via}` : null,
    `申込ID：${v.submissionId}`,
  ].filter(Boolean).join("\n");
}

/** lpEventDetail で書いた文を読み直す（一覧・ドロワーで希望サービスを出す） */
export function parseLpDetail(detail) {
  const out = { services: [], company: null, name: null, email: null, phone: null, source: null, submissionId: null };
  for (const line of String(detail || "").split("\n")) {
    const i = line.indexOf("：");
    if (i < 0) continue;
    const k = line.slice(0, i);
    const v = line.slice(i + 1).trim();
    if (k === "希望サービス") out.services = v.startsWith("未選択") ? [] : v.split("、").filter(Boolean);
    else if (k === "会社名（フォーム）") out.company = v;
    else if (k === "お名前") out.name = v;
    else if (k === "メール") out.email = v;
    else if (k === "電話") out.phone = v;
    else if (k === "流入元") out.source = v;
    else if (k === "申込ID") out.submissionId = v;
  }
  return out;
}

/**
 * 会社ごとに、LP の申込の状態をまとめる（企業一覧・リード一覧用）。
 * @param {{company_id:string, event_key:string, detail:string|null, occurred_at:string}[]} events
 * @returns {Map<string, {appliedAt:string|null, services:string[], candidateAt:string|null, candidate:boolean}>}
 */
export function aggregateLp(events) {
  const map = new Map();
  const sorted = [...(events || [])].sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  for (const e of sorted) {
    if (!LP_EVENT_KEYS.includes(e.event_key)) continue;
    const cur = map.get(e.company_id) || { appliedAt: null, services: [], candidateAt: null, candidate: false };
    if (e.event_key === LP_EVENT.apply) {
      cur.appliedAt = e.occurred_at;
      cur.services = parseLpDetail(e.detail).services;
      cur.candidate = false;
    } else if (e.event_key === LP_EVENT.candidate) {
      cur.candidateAt = e.occurred_at;
      cur.candidate = true;
      if (!cur.services.length) cur.services = parseLpDetail(e.detail).services;
    } else if (e.event_key === LP_EVENT.reject) {
      cur.candidate = false;
      if (!cur.appliedAt) cur.services = [];
    }
    map.set(e.company_id, cur);
  }
  return map;
}
