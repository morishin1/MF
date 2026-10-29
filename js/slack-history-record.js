// Normal owner-session form. API.api owns authentication; this code never reads tokens.
(async function(){
 'use strict';
 const $=id=>document.getElementById(id),dept=new URLSearchParams(location.search).get('department');
 const destinations={hr:{label:'採用HR',channel:'C0CCSBTDB1S',source:'hr-mailbox',path:'/hr/inbox.html',access:['recruit']},office:{label:'Office',channel:'C0CCLMUQZ7G',source:'office-gw',path:'/office/slack-history.html',access:['office','officeHr','officeFinance']},sales:{label:'Sales',channel:'C0CCQHQN3SM',source:'sales-mailbox',path:'/sales/slack-history.html',access:['sell']}};
 const target=destinations[dept],state=$('receipt-state'),form=$('receipt-form'),fields=$('receipt-fields'),verify=$('receipt-verify');
 let busy=false,locked=false,attempt=null;
 if(!target){state.textContent='対象部門が不正です。個人DMは記録できません。';return;}
 $('receipt-history').href=target.path;$('receipt-history').hidden=false;
 function message(text){state.textContent=text;}
 function postFromLink(){
  const input=$('receipt-link').value.trim();
  const match=input.match(new RegExp('^https://8grp\\.slack\\.com/archives/'+target.channel+'/p([0-9]{10})([0-9]{6})$'));
  $('receipt-ts').value=match?match[1]+'.'+match[2]:'';
  $('receipt-sent').value=match?new Date(Number(match[1])*1000+Math.floor(Number(match[2])/1000)).toISOString():'';
  return Boolean(match);
 }
 function payload(){
  if(!postFromLink())throw Error('この部門の正確なSlack投稿リンクを入力してください。個人DM・他部門・検索用URLは登録できません。');
  const value=id=>$(id).value.trim();
  if(!/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(value('receipt-start'))||!/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(value('receipt-end')))throw Error('確認対象日時にはZまたは+09:00などの時差を含めてください。');
  const b={department:dept,source:target.source,slackPermalink:value('receipt-link'),slackTs:value('receipt-ts'),sentAt:value('receipt-sent'),summary:value('receipt-summary'),targetDate:value('receipt-date'),slot:value('receipt-slot'),revision:Number(value('receipt-revision')),periodStart:value('receipt-start'),periodEnd:value('receipt-end'),coverageStatus:value('receipt-coverage'),coverageNote:value('receipt-note'),sourceIds:value('receipt-sources').split(/\r?\n/).map(x=>x.trim()).filter(Boolean),confirmedSent:$('receipt-confirm-sent').checked,confirmedNonConfidential:$('receipt-confirm-safe').checked};
  if(!b.confirmedSent||!b.confirmedNonConfidential)throw Error('実投稿と共有内容の両方を確認してください。');
  if(!b.summary||b.summary.length>2000||b.coverageStatus!=='complete'&&!b.coverageNote)throw Error('要約と、取得不足の場合は説明が必要です。');
  return b;
 }
 async function readBack(){
  if(busy||!attempt)return;busy=true;verify.disabled=true;
  try{
   const result=await API.api('/api/slack-history?department='+encodeURIComponent(dept));
   if(result.ready===false||!Array.isArray(result.history))throw Error();
   const hit=result.history.find(r=>r.department===dept&&r.slack_permalink===attempt.slackPermalink&&r.summary===attempt.summary&&r.target_date===attempt.targetDate&&r.slot===attempt.slot&&r.revision===attempt.revision);
   message(hit?'同じSlack投稿の履歴が見つかりました。取得状態・対象期間を含む全入力の一致は未確認です。履歴で内容を確認してください。Slackへの再送はしていません。':'この表示範囲では同じ記録を確認できません。新しい版や別キーで再登録せず、履歴・保存状態を管理者と確認してください。');
  }catch{message('保存結果を確認できません。入力は保持しています。再登録・Slack再送をせず、履歴の確認を続けてください。');}
  finally{busy=false;verify.disabled=false;}
 }
 try{
  const me=await API.me();
  if(!me?.gw?.roles?.includes('owner')||!target.access.some(key=>KPLayout.hasAccess(me,key))){message('記録できるのは、この部門の閲覧権限を持つ代表本人だけです。');return;}
  const ctx=await KPLayout.init({active:dept==='hr'?'hr_applicants':dept==='sales'?'sales':'office',access:target.access});if(!ctx)return;
  $('receipt-destination').textContent='記録先：'+target.label+' / '+target.channel+'　情報源：'+target.source;
  form.hidden=false;message('既に送信した投稿を確認して入力してください。入力内容はブラウザへ永続保存しません。');
  $('receipt-link').addEventListener('input',postFromLink);verify.addEventListener('click',readBack);
  form.addEventListener('submit',async event=>{
   event.preventDefault();if(busy||locked)return;
   let body;try{body=payload();}catch(e){message(e.message);return;}
   busy=true;fields.disabled=true;attempt=body;message('送信済みの記録を保存しています。Slackへの送信は行いません。');
   try{
    const result=await API.api('/api/slack-history',{method:'POST',body});
    if(result.ok!==true)throw Error('unknown');
    locked=true;message(result.duplicate?'同じ送信済み投稿は記録済みです。二重登録していません。':'送信済み投稿を記録しました。Slackへの送信はしていません。');verify.hidden=false;
   }catch(e){
    if([400,403,409,503].includes(e.status)){message(e.status===400?'入力を確認してください。保存されていません。':e.status===403?'記録権限を確認できません。保存されていません。':e.status===409?'既存の枠・版または投稿と競合しています。再送せず履歴を確認してください。':'保存先は準備中です。設定完了まで保存できません。');locked=e.status!==400;verify.hidden=!locked;}
    else{locked=true;verify.hidden=false;message('保存結果が不明です。再登録や版変更をせず「保存結果を履歴で確認する」を使ってください。Slack再送もしないでください。');}
   }finally{busy=false;fields.disabled=locked;}
  });
  window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});
 }catch{message('本人の権限を確認できません。再読み込みして確認してください。');}
})();
