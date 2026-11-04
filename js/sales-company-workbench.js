import {DEFAULT_TEMPLATES,fillTemplate,safeWebsite,phoneLink,previewProblem,mergeHistory,validEmail} from '../lib/sales-contact-preview.js';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=v=>v?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'日時未登録';
const kv=(label,value)=>'<div class="lc-kv"><dt>'+esc(label)+'</dt><dd>'+esc(value||'未登録')+'</dd></div>';
const link=(url,text)=>url?'<a class="lc-link" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(text)+' ↗</a>':'';
export function createCompanyWorkbench({draft,onChange,viewer}){
 let generation=0,row=null,company=null,evidence=null,salesHistory=[],historyWarning='',channel='memo',templates=DEFAULT_TEMPLATES,templatePromise;
 const compose=new Map();
 const valid=n=>n===generation&&$('lc-dialog').open;
 const record=()=>draft.get(row.id)||{};
 const state=()=>{if(!compose.has(row.id))compose.set(row.id,{sender:viewer()||'',to:'',subject:'',body:'',templateId:'intro',result:'',note:'',channel:null});return compose.get(row.id);};
 function message(text){$('lc-work-status').textContent=text;}
 async function copy(text){try{await navigator.clipboard.writeText(text);message('コピーしました。');}catch{message('コピーできませんでした。文字を選択してコピーしてください。');}}
 function templateValues(){return {company:company?.name||row.name,contact:company?.contactName?company.contactName+' 様':'ご担当者様',sender:state().sender,service:templates.find(t=>t.id===state().templateId)?.service||'',url:templates.find(t=>t.id===state().templateId)?.destinationUrl||''};}
 function applyTemplate(){const t=templates.find(t=>t.id===state().templateId)||templates[0];Object.assign(state(),fillTemplate(t,templateValues()));$('lc-subject').value=state().subject;$('lc-body').value=state().body;}
 function readInputs(){
  if(!$('lc-sender'))return;
  for(const [key,id] of [['sender','lc-sender'],['to','lc-to'],['subject','lc-subject'],['body','lc-body'],['result','lc-result'],['note','lc-result-note']])state()[key]=$(id).value;
 }
 function plan(){return {owner:$('lc-owner').value.trim(),nextDate:$('lc-date').value,nextAction:$('lc-action').value.trim()};}
 function showHistory(){
  const old=company?.historicalContactDate||company?.historicalActivityCount||company?.lastActivity;
  const historical=old?[{id:'legacy',at:company.historicalContactDate||null,label:'旧資料の接点記録',detail:[company.lastActivity,company.historicalActivityCount?'記録件数：'+company.historicalActivityCount+'件（個別内容は未取得）':null].filter(Boolean).join('\n'),source:'旧資料'}]:[];
  const items=[...mergeHistory(evidence?.touchpoints||[],salesHistory,record().events||[]),...historical].sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  $('lc-history-count').textContent=items.length+'件';
  $('lc-history-list').innerHTML=(historyWarning?'<p class="lc-error">'+esc(historyWarning)+'</p>':'')+(items.length?items.map(t=>'<article class="lc-history"><small>'+esc(stamp(t.at))+' · '+esc(t.source)+'</small><strong>'+esc(t.label)+'</strong>'+(t.actor?'<small>記録者'+(t.source==='ENGER'?'ID':'')+'：'+esc(t.actor)+'</small>':'')+(t.detail?'<details><summary>内容を見る</summary><p>'+esc(t.detail)+'</p></details>':'')+(t.nextAction||t.nextDate?'<small>次回：'+esc([t.nextDate,t.nextAction].filter(Boolean).join(' ／ '))+'</small>':'')+'</article>').join(''):'<p class="lc-detail-note">この企業IDの履歴はありません。別ID・未照合の記録は含みません。</p>');
 }
 function info(v){
  const site=safeWebsite(v.website),form=safeWebsite(v.formUrl),tel=phoneLink(v.phone);
  $('lc-company-info').innerHTML='<dl>'+kv('担当窓口',v.contactName)+kv('メール',v.contactEmail)+kv('電話',v.phone)+kv('所在地',v.address||v.prefecture)+kv('業種',v.industry)+kv('最終連絡',v.lastContactedAt?stamp(v.lastContactedAt):null)+'</dl><div class="lc-info-links">'+link(site,'ホームページ')+link(form,'問い合わせフォーム')+'</div>'+(v.note?'<details><summary>登録メモ</summary><p class="lc-detail-note">'+esc(v.note)+'</p></details>':'')+'<details><summary>分類・管理情報</summary><dl>'+kv('分類の根拠',row.reason)+kv('取引の根拠',row.relationshipEvidence)+kv('取込元',v.dataSource)+kv('Sales企業ID',v.sales?.id)+kv('Sales担当',v.sales?.ownerName)+'</dl></details>';
  $('lc-copy-id').disabled=!row.companyId;
  const blocked=Boolean(row.blocked||v.needsContactReview||v.directoryExcluded||v.sales?.hidden||v.sales?.ngReason);
  $('lc-contact-alert').textContent=!row.companyId?'同名候補の参照です。企業ID照合後に営業を開始してください。':blocked?'連絡停止・注意の企業です。登録情報と履歴を確認してください。':'';
  $('lc-contact-alert').hidden=!$('lc-contact-alert').textContent;
  for(const b of document.querySelectorAll('[data-channel]')){const c=b.dataset.channel;b.disabled=c!=='memo'&&(!row.companyId||blocked||(c==='email'&&!validEmail(v.contactEmail))||(c==='phone'&&!tel)||(c==='form'&&!form&&!site));}
  $('lc-call-link').innerHTML=tel&&!blocked&&row.companyId?'<a class="lc-primary-link" href="'+esc(tel)+'">'+esc(v.phone)+' に電話する</a>':'<p class="lc-detail-note">利用できる電話番号がありません。</p>';
  $('lc-form-link').innerHTML=!blocked&&row.companyId?(link(form, '問い合わせフォームを開く')||link(site,'ホームページで問い合わせ先を探す')):'';
  if(!form)$('lc-form-tip').textContent='ホームページで問い合わせ先を探し、営業連絡の受付可否を確認してください。開いただけでは送信済みになりません。';
  if(!state().to)state().to=v.contactEmail||'';
  $('lc-to').value=state().to;
  const wanted=state().channel|| (validEmail(v.contactEmail)?'email':tel?'phone':form||site?'form':'memo');
  const button=document.querySelector('[data-channel="'+wanted+'"]');
  setChannel(button&&!button.disabled?wanted:'memo');
 }
 function setChannel(value){
  readInputs();channel=value;state().channel=value;state().result='';
  document.querySelectorAll('[data-channel]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.channel===channel)));
  const composing=channel==='email'||channel==='form';
  $('lc-compose').hidden=!composing;$('lc-email-to').hidden=channel!=='email';$('lc-phone-panel').hidden=channel!=='phone';$('lc-form-panel').hidden=channel!=='form';
  $('lc-result-field').hidden=channel==='email';$('lc-result-note').placeholder=channel==='phone'?'会話内容・担当者の反応を記入':channel==='form'?'送信先・フォームでの結果を記入':'今回わかったこと・次回のポイント';
  const results=channel==='phone'?['通話できた','不在・つながらない','折り返し待ち','資料送付を依頼された','商談・面談を調整','連絡不要と言われた']:channel==='form'?['フォーム送信完了','問い合わせ先を調査中','フォームが使えない','営業連絡を受け付けていない']:['情報を確認','連絡先を調査','次回対応を設定','その他'];
  $('lc-result').innerHTML='<option value="">結果を選択</option>'+results.map(r=>'<option>'+esc(r)+'</option>').join('');
  $('lc-preview-action').textContent=channel==='email'?'送信内容を確認':'結果を履歴に追加（プレビュー）';
  $('lc-confirm').hidden=true;
 }
 function addPreview(){
  const s=state(),p=plan(),label=channel==='email'?'メール送信を試行（未送信）':({phone:'電話',form:'フォーム',memo:'メモ'}[channel]+'：'+s.result);
  const detail=[channel==='email'?'宛先：'+s.to:null,channel==='email'||channel==='form'?'件名：'+s.subject+'\n'+s.body:null,s.note].filter(Boolean).join('\n\n');
  const event={id:'preview:'+Date.now()+':'+Math.random().toString(36).slice(2),at:new Date().toISOString(),label,detail,actor:viewer()||s.sender||'確認中のメンバー',...p};
  draft.set(row.id,{...record(),...p,events:[event,...(record().events||[])]});
  $('lc-confirm').hidden=true;$('lc-result').value='';$('lc-result-note').value='';state().note='';state().result='';showHistory();onChange();
  message(channel==='email'?'送信操作を確認しました。外部には送信していません。':'確認用の履歴に追加しました。本番には保存していません。');
 }
 function attempt(){
  readInputs();const s=state(),blocked=Boolean(row.blocked||company?.needsContactReview||company?.directoryExcluded||company?.sales?.hidden||company?.sales?.ngReason);
  const error=previewProblem({...s,channel,blocked,identified:Boolean(row.companyId&&company)});
  if(error){message(error);return;}
  if(channel==='memo'&&!s.note.trim()){message('記録する内容を入力してください。');return;}
  if(channel==='email'){
   $('lc-confirm').hidden=false;$('lc-confirm-text').textContent='宛先：'+s.to+'\n件名：'+s.subject+'\n\n'+s.body;
   $('lc-confirm-send').focus();
  }else addPreview();
 }
 function render(r){
  const c={...r,...record()},s=state();
  $('lc-detail-title').textContent=r.name;
  $('lc-detail').innerHTML='<div class="lc-workbench"><section class="lc-pane lc-info-pane" aria-label="登録情報"><h3>登録情報</h3><div class="lc-company-id"><span>企業ID（ENGER）</span><code id="lc-full-id">'+esc(r.companyId||'未照合')+'</code><button type="button" id="lc-copy-id" '+(!r.companyId?'disabled':'')+'>IDをコピー</button></div><div id="lc-company-info" aria-live="polite">登録情報・履歴を読み込み中…</div><div id="lc-candidate-list"></div>'+(r.proposals.length?'<details><summary>進行中提案 '+r.proposals.length+'件</summary>'+r.proposals.map(p=>'<div class="lc-history">'+esc(p.stage)+' · '+esc(stamp(p.updatedAt))+'<small>提案ID '+esc(p.id)+'</small></div>').join('')+'</details>':'')+'</section>'+
   '<section class="lc-pane lc-action-pane" aria-label="営業アクション"><h3>営業アクション</h3><p id="lc-contact-alert" class="lc-error" hidden></p><div class="lc-action-tabs">'+[['email','メール'],['phone','電話'],['form','フォーム'],['memo','メモ']].map(([id,label])=>'<button type="button" data-channel="'+id+'" disabled aria-pressed="false">'+label+'</button>').join('')+'</div><div id="lc-phone-panel" hidden><div id="lc-call-link"></div><p class="lc-detail-note">端末の電話アプリを開きます。通話後に結果を選んでください。</p></div><div id="lc-form-panel" hidden><div id="lc-form-link"></div><p id="lc-form-tip" class="lc-detail-note">本文をコピー → フォームを開く → 送信後に結果を記録。</p></div>'+
   '<div id="lc-compose" hidden><div class="lc-fields"><label>テンプレート<select id="lc-template"></select></label><label>送る人の名前<input id="lc-sender" maxlength="80" value="'+esc(s.sender)+'"></label></div><p class="lc-detail-note" id="lc-template-status"></p><label id="lc-email-to">宛先<input id="lc-to" type="email" maxlength="254" value="'+esc(s.to)+'"></label><label>件名<input id="lc-subject" maxlength="300" value="'+esc(s.subject)+'"></label><label>本文<textarea id="lc-body" rows="7" maxlength="20000">'+esc(s.body)+'</textarea></label><div class="lc-compose-tools"><button type="button" id="lc-insert-template">テンプレートを反映</button><button type="button" id="lc-copy-body">本文をコピー</button></div></div>'+
   '<div class="lc-fields lc-result-fields"><label id="lc-result-field">対応結果<select id="lc-result"></select></label><label>メモ<textarea id="lc-result-note" rows="2" maxlength="2000">'+esc(s.note)+'</textarea></label></div>'+
   '<details class="lc-next-plan" open><summary>次回対応</summary><div class="lc-fields"><label>担当<input id="lc-owner" maxlength="80" value="'+esc(c.owner||viewer()||'')+'"></label><label>次回予定<input type="date" id="lc-date" value="'+esc(c.nextDate)+'"></label><label class="wide">次にすること<input id="lc-action" maxlength="200" value="'+esc(c.nextAction)+'"></label></div><button type="button" id="lc-save-plan">次回対応だけ仮保存</button></details><button type="button" id="lc-preview-action" class="lc-primary" disabled>結果を履歴に追加（プレビュー）</button><div id="lc-confirm" class="lc-confirm" hidden><strong>送信内容の確認</strong><pre id="lc-confirm-text"></pre><p>確認用です。実際のメールは送信されません。</p><button type="button" id="lc-confirm-send">送信を試す（外部送信なし）</button><button type="button" id="lc-confirm-cancel">編集に戻る</button></div><p id="lc-work-status" role="status" aria-live="polite">記録は確認用です。ページの再読み込みで消えます。</p></section>'+
   '<section class="lc-pane lc-history-pane" aria-label="営業履歴"><h3>営業履歴 <small id="lc-history-count"></small></h3><p class="lc-detail-note">新しい順・日時と記録元を表示</p><div id="lc-history-list" aria-live="polite">履歴を読み込み中…</div></section></div>';
  $('lc-copy-id').onclick=()=>copy(row.companyId);
  $('lc-copy-body').onclick=()=>{readInputs();void copy(state().body);};
  $('lc-preview-action').onclick=attempt;$('lc-confirm-send').onclick=addPreview;$('lc-confirm-cancel').onclick=()=>{$('lc-confirm').hidden=true;$('lc-subject').focus();};
  $('lc-save-plan').onclick=()=>{draft.set(row.id,{...record(),...plan()});onChange();message('次回対応を仮保存しました。本番には保存していません。');};
  document.querySelectorAll('[data-channel]').forEach(b=>b.onclick=()=>setChannel(b.dataset.channel));
  $('lc-template').onchange=()=>{readInputs();state().templateId=$('lc-template').value;message('「テンプレートを反映」で本文を置き換えます。');};
  $('lc-insert-template').onclick=()=>{readInputs();applyTemplate();message('テンプレートを反映しました。宛先・内容を確認してください。');};
  for(const id of ['lc-sender','lc-to','lc-subject','lc-body','lc-result','lc-result-note'])$(id).addEventListener('input',()=>{readInputs();$('lc-confirm').hidden=true;});
  $('lc-dialog').addEventListener('close',readInputs,{once:true});
 }
 function options(){const s=state();$('lc-template').innerHTML=templates.map(t=>'<option value="'+esc(t.id)+'">'+esc(t.name)+'</option>').join('');$('lc-template').value=s.templateId;if(!$('lc-template').value){s.templateId=templates[0].id;$('lc-template').value=s.templateId;}}
 async function loadCompany(id,n,isCandidate=false){
  $('lc-company-info').textContent='登録情報・履歴を読み込み中…';$('lc-history-list').textContent='履歴を読み込み中…';
  try{
   const d=await API.api('/api/sales/enger-company-detail?id='+encodeURIComponent(id));if(!valid(n))return;
   company=d.company;evidence=d.evidence;salesHistory=[];historyWarning='';info(company);
   $('lc-preview-action').disabled=isCandidate;$('lc-save-plan').disabled=isCandidate;
   if(!state().body)applyTemplate();showHistory();
   if(evidence.salesLinkAmbiguous){historyWarning='Sales企業IDが複数あります。Sales履歴は照合後に確認してください。';showHistory();}
   else if(evidence.linkedSalesCompanyId){
    try{const sd=await API.api('/api/sales/companies/detail?id='+encodeURIComponent(evidence.linkedSalesCompanyId));if(!valid(n))return;salesHistory=sd.timeline||[];if(sd.historyComplete===false)historyWarning='Sales履歴の一部を取得できませんでした。';showHistory();}
    catch{if(!valid(n))return;historyWarning='Sales履歴を取得できませんでした。モーダルを開き直してください。';showHistory();}
   }
  }catch(e){if(!valid(n))return;$('lc-company-info').textContent=e.hint||'登録情報を取得できませんでした。';$('lc-history-list').textContent='履歴未取得。モーダルを開き直してください。';}
 }
 async function open(r){
  if(row&&$('lc-dialog').open)readInputs();row=r;company=null;evidence=null;salesHistory=[];historyWarning='';const n=++generation;
  render(r);options();if(!$('lc-dialog').open)$('lc-dialog').showModal();
  if(!templatePromise)templatePromise=API.api('/api/sales/templates').then(d=>({templates:d.templates?.filter(t=>!t.archived)||[],warning:d.notReady?'登録済みテンプレートは未設定です。標準文面を使えます。':''})).catch(()=>({templates:[],warning:'登録済みテンプレートを取得できませんでした。標準文面を使えます。'}));
  void templatePromise.then(d=>{if(!valid(n))return;templates=[...DEFAULT_TEMPLATES,...d.templates];options();$('lc-template-status').textContent=d.warning;});
  if(r.companyId)void loadCompany(r.companyId,n);
  else{
   $('lc-company-info').textContent='企業IDが未照合です。同名候補の情報を比較してください。';$('lc-history-list').textContent='照合済み企業IDの履歴はまだ表示できません。';
   $('lc-candidate-list').innerHTML=(r.candidateIds||[]).map(c=>'<button type="button" data-candidate="'+esc(c.id)+'">'+esc(c.name)+'<small>'+esc(c.id)+'</small></button>').join('')||'<p>同名候補なし</p>';
   $('lc-save-plan').disabled=true;
   document.querySelectorAll('[data-candidate]').forEach(b=>b.onclick=()=>{const token=++generation;void loadCompany(b.dataset.candidate,token,true);});
  }
 }
 $('lc-dialog').addEventListener('close',()=>{generation++;});
 return {open};
}
