// No browser or network. Verify the exported page and its memory-only adapter.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
const root=new URL("../",import.meta.url),read=p=>readFileSync(new URL(p,root),"utf8");
const dir=mkdtempSync(join(tmpdir(),"nippo-plan-preview-test-"));
try{
  execFileSync(process.execPath,[new URL("scripts/build-nippo-plan-preview.mjs",root).pathname,dir]);
  const html=readFileSync(join(dir,"index.html"),"utf8");
  assert.match(html,/connect-src 'none'/);assert.match(html,/本番.*接続や通知はありません/);
  assert.doesNotMatch(html,/<(?:script|link)[^>]*(?:src|href)=|\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(|\b(?:localStorage|sessionStorage|indexedDB)\b/);
  for(const path of ["js/calendar-quantity.js","js/nippo-schedule.js"])assert.ok(html.includes(read(path)),path+" embedded unchanged");
  for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
  const c=vm.createContext({});c.window=c;
  vm.runInContext(read("scripts/nippo-plan-preview-mock.js"),c);
  vm.runInContext(read("js/nippo-schedule.js"),c);
  const initial=c.PreviewPlans.read();assert.equal(initial.length,2);
  const fields={title:"合成追加",startsAt:initial[0].starts_at,endsAt:initial[0].ends_at,plannedQuantity:0,plannedQuantityUnit:null};
  const created=await c.API.createEvent(fields);assert.equal(created.event.planned_quantity,0);
  await c.API.updateEvent({id:created.event.id,...fields,plannedQuantity:3,plannedQuantityUnit:"件"});
  const list=await c.API.schedule(initial[0].starts_at,"2999-01-01T00:00:00Z");assert.equal(list.events.length,3);assert.equal(list.quantityAvailable,true);
  const items=list.events.map(e=>({schedule_event_id:e.id,task:e.title,target:e.planned_quantity,unit:e.planned_quantity_unit||""}));
  const first=c.NippoSchedule.inherit([],{status:"available",items});assert.equal(first.items[0].actual,null);assert.equal(first.items[0].actual_minutes,null);
  first.items[0].actual=8;first.items[0].actual_minutes=75;
  const second=c.NippoSchedule.inherit(first.items,{status:"available",items:items.map(r=>({...r,target:999}))});
  assert.equal(second.items.length,3);assert.equal(second.items[0].target,10);assert.equal(second.items[0].actual,8);assert.equal(second.items[0].actual_minutes,75);
  await c.API.deleteEvent(created.event.id);assert.equal(c.PreviewPlans.read().length,2);
  assert.match(c.NippoSchedule.rowHtml(second.items[0],c.KPLayout.esc),/システム実績：未接続・未確認/);
  console.log("preview assembly, CSP, shared helpers, memory CRUD and snapshot preservation passed (no browser)");
}finally{rmSync(dir,{recursive:true,force:true});}
