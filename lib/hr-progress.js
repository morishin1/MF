// 担当者が電話・面談などで確認した「対応中の段階」。契約・本人合意・稼働開始の事実とは別に記録する。
import {ymd} from './jst.js';
export const PROGRESS_STEPS = [
  {key:'screening',label:'事前選考'}, {key:'interview',label:'カジュアル面談'},
  {key:'final',label:'代表面談'}, {key:'offer',label:'合格通知'},
  {key:'trial',label:'トライアル'}, {key:'terms',label:'条件通知書'},
  {key:'agreement',label:'合意'}, {key:'office',label:'OFFICE'},
];
export const PROGRESS_METHODS = {phone:'電話',interview:'面談',email:'メール',other:'その他'};
export const PROGRESS_EVENT = 'hiring_progress_set';
const LABEL = Object.fromEntries(PROGRESS_STEPS.map(s=>[s.key,s.label]));
export const progressLabel = key => LABEL[key]||({applied:'事前選考',casual_interview:'カジュアル面談',ceo_recommend:'代表面談',ceo_interview:'代表面談',joining_scheduled:'OFFICE'})[key]||'事前選考';
export const progressPhase = (a,f) => ({terms_preparing:'terms',terms_waiting:'agreement',offer_preparing:'offer',offer_waiting:'offer',onboarding:'office',ready:'office'})[f?.phase]||(a.status==='accepted'?'agreement':a.stage);
// 通常の手続きで状態を進めたら、古い手動指定を再表示しない。
export const PROGRESS_EVENTS = [PROGRESS_EVENT,'step_moved','status_manual','advanced',
  'stage_applied','stage_casual_interview','stage_ceo_recommend','stage_ceo_interview','stage_offer','stage_joining_scheduled',
  'decision_hired','decision_rejected','decision_hold','decision_cleared',
  'offer_drafted','offer_confirmed','offer_link_issued','offer_link_reissued','offer_sent','offer_accepted','offer_declined',
  'formal_sent','formal_signed','office_handoff'];

// メモ・担当者変更では失効させず、実際の選考・書類の進行が変わったときにだけ失効させる。
export const progressContext = (a,f=null) => JSON.stringify([
  a.stage,a.status,a.decision||null,a.offer_type||null,a.employee_id||null,
  f?.id||null,f?.phase||null,f?.version||null,f?.acceptedAt||null,
]);
export function progressRecord(a,events=[],f=null) {
  const latest=events.filter(e=>e.applicant_id===a.id&&PROGRESS_EVENTS.includes(e.event_key))
    .sort((x,y)=>String(y.occurred_at).localeCompare(String(x.occurred_at))||String(y.id).localeCompare(String(x.id)))[0];
  if(!latest||latest.event_key!==PROGRESS_EVENT)return {manualProgress:null,progressRevision:null};
  let d;try{d=JSON.parse(latest.detail);}catch{return {manualProgress:null,progressRevision:latest.id};}
  const valid=d?.version===1&&LABEL[d.phase]&&d.context===progressContext(a,f);
  return {progressRevision:latest.id,manualProgress:valid?{phase:d.phase,method:d.method,confirmedOn:d.confirmedOn,note:d.note,recordedAt:latest.occurred_at}:null};
}
export function progressDetail(t) {
  if(t.event_key!==PROGRESS_EVENT)return t.detail;
  try{const d=JSON.parse(t.detail);return `変更前：${progressLabel(d.from)} → 変更後：${LABEL[d.phase]||d.phase}／確認方法：${PROGRESS_METHODS[d.method]||'その他'}／確認日：${d.confirmedOn}／確認内容：${d.note}`;}catch{return '状態を変更しました';}
}
export async function readProgressEvents(sb,tenantId,ids) {
  if(!ids.length)return {ready:true,events:[]};
  // 各応募者の最新イベントだけが必要。1人の履歴で他の応募者が取得上限から落ちないようページを送る。
  const found=new Map(),wanted=new Set(ids);
  try{
    for(let offset=0;;offset+=1000){
      const r=await sb.from('gw_hr_timeline').select('id,applicant_id,event_key,detail,occurred_at')
        .eq('tenant_id',tenantId).in('applicant_id',ids).in('event_key',PROGRESS_EVENTS)
        .order('occurred_at',{ascending:false}).range(offset,offset+999);
      if(r.error)return {ready:false,events:[]};
      for(const e of r.data||[])if(!found.has(e.applicant_id)&&wanted.has(e.applicant_id))found.set(e.applicant_id,e);
      if(found.size===wanted.size||(r.data||[]).length<1000)break;
    }
    return {ready:true,events:[...found.values()]};
  }catch{return {ready:false,events:[]};}
}
export function progressOptions(a,{canDecide=false,offers=[],ready=true,pdfFlow=null}={}) {
  let locked=null;
  if(!ready)locked='現在の状態を取得できません。画面を読み直してください。';
  else if(a.lead_category==='mugendojo'||String(a.stage).startsWith('md_'))locked='無限道場は専用の受付から進めてください。';
  else if(['joined','cancelled','declined'].includes(pdfFlow?.phase))locked='この案内は終了しています。書類・契約から確認してください。';
  else if(a.employee_id||a.status==='done'||offers.some(o=>o.handoff_at))locked='OFFICEへ引き継ぎ済みのため、履歴から確認してください。';
  else if(['passed','declined','position_closed'].includes(a.status))locked='選考が終了しています。再開する場合は、先に対応状況を変更してください。';
  else if(a.status==='ceo_decision_pending'&&!canDecide)locked='代表の判断待ちです。代表・管理者が変更できます。';
  return {locked,options:PROGRESS_STEPS.map(s=>{
    const reason=locked||(['offer','trial','terms','agreement','office'].includes(s.key)&&!canDecide&&a.decision!=='hired'?'合格後の段階は、代表の採用判断後に選べます。':null);
    return {...s,state:reason?'blocked':'allowed',reason};
  })};
}
export function validateProgressInput(b,today) {
  const note=typeof b.note==='string'?b.note.replace(/\r\n/g,'\n').trim():'';
  if(typeof b.method!=='string'||!Object.hasOwn(PROGRESS_METHODS,b.method))return {error:'invalid_method',hint:'確認方法を選んでください。'};
  if(typeof b.confirmedOn!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(b.confirmedOn)||ymd(new Date(b.confirmedOn+'T00:00:00Z'))!==b.confirmedOn||b.confirmedOn>today)return {error:'invalid_date',hint:'確認日を今日以前の正しい日付で入力してください。'};
  if(!note||note.length>500)return {error:'note_required',hint:'確認した内容を500文字以内で入力してください。'};
  return {note};
}
export function progressNotices(to) {
  const notes=['電話・面談などで確認した内容を残し、対応中の状態を変更します。メールは送信されません。'];
  if(to==='trial')notes.push('トライアルの開始前に、契約・報酬・期間を確認してください。実施記録はトライアル画面で管理します。');
  if(to==='agreement'||to==='office')notes.push('本人の合意・契約締結・OFFICEへの引継ぎは、書類・契約の手続きで別に確認します。');
  return {notes,warnings:[]};
}
