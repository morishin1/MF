(async function(){
 'use strict';
 const ctx=await HRLayout.init({active:'learning'});if(!ctx)return;
 const $=id=>document.getElementById(id),esc=HRLearning.esc;
 let items=[],definitions=[],grades=[],decisions=[],openId=null,loading=false,refreshGeneration=0;
 const date=s=>s?new Date(s).toLocaleDateString('ja-JP',{timeZone:'Asia/Tokyo'}):'未確認';
 const pct=n=>Number.isFinite(n)?n+'%':'未確認';
 const progress=n=>Number.isFinite(n)?'<progress max="100" value="'+n+'" aria-label="'+n+'%"></progress>'+n+'%':'未確認';
 const labels=['氏名・参加状況','受講区分','経過','学習進捗','目標達成率','最終学習日','評価状態'];
 function target(x){return x.participation==='on'||x.plan||x.courses?.length;}
 function filtered(){const q=$('learning-search').value.trim().toLowerCase(),f=$('learning-filter').value;return items.filter(x=>(!q||x.name.toLowerCase().includes(q))&&(f==='all'||f==='target'&&target(x)||f==='learning'&&x.learning||f==='trial'&&x.trialActive||f==='pending'&&x.evaluationPending));}
 function render(){
  const uncertain=items.filter(x=>x.lmsStatus!=='verified').length;
  const counts=[['learning','学習中',items.filter(x=>x.learning).length],['trial','2週間トライアル',items.filter(x=>x.trialActive).length],['pending','評価待ち',items.filter(x=>x.evaluationPending).length]];
  $('learning-counts').innerHTML=counts.map(([key,label,n])=>'<button type="button" data-filter="'+key+'">'+label+'<strong>'+n+'人'+(loading?'（確認中）':'')+'</strong>'+(key==='learning'&&uncertain?'<small>未確認 '+uncertain+'人</small>':'')+'</button>').join('');
  const rows=filtered();
  $('learning-rows').innerHTML=rows.length?rows.map(x=>{
   const courses=x.courses||[],last=courses.map(c=>c.lastActivityAt).filter(Boolean).sort().at(-1);
   const cells=['<button class="learning-name" type="button" data-open="'+esc(x.id)+'">'+esc(x.name)+'</button> '+HRLearning.icon(x.id),courses.length?courses.map(c=>'<span class="learning-chip">'+(c.kind==='trial'?'体験版':'通常講座')+'</span>').join(''):'未確認',x.dates?(x.dates.day?x.dates.day+'日目':'開始前'):'未設定',courses.length?courses.map(c=>'<div>'+(c.kind==='trial'?'体験':'通常')+' '+progress(c.progressPercent)+'</div>').join(''):'未確認',progress(x.goalPercent),esc(date(last)),esc(x.evaluationStatus)];
   return '<tr>'+cells.map((s,i)=>'<td data-label="'+labels[i]+'">'+s+'</td>').join('')+'</tr>';
  }).join(''):'<tr><td colspan="7">'+(loading?'確認しています…':'該当する応募者はいません。表示対象から「すべての応募者」を選ぶと、参加状況を設定できます。')+'</td></tr>';
 }
 async function load(){
  if(loading)return;loading=true;const gen=++refreshGeneration;items=[];render();$('learning-refresh').disabled=true;$('learning-message').textContent='LMSの最新状況を確認しています。';
  try{
   await HRLearning.load(data=>{if(gen!==refreshGeneration)return;definitions=data.itemsDefinition||definitions;grades=data.grades||grades;decisions=data.decisions||decisions;items.push(...(data.items||[]));render();});
   $('learning-message').textContent=items.some(x=>x.lmsStatus==='unknown')?'LMSの取得待ち・本人照合未確認を含みます。「未確認」は未受講を意味しません。':'LMSの最新サマリーを表示しています。';
   const requested=new URLSearchParams(location.search).get('id');if(requested&&!openId)await open(requested);
  }catch(e){$('learning-message').textContent=e.hint||'取得できませんでした。「最新にする」で再度確認してください。';}
  finally{loading=false;$('learning-refresh').disabled=false;render();}
 }
 function courseCard(c){
  const t=c.trial,tri=t?'<div class="learning-metrics">'+[['MVV',t.mvvAnswered],['AI体験',t.aiTried],['AIチャレンジ',t.challengeSubmitted],['成果物',t.outputSubmitted],['振り返り',t.reflectionSubmitted]].map(([l,v])=>'<span>'+l+'：'+(v?'完了':'未完了')+'</span>').join('')+'</div>':'<p class="muted">通常講座の振り返りは個別課題・到達目標で確認します。</p>';
  return '<section class="learning-course"><h4>'+esc(c.title)+'</h4><span class="learning-chip">'+(c.kind==='trial'?'体験版':'通常講座')+'</span><p>学習進捗 '+progress(c.progressPercent)+'</p><div class="learning-metrics"><span>レッスン '+c.lessonsDone+' / '+c.lessonsTotal+'</span><span>課題提出 '+c.assignmentsDone+' / '+c.assignmentsTotal+'</span><span>AI対話 '+c.aiChallengeCount+'件</span><span>成果物 '+c.outputCount+'件</span><span>AIフィードバック '+c.aiFeedbackCount+'件</span><span>講師フィードバック '+c.teacherFeedbackCount+'件</span></div>'+tri+'<p class="muted">最終学習日：'+date(c.lastActivityAt)+'</p></section>';
 }
 function goalRow(g={label:'',target:1,current:0}){return '<div class="learning-goal"><label>到達目標<input data-goal="label" maxlength="200" value="'+esc(g.label)+'" required></label><label>目標値<input data-goal="target" type="number" min="0.01" max="100000" step="any" value="'+g.target+'" required></label><label>実績値<input data-goal="current" type="number" min="0" max="100000" step="any" value="'+g.current+'" required></label><button type="button" class="btn btn-secondary" data-remove-goal aria-label="目標を削除">×</button></div>';}
 function review(x,key,label){
  const r=x.reviews?.[key],due=x.dates?.day>=(key==='day7'?7:14),selected=!r&&x.dates?.checkpoint===key;
  return '<details class="learning-review" '+(selected?'open':'')+'><summary>'+label+' '+(r?'記録済み':due?'評価待ち':'評価日前')+'</summary>'+(r?'<p class="muted">記録日時：'+esc(new Date(r.recordedAt).toLocaleString('ja-JP'))+'</p>':'')+'<form data-review="'+key+'"><div class="learning-scores">'+definitions.map(i=>'<label>'+esc(i.label)+'<select name="'+i.key+'" required '+(!due?'disabled':'')+'><option value="">選択してください</option>'+grades.map(g=>'<option value="'+g.key+'" '+(r?.scores?.[i.key]===g.key?'selected':'')+'>'+esc(g.label)+'</option>').join('')+'</select></label>').join('')+'</div><label>総合判断<select name="decision" required '+(!due?'disabled':'')+'><option value="">選択してください</option>'+decisions.map(d=>'<option value="'+d.key+'" '+(r?.decision===d.key?'selected':'')+'>'+esc(d.label)+'</option>').join('')+'</select></label><label>評価コメント<textarea name="note" rows="3" maxlength="2000" '+(!due?'disabled':'')+'>'+esc(r?.note||'')+'</textarea></label><div class="learning-actions"><button class="btn btn-primary" type="submit" '+(!due?'disabled':'')+'>評価を保存</button></div></form></details>';
 }
 function detail(x){
  $('learning-title').textContent=x.name+' の育成・評価';$('learning-detail-message').textContent='';
  $('learning-detail').innerHTML='<p>参加状況 '+HRLearning.icon(x.id)+' <span class="muted">確認元：'+esc(x.source)+' ／ '+(x.lmsStatus==='verified'?'LMS本人照合済み':'LMSは未確認')+'</span></p><h3>学習状況</h3>'+(x.courses?.length?'<div class="learning-courses">'+x.courses.map(courseCard).join('')+'</div>':'<p class="muted">受講状況を確認できる記録がありません。未受講とは判定しません。</p>')+'<h3>2週間の到達目標</h3><p class="muted">学習目標の期間です。契約・有給のトライアル期間や採用ステータスは変更しません。</p><form id="learning-plan-form"><div class="learning-dates"><label>開始日<input id="learning-start" type="date" value="'+esc(x.plan?.startOn||'')+'" required '+(Object.keys(x.reviews||{}).length?'readonly':'')+'></label><span id="learning-end">終了日：'+esc(x.plan?.endOn||'開始日から14日間')+'</span><span>'+(x.dates?'経過 '+x.dates.day+'日目 ／ 残り '+x.dates.remaining+'日':'期間未設定')+'</span><span>目標達成率：'+pct(x.goalPercent)+'</span></div><div id="learning-goals" class="learning-goals">'+(x.plan?.goals||[{}]).map(g=>goalRow(g.label?g:undefined)).join('')+'</div><div class="learning-actions"><button id="learning-add-goal" class="btn btn-secondary" type="button">目標を追加</button><button class="btn btn-primary" type="submit">目標を保存</button></div></form><h3>担当者評価</h3><p class="muted">学習進捗だけで採否を決めません。最終的な採用判断は応募者情報から行います。</p>'+review(x,'day7','7日目・途中評価')+review(x,'day14','14日目・最終評価')+'<p class="muted"><a href="/hr/applicants.html?id='+encodeURIComponent(x.id)+'">応募者情報・内定通知を開く</a></p>';
 }
 async function open(id){
  try{const r=await API.api('/api/hr/learning?id='+encodeURIComponent(id));const x=r.items?.[0];if(!x)throw Error('応募者を確認できません。');definitions=r.itemsDefinition||definitions;grades=r.grades||grades;decisions=r.decisions||decisions;HRLearning.rows.set(id,x);openId=id;detail(x);if(!$('learning-dialog').open)$('learning-dialog').showModal();$('learning-dialog').scrollTop=0;}
  catch(e){$('learning-message').textContent=e.hint||e.message;}
 }
 async function save(action,value,button){
  const id=openId,x=HRLearning.rows.get(id);if(!x)return;button.disabled=true;
  try{const r=await API.api('/api/hr/learning',{method:'POST',body:{applicantId:id,expectedVersion:x.version,action,...value}});HRLearning.rows.set(id,r.item);items=items.map(i=>i.id===id?r.item:i);detail(r.item);render();$('learning-detail-message').textContent='保存しました。';}
  catch(e){$('learning-detail-message').textContent=e.hint||'保存できませんでした。内容を確認して再度お試しください。';button.disabled=false;}
 }
 $('learning-search').addEventListener('input',render);$('learning-filter').addEventListener('change',render);$('learning-refresh').addEventListener('click',load);
 $('learning-counts').addEventListener('click',e=>{const b=e.target.closest('[data-filter]');if(b){$('learning-filter').value=b.dataset.filter;render();}});
 $('learning-rows').addEventListener('click',e=>{const b=e.target.closest('[data-open]');if(b)open(b.dataset.open);});
 $('learning-close').addEventListener('click',()=>$('learning-dialog').close());$('learning-dialog').addEventListener('close',()=>{openId=null;});
 $('learning-detail').addEventListener('click',e=>{if(e.target.closest('#learning-add-goal')){if($('learning-goals').children.length<20)$('learning-goals').insertAdjacentHTML('beforeend',goalRow());}const remove=e.target.closest('[data-remove-goal]');if(remove)remove.closest('.learning-goal').remove();});
 $('learning-detail').addEventListener('input',e=>{if(e.target.id==='learning-start'){const d=new Date(e.target.value+'T00:00:00Z');$('learning-end').textContent='終了日：'+(Number.isFinite(d.getTime())?new Date(d.getTime()+13*86400000).toISOString().slice(0,10):'開始日を指定');}});
 $('learning-detail').addEventListener('submit',e=>{e.preventDefault();const form=e.target,b=form.querySelector('[type=submit]');if(form.id==='learning-plan-form'){const goals=[...form.querySelectorAll('.learning-goal')].map(g=>({label:g.querySelector('[data-goal=label]').value,target:Number(g.querySelector('[data-goal=target]').value),current:Number(g.querySelector('[data-goal=current]').value)}));save('plan',{plan:{startOn:$('learning-start').value,goals}},b);}else if(form.dataset.review){const data=new FormData(form),scores=Object.fromEntries(definitions.map(i=>[i.key,data.get(i.key)]));save('review',{checkpoint:form.dataset.review,evaluation:{scores,decision:data.get('decision'),note:data.get('note')}},b);}});
 document.addEventListener('hr-learning-updated',e=>{const x=e.detail;items=items.map(i=>i.id===x.id?x:i);render();if(openId===x.id){const icon=$('learning-detail').querySelector('[data-learning-id]');if(icon)icon.outerHTML=HRLearning.icon(x.id);}});
 await load();
})();
