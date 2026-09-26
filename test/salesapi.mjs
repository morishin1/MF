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

function matcher(f) {
  return (r) => f.every(([op, k, v]) => {
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
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter(matcher(f));
    if (order) {
      const [col, asc] = order;
      out = [...out].sort((a, b) => ((a[col] ?? "") < (b[col] ?? "") ? (asc ? -1 : 1) : (asc ? 1 : -1)));
    }
    return out;
  };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    not(k) { f.push(["notnull", k]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    order(col, opts) { order = [col, opts?.ascending !== false]; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r) => ({
        id: r.id || uuid(), created_at: new Date().toISOString(),
        ...(name === "gw_sales_companies" ? { status: "untouched" } : {}),
        ...(name === "gw_sales_approaches" ? { prepared_at: new Date().toISOString(), sent_at: null, click_count: 0 } : {}),
        ...r,
      }));
      (db.rows[name] = db.rows[name] || []).push(...made);
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
        is: (k, v) => { g.push(["is", k, v]); return r2; },
        select: () => r2,
        single: () => apply(),
        maybeSingle: () => apply(),
        then: (fn) => apply({ asList: true }).then(fn),
      };
      function apply(opts) {
        const hit = (db.rows[name] || []).filter(matcher(g));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve(opts?.asList ? { data: hit.map(copy), error: null } : { data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
    delete() {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        then: (fn) => {
          const m = matcher(g);
          db.rows[name] = (db.rows[name] || []).filter((x) => !m(x));
          return Promise.resolve({ data: null, error: null }).then(fn);
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
mock.module(atRoot("lib/slack.js"), {
  namedExports: { notifySlack: async (m) => { slacked.push(m); return { sent: true }; } },
});

const SALES = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["sales"], employee: { id: "emp-s1", display_name: "営業 一郎" } };
const SALES2 = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["sales"], employee: { id: "emp-s2", display_name: "営業 二郎" } };
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: true, roles: [], employee: { id: "emp-a1", display_name: "管理 花子" } };
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: { id: "emp-m1", display_name: "一般 次郎" } };
const RECRUITER = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "emp-r1", display_name: "採用 三郎" } };
let who = SALES;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    // lib/gw.js の canSell・canForceAttack と同じ判定
    canSell: (c) => Boolean(c.isAdmin || ["owner", "manager", "sales"].some((r) => (c.roles || []).includes(r))),
    canForceAttack: (c) => Boolean(c.isAdmin || (c.roles || []).includes("owner")),
  },
});

const { default: companies } = await import(atRoot("api/sales/companies/index.js"));
const { default: detail } = await import(atRoot("api/sales/companies/detail.js"));
const { default: approaches } = await import(atRoot("api/sales/approaches/index.js"));
const { default: templates } = await import(atRoot("api/sales/templates/index.js"));
const { default: redirect } = await import(atRoot("api/sales/r.js"));
const { TRACKING_RE, newTrackingToken, renderTemplate } = await import(atRoot("lib/sales.js"));

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
const click = (token, { ua = HUMAN, ip = "203.0.113.5", method = "GET" } = {}) =>
  call(redirect, { method, url: `/api/sales/r?t=${token}`, headers: { "user-agent": ua, "x-forwarded-for": ip } });

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
    gw_sales_templates: [], gw_sales_campaigns: [],
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
  const s = await act({ id: p.body.approach.id, action: "sent", body: `営業文 ${p.body.trackingUrl}`, service: "AI / DX", ...extra });
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

await ok("使えるのは営業担当・管理者。一般メンバー・採用担当は 403", async () => {
  setup();
  who = MEMBER;
  assert.equal((await list()).statusCode, 403);
  who = RECRUITER;
  assert.equal((await list()).statusCode, 403);
  who = ADMIN;
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

await ok("送信完了で履歴に残り、会社はアタック済・NEXTは「反応を確認」", async () => {
  setup();
  const c = await newCompany();
  const { approach } = await sendAttack(c.id);
  assert.ok(approach.sentAt);
  assert.equal(approach.employeeId, "emp-s1");
  assert.match(approach.body, /営業文/);
  const co = db.rows.gw_sales_companies[0];
  assert.equal(co.status, "attacked");
  assert.equal(co.next_action, "反応を確認");
  assert.ok(co.next_action_on > new Date().toISOString().slice(0, 10));
  assert.ok(logged.some((l) => l.action === "sales.attack_sent"));
  const l = await list();
  assert.equal(l.body.companies[0].attackCount, 1);
  assert.equal(l.body.companies[0].lastAttackerName, "営業 一郎");
});

await ok("送信完了は二度押ししても1回だけ（409）", async () => {
  setup();
  const c = await newCompany();
  const { approach } = await sendAttack(c.id);
  const again = await act({ id: approach.id, action: "sent", body: "もう一度" });
  assert.equal(again.statusCode, 409);
  assert.equal(db.rows.gw_sales_approaches[0].body.startsWith("営業文"), true, "本文は最初のまま");
});

await ok("営業文が空なら送信完了にしない", async () => {
  setup();
  const c = await newCompany();
  const p = await prepare({ companyId: c.id });
  const r = await act({ id: p.body.approach.id, action: "sent", body: "  " });
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
  const r = await act({ id: p.body.approach.id, action: "sent", body: "営業文" });
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
  assert.equal(ev.ip_hash.length, 32);
  assert.ok(!JSON.stringify(ev).includes("203.0.113.5"), "IPそのものは残さない");
  const a = db.rows.gw_sales_approaches[0];
  assert.equal(a.click_count, 1);
  assert.ok(a.first_click_at && a.last_click_at);
  assert.equal(db.rows.gw_sales_companies[0].status, "clicked");
  assert.equal(notified.length, 1, "送った人＝担当なので1通");
  assert.equal(notified[0].kind, "sales");
  assert.match(notified[0].title, /株式会社サンプルが営業リンクをクリックしました/);
  assert.match(notified[0].body, /クリック回数：1回/);
  assert.match(notified[0].body, /提案サービス：AI \/ DX/);
  assert.equal(slacked.length, 1);
  assert.match(slacked[0].text, /営業反応あり/);
});

await ok("同じ人の30秒以内の連打は1回。別の人・時間をおいたクリックは数える", async () => {
  setup();
  const c = await newCompany();
  const { url } = await sendAttack(c.id);
  const token = url.split("/r/")[1];
  await click(token);
  await click(token);
  assert.equal(db.rows.gw_sales_approaches[0].click_count, 1);
  await click(token, { ip: "198.51.100.9" });
  assert.equal(db.rows.gw_sales_approaches[0].click_count, 2);
  assert.equal(db.rows.gw_sales_click_events[1].click_no, 2);
  db.rows.gw_sales_click_events[0].clicked_at = new Date(Date.now() - 60000).toISOString();
  await click(token);
  assert.equal(db.rows.gw_sales_approaches[0].click_count, 3);
});

await ok("リンクのプレビュー（機械）・HEAD は数えず、飛ばすだけ", async () => {
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
  assert.equal(db.rows.gw_sales_click_events.length, 0);
  assert.equal(db.rows.gw_sales_companies[0].status, "attacked");
  assert.equal(notified.length, 0);
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
  assert.deepEqual(labels, ["フォーム送信", "リンククリック", "返信あり"]);
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
