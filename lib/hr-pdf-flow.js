// Uploaded source PDFs: separate from legacy conditions consent and employee records.
import crypto from 'node:crypto';
export const BUCKET='hr-pdf-flow';
export const TABLES={flows:'gw_hr_pdf_flows',docs:'gw_hr_pdf_docs',deliveries:'gw_hr_pdf_deliveries'};
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TOKEN=/^[0-9a-f]{64}$/;
export const MAX_BYTES=5*1024*1024;
export const enabled=()=>process.env.HR_PDF_FLOW==='1';
export const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
export const AGREEMENT={offer_accept:'このPDFの内容を確認し、内定を承諾します。',receipt:'このPDFの労働条件通知書を受領し、内容を確認しました（雇用契約の署名とは別です）。',contract_agree:'このPDFの労働条件・雇用契約の内容を確認し、同意します。'};
export const titleOf=kind=>kind==='offer'?'内定通知書':'労働条件通知書';
export function declared(b){return ['offer','terms'].includes(b.kind)&&Number.isSafeInteger(b.sizeBytes)&&b.sizeBytes>5&&b.sizeBytes<=MAX_BYTES&&/\.pdf$/i.test(b.fileName||'');}
export function filename(s){return String(s||'書類.pdf').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,'_').slice(0,110);}
export function checkPdf(bytes){return bytes?.length>5&&bytes.length<=MAX_BYTES&&Buffer.from(bytes).subarray(0,5).toString()==='%PDF-';}
export function stagingPath(t,a,k,id){return `${t}/pdf-flow/${a}/staging/${k}/${id}.pdf`;}
export function validStaging(p,t,a,k){const prefix=`${t}/pdf-flow/${a}/staging/${k}/`;return typeof p==='string'&&p.startsWith(prefix)&&UUID.test(p.slice(prefix.length,-4))&&p.endsWith('.pdf');}
export function publicOrigin(){try{const u=new URL(process.env.PUBLIC_BASE_URL||'');return u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash?u.origin:null;}catch{return null;}}
export function expiry(v,now=Date.now()){const t=Date.parse(v);return Number.isFinite(t)&&t>now&&t<=now+90*86400000?new Date(t).toISOString():null;}
export function deliveryEvidence(x){const at=Date.parse(x?.requestedAt);return x?.requested===true&&typeof x.evidence==='string'&&x.evidence.trim().length>=5&&x.evidence.length<=1000&&Number.isFinite(at)&&at<=Date.now()?{requested:true,evidence:x.evidence.trim(),requestedAt:new Date(at).toISOString()}:null;}
export function documentView(d){return {id:d.id,kind:d.kind,version:d.version,filename:d.filename,sha256:d.sha256,responseMode:d.response_mode,state:d.revoked_at?'revoked':d.superseded_at?'superseded':d.responded_at?'responded':d.delivery_state,sentAt:d.sent_at,response:d.response_action,deliveryId:d.delivery_id||null,deliveryCreatedAt:d.delivery_created_at||null,deliveryStatus:d.latest_delivery_status||null,expiresAt:d.expires_at,viewedAt:d.viewed_at,respondedAt:d.responded_at,current:!d.superseded_at&&!d.revoked_at};}
export function flowView(f){return f?{id:f.id,phase:f.phase,version:f.version,acceptedAt:f.accepted_at,readyAt:f.ready_at,joinedAt:f.joined_at,joinDate:f.join_date}:null;}
export function confirmation(a,f,d,cfg,expiresAt,electronicDelivery){const b={documentId:d.id,version:d.version,sha256:d.sha256,responseMode:d.response_mode,filename:d.filename,to:a.email,recipientName:a.name,from:cfg.from,replyTo:cfg.replyTo||null,provider:cfg.provider,expiresAt,electronicDelivery,flowVersion:f.version,subject:`${titleOf(d.kind)}のご確認`,body:`${a.name} 様\n\n添付の${titleOf(d.kind)}（第${d.version}版）をご確認ください。\n保存・印刷できます。下記の本人専用リンクで${d.kind==='offer'?'内定への回答':'受領確認・内容確認'}をお願いします。\n{{本人専用URL}}\n\n回答期限：${expiresAt}\nご不明点は送信者までお問い合わせください。`};return {...b,digest:hash(JSON.stringify(b))};}
export function eligible(a){return Boolean(a&&a.lead_category==='recruitment'&&['executive_employee','part_time'].includes(a.offer_type)&&!/業務委託|委託|副業|フリーランス|スポット|freelance|contractor/i.test(a.employment_type||'')&&!a.advance_claimed_at&&a.stage==='offer'&&a.decision==='hired'&&!a.employee_id&&!['accepted','done','declined','passed','position_closed'].includes(a.status));}
export function canonical(v){if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';return JSON.stringify(v);}
export function migrationConfirmation(snapshot,{tenantId,actorId,applicantId,reason,requestKey}){return {digest:hash(canonical({tenantId,actorId,applicantId,reason,requestKey,snapshot})),applicantId,applicantName:snapshot.applicant?.name||'',applicantEmail:snapshot.applicant?.email||'',reason,requestKey,legacyOffers:(snapshot.offers||[]).map(o=>({id:o.id,version:o.version,sentAt:o.sent_at||null,viewedAt:o.viewed_at||null,revokedAt:o.revoked_at||null})),warning:'未承諾の旧案内リンクを無効にして、新しいPDF準備へ移ります。旧PDF・送信履歴は保持します。この操作ではメール送信・本人承諾・Office引継ぎ・社員登録は行いません。'};}

/** Explain the next user action without changing eligibility or stored hiring decisions. */
export function startGuidance(a, hasLegacy = false) {
 const detail = {label:'応募者詳細を確認する', action:'detail'};
 if (!a || a.lead_category !== 'recruitment')
  return {...detail, message:'この区分は採用書類PDFの対象ではありません。応募者詳細で手続きを確認してください。'};
 if (a.employee_id || a.advance_claimed_at || ['accepted','done','declined','passed','position_closed'].includes(a.status))
  return {...detail, message:'承諾済み・入社手続き中・終了済みなどの状態です。応募者詳細で既存の書類と手続きを確認してください。'};
 if (a.stage !== 'offer' || a.decision !== 'hired')
  return {...detail, message:'採用判断が未完了です。応募者詳細で選考状況を確認してください。'};
 if (!a.offer_type)
  return {label:'採用区分・条件を設定する', action:'offerSetup', message:'採用判断は完了しています。採用区分が未設定のため、書類の準備を開始できません。採用区分を選び、条件を確認してください。'};
 if (!eligible(a))
  return {...detail, message:'この採用区分・契約形態は雇用向けPDF手続きの対象外です。応募者詳細で該当する条件通知・契約手続きを進めてください。'};
 if (hasLegacy)
  return {...detail, message:'既存の案内履歴があります。応募者詳細で内容を確認してください。未承諾の案内は、権限のある担当者が確認して移行できます。'};
 return {label:'採用条件を確認する', action:'offerSetup', message:'作成済みの内定通知書PDFを登録できます。PDFを用意する前に、応募者詳細で採用条件を確認してください。'};
}
