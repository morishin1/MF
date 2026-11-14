(function(){
'use strict';
const $=id=>document.getElementById(id),esc=HRLayout.esc;
const groups={new:'新規応募',review:'要確認',auto:'自動登録済み',linked:'紐づけ済み',ignored:'対象外',error:'取込エラー'};
const labels={application:'新規応募',reply:'既存応募者の連絡',schedule:'面談日程の通知',registration:'登録・申込',advertisement:'営業・広告',system:'システム通知',unknown:'判定不明・情報不足'};
let mails=[],analyses=new Map(),people=[],selected='review',current=null,busy=false,classificationReady=false;
const api=(path,body)=>API.api(path,body?{method:'POST',body}:undefined);
const tell=(s,error=false)=>{$('notice').textContent=s;$('notice').className=error?'error':'';};
function group(m){const a=analyses.get(m.id);return m.status==='linked'?(a?.auto_registered?'auto':'linked'):m.status==='ignored'?'ignored':a?.state==='error'?'error':m.status==='review'||a?'review':'new';}
function render(){
 $('filters').innerHTML=Object.entries(groups).map(([key,label])=>`<button data-filter="${key}" aria-pressed="${key===selected}">${label} <b>${mails.filter(m=>group(m)===key).length}</b></button>`).join('');
 const q=$('query').value.trim().toLowerCase();
 const rows=mails.filter(m=>group(m)===selected&&(!q||[m.candidate_name_guess,m.job_title_guess,m.source_guess,m.subject].join(' ').toLowerCase().includes(q)));
 $('rows').innerHTML=rows.length?rows.map(m=>{const a=analyses.get(m.id);return `<tr data-id="${esc(m.id)}" class="${m.read===false?'unread':''}" tabindex="0"><td>${esc(JST.dateTime(m.received_at))}${m.read===false?'<small>未読</small>':''}</td><td>${esc(m.source_guess||'未確認')}</td><td>${esc(m.candidate_name_guess||'氏名を確認')}</td><td>${esc(m.job_title_guess||'—')}</td><td><span class="pill">${esc(labels[a?.classification]||'未分類')}</span></td><td>${esc(groups[group(m)])}</td><td>${esc(m.reviewed_by_name||'未定')}</td><td><button data-open="${esc(m.id)}">${m.applicant_id?'履歴を確認':'内容を確認'} →</button></td></tr>`;}).join(''):'<tr><td colspan="8">対象の受付はありません。</td></tr>';
}
async function load(){
 try{
  tell('読み込み中…');
  const [inbox,analysis]=await Promise.all([api('/api/hr/inbox'),api('/api/hr/intake').catch(()=>null)]);
  mails=inbox.mails||[];analyses=new Map((analysis?.analyses||[]).map(a=>[a.mail_id,a]));classificationReady=Boolean(analysis);
  const b=analysis?.budget,spent=Number(b?.committed_yen)||0,max=Number.isFinite(Number(b?.budget_yen))?Number(b.budget_yen):1000;
  $('budget').textContent=[inbox.syncConfigured?'受信設定：有効':'受信設定：未接続',inbox.lastGmailImportedAt?'最終取込：'+JST.dateTime(inbox.lastGmailImportedAt):'取込実績：未確認',analysis?'AI分類：'+(analysis.aiEnabled?'有効':'未設定'):'分類用データベース：設定待ち',b?`今月の概算・予約額 ${spent.toFixed(2)}円 / ${max}円`:'',spent>=max?'予算上限：AIを停止し要確認へ振り分け':spent>=max*.8?'予算の80%を使用':''].filter(Boolean).join(' ／ ');
  $('budget').className=spent>=max*.8?'warn':'';$('sync').disabled=!inbox.manualSyncReady;
  render();tell(inbox.capped?'最新500件を表示しています。':`${mails.length}件の受付を表示しています。`);
 }catch(e){tell(e.message||'受付を取得できませんでした',true);}
}
async function open(id){
 if(busy)return;
 try{
  const r=await api('/api/hr/inbox?id='+encodeURIComponent(id));current=r.mail;
  if(!current)throw Error('受付が見つかりません');
  const a=analyses.get(id),f=a?.fields||{};
  $('detail-body').innerHTML=`<p>${esc(JST.dateTime(current.received_at))} ／ ${esc(current.subject)}</p><p>${esc(a?.reason||'分類はまだ行われていません。原文で確認してください。')}</p><details><summary>元メールの内容を確認</summary><pre>${esc(current.body_text||'本文はありません')}</pre>${current.provider==='gmail'&&/^[a-f0-9]{12,64}$/i.test(current.provider_message_id)?`<a class="button" href="https://mail.google.com/mail/u/0/#all/${current.provider_message_id}" target="_blank" rel="noopener noreferrer">Gmailで元メールを開く</a>`:''}</details>
  <div class="grid"><label>分類<select id="classification">${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${a?.classification===k?'selected':''}>${v}</option>`).join('')}</select></label><label>受付先<select id="service">${Object.entries({recruitment:'採用候補者',contractor:'業務委託候補',spot:'スポット人材',mugendojo:'無限道場'}).map(([k,v])=>`<option value="${k}" ${f.service===k?'selected':''}>${v}</option>`).join('')}</select></label>${Object.entries({name:'氏名',email:'応募者メール',jobTitle:'応募職種',source:'応募元'}).map(([k,v])=>`<label>${v}<input id="f-${k}" value="${esc(f[k]||({name:current.candidate_name_guess,jobTitle:current.job_title_guess,source:current.source_guess}[k])||'')}" maxlength="${k==='name'?100:k==='source'?80:k==='jobTitle'?180:200}"></label>`).join('')}<label class="wide">確認・修正理由<input id="reason" maxlength="500" placeholder="原文で確認した内容・修正理由"></label></div>
  <div class="foot">${!a&&classificationReady?'<button id="classify">AIで分類する</button>':''}<button id="correct" ${classificationReady?'':'disabled'}>分類を修正・保存</button>${!current.applicant_id?'<button id="register" class="primary">応募者として登録</button>':`<a class="button primary" href="/hr/applicants.html?id=${encodeURIComponent(current.applicant_id)}">応募者を開く</a>`}</div>
  ${!current.applicant_id?`<details><summary>既存応募者へ紐づける・対象外にする</summary><select id="existing" aria-label="既存応募者"><option value="">既存応募者を選択</option>${people.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} ／ ${esc(p.jobTitle||'')}</option>`).join('')}</select> <button id="link">紐づける</button> <button id="ignore">対象外にする</button></details>`:''}
  <p>スポット人材・無限道場の申込は各受付で確認します。<a href="/hr/spot.html">スポット人材</a> ／ <a href="/hr/applicants.html?category=mugendojo">無限道場</a></p><p id="detail-status" role="status"></p>`;
  $('detail').showModal();
  await api('/api/hr/inbox',{action:'read',id});
  const row=mails.find(m=>m.id===id);if(row)row.read=true;render();
 }catch(e){tell(e.message||'内容を取得できませんでした',true);}
}
async function act(action){
 if(busy||!current)return;busy=true;
 const buttons=[...$('detail').querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{
  const id=current.id,a=analyses.get(id);let r;
  if(action==='classify')r=await api('/api/hr/intake',{id,action});
  else if(action==='link'||action==='ignore'){
   if(action==='link'&&!$('existing').value)throw Error('紐づける応募者を選択してください');
   r=await api('/api/hr/inbox',{id,action:action==='ignore'?'review':'link',status:'ignored',note:$('reason').value,applicantId:$('existing').value});
  }else {
   if(action==='register'&&!classificationReady)throw Error('分類用データベースの設定が必要です');
   if(action==='register'&&!confirm('氏名・メール・応募職種を確認し、この内容でHRへ登録しますか？'))return;
   r=await api('/api/hr/intake',{id,action,classification:$('classification').value,reason:$('reason').value,expectUpdatedAt:a?.updated_at,fields:{name:$('f-name').value,email:$('f-email').value,jobTitle:$('f-jobTitle').value,source:$('f-source').value,service:$('service').value}});
  }
  $('detail').close();await load();
  tell(r.created?'応募者として登録しました。':r.applicantId?'既存応募者に紐づけました。':'確認結果を保存しました。');
 }catch(e){$('detail-status').textContent=e.message||'保存できませんでした';}
 finally{busy=false;buttons.forEach(b=>b.disabled=false);}
}
$('filters').addEventListener('click',e=>{const b=e.target.closest('[data-filter]');if(b){selected=b.dataset.filter;render();}});
$('rows').addEventListener('click',e=>{const r=e.target.closest('[data-id]');if(r)open(r.dataset.id);});
$('rows').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.dataset.id)open(e.target.dataset.id);});
$('detail').addEventListener('click',e=>{const action=e.target.id;if(['classify','correct','register','link','ignore'].includes(action))act(action);});
$('close').onclick=()=>$('detail').close();$('query').oninput=render;$('refresh').onclick=load;
$('sync').onclick=async()=>{if(busy)return;busy=true;$('sync').disabled=true;try{const r=await api('/api/hr/inbox-sync-now',{});await load();tell(r.dryRun?'テストモードで接続を確認しました。':`取込結果：新規 ${r.inserted||0}件、重複 ${r.duplicates||0}件。分類は順次行います。`);}catch(e){tell(e.message||'取込結果を確認できません。一覧を更新してください',true);}finally{busy=false;}};
HRLayout.init({active:'applicants'}).then(async ctx=>{if(!ctx)return;const p=await API.listHrApplicants().catch(()=>null);people=p?.applicants||[];await load();const id=new URLSearchParams(location.search).get('id');if(id)await open(id);});
})();
