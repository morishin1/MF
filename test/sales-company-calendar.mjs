import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
  googleCalendarEventUrl,normalizeMeetingUrl,validateMeetingCalendarInput
} from "../lib/sales-meeting-calendar.js";

const before=Date.parse("2026-11-08T00:00:00Z");
const input={scheduledAt:"2026-11-10T14:00:00+09:00",meetingUrl:"https://meet.google.com/abc-defg-hij",durationMin:60};

test("Google Calendar prefilled event preserves JST meeting time and meeting URL",()=>{
 const v=validateMeetingCalendarInput(input,before);
 assert.ok(v.value);
 assert.equal(v.value.scheduledAt,"2026-11-10T05:00:00.000Z");
 const link=googleCalendarEventUrl({
  companyName:"55株式会社",
  scheduledAt:v.value.scheduledAt,durationMin:v.value.durationMin,
  meetingUrl:v.value.meetingUrl,
  companyMeetingUrl:"https://enger.jp/business/meeting?companyId=5fa673dd-2fbf-476b-bb1c-76c8117fddd6",
 });
 const parsed=new URL(link);
 assert.equal(parsed.hostname,"calendar.google.com");
 assert.equal(parsed.searchParams.get("action"),"TEMPLATE");
 assert.equal(parsed.searchParams.get("dates"),"20261110T050000Z/20261110T060000Z");
 assert.equal(parsed.searchParams.get("stz"),"Asia/Tokyo");
 assert.equal(parsed.searchParams.get("etz"),"Asia/Tokyo");
 assert.match(parsed.searchParams.get("text"),/55株式会社/);
 assert.match(parsed.searchParams.get("details"),/https:\/\/meet.google.com\/abc-defg-hij/);
 assert.match(parsed.searchParams.get("details"),/ログイン必須/);
 assert.doesNotMatch(parsed.searchParams.get("details"),/temporaryPassword|service_role|Authorization/);
});
test("bad times, old events and unsupported durations are rejected",()=>{
 assert.equal(validateMeetingCalendarInput({...input,scheduledAt:"2026-11-10T14:00"},before).error,"bad_date");
 assert.equal(validateMeetingCalendarInput({...input,scheduledAt:"2026-11-01T14:00:00+09:00"},before).error,"past_date");
 assert.equal(validateMeetingCalendarInput({...input,durationMin:241},before).error,"bad_duration");
});
test("online meeting link may be empty but must be safe HTTPS",()=>{
 assert.equal(normalizeMeetingUrl(""),null);
 assert.equal(normalizeMeetingUrl("javascript:alert(1)"),false);
 assert.equal(normalizeMeetingUrl("http://meet.google.com/test"),false);
 assert.equal(normalizeMeetingUrl("https://user:password@meet.google.com/test"),false);
 assert.equal(normalizeMeetingUrl("https://meet.google.com/abc-defg-hij"),"https://meet.google.com/abc-defg-hij");
});
test("Calendar button remains separate from real Google event creation",()=>{
 const ui=readFileSync(new URL("../js/sales-company-meeting-calendar.js",import.meta.url),"utf8");
 const api=readFileSync(new URL("../api/sales/company-meeting-calendar.js",import.meta.url),"utf8");
 const compact=readFileSync(new URL("../js/sales-company-compact-proposal.js",import.meta.url),"utf8");
 assert.match(ui,/Googleカレンダーに追加/);
 assert.match(ui,/予定の内容を確認して「保存」/);
 assert.match(ui,/window\.open/);
 assert.match(api,/gw_sales_meetings/);
 assert.match(api,/companyInScope/);
 assert.match(api,/source_company_id/);
 assert.match(api,/timerex_managed/);
 assert.match(compact,/mountMeetingCalendar/);
});
