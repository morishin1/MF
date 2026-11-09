// Sales meeting activity statistics. Each metric is counted by its OWN event
// timestamp; do not present these unrelated populations as a conversion funnel.
export const MEETING_METRICS = Object.freeze([
  {key:"published",label:"候補を公開",unit:"件",note:"現在も公開中で、期間内に公開した人材・案件。非公開に戻した記録は含みません。"},
  {key:"started",label:"商談開始",unit:"件",note:"期間内に開始したSalesの商談セッション。"},
  {key:"sent",label:"提案メール送信",unit:"件",note:"期間内に送信成功した企業向け商談案内メール。"},
  {key:"offer",label:"オファー希望",unit:"件",note:"商談のクロージングで「オファーあり」を記録し、案内メールを送信した件数。成約数ではありません。"},
]);
export const MEETING_KEYS=MEETING_METRICS.map(x=>x.key);
const blank=()=>Object.fromEntries(MEETING_KEYS.map(x=>[x,0]));
const dayJst=iso=>{
  const n=Date.parse(iso||"");
  return Number.isFinite(n)?new Date(n+9*3600000).toISOString().slice(0,10):null;
};
const cleanId=id=>/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(id||""))?id:null;
const inside=(at,p)=>{
  const n=Date.parse(at||"");
  return Number.isFinite(n)&&n>=Date.parse(p.sinceIso)&&n<Date.parse(p.untilIso);
};
export function buildMemberMeetingAnalysis({
  period,employees=[],teamMemberIds=[],shortlists=[],sessions=[],closeouts=[],aiSummaries=[],
  manager=false,viewerAuthId=null,
}){
  const names=new Map(employees.filter(p=>p.user_id).map(p=>[p.user_id,{id:p.id,name:p.display_name||"氏名未登録"}]));
  const members=new Map(), allEvents=[];
  const ensure=authId=>{
    if(!manager&&authId!==viewerAuthId)return null;
    const key=authId||"unassigned";
    if(!members.has(key)){
      const employee=names.get(key);
      members.set(key,{
        employeeId:employee?.id||null,
        name:employee?.name||(authId===viewerAuthId?"自分（社員登録未確認）":"実施者未登録"),
        totals:blank(),days:{},evidence:Object.fromEntries(MEETING_KEYS.map(k=>[k,[]])),
      });
    }
    return members.get(key);
  };
  if(!manager&&viewerAuthId)ensure(viewerAuthId);
  if(manager){
    const active=new Set(teamMemberIds);
    for(const emp of employees)if(emp.user_id&&active.has(emp.id))ensure(emp.user_id);
  }
  const record=(authId,metric,at,id,companyId)=>{
    if(!MEETING_KEYS.includes(metric)||!inside(at,period))return;
    const m=ensure(authId);
    if(!m)return;
    m.totals[metric]++;
    const day=dayJst(at);
    (m.days[day] ||= blank())[metric]++;
    const item={metric,at,companyId:cleanId(companyId),recordId:cleanId(id)};
    // Keep bounded evidence for the detail dialog, newest items first below.
    m.evidence[metric].push(item);
    allEvents.push({metric,day});
  };
  for(const x of shortlists)record(x.published_by,"published",x.published_at,x.id,x.company_id);
  for(const x of sessions)record(x.started_by,"started",x.started_at,x.id,x.company_id);
  for(const x of closeouts)if(x.mail_status==="sent"){
    record(x.created_by,"sent",x.mail_sent_at,x.id,x.company_id);
    if(x.outcome==="offer")record(x.created_by,"offer",x.mail_sent_at,x.id,x.company_id);
  }
  const result=[...members.values()].map(m=>{
    for(const k of MEETING_KEYS)m.evidence[k]=m.evidence[k]
      .sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,100);
    return m;
  }).sort((a,b)=>b.totals.sent-a.totals.sent||b.totals.started-a.totals.started||a.name.localeCompare(b.name,"ja"));
  const totals=blank(),days={};
  for(const m of result){
    for(const k of MEETING_KEYS)totals[k]+=m.totals[k];
    for(const [date,metrics] of Object.entries(m.days)){
      const d=days[date] ||= blank();
      for(const k of MEETING_KEYS)d[k]+=metrics[k]||0;
    }
  }
  return {
    period:{from:period.from,to:period.to,key:period.key},
    manager,metrics:MEETING_METRICS,totals,days,members:result,
    aiAnalysis:manager?{
      completed:aiSummaries.filter(x=>x.status==="completed"&&inside(x.processed_at,period)).length,
      attribution:"AI分析は保存済み企業単位で集計。既存データには実行者IDがないため担当者別には計上できません。",
    }:null,
    note:"担当者は操作時の記録から特定します。候補公開・商談開始・メール送信は日時と母集団が異なるため、段階間の割り算を成約率として表示しません。",
  };
}
