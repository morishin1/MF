import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {buildMemberMeetingAnalysis,MEETING_KEYS} from "../lib/sales-meeting-funnel-analysis.js";

const code=p=>readFileSync(new URL(p,import.meta.url),"utf8");
const api=code("../api/sales/meeting-funnel-analysis.js");
const html=code("../sales/index.html");
const dashboardTabs=code("../js/sales-dashboard-tabs.js");
const ui=code("../js/sales-meeting-funnel.js");
const id=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const period={from:"2026-11-01",to:"2026-11-09",sinceIso:"2026-10-31T15:00:00.000Z",untilIso:"2026-11-09T15:00:00.000Z",key:"custom"};

const records={
 period,
 employees:[{id:id(1),user_id:id(11),display_name:"担当A"},{id:id(2),user_id:id(12),display_name:"担当B"}],
 shortlists:[
  {id:id(101),company_id:id(201),published_by:id(11),published_at:"2026-11-05T00:00:00Z"},
  {id:id(102),company_id:id(202),published_by:id(12),published_at:"2026-11-05T01:00:00Z"}
 ],
 sessions:[
  {id:id(301),company_id:id(201),started_by:id(11),started_at:"2026-11-05T02:00:00Z"},
  {id:id(302),company_id:id(202),started_by:id(12),started_at:"2026-11-06T02:00:00Z"}
 ],
 closeouts:[
  {id:id(401),company_id:id(201),created_by:id(11),mail_status:"sent",mail_sent_at:"2026-11-05T03:00:00Z",outcome:"offer"},
  {id:id(402),company_id:id(202),created_by:id(12),mail_status:"sent",mail_sent_at:"2026-11-06T03:00:00Z",outcome:"considering"},
  {id:id(403),company_id:id(201),created_by:id(11),mail_status:"failed",mail_sent_at:"2026-11-06T03:00:00Z",outcome:"offer"},
 ],
 aiSummaries:[{company_id:id(201),status:"completed",processed_at:"2026-11-05T01:00:00Z"}],
};

test("member report attributes actions to real actors and counts only sent closeouts",()=>{
 const x=buildMemberMeetingAnalysis({...records,manager:true});
 assert.deepEqual(MEETING_KEYS,["published","started","sent","offer"]);
 assert.deepEqual(x.totals,{published:2,started:2,sent:2,offer:1});
 assert.equal(x.aiAnalysis.completed,1);
 assert.match(x.aiAnalysis.attribution,/実行者IDがない/);
 assert.equal(x.members.find(m=>m.name==="担当A").totals.offer,1);
 assert.equal(x.members.find(m=>m.name==="担当B").totals.offer,0);
 assert.equal(x.members.find(m=>m.name==="担当A").days["2026-11-05"].started,1);
});

test("ordinary Sales user never receives another employee's history or team AI count",()=>{
 const x=buildMemberMeetingAnalysis({...records,manager:false,viewerAuthId:id(11)});
 assert.equal(x.members.length,1);
 assert.equal(x.members[0].name,"担当A");
 assert.deepEqual(x.totals,{published:1,started:1,sent:1,offer:1});
 assert.equal(x.aiAnalysis,null);
 assert.ok(x.members[0].evidence.sent.every(e=>e.companyId===id(201)));
});
test("out-of-range events are excluded and offer hope is not a sale",()=>{
 const x=buildMemberMeetingAnalysis({...records,
   closeouts:[...records.closeouts,{id:id(404),company_id:id(201),created_by:id(11),mail_status:"sent",mail_sent_at:"2026-10-20T01:00:00Z",outcome:"offer"}],
   manager:true
 });
 assert.equal(x.totals.offer,1);
 assert.match(x.metrics.find(m=>m.key==="offer").note,/成約数ではありません/);
 assert.match(x.note,/割り算を成約率として表示しません/);
});
test("API bounds tenant and employee identity server-side",()=>{
 assert.match(api,/requireUser/);
 assert.match(api,/canSell\(ctx\)/);
 assert.match(api,/isOwner\(ctx\)/);
 assert.match(api,/roles\|\|\[\]\)\.includes\("manager"\)/);
 assert.doesNotMatch(api,/canManageProposals/);
 assert.match(api,/q\.eq\(col,user\.id\)/);
 assert.match(api,/eq\("tenant_id",tenant\)/);
 assert.match(api,/\.eq\("user_id",user\.id\)/);
 assert.match(api,/resolvePeriod/);
 assert.doesNotMatch(api,/query\.get\("employeeId"\)/);
});
test("existing Sales detailed analysis loads staff graphs and evidence dialog",()=>{
 assert.match(html,/id="db-panel-analysis"/);
 assert.match(html,/id="sm-funnel"/);
 assert.match(html,/id="sm-member"/);
 assert.match(html,/id="sm-detail-dialog"/);
 assert.match(html,/js\/sales-meeting-funnel\.js/);
 assert.match(dashboardTabs,/SalesMeetingFunnel\?\.load\(\)/);
 assert.match(ui,/meeting-funnel-analysis\?/);
 assert.match(ui,/sm-member-bars/);
 assert.match(ui,/showModal\(\)/);
 assert.match(ui,/target="_blank"/);
});
