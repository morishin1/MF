import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolveProposalPeriod,proposalsForPeriod,countOutsideStalled,sentInProposalPeriod} from "../lib/sales-proposal-period.js";
import {countFilters,filterRows} from "../lib/sales-proposals.js";

const J=s=>new Date(s+"+09:00").toISOString();
const NOW=new Date(J("2026-11-11T14:00:00"));
const p=(id,sentAt,extras={})=>({id,sentAt,archived:false,closed:false,status:"call_wait",overdue:false,
 handoffStage:"cs",next:null,service:"ENGER",...extras});
const rows=[
 p("mon",J("2026-11-09T00:00:00"),{overdue:true}),
 p("wed",J("2026-11-11T13:20:00"),{status:"meeting_adjust"}),
 p("sun",J("2026-11-08T23:59:59"),{overdue:true}),
 p("last-month",J("2026-10-16T10:00:00"),{overdue:true}),
 p("unsent",null,{status:"proposal_wait",overdue:true,matchedAt:J("2026-11-11T12:00:00")}),
 p("old-closed",J("2026-10-12T12:00:00"),{closed:true,status:"won",overdue:false}),
 p("old-archived",J("2026-10-10T12:00:00"),{archived:true,overdue:true})
];

test("JST sent date, Monday boundary and timestamp precision: matching date never replaces missing sentAt",()=>{
 const period=resolveProposalPeriod("this_week",{},NOW);
 assert.deepEqual([period.from,period.to],["2026-11-09","2026-11-11"]);
 assert.equal(period.sinceIso,J("2026-11-09T00:00:00"));
 assert.deepEqual(proposalsForPeriod(rows,period).map(r=>r.id),["mon","wed"]);
 assert.equal(sentInProposalPeriod(rows[4],period),false);
 assert.equal(sentInProposalPeriod({sentAt:J("2026-11-12T00:00:00")},period),false);
});

test("all list and each stage count use the very same period-scoped proposal collection",()=>{
 const period=resolveProposalPeriod("this_week",{},NOW);
 const scoped=proposalsForPeriod(rows,period);
 const counts=countFilters(scoped,{now:NOW.toISOString(),manager:true});
 assert.equal(counts.all,2);
 assert.equal(counts.overdue,1);
 assert.equal(counts.meeting,1);
 assert.equal(counts.proposal_wait,0);
 assert.deepEqual(filterRows(scoped,{filter:"overdue",now:NOW.toISOString()}).map(r=>r.id),["mon"]);
 assert.deepEqual(filterRows(scoped,{filter:"all",now:NOW.toISOString()}).map(r=>r.id),["mon","wed"]);
});

test("outside-stalled count preserves existing overdue rule and ignores archived/closed, click means all proposals",()=>{
 const week=resolveProposalPeriod("this_week",{},NOW);
 assert.equal(countOutsideStalled(rows,week),3); // sun, last-month, unsent
 assert.equal(countOutsideStalled(rows,resolveProposalPeriod("all",{},NOW)),0);
 assert.deepEqual(proposalsForPeriod(rows,resolveProposalPeriod("all",{},NOW)).map(r=>r.id),rows.map(r=>r.id));
 assert.equal(resolveProposalPeriod("unknown",{},NOW).error,"bad_period");
});

test("month filtering includes only submissions whose sentAt was in month; service/owner filtering stays independent",()=>{
 const month=resolveProposalPeriod("this_month",{},NOW);
 assert.deepEqual(proposalsForPeriod(rows,month).map(r=>r.id),["mon","wed","sun"]);
 assert.equal(countOutsideStalled(rows,month),2);
 const october=resolveProposalPeriod("last_month",{},NOW);
 assert.deepEqual(proposalsForPeriod(rows,october).map(r=>r.id),["last-month","old-closed","old-archived"]);
});

test("server filters before status counts and excludes historical rows; legacy clients remain all-period",()=>{
 const api=readFileSync(new URL("../api/sales/proposals/index.js",import.meta.url),"utf8");
 assert.match(api,/const periodScope=proposalsForPeriod\(serviceScope,period\)/);
 assert.match(api,/const counts=countFilters\(periodScope,\{now,manager\}\)/);
 assert.match(api,/const visible=filterRows\(periodScope,\{filter,now\}\)/);
 assert.match(api,/outsideStalledCount=countOutsideStalled\(serviceScope,period\)/);
 assert.match(api,/sp\.get\("period"\)\|\|"all"/);
 assert.match(api,/const explicitPeriod=sp\.has\("period"\)/);
 assert.match(api,/period:\{key:period\.key,label:period\.label/);
 assert.match(api,/periodIds\.has\(t\.proposal_id\)/);
});

test("UI period selector drives API, stage badges and outside-period count link, never silently mixes rows",()=>{
 const page=readFileSync(new URL("../sales/proposals.html",import.meta.url),"utf8");
 assert.match(page,/id="f-period"/);
 assert.match(page,/STATE = \{ filter: "all", period:"all"/);
 assert.match(page,/period:STATE\.period/);
 assert.match(page,/d\.outsideStalledCount/);
 assert.match(page,/期間外で止まっている提案 /);
 assert.match(page,/ppAllPeriods\(\)/);
 assert.match(page,/STATE\.period="all";STATE\.filter="all"/);
 assert.match(page,/\$\("f-period"\)\.value=STATE\.period/);
});
