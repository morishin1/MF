import {COMPANY_FIELDS,ACTION_RESULTS,profilePatch,planInput} from '../lib/sales-company-workbench.js';
import {attachCompanyMail} from './sales-company-mail.js';
import {DEFAULT_TEMPLATES,fillTemplate,safeWebsite,phoneLink,previewProblem,mergeHistory,validEmail,templateRequest} from '../lib/sales-contact-preview.js';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=v=>v?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'日時未登録';
const OFFICIAL_HISTORY_LABELS={corporateNumber:'法人番号',officialSource:'取得・照合方法',updatedFields:'更新項目',verified:'公的API照合済み'};
const kv=(label,value)=>'<div class="lc-kv"><dt>'+esc(label)+'</dt><dd>'+esc(value||'未登録')+'</dd></div>';
const link=(url,text)=>url?'<a class="lc-link" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(text)+' ↗</a>':'';
export function createCompanyWorkbench({draft,onChange,onSaved=()=>{},viewer}){
 let generation=0,row=null,company=null,evidence=null,salesHistory=[],mailHistory=[],historyWarning='',channel='memo',templates=[...DEFAULT_TEMPLATES],templatePromise,templatesLoaded=false,editingTemplate=null,editorReturn=false,templateSaving=false;
 let workHistory=[],historyCursor=null,saving=false,pendingActivity=null;
 const compose=new Map();
 const valid=n=>n===generation&&$('lc-dialog').open;
 const record=()=>draft.get(row.id)||{};
 const state=()=>{if(!compose.has(row.id))compose.set(row.id,{sender:viewer()||'',to:'',subject:'',body:'',templateId:'intro',result:'',note:'',channel:null});return compose.get(row.id);};
 function message(text){$('lc-work-status').textContent=text;}
 async function copy(text){try{await navigator.clipboard.writeText(text);message('コピーしました。');}catch{message('コピーできませんでした。文字を選択してコピーしてください。');}}
 function templateValues(){return {company:company?.name||row.name,contact:company?.contactName?company.contactName+' 様':'ご担当者様',sender:state().sender||'営業担当',service:templates.find(t=>t.id===state().templateId)?.service||'',url:templates.find(t=>t.id===state().templateId)?.destinationUrl||''};}
 function applyTemplate(){if($('lc-body')?.readOnly){message('送信処理中の文面は変更できません。履歴で結果を確認してください。');return;}const t=templates.find(t=>t.id===state().templateId)||templates[0];Object.assign(state(),fillTemplate(t,templateValues()));$('lc-subject').value=state().subject;$('lc-body').value=state().body;}
 function readInputs(){
  if(!$('lc-sender'))return;
  for(const [key,id] of [['sender','lc-sender'],['to','lc-to'],['subject','lc-subject'],['body','lc-body'],['result','lc-result'],['note','lc-result-note']])state()[key]=$(id).value;
 }
 function plan(){return {owner:$('lc-owner').value.trim(),nextDate:$('lc-date').value,nextAction:$('lc-action').value.trim()};}
 function showHistory(){
  const old=company?.historicalContactDate||company?.historicalActivityCount||company?.lastActivity;
  const historical=old?[{id:'legacy',at:company.historicalContactDate||null,label:'旧資料の接点記録',detail:[company.lastActivity,company.historicalActivityCount?'記録件数：'+company.historicalActivityCount+'件（個別内容は未取得）':null].filter(Boolean).join('\n'),source:'旧資料'}]:[];
  const items=[...mergeHistory(evidence?.touchpoints||[],salesHistory,record().events||[]),...historical,...workHistory.map(m=>({id:'work:'+m.id,at:m.created_at,source:'Sales・保存済み',label:m.payload.result||(m.payload.plan?'次回対応を更新':'登録情報を更新'),actor:m.actor_name,detail:m.payload.result?[m.payload.subject,m.payload.body,m.payload.note].filter(Boolean).join('\n\n'):Object.keys(m.payload).filter(k=>k!=='plan').map(k=>(OFFICIAL_HISTORY_LABELS[k]||COMPANY_FIELDS[k]?.label||k)+'：'+(Array.isArray(m.payload[k])?m.payload[k].join(' / '):String(m.payload[k]??'未登録'))).join('\n'),nextAction:m.payload.plan?.nextAction,nextDate:m.payload.plan?.nextDate})),...mailHistory.map(m=>({id:'mail:'+m.id,at:m.created_at,source:'Salesメール',label:({accepted:'送信受付済み',sending:'送信処理中・結果未確定',unknown:'送信結果不明（再送しないでください）',not_sent:'未送信'}[m.status]||m.status)+'：'+m.subject,actor:m.actor_name,detail:'宛先：'+m.to_email+'\n送信元：'+m.from_email+'\n\n'+m.body_text,mail:true}))].sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  $('lc-history-count').textContent=items.length+'件';
  $('lc-history-list').innerHTML=(historyWarning?'<p class="lc-error">'+esc(historyWarning)+'</p>':'')+(items.length?items.map(t=>'<article class="lc-history"><small>'+esc(stamp(t.at))+' · '+esc(t.source)+'</small><strong>'+esc(t.label)+'</strong>'+(t.actor?'<small>記録者'+(t.source==='ENGER'?'ID':'')+'：'+esc(t.actor)+'</small>':'')+(t.detail?(t.mail?'<details><summary>宛先・送信内容を確認</summary><p>'+esc(t.detail)+'</p></details>':'<p>'+esc(t.detail)+'</p>'):'')+(t.nextAction||t.nextDate?'<small>次回：'+esc([t.nextDate,t.nextAction].filter(Boolean).join(' ／ '))+'</small>':'')+'</article>').join(''):'<p class="lc-detail-note">この企業IDの履歴はありません。別ID・未照合の記録は含みません。</p>');
 }
 function info(v){
  const site=safeWebsite(v.website),form=safeWebsite(v.formUrl),tel=phoneLink(v.phone);
  const editable=(key,value=undefined)=>{
   const f=COMPANY_FIELDS[key],v=value===undefined?company[key]:value;
   return '<div class="lc-kv"><dt>'+esc(f?.label||key)+'</dt><dd><button type="button" class="lc-edit-value" data-edit="'+key+'" '+(!row.companyId?'disabled':'')+' aria-label="'+esc(f?.label||key)+'を編集">'+esc(f?.type==='boolean'?f.options[v?1:0]:v||'未登録')+' <span aria-hidden="true">✎</span></button></dd></div>';
  };

  // Company fields stay left. Classification/management controls move above the right history.
  $('lc-company-info').innerHTML=
    '<p class="lc-detail-note">項目をクリックして編集できます。</p><dl>'+
      Object.keys(COMPANY_FIELDS).map(k=>editable(k)).join('')+'</dl>'+
    '<div class="lc-info-links">'+link(site,'ホームページを開く')+link(form,'フォームを開く')+'</div>'+
    '<p id="lc-edit-status" role="status"></p>';
  $('lc-company-segment-fields').innerHTML=
    '<h3>営業区分・企業評価</h3>'+
    '<label>営業区分<select id="lc-single-segment" '+(!row.companyId?'disabled':'')+'>'+
      '<option value="auto">自動分類</option><option value="current">現在</option>'+
      '<option value="past">過去</option><option value="future">未来</option>'+
      '<option value="broadcast">配信</option></select></label>'+
    '<p class="lc-detail-note">選ぶと保存します。取引実績の判定とは別です。</p>'+
    '<details class="lc-classification-detail"><summary>分類・管理情報を確認・編集</summary><dl>'+
      kv('取引状態',({active:'取引中',past:'過去取引',unknown:'未確認',none_confirmed:'取引なし確認済み'}[v.relationshipStatus]||v.relationshipStatus))+
      kv('分類の根拠',row.reason)+kv('取引の根拠',v.relationshipEvidence)+
      kv('取込元',v.dataSource)+kv('Sales企業ID',v.sales?.id)+
      kv('最終連絡',v.lastContactedAt?stamp(v.lastContactedAt):null)+
    '</dl><label>優先度<select id="lc-edit-priority" '+(!row.companyId?'disabled':'')+'>'+
       '<option value="">元の優先度を使用</option>'+
       ['A','B','C','D'].map(x=>'<option>'+x+'</option>').join('')+
       '</select></label>'+
       '<details><summary>取引状態を確認・編集</summary>'+
       '<label>取引状態<select id="lc-edit-relationship"><option value="unknown">未確認</option>'+
         '<option value="active">取引中</option><option value="past">過去取引</option>'+
         '<option value="none_confirmed">取引なし確認済み</option></select></label>'+
       '<label>確認した根拠<textarea id="lc-edit-evidence" rows="2" maxlength="2000">'+esc(v.relationshipEvidence||'')+'</textarea></label>'+
       '<button type="button" id="lc-save-relationship" '+(!row.companyId?'disabled':'')+'>取引状態を保存</button>'+
       '</details></details><p id="lc-segment-status" role="status"></p>';
  $('lc-corporate-display').textContent=v.corporateNumber?v.corporateNumber+'　✎':'未登録　✎';
  $('lc-corporate-number').value=v.corporateNumber||'';

  $('lc-single-segment').value=row.broadcast?'broadcast':row.manualSegment||'auto';
  $('lc-single-segment').onchange=()=>saveClassification({action:'segment',segment:$('lc-single-segment').value});
  $('lc-edit-priority').value=v.manualPriority||'';
  $('lc-edit-priority').onchange=()=>saveClassification({action:'priority',priority:$('lc-edit-priority').value||null});
  $('lc-edit-relationship').value=v.relationshipStatus||'unknown';
  $('lc-save-relationship').onclick=()=>saveClassification({action:'relationship',relationshipStatus:$('lc-edit-relationship').value,evidence:$('lc-edit-evidence').value});
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editField(b));
  $('lc-copy-id').disabled=!row.companyId;
  const blocked=Boolean(row.blocked||v.needsContactReview||v.directoryExcluded||v.sales?.hidden||v.sales?.ngReason);
  $('lc-contact-alert').textContent=!row.companyId?'同名候補の参照です。企業ID照合後に営業を開始してください。':blocked?'連絡停止・注意の企業です。登録情報と履歴を確認してください。':'';
  $('lc-contact-alert').hidden=!$('lc-contact-alert').textContent;
  for(const b of document.querySelectorAll('[data-channel]')){
   const c=b.dataset.channel;
   const reason=c==='memo'?'':!row.companyId?'企業IDの照合待ち':blocked?'連絡停止・確認が必要':c==='email'&&!validEmail(v.contactEmail)?'メールアドレス未登録':c==='phone'&&!tel?'電話番号未登録':c==='form'&&!form&&!site?'問い合わせ先未登録':'';
   b.disabled=Boolean(reason);b.title=reason||'';
   const hint=b.querySelector('[data-hint]');if(hint)hint.textContent=reason||({phone:'発信画面を開く',email:'文面入りで作成',form:form?'営業文をコピーして開く':'ホームページで問い合わせ先を探す',memo:'結果・次回対応を記録'}[c]);
  }
  $('lc-call-link').innerHTML=tel&&!blocked&&row.companyId?'<a class="lc-primary-link" href="'+esc(tel)+'">'+esc(v.phone)+' に電話する</a>':'<p class="lc-detail-note">利用できる電話番号がありません。</p>';
  $('lc-form-link').innerHTML=!blocked&&row.companyId?(link(form, '問い合わせフォームを開く')||link(site,'ホームページで問い合わせ先を探す')):'';
  if(!form)$('lc-form-tip').textContent='ホームページで問い合わせ先を探し、営業連絡の受付可否を確認してください。開いただけでは送信済みになりません。';
  if(!state().to)state().to=v.contactEmail||'';
  $('lc-to').value=state().to;
  $('lc-action-body').hidden=true;
  $('lc-action-prompt').hidden=!$('lc-template-editor').hidden;
  document.querySelectorAll('[data-channel]').forEach(b=>b.setAttribute('aria-pressed','false'));
 }
 function startAction(value){
  if(!$('lc-template-editor').hidden){message('雛形の編集を保存またはキャンセルしてから操作してください。');return;}
  if(!row.companyId||!company)return;
  setChannel(value);
  if(value==='phone'){
   const url=phoneLink(company.phone);if(url)window.location.href=url;
   message('電話アプリを開きます。通話後に結果を記入してください。');
  }else if(value==='email'){
   message('宛先・件名・本文をこの画面で編集できます。送信接続が完了すると、ここから送信できます。');
   $('lc-subject').focus();
  }else if(value==='form'){
   const url=safeWebsite(company.formUrl)||safeWebsite(company.website);
   if(url)window.open(url,'_blank','noopener,noreferrer');
   navigator.clipboard.writeText(state().body).then(()=>message('フォームを開き、営業文をコピーしました。貼り付けて内容を確認し、送信後に結果を記入してください。')).catch(()=>message('サイトを開きました。本文を選択してコピーし、貼り付けてください。'));
  }
 }
 function setChannel(value){
  $('lc-action-body').hidden=false;$('lc-action-prompt').hidden=true;
  readInputs();channel=value;state().channel=value;state().result='';
  document.querySelectorAll('[data-channel]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.channel===channel)));
  const composing=channel==='email'||channel==='form';
  $('lc-compose').hidden=!composing;$('lc-email-to').hidden=channel!=='email';$('lc-phone-panel').hidden=channel!=='phone';$('lc-form-panel').hidden=channel!=='form';
  $('lc-result-field').hidden=channel==='email';$('lc-mail-controls').hidden=channel!=='email';$('lc-preview-action').hidden=channel==='email';$('lc-result-fields').hidden=channel==='email';$('lc-next-plan').hidden=channel==='email';$('lc-result-note').placeholder=channel==='phone'?'会話内容・担当者の反応を記入':channel==='form'?'送信先・フォームでの結果を記入':'今回わかったこと・次回のポイント';
  const results=ACTION_RESULTS[channel]||[];
  $('lc-result').innerHTML='<option value="">結果を選択</option>'+results.map(r=>'<option>'+esc(r)+'</option>').join('');
  $('lc-preview-action').textContent='結果と次回対応を保存';
 }
 async function loadWork(n,more=false){
  const d=await API.api('/api/sales/company-workbench?id='+encodeURIComponent(row.companyId)+(more&&historyCursor?'&before='+encodeURIComponent(historyCursor):''));
  if(!valid(n))return;
  workHistory=more?[...workHistory,...d.activities]:d.activities;historyCursor=d.nextBefore;
  $('lc-work-more').hidden=!historyCursor;
  if(!more){const p=d.override.work_plan||{};for(const [key,id] of [['owner','lc-owner'],['nextDate','lc-date'],['nextAction','lc-action']])if(key in p)$(id).value=p[key];
   row.manualSegment=d.override.lifecycle_segment||null;row.broadcast=Boolean(d.override.blast_target);if($('lc-single-segment'))$('lc-single-segment').value=row.broadcast?'broadcast':row.manualSegment||'auto';}
  showHistory();
 }
 async function saveClassification(patch){
  if(saving)return;const n=generation;saving=true;$('lc-close').disabled=true;$('lc-edit-status').textContent='保存中…';
  try{await API.api('/api/sales/enger-company-bulk',{method:'PATCH',body:{ids:[row.companyId],...patch}});if(!valid(n))return;
   if(patch.action==='segment'){row.manualSegment=['current','past','future'].includes(patch.segment)?patch.segment:null;row.broadcast=patch.segment==='broadcast';}
   $('lc-edit-status').textContent='保存しました。';void onSaved();
  }catch(e){if(valid(n))$('lc-edit-status').textContent=e.hint||'保存できませんでした。再取得してください。';}
  finally{saving=false;$('lc-close').disabled=false;}
 }
 function editField(button){
  if(saving||$('lc-body')?.readOnly){message('送信・保存の結果を確認してから編集してください。');return;}
  if(document.querySelector('.lc-inline-editor')){message('編集中の項目を保存またはキャンセルしてください。');return;}
  const key=button.dataset.edit,f=COMPANY_FIELDS[key],initial=company[key],cell=button.parentElement;
  const field=f.options?'<select aria-label="'+f.label+'">'+(f.type==='boolean'?'':'<option value="">未登録</option>')+f.options.map((v,i)=>'<option value="'+esc(f.type==='boolean'?String(Boolean(i)):v)+'">'+esc(v)+'</option>').join('')+'</select>':f.type==='textarea'?'<textarea aria-label="'+f.label+'" rows="3" maxlength="'+f.max+'"></textarea>':'<input aria-label="'+f.label+'" type="'+(f.type||'text')+'" maxlength="'+f.max+'">';
  cell.innerHTML='<div class="lc-inline-editor">'+field+'<div><button type="button" data-save>保存</button><button type="button" data-cancel>取消</button></div><small role="status"></small></div>';
  const input=cell.querySelector('input,select,textarea'),status=cell.querySelector('small'),save=cell.querySelector('[data-save]');input.value=f.type==='boolean'?String(Boolean(initial)):initial||'';input.focus();
  cell.querySelector('[data-cancel]').onclick=()=>cell.replaceChildren(button);
  let request=null;
  save.onclick=async()=>{
   if(saving)return;let patch;try{patch=profilePatch({[key]:f.type==='boolean'?input.value==='true':input.value});}catch(e){status.textContent=e.message;return;}
   const signature=JSON.stringify(patch);if(!request||request.signature!==signature)request={signature,key:crypto.randomUUID()};
   const n=generation;saving=true;$('lc-close').disabled=true;save.disabled=true;status.textContent='保存中…';
   try{await API.api('/api/sales/company-workbench',{method:'PATCH',body:{id:row.companyId,patch,requestKey:request.key}});if(!valid(n))return;
    const d=await API.api('/api/sales/enger-company-detail?id='+encodeURIComponent(row.companyId));if(!valid(n))return;company=d.company;evidence=d.evidence;
    if(key==='contactEmail'){state().to=company.contactEmail||'';}
    info(company);$('lc-detail-title').textContent=company.name;await loadWork(n);void onSaved();message('企業情報を保存しました。');
   }catch(e){if(valid(n))status.textContent=e.hint||e.message||'保存結果を確認できません。同じ内容で再度保存してください。';}
   finally{saving=false;$('lc-close').disabled=false;if(valid(n))save.disabled=false;}
  };
 }
 async function saveWork(onlyPlan=false){
  if(saving)return;readInputs();const s=state(),n=generation;
  if(!onlyPlan){
   const error=previewProblem({...s,sender:s.sender||viewer()||'営業担当',channel,blocked:Boolean(row.blocked||company?.needsContactReview||company?.directoryExcluded||company?.sales?.hidden||company?.sales?.ngReason),identified:Boolean(row.companyId&&company)});
   if(error){message(error);return;}
   if(channel==='memo'&&!s.note.trim()){message('送信先や対応内容をメモに入力してください。');return;}
  }
  let p;try{p=planInput(plan());}catch(e){message(e.message);return;}
  const payload=onlyPlan?{operation:'plan',plan:p}:{channel,result:s.result,note:s.note,subject:s.subject,body:s.body,plan:p};
  const signature=JSON.stringify(payload);if(!pendingActivity||pendingActivity.signature!==signature)pendingActivity={signature,key:crypto.randomUUID()};
  saving=true;$('lc-close').disabled=true;$('lc-preview-action').disabled=true;$('lc-save-plan').disabled=true;message('保存中…');
  try{
   await API.api('/api/sales/company-workbench',{method:onlyPlan?'PATCH':'POST',body:{id:row.companyId,requestKey:pendingActivity.key,...payload}});
   if(!valid(n))return;draft.delete(row.id);await loadWork(n);pendingActivity=null;void onSaved();
   if(!onlyPlan){$('lc-result').value='';$('lc-result-note').value='';state().result='';state().note='';}
   message('履歴・次回対応を保存しました。');
  }catch(e){if(valid(n))message(e.hint||'保存結果を確認できません。同じ内容で再度保存してください。');}
  finally{saving=false;$('lc-close').disabled=false;if(valid(n)){$('lc-preview-action').disabled=false;$('lc-save-plan').disabled=false;}}
 }
 function render(r){
  const c={...r,...record()},s=state();
  $('lc-detail-title').textContent=r.name;
  $('lc-detail').innerHTML='<div class="lc-workbench"><section class="lc-pane lc-info-pane" aria-label="登録情報"><h3>登録情報</h3><section class="lc-corp-top" aria-label="法人番号・公式情報"><span>法人番号（13桁）</span><button type="button" id="lc-corporate-display" class="lc-edit-value">未登録　✎</button><div id="lc-corp-edit" hidden><input id="lc-corporate-number" type="text" inputmode="numeric" maxlength="13" pattern="[0-9]{13}" placeholder="13桁" aria-label="法人番号"><button type="button" data-official-number="true">照合して保存</button><button type="button" id="lc-corp-cancel">取消</button></div><small>法人番号を照合後、企業基本情報を補完します。ENGER企業IDとは別です。</small></section><div class="lc-company-id"><span>企業ID（ENGER）</span><code id="lc-full-id">'+esc(r.companyId||'未照合')+'</code><button type="button" id="lc-copy-id" '+(!r.companyId?'disabled':'')+'>IDをコピー</button></div><div class="lc-company-continue"><button type="button" id="lc-go-to-prep">企業情報を確認して商談管理へ →</button></div><div id="lc-company-info" aria-live="polite">登録情報・履歴を読み込み中…</div><div id="lc-candidate-list"></div>'+(r.proposals.length?'<details open><summary>進行中提案 '+r.proposals.length+'件</summary>'+r.proposals.map(p=>'<div class="lc-history">'+esc(p.stage)+' · '+esc(stamp(p.updatedAt))+'<small>提案ID '+esc(p.id)+'</small></div>').join('')+'</details>':'')+'</section>'+
   '<section class="lc-pane lc-action-pane" aria-label="営業アクション"><h3>次のアクション</h3><p id="lc-contact-alert" class="lc-error" hidden></p><div class="lc-action-tabs">'+[['phone','電話','call','発信画面を開く'],['email','メール','mail','文面入りで作成'],['form','フォームアタック','contact_page','営業文をコピーして開く'],['memo','記録のみ','edit_note','結果・次回対応を記録']].map(([id,label,icon,hint])=>'<button type="button" data-channel="'+id+'" disabled aria-pressed="false" aria-label="'+label+'"><span class="material-symbols-outlined lc-action-icon" aria-hidden="true">'+icon+'</span><span class="lc-action-copy"><strong>'+label+'</strong><small data-hint="'+id+'">'+hint+'</small></span><span class="material-symbols-outlined lc-action-check" aria-hidden="true">check_circle</span></button>').join('')+'</div><div class="lc-template-toolbar"><label>メールの雛形<select id="lc-template" aria-label="メールの雛形"></select></label><div class="lc-template-buttons"><button type="button" id="lc-template-add" disabled><span class="material-symbols-outlined" aria-hidden="true">add</span>追加</button><button type="button" id="lc-template-edit" disabled><span class="material-symbols-outlined" aria-hidden="true">edit</span>編集</button></div></div><p class="lc-detail-note" id="lc-template-status" role="status">雛形を読み込み中…</p><section id="lc-template-editor" class="lc-template-editor" aria-labelledby="lc-template-editor-title" hidden><h4 id="lc-template-editor-title"></h4><p id="lc-template-save-note" class="lc-detail-note"></p><fieldset id="lc-template-fields"><label>雛形の名前<input id="lc-t-name" maxlength="100" placeholder="例：案件ニーズの確認"></label><label>雛形の件名<input id="lc-t-subject" maxlength="300"></label><label>雛形の本文<textarea id="lc-t-body" rows="8" maxlength="20000"></textarea></label><p class="lc-template-variables">差し込み：<code>{{company}}</code> 企業名　<code>{{contact}}</code> 担当窓口　<code>{{sender}}</code> 送る人<br><code>{{service}}</code> サービス　<code>{{url}}</code> リンク先</p><div class="lc-fields"><label>対象サービス<input id="lc-t-service" maxlength="100"></label><label>リンク先URL<input id="lc-t-url" type="url" maxlength="500" placeholder="https://..."></label></div><div class="lc-template-buttons"><button type="button" id="lc-template-save" class="lc-primary"><span class="material-symbols-outlined" aria-hidden="true">save</span>雛形を保存</button><button type="button" id="lc-template-cancel">キャンセル</button></div></fieldset><p id="lc-template-error" role="status" aria-live="polite"></p></section><p class="lc-detail-note" id="lc-action-prompt">企業情報と履歴を確認したら、次のアクションを選んでください。<br>電話は発信画面、メールは文面入りの作成画面、フォームは問い合わせ先を開きます。</p><div id="lc-action-body" hidden><div id="lc-phone-panel" hidden><div id="lc-call-link"></div><p class="lc-detail-note">端末の電話アプリを開きます。通話後に結果を選んでください。</p></div><div id="lc-form-panel" hidden><div id="lc-form-link"></div><p id="lc-form-tip" class="lc-detail-note">本文をコピー → フォームを開く → 送信後に結果を記録。</p></div>'+
   '<div id="lc-compose" hidden><div class="lc-fields"><label>送る人の名前<input id="lc-sender" maxlength="80" value="'+esc(s.sender)+'"></label></div><label id="lc-email-to">宛先<input id="lc-to" type="email" maxlength="254" value="'+esc(s.to)+'"></label><label>件名<input id="lc-subject" maxlength="300" value="'+esc(s.subject)+'"></label><label>本文<textarea id="lc-body" rows="7" maxlength="20000">'+esc(s.body)+'</textarea></label><div class="lc-compose-tools"><button type="button" id="lc-insert-template">テンプレートを反映</button><button type="button" id="lc-copy-body">本文をコピー</button></div></div>'+
   '<section id="lc-mail-controls" hidden><p class="lc-detail-note">送信元：<strong id="lc-mail-from">確認中…</strong></p><p id="lc-mail-config" class="lc-detail-note"></p><button type="button" id="lc-mail-send" class="lc-primary" disabled>送信して履歴に保存</button><button type="button" id="lc-mail-new" hidden>新しいメールを作成</button><p class="lc-detail-note">送信受付は配信サーバーの応答です。到達・開封・返信は未確認です。</p></section><div id="lc-result-fields" class="lc-fields lc-result-fields"><label id="lc-result-field">対応結果<select id="lc-result"></select></label><label>メモ<textarea id="lc-result-note" rows="2" maxlength="2000">'+esc(s.note)+'</textarea></label></div>'+
   '<details id="lc-next-plan" class="lc-next-plan" open><summary>次回対応</summary><div class="lc-fields"><label>担当<input id="lc-owner" maxlength="80" value="'+esc(c.owner||viewer()||'')+'"></label><label>次回予定<input type="date" id="lc-date" value="'+esc(c.nextDate)+'"></label><label class="wide">次にすること<input id="lc-action" maxlength="200" value="'+esc(c.nextAction)+'"></label></div><button type="button" id="lc-save-plan">次回対応だけ保存</button></details><button type="button" id="lc-preview-action" class="lc-primary" disabled>結果と次回対応を保存</button></div><p id="lc-work-status" role="status" aria-live="polite">メールは送信操作で自動記録。電話・フォームは対応後に結果を保存してください。</p></section>'+
   '<section class="lc-pane lc-history-pane" aria-label="営業履歴"><div id="lc-company-segment-fields" class="lc-company-segment-fields"></div><h3>営業履歴 <small id="lc-history-count"></small></h3><p class="lc-detail-note">新しい順・日時と記録元を表示</p><div class="lc-compose-tools"><button type="button" id="lc-work-refresh">対応履歴を再取得</button><button type="button" id="lc-work-more" hidden>以前の対応を見る</button><button type="button" id="lc-mail-refresh">メール履歴を再取得</button><button type="button" id="lc-mail-more" hidden>以前のメールを見る</button></div><p id="lc-mail-history-warning" class="lc-error" role="status"></p><div id="lc-history-list" aria-live="polite">履歴を読み込み中…</div></section></div>';
  $('lc-copy-id').onclick=()=>copy(row.companyId);
   $('lc-corporate-display').disabled=!row.companyId;
   $('lc-corporate-display').onclick=()=>{
     if(!row.companyId)return;
     $('lc-corp-edit').hidden=false;
     $('lc-corporate-number').focus();
     $('lc-corporate-number').select();
   };
   $('lc-corp-cancel').onclick=()=>{
     $('lc-corp-edit').hidden=true;
     $('lc-corporate-number').value=company?.corporateNumber||'';
   };
   $('lc-go-to-prep').disabled=!row.companyId;

  $('lc-copy-body').onclick=()=>{readInputs();void copy(state().body);};
  $('lc-preview-action').onclick=()=>saveWork();
  $('lc-work-refresh').onclick=()=>loadWork(generation).catch(()=>message('履歴を取得できませんでした。'));$('lc-work-more').onclick=()=>loadWork(generation,true).catch(()=>message('以前の履歴を取得できませんでした。'));
  $('lc-save-plan').onclick=()=>saveWork(true);
  document.querySelectorAll('[data-channel]').forEach(b=>b.onclick=()=>startAction(b.dataset.channel));
  $('lc-template').onchange=()=>{readInputs();state().templateId=$('lc-template').value;applyTemplate();message('選んだ雛形を反映しました。メール・フォームから作業を開始できます。');};
  $('lc-template-add').onclick=()=>editTemplate(true);$('lc-template-edit').onclick=()=>editTemplate(false);
  $('lc-template-cancel').onclick=closeTemplateEditor;$('lc-template-save').onclick=saveTemplate;
  $('lc-insert-template').onclick=()=>{readInputs();applyTemplate();message('テンプレートを反映しました。宛先・内容を確認してください。');};
  for(const id of ['lc-sender','lc-to','lc-subject','lc-body','lc-result','lc-result-note'])$(id).addEventListener('input',()=>{readInputs();});
  $('lc-dialog').addEventListener('cancel',e=>{if(saving)e.preventDefault();});
 $('lc-dialog').addEventListener('close',readInputs,{once:true});
 }
 function options(){
  const selected=state().templateId;
  const group=(name,list)=>'<optgroup label="'+name+'">'+list.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.name)+'</option>').join('')+'</optgroup>';
  $('lc-template').innerHTML=group('標準の雛形',templates.filter(t=>DEFAULT_TEMPLATES.some(d=>d.id===t.id)))+group('保存した雛形',templates.filter(t=>!DEFAULT_TEMPLATES.some(d=>d.id===t.id)));
  $('lc-template').value=selected;
  if(!$('lc-template').value){state().templateId=templates[0].id;$('lc-template').value=state().templateId;}
  $('lc-template-add').disabled=!templatesLoaded||templateSaving;$('lc-template-edit').disabled=!templatesLoaded||templateSaving;
 }
 function editTemplate(isNew){
  if($('lc-body')?.readOnly){message('送信依頼の結果を確認してから新しいメールを作成してください。');return;}
  readInputs();editingTemplate=isNew?null:templates.find(t=>t.id===state().templateId);
  const standard=editingTemplate&&DEFAULT_TEMPLATES.some(t=>t.id===editingTemplate.id);
  const t=editingTemplate||{name:'',subject:'',body:'{{company}}\n{{contact}}\n\n株式会社エイトの{{sender}}です。\n\n',service:'',destinationUrl:''};
  editorReturn=!$('lc-action-body').hidden;
  $('lc-template-editor').hidden=false;$('lc-action-body').hidden=true;$('lc-action-prompt').hidden=true;
  $('lc-template').disabled=true;$('lc-template-add').disabled=true;$('lc-template-edit').disabled=true;
  $('lc-template-fields').disabled=false;$('lc-template-error').textContent='';
  $('lc-template-editor-title').textContent=isNew?'メールの雛形を追加':standard?'標準の雛形を編集して保存':'メールの雛形を編集';
  $('lc-template-save-note').textContent=(standard?'標準の雛形は変更せず、編集したコピーを新しく保存します。':'')+'保存するとメンバー共通の雛形に反映されます。メールは送信されません。';
  for(const [id,key] of [['lc-t-name','name'],['lc-t-subject','subject'],['lc-t-body','body'],['lc-t-service','service'],['lc-t-url','destinationUrl']])$(id).value=t[key]||'';
  if(standard)$('lc-t-name').value=t.name+'（編集版）';
  $('lc-t-name').focus();
 }
 function closeTemplateEditor(){
  $('lc-template-editor').hidden=true;$('lc-template').disabled=false;
  $('lc-action-body').hidden=!editorReturn;$('lc-action-prompt').hidden=editorReturn;
  options();
 }
 async function saveTemplate(){
  if(templateSaving)return;
  let request;
  try{request=templateRequest(editingTemplate,{name:$('lc-t-name').value,subject:$('lc-t-subject').value,body:$('lc-t-body').value,service:$('lc-t-service').value,destinationUrl:$('lc-t-url').value});}
  catch(e){$('lc-template-error').textContent=e.message;return;}
  const n=generation;templateSaving=true;$('lc-template-fields').disabled=true;$('lc-template-error').textContent='保存中…';
  try{
   const d=await API.api('/api/sales/templates',request);
   if(!d.template?.id)throw Error('保存結果を確認できませんでした。雛形一覧を再取得して確認してください。');
   templates=[...templates.filter(t=>t.id!==d.template.id),d.template];
   templatePromise=Promise.resolve({templates:templates.filter(t=>!DEFAULT_TEMPLATES.some(x=>x.id===t.id)),warning:''});
   if(valid(n)){state().templateId=d.template.id;options();applyTemplate();closeTemplateEditor();message('雛形を保存しました。ほかの企業でも使えます。');$('lc-template-status').textContent='保存済み・メンバー共通';}
  }catch(e){if(valid(n))$('lc-template-error').textContent=e.hint||e.message||'保存できませんでした。入力内容を確認してください。';}
  finally{templateSaving=false;if(valid(n))$('lc-template-fields').disabled=false;if($('lc-dialog').open&&$('lc-template-editor').hidden)options();}
 }

 async function loadCompany(id,n,isCandidate=false){
  $('lc-company-info').textContent='登録情報・履歴を読み込み中…';$('lc-history-list').textContent='履歴を読み込み中…';
  try{
   const d=await API.api('/api/sales/enger-company-detail?id='+encodeURIComponent(id));if(!valid(n))return;
   company=d.company;evidence=d.evidence;salesHistory=[];historyWarning='';info(company);
   $('lc-preview-action').disabled=isCandidate;$('lc-save-plan').disabled=isCandidate;
   if(!state().body)applyTemplate();showHistory();
   if(!isCandidate){await loadWork(n);if(!valid(n))return;}
   if(!isCandidate)attachCompanyMail({companyId:id,isCurrent:()=>valid(n),onMessage:message,onHistory:items=>{mailHistory=items;showHistory();}});
   if(evidence.salesLinkAmbiguous){historyWarning='Sales企業IDが複数あります。Sales履歴は照合後に確認してください。';showHistory();}
   else if(evidence.linkedSalesCompanyId){
    try{const sd=await API.api('/api/sales/companies/detail?id='+encodeURIComponent(evidence.linkedSalesCompanyId));if(!valid(n))return;salesHistory=sd.timeline||[];if(sd.historyComplete===false)historyWarning='Sales履歴の一部を取得できませんでした。';showHistory();}
    catch{if(!valid(n))return;historyWarning='Sales履歴を取得できませんでした。モーダルを開き直してください。';showHistory();}
   }
  }catch(e){if(!valid(n))return;$('lc-company-info').textContent=e.hint||'登録情報を取得できませんでした。';$('lc-history-list').textContent='履歴未取得。モーダルを開き直してください。';}
 }
 async function open(r){
  if(saving){message('保存が完了してから企業を切り替えてください。');return;}
  if(row&&$('lc-dialog').open)readInputs();row=r;company=null;evidence=null;salesHistory=[];mailHistory=[];historyWarning='';const n=++generation;
  workHistory=[];historyCursor=null;pendingActivity=null;render(r);options();if(!$('lc-dialog').open)$('lc-dialog').showModal();
  if(!templatePromise)templatePromise=API.api('/api/sales/templates').then(d=>({templates:d.templates?.filter(t=>!t.archived)||[],warning:d.notReady?'登録済みテンプレートは未設定です。標準文面を使えます。':''})).catch(()=>({templates:[],warning:'登録済みテンプレートを取得できませんでした。標準文面を使えます。'}));
  void templatePromise.then(d=>{if(!valid(n))return;templates=[...DEFAULT_TEMPLATES,...d.templates];templatesLoaded=true;options();$('lc-template-status').textContent=d.warning;});
  if(r.companyId)void loadCompany(r.companyId,n);
  else{
   $('lc-company-info').textContent='企業IDが未照合です。同名候補の情報を比較してください。';$('lc-history-list').textContent='照合済み企業IDの履歴はまだ表示できません。';
   $('lc-candidate-list').innerHTML=(r.candidateIds||[]).map(c=>'<button type="button" data-candidate="'+esc(c.id)+'">'+esc(c.name)+'<small>'+esc(c.id)+'</small></button>').join('')||'<p>同名候補なし</p>';
   $('lc-save-plan').disabled=true;
   document.querySelectorAll('[data-candidate]').forEach(b=>b.onclick=()=>{const token=++generation;void loadCompany(b.dataset.candidate,token,true);});
  }
 }
 $('lc-dialog').addEventListener('cancel',e=>{if(saving)e.preventDefault();});
 $('lc-dialog').addEventListener('close',()=>{generation++;});
 return {open,refresh:()=>{if(row?.companyId&&$('lc-dialog').open)void loadCompany(row.companyId,generation);}};
}
