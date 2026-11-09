// Read-only classification. Legacy buckets and name matches are candidates, never verified IDs.
import {formatCompanyNumber} from "./sales-company-number.js";
export const ACTIVE_STAGES=new Set(['提案中','確認中','面談','合格','所属確認','提案済','返信待ち','返信あり','面談調整','クロージング中','面談合格']);
const clean=v=>String(v??'').trim();
const normalize=v=>clean(v).normalize('NFKC').replace(/\s+/g,'').toLowerCase();
export function buildLifecycle({directory,contacts,proposals,links=[],sales=[],employees=[],jobs=[],broadcasts=[],people=[],peopleReady=true,classifications=[]}){
 const classMap=new Map(classifications.map(c=>[c.company_id,c]));
 const pilot100=classifications.filter(c=>c.origin==='pilot100');
 const overrides=new Map(broadcasts.map(b=>[b.company_id,b]));
 const broadcastIds=new Set(broadcasts.filter(b=>b.blast_target===true).map(b=>b.company_id));
 const contactMap=new Map(contacts.map(c=>[c.id,c]));
 const peopleMap=new Map();for(const p of people){if(!peopleMap.has(p.company_id))peopleMap.set(p.company_id,[]);peopleMap.get(p.company_id).push(p);}
 const names=new Map(employees.map(e=>[e.id,e.display_name]));
 const salesMap=new Map(sales.map(s=>[s.id,s]));
 const linkedSalesIds=new Set(links.map(l=>l.company_id));
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
  const classification=classMap.get(d.id)||null;
  const c=contactMap.get(d.id);if(!c)throw Error('contact_source_incomplete');
  const s=salesMap.get(linked.get(d.id));
  const active=byId.get(d.id)||[];
  const broadcast=broadcastIds.has(d.id),companyPeople=peopleMap.get(d.id)||[];
  const manualSegment=overrides.get(d.id)?.lifecycle_segment||null,plan=overrides.get(d.id)?.work_plan||{};
  const segment=broadcast?'broadcast':manualSegment|| (active.length||d.relationship_status==='active'||(s&&!s.hidden_at&&['attacked','clicked','proposal','meeting'].includes(s.status))?'current':d.relationship_status==='past'?'past':'pending');
  const emails=s?(s.emails||[]):[c.contact_email];
  const email=emails.some(x=>clean(x))||companyPeople.some(p=>clean(p.email)),phone=Boolean(clean(s?s.phone:c.phone))||companyPeople.some(p=>clean(p.phone)),form=Boolean(clean(s?s.form_url:c.contact_form_url));
  const blocked=Boolean(d.needs_contact_review||s?.hidden_at||s?.ng_reason);
  const reason=active.length?'企業IDに紐づく進行中提案':s&&['attacked','clicked','proposal','meeting'].includes(s.status)?'営業DBの対応状況（'+s.status+'）':d.relationship_status==='active'?'根拠付きの取引中確認':d.relationship_status==='past'?'根拠付きの過去取引確認':d.classification_basis||'営業履歴・提案との照合待ち';
  return {id:d.id,companyId:d.id,companyNo:c.company_no??null,displayId:formatCompanyNumber(c.company_no),salesId:s?.id||null,name:d.name,contactName:c.contact_name||null,people:companyPeople,segment,broadcast,manualSegment,legacyBucket:d.bucket,confirmed:!manualSegment&&['current','past'].includes(segment),
   reason:manualSegment?'手動で営業区分を設定（取引実績とは別）':reason,relationship:d.relationship_status||'unknown',relationshipEvidence:d.relationship_evidence||null,
   industry:d.industry||null,region:d.prefecture||null,priority:d.effective_priority||null,
   orgType:classification?.org_type||'unknown',
   businessTypes:classification?.business_types||[],
   classificationStatus:classification?.status||'unclassified',
   isPilot100:classification?.origin==='pilot100',
   classificationConfidence:classification?.confidence??null,
   suggestedService:classification?.suggested_service||null,
   email,phone,form,contactKnown:true,hasContact:email||phone||form,blocked,siSes:Boolean(d.si_ses_candidate),
   lastContact:s?.last_contact_at||c.last_contacted_at||d.historical_contact_date||null,lastContactKind:c.last_contacted_at?'最終連絡':'旧資料の接点',
   owner:plan.owner??(s?.owner_id?names.get(s.owner_id)||'担当名未取得':''),nextDate:plan.nextDate??s?.next_action_on??'',
   nextAction:plan.nextAction??(s?.next_action||(blocked?'連絡停止・注意内容を確認':active.length?'進捗・返答を確認':!(email||phone||form)?'連絡先を調査':d.bucket==='revive'?'過去の接点・再開理由を確認':'営業履歴を確認して初回連絡を準備')),
   proposals:active,candidateIds:[],historicalCount:Number(d.historical_activity_count||0)};
 });
 // The Sales CRM contains companies without an ENGER link. Keep their identity distinct;
 // omitting them here hides the majority of active outreach companies.
 const salesOnly=sales.filter(s=>!linkedSalesIds.has(s.id)&&!s.hidden_at&&['attacked','clicked','proposal','meeting'].includes(s.status)).map(s=>{
  const emails=Array.isArray(s.emails)?s.emails:[];
  const email=emails.some(x=>clean(x)),phone=Boolean(clean(s.phone)),form=Boolean(clean(s.form_url));
  return {id:'sales:'+s.id,companyId:null,salesId:s.id,name:s.name||'企業名未登録',segment:'current',confirmed:false,
   reason:'Sales営業DBの対応状況（'+s.status+'）・ENGER未連携',legacyBucket:null,relationship:'unknown',
   contactKnown:true,email,phone,form,hasContact:email||phone||form,blocked:Boolean(s.ng_reason),
   lastContact:s.last_contact_at||null,lastContactKind:s.last_contact_at?'営業DBの最終接点':'連絡日未登録',
   owner:s.owner_id?names.get(s.owner_id)||'担当名未取得':'',nextDate:s.next_action_on||'',
   nextAction:s.next_action||'営業履歴と次回対応を確認',proposals:[],candidateIds:[],salesOnly:true};
 });
 const nameMap=new Map();for(const r of rows){const n=normalize(r.name);if(!nameMap.has(n))nameMap.set(n,[]);nameMap.get(n).push(r);}
 const activities=[...unlinked.entries()].map(([key,a])=>({id:'activity:'+key,companyId:null,salesId:null,name:a.name,segment:'current',confirmed:false,
  reason:'ENGER進行中。企業IDは未照合',legacyBucket:null,contactKnown:false,email:false,phone:false,form:false,hasContact:false,blocked:false,
  candidateIds:(nameMap.get(key)||[]).map(r=>({id:r.id,name:r.name})),proposals:a.proposals,
  lastContact:null,lastContactKind:'提案更新は連絡実績とは別',owner:'',nextDate:'',nextAction:'企業ID・担当者・提案の進捗を確認'}));
 for(const r of [...rows,...activities,...salesOnly])r.statusLabel=lifecycleStatus(r);
 return {rows,activities,salesOnly,counts:{salesOnly:salesOnly.length,total:rows.length,broadcast:rows.filter(r=>r.broadcast).length,current:rows.filter(r=>r.segment==='current').length+salesOnly.length,
  activityNames:activities.length,activeProposals:proposals.filter(p=>ACTIVE_STAGES.has(p.stage)).length,
  past:rows.filter(r=>r.segment==='past').length,pastCandidates:rows.filter(r=>r.segment==='pending'&&r.legacyBucket==='revive').length,
  futureCandidates:rows.filter(r=>r.segment==='future'||r.segment==='pending'&&r.legacyBucket==='new').length,pending:rows.filter(r=>r.segment==='pending').length,
  contact:rows.filter(r=>r.hasContact).length,blocked:rows.filter(r=>r.blocked).length,
  pilot100:{
   total:pilot100.length,
   queued:pilot100.filter(c=>c.status==='queued').length,
   processing:pilot100.filter(c=>c.status==='processing').length,
   completed:pilot100.filter(c=>c.status==='completed').length,
   needsReview:pilot100.filter(c=>c.status==='needs_review').length,
   failed:pilot100.filter(c=>c.status==='failed').length
  },
  classification:{
   completed:classifications.filter(x=>x.status==='completed').length,
   review:classifications.filter(x=>x.status==='needs_review').length,
   failed:classifications.filter(x=>x.status==='failed').length,
   queued:classifications.filter(x=>['queued','processing'].includes(x.status)).length,
   total:classifications.length
  },
  peopleReady,contactUnclassified:rows.filter(r=>r.contactName&&!(r.people?.length)).length,
  businessCard:rows.filter(r=>r.people?.some(p=>p.source==='business_card')).length,
  businessCardPeople:rows.reduce((n,r)=>n+(r.people||[]).filter(p=>p.source==='business_card').length,0),
  inquiry:rows.filter(r=>r.people?.some(p=>p.source==='inquiry')).length,
  referral:rows.filter(r=>r.people?.some(p=>['referral','event'].includes(p.source))).length}};
}
export function selectLifecycle(model,params){
 const segment=params.get('segment')||'current',page=Number(params.get('page')||1),contact=params.get('contact')||'',quick=params.get('quick')||'',category=params.get('category')||'',pilot=params.get('pilot')||'',sort=params.get('sort')||'action',direction=params.get('direction')||(sort==='last'?'desc':'asc');
 if(!['current','past','future','broadcast','pending','all','business_card','inquiry','referral','contact_unclassified'].includes(segment)||!Number.isInteger(page)||page<1||page>1000||!['','yes','email','phone','both','form','no','unknown'].includes(contact)||!['','unassigned','today','overdue','blocked'].includes(quick)||!['','ses','sier','general','municipality','education','other','review','unclassified'].includes(category)||!['','all','queued','processing','completed','needs_review','failed'].includes(pilot)||!['action','name','contact','status','last','nextAction','owner','deadline'].includes(sort)||!['asc','desc'].includes(direction))throw Error('invalid_filter');
 const q=clean(params.get('q')).slice(0,100).toLowerCase(),today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 let rows=segment==='contact_unclassified'?model.rows.filter(r=>r.contactName&&!(r.people?.length)):segment==='business_card'?model.rows.filter(r=>r.people?.some(p=>p.source==='business_card')):segment==='inquiry'?model.rows.filter(r=>r.people?.some(p=>p.source==='inquiry')):segment==='referral'?model.rows.filter(r=>r.people?.some(p=>['referral','event'].includes(p.source))):segment==='current'?[...model.rows.filter(r=>r.segment==='current'),...model.activities,...(model.salesOnly||[])]:model.rows.filter(r=>segment==='all'||segment==='broadcast'&&r.broadcast||segment==='past'&&(r.segment==='past'||r.segment==='pending'&&r.legacyBucket==='revive')||segment==='future'&&(r.segment==='future'||r.segment==='pending'&&r.legacyBucket==='new')||segment==='pending'&&r.segment==='pending');
 const matchesContact=r=>!contact||contact==='unknown'&&!r.contactKnown||r.contactKnown&&(contact==='yes'&&r.hasContact||contact==='no'&&!r.hasContact||contact==='email'&&r.email||contact==='phone'&&r.phone||contact==='both'&&r.email&&r.phone||contact==='form'&&r.form);
 const matchesCategory=r=>{
  if(!category)return true;
  const tags=Array.isArray(r.businessTypes)?r.businessTypes:[];
  if(category==='ses'||category==='sier')return tags.includes(category);
  if(category==='municipality'||category==='education'||category==='other')return r.orgType===category;
  if(category==='general')return r.orgType==='private'&&!tags.includes('ses')&&!tags.includes('sier');
  if(category==='review')return r.classificationStatus==='needs_review';
  if(category==='unclassified')return !r.classificationStatus||['unclassified','queued','processing','failed'].includes(r.classificationStatus);
  return false;
 };
 const matchesPilot=r=>!pilot||(r.isPilot100===true&&(pilot==='all'||r.classificationStatus===pilot));
 rows=rows.filter(r=>(!q||[r.name,r.contactName,r.companyId,r.salesId,r.companyNo,r.displayId,...(r.people||[]).flatMap(p=>[p.name,p.email,p.department,p.position,p.phone])].some(v=>String(v||'').toLowerCase().includes(q)))&&matchesContact(r)&&matchesCategory(r)&&matchesPilot(r)&&(!quick||quick==='unassigned'&&!r.owner||quick==='blocked'&&r.blocked||quick==='today'&&r.nextDate===today||quick==='overdue'&&r.nextDate&&r.nextDate<today));
 const textCompare=(a,b)=>String(a).localeCompare(String(b),'ja',{numeric:true});
 const stable=(a,b)=>textCompare(a.name,b.name)||textCompare(a.id,b.id);
 const values={name:r=>r.name,contact:r=>r.contactKnown?Number(r.email)+Number(r.phone)+Number(r.form):null,status:r=>r.statusLabel||lifecycleStatus(r),last:r=>r.lastContact?Date.parse(r.lastContact):null,nextAction:r=>r.nextAction,owner:r=>r.owner,deadline:r=>r.nextDate};
 const compare=(a,b)=>{
  if(sort==='action')return Number(a.blocked)-Number(b.blocked)||Number(b.hasContact)-Number(a.hasContact)||String(a.nextDate||'9999').localeCompare(String(b.nextDate||'9999'));
  const av=values[sort](a),bv=values[sort](b),missing=v=>v==null||v===''||typeof v==='number'&&!Number.isFinite(v);
  if(missing(av)||missing(bv))return missing(av)===missing(bv)?0:missing(av)?1:-1;
  return (typeof av==='number'?av-bv:textCompare(av,bv))*(direction==='desc'?-1:1);
 };
 rows.sort((a,b)=>(sort==='action'&&direction==='desc'?-compare(a,b):compare(a,b))||stable(a,b));
 const total=rows.length;
 return {rows:rows.slice((page-1)*50,page*50),selectedCount:total,page,pageSize:50,segment,counts:model.counts};
}

export function lifecycleStatus(r){
 return r.blocked?'連絡停止・注意':r.salesOnly?'営業中・Sales企業DB':r.companyId===null?'進行中・ID照合待ち':r.broadcast?'配信登録':r.manualSegment?({current:'営業対応中',past:'再アプローチ',future:'新規開拓'}[r.manualSegment]):r.confirmed?(r.segment==='current'?'営業対応中・確認済み':'過去取引・確認済み'):({revive:'旧接点候補',new:'新規候補',existing:'旧既存区分・要確認'}[r.legacyBucket]||'分類未確定');
}
