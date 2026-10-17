// GW-05: 休暇のGoogle Calendar予定は、DBへのevent id保存前に再実行されても重複させない。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);

mock.module(atRoot("lib/gdrive.js"), { namedExports: {
  hasCredentials: () => true,
  getAccessToken: async () => "token",
}});

process.env.GCAL_CALENDAR_ID = "calendar@example.test";

const calls = [];
const made = new Set();
global.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url, method, body });
  if (method === "POST") {
    const id = body?.id || "random";
    if (made.has(id)) {
      return new Response(JSON.stringify({ error: { message: "The requested identifier already exists." } }), {
        status: 409, headers: { "content-type": "application/json" },
      });
    }
    made.add(id);
    return new Response(JSON.stringify({ id, htmlLink: "https://calendar.example/" + id }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  if (method === "PATCH") {
    const id = decodeURIComponent(url.split("/events/")[1] || "");
    return new Response(JSON.stringify({ id, htmlLink: "https://calendar.example/" + id }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  if (method === "DELETE") return new Response("", { status: 204 });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

const { stableLeaveEventId, syncAllDay } = await import(atRoot("lib/gcal.js"));

const record = {
  id: "12345678-1234-4abc-8def-1234567890ab",
  gcal_event_id: null,
  gcal_calendar_id: null,
};
const stable = stableLeaveEventId(record);
assert.equal(stable, "leave1234567812344abc8def1234567890ab");
assert.equal(stableLeaveEventId({ id: "legacy-id" }), null);

const args = {
  record, action: "upsert",
  summary: "山田さん 休暇", description: "test",
  startsOn: "2026-10-20", endsOn: "2026-10-20",
};
const first = await syncAllDay(args);
assert.equal(first.error, null);
assert.equal(first.eventId, stable);
assert.equal(calls.filter((c) => c.method === "POST").length, 1);

const second = await syncAllDay(args);
assert.equal(second.error, null);
assert.equal(second.eventId, stable);
assert.equal(second.reused, true, "2回目は409を新規作成失敗にせず、同じ予定を更新する");
assert.equal(calls.filter((c) => c.method === "POST").length, 2, "再実行でも同じ固定IDでPOSTを試す");
assert.equal(calls.filter((c) => c.method === "PATCH").length, 1, "既存ならPATCHへ切り替える");
assert.ok(calls.filter((c) => c.method === "POST").every((c) => c.body.id === stable), "毎回同じevent id");

console.log("すべて通過");
