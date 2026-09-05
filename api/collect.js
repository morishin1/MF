// POST /api/collect  { k, p, r }   … 自前の計測タグからの1回ぶんの記録
//   k … サイトごとの合鍵（gw_web_projects.beacon_key）
//   p … パス（"/service" など）
//   r … 参照元（document.referrer）
//
// ここだけはログイン不要で受ける。各サイトのブラウザから直接呼ぶため。
//
// 開けっぱなしの書き込み口になるので、絞りをいくつも入れている:
//   ・合鍵が一致するサイトしか受けない
//   ・そのサイトに登録されたドメインからの呼び出しだけ受ける（Origin を見る）
//   ・日別の集計行に足すだけ。個票は残さない（IPも保存しない）
//   ・1回の呼び出しで増えるのは 1。まとめて水増しはできない
//
// 訪問者数は「その日そのサイトで初めて来た人」を、ブラウザ側の印で数えている。
// 端末をまたぐと別人として数えるが、社内で伸びを見るには足りる。

import { json, readJson, methodNotAllowed } from "../lib/http.js";
import { admin } from "../lib/supabase.js";

const MAX_PATH = 300;

export default async function handler(req, res) {
  // 計測タグは別ドメインから呼ぶので CORS を通す
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  if (req.method !== "POST") return methodNotAllowed(res, ["POST", "OPTIONS"]);

  const body = await readJson(req);
  const key = String(body?.k || "").trim();
  if (!key) return ok(res);   // 中身がおかしくても 204。相手はブラウザなので黙って捨てる

  const sb = admin();
  const { data: project } = await sb
    .from("gw_web_projects")
    .select("id, domain, enabled")
    .eq("beacon_key", key)
    .maybeSingle();
  if (!project || !project.enabled) return ok(res);

  // 登録されたドメイン以外からの呼び出しは数えない。
  // 合鍵はページのソースに書いてあるので、これが無いと誰でも水増しできる
  if (!originAllowed(req, project.domain)) return ok(res);

  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const isNew = body?.n === 1;   // その日はじめての訪問かどうか（タグ側の判定）

  const path = normalizePath(body?.p);
  const referrer = normalizeReferrer(body?.r, project.domain);

  // 3つの集計を1回ずつ足す。RPC を使わずに済ませるため、
  // 「読んで足して書く」を短い間隔でやる。取りこぼしても数字の性質上問題にならない
  await Promise.all([
    bump(sb, "gw_web_daily", { project_id: project.id, date: today, source: "beacon" },
      { pageviews: 1, visitors: isNew ? 1 : 0 }),
    bump(sb, "gw_web_pages", { project_id: project.id, date: today, source: "beacon", path },
      { pageviews: 1 }),
    bump(sb, "gw_web_referrers", { project_id: project.id, date: today, source: "beacon", referrer },
      { pageviews: 1 }),
  ]).catch((e) => console.error("[collect] failed:", e?.message || e));

  return ok(res);
}

function ok(res) { res.statusCode = 204; res.end(); }

function originAllowed(req, domain) {
  if (!domain) return true;   // ドメイン未登録のうちは受ける（登録すれば絞られる）
  const origin = req.headers["origin"] || "";
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname.replace(/^www\./, "");
    const want = String(domain).replace(/^www\./, "").toLowerCase();
    return host === want || host.endsWith(`.${want}`);
  } catch { return false; }
}

function normalizePath(raw) {
  let p = String(raw || "/").split("?")[0].split("#")[0];
  if (!p.startsWith("/")) p = `/${p}`;
  return p.slice(0, MAX_PATH);
}

// 参照元は「どこから来たか」が分かれば足りる。ホスト名までにして、
// 検索語やパラメータの付いたURLをそのまま貯めない
function normalizeReferrer(raw, ownDomain) {
  const s = String(raw || "").trim();
  if (!s) return "direct";
  let host;
  try { host = new URL(s).hostname.replace(/^www\./, "").toLowerCase(); } catch { return "direct"; }
  if (ownDomain && host === String(ownDomain).replace(/^www\./, "").toLowerCase()) return "internal";
  if (/(^|\.)google\./.test(host)) return "google";
  if (/(^|\.)(yahoo\.co\.jp|search\.yahoo)/.test(host)) return "yahoo";
  if (/(^|\.)bing\./.test(host)) return "bing";
  if (host === "t.co" || host === "x.com" || host === "twitter.com") return "x";
  return host.slice(0, 200);
}

async function bump(sb, table, keys, add) {
  const { data } = await sb.from(table).select("*").match(keys).maybeSingle();
  const next = { ...keys };
  for (const [k, v] of Object.entries(add)) next[k] = (data?.[k] || 0) + v;
  if (table === "gw_web_daily") next.updated_at = new Date().toISOString();
  await sb.from(table).upsert(next);
}
