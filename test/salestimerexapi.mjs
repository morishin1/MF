// 営業（Sales）の TimeRex 予約反映（api/sales/timerex/webhook.js・lib/sales-timerex.js）を、偽の DB で通す。
//
// ■ 何を守るテストか
//   1. Sales 専用の Secret だけで通す。採用HRの Secret は 401。未設定は 503
//   2. 営業の初回商談カレンダー以外（採用HRの面談など）は処理しない（422・何も書かない）
//   3. 初回予約は guest_email の完全一致（大文字小文字は区別しない）で、日程調整中の商談を1件に決めたときだけ反映する
//      照合するのは企業のメールアドレス（emails[]・db/108。複数のどれでもよい）と、連絡先のメール・連絡手段がメールのときの連絡先
//      0件は 404・2件以上は 409（何も書かない）。別テナントへは書かない
//   4. event_confirmed → 商談予定（scheduled）・日時・Google Meet URL・timerex_event_id・同期時刻
//   5. 同じ event.id の再送で二重に登録・記録しない
//   6. 企業の状態は前へ進めるだけ。成約・失注・対象外・営業禁止は変えない
//   7. 日程変更・キャンセルは今回は扱わない（200 ignored・何も書かない）
//   8. 採用HRの Webhook に営業の予約は入らない（HR の予約枠ではないので 422）。gw_hr_interviews には触らない
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);

// ---- 偽の DB（このテストで使う形だけ） ----------------------------------------------
const db = { rows: {} };
const writes = [];
let seq = 0;
const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : r);
function table(name) {
  const f = [];
  let lim = null;
  let embed = false;
  const match = (r) => f.every(([k, v]) => r[k] === v);
  const rows = () => (db.rows[name] || []).filter(match);
  const withEmbed = (r) => (embed ? { ...copy(r), company: copy((db.rows.gw_sales_companies || []).find((c) => c.id === r.company_id) || null) } : copy(r));
  const q = {
    select(cols) { embed = /company:gw_sales_companies\(\*\)/.test(cols || ""); return q; },
    eq(k, v) { f.push([k, v]); return q; },
    limit(n) { lim = n; return q; },
    then(fn) { const out = rows().slice(0, lim ?? undefined).map(withEmbed); return Promise.resolve({ data: out, error: null }).then(fn); },
    update(patch) {
      const g = [];
      let want = false;
      const apply = () => {
        const hit = (db.rows[name] || []).filter((r) => g.every(([k, v]) => r[k] === v));
        // 一意索引 (tenant_id, timerex_event_id)（db/090）
        if (name === "gw_sales_meetings" && patch.timerex_event_id) {
          const dup = (db.rows[name] || []).find((r) => !hit.includes(r) && r.timerex_event_id === patch.timerex_event_id
            && hit.some((h) => h.tenant_id === r.tenant_id));
          if (dup) return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        for (const r of hit) Object.assign(r, patch);
        writes.push({ table: name, op: "update", ids: hit.map((r) => r.id), tenants: hit.map((r) => r.tenant_id), patch });
        return { data: hit.map(copy), error: null };
      };
      const r2 = {
        eq(k, v) { g.push([k, v]); return r2; },
        select() { want = true; return r2; },
        single() { const r = apply(); return Promise.resolve(r.error ? r : { data: r.data[0] || null, error: null }); },
        then(fn) { return Promise.resolve(apply()).then(fn); },
      };
      return r2;
    },
    insert(row) {
      const made = [].concat(row).map((r) => ({ id: `row${++seq}`, ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      writes.push({ table: name, op: "insert", tenants: made.map((r) => r.tenant_id), rows: made });
      return Promise.resolve({ data: made, error: null });
    },
  };
  return q;
}
const sbMock = { from: table };
const logged = [];
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => sbMock, userClient: () => sbMock } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ok ${name}`); } catch (e) { fail++; console.log(`  NG ${name}\n      ${e.message}`); }
};

const SALES_SECRET = "sales-secret-value-long-enough";
const HR_SECRET = "hr-secret-value-long-enough";
process.env.TIMEREX_SALES_WEBHOOK_SECRET = SALES_SECRET;
process.env.TIMEREX_WEBHOOK_SECRET = HR_SECRET;
process.env.TIMEREX_SALES_MEETING_URL = "https://timerex.net/s/its_8888/b6915742";
process.env.TIMEREX_CASUAL_INTERVIEW_URL = "https://timerex.net/s/bo_43ba_dabf/c0a1b2c3";

const { default: salesHook } = await import(atRoot("api/sales/timerex/webhook.js"));
const { default: hrHook } = await import(atRoot("api/hr/timerex/webhook.js"));

const origLog = console.log, origWarn = console.warn;
const logs = [];
const call = async (handler, body, secret = SALES_SECRET) => {
  const r = { statusCode: 0, headers: {}, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.body = JSON.parse(b); };
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push(a.join(" "));
  try {
    await handler({ method: "POST", headers: secret ? { "x-timerex-authorization": secret } : {}, body }, r);
  } finally { console.log = origLog; console.warn = origWarn; }
  return r;
};
const hook = (body, secret) => call(salesHook, body, secret);

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
function setup() {
  writes.length = 0; logged.length = 0; logs.length = 0;
  db.rows = {
    gw_sales_companies: [
      { id: "c1", tenant_id: T1, name: "株式会社テスト商事", status: "clicked", ng_reason: null,
        contacts: { email: "Hanako@Test-Shoji.example" }, current_contact_channel: null, current_contact_value: null },
      { id: "c2", tenant_id: T1, name: "現在の連絡手段がメール", status: "replied", ng_reason: null,
        contacts: {}, current_contact_channel: "email", current_contact_value: "taro@mail.example" },
    ],
    gw_sales_meetings: [
      { id: "m1", tenant_id: T1, company_id: "c1", kind: "first_meeting", duration_min: 30, status: "scheduling",
        scheduled_at: null, meeting_url: null, timerex_event_id: null, timerex_synced_at: null, created_at: "2026-09-30T00:00:00Z" },
      { id: "m2", tenant_id: T1, company_id: "c2", kind: "first_meeting", duration_min: 30, status: "scheduling",
        scheduled_at: null, meeting_url: null, timerex_event_id: null, timerex_synced_at: null, created_at: "2026-09-30T00:00:00Z" },
    ],
    gw_sales_events: [],
    gw_hr_interviews: [],
  };
}
// 実 Webhook で確認できた形（DEBUG 受信）
const booked = (over = {}, evOver = {}, email = "hanako@test-shoji.example") => ({
  webhook_type: "event_confirmed", calendar_url_path: "b6915742",
  event: {
    id: "evt_s1", start_datetime: "2026-10-05T01:00:00+00:00",
    google_meet_meeting: { meeting_id: "abc", join_url: "https://meet.google.com/abc-defg-hij" },
    form: [
      { field_type: "company_name", value: "テスト商事" }, { field_type: "guest_name", value: "営業 花子" },
      { field_type: "guest_email", value: email }, { field_type: "guest_comment", value: "" },
    ],
    is_changed: false, old_event_id: null, new_event_id: null, ...evOver,
  },
  ...over,
});
const m = (id) => db.rows.gw_sales_meetings.find((x) => x.id === id);
const c = (id) => db.rows.gw_sales_companies.find((x) => x.id === id);

console.log("\n=== 認証・予約枠 ===\n");

await ok("Sales の Secret なら反映する。採用HRの Secret・ヘッダー無しは 401。未設定は 503", async () => {
  setup();
  assert.equal((await hook(booked(), HR_SECRET)).statusCode, 401);
  assert.equal((await hook(booked(), null)).statusCode, 401);
  assert.equal(writes.length, 0);
  delete process.env.TIMEREX_SALES_WEBHOOK_SECRET;
  try { assert.equal((await hook(booked())).statusCode, 503); } finally { process.env.TIMEREX_SALES_WEBHOOK_SECRET = SALES_SECRET; }
  const r = await hook(booked());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.action, "scheduled");
});

await ok("営業の初回商談カレンダー以外（採用HRの予約枠など）は処理しない（422・何も書かない）", async () => {
  setup();
  for (const path of ["c0a1b2c3", "98b26445", null]) {
    const r = await hook(booked({ calendar_url_path: path }));
    assert.equal(r.statusCode, 422, String(path));
    assert.equal(r.body.error, "not_sales_calendar");
  }
  assert.equal(writes.length, 0);
  assert.equal(m("m1").status, "scheduling");
});

await ok("採用HRの Webhook に営業の予約は入らない（HR の予約枠ではない → 422）。gw_hr_interviews に書かない", async () => {
  setup();
  const r = await call(hrHook, booked(), HR_SECRET);
  assert.equal(r.statusCode, 422, JSON.stringify(r.body));
  assert.equal(r.body.error, "unknown_timerex_calendar");
  assert.equal(db.rows.gw_hr_interviews.length, 0);
  assert.equal(writes.length, 0);
  // 採用HRの面談（HR の予約枠）は Sales の Webhook に入らない
  const s = await hook(booked({ calendar_url_path: "c0a1b2c3" }));
  assert.equal(s.statusCode, 422);
});

console.log("\n=== 予約確定 → 商談予定 ===\n");

await ok("event_confirmed → 商談予定：日時・Google Meet URL・timerex_event_id・同期時刻。企業は「商談」・NEXT は商談準備", async () => {
  setup();
  const r = await hook(booked());
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.meetingId, "m1");
  const x = m("m1");
  assert.equal(x.status, "scheduled");
  assert.equal(x.scheduled_at, "2026-10-05T01:00:00.000Z");
  assert.equal(x.meeting_url, "https://meet.google.com/abc-defg-hij");
  assert.equal(x.timerex_event_id, "evt_s1");
  assert.ok(x.timerex_synced_at);
  assert.equal(c("c1").status, "meeting");
  assert.equal(c("c1").next_action, "商談準備");
  assert.equal(c("c1").next_action_on, "2026-10-05");
  const ev = db.rows.gw_sales_events;
  assert.equal(ev.length, 1);
  assert.match(ev[0].label, /^商談予定：10\/5 10:00/);
  assert.match(ev[0].detail, /TimeRexで確定/);
  assert.ok(logged.some((l) => l.action === "sales.meeting_timerex_booked" && l.detail.meetingId === "m1" && l.tenantId === T1));
  // 別の商談（m2）は変えない
  assert.equal(m("m2").status, "scheduling");
  // ログに個人情報・Meet URL を出さない
  const text = logs.join("\n") + JSON.stringify(logged);
  for (const s of ["hanako", "営業 花子", "テスト商事", "meet.google.com"]) assert.ok(!text.includes(s), s);
});

await ok("guest_email は大文字小文字を区別しない。いまの連絡手段がメールならその連絡先でも一致する", async () => {
  setup();
  assert.equal((await hook(booked({}, { id: "evt_up" }, "HANAKO@TEST-SHOJI.EXAMPLE"))).body.meetingId, "m1");
  assert.equal((await hook(booked({}, { id: "evt_t" }, "taro@mail.example"))).body.meetingId, "m2");
  assert.equal(m("m2").status, "scheduled");
});

await ok("企業のメールアドレス（emails[]・db/108）は複数のどれで予約されても照合する。列が無い企業でも壊れない", async () => {
  setup();
  c("c2").emails = ["sales@multi.example", "info@multi.example"];
  assert.equal((await hook(booked({}, { id: "evt_multi" }, "info@multi.example"))).body.meetingId, "m2");
  setup();
  c("c2").emails = ["sales@multi.example", "info@multi.example"];
  assert.equal((await hook(booked({}, { id: "evt_multi1" }, "Sales@Multi.example"))).body.meetingId, "m2");
  // 同じ予約の再送は、どのアドレスで来ても1件のまま
  const again = await hook(booked({}, { id: "evt_multi1" }, "Sales@Multi.example"));
  assert.equal(again.body.action, "resynced");
});

await ok("同じアドレスが2社の emails[] にあれば、どちらにも入れない（409・何も書かない）", async () => {
  setup();
  c("c1").emails = ["shared@group.example"];
  c("c2").emails = ["info@c2.example", "shared@group.example"];
  const r = await hook(booked({}, { id: "evt_shared" }, "shared@group.example"));
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "ambiguous_meeting");
  assert.equal(writes.length, 0);
  assert.equal(m("m1").status, "scheduling");
  assert.equal(m("m2").status, "scheduling");
});

await ok("一致しない・guest_email が無いなら何も書かない（404・400）", async () => {
  setup();
  const r = await hook(booked({}, {}, "nobody@example.jp"));
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error, "meeting_not_found");
  const noMail = booked();
  noMail.event.form = noMail.event.form.filter((f) => f.field_type !== "guest_email");
  assert.equal((await hook(noMail)).statusCode, 400);
  assert.equal(writes.length, 0);
});

await ok("日程調整中（scheduling）の商談だけが対象。予定済み・実施済み・取りやめの商談には入れない", async () => {
  setup();
  m("m1").status = "canceled";
  assert.equal((await hook(booked())).statusCode, 404);
  m("m1").status = "done";
  assert.equal((await hook(booked())).statusCode, 404);
  assert.equal(writes.length, 0);
});

await ok("候補が2件以上なら更新しない（409・何も書かない）", async () => {
  setup();
  db.rows.gw_sales_companies.push({ id: "c3", tenant_id: T1, name: "同じメールの別会社", status: "clicked",
    contacts: { email: "hanako@test-shoji.example" } });
  db.rows.gw_sales_meetings.push({ id: "m3", tenant_id: T1, company_id: "c3", kind: "first_meeting", status: "scheduling" });
  const r = await hook(booked());
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "ambiguous_meeting");
  assert.equal(writes.length, 0);
  assert.equal(m("m1").status, "scheduling");
  // 同じ会社に日程調整中の商談が2件ある場合も選ばない
  setup();
  db.rows.gw_sales_meetings.push({ id: "m1b", tenant_id: T1, company_id: "c1", kind: "first_meeting", status: "scheduling" });
  assert.equal((await hook(booked())).statusCode, 409);
});

await ok("別テナントへは書かない：別テナントに同じメールがあれば 409。書き込みは見つけた商談のテナントだけ", async () => {
  setup();
  db.rows.gw_sales_companies.push({ id: "x1", tenant_id: T2, name: "他テナント", status: "clicked",
    contacts: { email: "hanako@test-shoji.example" } });
  db.rows.gw_sales_meetings.push({ id: "xm1", tenant_id: T2, company_id: "x1", kind: "first_meeting", status: "scheduling" });
  assert.equal((await hook(booked())).statusCode, 409, "テナントをまたいで同じメールなら自動で選ばない");
  assert.equal(writes.length, 0);
  // 他テナントだけにあるメールなら、そのテナントの商談だけに書く
  setup();
  db.rows.gw_sales_companies.push({ id: "x1", tenant_id: T2, name: "他テナント", status: "clicked", contacts: { email: "only@t2.example" } });
  db.rows.gw_sales_meetings.push({ id: "xm1", tenant_id: T2, company_id: "x1", kind: "first_meeting", status: "scheduling" });
  await hook(booked({}, { id: "evt_t2" }, "only@t2.example"));
  assert.ok(writes.length > 0);
  assert.ok(writes.every((w) => (w.tenants || []).every((t) => t === T2)), JSON.stringify(writes.map((w) => w.tenants)));
  // 商談と企業のテナントが食い違う行（壊れたデータ）には書かない
  setup();
  c("c1").tenant_id = T2;
  assert.equal((await hook(booked())).statusCode, 404);
  assert.equal(writes.length, 0);
});

console.log("\n=== 再送・状態を戻さない・今回扱わないもの ===\n");

await ok("同じ event.id の再送では二重に登録・記録しない（resynced）", async () => {
  setup();
  await hook(booked());
  const n = writes.length;
  for (let i = 0; i < 3; i++) {
    const r = await hook(booked());
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.action, "resynced");
  }
  assert.equal(writes.length, n, "再送では何も書かない");
  assert.equal(db.rows.gw_sales_events.length, 1);
  assert.equal(logged.filter((l) => l.action === "sales.meeting_timerex_booked").length, 1);
  // 同じ event.id で日時・URL が違って届いたら、日時・URL・同期時刻だけを直す（記録は増やさない）
  const r = await hook(booked({}, { start_datetime: "2026-10-06T02:00:00+00:00" }));
  assert.equal(r.body.action, "updated");
  assert.equal(m("m1").scheduled_at, "2026-10-06T02:00:00.000Z");
  assert.equal(db.rows.gw_sales_events.length, 1);
});

await ok("企業の状態は前へ進めるだけ：提案は提案のまま。成約・失注・対象外・営業禁止は状態も NEXT も変えない", async () => {
  for (const [status, ng] of [["proposal", null], ["won", null], ["lost", null], ["excluded", null], ["clicked", "no_sales"]]) {
    setup();
    Object.assign(c("c1"), { status, ng_reason: ng, next_action: "元のNEXT" });
    const r = await hook(booked());
    assert.equal(r.statusCode, 200, `${status}/${ng}`);
    assert.equal(m("m1").status, "scheduled", "商談そのものは予定にする");
    assert.equal(c("c1").status, status, `${status} を戻さない`);
    assert.equal(c("c1").next_action, status === "proposal" ? "商談準備" : "元のNEXT");
  }
});

console.log("\n=== 日程変更・キャンセル ===\n");

// 日程変更：採用HRの実 payload で確認できた形（event_confirmed・is_changed・old_event_id → event.id が新しい予約）
const changed = (from = "evt_s1", to = "evt_s2", start = "2026-10-07T05:00:00+00:00", email) =>
  booked({}, { id: to, is_changed: true, old_event_id: from, new_event_id: to, start_datetime: start,
    google_meet_meeting: { join_url: "https://meet.google.com/new-room-xyz" } }, email);

await ok("日程変更：変更前の予約の商談を、新しい予約（日時・Meet URL・event.id）へ付け替える。企業の状態は変えない", async () => {
  setup();
  await hook(booked());
  const before = c("c1").status;
  const r = await hook(changed());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.action, "rescheduled");
  assert.equal(m("m1").timerex_event_id, "evt_s2");
  assert.equal(m("m1").scheduled_at, "2026-10-07T05:00:00.000Z");
  assert.equal(m("m1").meeting_url, "https://meet.google.com/new-room-xyz");
  assert.equal(m("m1").status, "scheduled");
  assert.equal(c("c1").status, before);
  assert.ok(logged.some((l) => l.action === "sales.meeting_timerex_rescheduled" && l.detail.previousEventId === "evt_s1"));
  assert.ok(!JSON.stringify(logged).includes("meet.google.com"), "監査ログに Meet URL を入れない");
});

await ok("日程変更の再送（同じ新しい予約が2回）は二重に書かない。メールが無くても、変更前の予約で決める", async () => {
  setup();
  await hook(booked());
  await hook(changed("evt_s1", "evt_s2", undefined, ""));
  const n = writes.length;
  const again = await hook(changed("evt_s1", "evt_s2", undefined, ""));
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.action, "resynced");
  assert.equal(writes.length, n);
  assert.equal(logged.filter((l) => l.action === "sales.meeting_timerex_rescheduled").length, 1);
});

await ok("日程変更で変更前の商談が無い：メールで初回と同じ照合（あれば予定にする・無ければ 404 で何も書かない）", async () => {
  setup();
  const r = await hook(changed("evt_unknown", "evt_s9"));
  assert.equal(r.body.action, "scheduled");
  assert.equal(m("m1").timerex_event_id, "evt_s9");
  setup();
  const n = await hook(changed("evt_unknown", "evt_s9", undefined, ""));
  assert.equal(n.statusCode, 404);
  assert.equal(writes.length, 0);
});

await ok("取りやめ・実施済みの商談は、日程変更で戻さない（200 ignored・何も書かない）", async () => {
  for (const st of ["canceled", "done"]) {
    setup();
    Object.assign(m("m1"), { status: st, timerex_event_id: "evt_s1", scheduled_at: "2026-10-05T01:00:00.000Z" });
    const r = await hook(changed());
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.action, "ignored", st);
    assert.equal(m("m1").status, st);
    assert.equal(writes.length, 0, st);
  }
});

await ok("キャンセルは、実ログで確かめた event 名を TIMEREX_SALES_CANCEL_WEBHOOK_TYPES に入れるまで何も書かない", async () => {
  setup();
  await hook(booked());
  const n = writes.length;
  const b = await hook(booked({ webhook_type: "event_canceled" }));
  assert.equal(b.statusCode, 200);
  assert.equal(b.body.ignored, "unsupported_webhook_type");
  assert.equal(writes.length, n);
  assert.equal(m("m1").status, "scheduled");
  assert.ok(logs.some((l) => l.includes("event_canceled")), "event 名だけは残す（実ログで確かめるため）");
  // 採用HRの変数（TIMEREX_CANCEL_WEBHOOK_TYPES）は読まない
  process.env.TIMEREX_CANCEL_WEBHOOK_TYPES = "event_canceled";
  try { assert.equal((await hook(booked({ webhook_type: "event_canceled" }))).body.ignored, "unsupported_webhook_type"); }
  finally { delete process.env.TIMEREX_CANCEL_WEBHOOK_TYPES; }
});

await ok("キャンセル（TIMEREX_SALES_CANCEL_WEBHOOK_TYPES の event）→ 商談は取りやめ。再送は二重にしない。企業の状態は変えない", async () => {
  process.env.TIMEREX_SALES_CANCEL_WEBHOOK_TYPES = "event_canceled, event_cancelled";
  try {
    setup();
    await hook(booked());
    const st = c("c1").status;
    const r = await hook(booked({ webhook_type: "event_canceled" }));
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.body.action, "canceled");
    assert.equal(m("m1").status, "canceled");
    assert.equal(c("c1").status, st);
    const n = writes.length;
    const again = await hook(booked({ webhook_type: "event_cancelled" }));
    assert.equal(again.body.action, "resynced");
    assert.equal(writes.length, n);
    assert.equal(logged.filter((l) => l.action === "sales.meeting_timerex_canceled").length, 1);
    // 知らない予約のキャンセルは何も書かない（404）。実施済みは戻さない
    assert.equal((await hook(booked({ webhook_type: "event_canceled" }, { id: "evt_x" }))).statusCode, 404);
    setup();
    Object.assign(m("m1"), { status: "done", timerex_event_id: "evt_s1" });
    assert.equal((await hook(booked({ webhook_type: "event_canceled" }))).body.action, "ignored");
    assert.equal(m("m1").status, "done");
  } finally { delete process.env.TIMEREX_SALES_CANCEL_WEBHOOK_TYPES; }
});

await ok("壊れた body・start_datetime 無しは 400", async () => {
  setup();
  assert.equal((await hook(null)).statusCode, 400);
  assert.equal((await hook(booked({}, { start_datetime: null }))).statusCode, 400);
});

await ok("DEBUG ログは TIMEREX_SALES_WEBHOOK_DEBUG_LOG=1 のときだけ（形だけ。個人情報は出さない）", async () => {
  setup();
  await hook(booked());
  assert.ok(!logs.some((l) => l.includes("[sales-timerex-webhook][debug]")));
  process.env.TIMEREX_SALES_WEBHOOK_DEBUG_LOG = "1";
  try {
    setup();
    await hook(booked());
    const d = logs.find((l) => l.includes("[sales-timerex-webhook][debug]"));
    assert.ok(d && d.includes("evt_s1") && !d.includes("hanako") && !d.includes("meet.google.com"));
  } finally { delete process.env.TIMEREX_SALES_WEBHOOK_DEBUG_LOG; }
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
