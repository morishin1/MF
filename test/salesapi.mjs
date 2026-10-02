// 営業アタック管理（api/sales/*）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 企業の追加。同じサイト（ドメイン）の会社は2行にしない（1社追加・取り込みの両方）
//   2. 使えるのは管理者・経営者・マネージャー・営業担当だけ
//   3. フォームアタック：送る前に専用URLを発行し、「送信完了」ではじめて履歴に残る。二重には残らない
//   4. 直近30日以内のアタックはサーバが止める。押し切れるのは管理者・経営者だけ
//   5. 営業禁止の会社には、誰もアタックできない
//   6. 専用URL：人のクリックだけを数え、会社を「クリックあり」に進め、担当へ通知する。
//      機械（リンクのプレビュー）・連打・知らないトークンは数えず、必ず本来のページへ飛ばす
//   7. 未対応クリック → フォローを記録すると外れる。返信ありでステータスが進む
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };
const logged = [];
const notified = [];
const slacked = [];

let seq = 0;
const uuid = () => {
  seq++;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};
const copy = (r) => (r ? { ...r } : null);

// 実行したクエリの記録（一覧が「100社ぶんだけ」取っているかを確かめる）
const qlog = [];

// DB のトリガー（db/097 gw_sales_approaches_rollup）と同じ：アタックが変わったら会社の写しを取り直す
function rollup(companyId) {
  const c = (db.rows.gw_sales_companies || []).find((x) => x.id === companyId);
  if (!c) return;
  const mine = (db.rows.gw_sales_approaches || []).filter((a) => a.company_id === companyId);
  const sent = mine.map((a) => a.sent_at).filter(Boolean).sort();
  c.last_sent_at = sent.length ? sent[sent.length - 1] : null;
  c.click_count = mine.reduce((n, a) => n + (a.click_count || 0), 0);
  // db/098：最後のクリック日時の写しも
  const clicks = mine.map((a) => a.last_click_at).filter(Boolean).sort();
  c.last_click_at = clicks.length ? clicks[clicks.length - 1] : null;
}
// view gw_sales_company_list（db/098）と同じ：担当者名・実効 NEXT の並び順
function listViewRows() {
  const emp = new Map((db.rows.gw_employees || []).map((e) => [e.id, e.display_name]));
  const today = todayJst();
  return (db.rows.gw_sales_companies || []).map((c) => {
    const closed = c.ng_reason || ["won", "lost", "excluded"].includes(c.status);
    const unhandled = c.last_click_at && (!c.followed_at || c.followed_at < c.last_click_at);
    const next_group = closed ? 5 : unhandled ? 0 : c.next_action_on ? 1 : c.next_action ? 2
      : ["untouched", "reattack_wait"].includes(c.status) ? 3 : 4;
    const next_due = closed ? null
      : unhandled ? (c.next_action === "クリックあり・要フォロー" && c.next_action_on ? c.next_action_on : today)
      : c.next_action_on || null;
    return { ...c, owner_name: emp.get(c.owner_id) || null, next_group, next_due };
  });
}
function afterWrite(name, rows) {
  if (name === "gw_sales_approaches") for (const id of new Set(rows.map((r) => r.company_id))) rollup(id);
}
// view gw_sales_company_facets（db/097）と同じ集計
function facetRows() {
  const out = new Map();
  for (const c of db.rows.gw_sales_companies || []) {
    for (const kind of ["industry", "region", "service"]) {
      if (!c[kind]) continue;
      const key = `${c.tenant_id}|${kind}|${c[kind]}`;
      const cur = out.get(key) || { tenant_id: c.tenant_id, kind, value: c[kind], n: 0 };
      cur.n++;
      out.set(key, cur);
    }
  }
  return [...out.values()];
}

// PostgREST の or()/and() の式（or=(…) の中身）を行に当てる。ネスト・not・like/ilike の * % に対応
function splitTop(str) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of str) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const likeRe = (pat, flags) => new RegExp(`^${pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[%*]/g, ".*")}$`, flags);
function logic(r, expr) {
  const m = expr.match(/^(and|or)\((.*)\)$/s);
  if (m) {
    const parts = splitTop(m[2]);
    return m[1] === "and" ? parts.every((p) => logic(r, p)) : parts.some((p) => logic(r, p));
  }
  const c = expr.match(/^([a-z_]+)\.(not\.)?([a-z]+)\.(.*)$/s);
  if (!c) throw new Error(`mock: 読めない条件 ${expr}`);
  const [, col, not, op, val] = c;
  const x = r[col] ?? null;
  let hit;
  if (op === "is") hit = val === "null" ? x === null : String(x) === val;
  else if (x === null) hit = false;
  else if (op === "eq") hit = String(x) === val;
  else if (op === "lt") hit = x < val;
  else if (op === "lte") hit = x <= val;
  else if (op === "gt") hit = x > val;
  else if (op === "gte") hit = x >= val;
  else if (op === "like") hit = likeRe(val, "").test(String(x));
  else if (op === "ilike") hit = likeRe(val, "i").test(String(x));
  else throw new Error(`mock: 知らない演算子 ${op}`);
  return not ? (x === null ? false : !hit) : hit;
}

function matcher(f) {
  return (r) => f.every(([op, k, v]) => {
    if (op === "or") return logic(r, `or(${v})`);
    if (op === "gt") return r[k] !== null && r[k] !== undefined && r[k] > v;
    if (op === "eq") return r[k] === v;
    if (op === "in") return v.includes(r[k]);
    if (op === "is") return (r[k] ?? null) === v;
    if (op === "notnull") return r[k] !== null && r[k] !== undefined;
    if (op === "gte") return r[k] !== null && r[k] !== undefined && r[k] >= v;
    // like 'x%'（先頭一致）だけ
    if (op === "like") return String(r[k] ?? "").startsWith(v.replace(/%$/, "")) && r[k] !== null && r[k] !== undefined;
    return true;
  });
}

function table(name) {
  const f = [];
  const orders = [];
  let range = null;
  let cap = null;
  let withCount = false;
  let head = false;
  const rows = () => {
    const src = name === "gw_sales_company_facets" ? facetRows()
      : name === "gw_sales_company_list" ? listViewRows() : (db.rows[name] || []);
    let out = src.filter(matcher(f));
    if (orders.length) {
      // PostgREST と同じ：空の値は nullsFirst=false なら昇順・降順とも最後
      const cmp = (a, b) => {
        for (const [col, asc, nullsFirst] of orders) {
          const x = a[col] ?? null, y = b[col] ?? null;
          if (x === y) continue;
          if (x === null) return nullsFirst ? -1 : 1;
          if (y === null) return nullsFirst ? 1 : -1;
          return (x < y ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      };
      out = [...out].sort(cmp);
    }
    return out;
  };
  const result = () => {
    qlog.push({ name, f: f.map((x) => [...x]), range });
    const all = rows();
    if (range && all.length && range[0] >= all.length) {
      return { data: null, count: null, error: { code: "PGRST103", message: "Requested range not satisfiable" } };
    }
    // 本物と同じく、limit(n) は先頭 n 件だけ（並べたあとで切る）
    const cut = cap !== null ? all.slice(0, cap) : all;
    const data = range ? cut.slice(range[0], range[1] + 1) : cut;
    return { data: head ? null : data.map(copy), count: withCount ? all.length : null, error: null };
  };
  const q = {
    select(_cols, opts) { withCount = Boolean(opts?.count); head = Boolean(opts?.head); return q; },
    or(expr) { f.push(["or", null, expr]); return q; },
    gt(k, v) { f.push(["gt", k, v]); return q; },
    range(a, b) { range = [a, b]; return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    not(k) { f.push(["notnull", k]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    like(k, v) { f.push(["like", k, v]); return q; },
    order(col, opts) { orders.push([col, opts?.ascending !== false, opts?.nullsFirst ?? (opts?.ascending === false)]); return q; },
    limit(n) { cap = n; return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn) => Promise.resolve(result()).then(fn),
    insert(row) {
      const failed = insertFail?.(name, [].concat(row));
      if (failed) {
        const r3 = { select: () => r3, single: () => Promise.resolve({ data: null, error: failed }),
          then: (fn) => Promise.resolve({ data: null, error: failed }).then(fn) };
        return r3;
      }
      const made = [].concat(row).map((r) => ({
        id: r.id || uuid(), created_at: new Date().toISOString(),
        ...(name === "gw_sales_companies" ? { status: "untouched" } : {}),
        ...(name === "gw_sales_approaches" ? { prepared_at: new Date().toISOString(), sent_at: null, click_count: 0 } : {}),
        ...r,
      }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      afterWrite(name, made);
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn),
      };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        in: (k, v) => { g.push(["in", k, v]); return r2; },
        is: (k, v) => { g.push(["is", k, v]); return r2; },
        select: () => r2,
        single: () => apply(),
        maybeSingle: () => apply(),
        then: (fn) => apply({ asList: true }).then(fn),
      };
      function apply(opts) {
        const hit = (db.rows[name] || []).filter(matcher(g));
        for (const x of hit) Object.assign(x, patch);
        afterWrite(name, hit);
        return Promise.resolve(opts?.asList ? { data: hit.map(copy), error: null } : { data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
    delete() {
      const g = [];
      let want = false;
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        in: (k, v) => { g.push(["in", k, v]); return r2; },
        select: () => { want = true; return r2; },
        then: (fn) => {
          const m = matcher(g);
          const gone = (db.rows[name] || []).filter(m);
          db.rows[name] = (db.rows[name] || []).filter((x) => !m(x));
          afterWrite(name, gone);
          return Promise.resolve({ data: want ? gone.map(copy) : null, error: null }).then(fn);
        },
      };
      return r2;
    },
  };
  return q;
}

// db/101 gw_sales_company_facet_counts と同じ集計（SQL を JS で書き直したもの。lib 側の絞り込みとは別に書く）
const PREFS = ["北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県",
  "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県",
  "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県",
  "高知県", "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県"];
let insertFail = null;          // (表名, 行[]) => error | null。登録の途中失敗を作る
let rpcMissing = false;
let rpcNoNone = false;           // true：101 の版の関数（地域に none を返さない）          // true：101 が未実行（関数が無い）
const rpcCalls = [];
function facetCountsRpc(a) {
  const has = (s) => s !== null && s !== undefined && s !== "";
  const base = (db.rows.gw_sales_companies || []).filter((c) => c.tenant_id === a.p_tenant
    && (a.p_visibility === "all" || (a.p_visibility === "hidden") === Boolean(c.hidden_at))
    && (!has(a.p_q) || ["name", "domain", "site_url"].some((k) => String(c[k] ?? "").toLowerCase().includes(a.p_q.toLowerCase()))))
    .map((c) => ({
      c, pref: PREFS.find((p) => String(c.region ?? "").startsWith(p)) || null,
      m: {
        status: !has(a.p_status) || (a.p_status === "ng" && Boolean(c.ng_reason)) || c.status === a.p_status,
        owner: !has(a.p_owner) || (a.p_owner === "none" && !c.owner_id) || c.owner_id === a.p_owner,
        service: !has(a.p_service) || c.service === a.p_service,
        industry: !has(a.p_industry) || c.industry === a.p_industry,
        region: !has(a.p_region) || (a.p_region === "none" ? !PREFS.some((p) => String(c.region ?? "").startsWith(p))
          : String(c.region ?? "").startsWith(a.p_region)),
        channel: !has(a.p_channel) || (a.p_channel === "none" && !c.current_contact_channel) || c.current_contact_channel === a.p_channel,
        attacked: !has(a.p_attacked) || (a.p_attacked === "yes") === Boolean(c.last_sent_at),
        clicked: !has(a.p_clicked) || (a.p_clicked === "yes") === ((c.click_count || 0) > 0),
      },
    }));
  const but = (x, kind) => Object.entries(x.m).every(([k, v]) => k === kind || v);
  const out = [{ kind: "total", value: null, n: base.filter((x) => but(x, null)).length }];
  const group = (kind, key) => {
    const m = new Map();
    for (const x of base) {
      if (!but(x, kind)) continue;
      const v = key(x);
      if (v === null || v === undefined) continue;
      m.set(v, (m.get(v) || 0) + 1);
    }
    for (const [value, n] of m) out.push({ kind, value, n });
  };
  group("industry", (x) => x.c.industry ?? null);
  group("region", (x) => x.pref || "none");   // db/108：都道府県が取れない企業は none（未設定）
  group("service", (x) => x.c.service ?? null);
  group("status", (x) => x.c.status);
  const ng = base.filter((x) => but(x, "status") && x.c.ng_reason).length;
  if (ng) out.push({ kind: "status", value: "ng", n: ng });
  group("owner", (x) => x.c.owner_id || "none");
  group("channel", (x) => x.c.current_contact_channel || "none");
  group("attacked", (x) => (x.c.last_sent_at ? "yes" : "no"));
  group("clicked", (x) => ((x.c.click_count || 0) > 0 ? "yes" : "no"));
  return out;
}
function rpc(name, args) {
  rpcCalls.push({ name, args });
  if (rpcMissing || name !== "gw_sales_company_facet_counts") {
    return Promise.resolve({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${name}` } });
  }
  const rows = facetCountsRpc(args);
  return Promise.resolve({ data: rpcNoNone ? rows.filter((r) => !(r.kind === "region" && r.value === "none")) : rows, error: null });
}

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table, rpc }), userClient: () => ({ from: table, rpc }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async (rows) => { notified.push(...rows); return { created: rows.length }; } },
});
const looked = [];
mock.module(atRoot("lib/sales-lookup.js"), {
  namedExports: {
    normalizeSiteUrl: (u) => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).toString(); } catch { return null; } },
    lookupCompany: async (u) => { looked.push(u); return { ok: true, url: u, name: "株式会社ルックアップ", formUrl: `${u}contact/` }; },
  },
});
mock.module(atRoot("lib/slack.js"), {
  namedExports: { notifySlack: async (m) => { slacked.push(m); return { sent: true }; } },
});

const SALES = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["sales"], employee: { id: "emp-s1", display_name: "営業 一郎" } };
const SALES2 = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["sales"], employee: { id: "emp-s2", display_name: "営業 二郎" } };
// 経営者（社内権限 owner）。押し切り（強行アタック）もできる
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: true, roles: ["owner"], employee: { id: "emp-a1", display_name: "管理 花子" } };
// 会計側の管理者だけ（社内権限なし）。Sales には入れない
const ACCOUNTING_ADMIN = { tenantId: "t1", isAdmin: true, isHr: true, roles: [], employee: { id: "emp-a2", display_name: "会計 管理" } };
const IT_ONLY = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["it"], employee: { id: "emp-it", display_name: "情シス" } };
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: { id: "emp-m1", display_name: "一般 次郎" } };
const RECRUITER = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "emp-r1", display_name: "採用 三郎" } };
let who = SALES;
// 判定は本物（lib/gw.js）を使う。テストで条件を書き直すと、本番とずれても気づけない
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    // lib/gw.js の canSell・canForceAttack と同じ判定
    canSell: REAL_GW.canSell,
    canForceAttack: REAL_GW.canForceAttack,
  },
});

const { default: companies } = await import(atRoot("api/sales/companies/index.js"));
const { default: detail } = await import(atRoot("api/sales/companies/detail.js"));
const { default: approaches } = await import(atRoot("api/sales/approaches/index.js"));
const { default: templates } = await import(atRoot("api/sales/templates/index.js"));
const { default: redirect } = await import(atRoot("api/sales/r.js"));
const { default: lookup } = await import(atRoot("api/sales/lookup.js"));
const { default: meetingsApi } = await import(atRoot("api/sales/meetings/index.js"));
const { default: bulkApi } = await import(atRoot("api/sales/companies/bulk.js"));
const { default: exportApi } = await import(atRoot("api/sales/companies/export.js"));
const { default: importApi } = await import(atRoot("api/sales/companies/import.js"));
const { default: mastersApi } = await import(atRoot("api/sales/masters/index.js"));
const { TRACKING_RE, newTrackingToken, renderTemplate, addBizDays, autoNext, todayJst, classifyClick, isBot } =
  await import(atRoot("lib/sales.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => {
  const r = res();
  await h({ headers: { authorization: "Bearer x", host: "gw.example.jp", ...(req.headers || {}) }, ...req }, r);
  return r;
};
const HUMAN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const list = () => call(companies, { method: "GET", url: "/api/sales/companies" });
const create = (body) => call(companies, { method: "POST", url: "/api/sales/companies", body });
const getOne = (id) => call(detail, { method: "GET", url: `/api/sales/companies/detail?id=${id}` });
const patchCo = (body) => call(detail, { method: "PATCH", url: "/api/sales/companies/detail", body });
const addEvent = (body) => call(detail, { method: "POST", url: "/api/sales/companies/detail", body });
const prepare = (body) => call(approaches, { method: "POST", url: "/api/sales/approaches", body });
const act = (body) => call(approaches, { method: "PATCH", url: "/api/sales/approaches", body });
const click = (token, { ua = HUMAN, ip = "203.0.113.5", method = "GET", headers = {} } = {}) =>
  call(redirect, { method, url: `/api/sales/r?t=${token}`, headers: { "user-agent": ua, "x-forwarded-for": ip, ...headers } });
const valid = () => db.rows.gw_sales_click_events.filter((e) => e.is_valid);

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = SALES;
  rpcMissing = false;
  rpcNoNone = false;
  insertFail = null;
  rpcCalls.length = 0;
  logged.length = 0;
  notified.length = 0;
  slacked.length = 0;
  db.rows = {
    gw_sales_companies: [], gw_sales_approaches: [], gw_sales_click_events: [], gw_sales_events: [],
    gw_sales_templates: [], gw_sales_campaigns: [], gw_sales_meetings: [],
    gw_employees: [
      { id: "emp-s1", tenant_id: "t1", display_name: "営業 一郎", status: "active" },
      { id: "emp-s2", tenant_id: "t1", display_name: "営業 二郎", status: "active" },
      { id: "emp-a1", tenant_id: "t1", display_name: "管理 花子", status: "active" },
    ],
  };
}
async function newCompany(over = {}) {
  const r = await create({ name: "株式会社サンプル", siteUrl: "https://www.sample.co.jp/", formUrl: "sample.co.jp/contact", ...over });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return r.body.company;
}
async function sendAttack(companyId, extra = {}) {
  const p = await prepare({ companyId, ...extra });
  assert.equal(p.statusCode, 200, JSON.stringify(p.body));
  const s = await act({ id: p.body.approach.id, action: "sent", channel: "form", body: `営業文 ${p.body.trackingUrl}`, service: "AI / DX", ...extra });
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  return { approach: s.body.approach, url: p.body.trackingUrl };
}
const ageApproaches = (days) => {
  for (const a of db.rows.gw_sales_approaches) {
    if (a.sent_at) a.sent_at = new Date(Date.now() - days * 86400000).toISOString();
  }
};

console.log("\n=== 企業 ===\n");

await ok("追加すると、ドメインが入り、担当は自分になる", async () => {
  setup();
  const c = await newCompany();
  assert.equal(c.domain, "sample.co.jp");
  assert.equal(c.formUrl, "https://sample.co.jp/contact", "スキーム無しのURLは https を補う");
  assert.equal(c.ownerId, "emp-s1");
  assert.ok(logged.some((l) => l.action === "sales.company_create"));
});

await ok("同じサイトの会社は2行にしない（409で既存の会社を返す）", async () => {
  setup();
  const c = await newCompany();
  const r = await create({ name: "サンプル（別名）", siteUrl: "http://sample.co.jp/about" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.company.id, c.id);
  assert.equal(db.rows.gw_sales_companies.length, 1);
});

await ok("javascript: のURLは受け付けない", async () => {
  setup();
  const r = await create({ name: "悪い会社", siteUrl: "javascript:alert(1)" });
  assert.equal(r.statusCode, 400);
});

await ok("リストの取り込み：登録済み・リスト内の重複は飛ばす", async () => {
  setup();
  await newCompany();
  const r = await create({ companies: [
    { name: "A社", siteUrl: "https://a.example.jp" },
    { name: "A社（重複）", siteUrl: "https://www.a.example.jp/x" },
    { name: "サンプル", siteUrl: "https://sample.co.jp" },
    { name: "URLなし社" },
  ] });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, 2);
  assert.equal(r.body.skipped, 2);
  assert.equal(db.rows.gw_sales_companies.length, 3);
});

await ok("取り込みで1行でも形が悪ければ、何も入れず行番号を返す", async () => {
  setup();
  const r = await create({ companies: [{ name: "A社" }, { siteUrl: "https://b.example.jp" }] });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.row, 2);
  assert.equal(db.rows.gw_sales_companies.length, 0);
});

await ok("使えるのは経営者・責任者・営業担当（社内権限）。一般メンバー・採用担当・会計の管理者だけ・IT・管理だけは 403", async () => {
  setup();
  for (const p of [MEMBER, RECRUITER, ACCOUNTING_ADMIN, IT_ONLY]) {
    who = p;
    assert.equal((await list()).statusCode, 403, p.employee.display_name);
  }
  who = ADMIN;
  assert.equal((await list()).statusCode, 200);
  who = SALES;
  assert.equal((await list()).statusCode, 200);
});

console.log("\n=== フォームアタック ===\n");

await ok("送る前に専用URLを発行する。開き直しても同じURLを使い回す", async () => {
  setup();
  const c = await newCompany();
  const a = await prepare({ companyId: c.id });
  assert.equal(a.statusCode, 200, JSON.stringify(a.body));
  assert.match(a.body.trackingUrl, /^https:\/\/gw\.example\.jp\/r\/[2-9A-HJ-NP-Z]{10}$/);
  assert.equal(a.body.approach.sentAt, null, "まだ送っていない");
  const b = await prepare({ companyId: c.id });
  assert.equal(b.body.approach.id, a.body.approach.id);
  assert.equal(db.rows.gw_sales_approaches.length, 1);
  // まだ送っていないので、一覧のアタック数には入らない
  const l = await list();
  assert.equal(l.body.companies[0].attackCount, 0);
  assert.equal(l.body.companies[0].status, "untouched");
});

await ok("送信完了で履歴に残り、会社はアタック済・NEXTは「反応確認」3営業日後", async () => {
  setup();
  const c = await newCompany();
  const { approach } = await sendAttack(c.id);
  assert.ok(approach.sentAt);
  assert.equal(approach.employeeId, "emp-s1");
  assert.match(approach.body, /営業文/);
  const co = db.rows.gw_sales_companies[0];
  assert.equal(co.status, "attacked");
  assert.equal(co.next_action, "反応確認");
  assert.equal(co.next_action_on, addBizDays(todayJst(), 3));
  assert.ok(logged.some((l) => l.action === "sales.attack_sent"));
  const l = await list();
  assert.equal(l.body.companies[0].attackCount, 1);
  assert.equal(l.body.companies[0].lastAttackerName, "営業 一郎");
});

await ok("送信完了は二度押ししても1回だけ（409）", async () => {
  setup();
  const c = await newCompany();
  const { approach } = await sendAttack(c.id);
  const again = await act({ id: approach.id, action: "sent", channel: "form", body: "もう一度" });
  assert.equal(again.statusCode, 409);
  assert.equal(db.rows.gw_sales_approaches[0].body.startsWith("営業文"), true, "本文は最初のまま");
});

await ok("営業文が空なら送信完了にしない", async () => {
  setup();
  const c = await newCompany();
  const p = await prepare({ companyId: c.id });
  const r = await act({ id: p.body.approach.id, action: "sent", channel: "form", body: "  " });
  assert.equal(r.statusCode, 400);
});

await ok("送らなかった：未送信の専用URLは捨てられる。送信済みは消せない", async () => {
  setup();
  const c = await newCompany();
  const p = await prepare({ companyId: c.id });
  const d = await act({ id: p.body.approach.id, action: "discard" });
  assert.equal(d.statusCode, 200);
  assert.equal(db.rows.gw_sales_approaches.length, 0);
  const { approach } = await sendAttack(c.id);
  const d2 = await act({ id: approach.id, action: "discard" });
  assert.equal(d2.statusCode, 409);
  assert.equal(db.rows.gw_sales_approaches.length, 1);
});

console.log("\n=== 重複営業防止・NG ===\n");

await ok("直近30日以内にアタック済みなら、別の人でも 409（前回の日時・担当・サービスつき）", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  ageApproaches(3);
  who = SALES2;
  const r = await prepare({ companyId: c.id });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "recent_attack");
  assert.equal(r.body.recent.employeeName, "営業 一郎");
  assert.equal(r.body.recent.service, "AI / DX");
  assert.equal(r.body.canForce, false);
  const d = await getOne(c.id);
  assert.equal(d.body.recent.employeeName, "営業 一郎", "企業ページにも出す");
});

await ok("営業担当は押し切れない（403）。管理者は押し切れて、押し切ったことが残る", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  ageApproaches(3);
  who = SALES2;
  assert.equal((await prepare({ companyId: c.id, force: true })).statusCode, 403);
  who = ADMIN;
  const { approach } = await sendAttack(c.id, { force: true });
  assert.equal(approach.forced, true);
});

await ok("準備したあとに別の人が送っていたら、送信完了の時点でも止める", async () => {
  setup();
  const c = await newCompany();
  const p = await prepare({ companyId: c.id });
  who = SALES2;
  await sendAttack(c.id);
  who = SALES;
  const r = await act({ id: p.body.approach.id, action: "sent", channel: "form", body: "営業文" });
  assert.equal(r.statusCode, 409);
});

await ok("31日前のアタックなら止めない", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  ageApproaches(31);
  assert.equal((await prepare({ companyId: c.id })).statusCode, 200);
});

await ok("営業禁止の会社には、管理者でも押し切りでもアタックできない", async () => {
  setup();
  const c = await newCompany();
  const n = await patchCo({ id: c.id, ngReason: "unsubscribed", ngNote: "配信停止のご依頼" });
  assert.equal(n.statusCode, 200);
  assert.ok(db.rows.gw_sales_events.some((e) => e.label === "営業禁止に設定"));
  who = ADMIN;
  const r = await prepare({ companyId: c.id, force: true });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "ng_company");
  const l = await list();
  assert.equal(l.body.companies[0].nextKey, "ng");
});

console.log("\n=== 専用URL（クリック検知） ===\n");

await ok("人のクリック：記録して本来のページへ。会社はクリックあり、担当へGW通知・Slack", async () => {
  setup();
  const c = await newCompany();
  const tpl = await call(templates, { method: "POST", url: "/api/sales/templates",
    body: { name: "DX", service: "AI / DX", body: "{{company}} {{url}}", destinationUrl: "https://8grp.co.jp/service/dx" } });
  assert.equal(tpl.statusCode, 200, JSON.stringify(tpl.body));
  const { url } = await sendAttack(c.id, { templateId: tpl.body.template.id });
  const token = url.split("/r/")[1];

  const r = await click(token);
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, "https://8grp.co.jp/service/dx");
  assert.equal(r.headers["cache-control"], "no-store, max-age=0");
  assert.equal(db.rows.gw_sales_click_events.length, 1);
  const ev = db.rows.gw_sales_click_events[0];
  assert.equal(ev.is_valid, true);
  assert.equal(ev.excluded_reason, null);
  assert.equal(ev.click_no, 1);
  assert.equal(ev.ip_hash.length, 32);
  assert.ok(!JSON.stringify(ev).includes("203.0.113.5"), "IPそのものは残さない");
  const a = db.rows.gw_sales_approaches[0];
  assert.equal(a.click_count, 1);
  assert.ok(a.first_click_at && a.last_click_at);
  assert.equal(db.rows.gw_sales_companies[0].status, "clicked");
  assert.equal(db.rows.gw_sales_companies[0].next_action, "クリックあり・要フォロー");
  assert.equal(db.rows.gw_sales_companies[0].next_action_on, autoNext("click").next_action_on);
  assert.equal(notified.length, 1, "送った人＝担当なので1通");
  assert.equal(notified[0].kind, "sales");
  assert.match(notified[0].title, /株式会社サンプルが営業リンクをクリックしました/);
  assert.match(notified[0].body, /クリック回数：1回/);
  assert.match(notified[0].body, /提案サービス：AI \/ DX/);
  assert.equal(slacked.length, 1);
  assert.match(slacked[0].text, /営業反応あり/);
});

await ok("同じ人の30秒以内の連打は1回（ログには duplicate で残る）。別の人・時間をおいたクリックは数える", async () => {
  setup();
  const c = await newCompany();
  const { url } = await sendAttack(c.id);
  const token = url.split("/r/")[1];
  await click(token);
  await click(token);
  assert.equal(db.rows.gw_sales_approaches[0].click_count, 1);
  assert.equal(db.rows.gw_sales_click_events.length, 2, "連打もログには残す");
  assert.equal(db.rows.gw_sales_click_events[1].is_valid, false);
  assert.equal(db.rows.gw_sales_click_events[1].excluded_reason, "duplicate");
  assert.equal(notified.length, 1, "連打では通知しない");
  await click(token, { ip: "198.51.100.9" });
  assert.equal(db.rows.gw_sales_approaches[0].click_count, 2);
  assert.equal(valid()[1].click_no, 2);
  valid()[0].clicked_at = new Date(Date.now() - 60000).toISOString();
  await click(token);
  assert.equal(db.rows.gw_sales_approaches[0].click_count, 3);
});

await ok("リンクのプレビュー（機械）・HEAD・先読みは数えず飛ばすだけ。ログには理由つきで残す", async () => {
  setup();
  const c = await newCompany();
  const { url } = await sendAttack(c.id);
  const token = url.split("/r/")[1];
  for (const ua of ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "Mozilla/5.0 (compatible; Googlebot/2.1)", "facebookexternalhit/1.1", ""]) {
    const r = await click(token, { ua });
    assert.equal(r.statusCode, 302);
  }
  assert.equal((await click(token, { method: "HEAD" })).statusCode, 302);
  assert.equal((await click(token, { headers: { "sec-purpose": "prefetch" } })).statusCode, 302);
  assert.equal((await click(token, { ua: "python-requests/2.31" })).statusCode, 302);
  assert.equal(valid().length, 0, "有効クリックは0");
  assert.deepEqual(db.rows.gw_sales_click_events.map((e) => e.excluded_reason),
    ["bot", "bot", "bot", "no_ua", "head", "prefetch", "bot"]);
  assert.equal(db.rows.gw_sales_approaches[0].click_count, 0);
  assert.equal(db.rows.gw_sales_companies[0].status, "attacked");
  assert.equal(notified.length, 0);
});

await ok("人のブラウザ（iPhone・Android・Edge・Outlook内・名前にbotを含む端末）は除外しない", async () => {
  for (const ua of [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edge/18 Outlook-iOS/709",
    "Mozilla/5.0 (Linux; Android 12; CUBOT KingKong 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.9.0",
  ]) {
    assert.equal(isBot(ua), false, ua);
    assert.deepEqual(classifyClick({ method: "GET", ua }), { valid: true, reason: null }, ua);
  }
});

await ok("知らない・形の悪いトークンでも、エラーにせず会社のサイトへ飛ばす", async () => {
  setup();
  for (const t of ["XXXXXXXXXX", "abc", "'; drop table--"]) {
    const r = await click(encodeURIComponent(t));
    assert.equal(r.statusCode, 302);
    assert.match(r.headers.location, /^https:\/\/8grp\.co\.jp\//);
  }
});

await ok("クリックは、商談以上に進んだ会社のステータスを戻さない", async () => {
  setup();
  const c = await newCompany();
  const { url } = await sendAttack(c.id);
  await patchCo({ id: c.id, status: "meeting" });
  await click(url.split("/r/")[1]);
  assert.equal(db.rows.gw_sales_companies[0].status, "meeting");
});

console.log("\n=== 反応への対応・NEXT ===\n");

await ok("クリックされると未対応クリック。フォローを記録すると外れる", async () => {
  setup();
  const c = await newCompany();
  const { url } = await sendAttack(c.id);
  await click(url.split("/r/")[1]);
  let l = await list();
  assert.equal(l.body.companies[0].unhandledClick, true);
  assert.equal(l.body.companies[0].nextKey, "follow_click");
  assert.equal(l.body.companies[0].clickCount, 1);

  // 同じミリ秒に並ばないよう、クリックを少し前にずらす
  db.rows.gw_sales_approaches[0].last_click_at = new Date(Date.now() - 1000).toISOString();
  const e = await addEvent({ id: c.id, kind: "follow", detail: "電話で担当者確認", nextAction: "資料送付", nextActionOn: "2099-01-05" });
  assert.equal(e.statusCode, 200, JSON.stringify(e.body));
  l = await list();
  assert.equal(l.body.companies[0].unhandledClick, false);
  assert.equal(l.body.companies[0].next, "資料送付");
  assert.equal(l.body.companies[0].nextDue, "2099-01-05");
});

await ok("返信ありを記録するとステータスが進む。メモでは進まない・戻らない", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  await addEvent({ id: c.id, kind: "memo", detail: "メモ" });
  assert.equal(db.rows.gw_sales_companies[0].status, "attacked");
  await addEvent({ id: c.id, kind: "reply" });
  assert.equal(db.rows.gw_sales_companies[0].status, "replied");
  await patchCo({ id: c.id, status: "proposal" });
  await addEvent({ id: c.id, kind: "reply" });
  assert.equal(db.rows.gw_sales_companies[0].status, "proposal");
});

await ok("営業履歴は、送信・クリック・出来事が時系列に並ぶ", async () => {
  setup();
  const c = await newCompany();
  const { url } = await sendAttack(c.id);
  db.rows.gw_sales_approaches[0].sent_at = new Date(Date.now() - 3600000).toISOString();
  await click(url.split("/r/")[1]);
  db.rows.gw_sales_click_events[0].clicked_at = new Date(Date.now() - 1800000).toISOString();
  await addEvent({ id: c.id, kind: "reply" });
  const d = await getOne(c.id);
  assert.equal(d.statusCode, 200);
  const labels = d.body.timeline.filter((t) => !t.planned).map((t) => t.label);
  assert.deepEqual(labels, ["お問い合わせフォームから送信", "リンククリック", "返信あり"]);
});

console.log("\n=== NEXT の自動更新 ===\n");

await ok("返信あり → 返信対応（当日〜）。商談 → 商談準備。フォローだけなら反応確認（3営業日後）", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  await addEvent({ id: c.id, kind: "call", nextAction: null, nextActionOn: null });
  let co = db.rows.gw_sales_companies[0];
  assert.equal(co.next_action, "反応確認");
  assert.equal(co.next_action_on, addBizDays(todayJst(), 3));
  await addEvent({ id: c.id, kind: "reply" });
  co = db.rows.gw_sales_companies[0];
  assert.equal(co.status, "replied");
  assert.equal(co.next_action, "返信対応");
  assert.equal(co.next_action_on, autoNext("reply").next_action_on);
  // 返信対応の最中にフォローを記録しても、返信対応は上書きしない
  await addEvent({ id: c.id, kind: "follow" });
  assert.equal(db.rows.gw_sales_companies[0].next_action, "返信対応");
  await addEvent({ id: c.id, kind: "meeting" });
  co = db.rows.gw_sales_companies[0];
  assert.equal(co.status, "meeting");
  assert.equal(co.next_action, "商談準備");
});

await ok("人が決めた NEXT は、自動より優先する", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  await addEvent({ id: c.id, kind: "reply", nextAction: "見積作成", nextActionOn: "2099-02-01" });
  const co = db.rows.gw_sales_companies[0];
  assert.equal(co.next_action, "見積作成");
  assert.equal(co.next_action_on, "2099-02-01");
});

await ok("ステータスを手で「返信あり」「商談」にしたときも、NEXT を自動で入れる", async () => {
  setup();
  const c = await newCompany();
  await patchCo({ id: c.id, status: "replied" });
  assert.equal(db.rows.gw_sales_companies[0].next_action, "返信対応");
  await patchCo({ id: c.id, status: "meeting" });
  assert.equal(db.rows.gw_sales_companies[0].next_action, "商談準備");
});

await ok("返信・商談中の会社がクリックしても、返信対応・商談準備は残す（未対応クリックとしては出る）", async () => {
  setup();
  const c = await newCompany();
  const { url } = await sendAttack(c.id);
  await addEvent({ id: c.id, kind: "reply" });
  db.rows.gw_sales_companies[0].followed_at = new Date(Date.now() - 5000).toISOString();
  await click(url.split("/r/")[1]);
  const co = db.rows.gw_sales_companies[0];
  assert.equal(co.status, "replied");
  assert.equal(co.next_action, "返信対応");
  const l = await list();
  assert.equal(l.body.companies[0].unhandledClick, true);
  assert.equal(l.body.companies[0].next, "クリックあり・要フォロー");
});

await ok("クリック：営業日の17時前は当日、17時以降・休日は翌営業日", async () => {
  // 2026-09-24（木）11:00 JST / 18:00 JST、2026-09-26（土）
  assert.equal(autoNext("click", new Date("2026-09-24T02:00:00Z")).next_action_on, "2026-09-24");
  assert.equal(autoNext("click", new Date("2026-09-24T09:00:00Z")).next_action_on, "2026-09-25");
  assert.equal(autoNext("click", new Date("2026-09-26T02:00:00Z")).next_action_on, "2026-09-28");
  // 送信直後：9/18（金）から3営業日＝祝日（9/21・22・23）を飛ばして 9/28（月）
  assert.equal(autoNext("sent", new Date("2026-09-18T02:00:00Z")).next_action_on, "2026-09-28");
});

await ok("ステータス画面から空欄（null）のNEXTで「返信あり」にしても、返信対応が入る", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  await patchCo({ id: c.id, status: "replied", nextAction: null, nextActionOn: null, ownerId: null, campaignId: null });
  assert.equal(db.rows.gw_sales_companies[0].next_action, "返信対応");
});

await ok("失注・対象外・営業禁止の会社は、クリックされても営業を再開しない（ログと回数は残す）", async () => {
  for (const [field, value] of [["status", "lost"], ["status", "excluded"], ["ng_reason", "unsubscribed"]]) {
    setup();
    const c = await newCompany();
    const { url } = await sendAttack(c.id);
    db.rows.gw_sales_companies[0][field] = value;
    const before = { ...db.rows.gw_sales_companies[0] };
    const r = await click(url.split("/r/")[1]);
    assert.equal(r.statusCode, 302);
    const co = db.rows.gw_sales_companies[0];
    assert.equal(co.status, before.status, `${field}=${value}`);
    assert.equal(co.next_action, before.next_action, `${field}=${value}`);
    assert.equal(db.rows.gw_sales_approaches[0].click_count, 1);
    assert.equal(notified.length, 0);
  }
});

await ok("同時に開かれても回数を取りこぼさない（読んだ値＋1にしない）", async () => {
  setup();
  const c = await newCompany();
  const { url } = await sendAttack(c.id);
  const a = db.rows.gw_sales_approaches[0];
  // 別のリクエストが先に有効クリックを記録したが、まだ回数を書き戻していない状態
  db.rows.gw_sales_click_events.push({ id: "other", tenant_id: "t1", approach_id: a.id, company_id: c.id,
    clicked_at: new Date(Date.now() - 1000).toISOString(), is_valid: true, ip_hash: "someone-else" });
  await click(url.split("/r/")[1]);
  assert.equal(a.click_count, 2);
  assert.equal(valid().find((e) => e.id !== "other").click_no, 2);
  assert.equal(a.first_click_at, db.rows.gw_sales_click_events[0].clicked_at, "初回は早いほう");
});

console.log("\n=== テンプレート ===\n");

await ok("テンプレートごとの使用回数・クリック率", async () => {
  setup();
  const tpl = await call(templates, { method: "POST", url: "/api/sales/templates",
    body: { name: "DX", body: "{{company}} {{url}}" } });
  const id = tpl.body.template.id;
  const c1 = await newCompany({ name: "A", siteUrl: "https://a.jp" });
  const c2 = await newCompany({ name: "B", siteUrl: "https://b.jp" });
  const { url } = await sendAttack(c1.id, { templateId: id });
  await sendAttack(c2.id, { templateId: id });
  await click(url.split("/r/")[1]);
  const r = await call(templates, { method: "GET", url: "/api/sales/templates" });
  const t = r.body.templates.find((x) => x.id === id);
  assert.equal(t.uses, 2);
  assert.equal(t.clickRate, 50);
});

console.log("\n=== URLから企業情報（/api/sales/lookup） ===\n");

await ok("候補を返す。登録済みのドメインなら、その企業も返す", async () => {
  setup();
  looked.length = 0;
  const r1 = await call(lookup, { method: "GET", url: "/api/sales/lookup?url=https%3A%2F%2Fnew.example.jp" });
  assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.name, "株式会社ルックアップ");
  assert.equal(r1.body.domain, "new.example.jp");
  assert.equal(r1.body.duplicate, null);
  const c = await newCompany();
  const r2 = await call(lookup, { method: "GET", url: "/api/sales/lookup?url=www.sample.co.jp" });
  assert.equal(r2.body.duplicate.id, c.id);
});

await ok("/sales を使えない人は使えない（外のサイトを取りにいく中継にしない）", async () => {
  setup();
  looked.length = 0;
  who = MEMBER;
  const r = await call(lookup, { method: "GET", url: "/api/sales/lookup?url=https%3A%2F%2Fx.example.jp" });
  assert.equal(r.statusCode, 403);
  assert.equal(looked.length, 0, "取りにいっていない");
  who = SALES;
  const bad = await call(lookup, { method: "GET", url: "/api/sales/lookup?url=javascript%3Aalert(1)" });
  assert.equal(bad.statusCode, 400);
});

console.log("\n=== 営業面談（/api/sales/meetings） ===\n");

const mIssue = (body) => call(meetingsApi, { method: "POST", url: "/api/sales/meetings", body });
const mAct = (body) => call(meetingsApi, { method: "PATCH", url: "/api/sales/meetings", body });

await ok("面談を設定：初回商談30分を作り、会社と面談のIDつきの TimeRex URL を返す。2回押しても1件", async () => {
  setup();
  process.env.TIMEREX_SALES_MEETING_URL = "https://timerex.net/s/eight/first30";
  const c = await newCompany();
  await patchCo({ id: c.id, contacts: { email: "tanaka@sample.co.jp" } });
  const r = await mIssue({ companyId: c.id });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const m = r.body.meeting;
  assert.equal(m.kind, "first_meeting");
  assert.equal(m.kindLabel, "初回商談");
  assert.equal(m.durationMin, 30);
  assert.equal(m.status, "scheduling");
  assert.equal(m.ownerId, "emp-s1", "担当は会社の担当");
  assert.equal(m.schedulingUrl, `https://timerex.net/s/eight/first30?sales_company_id=${c.id}&sales_meeting_id=${m.id}`);
  const again = await mIssue({ companyId: c.id });
  assert.equal(again.body.reused, true);
  assert.equal(again.body.meeting.id, m.id);
  assert.equal(db.rows.gw_sales_meetings.length, 1);
  delete process.env.TIMEREX_SALES_MEETING_URL;
});

await ok("TimeRex を使うとき、予約照合に使うメールが無い企業は日程調整を開始できない（400 email_required・商談を作らない）", async () => {
  setup();
  process.env.TIMEREX_SALES_MEETING_URL = "https://timerex.net/s/eight/first30";
  const c = await newCompany();
  const r = await mIssue({ companyId: c.id });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "email_required");
  assert.equal(db.rows.gw_sales_meetings.length, 0, "商談を作らない");
  // いまの連絡手段がメールなら、その連絡先でも照合できる（Webhook と同じ判定）
  const co = db.rows.gw_sales_companies.find((x) => x.id === c.id);
  Object.assign(co, { current_contact_channel: "email", current_contact_value: "Info@Sample.co.jp" });
  const d = await getOne(c.id);
  assert.deepEqual(d.body.matchEmails, ["info@sample.co.jp"]);
  assert.equal((await mIssue({ companyId: c.id })).statusCode, 200);
  delete process.env.TIMEREX_SALES_MEETING_URL;
});

await ok("企業詳細は共通マスター（業種・提案サービス・47都道府県）を返す（リード一覧の基本情報の編集で使う）", async () => {
  setup();
  const c = await newCompany();
  const d = await getOne(c.id);
  assert.equal(d.statusCode, 200);
  assert.equal(d.body.masters.prefectures.length, 47);
  assert.ok(d.body.masters.industries.includes("製造") && d.body.masters.services.includes("AI / DX"));
});

await ok("予約照合用のメールをその場で登録：PATCH contacts は連絡先だけ直し、営業履歴は増やさない。詳細の matchEmails に出る", async () => {
  setup();
  const c = await newCompany();
  const before = db.rows.gw_sales_events.length;
  assert.deepEqual((await getOne(c.id)).body.matchEmails, []);
  assert.equal((await patchCo({ id: c.id, contacts: { email: "tanaka" } })).statusCode, 400, "メールの形");
  const r = await patchCo({ id: c.id, contacts: { email: "tanaka@sample.co.jp" } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.company.contacts.email, "tanaka@sample.co.jp");
  assert.equal(db.rows.gw_sales_events.length, before, "営業履歴は増やさない");
  assert.deepEqual((await getOne(c.id)).body.matchEmails, ["tanaka@sample.co.jp"]);
  // 他の連絡先は消さない。いまの連絡手段がメールなら、その連絡先も合わせて直す
  const co = db.rows.gw_sales_companies.find((x) => x.id === c.id);
  co.contacts = { ...co.contacts, line: "sample_line" };
  co.current_contact_channel = "email";
  await patchCo({ id: c.id, contacts: { email: "sato@sample.co.jp" } });
  assert.equal(co.contacts.line, "sample_line");
  assert.equal(co.current_contact_value, "sato@sample.co.jp");
});

await ok("TimeRex の URL が未設定でも面談は作れる（URL は null、日程は手入力）", async () => {
  setup();
  delete process.env.TIMEREX_SALES_MEETING_URL;
  const c = await newCompany();
  const r = await mIssue({ companyId: c.id });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.meeting.schedulingUrl, null);
  assert.equal(r.body.timerexConfigured, false);
});

await ok("送付済み：NEXT は「日程調整待ち（初回商談）」3営業日後。未対応クリックから外れる", async () => {
  setup();
  const c = await newCompany();
  const { url } = await sendAttack(c.id);
  db.rows.gw_sales_approaches[0].last_click_at = new Date(Date.now() - 5000).toISOString();
  await click(url.split("/r/")[1]);
  const { body } = await mIssue({ companyId: c.id });
  const r = await mAct({ id: body.meeting.id, action: "sent" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(r.body.meeting.schedulingSentAt);
  const co = db.rows.gw_sales_companies[0];
  assert.equal(co.next_action, "日程調整待ち（初回商談）");
  assert.equal(co.next_action_on, addBizDays(todayJst(), 3));
  const l = await list();
  assert.equal(l.body.companies[0].unhandledClick, false);
  assert.equal(l.body.companies[0].meetingStatus, "scheduling");
  assert.ok(db.rows.gw_sales_events.some((e) => e.label.startsWith("商談の日程調整URLを送付")));
});

await ok("日程確定：面談予定・会社は商談へ・NEXT は面談の日に「商談準備」・履歴に残る", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  const { body } = await mIssue({ companyId: c.id });
  const at = "2099-10-05T05:00:00.000Z"; // JST 14:00
  const r = await mAct({ id: body.meeting.id, action: "schedule", scheduledAt: at, meetingUrl: "https://meet.google.com/abc-defg-hij" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.meeting.status, "scheduled");
  assert.equal(r.body.meeting.scheduledAt, at);
  assert.equal(r.body.meeting.meetingUrl, "https://meet.google.com/abc-defg-hij");
  const co = db.rows.gw_sales_companies[0];
  assert.equal(co.status, "meeting");
  assert.equal(co.next_action, "商談準備");
  assert.equal(co.next_action_on, "2099-10-05");
  assert.ok(db.rows.gw_sales_events.some((e) => e.label === "商談予定：10/5 14:00（初回商談）"));
  const d = await getOne(c.id);
  assert.equal(d.body.meetings[0].status, "scheduled");
  assert.equal(d.body.meetingsReady, true);
  // 面談予定のあいだは、新しく日程調整URLを出さない
  const again = await mIssue({ companyId: c.id });
  assert.equal(again.body.meeting.id, body.meeting.id);
});

await ok("日時なし・変なURLは断る。取りやめたら次は新しく作れる", async () => {
  setup();
  const c = await newCompany();
  const { body } = await mIssue({ companyId: c.id });
  assert.equal((await mAct({ id: body.meeting.id, action: "schedule" })).statusCode, 400);
  assert.equal((await mAct({ id: body.meeting.id, action: "schedule", scheduledAt: "2099-01-01T00:00:00Z", meetingUrl: "javascript:alert(1)" })).statusCode, 400);
  assert.equal((await mAct({ id: body.meeting.id, action: "cancel" })).body.meeting.status, "canceled");
  const next = await mIssue({ companyId: c.id });
  assert.notEqual(next.body.meeting.id, body.meeting.id);
});

await ok("TimeRex の予約で確定した商談は、手入力で日時を変えられない（409 timerex_managed）。失注の会社は手入力でも戻さない", async () => {
  setup();
  const c = await newCompany();
  const { body } = await mIssue({ companyId: c.id });
  const row = db.rows.gw_sales_meetings.find((x) => x.id === body.meeting.id);
  Object.assign(row, { status: "scheduled", scheduled_at: "2026-10-05T01:00:00.000Z", timerex_event_id: "evt_x", timerex_synced_at: new Date().toISOString() });
  const r = await mAct({ id: row.id, action: "schedule", scheduledAt: "2026-10-09T05:00:00Z" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "timerex_managed");
  assert.equal(row.scheduled_at, "2026-10-05T01:00:00.000Z");
  // 手入力の商談なら従来どおり。ただし失注・対象外の会社を「商談」へ戻さない
  const c2 = await newCompany({ name: "失注社", siteUrl: "https://lost.example.jp/" });
  const co = db.rows.gw_sales_companies.find((x) => x.id === c2.id);
  const { body: b2 } = await mIssue({ companyId: c2.id });
  co.status = "lost";
  const r2 = await mAct({ id: b2.meeting.id, action: "schedule", scheduledAt: "2026-10-09T05:00:00Z" });
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  assert.equal(co.status, "lost", "失注を商談へ戻さない");
});

await ok("営業禁止の会社・/sales を使えない人は面談を設定できない", async () => {
  setup();
  const c = await newCompany();
  await patchCo({ id: c.id, ngReason: "unsubscribed" });
  assert.equal((await mIssue({ companyId: c.id })).statusCode, 403);
  who = MEMBER;
  assert.equal((await mIssue({ companyId: c.id })).statusCode, 403);
  assert.equal(db.rows.gw_sales_meetings.length, 0);
});

console.log("\n=== 企業の一括操作（/api/sales/companies/bulk） ===\n");

const bulk = (body) => call(bulkApi, { method: "POST", url: "/api/sales/companies/bulk", body });
const coRow = (id) => db.rows.gw_sales_companies.find((x) => x.id === id);

await ok("ステータス一括変更：同じステータスの企業は触らず、変えた企業には営業履歴と自動NEXTを残す", async () => {
  setup();
  const a = await newCompany({ name: "A社", siteUrl: "https://a.example.jp/" });
  const b = await newCompany({ name: "B社", siteUrl: "https://b.example.jp/" });
  coRow(b.id).status = "replied";
  const r = await bulk({ ids: [a.id, b.id], action: "change_status", status: "replied" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.updated, r.body.skipped, r.body.failed, r.body.notFound], [1, 1, 0, 0]);
  assert.equal(coRow(a.id).status, "replied");
  assert.equal(coRow(a.id).next_action, autoNext("reply").next_action, "返信ありへ進めたら NEXT を自動で入れる");
  const ev = db.rows.gw_sales_events.filter((e) => e.company_id === a.id);
  assert.equal(ev.length, 1);
  assert.match(ev[0].detail, /未アタック → 返信あり（一括変更）/);
  assert.equal(db.rows.gw_sales_events.filter((e) => e.company_id === b.id).length, 0, "変わらない企業には履歴を残さない");
  assert.ok(logged.some((l) => l.action === "sales.company_bulk_status" && l.detail.count === 1));
});

await ok("担当一括変更：同じテナントの社員だけ。知らない担当は断る", async () => {
  setup();
  const a = await newCompany({ name: "A社", siteUrl: "https://a.example.jp/" });
  const b = await newCompany({ name: "B社", siteUrl: "https://b.example.jp/" });
  const r = await bulk({ ids: [a.id, b.id], action: "change_owner", ownerId: "00000000-0000-4000-8000-00000000abcd" });
  assert.equal(r.statusCode, 400);
  db.rows.gw_employees.push({ id: "00000000-0000-4000-8000-0000000000e2", tenant_id: "t1", display_name: "営業 三郎", status: "active" });
  const r2 = await bulk({ ids: [a.id, b.id], action: "change_owner", ownerId: "00000000-0000-4000-8000-0000000000e2" });
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.updated, 2);
  assert.ok([a.id, b.id].every((id) => coRow(id).owner_id === "00000000-0000-4000-8000-0000000000e2"));
  const r3 = await bulk({ ids: [a.id], action: "change_owner", ownerId: null });
  assert.equal(r3.body.updated, 1);
  assert.equal(coRow(a.id).owner_id, null, "未定にもできる");
});

await ok("他テナント・知らない・形の悪いIDは処理せず「見つからない」に数える", async () => {
  setup();
  const a = await newCompany({ name: "A社", siteUrl: "https://a.example.jp/" });
  const other = { id: "00000000-0000-4000-8000-0000000000f1", tenant_id: "t2", name: "他社", status: "untouched" };
  db.rows.gw_sales_companies.push(other);
  const r = await bulk({ ids: [a.id, other.id, "00000000-0000-4000-8000-0000000000f9", "not-a-uuid"], action: "change_service", service: "AI / DX" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.updated, 1);
  assert.equal(r.body.notFound, 3);
  assert.equal(coRow(a.id).service, "AI / DX");
  assert.equal(other.service, undefined, "他テナントの企業は変えない");
});

await ok("使えない人・選択なし・多すぎ・知らない操作は断る", async () => {
  setup();
  const a = await newCompany({ name: "A社", siteUrl: "https://a.example.jp/" });
  who = MEMBER;
  assert.equal((await bulk({ ids: [a.id], action: "change_status", status: "lost" })).statusCode, 403);
  who = RECRUITER;
  assert.equal((await bulk({ ids: [a.id], action: "change_status", status: "lost" })).statusCode, 403);
  who = SALES;
  assert.equal((await bulk({ ids: [], action: "change_status", status: "lost" })).statusCode, 400);
  const many = Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(900000 + i).padStart(12, "0")}`);
  assert.equal((await bulk({ ids: many, action: "change_status", status: "lost" })).statusCode, 400);
  assert.equal((await bulk({ ids: [a.id], action: "wipe" })).statusCode, 400);
  assert.equal((await bulk({ ids: [a.id], action: "change_status", status: "nope" })).statusCode, 400);
  assert.equal(coRow(a.id).status, "untouched");
});

await ok("キャンペーン一括変更：自テナントのキャンペーンだけ", async () => {
  setup();
  const a = await newCompany({ name: "A社", siteUrl: "https://a.example.jp/" });
  db.rows.gw_sales_campaigns.push({ id: "00000000-0000-4000-8000-0000000000c1", tenant_id: "t1", name: "秋の製造業" },
    { id: "00000000-0000-4000-8000-0000000000c2", tenant_id: "t2", name: "他社の" });
  assert.equal((await bulk({ ids: [a.id], action: "change_campaign", campaignId: "00000000-0000-4000-8000-0000000000c2" })).statusCode, 400);
  const r = await bulk({ ids: [a.id], action: "change_campaign", campaignId: "00000000-0000-4000-8000-0000000000c1" });
  assert.equal(r.body.updated, 1);
  assert.equal(coRow(a.id).campaign_id, "00000000-0000-4000-8000-0000000000c1");
});

await ok("営業禁止にする：理由は必須。すでに営業禁止の企業は上書きしない。営業履歴に残す", async () => {
  setup();
  const a = await newCompany({ name: "A社", siteUrl: "https://a.example.jp/" });
  const b = await newCompany({ name: "B社", siteUrl: "https://b.example.jp/" });
  coRow(b.id).ng_reason = "competitor";
  assert.equal((await bulk({ ids: [a.id, b.id], action: "set_ng" })).statusCode, 400);
  const r = await bulk({ ids: [a.id, b.id], action: "set_ng", ngReason: "unsubscribed", ngNote: "配信停止のご依頼" });
  assert.deepEqual([r.body.updated, r.body.skipped], [1, 1]);
  assert.equal(coRow(a.id).ng_reason, "unsubscribed");
  assert.equal(coRow(b.id).ng_reason, "competitor");
  assert.ok(db.rows.gw_sales_events.some((e) => e.company_id === a.id && e.label === "営業禁止に設定"));
  // 営業禁止になった企業には、もうアタックできない
  assert.equal((await prepare({ companyId: a.id })).statusCode, 403);
});

await ok("削除：履歴・面談・成約・営業禁止のある企業は消さず理由を返す。履歴の無い企業だけ消す", async () => {
  setup();
  const clean = await newCompany({ name: "誤登録社", siteUrl: "https://clean.example.jp/" });
  const attacked = await newCompany({ name: "アタック済社", siteUrl: "https://atk.example.jp/" });
  const noted = await newCompany({ name: "メモ社", siteUrl: "https://memo.example.jp/" });
  const met = await newCompany({ name: "面談社", siteUrl: "https://meet.example.jp/" });
  const won = await newCompany({ name: "成約社", siteUrl: "https://won.example.jp/" });
  const ng = await newCompany({ name: "禁止社", siteUrl: "https://ng.example.jp/" });
  await sendAttack(attacked.id);
  await addEvent({ id: noted.id, kind: "memo", detail: "電話した" });
  db.rows.gw_sales_meetings.push({ id: uuid(), tenant_id: "t1", company_id: met.id, status: "scheduling" });
  coRow(won.id).status = "won";
  coRow(ng.id).ng_reason = "customer";
  const ids = [clean.id, attacked.id, noted.id, met.id, won.id, ng.id];

  const dry = await bulk({ ids, action: "delete", dryRun: true });
  assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
  assert.deepEqual(dry.body.deletable.map((c) => c.name), ["誤登録社"]);
  const why = Object.fromEntries(dry.body.blocked.map((b) => [b.name, b.reasons.join("・")]));
  assert.match(why["アタック済社"], /アタック履歴あり/);
  assert.match(why["メモ社"], /営業履歴あり/);
  assert.match(why["面談社"], /商談あり/);
  assert.match(why["成約社"], /成約済み/);
  assert.match(why["禁止社"], /営業禁止/);
  assert.equal(db.rows.gw_sales_companies.length, 6, "確認だけでは消さない");

  // 画面を通さずに全部を消そうとしても、履歴のある企業は残る
  const r = await bulk({ ids, action: "delete" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.deleted, 1);
  assert.equal(r.body.blocked.length, 5);
  assert.deepEqual(db.rows.gw_sales_companies.map((c) => c.name).sort(), ["アタック済社", "メモ社", "成約社", "禁止社", "面談社"].sort());
  assert.ok(logged.some((l) => l.action === "sales.company_bulk_delete" && l.detail.deleted === 1 && l.detail.names[0] === "誤登録社"));
});

await ok("削除：クリック履歴だけがある企業も消さない", async () => {
  setup();
  const c = await newCompany({ name: "クリック社", siteUrl: "https://click.example.jp/" });
  db.rows.gw_sales_click_events.push({ id: uuid(), tenant_id: "t1", company_id: c.id, is_valid: false });
  const r = await bulk({ ids: [c.id], action: "delete" });
  assert.equal(r.body.deleted, 0);
  assert.match(r.body.blocked[0].reasons.join(), /クリック履歴あり/);
  assert.equal(db.rows.gw_sales_companies.length, 1);
});

console.log("\n=== 非表示・送信チャネル・送信できなかった・返信後の連絡（db/096） ===\n");

const listV = (v) => call(companies, { method: "GET", url: `/api/sales/companies?visibility=${v}` });
const names = (r) => r.body.companies.map((c) => c.name).sort();

await ok("非表示：理由は必須。通常の一覧から消え、「非表示」「すべて」では見える。再表示で戻る", async () => {
  setup();
  const a = await newCompany({ name: "リンク切れ社", siteUrl: "https://dead.example.jp/" });
  const b = await newCompany({ name: "生きてる社", siteUrl: "https://alive.example.jp/" });
  assert.equal((await bulk({ ids: [a.id], action: "hide" })).statusCode, 400, "理由なしは 400");
  assert.equal((await bulk({ ids: [a.id], action: "hide", reason: "nope" })).statusCode, 400);
  const r = await bulk({ ids: [a.id], action: "hide", reason: "link_broken", note: "404" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.updated, 1);
  const row = db.rows.gw_sales_companies.find((x) => x.id === a.id);
  assert.ok(row.hidden_at);
  assert.equal(row.hidden_by, "u-1");
  assert.equal(row.hidden_reason, "link_broken");
  assert.deepEqual(names(await list()), ["生きてる社"], "既定（表示中）には出ない");
  assert.deepEqual(names(await listV("hidden")), ["リンク切れ社"]);
  assert.deepEqual(names(await listV("all")), ["リンク切れ社", "生きてる社"]);
  assert.equal((await listV("nope")).statusCode, 400);
  const shown = (await listV("hidden")).body.companies[0];
  assert.equal(shown.hidden, true);
  assert.equal(shown.hiddenLabel, "リンク切れ");
  assert.ok(db.rows.gw_sales_events.some((e) => e.company_id === a.id && e.label === "非表示：リンク切れ" && e.detail === "404"));
  assert.ok(logged.some((l) => l.action === "sales.company_bulk_hide"));

  // すでに非表示の企業は、理由を上書きしない
  const again = await bulk({ ids: [a.id, b.id], action: "hide", reason: "closed" });
  assert.equal(again.body.updated, 1);
  assert.equal(again.body.skipped, 1);
  assert.equal(db.rows.gw_sales_companies.find((x) => x.id === a.id).hidden_reason, "link_broken");

  const un = await bulk({ ids: [a.id], action: "unhide" });
  assert.equal(un.body.updated, 1);
  const back = db.rows.gw_sales_companies.find((x) => x.id === a.id);
  assert.equal(back.hidden_at, null);
  assert.equal(back.hidden_reason, null);
  assert.ok(names(await list()).includes("リンク切れ社"), "再表示で一覧に戻る");
  assert.ok(db.rows.gw_sales_events.some((e) => e.company_id === a.id && e.label === "再表示"));
});

await ok("非表示の企業にはアタックできない（409）。再表示すれば送れる", async () => {
  setup();
  const c = await newCompany();
  await bulk({ ids: [c.id], action: "hide", reason: "not_target" });
  const p = await prepare({ companyId: c.id });
  assert.equal(p.statusCode, 409);
  assert.equal(p.body.error, "hidden_company");
  assert.match(p.body.hint, /営業対象外/);
  await bulk({ ids: [c.id], action: "unhide" });
  assert.equal((await prepare({ companyId: c.id })).statusCode, 200);
});

await ok("非表示でも同じサイトは取り込み直さない（重複として止まる・非表示中と分かる）", async () => {
  setup();
  const c = await newCompany();
  await bulk({ ids: [c.id], action: "hide", reason: "closed" });
  const one = await create({ name: "サンプル再取得", siteUrl: "https://sample.co.jp/" });
  assert.equal(one.statusCode, 409);
  assert.equal(one.body.company.hidden, true);
  assert.match(one.body.hint, /非表示中/);
  const many = await create({ companies: [{ name: "サンプル再取得", siteUrl: "https://sample.co.jp/" }] });
  assert.equal(many.body.skipped, 1);
  assert.equal(db.rows.gw_sales_companies.length, 1);
});

await ok("非表示の記録だけの企業は削除できる（テスト企業を隠してから消せる）", async () => {
  setup();
  const c = await newCompany({ name: "テスト社", siteUrl: "https://test.example.jp/" });
  await bulk({ ids: [c.id], action: "hide", reason: "other", note: "テスト" });
  const r = await bulk({ ids: [c.id], action: "delete" });
  assert.equal(r.body.deleted, 1, JSON.stringify(r.body));
});

await ok("送信完了：送信チャネルは必須。Instagram と送信元が残り、履歴は「Instagramから送信」", async () => {
  setup();
  const c = await newCompany();
  const p = await prepare({ companyId: c.id, channel: "instagram" });
  assert.equal(p.statusCode, 200);
  assert.equal(p.body.approach.channel, "instagram");
  assert.equal((await act({ id: p.body.approach.id, action: "sent", body: "営業文" })).statusCode, 400, "チャネルなしは 400");
  assert.equal((await act({ id: p.body.approach.id, action: "sent", channel: "fax", body: "営業文" })).statusCode, 400);
  const s = await act({ id: p.body.approach.id, action: "sent", channel: "instagram", sendFrom: "@eight_xxx", body: "営業文" });
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  assert.equal(s.body.approach.channel, "instagram");
  assert.equal(s.body.approach.sendFrom, "@eight_xxx");
  const row = db.rows.gw_sales_approaches[0];
  assert.equal(row.form_url, null, "フォーム以外で送ったらフォームURLは残さない");
  const d = await getOne(c.id);
  const t = d.body.timeline.find((x) => x.kind === "attack");
  assert.equal(t.label, "Instagramから送信");
  assert.match(t.detail, /@eight_xxx/);
  assert.equal(d.body.contactStatus.firstChannelLabel, "Instagram");
  assert.ok(d.body.contactStatus.lastContactAt, "送信も最終連絡に数える");
  const l = (await list()).body.companies[0];
  assert.equal(l.lastChannel, "instagram");
  assert.equal(l.attackCount, 1);
});

await ok("複数チャネル：同じチャネルは30日以内なら止める。別チャネルは直近の接触を見せ、「別チャネルで送る」を選べば送れる", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id, { channel: "instagram" });
  db.rows.gw_sales_approaches[0].sent_at = new Date(Date.now() - 3 * 86400000).toISOString();
  who = SALES2;
  const same = await prepare({ companyId: c.id, channel: "instagram" });
  assert.equal(same.statusCode, 409);
  assert.equal(same.body.error, "recent_attack");
  assert.equal(same.body.recent.channel, "instagram");
  assert.match(same.body.hint, /Instagram/);
  // 同じチャネルは、「別チャネルで送る」を選んでも通さない（押し切りは管理者の force だけ）
  assert.equal((await prepare({ companyId: c.id, channel: "instagram", acknowledgeRecent: true })).statusCode, 409);

  // 別チャネル：無警告にはしない。会社単位の直近接触を返して止める
  const x0 = await prepare({ companyId: c.id, channel: "x" });
  assert.equal(x0.statusCode, 409);
  assert.equal(x0.body.error, "recent_other_channel");
  assert.equal(x0.body.hint, "3日前にInstagramから送信済みです");
  assert.equal(x0.body.recent.employeeName, "営業 一郎");
  assert.equal(db.rows.gw_sales_approaches.length, 1, "確認するまで専用URLも発行しない");

  const x = await prepare({ companyId: c.id, channel: "x", acknowledgeRecent: true });
  assert.equal(x.statusCode, 200, JSON.stringify(x.body));
  // 送信完了の時点でもサーバが確かめ直す：確認なし → 409、同じチャネルへすり替え → 409
  assert.equal((await act({ id: x.body.approach.id, action: "sent", channel: "x", body: "営業文" })).statusCode, 409);
  const sneaky = await act({ id: x.body.approach.id, action: "sent", channel: "instagram", body: "営業文", acknowledgeRecent: true });
  assert.equal(sneaky.statusCode, 409);
  assert.equal(sneaky.body.error, "recent_attack");
  const ok2 = await act({ id: x.body.approach.id, action: "sent", channel: "x", body: "営業文", acknowledgeRecent: true });
  assert.equal(ok2.statusCode, 200);
  const labels = (await getOne(c.id)).body.timeline.filter((t) => t.kind === "attack").map((t) => t.label);
  assert.deepEqual(labels, ["Instagramから送信", "Xから送信"]);
});

await ok("別チャネルの確認：管理者の押し切り（force）でも通る。31日前なら確認なしで送れる", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id, { channel: "instagram" });
  who = ADMIN;
  assert.equal((await prepare({ companyId: c.id, channel: "x", force: true })).statusCode, 200);
  ageApproaches(31);
  who = SALES;
  assert.equal((await prepare({ companyId: c.id, channel: "email" })).statusCode, 200);
});

await ok("送信できなかった：理由は必須・「その他」はメモ必須。ステータスは動かず、NEXTは別チャネル検討", async () => {
  setup();
  const c = await newCompany();
  const p = await prepare({ companyId: c.id });
  const id = p.body.approach.id;
  assert.equal((await act({ id, action: "failed" })).statusCode, 400, "理由なしは 400");
  assert.equal((await act({ id, action: "failed", reason: "other" })).statusCode, 400, "その他はメモ必須");
  const r = await act({ id, action: "failed", reason: "no_form" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.approach.failedLabel, "問い合わせフォームがない");
  const row = db.rows.gw_sales_approaches.find((a) => a.id === id);
  assert.ok(row.failed_at);
  assert.equal(row.sent_at, null, "送ってはいないので sent_at は立てない");
  const co = db.rows.gw_sales_companies.find((x) => x.id === c.id);
  assert.equal(co.status, "untouched", "アタック済にはしない");
  assert.equal(co.next_action, "別チャネルで再アタックを検討");
  assert.ok(co.next_action_on);
  assert.ok(logged.some((l) => l.action === "sales.attack_failed" && l.detail.reason === "no_form"));

  const d = await getOne(c.id);
  assert.ok(d.body.timeline.some((t) => t.kind === "attack_failed" && t.label === "送信できず：問い合わせフォームがない"));
  assert.equal(d.body.failedApproaches.length, 1);
  assert.equal((await list()).body.companies[0].attackCount, 0, "アタック数には数えない");

  // 二重の記録・送信完了・取り消しはできない
  assert.equal((await act({ id, action: "failed", reason: "no_form" })).statusCode, 409);
  assert.equal((await act({ id, action: "sent", channel: "form", body: "営業文" })).statusCode, 409);
  assert.equal((await act({ id, action: "discard" })).statusCode, 409);

  // すぐ別チャネルで再アタックできる（送れなかった専用URLは使い回さない）
  const again = await prepare({ companyId: c.id, channel: "email" });
  assert.equal(again.statusCode, 200);
  assert.notEqual(again.body.approach.id, id);
  // 同じチャネル（フォーム）でも、送れていないので30日の警告には掛からない
  assert.equal((await prepare({ companyId: c.id })).statusCode, 200);
});

await ok("送信できなかった：クリックされたアタックは「送れなかった」にしない", async () => {
  setup();
  const c = await newCompany();
  const p = await prepare({ companyId: c.id });
  await click(p.body.trackingUrl.split("/r/")[1]);
  const r = await act({ id: p.body.approach.id, action: "failed", reason: "form_error" });
  assert.equal(r.statusCode, 409);
});

const contact = (body) => call(detail, { method: "POST", url: "/api/sales/companies/detail", body: { action: "contact", ...body } });

await ok("返信・やり取り：Instagramで返信 → メールへ。返信元・連絡手段・連絡先・メモ・NEXT が残る", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id, { channel: "instagram" });
  assert.equal((await contact({ id: c.id, replied: true })).statusCode, 400, "返信元なしは 400");
  assert.equal((await contact({ id: c.id, replied: true, replyChannel: "fax" })).statusCode, 400);
  assert.equal((await contact({ id: c.id, replied: true, replyChannel: "instagram", contacts: { email: "tanaka" } })).statusCode, 400, "メールの形");
  const r = await contact({
    id: c.id, replied: true, replyChannel: "instagram", contactChannel: "email",
    contacts: { email: "tanaka@example.co.jp", instagram: "@tanaka" },
    note: "担当の田中様よりInstagramで返信。詳細資料はメールで送付。",
    nextAction: "資料送付", nextActionOn: "2026-10-01",
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.company.status, "replied", "返信なので返信ありへ進む");
  assert.equal(r.body.company.contactChannel, "email");
  assert.equal(r.body.company.contactValue, "tanaka@example.co.jp");
  assert.equal(r.body.company.contacts.instagram, "@tanaka");
  assert.equal(r.body.company.nextAction, "資料送付");
  assert.equal(r.body.company.nextActionOn, "2026-10-01");

  const ev = db.rows.gw_sales_events.filter((e) => e.company_id === c.id);
  assert.deepEqual(ev.map((e) => e.label), ["先方返信：Instagram", "連絡手段：メール"]);
  assert.equal(ev[0].channel, "instagram");
  assert.match(ev[0].detail, /田中様/);
  assert.equal(ev[1].channel, "email");

  const d = await getOne(c.id);
  assert.deepEqual(
    { first: d.body.contactStatus.firstChannelLabel, reply: d.body.contactStatus.replyChannelLabel,
      now: d.body.contactStatus.currentChannelLabel, value: d.body.contactStatus.currentValue },
    { first: "Instagram", reply: "Instagram", now: "メール", value: "tanaka@example.co.jp" });
  const labels = d.body.timeline.filter((t) => !t.planned).map((t) => t.label);
  assert.deepEqual(labels, ["Instagramから送信", "先方返信：Instagram", "連絡手段：メール"]);
  assert.equal((await list()).body.companies[0].contactChannelLabel, "メール", "一覧の「連絡手段」");
  assert.ok(logged.some((l) => l.action === "sales.contact_add" && l.detail.switched));
});

await ok("返信・やり取り：連絡手段を変えただけではステータスは動かない。何も無ければ 400", async () => {
  setup();
  const c = await newCompany();
  await patchCo({ id: c.id, status: "meeting" });
  const r = await contact({ id: c.id, replied: false, contactChannel: "email", contacts: { email: "a@example.jp" } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const r2 = await contact({ id: c.id, replied: false, contactChannel: "line", contacts: { line: "田中" }, note: "LINEへ" });
  assert.equal(r2.body.company.status, "meeting", "商談のまま");
  assert.equal(r2.body.company.contactChannel, "line");
  assert.equal(r2.body.company.contactValue, "田中");
  assert.equal(r2.body.company.contacts.email, "a@example.jp", "他の連絡先は消さない");
  assert.ok(db.rows.gw_sales_events.some((e) => e.label === "連絡手段をLINEへ切替" && e.detail === "LINEへ"));
  assert.equal((await contact({ id: c.id, replied: false })).statusCode, 400);
  assert.equal((await contact({ id: c.id, replied: false, replyChannel: "email", note: "x" })).statusCode, 400,
    "返信元は返信のときだけ");
  // 空欄にした連絡先は消える
  const r3 = await contact({ id: c.id, replied: false, contacts: { email: null } });
  assert.equal(r3.body.company.contacts.email, undefined);
});

await ok("返信・やり取り：NEXTを決めなければ、返信は「返信対応」（当日〜）", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  const r = await contact({ id: c.id, replied: true, replyChannel: "form" });
  assert.equal(r.body.company.nextAction, "返信対応");
  assert.ok(r.body.company.nextActionOn >= todayJst());
  const ev = db.rows.gw_sales_events.find((e) => e.company_id === c.id);
  assert.equal(ev.label, "先方返信：お問い合わせフォーム経由");
});

console.log("\n=== 企業一覧：サーバー側ページング・絞り込み・並べ替え（db/097） ===\n");

const pageOf = (params) => call(companies, { method: "GET", url: `/api/sales/companies?${new URLSearchParams(params)}` });
const exportGet = (params) => call(exportApi, { method: "GET", url: `/api/sales/companies/export?${new URLSearchParams(params)}` });
const exportPost = (body) => call(exportApi, { method: "POST", url: "/api/sales/companies/export", body });
async function seed(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({ name: `会社${String(i).padStart(3, "0")}`, siteUrl: `https://c${i}.example.jp/`,
      industry: ["士業", "製造", "医療"][i % 3], region: ["東京都", "大阪府"][i % 2], service: "AI / DX" });
  }
  const r = await create({ companies: rows });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  // 登録日時をずらす（既定の並び＝登録の新しい順を確かめるため）
  db.rows.gw_sales_companies.forEach((c, i) => { c.created_at = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(); });
}

await ok("ページング：1ページ100社。2・3ページ目は残り。重複・欠落なし。total・totalPages が正しい", async () => {
  setup();
  await seed(205);
  const p1 = await pageOf({ page: 1 });
  assert.equal(p1.statusCode, 200, JSON.stringify(p1.body));
  assert.equal(p1.body.companies.length, 100);
  assert.equal(p1.body.total, 205);
  assert.equal(p1.body.totalPages, 3);
  assert.equal(p1.body.limit, 100);
  const p2 = await pageOf({ page: 2 });
  const p3 = await pageOf({ page: 3 });
  assert.equal(p2.body.companies.length, 100);
  assert.equal(p3.body.companies.length, 5);
  const ids = [...p1.body.companies, ...p2.body.companies, ...p3.body.companies].map((c) => c.id);
  assert.equal(new Set(ids).size, 205, "ページ間で重複・欠落しない");
  // 既定は登録の新しい順
  assert.equal(p1.body.companies[0].name, "会社205");
  // limit は100より大きくできない
  assert.equal((await pageOf({ page: 1, limit: 500 })).body.companies.length, 100);
  // 範囲外のページは最後のページを返す
  const p9 = await pageOf({ page: 9 });
  assert.equal(p9.body.page, 3);
  assert.equal(p9.body.companies.length, 5);
});

await ok("ページング：DBから100社だけ取り、関連データ（アタック・面談）もその100社ぶんだけ取る", async () => {
  setup();
  await seed(150);
  qlog.length = 0;
  await pageOf({ page: 1 });
  const co = qlog.filter((q) => q.name === "gw_sales_companies");
  assert.ok(co.length && co.every((q) => q.range && q.range[1] - q.range[0] + 1 <= 100), "企業は range で100件に切っている");
  for (const t of ["gw_sales_approaches", "gw_sales_meetings"]) {
    const qs = qlog.filter((q) => q.name === t);
    assert.ok(qs.length, `${t} を取っている`);
    for (const q of qs) {
      const inIds = q.f.find(([op, k]) => op === "in" && k === "company_id");
      assert.ok(inIds && inIds[2].length <= 100, `${t} は company_id in (最大100社) でしか取らない`);
    }
  }
  const body = (await pageOf({ page: 1 })).body.companies[0];
  for (const k of ["note", "contacts", "address", "phone"]) assert.ok(!(k in body), `一覧に ${k} を返さない（詳細で取る）`);
});

await ok("絞り込み：業種・地域・検索・担当・連絡手段。total は絞り込み後の件数", async () => {
  setup();
  await seed(30);
  const it = await pageOf({ page: 1, industry: "士業" });
  assert.equal(it.body.total, 10);
  assert.ok(it.body.companies.every((c) => c.industry === "士業"));
  const both = await pageOf({ page: 1, industry: "士業", region: "東京都" });
  assert.equal(both.body.total, 5);
  assert.ok(both.body.companies.every((c) => c.industry === "士業" && c.region === "東京都"));
  assert.equal((await pageOf({ page: 1, q: "会社02" })).body.total, 10, "企業名で検索（会社020〜029）");
  assert.equal((await pageOf({ page: 1, q: "c7.example" })).body.total, 1, "ドメインでも探せる");
  assert.equal((await pageOf({ page: 1, q: "%,()" })).body.total, 30, "or() を壊す記号は外す");
  assert.equal((await pageOf({ page: 1, owner: "me" })).body.total, 30);
  assert.equal((await pageOf({ page: 1, owner: "none" })).body.total, 0);
  db.rows.gw_sales_companies[0].current_contact_channel = "email";
  assert.equal((await pageOf({ page: 1, channel: "email" })).body.total, 1);
  assert.equal((await pageOf({ page: 1, channel: "none" })).body.total, 29);
  await bulk({ ids: [db.rows.gw_sales_companies[1].id], action: "hide", reason: "closed" });
  assert.equal((await pageOf({ page: 1 })).body.total, 29, "既定は表示中だけ");
  assert.equal((await pageOf({ page: 1, visibility: "hidden" })).body.total, 1);
  assert.equal((await pageOf({ page: 1, visibility: "all" })).body.total, 30);
  assert.equal((await pageOf({ page: 1, status: "nope" })).statusCode, 400);
  assert.equal((await pageOf({ page: 1, sort: "drop table" })).statusCode, 400);
});

await ok("並べ替え：企業名・業種・地域はDB全体で並べ、2ページ目でも条件を保つ", async () => {
  setup();
  await seed(150);
  const a1 = (await pageOf({ page: 1, sort: "name", order: "asc" })).body.companies;
  const a2 = (await pageOf({ page: 2, sort: "name", order: "asc" })).body.companies;
  assert.equal(a1[0].name, "会社001");
  assert.equal(a1[99].name, "会社100");
  assert.equal(a2[0].name, "会社101", "2ページ目は続きから（DB全体の順）");
  const d1 = (await pageOf({ page: 1, sort: "name", order: "desc" })).body.companies;
  assert.equal(d1[0].name, "会社150");
  const ind = [...(await pageOf({ page: 1, sort: "industry", order: "asc" })).body.companies,
    ...(await pageOf({ page: 2, sort: "industry", order: "asc" })).body.companies];
  assert.deepEqual([...new Set(ind.map((c) => c.industry))], ["医療", "士業", "製造"]);
  assert.equal(new Set(ind.map((c) => c.id)).size, 150, "同じ値が続いても id で順番を固定するので、ページ間で重複しない");
  const reg = (await pageOf({ page: 1, sort: "region", order: "desc" })).body.companies;
  assert.equal(reg[0].region, "東京都");
});

await ok("並べ替え：最終アタックの新しい順（未アタックは最後）・クリック数の多い順", async () => {
  setup();
  await seed(5);
  const [c1, c2, c3] = db.rows.gw_sales_companies;
  await sendAttack(c1.id);
  const { url } = await sendAttack(c2.id);
  db.rows.gw_sales_approaches.find((a) => a.company_id === c1.id).sent_at = new Date(Date.now() - 86400000).toISOString();
  rollup(c1.id);
  await click(url.split("/r/")[1]);
  await click(url.split("/r/")[1], { ip: "203.0.113.9", ua: `${HUMAN} x` });
  const last = (await pageOf({ page: 1, sort: "last_sent", order: "desc" })).body.companies;
  assert.deepEqual(last.slice(0, 2).map((c) => c.id), [c2.id, c1.id]);
  assert.ok(last.slice(2).every((c) => !c.lastSentAt), "未アタックは最後");
  const clicks = (await pageOf({ page: 1, sort: "clicks", order: "desc" })).body.companies;
  assert.equal(clicks[0].id, c2.id);
  assert.equal(clicks[0].clickCount, db.rows.gw_sales_companies.find((c) => c.id === c2.id).click_count);
  assert.ok(clicks[0].clickCount >= 1, "クリックがトリガー（の写し）で会社に反映されている");
  assert.equal(clicks[0].lastAttackerName, "営業 一郎");
  void c3;
});

await ok("並べ替え：担当は表示している担当者名の順（DB全体で。未定は最後）", async () => {
  setup();
  db.rows.gw_employees.push({ id: "emp-z1", tenant_id: "t1", display_name: "青木 花", status: "active" });
  await seed(150);
  // 担当を3人＋未定に振り分ける（ID の順と名前の順が逆になるように）
  const owners = ["emp-s2", "emp-z1", "emp-s1", null];
  db.rows.gw_sales_companies.forEach((c, i) => { c.owner_id = owners[i % 4]; });
  const all = [];
  for (let p = 1; p <= 2; p++) all.push(...(await pageOf({ page: p, sort: "owner", order: "asc" })).body.companies);
  assert.equal(all.length, 150);
  assert.equal(new Set(all.map((c) => c.id)).size, 150, "ページ間で重複・欠落しない");
  const names = all.map((c) => c.ownerName);
  const expected = [...names].sort((a, b) => (a === null) - (b === null) || (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(names, expected, "担当者名の順（未定は最後）");
  assert.equal(names[0], "営業 一郎");
  assert.equal(names.at(-1), null);
  assert.ok(qlog.some((q) => q.name === "gw_sales_company_list"), "担当者名つきの view から並べて取る");
  const desc = (await pageOf({ page: 1, sort: "owner", order: "desc" })).body.companies;
  assert.equal(desc[0].ownerName, "青木 花");
  // ほかの並べ替えは表から（098 が無くても動く）
  qlog.length = 0;
  await pageOf({ page: 1, sort: "name" });
  assert.ok(!qlog.some((q) => q.name === "gw_sales_company_list"));
});

await ok("並べ替え：NEXT は画面の実効NEXTの順。未対応クリック（要フォロー）が先頭、期限の近い順、やること無しは最後", async () => {
  setup();
  await seed(8);
  const cs = db.rows.gw_sales_companies;
  const ymd = (d) => new Date(Date.now() + 9 * 3600000 + d * 86400000).toISOString().slice(0, 10);
  // 0: 期限なしのNEXT / 1: 期限3日後 / 2: 期限昨日（超過）/ 3: 未アタック（フォームアタック）
  cs[0].next_action = "電話";
  cs[1].next_action = "フォロー"; cs[1].next_action_on = ymd(3);
  cs[2].next_action = "資料送付"; cs[2].next_action_on = ymd(-1);
  // 4: 成約（やること無し）/ 5: 営業禁止
  cs[4].status = "won"; cs[5].ng_reason = "no_sales";
  // 6・7: 未対応クリック（6 は期限を5日後に手で決めていても、クリックが先）
  cs[6].next_action = "フォロー"; cs[6].next_action_on = ymd(5);
  await sendAttack(cs[6].id);
  const { url } = await sendAttack(cs[7].id);
  await click(db.rows.gw_sales_approaches.find((a) => a.company_id === cs[6].id).tracking_token);
  await click(url.split("/r/")[1]);
  // 7 は「クリックに対応した」ので未対応ではなくなる
  await patchCo({ id: cs[7].id, action: "followed" });
  const list = (await pageOf({ page: 1, sort: "next", order: "asc" })).body.companies;
  const pos = (i) => list.findIndex((c) => c.id === cs[i].id);
  assert.equal(list[0].id, cs[6].id, "未対応クリック（クリックあり・要フォロー）が先頭");
  assert.equal(list[0].next, "クリックあり・要フォロー");
  assert.ok(pos(2) < pos(1), "期限の近い（超過した）NEXT が先");
  assert.ok(pos(1) < pos(0), "期限のある NEXT が期限なしより先");
  assert.ok(pos(0) < pos(3), "決めた NEXT がフォームアタック待ちより先");
  assert.ok(pos(4) > pos(3) && pos(5) > pos(3), "成約・営業禁止（やること無し）は最後");
  // 画面の NEXT と並びが食い違わない（先頭の要フォローは、画面でも要フォロー）
  assert.equal(list.filter((c) => c.nextKey === "follow_click").length, 1);
  const desc = (await pageOf({ page: 1, sort: "next", order: "desc" })).body.companies;
  assert.ok([cs[4].id, cs[5].id].includes(desc[0].id), "降順は逆（やること無しが先）");
});

await ok("絞り込みの候補（facets=1）：業種・地域・商材を件数つきで返す。マスターも返す", async () => {
  setup();
  await seed(6);
  const r = await pageOf({ page: 1, facets: 1 });
  const byValue = (xs) => Object.fromEntries(xs.map((x) => [x.value, x.n]));
  assert.deepEqual(byValue(r.body.facets.industry), { 士業: 2, 医療: 2, 製造: 2 });
  assert.deepEqual(byValue(r.body.facets.region), { 大阪府: 3, 東京都: 3 });
  assert.equal(r.body.facets.dynamic, true);
  assert.equal(r.body.facets.total, 6);
  assert.equal((await pageOf({ page: 1 })).body.facets, undefined, "頼んだときだけ");
  assert.deepEqual(r.body.masters.industries, ["製造", "不動産", "士業", "医療", "小売", "その他"]);
  assert.equal(r.body.masters.prefectures.length, 47);
  assert.ok(r.body.masters.services.includes("AI / DX"));
  assert.deepEqual(r.body.csvColumns.map((c) => c.label),
    ["企業名", "企業サイトURL", "問い合わせフォームURL", "業種", "都道府県", "所在地", "提案サービス", "電話番号", "メールアドレス", "企業規模", "メモ"]);
});

// 要件 2〜6・11・13：地域は都道府県にまとめる／件数はいまの条件に連動／並べ替えでは変わらない／総件数・ページャーと一致
await ok("件数の連動：業種を変えると鹿児島県の件数も変わる。昔の「鹿児島県鹿屋市」は鹿児島県に数える", async () => {
  setup();
  // 鹿児島県：製造4（うち2社は昔の「鹿児島県鹿屋市」「鹿児島県 霧島市」）・医療3 ／ 東京都：製造2
  const rows = [];
  for (let i = 1; i <= 9; i++) {
    rows.push({ name: `鹿${i}`, siteUrl: `https://k${i}.example.jp/`, industry: i <= 6 ? "製造" : "医療",
      region: i <= 4 ? "鹿児島県" : i <= 6 ? "東京都" : "鹿児島県", service: "AI / DX" });
  }
  assert.equal((await create({ companies: rows })).statusCode, 200);
  // 昔のデータ（API を通さずに入った市区町村つき）
  const cs = db.rows.gw_sales_companies;
  cs[0].region = "鹿児島県鹿屋市";
  cs[1].region = "鹿児島県霧島市";
  const f0 = (await pageOf({ page: 1, facets: 1 })).body;
  const n = (xs, v) => xs.find((x) => x.value === v)?.n ?? 0;
  assert.equal(n(f0.facets.region, "鹿児島県"), 7, "鹿児島県鹿屋市・霧島市も鹿児島県に合算");
  assert.ok(!f0.facets.region.some((x) => x.value.includes("市")), "市区町村は候補に出ない");
  const kago = (await pageOf({ page: 1, facets: 1, region: "鹿児島県" })).body;
  assert.equal(kago.total, 7, "鹿児島県で絞ると、昔の市区町村つきも入る");
  assert.ok(kago.companies.every((c) => c.region === "鹿児島県"), "一覧の地域は都道府県だけ表示");
  assert.equal(kago.facets.total, kago.total, "件数の総数と一覧の総件数が一致");
  assert.equal(n(kago.facets.region, "鹿児島県"), 7, "地域の件数は地域以外の条件で数える（選んだ地域の数が0にならない）");

  const mfg = (await pageOf({ page: 1, facets: 1, industry: "製造" })).body;
  assert.equal(n(mfg.facets.region, "鹿児島県"), 4, "業種＝製造にすると鹿児島県は4");
  assert.equal(n(mfg.facets.region, "東京都"), 2);
  assert.equal(n(mfg.facets.industry, "医療"), 3, "業種自身の件数は業種以外の条件で（切り替え先の件数が見える）");
  assert.equal(mfg.facets.total, mfg.total);
  assert.equal(mfg.total, 6);

  const both = (await pageOf({ page: 1, facets: 1, industry: "製造", region: "鹿児島県" })).body;
  assert.equal(both.total, 4);
  assert.equal(both.facets.total, 4);
  assert.equal(n(both.facets.industry, "医療"), 3, "鹿児島県の中の医療");

  const q = (await pageOf({ page: 1, facets: 1, q: "鹿1" })).body;
  assert.equal(q.total, 1, "検索語も件数に効く");
  assert.equal(n(q.facets.region, "鹿児島県"), 1);

  // 担当・連絡手段・アタック・クリック・状態も、ほかの条件に連動
  cs[2].owner_id = null;
  cs[3].current_contact_channel = "email";
  const own = (await pageOf({ page: 1, facets: 1, industry: "医療" })).body.facets;
  assert.equal(n(own.owner, "emp-s1"), 3);
  assert.equal(n(own.channel, "none"), 3);
  assert.equal(n(own.attacked, "no"), 3);
  assert.equal(n(own.clicked, "no"), 3);
  assert.equal(n(own.status, "untouched"), 3);
  const me = (await pageOf({ page: 1, facets: 1, owner: "me" })).body;
  assert.equal(me.total, 8);
  assert.equal(me.facets.total, 8);
  assert.equal(rpcCalls.at(-1).args.p_owner, "emp-s1", "「自分」は社員IDで数える");
  assert.equal(rpcCalls.at(-1).args.p_tenant, "t1");
});

await ok("件数の連動：並べ替えでは件数が変わらない。100社を超えてもページングはサーバー側のまま", async () => {
  setup();
  await seed(250);
  const a = (await pageOf({ page: 1, facets: 1, industry: "製造" })).body;
  const b = (await pageOf({ page: 2, facets: 1, industry: "製造", sort: "name", order: "desc" })).body;
  assert.deepEqual(b.facets, a.facets, "並べ替え・ページ送りで件数は同じ");
  assert.equal(a.total, 84);
  assert.equal(a.facets.total, 84, "件数の総数＝一覧の総件数（ページャー）");
  assert.equal(a.companies.length, 84);
  const all = (await pageOf({ page: 1, facets: 1 })).body;
  assert.equal(all.companies.length, 100, "1ページ100社");
  assert.equal(all.totalPages, 3);
  assert.equal(all.facets.total, 250);
  const co = qlog.filter((x) => x.name === "gw_sales_companies" && x.range);
  assert.ok(co.every((x) => x.range[1] - x.range[0] + 1 <= 100), "企業は100件ずつしか取らない");
  assert.ok(!rpcCalls.some((c) => "p_sort" in c.args || "p_order" in c.args), "件数に並べ替えを渡さない");
});

await ok("件数：101 が未実行でも一覧は動く（以前の件数。地域は都道府県にまとめる）", async () => {
  setup();
  await seed(6);
  db.rows.gw_sales_companies[0].region = "大阪府大阪市";
  rpcMissing = true;
  const r = await pageOf({ page: 1, facets: 1 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.facets.dynamic, false);
  assert.deepEqual(Object.fromEntries(r.body.facets.region.map((x) => [x.value, x.n])), { 大阪府: 3, 東京都: 3 });
  assert.equal(r.body.total, 6);
});

console.log("\n=== 共通マスター・都道府県・CSV取込（/api/sales/companies/import） ===\n");

const csvImport = (body) => call(importApi, { method: "POST", url: "/api/sales/companies/import", body });

await ok("マスター：企業追加で「鹿児島県」を選んで登録できる。業種・提案サービス・地域はマスターの値だけ", async () => {
  setup();
  const a = await create({ name: "鹿児島の会社", siteUrl: "https://kago.example.jp", industry: "製造", region: "鹿児島県", service: "AI / DX" });
  assert.equal(a.statusCode, 200, JSON.stringify(a.body));
  assert.equal(db.rows.gw_sales_companies[0].region, "鹿児島県");
  const l = (await pageOf({ page: 1, facets: 1 })).body;
  assert.deepEqual(l.facets.region, [{ value: "鹿児島県", n: 1 }], "一覧の地域の候補に鹿児島県が出る");
  const bad = async (body, code) => {
    const r = await create({ name: "x", ...body });
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(r.body.error, code);
  };
  await bad({ industry: "IT" }, "bad_industry");
  await bad({ service: "なんでも" }, "bad_service");
  await bad({ region: "鹿屋市" }, "bad_region");
  await bad({ region: "日本" }, "bad_region");
  assert.equal(db.rows.gw_sales_companies.length, 1, "エラーの会社は入らない");
});

await ok("マスター：「鹿児島県鹿屋市」は鹿児島県にする（所在地が空なら元の文字列を所在地へ）。「東京」「大阪市北区」も都道府県に", async () => {
  setup();
  const cases = [
    ["鹿児島県鹿屋市", "鹿児島県", "鹿児島県鹿屋市"], ["東京都渋谷区", "東京都", "東京都渋谷区"], ["北海道札幌市", "北海道", "北海道札幌市"],
    ["京都府京都市", "京都府", "京都府京都市"], ["大阪府大阪市", "大阪府", "大阪府大阪市"], ["鹿児島", "鹿児島県", null], ["東京", "東京都", null],
  ];
  for (const [i, [input, pref, addr]] of cases.entries()) {
    const r = await create({ name: `会社${i}`, region: input });
    assert.equal(r.statusCode, 200, input);
    const c = db.rows.gw_sales_companies.at(-1);
    assert.equal(c.region, pref, input);
    assert.equal(c.address ?? null, addr, input);
  }
  // 所在地を入れていれば所在地は変えない
  await create({ name: "所在地あり", region: "鹿児島県鹿屋市", address: "鹿児島県鹿屋市○○1-2-3" });
  assert.equal(db.rows.gw_sales_companies.at(-1).address, "鹿児島県鹿屋市○○1-2-3");
});

await ok("マスター：編集。昔の値（マスター外・市区町村つき）はそのままなら保存できる。新しくマスター外にはできない", async () => {
  setup();
  const c = await newCompany();
  const row = db.rows.gw_sales_companies.find((x) => x.id === c.id);
  row.industry = "IT"; row.region = "鹿児島県鹿屋市"; row.service = "旧商材";
  const same = await patchCo({ id: c.id, name: "名前だけ変更", industry: "IT", region: "鹿児島県鹿屋市", service: "旧商材" });
  assert.equal(same.statusCode, 200, JSON.stringify(same.body));
  assert.equal(row.region, "鹿児島県鹿屋市", "DB を勝手に書き換えない");
  assert.equal((await patchCo({ id: c.id, industry: "小売業" })).body.error, "bad_industry");
  assert.equal((await patchCo({ id: c.id, service: "新商材" })).body.error, "bad_service");
  assert.equal((await patchCo({ id: c.id, region: "どこか" })).body.error, "bad_region");
  const fix = await patchCo({ id: c.id, region: "鹿児島県" });
  assert.equal(fix.statusCode, 200);
  assert.equal(row.region, "鹿児島県");
  // 一覧の地域列は都道府県だけ
  row.region = "東京都渋谷区";
  assert.equal((await pageOf({ page: 1 })).body.companies[0].region, "東京都");
  // 一括の商材変更もマスターだけ
  assert.equal((await bulk({ ids: [c.id], action: "change_service", service: "新商材" })).body.error, "bad_service");
  assert.equal((await bulk({ ids: [c.id], action: "change_service", service: "PCレンタル" })).statusCode, 200);
});

const CSV_ROWS = [
  { row: 2, name: "株式会社A", siteUrl: "https://www.a.example.jp/", industry: "製造", region: "鹿児島県鹿屋市", service: "AI / DX" },
  { row: 3, name: "株式会社B", siteUrl: "http://b.example.jp", industry: "不動産", region: "東京都", service: "PCレンタル" },
  { row: 4, name: "株式会社C", siteUrl: "c.example.jp", industry: "未知の業種", region: "千葉県", service: "AI / DX" },
  { row: 5, name: "株式会社D", siteUrl: "https://d.example.jp", industry: "医療", region: "千葉", service: "謎の商材" },
  { row: 6, name: "株式会社A（重複）", siteUrl: "https://a.example.jp/contact", industry: "製造" },
  { row: 7, name: "", siteUrl: "https://e.example.jp" },
  { row: 8, name: "株式会社F", region: "どこか" },
  { row: 9, name: "株式会社G", siteUrl: "https://g.example.jp", region: "鹿児島県", address: "鹿児島県霧島市1-1", formUrl: "https://g.example.jp/form",
    phone: "099-000-0000", size: "10名", note: "メモ" },
];

await ok("CSV取込：確認（プレビュー）は DB に書かない。行ごとに 登録できる／重複／要修正 と理由", async () => {
  setup();
  await newCompany({ name: "既存B", siteUrl: "https://b.example.jp/" });
  const before = db.rows.gw_sales_companies.length;
  const r = await csvImport({ fileName: "list.csv", rows: CSV_ROWS, commit: false });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_sales_companies.length, before, "確認では登録しない");
  const st = Object.fromEntries(r.body.results.map((x) => [x.row, x.status]));
  assert.deepEqual(st, { 2: "ok", 3: "duplicate", 4: "error", 5: "error", 6: "duplicate", 7: "error", 8: "error", 9: "ok" });
  assert.deepEqual(r.body.counts, { read: 8, ok: 2, duplicate: 2, error: 4 });
  const by = Object.fromEntries(r.body.results.map((x) => [x.row, x]));
  assert.equal(by[2].region, "鹿児島県", "鹿児島県鹿屋市 → 鹿児島県");
  assert.equal(by[2].domain, "a.example.jp", "https://www. を外したドメイン");
  assert.match(by[3].reasons[0], /登録済みのためスキップ（既存B）/);
  assert.match(by[4].reasons[0], /業種「未知の業種」はマスターにありません/);
  assert.ok(by[5].reasons.some((x) => /提案サービス「謎の商材」/.test(x)), "商材の間違い");
  assert.equal(by[5].region, "千葉県", "「千葉」も千葉県にする");
  assert.match(by[6].reasons[0], /CSV内で重複（2行目と同じサイト）/);
  assert.match(by[7].reasons[0], /企業名がありません/);
  assert.match(by[8].reasons[0], /都道府県「どこか」を判定できません/);
  const log = logged.find((l) => l.action === "sales.company_csv_preview");
  assert.deepEqual(log.detail, { fileName: "list.csv", read: 8, ok: 2, duplicate: 2, error: 4 });
  assert.equal(log.actorId, "u-1", "実行者");
});

await ok("CSV取込：登録。担当は取り込んだ人、地域は都道府県、所在地は補完。監査ログに件数。もう一度送っても二重にならない", async () => {
  setup();
  await newCompany({ name: "既存B", siteUrl: "https://b.example.jp/" });
  const pre = (await csvImport({ fileName: "list.csv", rows: CSV_ROWS, commit: false })).body;
  const okRows = CSV_ROWS.filter((x) => pre.results.find((r) => r.row === x.row).status === "ok");
  const r = await csvImport({ fileName: "list.csv", rows: okRows, commit: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.counts, { read: 2, created: 2, duplicate: 0, error: 0 });
  const a = db.rows.gw_sales_companies.find((c) => c.domain === "a.example.jp");
  assert.equal(a.region, "鹿児島県");
  assert.equal(a.address, "鹿児島県鹿屋市", "所在地が空なら元の文字列を所在地へ");
  assert.equal(a.owner_id, "emp-s1", "担当は取り込んだ人");
  assert.equal(a.tenant_id, "t1");
  assert.equal(a.industry, "製造");
  const g = db.rows.gw_sales_companies.find((c) => c.domain === "g.example.jp");
  assert.equal(g.address, "鹿児島県霧島市1-1");
  assert.equal(g.form_url, "https://g.example.jp/form");
  assert.equal(g.phone, "099-000-0000");
  assert.equal(g.size, "10名");
  assert.equal(g.note, "メモ");
  const log = logged.find((l) => l.action === "sales.company_csv_import");
  assert.deepEqual(log.detail, { fileName: "list.csv", read: 2, created: 2, duplicate: 0, error: 0, firstRow: 2, lastRow: 9 });
  assert.equal(log.actorId, "u-1", "実行者");
  assert.ok(log.tenantId === "t1");
  // 同じ行をもう一度（別の人が同時に入れた・二度押し）→ 重複としてスキップ。上書きしない
  a.name = "手で直した名前";
  const again = await csvImport({ fileName: "list.csv", rows: okRows, commit: true });
  assert.deepEqual(again.body.counts, { read: 2, created: 0, duplicate: 2, error: 0 });
  assert.equal(a.name, "手で直した名前", "既存を上書きしない");
  assert.equal(db.rows.gw_sales_companies.length, 3);
});

await ok("CSV取込：登録後、一覧の件数と絞り込みの件数に反映される", async () => {
  setup();
  const before = (await pageOf({ page: 1, facets: 1, region: "鹿児島県" })).body;
  assert.equal(before.total, 0);
  await csvImport({ fileName: "k.csv", rows: CSV_ROWS.filter((x) => [2, 9].includes(x.row)), commit: true });
  const after = (await pageOf({ page: 1, facets: 1, region: "鹿児島県" })).body;
  assert.equal(after.total, 2);
  assert.equal(after.facets.total, 2);
  assert.equal(after.facets.region.find((x) => x.value === "鹿児島県").n, 2);
  assert.equal(after.facets.industry.find((x) => x.value === "製造").n, 1);
});

await ok("CSV取込：途中で失敗した行が分かる（まとめて入らなければ1行ずつ入れ直す）。エラー行は入らない", async () => {
  setup();
  const rows = [
    { row: 2, name: "良い会社1", siteUrl: "https://ok1.example.jp" },
    { row: 3, name: "壊れる会社", siteUrl: "https://bad.example.jp" },
    { row: 4, name: "良い会社2", siteUrl: "https://ok2.example.jp" },
    { row: 5, name: "同時に入った会社", siteUrl: "https://race.example.jp" },
  ];
  insertFail = (name, rs) => {
    if (name !== "gw_sales_companies") return null;
    if (rs.some((x) => x.domain === "bad.example.jp")) return { code: "23514", message: "check violation" };
    if (rs.some((x) => x.domain === "race.example.jp")) return { code: "23505", message: "duplicate key" };
    return null;
  };
  const r = await csvImport({ fileName: "p.csv", rows, commit: true });
  assert.equal(r.statusCode, 200);
  const st = Object.fromEntries(r.body.results.map((x) => [x.row, x.status]));
  assert.deepEqual(st, { 2: "created", 3: "error", 4: "created", 5: "duplicate" });
  assert.match(r.body.results[1].reasons[0], /登録できませんでした/);
  assert.deepEqual(r.body.counts, { read: 4, created: 2, duplicate: 1, error: 1 });
  assert.deepEqual(db.rows.gw_sales_companies.map((c) => c.domain).sort(), ["ok1.example.jp", "ok2.example.jp"]);
  const log = logged.find((l) => l.action === "sales.company_csv_import");
  assert.equal(log.detail.created, 2);
  assert.equal(log.detail.error, 1);
});

await ok("CSV取込：権限・件数の上限・空。別テナントの同じドメインは重複にしない", async () => {
  setup();
  db.rows.gw_sales_companies.push({ id: "00000000-0000-4000-8000-0000000000e1", tenant_id: "t2", name: "他テナント",
    domain: "a.example.jp", status: "untouched", click_count: 0 });
  const r = await csvImport({ fileName: "x.csv", rows: [CSV_ROWS[0]], commit: false });
  assert.equal(r.body.results[0].status, "ok", "他テナントの会社とは比べない");
  const many = Array.from({ length: 101 }, (_, i) => ({ row: i + 2, name: `会社${i}` }));
  assert.equal((await csvImport({ fileName: "x.csv", rows: many, commit: true })).statusCode, 400, "登録は1回100行まで");
  assert.equal((await csvImport({ fileName: "x.csv", rows: many, commit: false })).statusCode, 200, "確認は5,000行まで");
  const huge = Array.from({ length: 5001 }, (_, i) => ({ row: i + 2, name: `会社${i}` }));
  assert.equal((await csvImport({ fileName: "x.csv", rows: huge, commit: false })).statusCode, 400);
  assert.equal((await csvImport({ fileName: "x.csv", rows: [], commit: false })).statusCode, 400);
  assert.equal((await call(importApi, { method: "GET", url: "/api/sales/companies/import" })).statusCode, 405);
  who = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["staff"], employee: { id: "emp-x" } };
  assert.equal((await csvImport({ fileName: "x.csv", rows: [CSV_ROWS[0]], commit: true })).statusCode, 403);
  assert.equal(db.rows.gw_sales_companies.length, 1);
});

await ok("旧データ：マスター外の業種（イベント企画・制作・運営）は件数に出て絞り込める。新規・編集・CSVでは作れない", async () => {
  setup();
  const LEGACY = "イベント企画・制作・運営";
  await seed(3);
  const c = await newCompany({ name: "株式会社イベントワークス", siteUrl: "https://event-works.jp" });
  const row = db.rows.gw_sales_companies.find((x) => x.id === c.id);
  row.industry = LEGACY; row.region = "鹿児島県鹿屋市";   // 以前に自由入力で入ったデータ
  const all = (await pageOf({ page: 1, facets: 1 })).body;
  assert.ok(all.companies.some((x) => x.id === c.id && x.industry === LEGACY && x.region === "鹿児島県"), "一覧に出る（地域は都道府県）");
  assert.deepEqual(all.facets.industry.find((x) => x.value === LEGACY), { value: LEGACY, n: 1 }, "業種の件数に旧データも出る");
  assert.ok(!all.facets.region.some((x) => x.value.includes("鹿屋市")), "地域は都道府県だけ");
  const only = (await pageOf({ page: 1, facets: 1, industry: LEGACY })).body;
  assert.deepEqual(only.companies.map((x) => x.id), [c.id], "選ぶとその企業だけ");
  assert.equal(only.facets.total, 1);
  assert.equal((await create({ name: "新規", industry: LEGACY })).body.error, "bad_industry", "新規では作れない");
  const other = db.rows.gw_sales_companies.find((x) => x.id !== c.id);
  assert.equal((await patchCo({ id: other.id, industry: LEGACY })).body.error, "bad_industry", "別の会社を旧データに変えられない");
  const csv = await csvImport({ fileName: "x.csv", rows: [{ row: 2, name: "CSV社", industry: LEGACY }], commit: false });
  assert.equal(csv.body.results[0].status, "error", "CSVでも要修正");
});

console.log("\n=== 分類マスター（db/108）・複数メールアドレス・地域「未設定」・アタック画面の絞り込み ===\n");

const masterGet = () => call(mastersApi, { method: "GET", url: "/api/sales/masters" });
const masterAdd = (body) => call(mastersApi, { method: "POST", url: "/api/sales/masters", body });
const masterPatch = (body) => call(mastersApi, { method: "PATCH", url: "/api/sales/masters", body });

await ok("分類マスター：初回は既定値を入れる。追加・重複・名前変更（企業もそろう）・非表示（新規では選べない・旧データとして絞れる）・再表示", async () => {
  setup();
  db.rows.gw_sales_master_options = [];
  const g = await masterGet();
  assert.equal(g.statusCode, 200, JSON.stringify(g.body));
  assert.deepEqual(g.body.options.filter((o) => o.kind === "industry").map((o) => o.label), ["製造", "不動産", "士業", "医療", "小売", "その他"]);
  assert.equal(g.body.options.filter((o) => o.kind === "service").length, 7);
  assert.ok(db.rows.gw_sales_master_options.every((o) => o.tenant_id === "t1"));
  assert.equal((await masterGet()).body.options.length, 13, "2回目は増やさない");

  // 追加 → 企業追加で選べる
  const add = await masterAdd({ kind: "service", label: "  Web広告  " });
  assert.equal(add.statusCode, 200, JSON.stringify(add.body));
  assert.equal(add.body.option.label, "Web広告");
  assert.equal((await masterAdd({ kind: "service", label: "Web広告" })).statusCode, 409, "同じ名前は足せない");
  assert.equal((await masterAdd({ kind: "nope", label: "x" })).statusCode, 400);
  assert.equal((await masterAdd({ kind: "service", label: " " })).statusCode, 400);
  const c = await newCompany({ service: "Web広告", industry: "製造" });
  assert.equal(c.service, "Web広告");
  const list = (await pageOf({ page: 1, facets: 1 })).body;
  assert.ok(list.masters.services.includes("Web広告"), "一覧の選択肢にも出る");

  // 名前変更：その名前の企業もそろう
  const opt = db.rows.gw_sales_master_options.find((o) => o.label === "Web広告");
  const rn = await masterPatch({ id: opt.id, label: "Web広告運用" });
  assert.equal(rn.statusCode, 200, JSON.stringify(rn.body));
  assert.equal(rn.body.companies, 1);
  assert.equal(db.rows.gw_sales_companies.find((x) => x.id === c.id).service, "Web広告運用");
  const mfg = db.rows.gw_sales_master_options.find((o) => o.label === "製造");
  assert.equal((await masterPatch({ id: mfg.id, label: "不動産" })).statusCode, 409, "既にある名前には変えられない");
  assert.ok(logged.some((l) => l.action === "sales.master_rename" && l.detail.from === "Web広告" && l.detail.companies === 1));

  // 非表示：企業のデータは変えない。新規では選べない。一覧の絞り込みでは旧データとして出る
  assert.equal((await masterPatch({ id: mfg.id, archived: true })).statusCode, 200);
  assert.equal(db.rows.gw_sales_companies.find((x) => x.id === c.id).industry, "製造", "既存企業はそのまま");
  assert.equal((await create({ name: "新規", industry: "製造" })).body.error, "bad_industry", "非表示の値は新規で選べない");
  const after = (await pageOf({ page: 1, facets: 1 })).body;
  assert.ok(!after.masters.industries.includes("製造"), "表示中の選択肢から消える");
  assert.deepEqual(after.facets.industry.find((x) => x.value === "製造"), { value: "製造", n: 1 }, "件数には旧データとして出る");
  assert.equal((await pageOf({ page: 1, industry: "製造" })).body.total, 1, "旧データでも絞り込める");
  assert.equal((await patchCo({ id: c.id, industry: "製造", name: "名前だけ変更" })).statusCode, 200, "変えていなければ編集は通る");
  assert.equal((await masterAdd({ kind: "industry", label: "製造" })).body.hint, "「製造」は非表示にしてあります。再表示してください");
  assert.equal((await masterPatch({ id: mfg.id, archived: false })).statusCode, 200);
  assert.equal((await create({ name: "新規2", industry: "製造" })).statusCode, 200, "再表示で選べる");
  assert.equal((await masterGet()).body.options.find((o) => o.id === mfg.id).used, 2, "使っている企業数");

  // 営業でない人は触れない
  who = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["staff"], employee: { id: "emp-x" } };
  assert.equal((await masterGet()).statusCode, 403);
  assert.equal((await masterAdd({ kind: "industry", label: "x" })).statusCode, 403);
});

await ok("分類マスター：CSV取込・一括の提案サービス変更もテナントの選択肢でチェックする", async () => {
  setup();
  db.rows.gw_sales_master_options = [];
  await masterGet();
  await masterAdd({ kind: "industry", label: "イベント" });
  const svc = db.rows.gw_sales_master_options.find((o) => o.label === "ENGER");
  await masterPatch({ id: svc.id, archived: true });
  const r = await csvImport({ fileName: "m.csv", commit: false, rows: [
    { row: 2, name: "A", industry: "イベント" }, { row: 3, name: "B", service: "ENGER" }] });
  assert.deepEqual(r.body.results.map((x) => x.status), ["ok", "error"]);
  assert.match(r.body.results[1].reasons[0], /提案サービス「ENGER」はマスターにありません/);
  const c = await newCompany();
  assert.equal((await bulk({ ids: [c.id], action: "change_service", service: "ENGER" })).body.error, "bad_service");
});

await ok("メールアドレス：カンマ区切りで複数。前後空白・小文字・空・重複を整える。形式が違えば登録しない", async () => {
  setup();
  const r = await create({ name: "メール社", emails: " Info@Example.jp, sales@example.jp ,, info@example.jp，support@example.jp" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.company.emails, ["info@example.jp", "sales@example.jp", "support@example.jp"]);
  const row = db.rows.gw_sales_companies.at(-1);
  assert.deepEqual(row.emails, ["info@example.jp", "sales@example.jp", "support@example.jp"]);
  assert.equal(row.size, undefined, "企業規模に入れない");
  const bad = await create({ name: "x", emails: "info@example.jp, not-an-email, a@b" });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.error, "bad_email");
  assert.deepEqual(bad.body.invalid, ["not-an-email", "a@b"]);
  assert.equal(db.rows.gw_sales_companies.length, 1, "不正なら登録しない");
  // 編集：配列でも送れる。空にもできる。企業規模は残る
  row.size = "従業員50名";
  assert.equal((await patchCo({ id: row.id, emails: ["NEW@example.jp"] })).statusCode, 200);
  assert.deepEqual(row.emails, ["new@example.jp"]);
  assert.equal((await patchCo({ id: row.id, emails: "" })).statusCode, 200);
  assert.deepEqual(row.emails, []);
  assert.equal(row.size, "従業員50名", "既存の企業規模は消さない");
  assert.equal((await patchCo({ id: row.id, emails: Array.from({ length: 21 }, (_, i) => `u${i}@example.jp`) })).body.error, "bad_email");
  // 詳細で返す
  row.emails = ["a@example.jp", "b@example.jp"];
  assert.deepEqual((await getOne(row.id)).body.company.emails, ["a@example.jp", "b@example.jp"]);
  // CSV：同じ正規化・チェック
  const csv = await csvImport({ fileName: "e.csv", commit: true, rows: [
    { row: 2, name: "CSVメール社", siteUrl: "https://mail.example.jp", emails: "A@mail.example.jp,b@mail.example.jp" },
    { row: 3, name: "CSV不正", emails: "x@y" }] });
  assert.deepEqual(csv.body.results.map((x) => x.status), ["created", "error"]);
  assert.match(csv.body.results[1].reasons[0], /メールアドレスが正しくありません：x@y/);
  assert.deepEqual(db.rows.gw_sales_companies.find((x) => x.name === "CSVメール社").emails, ["a@mail.example.jp", "b@mail.example.jp"]);
});

await ok("地域「未設定」：null・空・都道府県で始まらない値を未設定にまとめる。47都道府県＋未設定＝総件数。未設定で絞れる", async () => {
  setup();
  await seed(6);
  const cs = db.rows.gw_sales_companies;
  cs[0].region = null; cs[1].region = ""; cs[2].region = "鹿屋市"; cs[3].region = "鹿児島県鹿屋市";
  const all = (await pageOf({ page: 1, facets: 1 })).body;
  const sum = all.facets.region.reduce((a, x) => a + x.n, 0);
  assert.equal(sum, all.total, "地域の件数の合計＝総件数");
  assert.deepEqual(all.facets.region.find((x) => x.value === "none"), { value: "none", n: 3 });
  assert.equal(all.facets.region.find((x) => x.value === "鹿児島県").n, 1);
  const none = (await pageOf({ page: 1, facets: 1, region: "none" })).body;
  assert.equal(none.total, 3, "未設定で絞れる（null・空・鹿屋市）");
  assert.deepEqual(none.companies.map((c) => c.region), [null, null, null], "一覧の地域は空（画面で「未設定」）");
  assert.equal(none.facets.total, 3);
  // 業種と組み合わせても合計が合う
  const ind = (await pageOf({ page: 1, facets: 1, industry: "製造" })).body;
  assert.equal(ind.facets.region.reduce((a, x) => a + x.n, 0), ind.total);
  // 101 の版の関数（none を返さない）でも、全件－都道府県で未設定を出す
  rpcNoNone = true;
  const old = (await pageOf({ page: 1, facets: 1 })).body;
  assert.deepEqual(old.facets.region.find((x) => x.value === "none"), { value: "none", n: 3 });
  rpcNoNone = false;
  assert.equal((await pageOf({ page: 1, region: "どこか" })).statusCode, 400);
  // 企業追加で地域を未設定にできる
  assert.equal((await create({ name: "地域なし", region: "" })).statusCode, 200);
  assert.equal(db.rows.gw_sales_companies.at(-1).region ?? null, null);
});

await ok("アタック画面（queue=attack）：営業禁止・30日以内・期限前・対象外の状態を除く。地域・NEXT・キャンペーン・自分＋担当なしで絞れる。100社超もページ送り", async () => {
  setup();
  db.rows.gw_sales_campaigns = [{ id: "00000000-0000-4000-8000-0000000000c1", tenant_id: "t1", name: "秋の製造業" }];
  await seed(130);
  const cs = db.rows.gw_sales_companies;
  const ymd = (d) => new Date(Date.now() + 9 * 3600000 + d * 86400000).toISOString().slice(0, 10);
  cs[0].ng_reason = "no_sales";                                               // 営業禁止
  cs[1].status = "won";                                                       // 対象外の状態
  cs[2].last_sent_at = new Date(Date.now() - 5 * 86400000).toISOString();    // 30日以内に送った
  cs[3].last_sent_at = new Date(Date.now() - 40 * 86400000).toISOString(); cs[3].status = "reattack_wait";  // 40日前 → 出す
  cs[4].next_action = "電話"; cs[4].next_action_on = ymd(3);                  // 期限がまだ先
  cs[5].next_action = "電話"; cs[5].next_action_on = ymd(-1);                 // 期限切れ → 出す（manual）
  cs[6].region = "鹿屋市";                                                    // 未設定
  cs[7].campaign_id = "00000000-0000-4000-8000-0000000000c1";
  cs[8].owner_id = "emp-s2";                                                  // 他の人の担当
  cs[9].owner_id = null;                                                      // 担当なし
  const q = (params) => pageOf({ page: 1, queue: "attack", ...params });
  const all = (await q({})).body;
  assert.equal(all.total, 126, "130社から 営業禁止・成約・30日以内・期限前 の4社を除く");
  assert.equal(all.companies.length, 100, "100社ずつ");
  assert.equal(all.totalPages, 2);
  const p2 = (await q({ page: 2 })).body;
  assert.equal(p2.companies.length, 26, "2ページ目で残りを見られる（「ほか」に隠さない）");
  const ids = new Set([...all.companies, ...p2.companies].map((c) => c.id));
  assert.equal(ids.size, 126);
  for (const i of [0, 1, 2, 4]) assert.ok(!ids.has(cs[i].id), `除外 ${i}`);
  for (const i of [3, 5]) assert.ok(ids.has(cs[i].id), `対象 ${i}`);
  assert.equal(all.facets, undefined, "件数（facets）はアタック画面の条件では数えない");

  assert.deepEqual((await q({ region: "none" })).body.companies.map((c) => c.id), [cs[6].id], "地域：未設定");
  const kc = (await q({ campaign: "00000000-0000-4000-8000-0000000000c1" })).body;
  assert.deepEqual(kc.companies.map((c) => c.id), [cs[7].id], "キャンペーンで絞る");
  assert.equal(kc.companies[0].campaignName, "秋の製造業", "キャンペーン名を返す");
  assert.equal((await q({ campaign: "none" })).body.total, 125);
  assert.deepEqual((await q({ next: "manual" })).body.companies.map((c) => c.id), [cs[5].id], "NEXT：決めたNEXT");
  assert.equal((await q({ next: "attack" })).body.total, 125, "NEXT：フォームアタック");
  const mine = (await q({ owner: "mine" })).body;
  assert.equal(mine.total, 125, "自分の担当＋担当なし（他の人の担当を除く）");
  assert.ok(mine.companies.every((c) => c.ownerId === "emp-s1" || c.ownerId === null));
  const combo = (await q({ owner: "mine", q: "会社01", region: "東京都" })).body;
  assert.ok(combo.total > 0 && combo.companies.every((c) => c.name.startsWith("会社01") && c.region === "東京都"),
    "検索語・自分＋担当なし・地域を同時に（and(or…)）");
  assert.ok(all.nextFilters.some((x) => x.key === "follow_click"), "NEXT の選択肢を返す");
  assert.ok(all.campaigns.some((x) => x.name === "秋の製造業"));
  // 企業一覧の NEXT の意味と同じ：一覧の nextKey と絞り込みが食い違わない
  for (const [key] of [["manual"], ["attack"]]) {
    const r = (await pageOf({ page: 1, next: key })).body;
    assert.ok(r.companies.every((c) => c.nextKey === key), `NEXT=${key} は一覧の nextKey と同じ`);
  }
  for (const bad of [{ queue: "x" }, { next: "x" }, { campaign: "x" }, { owner: "x" }]) {
    assert.equal((await pageOf({ page: 1, ...bad })).statusCode, 400, JSON.stringify(bad));
  }
});

await ok("企業一覧：キャンペーン列（名前）を返す", async () => {
  setup();
  db.rows.gw_sales_campaigns = [{ id: "00000000-0000-4000-8000-0000000000c2", tenant_id: "t1", name: "冬の不動産" }];
  await seed(2);
  db.rows.gw_sales_companies[0].campaign_id = "00000000-0000-4000-8000-0000000000c2";
  const r = (await pageOf({ page: 1 })).body.companies;
  assert.equal(r.find((c) => c.id === db.rows.gw_sales_companies[0].id).campaignName, "冬の不動産");
  assert.equal(r.find((c) => c.id === db.rows.gw_sales_companies[1].id).campaignName, null);
});

console.log("\n=== CSV（/api/sales/companies/export） ===\n");

const csvLines = (r) => String(r.body).replace(/^﻿/, "").split("\r\n").filter(Boolean);

await ok("CSV：いまの検索・絞り込み結果すべて。BOMつき・業種・地域・非表示理由を含む・並び順は一覧と同じ", async () => {
  setup();
  await seed(150);
  const r = await exportGet({ industry: "士業", sort: "name", order: "asc" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.match(r.headers["content-type"], /text\/csv; charset=utf-8/);
  assert.match(r.headers["content-disposition"], /sales_companies_\d{4}-\d{2}-\d{2}\.csv/);
  assert.ok(String(r.body).startsWith("﻿"), "UTF-8 BOM");
  const lines = csvLines(r);
  assert.equal(lines.length, 51, "見出し＋士業 の50社（100件で切らない）");
  assert.equal(lines[0], "企業名,URL,ドメイン,業種,地域,提案サービス,キャンペーン,ステータス,担当,最終アタック日時,最終アタック実行者,送信チャネル,現在の連絡手段,クリック数,NEXT,NEXT期限,非表示状態,非表示理由,登録日時");
  assert.ok(lines[1].startsWith("会社003,https://c3.example.jp/,c3.example.jp,士業,"), lines[1]);
  assert.ok(logged.some((l) => l.action === "sales.company_export" && l.detail.count === 50 && l.detail.mode === "filtered"));

  const c = db.rows.gw_sales_companies[0];
  await bulk({ ids: [c.id], action: "hide", reason: "link_broken" });
  const h = csvLines(await exportGet({ visibility: "hidden" }));
  assert.equal(h.length, 2);
  assert.match(h[1], /,非表示,リンク切れ,/);
});

await ok("CSV：チェックした企業だけ。他テナント・知らないIDは入らない。式は実行させない", async () => {
  setup();
  await seed(5);
  const [a, b] = db.rows.gw_sales_companies;
  a.name = '=HYPERLINK("http://evil")';
  db.rows.gw_sales_companies.push({ id: "00000000-0000-4000-8000-0000000000f1", tenant_id: "t2", name: "他社テナント", status: "untouched", click_count: 0 });
  const r = await exportPost({ ids: [a.id, b.id, "00000000-0000-4000-8000-0000000000f1", "not-a-uuid"] });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const lines = csvLines(r);
  assert.equal(lines.length, 3, "選んだ自テナントの2社だけ");
  assert.ok(!String(r.body).includes("他社テナント"));
  assert.ok(String(r.body).includes(`"'=HYPERLINK(""http://evil"")"`), "= で始まる値は ' を付けて式にしない");
  assert.equal((await exportPost({ ids: [] })).statusCode, 400);
  assert.ok(logged.some((l) => l.action === "sales.company_export" && l.detail.mode === "selected" && l.detail.count === 2));
});

await ok("CSV：営業の権限が無い人は 403", async () => {
  setup();
  await seed(2);
  who = MEMBER;
  assert.equal((await exportGet({})).statusCode, 403);
  assert.equal((await exportPost({ ids: [db.rows.gw_sales_companies[0].id] })).statusCode, 403);
});

console.log("\n=== ダッシュボード（/sales/）：件数と上位だけ返す（表示速度） ===\n");

// 以前の画面（sales/index.html）が、全件から組み立てていた決まり。サーバへ移しても同じ結果になることを確かめる
function oldPageSections(companies, today) {
  const open = (c) => !c.ngReason && !["won", "lost", "excluded"].includes(c.status);
  const due = (c) => c.nextDue && c.nextDue <= today;
  const RECENT_MS = 30 * 86400000;
  const SECTIONS = [
    { key: "click", pick: (c) => c.unhandledClick,
      sort: (x, y) => String(y.lastClickAt || "").localeCompare(String(x.lastClickAt || "")) || y.clickCount - x.clickCount },
    { key: "replied", pick: (c) => open(c) && c.status === "replied" },
    { key: "follow", pick: (c) => open(c) && !["untouched", "reattack_wait"].includes(c.status) && due(c) },
    { key: "attack", pick: (c) => open(c) && ["untouched", "reattack_wait"].includes(c.status)
        && !(c.lastSentAt && Date.now() - new Date(c.lastSentAt).getTime() < RECENT_MS)
        && (!c.nextDue || c.nextDue <= today) },
  ];
  const DEFAULT_SORT = (x, y) => (y.overdue ? 1 : 0) - (x.overdue ? 1 : 0)
    || String(x.nextDue || "9").localeCompare(String(y.nextDue || "9"));
  const used = new Set();
  const lists = {};
  for (const sec of SECTIONS) {
    lists[sec.key] = companies.filter((c) => !used.has(c.id) && sec.pick(c)).sort(sec.sort || DEFAULT_SORT);
    for (const c of lists[sec.key]) used.add(c.id);
  }
  return lists;
}

async function seedDashboard() {
  setup();
  await seed(90);
  const today = todayJst();
  const shift = (d) => new Date(Date.parse(`${today}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
  const ST = ["untouched", "attacked", "clicked", "replied", "meeting", "proposal", "reattack_wait", "won", "lost"];
  db.rows.gw_sales_companies.forEach((c, i) => {
    c.status = ST[i % ST.length];
    c.next_action = i % 4 ? "電話する" : null;
    c.next_action_on = i % 4 ? shift((i % 7) - 3) : null;
    if (i % 17 === 0) c.ng_reason = "no_sales";
  });
  // アタック（クリックあり・なし・最近・昔）
  db.rows.gw_sales_companies.forEach((c, i) => {
    if (i % 3) return;
    const sent = new Date(Date.now() - ((i % 50) + 1) * 86400000).toISOString();
    db.rows.gw_sales_approaches.push({ id: `ap-${i}`, tenant_id: "t1", company_id: c.id, employee_id: "emp-s1", service: "AI / DX",
      prepared_at: sent, sent_at: sent, channel: "form", click_count: i % 2 ? 0 : (i % 5) + 1,
      first_click_at: i % 2 ? null : sent, last_click_at: i % 2 ? null : new Date(Date.parse(sent) + i * 60000).toISOString() });
  });
  // 1社は非表示（ダッシュボードには出さない）
  db.rows.gw_sales_companies[1].hidden_at = new Date().toISOString();
  db.rows.gw_sales_companies[1].hidden_reason = "closed";
  return today;
}

await ok("view=dashboard：段ごとの件数と上位は、以前の画面（全件から組み立て）と同じ", async () => {
  const today = await seedDashboard();
  const all = await list();
  assert.equal(all.statusCode, 200);
  const want = oldPageSections(all.body.companies, today);
  const r = await call(companies, { method: "GET", url: "/api/sales/companies?view=dashboard" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.view, "dashboard");
  assert.equal(r.body.companies, undefined, "全件は返さない");
  const LIMIT = { click: 20, replied: 20, follow: 20, attack: 10 };
  let any = 0;
  for (const k of ["click", "replied", "follow", "attack"]) {
    assert.equal(r.body.sections[k].total, want[k].length, `${k} の件数`);
    assert.deepEqual(r.body.sections[k].rows.map((c) => c.id), want[k].slice(0, LIMIT[k]).map((c) => c.id), `${k} の並びと上位`);
    any += want[k].length;
  }
  assert.ok(any > 0 && want.click.length > 0 && want.attack.length > 0, "どの段にも何か入るデータで確かめる");
  // 画面が使う項目は、全件の形と同じ値
  const one = r.body.sections.click.rows[0];
  const full = all.body.companies.find((c) => c.id === one.id);
  for (const k of ["name", "status", "statusLabel", "next", "nextDue", "overdue", "ownerName", "clickCount", "lastClickAt", "lastSentAt", "unhandledClick"]) {
    assert.deepEqual(one[k], full[k] ?? (typeof one[k] === "boolean" ? false : one[k]), k);
  }
  assert.ok(JSON.stringify(r.body).length < JSON.stringify(all.body).length / 2, "送る量は全件より小さい");
});

await ok("view=dashboard：非表示の企業は出さない。知らない view は 400。営業でない人は 403", async () => {
  await seedDashboard();
  const hidden = db.rows.gw_sales_companies[1].id;
  const r = await call(companies, { method: "GET", url: "/api/sales/companies?view=dashboard" });
  for (const k of Object.keys(r.body.sections)) assert.ok(!r.body.sections[k].rows.some((c) => c.id === hidden));
  assert.equal(r.body.total, db.rows.gw_sales_companies.length - 1);
  assert.equal((await call(companies, { method: "GET", url: "/api/sales/companies?view=nope" })).statusCode, 400);
  who = MEMBER;
  assert.equal((await call(companies, { method: "GET", url: "/api/sales/companies?view=dashboard" })).statusCode, 403);
});

await ok("最近の営業履歴：limit を渡すとその件数だけ（新しい順）。渡さなければ、いままでどおり全件", async () => {
  setup();
  for (let i = 0; i < 20; i++) {
    const c = await newCompany({ name: `履歴${i}`, siteUrl: `https://h${i}.example.jp/` });
    await sendAttack(c.id);
  }
  db.rows.gw_sales_approaches.forEach((a, i) => { a.sent_at = new Date(Date.now() - (20 - i) * 3600000).toISOString(); });
  const all = await call(approaches, { method: "GET", url: "/api/sales/approaches?days=14" });
  assert.equal(all.body.approaches.length, 20);
  const top = await call(approaches, { method: "GET", url: "/api/sales/approaches?days=14&limit=15" });
  assert.equal(top.body.approaches.length, 15);
  assert.deepEqual(top.body.approaches.map((a) => a.id), all.body.approaches.slice(0, 15).map((a) => a.id), "新しい15件");
  assert.equal((await call(approaches, { method: "GET", url: "/api/sales/approaches?days=14&limit=abc" })).body.approaches.length, 20);
});

console.log("\n=== 小さな道具 ===\n");

await ok("トークンは10字・紛らわしい字なし", async () => {
  for (let i = 0; i < 200; i++) {
    const t = newTrackingToken();
    assert.ok(TRACKING_RE.test(t), t);
    assert.ok(!/[01OIl]/.test(t), t);
  }
});

await ok("差し込みは決めた4つだけ。知らない {{…}} は残す", async () => {
  const s = renderTemplate("{{company}} {{ sender }} {{url}} {{service}} {{unknown}}",
    { company: "A社", sender: "森", url: "https://x/r/ABC", service: "DX" });
  assert.equal(s, "A社 森 https://x/r/ABC DX {{unknown}}");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
