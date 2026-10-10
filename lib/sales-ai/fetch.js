// AI営業：企業の公開サイトを読む（トップ＋会社概要・事業内容・問い合わせの最大3ページ＝最大4ページ）。
//
// ■ 守ること（docs/ai-sales-agent-phase0.md §5.7）
//   ・robots.txt を先に読み、止められているパスは読まない（トップが止められていたら、その会社は読まない）
//   ・同じサイト（同じホスト・そのサブドメイン）の中だけ。外部のフォームサービスは読まない（担当者が確認する）
//   ・社内・ループバック等のアドレスへは行かない（lib/sales-lookup.js fetchSite の SSRF 対策をそのまま使う）
//   ・ログイン・CAPTCHA・アクセス制限は越えない。見つけたら「ある」と記録するだけ
//   ・読んだ URL は出典として残す（pages）

import { fetchSite, normalizeSiteUrl, decodeEntities } from "../sales-lookup.js";
import { LIMITS } from "./config.js";

const BOT_TOKENS = ["eightgw-saleslookup", "eightgw"];

/** robots.txt を読む。無い（404 等）・読めないときは「止められていない」 */
export function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === "disallow" || key === "allow") cur.rules.push({ allow: key === "allow", path: val });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => BOT_TOKENS.some((t) => a && t.includes(a) && a !== "*")));
  const rules = (mine.length ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  return { rules };
}

const ruleRe = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
/** そのパスを読んでよいか（一番長く一致した規則に従う。同じ長さなら Allow） */
export function robotsAllows(robots, pathWithQuery) {
  let best = null;
  for (const r of robots?.rules || []) {
    if (!r.path) continue;                 // 「Disallow:」（空）は全部許可
    let re;
    try { re = ruleRe(r.path); } catch { continue; }
    if (!re.test(pathWithQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

async function loadRobots(origin, deps) {
  try {
    const { html } = await fetchSite(`${origin}/robots.txt`, { ...deps, allowText: true });
    // HTML が返ってきた（robots.txt が無くてトップに飛ばされた等）ときは、規則なし
    if (/<html|<body/i.test(html.slice(0, 500))) return { rules: [] };
    return parseRobots(html);
  } catch {
    return { rules: [] };
  }
}

/** HTML から本文の文字を取り出す（script・style・svg は捨てる。見出し・段落は改行にする） */
export function htmlText(html, max = LIMITS.pageChars) {
  const s = String(html || "")
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/dt|\/dd|\/section|\/article)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(s).replace(/[ \t 　]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim().slice(0, max);
}

const titleOf = (html) => htmlText((String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "", 200);

const KINDS = [
  { kind: "about", re: /会社概要|企業情報|会社案内|会社情報|企業概要|私たちについて|about|company|corporate|profile|gaiyou|outline/i },
  { kind: "business", re: /事業内容|事業紹介|サービス|製品|商品|取扱|業務内容|service|business|product|solution|works/i },
  { kind: "contact", re: /お問い?合わ?せ|問い?合わ?せ|ご相談|資料請求|contact|inquiry|enquiry|toiawase|otoiawase/i },
];

const sameSite = (u, base) => {
  const h = u.hostname.replace(/^www\./, ""), b = base.hostname.replace(/^www\./, "");
  return h === b || h.endsWith(`.${b}`);
};

/** トップページのリンクから、会社概要・事業内容・問い合わせを1つずつ選ぶ（同じサイトの中だけ） */
export function pickPages(html, baseUrl, formUrl = null) {
  const base = new URL(baseUrl);
  const found = {};
  const take = (kind, url, score) => {
    if (!found[kind] || score > found[kind].score) found[kind] = { url, score };
  };
  for (const m of String(html || "").matchAll(/<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/gi)) {
    const href = (m[1].match(/href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i) || []).slice(1).find(Boolean);
    if (!href || /^(mailto|tel|javascript):/i.test(href) || href.startsWith("#")) continue;
    let u;
    try { u = new URL(decodeEntities(href), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !sameSite(u, base)) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?|pptx?)$/i.test(u.pathname)) continue;
    u.hash = "";
    if (u.toString() === base.toString()) continue;
    const text = htmlText(m[2], 100);
    for (const k of KINDS) {
      const textHit = k.re.test(text), hrefHit = k.re.test(u.pathname);
      if (textHit || hrefHit) { take(k.kind, u.toString(), (textHit ? 2 : 0) + (hrefHit ? 1 : 0)); break; }
    }
  }
  // 企業マスタに登録済みの問い合わせフォーム URL が同じサイトなら、それを使う
  if (formUrl) {
    try {
      const f = new URL(formUrl);
      if (sameSite(f, base)) found.contact = { url: f.toString(), score: 9 };
    } catch { /* 読めない URL は使わない */ }
  }
  return Object.entries(found).map(([kind, v]) => ({ kind, url: v.url }));
}

/** 問い合わせページのフォームの様子（送れるかの判断材料。中身は送らない） */
export function formInfo(html) {
  const s = String(html || "");
  return {
    hasForm: /<form\b/i.test(s),
    captcha: /g-recaptcha|recaptcha\/api|h-captcha|hcaptcha\.com|cf-turnstile|challenges\.cloudflare\.com/i.test(s),
    login: /type\s*=\s*["']?password/i.test(s),
  };
}

/**
 * 1社ぶんを読む
 * @returns {Promise<{status:'ok'|'site_unreachable'|'robots_blocked', reason?:string, pages:Array, form:object}>}
 */
export async function collectSite({ siteUrl, formUrl = null }, deps = {}) {
  const url = normalizeSiteUrl(siteUrl);
  if (!url) return { status: "site_unreachable", reason: "bad_url", pages: [], form: null };
  const origin = new URL(url).origin;
  const robots = await loadRobots(origin, deps);
  const pathOf = (u) => { const x = new URL(u); return x.pathname + x.search; };
  if (!robotsAllows(robots, pathOf(url))) return { status: "robots_blocked", reason: "robots", pages: [], form: null };

  let top;
  try { top = await fetchSite(url, deps); } catch (e) {
    return { status: "site_unreachable", reason: e.code || "fetch_failed", pages: [], form: null };
  }
  // 別のホストへ転送されたら、転送先の robots.txt でも確かめる（転送先のサイトの決まりに従う）
  let rules = robots;
  if (new URL(top.finalUrl).origin !== origin) {
    rules = await loadRobots(new URL(top.finalUrl).origin, deps);
    if (!robotsAllows(rules, pathOf(top.finalUrl))) return { status: "robots_blocked", reason: "robots", pages: [], form: null };
  }
  const pages = [{ kind: "top", url: top.finalUrl, title: titleOf(top.html), text: htmlText(top.html) }];
  const skipped = [];
  const picks = pickPages(top.html, top.finalUrl, formUrl).filter((p) => {
    if (robotsAllows(rules, pathOf(p.url))) return true;
    skipped.push({ kind: p.kind, url: p.url, reason: "robots" });
    return false;
  }).slice(0, 3);
  const got = await Promise.allSettled(picks.map((p) => fetchSite(p.url, deps)));
  let form = null;
  got.forEach((g, i) => {
    const p = picks[i];
    if (g.status !== "fulfilled") { skipped.push({ kind: p.kind, url: p.url, reason: g.reason?.code || "fetch_failed" }); return; }
    // 転送で別のサイトへ出たページは読まない（問い合わせなら「外部のフォーム」として担当者が確かめる）
    if (!sameSite(new URL(g.value.finalUrl), new URL(top.finalUrl))) {
      skipped.push({ kind: p.kind, url: p.url, reason: "other_site" });
      if (p.kind === "contact") form = { url: g.value.finalUrl, external: true, hasForm: null, captcha: null, login: null };
      return;
    }
    pages.push({ kind: p.kind, url: g.value.finalUrl, title: titleOf(g.value.html), text: htmlText(g.value.html) });
    if (p.kind === "contact") form = { url: g.value.finalUrl, ...formInfo(g.value.html) };
  });
  // 外のフォームサービス（同じサイトではない）は読まない。担当者が開いて確かめる
  if (!form && formUrl) {
    try {
      if (!sameSite(new URL(formUrl), new URL(top.finalUrl))) form = { url: formUrl, external: true, hasForm: null, captcha: null, login: null };
    } catch { /* 読めない URL */ }
  }
  // AI に渡す文字数の合計を抑える（トップを優先して、残りを順に詰める）
  let room = LIMITS.totalChars;
  for (const p of pages) { p.text = p.text.slice(0, Math.max(room, 0)); room -= p.text.length; }
  return { status: "ok", pages, form, skipped };
}
