// 営業（Sales）の TimeRex Webhook の DEBUG 受信（api/sales/timerex/webhook.js・lib/sales-timerex-debug.js）。
//
// ■ 何を守るテストか
//   1. Sales 専用の Secret（TIMEREX_SALES_WEBHOOK_SECRET）だけで通す。採用HRの Secret では通らない。未設定は 503
//   2. DB に一切書かない（Supabase を呼んだら落とす）
//   3. ログに個人情報・URL・日時の値・payload 全文・Secret・sales_*_id の値を出さない
//   4. 確かめたいこと（webhook の種類・event.id・予約枠・start_datetime の形・Meet の構造・form の field_type・
//      sales_company_id / sales_meeting_id が返ってくるか・日程変更の old/new id）が、ログから読める
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);

let dbCalls = 0;
const boom = () => { dbCalls++; throw new Error("DEBUG 受信口が DB を呼んだ"); };
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: boom, userClient: boom } });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok ${name}`); } catch (e) { fail++; console.log(`  NG ${name}\n      ${e.message}`); }
};

const SECRET = "sales-secret-value-long-enough";
process.env.TIMEREX_SALES_WEBHOOK_SECRET = SECRET;
process.env.TIMEREX_WEBHOOK_SECRET = "hr-secret-value-long-enough";
process.env.TIMEREX_SALES_MEETING_URL = "https://timerex.net/s/its_8888/b6915742";

const { default: handler } = await import(atRoot("api/sales/timerex/webhook.js"));
const { salesDebugSummary, findSalesParams } = await import(atRoot("lib/sales-timerex-debug.js"));

const logs = [];
const origLog = console.log;
const call = async (body, headers = { "x-timerex-authorization": SECRET }, method = "POST") => {
  const r = { statusCode: 0, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.body = JSON.parse(b); };
  console.log = (...a) => { logs.push(a.join(" ")); };
  try { await handler({ method, headers, body }, r); } finally { console.log = origLog; }
  return r;
};

const COMPANY = "11111111-2222-4333-8444-555555555555";
const MEETING = "66666666-7777-4888-9999-000000000000";
// 採用HRの実 payload（test/fixtures/timerex-event-confirmed.json）と同じ形に、営業の値を入れたもの
const booked = (over = {}, evOver = {}) => ({
  webhook_type: "event_confirmed",
  calendar_url_path: "b6915742",
  team_url_path: "its_8888",
  calendar_url: "https://timerex.net/s/its_8888/b6915742",
  calendar_name: "GW営業｜初回商談30分",
  event: {
    id: "evt_sales_0001", calendar_id: "3b8706ceaae4946d3ae4", status: 1,
    url: `https://timerex.net/s/its_8888/b6915742?sales_company_id=${COMPANY}&sales_meeting_id=${MEETING}`,
    duration: 30,
    start_datetime: "2026-10-05T01:00:00+00:00", end_datetime: "2026-10-05T01:30:00+00:00",
    local_start_datetime: "2026-10-05T10:00:00+09:00",
    guest_cancel_url: "https://timerex.net/x/guest_cancel/SECRET_CANCEL_TOKEN",
    guest_reschedule_url: "https://timerex.net/x/guest_reschedule/SECRET_RESCHEDULE_TOKEN",
    host_cancel_url: "https://timerex.net/x/host_cancel/SECRET_HOST_TOKEN",
    google_meet_meeting: { meeting_id: "abc-defg-hij", join_url: "https://meet.google.com/abc-defg-hij" },
    form: [
      { field_type: "company_name", value: "株式会社テスト商事" },
      { field_type: "guest_name", value: "営業 花子" },
      { field_type: "guest_email", value: "hanako@test-shoji.example" },
      { field_type: "guest_phone", value: "03-1234-5678" },
      { field_type: "guest_comment", value: "AIの相談をしたいです" },
    ],
    is_changed: false, old_event_id: null, new_event_id: null,
    ...evOver,
  },
  ...over,
});
const PII = ["株式会社テスト商事", "営業 花子", "hanako@test-shoji.example", "03-1234-5678", "AIの相談",
  "meet.google.com", "SECRET_CANCEL_TOKEN", "SECRET_RESCHEDULE_TOKEN", "SECRET_HOST_TOKEN",
  "2026-10-05", "10:00", COMPANY, MEETING, SECRET, "hr-secret-value"];

console.log("\n=== 認証（Sales 専用の Secret） ===\n");

await ok("Sales の Secret なら 200・DEBUG。DB は一度も呼ばない", async () => {
  logs.length = 0;
  const r = await call(booked());
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, mode: "debug", webhookType: "event_confirmed" });
  assert.equal(dbCalls, 0);
  assert.equal(logs.length, 1);
});

await ok("採用HRの Secret・ヘッダー無し・違う値は 401。POST 以外は 405", async () => {
  assert.equal((await call(booked(), { "x-timerex-authorization": "hr-secret-value-long-enough" })).statusCode, 401);
  assert.equal((await call(booked(), {})).statusCode, 401);
  assert.equal((await call(booked(), { "x-timerex-authorization": SECRET + "x" })).statusCode, 401);
  assert.equal((await call(null, {}, "GET")).statusCode, 405);
});

await ok("TIMEREX_SALES_WEBHOOK_SECRET が未設定なら 503（常に拒否）", async () => {
  delete process.env.TIMEREX_SALES_WEBHOOK_SECRET;
  try { assert.equal((await call(booked())).statusCode, 503); }
  finally { process.env.TIMEREX_SALES_WEBHOOK_SECRET = SECRET; }
});

console.log("\n=== ログに出すもの・出さないもの ===\n");

await ok("個人情報・URL・日時の値・sales_*_id の値・Secret はログに出ない", async () => {
  logs.length = 0;
  await call(booked());
  await call(booked({}, { is_changed: true, old_event_id: "evt_sales_0001", new_event_id: "evt_sales_0002", id: "evt_sales_0002" }));
  await call({ webhook_type: "event_canceled", calendar_url_path: "b6915742", event: booked().event });
  const text = logs.join("\n");
  for (const s of PII) assert.ok(!text.includes(s), `ログに出ている：${s}`);
  assert.ok(text.includes("[sales-timerex-webhook][debug]"));
});

await ok("確かめたいことが読める：種類・event.id・予約枠（営業のカレンダーか）・日時の形・Meet の構造・form の field_type", async () => {
  const s = salesDebugSummary(booked());
  assert.equal(s.webhook_type, "event_confirmed");
  assert.equal(s.event_id, "evt_sales_0001");
  assert.equal(s.calendar_url_path, "b6915742");
  assert.equal(s.calendar_url_path_at, "body");
  assert.equal(s.matches_sales_calendar, true);
  assert.equal(s.start_datetime, "string(datetime+offset)");
  assert.deepEqual(s.google_meet_meeting, { join_url: "string(url)", meeting_id: "string" });
  assert.deepEqual(s.form_field_types, ["company_name", "guest_name", "guest_email", "guest_phone", "guest_comment"]);
  assert.deepEqual(s.form_value_types, ["string", "string", "string", "string", "string"]);
  assert.ok(s.event_keys.includes("google_meet_meeting") && s.top_level_keys.includes("calendar_url_path"));
  assert.equal(s.shape.event.guest_cancel_url, "string(url)");
});

await ok("予約URLの sales_company_id / sales_meeting_id：返ってくれば場所と UUID の形か、を出す（値は出さない）", async () => {
  assert.deepEqual(findSalesParams(booked()), [
    { path: "event.url", name: "sales_company_id", via: "query", uuid: true },
    { path: "event.url", name: "sales_meeting_id", via: "query", uuid: true },
  ]);
  const custom = booked({ custom_params: { sales_meeting_id: MEETING } }, { url: "https://timerex.net/s/its_8888/b6915742" });
  assert.deepEqual(findSalesParams(custom), [{ path: "custom_params.sales_meeting_id", name: "sales_meeting_id", via: "key", uuid: true }]);
  // 返ってこなければ空（＝ URL パラメータは使えないと分かる）
  assert.deepEqual(findSalesParams(booked({}, { url: "https://timerex.net/s/its_8888/b6915742" })), []);
});

await ok("日程変更の old/new event id・キャンセルの種類が読める", async () => {
  const r = salesDebugSummary(booked({}, { is_changed: true, old_event_id: "evt_sales_0001", new_event_id: "evt_sales_0002", id: "evt_sales_0002" }));
  assert.equal(r.is_changed, true);
  assert.equal(r.old_event_id, "evt_sales_0001");
  assert.equal(r.new_event_id, "evt_sales_0002");
  const c = salesDebugSummary({ webhook_type: "event_canceled", event: { id: "evt_sales_0002" } });
  assert.equal(c.webhook_type, "event_canceled");
  assert.equal(c.start_datetime, null);
});

await ok("採用HRの予約枠（社長面談など）なら matches_sales_calendar=false（営業ではないと分かる）", async () => {
  const s = salesDebugSummary(booked({ calendar_url_path: "98b26445" }));
  assert.equal(s.matches_sales_calendar, false);
  assert.equal(salesDebugSummary(booked(), {}).sales_calendar_configured, false, "TIMEREX_SALES_MEETING_URL 未設定なら false");
});

await ok("識別子に見えない値（メール・URL・日本語）は (redacted)。壊れた body でも 200", async () => {
  const s = salesDebugSummary({ webhook_type: "a@b.example", event: { id: "https://x", old_event_id: "予約" } });
  assert.equal(s.webhook_type, "(redacted)");
  assert.equal(s.event_id, "(redacted)");
  assert.equal(s.old_event_id, "(redacted)");
  for (const body of [null, [], "text", { event: [] }]) {
    const r = await call(body);
    assert.equal(r.statusCode, 200, JSON.stringify(body));
  }
  assert.equal(dbCalls, 0);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
