// Read-only classification. Legacy buckets and name matches are candidates, never verified IDs.
export const ACTIVE_STAGES=new Set(['提案中','確認中','面談','合格','所属確認','提案済','返信待ち','返信あり','面談調整','クロージング中','面談合格']);
const clean=v=>String(v??'').trim();
const normalize=v=>clean(v).normalize('NFKC').replace(/\s+/g,'').toLowerCase();
export function buildLifecycle({directory,contacts,proposals,links=[],sales=[],employees=[],jobs=[]}){
 const contactMap=new Map(contacts.map(c=>[c.id,c]));
 const names=new Map(employees.map(e=>[e.id,e.display_name]));
 const salesMap=new Map(sales.map(s=>[s.id,s]));
 const linked=new Map();
 for(const l of links){if(linked.has(l.source_company_id))throw Error('ambiguous_company_link');linked.set(l.source_company_id,l.company_id);}
 const byId=new Map(),unlinked=new Map(),jobsById=new Map(jobs.map(j=>[j.id,j]));
 for(const p of proposals){
  if(!ACTIVE_STAGES.has(p.stage))continue;
  const job=jobsById.get(p.job_id);
  const item={id:p.id,stage:p.stage,updatedAt:p.updated_at,jobStatus:job?.status||null,jobDeleted:Boolean(job?.deleted_at)};
  if(p.company_id){if(!byId.has(p.company_id))byId.set(p.company_id,[]);byId.get(p.company_id).push(item);}
  else {const name=clean(p.company)||'提案先名未登録',key=normalize(name);if(!unlinked.has(key))unlinked.set(key,{name,proposals:[]});unlinked.get(key).proposals.push(item);}
 }
 const rows=directory.map(d=>{
  const c=contactMap.get(d.id);if(!c)throw Error('contact_source_incomplete');
  const s=salesMap.get(linked.get(d.id));
  const active=byId.get(d.id)||[];
  const segment=active.length||d.relationship_status==='active'?'current':d.relationship_status==='past'?'past':'pending';
  const emails=s?(s.emails||[]):[c.contact_email];
  const email=emails.some(x=>clean(x)),phone=Boolean(clean(s?s.phone:c.phone)),form=Boolean(clean(s?s.form_url:c.contact_form_url));
  const blocked=Boolean(d.needs_contact_review||s?.hidden_at||s?.ng_reason);
  const reason=active.length?'企業IDに紐づく進行中提案':d.relationship_status==='active'?'根拠付きの取引中確認':d.relationship_status==='past'?'根拠付きの過去取引確認':d.classification_basis||'営業履歴・提案との照合待ち';
  return {id:d.id,companyId:d.id,salesId:s?.id||null,name:d.name,segment,legacyBucket:d.bucket,confirmed:segment!=='pending',
   reason,relationship:d.relationship_status||'unknown',relationshipEvidence:d.relationship_evidence||null,
   industry:d.industry||null,region:d.prefecture||null,priority:d.effective_priority||null,
   email,phone,form,contactKnown:true,hasContact:email||phone||form,blocked,siSes:Boolean(d.si_ses_candidate),
   lastContact:c.last_contacted_at||d.historical_contact_date||null,lastContactKind:c.last_contacted_at?'最終連絡':'旧資料の接点',
   owner:s?.owner_id?names.get(s.owner_id)||'担当名未取得':'',nextDate:s?.next_action_on||'',
   nextAction:s?.next_action||(blocked?'連絡停止・注意内容を確認':active.length?'進捗・返答を確認':!(email||phone||form)?'連絡先を調査':d.bucket==='revive'?'過去の接点・再開理由を確認':'営業履歴を確認して初回連絡を準備'),
   proposals:active,candidateIds:[],historicalCount:Number(d.historical_activity_count||0)};
 });
 const nameMap=new Map();for(const r of rows){const n=normalize(r.name);if(!nameMap.has(n))nameMap.set(n,[]);nameMap.get(n).push(r);}
 const activities=[...unlinked.entries()].map(([key,a])=>({id:'activity:'+key,companyId:null,salesId:null,name:a.name,segment:'current',confirmed:false,
  reason:'ENGER進行中。企業IDは未照合',legacyBucket:null,contactKnown:false,email:false,phone:false,form:false,hasContact:false,blocked:false,
  candidateIds:(nameMap.get(key)||[]).map(r=>({id:r.id,name:r.name})),proposals:a.proposals,
  lastContact:null,lastContactKind:'提案更新は連絡実績とは別',owner:'',nextDate:'',nextAction:'企業ID・担当者・提案の進捗を確認'}));
 return {rows,activities,counts:{total:rows.length,current:rows.filter(r=>r.segment==='current').length,
  activityNames:activities.length,activeProposals:proposals.filter(p=>ACTIVE_STAGES.has(p.stage)).length,
  past:rows.filter(r=>r.segment==='past').length,pastCandidates:rows.filter(r=>r.segment==='pending'&&r.legacyBucket==='revive').length,
  futureCandidates:rows.filter(r=>r.segment==='pending'&&r.legacyBucket==='new').length,pending:rows.filter(r=>r.segment==='pending').length,
  contact:rows.filter(r=>r.hasContact).length,blocked:rows.filter(r=>r.blocked).length}};
}
export function selectLifecycle(model,params){
 const segment=params.get('segment')||'current',page=Number(params.get('page')||1),contact=params.get('contact')||'',quick=params.get('quick')||'',sort=params.get('sort')||'action';
 if(!['current','past','future','pending','all'].includes(segment)||!Number.isInteger(page)||page<1||page>1000||!['','yes','no','unknown'].includes(contact)||!['','unassigned','today','overdue','blocked'].includes(quick)||!['action','name','last'].includes(sort))throw Error('invalid_filter');
 const q=clean(params.get('q')).slice(0,100).toLowerCase(),today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 let rows=segment==='current'?[...model.rows.filter(r=>r.segment==='current'),...model.activities]:model.rows.filter(r=>segment==='all'||segment==='past'&&(r.segment==='past'||r.segment==='pending'&&r.legacyBucket==='revive')||segment==='future'&&r.segment==='pending'&&r.legacyBucket==='new'||segment==='pending'&&r.segment==='pending');
 rows=rows.filter(r=>(!q||r.name.toLowerCase().includes(q))&&(!contact||contact==='yes'&&r.hasContact||contact==='no'&&r.contactKnown&&!r.hasContact||contact==='unknown'&&!r.contactKnown)&&(!quick||quick==='unassigned'&&!r.owner||quick==='blocked'&&r.blocked||quick==='today'&&r.nextDate===today||quick==='overdue'&&r.nextDate&&r.nextDate<today));
 rows.sort((a,b)=>sort==='last'?String(b.lastContact||'').localeCompare(String(a.lastContact||''))||a.name.localeCompare(b.name,'ja'):sort==='action'?Number(a.blocked)-Number(b.blocked)||Number(b.hasContact)-Number(a.hasContact)||String(a.nextDate||'9999').localeCompare(String(b.nextDate||'9999'))||a.name.localeCompare(b.name,'ja'):a.name.localeCompare(b.name,'ja'));
 const total=rows.length;
 return {rows:rows.slice((page-1)*50,page*50),selectedCount:total,page,pageSize:50,segment,counts:model.counts};
}
