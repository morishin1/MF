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

function matcher(f) {
  return (r) => f.every(([op, k, v]) => {
    if (op === "or") {
      // name.ilike.%x%,domain.ilike.%x% の形だけ
      return v.split(",").some((part) => {
        const [col, , pat] = part.split(".");
        const needle = pat.replace(/%/g, "").toLowerCase();
        return String(r[col] ?? "").toLowerCase().includes(needle);
      });
    }
    if (op === "gt") return r[k] !== null && r[k] !== undefined && r[k] > v;
    if (op === "eq") return r[k] === v;
    if (op === "in") return v.includes(r[k]);
    if (op === "is") return (r[k] ?? null) === v;
    if (op === "notnull") return r[k] !== null && r[k] !== undefined;
    if (op === "gte") return r[k] !== null && r[k] !== undefined && r[k] >= v;
    return true;
  });
}

function table(name) {
  const f = [];
  const orders = [];
  let range = null;
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
    const data = range ? all.slice(range[0], range[1] + 1) : all;
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
    order(col, opts) { orders.push([col, opts?.ascending !== false, opts?.nullsFirst ?? (opts?.ascending === false)]); return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn) => Promise.resolve(result()).then(fn),
    insert(row) {
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

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
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
const { default: dealsApi } = await import(atRoot("api/sales/deals/index.js"));
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
  assert.ok(db.rows.gw_sales_events.some((e) => e.label.startsWith("面談の日程調整URLを送付")));
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
  assert.ok(db.rows.gw_sales_events.some((e) => e.label === "面談予定：10/5 14:00（初回商談）"));
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
  assert.match(why["面談社"], /面談あり/);
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
      industry: ["IT", "製造", "医療"][i % 3], region: ["東京都", "大阪府"][i % 2], service: "AI / DX" });
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
  const it = await pageOf({ page: 1, industry: "IT" });
  assert.equal(it.body.total, 10);
  assert.ok(it.body.companies.every((c) => c.industry === "IT"));
  const both = await pageOf({ page: 1, industry: "IT", region: "東京都" });
  assert.equal(both.body.total, 5);
  assert.ok(both.body.companies.every((c) => c.industry === "IT" && c.region === "東京都"));
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
  assert.deepEqual([...new Set(ind.map((c) => c.industry))], ["IT", "医療", "製造"]);
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

await ok("絞り込みの候補（facets=1）：業種・地域・商材を件数つきで返す", async () => {
  setup();
  await seed(6);
  const r = await pageOf({ page: 1, facets: 1 });
  assert.deepEqual(r.body.facets.industry.map((x) => [x.value, x.n]), [["IT", 2], ["医療", 2], ["製造", 2]]);
  assert.deepEqual(r.body.facets.region.map((x) => x.value), ["大阪府", "東京都"]);
  assert.equal((await pageOf({ page: 1 })).body.facets, undefined, "頼んだときだけ");
});

console.log("\n=== CSV（/api/sales/companies/export） ===\n");

const csvLines = (r) => String(r.body).replace(/^﻿/, "").split("\r\n").filter(Boolean);

await ok("CSV：いまの検索・絞り込み結果すべて。BOMつき・業種・地域・非表示理由を含む・並び順は一覧と同じ", async () => {
  setup();
  await seed(150);
  const r = await exportGet({ industry: "IT", sort: "name", order: "asc" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.match(r.headers["content-type"], /text\/csv; charset=utf-8/);
  assert.match(r.headers["content-disposition"], /sales_companies_\d{4}-\d{2}-\d{2}\.csv/);
  assert.ok(String(r.body).startsWith("﻿"), "UTF-8 BOM");
  const lines = csvLines(r);
  assert.equal(lines.length, 51, "見出し＋IT の50社（100件で切らない）");
  assert.equal(lines[0], "企業名,URL,ドメイン,業種,地域,商材,ステータス,担当,最終アタック日時,最終アタック実行者,送信チャネル,現在の連絡手段,クリック数,NEXT,NEXT期限,非表示状態,非表示理由,登録日時");
  assert.ok(lines[1].startsWith("会社003,https://c3.example.jp/,c3.example.jp,IT,"), lines[1]);
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

console.log("\n=== 案件（db/100） ===\n");

const newDeal = (body) => call(dealsApi, { method: "POST", url: "/api/sales/deals", body });
const patchDeal = (body) => call(dealsApi, { method: "PATCH", url: "/api/sales/deals", body });
const listDeals = (companyId) => call(dealsApi, { method: "GET", url: `/api/sales/deals${companyId ? `?companyId=${companyId}` : ""}` });
const dealRow = (id) => db.rows.gw_sales_deals.find((d) => d.id === id);
const coOf = (id) => db.rows.gw_sales_companies.find((c) => c.id === id);

await ok("案件を作ると、もとのアタックは最後に送ったもの・会社は商談へ進む・履歴に残る", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  ageApproaches(40);
  const { approach: latest } = await sendAttack(c.id, { service: "PCレンタル" });
  const r = await newDeal({ companyId: c.id, title: "AI/DX 導入支援", amount: "1,200,000" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const d = dealRow(r.body.deal.id);
  assert.equal(d.approach_id, latest.id, "最後に送ったアタック");
  assert.equal(d.amount, 1200000);
  assert.equal(d.stage, "meeting");
  assert.equal(d.owner_id, coOf(c.id).owner_id, "担当は会社の担当");
  assert.equal(r.body.deal.probabilityUsed, 20);
  assert.equal(r.body.deal.expected, 240000);
  assert.equal(coOf(c.id).status, "meeting");
  assert.equal(r.body.companyStatus, "meeting");
  assert.ok(coOf(c.id).next_action, "NEXT が空なら自動で入る");
  assert.ok(db.rows.gw_sales_events.some((e) => e.event_key === "deal" && /案件を追加：AI\/DX 導入支援（1,200,000円）/.test(e.label)));
  assert.ok(db.rows.gw_sales_events.some((e) => e.event_key === "status" && /商談/.test(e.label)));
  assert.ok(logged.some((l) => l.action === "sales.deal_create"));
});

await ok("案件：入力のチェック（案件名・金額・確率・作るときの段階）", async () => {
  setup();
  const c = await newCompany();
  assert.equal((await newDeal({ companyId: c.id, title: "" })).body.error, "bad_title");
  assert.equal((await newDeal({ companyId: c.id, title: "x", amount: -1 })).body.error, "bad_amount");
  assert.equal((await newDeal({ companyId: c.id, title: "x", amount: 1.5 })).body.error, "bad_amount");
  assert.equal((await newDeal({ companyId: c.id, title: "x", amount: 100000000001 })).body.error, "bad_amount");
  assert.equal((await newDeal({ companyId: c.id, title: "x", probability: 101 })).body.error, "bad_probability");
  assert.equal((await newDeal({ companyId: c.id, title: "x", stage: "won", amount: 1 })).body.error, "bad_stage", "作るときに成約にはしない");
  assert.equal((await newDeal({ companyId: "nope", title: "x" })).statusCode, 400);
  assert.equal((db.rows.gw_sales_deals || []).length, 0);
  // アタックの無い会社にも作れる（紹介など）。もとのアタックは null
  const r = await newDeal({ companyId: c.id, title: "紹介案件" });
  assert.equal(r.statusCode, 200);
  assert.equal(dealRow(r.body.deal.id).approach_id, null);
});

await ok("案件の段階：提案・最終調整で会社は提案、成約は金額が要る、成約で会社も成約", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  const { body } = await newDeal({ companyId: c.id, title: "案件A" });
  const id = body.deal.id;
  let r = await patchDeal({ id, stage: "proposal" });
  assert.equal(coOf(c.id).status, "proposal");
  r = await patchDeal({ id, stage: "negotiation", probability: 70 });
  assert.equal(r.body.deal.probabilityUsed, 70, "個別の確率を優先");
  assert.equal(coOf(c.id).status, "proposal");
  r = await patchDeal({ id, stage: "won" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "amount_required");
  r = await patchDeal({ id, stage: "won", amount: 0 });
  assert.equal(r.statusCode, 400, "0円の成約は作らない（DB の制約と同じ）");
  assert.equal(r.body.error, "amount_required");
  assert.equal(dealRow(id).stage, "negotiation");
  r = await patchDeal({ id, stage: "won", amount: 800000 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(dealRow(id).won_on, todayJst());
  assert.equal(r.body.deal.expected, 0, "成約は見込に入れない");
  assert.equal(coOf(c.id).status, "won");
  assert.ok(db.rows.gw_sales_events.some((e) => e.event_key === "deal" && /最終調整 → 成約/.test(e.label) && e.detail === "800,000円"));
  // 取り消して進行中へ戻すと、成約日は消える（会社は戻さない）
  r = await patchDeal({ id, stage: "proposal" });
  assert.equal(dealRow(id).won_on, null);
  assert.equal(coOf(c.id).status, "won");
});

await ok("1件の失注で会社を失注にしない。全部失注になったら聞くだけ（会社は変えない）", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  const a = (await newDeal({ companyId: c.id, title: "案件A", amount: 100000 })).body.deal;
  const b = (await newDeal({ companyId: c.id, title: "案件B" })).body.deal;
  let r = await patchDeal({ id: a.id, stage: "lost", lostReason: "予算なし" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.suggestCompanyLost, false);
  assert.equal(coOf(c.id).status, "meeting");
  assert.equal(dealRow(a.id).lost_on, todayJst());
  assert.equal(dealRow(a.id).lost_reason, "予算なし");
  r = await patchDeal({ id: b.id, stage: "lost" });
  assert.equal(r.body.suggestCompanyLost, true);
  assert.equal(coOf(c.id).status, "meeting", "会社のステータスは人が決める");
  // 失注から戻すと、失注日・理由は消える
  await patchDeal({ id: a.id, stage: "meeting" });
  assert.equal(dealRow(a.id).lost_on, null);
  assert.equal(dealRow(a.id).lost_reason, null);
});

await ok("もとのアタック・会社は、作ったあとは変えられない", async () => {
  setup();
  const c = await newCompany();
  await sendAttack(c.id);
  const d = (await newDeal({ companyId: c.id, title: "案件A" })).body.deal;
  const before = dealRow(d.id).approach_id;
  const other = await newCompany({ name: "別社", siteUrl: "https://other.example.jp/" });
  const { approach } = await sendAttack(other.id);
  assert.equal((await patchDeal({ id: d.id, approachId: approach.id })).body.error, "fixed_fields");
  assert.equal((await patchDeal({ id: d.id, companyId: other.id })).body.error, "fixed_fields");
  // あとから別のアタックを送っても、案件のもとのアタックは変わらない
  ageApproaches(40);
  await sendAttack(c.id);
  await patchDeal({ id: d.id, stage: "proposal" });
  assert.equal(dealRow(d.id).approach_id, before);
});

await ok("会社のステータスは戻さない・営業禁止や対象外の会社は案件で動かさない", async () => {
  setup();
  const won = await newCompany({ name: "成約社", siteUrl: "https://won.example.jp/" });
  coOf(won.id).status = "won";
  await newDeal({ companyId: won.id, title: "追加案件" });
  assert.equal(coOf(won.id).status, "won");
  const ng = await newCompany({ name: "既存顧客社", siteUrl: "https://ng.example.jp/" });
  coOf(ng.id).ng_reason = "customer";
  const r = await newDeal({ companyId: ng.id, title: "追加発注" });
  assert.equal(r.statusCode, 200, "営業禁止（既存顧客など）でも案件は作れる");
  assert.equal(coOf(ng.id).status, "untouched");
  const lost = await newCompany({ name: "失注社", siteUrl: "https://lost.example.jp/" });
  coOf(lost.id).status = "lost";
  await newDeal({ companyId: lost.id, title: "再提案" });
  assert.equal(coOf(lost.id).status, "meeting", "失注の会社に新しい案件が立ったら商談へ");
});

await ok("案件：他テナントのものは見えない・直せない。営業でない人は使えない", async () => {
  setup();
  const c = await newCompany();
  const d = (await newDeal({ companyId: c.id, title: "案件A", amount: 5 })).body.deal;
  db.rows.gw_sales_deals.push({ id: uuid(), tenant_id: "t2", company_id: "c-other", title: "他社", stage: "meeting", amount: 9 });
  const all = await listDeals();
  assert.deepEqual(all.body.deals.map((x) => x.title), ["案件A"]);
  assert.equal(all.body.deals[0].companyName, "株式会社サンプル", "全体の一覧には会社名もつける");
  const other = db.rows.gw_sales_deals.find((x) => x.tenant_id === "t2");
  assert.equal((await patchDeal({ id: other.id, amount: 1 })).statusCode, 404);
  assert.equal(other.amount, 9);
  who = MEMBER;
  assert.equal((await listDeals()).statusCode, 403);
  assert.equal((await newDeal({ companyId: c.id, title: "x" })).statusCode, 403);
  assert.equal((await patchDeal({ id: d.id, amount: 1 })).statusCode, 403);
});

await ok("企業詳細に案件が出る。案件のある企業は削除できない", async () => {
  setup();
  const c = await newCompany();
  await newDeal({ companyId: c.id, title: "案件A", amount: 300000 });
  const g = await getOne(c.id);
  assert.equal(g.statusCode, 200);
  assert.equal(g.body.dealsReady, true);
  assert.equal(g.body.deals[0].title, "案件A");
  assert.equal(g.body.deals[0].amount, 300000);
  // 案件の記録は「最終連絡」に数えない
  assert.equal(g.body.contactStatus?.lastContactAt ?? null, null);
  db.rows.gw_sales_events = [];   // 営業履歴を消しても、案件があれば止まる
  const r = await bulk({ ids: [c.id], action: "delete" });
  assert.equal(r.body.deleted, 0);
  assert.match(r.body.blocked[0].reasons.join(), /案件あり/);
});

await ok("成約確率の既定値：DB（db/100 の関数）と画面・API（lib/sales-deals.js）が同じ", async () => {
  const { DEFAULT_PROBABILITY } = await import(atRoot("lib/sales-deals.js"));
  const sql = (await import("node:fs")).readFileSync(atRoot("db/100_sales_deals.sql"), "utf8");
  const fn = sql.slice(sql.indexOf("function public.gw_sales_deal_default_probability"));
  const inSql = Object.fromEntries([...fn.slice(0, fn.indexOf("$$;")).matchAll(/when '(\w+)'\s+then (\d+)/g)].map((m) => [m[1], Number(m[2])]));
  for (const [k, v] of Object.entries(DEFAULT_PROBABILITY)) assert.equal(inSql[k], v, `${k}: SQL ${inSql[k]} / JS ${v}`);
  assert.equal(inSql.won, 100);
  assert.equal(inSql.lost, 0);
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
