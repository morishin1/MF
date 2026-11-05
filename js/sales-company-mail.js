// One durable request key per explicit submission; retries reuse its exact payload.
import {validEmail} from '../lib/sales-contact-preview.js';
const $=id=>document.getElementById(id);
export function attachCompanyMail({companyId,onHistory,onMessage,isCurrent}){
 let config=null,busy=false,entries=[],nextBefore=null,pending=null;
 let storageKey=null;
 function restore(actorId){
  if(storageKey)return;
  storageKey='sales-company-mail:'+actorId+':'+companyId;
  try{const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');if(saved?.payload?.id===companyId&&saved.payload.requestKey)pending=saved;}catch{}
  if(pending){$('lc-to').value=pending.payload.to;$('lc-subject').value=pending.payload.subject;$('lc-body').value=pending.payload.text;onMessage(notice(pending.status));}
 }
 function lock(locked){for(const id of ['lc-to','lc-subject','lc-body'])$(id).readOnly=locked;}
 function controls(){
  if(!isCurrent())return;
  $('lc-mail-from').textContent=config?.from||'送信元未設定';
  $('lc-mail-config').textContent=config?.hint||'送信設定・履歴を確認中…';
  const status=pending?.status;
  lock(Boolean(pending));
  for(const id of ['lc-insert-template','lc-template','lc-template-add','lc-template-edit'])$(id).disabled=Boolean(pending);
  $('lc-mail-send').disabled=busy||(!pending&&!config?.configured)||['accepted','not_sent'].includes(status);
  $('lc-mail-send').textContent=busy?'処理中…':pending?'同じ送信依頼の結果を確認':'送信して履歴に保存';
  $('lc-mail-new').hidden=!['accepted','not_sent'].includes(status);
  $('lc-mail-more').hidden=!nextBefore;
 }
 function remember(){sessionStorage.setItem(storageKey,JSON.stringify(pending));}
 function notice(status){return ({accepted:'送信サーバーが受け付けました。宛先・本文・送信者・日時を履歴に保存しました。到達・開封・返信は未確認です。',sending:'送信処理中、または結果が未確定です。新しく送り直さず、同じ送信依頼の結果を確認してください。',unknown:'送信結果を確定できません。送信済みの可能性があるため、再送せず送信サーバーの記録を確認してください。',not_sent:'送信されませんでした。設定確認後、新しいメールを作成できます。'})[status]||'';}
 function include(items,append=false){
  entries=append?[...entries,...items]:items;
  entries=[...new Map(entries.map(m=>[m.id,m])).values()];
  const found=pending&&entries.find(m=>m.request_key===pending.payload.requestKey);
  if(found){pending.status=found.status;try{remember();}catch{}onMessage(notice(found.status));}
  onHistory(entries);controls();
 }
 async function load(append=false){
  try{
   const d=await API.api('/api/sales/company-mail?id='+encodeURIComponent(companyId)+(append&&nextBefore?'&before='+encodeURIComponent(nextBefore):''));
   if(!isCurrent())return;
   config=d.config;restore(config.actorId);nextBefore=d.nextBefore;include(d.messages||[],append);$('lc-mail-history-warning').textContent='';
  }catch{if(!isCurrent())return;config=null;$('lc-mail-history-warning').textContent='メール履歴を取得できませんでした。再取得してください。';$('lc-mail-config').textContent='送信設定・履歴の取得に失敗しました。';$('lc-mail-send').disabled=true;}
 }
 async function submit(){
  if(busy||!isCurrent())return;
  if(!pending){
   const to=$('lc-to').value.trim(),subject=$('lc-subject').value.trim(),text=$('lc-body').value.trim();
   if(!validEmail(to)||!subject||/[\r\n]/.test(subject)||!text||/{{[^}]*}}/.test(subject+text)){onMessage('宛先・件名・本文と差し込み項目を確認してください。');return;}
   if(!config?.configured){onMessage(config?.hint||'送信設定を確認してください。');return;}
   pending={payload:{id:companyId,to,subject,text,expectedFrom:config.from,requestKey:crypto.randomUUID()},status:'sending'};
   try{remember();}catch{pending=null;onMessage('二重送信防止の記録を保存できません。ブラウザの保存設定を確認してください。');return;}
  }
  busy=true;controls();onMessage('送信処理の結果を確認しています…');
  try{
   const d=await API.api('/api/sales/company-mail',{method:'POST',body:pending.payload});
   pending.status=d.message.status;remember();
   if(!isCurrent())return;
   include([d.message,...entries]);onMessage(d.warning||notice(pending.status));
  }catch(e){
   // A known validation rejection means no transport attempt. Unknown failures keep the key locked.
   if(['invalid_mail','recipient_changed','mail_not_configured','sender_changed','contact_blocked','ambiguous_company','invalid_id','company_not_found','forbidden'].includes(e.code)){
    pending=null;sessionStorage.removeItem(storageKey);
   }
   if(isCurrent())onMessage(e.hint||'通信結果が不明です。同じ送信依頼の結果を確認してください。新規の再送はしないでください。');
  }finally{busy=false;controls();}
 }
 if(pending?.payload){$('lc-to').value=pending.payload.to;$('lc-subject').value=pending.payload.subject;$('lc-body').value=pending.payload.text;onMessage(notice(pending.status));}
 $('lc-mail-send').onclick=submit;
 $('lc-mail-new').onclick=()=>{if(busy)return;pending=null;sessionStorage.removeItem(storageKey);$('lc-subject').value='';$('lc-body').value='';controls();onMessage('新しいメールの件名と本文を入力してください。');};
 $('lc-mail-refresh').onclick=()=>load();$('lc-mail-more').onclick=()=>load(true);
 controls();void load();
 return {refresh:()=>load()};
}
