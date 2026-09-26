// 企業サイトの URL から、企業名・問い合わせフォーム URL などを拾う（/sales のクイック登録）。
//
// ■ 取れなくても止めない（要件 §4）
//   ここで返すのは「候補」だけ。取れなかった項目は null のまま返し、
//   登録そのものは画面側で進められるようにする。
//
// ■ 外のサイトを取りにいくので、社内・内部のアドレスには行かない（SSRF 対策）
//   ・http / https、ポートは 80 / 443 だけ
//   ・名前解決した結果が、社内・ループバック・リンクローカル等なら行かない
//   ・リダイレクトは自分でたどり、1回ごとに同じ確認をする（最大3回）
//   ・6秒で打ち切る。読むのは先頭 800KB まで
//   ・API は /sales を使える人（canSell）だけが呼べる（誰でも使える中継にしない）
//
// ■ 読むのはトップページ1枚だけ
//   フォームを探しに中のページまで回ると、遅くなるうえに相手のサイトに負担をかける。

import dnsPromises from "node:dns/promises";
import net from "node:net";

const TIMEOUT_MS = 6000;
const MAX_BYTES = 800 * 1024;
const MAX_HOPS = 3;
const UA = "Mozilla/5.0 (compatible; EightGW-SalesLookup/1.0; +https://gw.8grp.co.jp/sales)";

// ---- 行ってはいけないアドレス ----------------------------------------------------

function v4ToInt(ip) {
  return ip.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}
const V4_BLOCK = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => [v4ToInt(base), bits]);

/** 社内・ループバック・リンクローカル・予約済みのアドレスか */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return V4_BLOCK.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true; // 読めないものは行かない
}

/** URL を、行ってよい形に直す。だめなら null */
export function normalizeSiteUrl(input) {
  let s = String(input || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && !["80", "443"].includes(u.port)) return null;
  if (!u.hostname.includes(".")) return null;
  u.hash = "";
  return u.toString();
}

async function assertPublicHost(hostname, resolve) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw Object.assign(new Error("private_address"), { code: "blocked" });
    return;
  }
  const addrs = await resolve(hostname);
  if (!addrs.length) throw Object.assign(new Error("dns_failed"), { code: "dns" });
  if (addrs.some((a) => isPrivateAddress(a))) throw Object.assign(new Error("private_address"), { code: "blocked" });
}

const defaultResolve = async (host) =>
  (await dnsPromises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

// ---- 取りにいく ----------------------------------------------------------------

async function readLimited(res) {
  const reader = res.body?.getReader?.();
  if (!reader) return new Uint8Array(await res.arrayBuffer()).slice(0, MAX_BYTES);
  const chunks = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  try { await reader.cancel(); } catch { /* 読み終わっている */ }
  const out = new Uint8Array(Math.min(size, MAX_BYTES));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - off);
    out.set(c.subarray(0, take), off);
    off += take;
    if (off >= out.length) break;
  }
  return out;
}

/** 日本のサイトは Shift_JIS・EUC-JP がまだ多い。宣言を見て読み分ける */
export function decodeHtml(bytes, contentType = "") {
  const pick = (s) => (String(s || "").match(/charset\s*=\s*["']?([\w-]+)/i) || [])[1];
  let cs = pick(contentType);
  if (!cs) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    cs = pick(head);
  }
  cs = String(cs || "utf-8").toLowerCase();
  if (["sjis", "x-sjis", "shift-jis", "windows-31j", "cp932", "ms932"].includes(cs)) cs = "shift_jis";
  try { return new TextDecoder(cs).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

/**
 * @param {string} url
 * @param {{resolve?:Function, fetchImpl?:Function}} deps テストで差し替える
 * @returns {Promise<{finalUrl:string, html:string}>}
 */
export async function fetchSite(url, { resolve = defaultResolve, fetchImpl = fetch } = {}) {
  let current = normalizeSiteUrl(url);
  if (!current) throw Object.assign(new Error("bad_url"), { code: "bad_url" });
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const u = new URL(current);
    await assertPublicHost(u.hostname, resolve);
    const res = await fetchImpl(current, {
      redirect: "manual",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", "accept-language": "ja,en;q=0.5" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = normalizeSiteUrl(new URL(res.headers.get("location"), current).toString());
      if (!next) throw Object.assign(new Error("bad_redirect"), { code: "bad_url" });
      current = next;
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`http_${res.status}`), { code: "http", status: res.status });
    const type = res.headers.get("content-type") || "";
    if (type && !/html|xml/i.test(type)) throw Object.assign(new Error("not_html"), { code: "not_html" });
    return { finalUrl: current, html: decodeHtml(await readLimited(res), type) };
  }
  throw Object.assign(new Error("too_many_redirects"), { code: "redirects" });
}

// ---- 読む ------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+|#39);/gi, (m, k) => ENTITIES[k.toLowerCase()] ?? m);
}
const clean = (s) => decodeEntities(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function metaContent(html, key) {
  const re = new RegExp(`<meta\\b[^>]*(?:name|property)\\s*=\\s*["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const v = tag.match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i);
  return v ? clean(v[1] ?? v[2]) || null : null;
}

const CORP_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社会福祉法人|医療法人|学校法人|NPO法人|特定非営利活動法人|税理士法人|弁護士法人|司法書士法人|行政書士法人|社会保険労務士法人|\bInc\.?|\bCo\.,?\s?Ltd\.?|\bLtd\.?|\bLLC\b|\bK\.K\.)/i;
const GENERIC_RE = /^(top|home|トップ|トップページ|ホーム|ホームページ|公式サイト|公式ホームページ|オフィシャルサイト|official site|welcome)$/i;

/** タイトル・og:site_name から企業名らしいものを選ぶ */
export function pickCompanyName({ title, siteName }) {
  const parts = [siteName, ...String(title || "").split(/\s*[|｜\-–—:：／/]\s*|\s{2,}/)]
    .map((s) => clean(s).replace(/^[「『【]|[」』】]$/g, "").trim())
    .filter((s) => s && s.length <= 60 && !GENERIC_RE.test(s));
  const corp = parts.find((s) => CORP_RE.test(s));
  if (corp) {
    // 「AI開発なら株式会社サンプル」のような宣伝文句から、会社名の部分だけを取り出す。
    // 先に「株式会社○○」（前株）を探し、無ければ「○○株式会社」（後株）を探す
    const body = corp.replace(/^.*?(?:のことなら|といえば|なら)/, "");
    const pre = body.match(/(?:株式会社|有限会社|合同会社|一般社団法人|一般財団法人|医療法人|社会福祉法人|学校法人|税理士法人|弁護士法人)\s?[^\s、。｜|（(]{1,30}/);
    if (pre) return pre[0].trim();
    const post = body.match(/[^\s、。｜|]{1,30}\s?(?:株式会社|有限会社|合同会社)/);
    return (post ? post[0] : body).trim();
  }
  return parts[0] || null;
}

const CONTACT_RE = /contact|inquiry|enquiry|toiawase|otoiawase|form|お問い?合わ?せ|問い?合わ?せ|ご相談|資料請求/i;

/** 問い合わせフォームらしいリンクを1つ。同じサイト内のものだけ */
export function pickContactUrl(html, baseUrl) {
  const base = new URL(baseUrl);
  const baseHost = base.hostname.replace(/^www\./, "");
  const hits = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/gi)) {
    const href = (m[1].match(/href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i) || []).slice(1).find(Boolean);
    if (!href || /^(mailto|tel|javascript):/i.test(href) || href.startsWith("#")) continue;
    const text = clean(m[2]);
    const hrefHit = CONTACT_RE.test(href);
    const textHit = CONTACT_RE.test(text);
    if (!hrefHit && !textHit) continue;
    let u;
    try { u = new URL(decodeEntities(href), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const host = u.hostname.replace(/^www\./, "");
    if (host !== baseHost && !host.endsWith(`.${baseHost}`)) continue;
    // 文字で「お問い合わせ」と書いてあるものを優先。「フォーム」だけの href は弱い
    hits.push({ url: u.toString(), score: (textHit ? 2 : 0) + (/contact|inquiry|toiawase/i.test(href) ? 1 : 0) });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits[0]?.url || null;
}

export function pickPhone(html) {
  const tel = html.match(/href\s*=\s*["']tel:([+\d\-() ]{9,20})["']/i)?.[1];
  if (tel) return tel.replace(/\s+/g, "");
  const text = clean(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " "));
  return text.match(/(?:TEL|Tel|tel|電話)[\s:：.]*(0\d{1,4}[-‐－ー]\d{1,4}[-‐－ー]\d{3,4})/)?.[1]?.replace(/[‐－ー]/g, "-") || null;
}

export function pickAddress(html) {
  const text = clean(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " "));
  const m = text.match(/〒\s?\d{3}[-‐－]\d{4}\s*[^\s]{2,}(?:\s[^\s]{1,30}){0,2}/);
  return m ? m[0].replace(/[‐－]/g, "-").slice(0, 80) : null;
}

/**
 * HTML から候補を拾う
 * @returns {{name:string|null, description:string|null, formUrl:string|null, phone:string|null, address:string|null}}
 */
export function parseCompanyPage(html, baseUrl) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
  const siteName = metaContent(html, "og:site_name") || metaContent(html, "application-name");
  return {
    name: pickCompanyName({ title, siteName }),
    description: (metaContent(html, "description") || metaContent(html, "og:description") || "").slice(0, 300) || null,
    formUrl: pickContactUrl(html, baseUrl),
    phone: pickPhone(html),
    address: pickAddress(html),
  };
}

/** まとめて：取りにいって読む。失敗しても投げず、理由つきで空を返す */
export async function lookupCompany(url, deps) {
  const normalized = normalizeSiteUrl(url);
  if (!normalized) return { ok: false, reason: "bad_url", url: null };
  try {
    const { finalUrl, html } = await fetchSite(normalized, deps);
    return { ok: true, url: normalized, finalUrl, ...parseCompanyPage(html, finalUrl) };
  } catch (e) {
    return { ok: false, url: normalized, reason: e.code || "fetch_failed" };
  }
}
