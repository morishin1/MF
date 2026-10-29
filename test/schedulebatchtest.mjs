// カレンダーの複数予定一括保存を守る（1〜30件／すべて検証してから一括INSERT）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { prepareCalendarBatch, MAX_CALENDAR_BATCH } from "../lib/schedule-batch.js";

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const read=p=>readFileSync(resolve(ROOT,p),"utf8");
const normalize=x=>{
  if(!x.title?.trim())return {error:"invalid_body",hint:"件名を入力してください"};
  if(x.visibility!=="shared")return {error:"invalid_visibility",hint:"全社員共有のみ"};
  const start=Date.parse(x.startsAt),end=Date.parse(x.endsAt);
  if(!Number.isFinite(start)||!Number.isFinite(end))return {error:"invalid_time",hint:"日時が不正です"};
  return {value:{title:x.title.trim(),starts_at:new Date(start).toISOString(),
    ends_at:new Date(end).toISOString(),location:x.location||null,visibility:"shared",category:x.category||"work"}};
};
const event=(title,date="2026-10-20",start="09:00",end="10:00")=>({
  title,startsAt:date+"T"+start+":00+09:00",endsAt:date+"T"+end+":00+09:00",
  location:null,category:"work",visibility:"shared",
});
assert.equal(MAX_CALENDAR_BATCH,30);
assert.equal(prepareCalendarBatch([event("訪問"),event("打合せ","2026-10-21")],normalize).rows.length,2);
assert.equal(prepareCalendarBatch([],normalize).error,"invalid_batch");
assert.equal(prepareCalendarBatch(Array.from({length:31},(_,i)=>event("予定"+i)),normalize).error,"invalid_batch");
assert.equal(prepareCalendarBatch([event("重複"),event("重複")],normalize).error,"duplicate_in_batch");
assert.equal(prepareCalendarBatch([event("正常"),{...event("私用"),visibility:"private"}],normalize).error,"invalid_visibility");
assert.equal(prepareCalendarBatch([event("正常"),event("逆時間","2026-10-20","12:00","10:00")],normalize).error,"invalid_time");
assert.equal(prepareCalendarBatch([event("正常"),event("")],normalize).error,"invalid_body");
assert.equal(prepareCalendarBatch([event("A"),event("B")],normalize).rows.length,2);

const api=read("api/schedule/index.js"),html=read("calendar.html");
assert(api.includes('body?.action === "batch_create"')&&api.includes('prepareCalendarBatch(events, normalize)'),
  "既存と同じ検証ロジックを一括保存でも使用");
assert(api.includes('.insert(rows).select(FIELDS)'),"一度のINSERTで全件保存");
assert(api.includes('tenant_id: ctx.tenantId, employee_id: ctx.employee.id'),"テナントと所有者をサーバで固定");
assert(html.includes('id="cal-new"')&&html.includes('id="cal-batch-panel"'),
  "カレンダーに複数予定の入力導線");
assert(html.includes('if(scope!=="mine")closeBatch()'),"全社員モードでは一括入力を閉じる");
assert(html.includes('action:"batch_create",events:entries'),"一度にまとめて登録");
assert(html.includes('if(!title&&!location&&!quantity)continue'),"完全な空欄行だけを無視し、数字だけの入力は検証する");
const inline=html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/);
assert(inline,"カレンダーの画面スクリプト");
new Function(inline[1]);
console.log("PASS カレンダー一括入力：30件制限・全件検証・権限・複数日・画面構文");
