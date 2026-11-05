import {attachCompanyMail} from './sales-company-mail.js';
import {DEFAULT_TEMPLATES,fillTemplate,safeWebsite,phoneLink,previewProblem,mergeHistory,validEmail,templateRequest} from '../lib/sales-contact-preview.js';
const $=id=>document.getElementById(id);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=v=>v?new Date(v).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'日時未登録';
const kv=(label,value)=>'<div class="lc-kv"><dt>'+esc(label)+'</dt><dd>'+esc(value||'未登録')+'</dd></div>';
const link=(url,text)=>url?'<a class="lc-link" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(text)+' ↗</a>':'';
export function createCompanyWorkbench({draft,onChange,viewer}){
 let generation=0,row=null,company=null,evidence=null,salesHistory=[],mailHistory=[],historyWarning='',channel='memo',templates=[...DEFAULT_TEMPLATES],templatePromise,templatesLoaded=false,editingTemplate=null,editorReturn=false,templateSaving=false;
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
  const items=[...mergeHistory(evidence?.touchpoints||[],salesHistory,record().events||[]),...historical,...mailHistory.map(m=>({id:'mail:'+m.id,at:m.created_at,source:'Salesメール',label:({accepted:'送信受付済み',sending:'送信処理中・結果未確定',unknown:'送信結果不明（再送しないでください）',not_sent:'未送信'}[m.status]||m.status)+'：'+m.subject,actor:m.actor_name,detail:'宛先：'+m.to_email+'\n送信元：'+m.from_email+'\n\n'+m.body_text,mail:true}))].sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  $('lc-history-count').textContent=items.length+'件';
  $('lc-history-list').innerHTML=(historyWarning?'<p class="lc-error">'+esc(historyWarning)+'</p>':'')+(items.length?items.map(t=>'<article class="lc-history"><small>'+esc(stamp(t.at))+' · '+esc(t.source)+'</small><strong>'+esc(t.label)+'</strong>'+(t.actor?'<small>記録者'+(t.source==='ENGER'?'ID':'')+'：'+esc(t.actor)+'</small>':'')+(t.detail?(t.mail?'<details><summary>宛先・送信内容を確認</summary><p>'+esc(t.detail)+'</p></details>':'<p>'+esc(t.detail)+'</p>'):'')+(t.nextAction||t.nextDate?'<small>次回：'+esc([t.nextDate,t.nextAction].filter(Boolean).join(' ／ '))+'</small>':'')+'</article>').join(''):'<p class="lc-detail-note">この企業IDの履歴はありません。別ID・未照合の記録は含みません。</p>');
 }
 function info(v){
  const site=safeWebsite(v.website),form=safeWebsite(v.formUrl),tel=phoneLink(v.phone);
  $('lc-company-info').innerHTML='<dl>'+kv('担当窓口',v.contactName)+kv('メール',v.contactEmail)+kv('電話',v.phone)+kv('所在地',v.address||v.prefecture)+kv('業種',v.industry)+kv('登録状態',v.status)+kv('取引状態',({active:'取引中',past:'過去取引',unknown:'未確認'}[v.relationshipStatus]||v.relationshipStatus))+kv('優先度',v.priority)+kv('最終連絡',v.lastContactedAt?stamp(v.lastContactedAt):null)+'</dl><div class="lc-info-links">'+link(site,'ホームページ')+link(form,'問い合わせフォーム')+'</div>'+(v.note?'<details open><summary>登録メモ</summary><p class="lc-detail-note">'+esc(v.note)+'</p></details>':'')+'<details open><summary>分類・管理情報</summary><dl>'+kv('分類の根拠',row.reason)+kv('取引の根拠',row.relationshipEvidence)+kv('取込元',v.dataSource)+kv('Sales企業ID',v.sales?.id)+kv('Sales担当',v.sales?.ownerName)+kv('次回予定',v.sales?.nextActionOn)+kv('次回対応',v.sales?.nextAction)+kv('企業評価',v.isFavorite?'注力企業':null)+kv('エンド企業',v.isEndClient?'登録あり':'未確認')+'</dl></details>';
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
   message('この画面で宛先・件名・本文を確認し、送信できます。送信結果は履歴に自動保存されます。');
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
  const results=channel==='email'?['送信済み（本人確認）','下書きを作成','送信できなかった','未送信']:channel==='phone'?['通話できた','不在・つながらない','折り返し待ち','資料送付を依頼された','商談・面談を調整','連絡不要と言われた']:channel==='form'?['フォーム送信完了','問い合わせ先を調査中','フォームが使えない','営業連絡を受け付けていない']:['情報を確認','連絡先を調査','次回対応を設定','その他'];
  $('lc-result').innerHTML='<option value="">結果を選択</option>'+results.map(r=>'<option>'+esc(r)+'</option>').join('');
  $('lc-preview-action').textContent='結果を履歴に追加（プレビュー）';
 }
 function addPreview(){
  const s=state(),p=plan(),label=({email:'メール',phone:'電話',form:'フォーム',memo:'メモ'}[channel]+'：'+s.result);
  const detail=[channel==='email'?'宛先：'+s.to:null,channel==='email'||channel==='form'?'件名：'+s.subject+'\n'+s.body:null,s.note].filter(Boolean).join('\n\n');
  const event={id:'preview:'+Date.now()+':'+Math.random().toString(36).slice(2),at:new Date().toISOString(),label,detail,actor:viewer()||s.sender||'確認中のメンバー',...p};
  draft.set(row.id,{...record(),...p,events:[event,...(record().events||[])]});
  $('lc-result').value='';$('lc-result-note').value='';state().note='';state().result='';showHistory();onChange();
  message('確認用の履歴に追加しました。本番には保存していません。');
 }
 function attempt(){
  readInputs();const s=state(),blocked=Boolean(row.blocked||company?.needsContactReview||company?.directoryExcluded||company?.sales?.hidden||company?.sales?.ngReason);
  const error=previewProblem({...s,sender:s.sender||viewer()||'営業担当',channel,blocked,identified:Boolean(row.companyId&&company)});
  if(error){message(error);return;}
  if(channel==='memo'&&!s.note.trim()){message('記録する内容を入力してください。');return;}
  if(!s.result){message('対応結果を選んでください。');return;}
  addPreview();
 }
 function render(r){
  const c={...r,...record()},s=state();
  $('lc-detail-title').textContent=r.name;
  $('lc-detail').innerHTML='<div class="lc-workbench"><section class="lc-pane lc-info-pane" aria-label="登録情報"><h3>登録情報</h3><div class="lc-company-id"><span>企業ID（ENGER）</span><code id="lc-full-id">'+esc(r.companyId||'未照合')+'</code><button type="button" id="lc-copy-id" '+(!r.companyId?'disabled':'')+'>IDをコピー</button></div><div id="lc-company-info" aria-live="polite">登録情報・履歴を読み込み中…</div><div id="lc-candidate-list"></div>'+(r.proposals.length?'<details open><summary>進行中提案 '+r.proposals.length+'件</summary>'+r.proposals.map(p=>'<div class="lc-history">'+esc(p.stage)+' · '+esc(stamp(p.updatedAt))+'<small>提案ID '+esc(p.id)+'</small></div>').join('')+'</details>':'')+'</section>'+
   '<section class="lc-pane lc-action-pane" aria-label="営業アクション"><h3>次のアクション</h3><p id="lc-contact-alert" class="lc-error" hidden></p><div class="lc-action-tabs">'+[['phone','電話','call','発信画面を開く'],['email','メール','mail','文面入りで作成'],['form','フォームアタック','contact_page','営業文をコピーして開く'],['memo','記録のみ','edit_note','結果・次回対応を記録']].map(([id,label,icon,hint])=>'<button type="button" data-channel="'+id+'" disabled aria-pressed="false" aria-label="'+label+'"><span class="material-symbols-outlined lc-action-icon" aria-hidden="true">'+icon+'</span><span class="lc-action-copy"><strong>'+label+'</strong><small data-hint="'+id+'">'+hint+'</small></span><span class="material-symbols-outlined lc-action-check" aria-hidden="true">check_circle</span></button>').join('')+'</div><div class="lc-template-toolbar"><label>メールの雛形<select id="lc-template" aria-label="メールの雛形"></select></label><div class="lc-template-buttons"><button type="button" id="lc-template-add" disabled><span class="material-symbols-outlined" aria-hidden="true">add</span>追加</button><button type="button" id="lc-template-edit" disabled><span class="material-symbols-outlined" aria-hidden="true">edit</span>編集</button></div></div><p class="lc-detail-note" id="lc-template-status" role="status">雛形を読み込み中…</p><section id="lc-template-editor" class="lc-template-editor" aria-labelledby="lc-template-editor-title" hidden><h4 id="lc-template-editor-title"></h4><p id="lc-template-save-note" class="lc-detail-note"></p><fieldset id="lc-template-fields"><label>雛形の名前<input id="lc-t-name" maxlength="100" placeholder="例：案件ニーズの確認"></label><label>雛形の件名<input id="lc-t-subject" maxlength="300"></label><label>雛形の本文<textarea id="lc-t-body" rows="8" maxlength="20000"></textarea></label><p class="lc-template-variables">差し込み：<code>{{company}}</code> 企業名　<code>{{contact}}</code> 担当窓口　<code>{{sender}}</code> 送る人<br><code>{{service}}</code> サービス　<code>{{url}}</code> リンク先</p><div class="lc-fields"><label>対象サービス<input id="lc-t-service" maxlength="100"></label><label>リンク先URL<input id="lc-t-url" type="url" maxlength="500" placeholder="https://..."></label></div><div class="lc-template-buttons"><button type="button" id="lc-template-save" class="lc-primary"><span class="material-symbols-outlined" aria-hidden="true">save</span>雛形を保存</button><button type="button" id="lc-template-cancel">キャンセル</button></div></fieldset><p id="lc-template-error" role="status" aria-live="polite"></p></section><p class="lc-detail-note" id="lc-action-prompt">企業情報と履歴を確認したら、次のアクションを選んでください。<br>電話は発信画面、メールは文面入りの作成画面、フォームは問い合わせ先を開きます。</p><div id="lc-action-body" hidden><div id="lc-phone-panel" hidden><div id="lc-call-link"></div><p class="lc-detail-note">端末の電話アプリを開きます。通話後に結果を選んでください。</p></div><div id="lc-form-panel" hidden><div id="lc-form-link"></div><p id="lc-form-tip" class="lc-detail-note">本文をコピー → フォームを開く → 送信後に結果を記録。</p></div>'+
   '<div id="lc-compose" hidden><div class="lc-fields"><label>送る人の名前<input id="lc-sender" maxlength="80" value="'+esc(s.sender)+'"></label></div><label id="lc-email-to">宛先<input id="lc-to" type="email" maxlength="254" value="'+esc(s.to)+'"></label><label>件名<input id="lc-subject" maxlength="300" value="'+esc(s.subject)+'"></label><label>本文<textarea id="lc-body" rows="7" maxlength="20000">'+esc(s.body)+'</textarea></label><div class="lc-compose-tools"><button type="button" id="lc-insert-template">テンプレートを反映</button><button type="button" id="lc-copy-body">本文をコピー</button></div></div>'+
   '<section id="lc-mail-controls" hidden><p class="lc-detail-note">送信元：<strong id="lc-mail-from">確認中…</strong></p><p id="lc-mail-config" class="lc-detail-note"></p><button type="button" id="lc-mail-send" class="lc-primary" disabled>送信して履歴に保存</button><button type="button" id="lc-mail-new" hidden>新しいメールを作成</button><p class="lc-detail-note">送信受付は配信サーバーの応答です。到達・開封・返信は未確認です。</p></section><div id="lc-result-fields" class="lc-fields lc-result-fields"><label id="lc-result-field">対応結果<select id="lc-result"></select></label><label>メモ<textarea id="lc-result-note" rows="2" maxlength="2000">'+esc(s.note)+'</textarea></label></div>'+
   '<details id="lc-next-plan" class="lc-next-plan" open><summary>次回対応</summary><div class="lc-fields"><label>担当<input id="lc-owner" maxlength="80" value="'+esc(c.owner||viewer()||'')+'"></label><label>次回予定<input type="date" id="lc-date" value="'+esc(c.nextDate)+'"></label><label class="wide">次にすること<input id="lc-action" maxlength="200" value="'+esc(c.nextAction)+'"></label></div><button type="button" id="lc-save-plan">次回対応だけ仮保存</button></details><button type="button" id="lc-preview-action" class="lc-primary" disabled>結果を履歴に追加（プレビュー）</button></div><p id="lc-work-status" role="status" aria-live="polite">メール送信結果は保存されます。電話・フォーム・メモの仮記録は再読み込みで消えます。</p></section>'+
   '<section class="lc-pane lc-history-pane" aria-label="営業履歴"><h3>営業履歴 <small id="lc-history-count"></small></h3><p class="lc-detail-note">新しい順・日時と記録元を表示</p><div class="lc-compose-tools"><button type="button" id="lc-mail-refresh">メール履歴を再取得</button><button type="button" id="lc-mail-more" hidden>以前のメールを見る</button></div><p id="lc-mail-history-warning" class="lc-error" role="status"></p><div id="lc-history-list" aria-live="polite">履歴を読み込み中…</div></section></div>';
  $('lc-copy-id').onclick=()=>copy(row.companyId);
  $('lc-copy-body').onclick=()=>{readInputs();void copy(state().body);};
  $('lc-preview-action').onclick=attempt;
  $('lc-save-plan').onclick=()=>{draft.set(row.id,{...record(),...plan()});onChange();message('次回対応を仮保存しました。本番には保存していません。');};
  document.querySelectorAll('[data-channel]').forEach(b=>b.onclick=()=>startAction(b.dataset.channel));
  $('lc-template').onchange=()=>{readInputs();state().templateId=$('lc-template').value;applyTemplate();message('選んだ雛形を反映しました。メール・フォームから作業を開始できます。');};
  $('lc-template-add').onclick=()=>editTemplate(true);$('lc-template-edit').onclick=()=>editTemplate(false);
  $('lc-template-cancel').onclick=closeTemplateEditor;$('lc-template-save').onclick=saveTemplate;
  $('lc-insert-template').onclick=()=>{readInputs();applyTemplate();message('テンプレートを反映しました。宛先・内容を確認してください。');};
  for(const id of ['lc-sender','lc-to','lc-subject','lc-body','lc-result','lc-result-note'])$(id).addEventListener('input',()=>{readInputs();});
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
   if(!isCandidate)attachCompanyMail({companyId:id,isCurrent:()=>valid(n),onMessage:message,onHistory:items=>{mailHistory=items;showHistory();}});
   if(evidence.salesLinkAmbiguous){historyWarning='Sales企業IDが複数あります。Sales履歴は照合後に確認してください。';showHistory();}
   else if(evidence.linkedSalesCompanyId){
    try{const sd=await API.api('/api/sales/companies/detail?id='+encodeURIComponent(evidence.linkedSalesCompanyId));if(!valid(n))return;salesHistory=sd.timeline||[];if(sd.historyComplete===false)historyWarning='Sales履歴の一部を取得できませんでした。';showHistory();}
    catch{if(!valid(n))return;historyWarning='Sales履歴を取得できませんでした。モーダルを開き直してください。';showHistory();}
   }
  }catch(e){if(!valid(n))return;$('lc-company-info').textContent=e.hint||'登録情報を取得できませんでした。';$('lc-history-list').textContent='履歴未取得。モーダルを開き直してください。';}
 }
 async function open(r){
  if(row&&$('lc-dialog').open)readInputs();row=r;company=null;evidence=null;salesHistory=[];mailHistory=[];historyWarning='';const n=++generation;
  render(r);options();if(!$('lc-dialog').open)$('lc-dialog').showModal();
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
 $('lc-dialog').addEventListener('close',()=>{generation++;});
 return {open};
}
