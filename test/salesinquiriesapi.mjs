// 自治体向けLPの問い合わせ受付：POST /api/sales/inquiries を、偽の Supabase（test/_memdb.mjs）と本物の署名・保存処理で通す。
//
// ■ 何を守るテストか
//   1. 署名（"sales." 付きの HMAC-SHA256）と時刻が正しいものだけ。HR リードの署名・ブラウザからの直接は通らない
//   2. 必須（送信ID・経路・種別・自治体名・担当者・メール・同意、自治体は部署名）と形
//   3. 会社（自治体）が無ければ「返信あり」で作り、あれば足す（成約・営業禁止などは動かさない）。同名は1社
//   4. 出来事「LP問い合わせ」（channel=form）に、種別・経路（source/source_detail/inquiry_type）・送信IDを残す
//   5. 同じ送信IDは2回目以降なにもしない（replayed）
//   6. 通知は担当者、いなければ在籍中の経営者。監査ログにメール・氏名・本文を出さない
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T1 = uid(1), T2 = uid(2), E_OWNER = uid(11), E_LEFT = uid(12), E_SALES = uid(13);
const nowIso = () => new Date().toISOString();

const mem = createMemDb({
  schema: {
    gw_sales_companies: {
      required: ["tenant_id", "name", "status"],
      defaults: () => ({ status: "untouched", created_at: nowIso(), updated_at: nowIso() }),
      check: (r) => (["untouched", "attacked", "clicked", "replied", "meeting", "proposal", "won", "excluded", "lost", "reattack_wait"].includes(r.status) ? null : "status"),
    },
    gw_sales_events: {
      required: ["tenant_id", "company_id", "event_key", "label"],
      defaults: () => ({ occurred_at: nowIso() }),
      check: (r) => (r.channel == null || ["form", "email", "line", "instagram", "x", "facebook", "linkedin", "phone", "other"].includes(r.channel) ? null : "channel"),
    },
    gw_notifications: { unique: [["employee_id", "dedupe_key"]], required: ["tenant_id", "employee_id", "title"] },
  },
});
const logged = [];
const slack = [];
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.userClient(null) } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async (m) => { slack.push(m); return { sent: true }; } } });

const SECRET = "test-lead-secret-0123456789abcdef";
process.env.MUGENDOJO_LEAD_SECRET = SECRET;
process.env.HR_LEAD_TENANT_ID = T1;

const { default: handler } = await import(atRoot("api/sales/inquiries.js"));
const { signSalesInquiry } = await import(atRoot("lib/sales-inquiries.js"));
const { signLeadRequest } = await import(atRoot("lib/hr-leads.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const sec = () => Math.floor(Date.now() / 1000);
const signed = (body, { secret = SECRET, ts = sec(), sign = signSalesInquiry } = {}) => ({ "x-lead-timestamp": String(ts), "x-lead-signature": sign(secret, ts, body) });
const call = async (body, headers = signed(body), method = "POST") => { const r = res(); await handler({ method, headers, body }, r); return r; };

let n = 0;
const inq = (over = {}) => ({
  submission_id: `2f0c1c9e-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  source: "mugendojo_lp", source_detail: "local_gov", inquiry_type: "consult", inquiry_label: "自治体向け導入相談",
  org: "テスト町", dept: "企画政策課", name: "自治 太郎", email: "Taro@Town.example.jp", tel: "03-1234-5678",
  area: "長野県テスト町", timing: "来年度", budget: "未定", message: "若い世代の流出", privacy_agreed: true,
  page_url: "https://mugendojo.jp/lp", utm_source: "google",
  ...over,
});
const companies = () => (mem.rows.gw_sales_companies || []).filter((c) => c.tenant_id === T1);
const events = () => mem.rows.gw_sales_events || [];
const notes = () => mem.rows.gw_notifications || [];

function setup() {
  mem.reset(); logged.length = 0; slack.length = 0;
  mem.rows.gw_employees = [
    { id: E_OWNER, tenant_id: T1, status: "active" }, { id: E_LEFT, tenant_id: T1, status: "left" }, { id: E_SALES, tenant_id: T1, status: "active" },
  ];
  mem.rows.gw_role_grants = [
    { tenant_id: T1, employee_id: E_OWNER, role: "owner" }, { tenant_id: T1, employee_id: E_LEFT, role: "owner" }, { tenant_id: T1, employee_id: E_SALES, role: "sales" },
  ];
  mem.rows.gw_sales_companies = [];
  mem.rows.gw_sales_events = [];
}

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

console.log("sales inquiries (自治体向けLP → /sales)");

await ok("署名なし・違う鍵・HR リードの署名・古い時刻は 401。GET は 405", async () => {
  setup();
  const b = inq();
  assert.equal((await call(b, {})).statusCode, 401);
  assert.equal((await call(b, signed(b, { secret: "x".repeat(40) }))).statusCode, 401);
  assert.equal((await call(b, signed(b, { sign: signLeadRequest }))).statusCode, 401, "HR の口の署名は通らない");
  const old = await call(b, signed(b, { ts: sec() - 3600 }));
  assert.equal(old.statusCode, 401); assert.equal(old.body.error, "timestamp_out_of_range");
  assert.equal((await call(b, signed(b), "GET")).statusCode, 405);
  assert.equal(companies().length, 0);
});

await ok("設定が無ければ 503（どのテナントへ入れるかを推測しない）", async () => {
  setup();
  const keep = process.env.HR_LEAD_TENANT_ID;
  process.env.HR_LEAD_TENANT_ID = "";
  try { assert.equal((await call(inq())).statusCode, 503); } finally { process.env.HR_LEAD_TENANT_ID = keep; }
});

await ok("必須・形が違えば 400（field で項目を返す）", async () => {
  setup();
  for (const [over, field] of [
    [{ submission_id: "x" }, "submission_id"], [{ source: "other" }, "source"], [{ source_detail: "other" }, "source"],
    [{ inquiry_type: "x" }, "inquiry_type"], [{ org: "" }, "org"], [{ name: "" }, "name"], [{ email: "bad" }, "email"],
    [{ dept: "" }, "dept"], [{ privacy_agreed: false }, "privacy_agreed"], [{ tel: "abc" }, "tel"],
  ]) {
    const r = await call(inq(over));
    assert.equal(r.statusCode, 400, JSON.stringify(over)); assert.equal(r.body.field, field);
  }
  // 地域企業のDX相談は部署名なしで通る
  assert.equal((await call(inq({ inquiry_type: "biz", org: "○○商店", dept: "" }))).statusCode, 200);
});

await ok("新しい自治体：返信あり・地域は都道府県・メール・NEXT。出来事「LP問い合わせ」に経路と送信ID", async () => {
  setup();
  const b = inq();
  const r = await call(b);
  assert.equal(r.statusCode, 200); assert.equal(r.body.result, "created");
  const [c] = companies();
  assert.equal(c.name, "テスト町"); assert.equal(c.status, "replied"); assert.equal(c.region, "長野県");
  assert.deepEqual(c.emails, ["taro@town.example.jp"]); assert.equal(c.service, "地方創生");
  assert.match(c.next_action, /LP問い合わせ（自治体向け導入相談）に返信/);
  const [e] = events();
  assert.equal(e.event_key, "lp_inquiry"); assert.equal(e.channel, "form"); assert.equal(e.company_id, c.id);
  assert.match(e.detail, /source=mugendojo_lp source_detail=local_gov inquiry_type=consult/);
  assert.match(e.detail, new RegExp(`送信ID：${b.submission_id}`));
  assert.match(e.detail, /想定時期／予算：来年度／未定/);
});

await ok("同じ送信IDは2回目以降なにもしない（replayed）", async () => {
  setup();
  const b = inq();
  assert.equal((await call(b)).body.result, "created");
  const r2 = await call(b);
  assert.equal(r2.body.result, "replayed");
  assert.equal(companies().length, 1); assert.equal(events().length, 1);
});

await ok("同じ名前の自治体には足す（メールを足す・ステータスを進める）。成約・営業禁止は動かさない", async () => {
  setup();
  mem.rows.gw_sales_companies.push({ id: uid(100), tenant_id: T1, name: "テスト町", status: "attacked", emails: ["info@town.example.jp"], owner_id: E_SALES });
  const r = await call(inq());
  assert.equal(r.body.result, "updated"); assert.equal(companies().length, 1);
  const c = companies()[0];
  assert.equal(c.status, "replied"); assert.deepEqual(c.emails, ["info@town.example.jp", "taro@town.example.jp"]);
  // 担当者がいれば、担当者へ
  assert.deepEqual(notes().map((x) => x.employee_id), [E_SALES]);

  setup();
  mem.rows.gw_sales_companies.push({ id: uid(101), tenant_id: T1, name: "テスト町", status: "won", emails: [], next_action: null });
  await call(inq());
  assert.equal(companies()[0].status, "won"); assert.equal(companies()[0].next_action, null);
  assert.equal(events().length, 1, "記録は残す");
});

await ok("担当者がいなければ、在籍中の経営者へ通知。Slack。監査ログにメール・氏名・本文を出さない", async () => {
  setup();
  const b = inq();
  await call(b);
  assert.deepEqual(notes().map((x) => x.employee_id), [E_OWNER]);
  assert.equal(notes()[0].kind, "sales");
  assert.equal(slack.length, 1);
  assert.equal(logged.length, 1); assert.equal(logged[0].action, "sales.lp_inquiry");
  const s = JSON.stringify(logged[0]);
  for (const x of ["taro@", "自治 太郎", "若い世代"]) assert.ok(!s.includes(x), x);
});

await ok("別テナントの同名の会社とは混ざらない", async () => {
  setup();
  mem.rows.gw_sales_companies.push({ id: uid(102), tenant_id: T2, name: "テスト町", status: "untouched", emails: [] });
  assert.equal((await call(inq())).body.result, "created");
  assert.equal(companies().length, 1);
  assert.equal(mem.rows.gw_sales_companies.find((c) => c.tenant_id === T2).status, "untouched");
});

console.log(`\nsales inquiries: ${pass} ok, ${fail} NG`);
if (fail) process.exit(1);
