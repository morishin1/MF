// Member-calendar rendering and privacy smoke test; no browser or real database.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const base=dirname(dirname(fileURLToPath(import.meta.url)));
const script=readFileSync(join(base,"js/calendar-team-board.js"),"utf8");
const nodes={};
function control(){
  return {value:"",hidden:false,dataset:{},innerHTML:"",listeners:{},
    addEventListener(kind,fn){this.listeners[kind]=fn;},
    querySelector(sel){const sub=this.sub||(this.sub={});return sub[sel]||(sub[sel]=control());}};
}
const doc={getElementById(id){return nodes[id]||(nodes[id]=control());}};
const window={};
runInNewContext(script,{window,document:doc});
const board=window.CalendarTeamBoard;
assert.ok(board?.render&&board?.keep&&board?.sync,"render API exists");

const people=[{id:"a",name:"営業A",department:"営業"},{id:"b",name:"企画B",department:"企画"}];
const events=[
  {employeeId:"a",title:"訪問 & 面談",location:"新宿 <本社>",allDay:false,startsAt:"2026-10-22T00:00:00Z",endsAt:"2026-10-22T01:00:00Z"},
  {employeeId:"b",title:"企画会議",location:"オンライン",allDay:false,startsAt:"2026-10-22T05:00:00Z",endsAt:"2026-10-22T06:00:00Z"}
];
let redraws=0;board.sync(people,()=>{redraws++;},"team");
const makeRoot=()=>({innerHTML:"",querySelectorAll(){return[];}});
const week=makeRoot();
board.render("week",{root:week,dates:["2026-10-22"],dayLabel:()=> "10月22日（木）",events,open(){}});
assert.match(week.innerHTML,/営業A/);
assert.match(week.innerHTML,/企画B/);
assert.match(week.innerHTML,/09:00–10:00/);
assert.match(week.innerHTML,/訪問 &amp; 面談/);
assert.match(week.innerHTML,/新宿 &lt;本社&gt;/,"HTML escapes event location");
assert.doesNotMatch(week.innerHTML,/<本社>/);
const day=makeRoot();
board.render("day",{root:day,day:"2026-10-22",events,open(){}});
assert.match(day.innerHTML,/午前/);assert.match(day.innerHTML,/午後/);assert.match(day.innerHTML,/夕方以降/);

const input=nodes["cal-team-tools"].querySelector("#ct-search");
input.listeners.input({target:{value:"企画"}});
assert.equal(redraws,1);
assert.equal(board.keep(events[0]),false,"name filter excludes other person");
assert.equal(board.keep(events[1]),true,"name filter includes selected person");
board.sync(people,()=>{},"mine");
assert.equal(nodes["cal-team-tools"].hidden,true,"controls hidden in personal scope");
console.log("PASS Calendar member-by-day/week board, filtering, escaping, private UI");
