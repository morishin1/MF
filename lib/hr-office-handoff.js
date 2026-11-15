// 採用決定後にOffice人事労務へ引き継ぐ。通知は担当者だけ、一覧は既存事実から導出する。
// 正式な労働条件・契約・合意はHRの操作やファイルアップロードだけでは確定しない。
import {loadAppsMany} from './app-grants.js';

export const OFFICE_DOC_KINDS=['terms','employment_contract','contractor_contract'];
export function contractKindOf(offerType){
  if(['contractor','spot'].includes(offerType))return 'contractor_contract';
  if(offerType==='training'||!offerType)return null;
  return 'employment_contract';
}
const latest=(docs,kind)=>(docs||[]).filter(d=>d.kind===kind&&['draft','published'].includes(d.status))
  .sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))[0]||null;
const stageOf=d=>!d?'未アップロード':d.status==='published'?'本人に公開済み':'アップロード済み（未公開）';
export function officeHandoffSummary(a,docs=[],legacyOffers=null){
  const notice=latest(docs,'offer'),terms=latest(docs,'terms'),contractKind=contractKindOf(a.offer_type);
  const legacy=Array.isArray(legacyOffers)?[...legacyOffers].filter(x=>!x.revoked_at)
    .sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))[0]:null;
  const offerPublished=notice?.status==='published'||(!notice&&Boolean(legacy?.sent_at));
  const offerLabel=notice?stageOf(notice):legacy?.sent_at?'旧通知で本人へ送付済み'
    :legacy?.notice_pdf_path?'旧通知PDF作成済み（送信未確認）'
    :legacyOffers===null?'旧通知の状況はHRで確認':'未アップロード';
  const contract=contractKind?latest(docs,contractKind):null;
  const completed=Boolean(a.employee_id)||a.status==='done';
  const accepted=a.status==='accepted'||completed;
  let phase='preoffer',next='内定通知前の労働条件を確認';
  if(completed){phase='done';next='入社・稼働手続き完了（履歴を確認）';}
  else if(!a.offer_type){phase='category';next='HRに採用予定区分を確認';}
  else if(a.offer_type==='training'){phase='training';next='育成枠の手続きを確認';}
  else if(!terms){phase='terms';next='労働条件通知書PDFを準備・登録';}
  else if(terms.status==='draft'){phase='terms_review';next='労働条件通知書の内容・公開先を確認';}
  else if(!offerPublished){phase='offer';next='HRの内定通知書の送付状況を確認';}
  else if(contractKind&&!contract){phase='contract';next='契約書PDFを準備・登録';}
  else if(contractKind&&contract.status==='draft'){phase='contract_review';next='契約書の内容・公開先を確認';}
  else if(!accepted){phase='acceptance';next='本人の回答・契約署名を確認';}
  else {phase='onboarding';next='契約締結を確認して入社手続きへ';}
  return {
    phase,next,completed,accepted,contractKind,
    offer:offerLabel,terms:stageOf(terms),contract:contractKind?stageOf(contract):'対象外',
    // 閲覧やPDF公開だけでは法的な合意・署名済みとは表示しない。
    offerPublished,termsPublished:terms?.status==='published',
    contractPublished:contract?.status==='published',
  };
}

// 権限判定の正はlib/gw.js canOfficeHr と同じ：owner / 管理者 / (hr + Officeアプリ)。
// Office入口だけ・採用担当だけ・退職者・外部専門家には通知しない。
export function officeHrRecipientIds(employees,roleGrants,adminMemberships,appsById){
  const admins=new Set((adminMemberships||[]).map(m=>m.user_id));
  const roleMap=new Map();
  for(const g of roleGrants||[]){
    if(!roleMap.has(g.employee_id))roleMap.set(g.employee_id,new Set());
    roleMap.get(g.employee_id).add(g.role);
  }
  return (employees||[]).filter(e=>{
    if(!e?.id||!e.user_id||!['active','invited'].includes(e.status))return false;
    const roles=roleMap.get(e.id)||new Set(),apps=appsById.get(e.id)||[];
    return admins.has(e.user_id)||roles.has('owner')||(roles.has('hr')&&apps.includes('office'));
  }).map(e=>e.id);
}
export async function findOfficeHrRecipients(sb,tenantId){
  const [e,m]=await Promise.all([
    sb.from('gw_employees').select('id,user_id,status').eq('tenant_id',tenantId).in('status',['active','invited']).limit(1000),
    sb.from('memberships').select('user_id,role').eq('tenant_id',tenantId).in('role',['admin','staff'])
  ]);
  if(e.error||m.error)return {ids:[],ready:false};
  const employees=e.data||[],ids=employees.map(x=>x.id);
  if(!ids.length)return {ids:[],ready:true};
  const g=await sb.from('gw_role_grants').select('employee_id,role').in('employee_id',ids).in('role',['owner','hr']);
  if(g.error)return {ids:[],ready:false};
  const byRoles=new Map(ids.map(id=>[id,(g.data||[]).filter(x=>x.employee_id===id).map(x=>x.role)]));
  const apps=await loadAppsMany(sb,ids,byRoles);
  if(apps.state==='error')return {ids:[],ready:false};
  return {ids:officeHrRecipientIds(employees,g.data,m.data,apps.byId),ready:true};
}
export async function notifyOfficeHandoff({sb,tenantId,applicantId,applicantName,decisionAt,notifyFn}){
  const recipients=await findOfficeHrRecipients(sb,tenantId);
  if(!recipients.ready)return {created:0,ready:false};
  const link='/office/hiring-documents.html?applicantId='+encodeURIComponent(applicantId);
  const rows=recipients.ids.map(employeeId=>({
    tenantId,employeeId,kind:'hr',
    title:'内定者の労働条件・契約の準備',
    body:applicantName+'：HRで採用決定しました。内定前の労働条件の確認と正式書類をお願いします。',
    link,
    dedupeKey:'hr_office_handoff:'+applicantId+':'+String(decisionAt||'new'),
  }));
  const result=await notifyFn(rows,{replace:false});
  return {ready:true,recipients:recipients.ids.length,...result};
}
