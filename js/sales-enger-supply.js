// 企業詳細モーダル内の「案件/人材をもらう」営業アクション。
// DBの正本はENGER。案件・人材は実際の本登録IDがある時だけ registered にできる。
(() => {
 const modal=document.getElementById("enger-directory-modal"); if(!modal)return;
 const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const stageLabels={planned:"依頼予定",contacted:"連絡済み",appointment:"打ち合わせ予定",awaiting_info:"情報待ち",received:"情報受領",registered:"ENGER本登録済み",closed:"見送り"};
 const kindLabels={job:"案件情報",talent:"人材情報",both:"両方"};
 const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 let company=null,latest=[],sequence=0;
 const root=()=>modal.querySelector("#enger-supply-pipeline");
 const report=msg=>{const e=modal.querySelector("#enger-supply-message");if(e)e.textContent=msg;};
 const draw=()=>{
  const el=root();if(!el)return;
  const rows=latest.map(item=>{
    const registered=item.stage==="registered";
    const disabled=registered?"disabled":"";
    return '<article class="engr-supply-record" data-supply-id="'+esc(item.id)+'">'+
      '<header><strong>'+esc(kindLabels[item.request_kind])+'</strong><small>作成 '+esc((item.created_at||"").slice(0,10))+'</small></header>'+
      '<div class="engr-supply-fields"><label>進行状況<select data-supply-stage '+disabled+'>'+
       Object.entries(stageLabels).map(([key,label])=>'<option value="'+key+'" '+(item.stage===key?"selected":"")+'>'+esc(label)+'</option>').join("")+
       '</select></label><label>次回連絡日<input type="date" data-supply-next value="'+esc(item.next_action_on||"")+'" '+disabled+'></label></div>'+
      '<label class="engr-supply-notes">確認した内容・相手の回答（メールアドレスなど個人情報は記入しない）'+
       '<textarea data-supply-note rows="2" maxlength="2000" '+disabled+'>'+esc(item.note||"")+'</textarea></label>'+
      '<div class="engr-supply-fields" data-registered-fields hidden>'+
       '<label>ENGER案件ID<input data-supply-job placeholder="案件UUID" value="'+esc(item.job_id||"")+'" '+disabled+'></label>'+
       '<label>ENGER人材ID<input data-supply-candidate placeholder="人材UUID" value="'+esc(item.candidate_id||"")+'" '+disabled+'></label></div>'+
      (registered?'<p class="engr-muted">ENGERに登録された情報と連携済み。記録の変更はできません。</p>':
       '<button class="btn btn-secondary btn-sm" type="button" data-supply-save>進捗を保存</button>')+
     '</article>';
  }).join("");
  el.innerHTML='<div class="engr-supply-intro"><h3>案件・人材情報の提供依頼</h3>'+
   '<p>電話・メール・面談で「案件配信先」「人材配信先」と、提供できる情報を確認。連絡先はSales企業詳細へ保存し、ここでは進捗とENGER登録IDを管理します。</p>'+
   '<p class="engr-muted">自動メール送信なし／連絡拒否がある企業は新規依頼を作成しません。</p></div>'+
   '<div class="engr-supply-controls"><label>依頼する情報<select id="enger-supply-kind">'+
     Object.entries(kindLabels).map(([key,label])=>'<option value="'+key+'">'+label+'</option>').join("")+'</select></label>'+
   '<label>次回連絡日<input type="date" id="enger-supply-next"></label>'+
   '<button type="button" class="btn btn-primary btn-sm" id="enger-supply-create" '+(company.needsContactReview||company.bucket==="existing"?"disabled":"")+
   '>情報提供を依頼する</button></div>'+
   (company.bucket==="existing"?'<p class="engr-muted">既存取引・やり取り中の企業は新規アタック対象から除外しています。取引担当へ確認してください。</p>':"")+
   '<div id="enger-supply-message" role="status"></div>'+
   '<div class="engr-supply-records">'+(rows||'<p class="engr-muted">依頼履歴はまだありません。</p>')+'</div>';
  for(const article of el.querySelectorAll(".engr-supply-record")){
   const stage=article.querySelector("[data-supply-stage]"),extra=article.querySelector("[data-registered-fields]");
   const change=()=>{extra.hidden=stage.value!=="registered";};
   stage?.addEventListener("change",change);change();
  }
 };
 const load=async()=>{
  const el=root();if(!el||!company)return;
  el.textContent="依頼・受領履歴を読み込み中…";
  const ticket=++sequence;
  try{
   const data=await window.API.api("/api/sales/enger-company-supply?companyId="+encodeURIComponent(company.id));
   if(ticket!==sequence)return;
   if(!data.complete)throw Error("履歴の完全性を確認できません");
   latest=data.rows||[];draw();
  }catch(e){
   if(ticket!==sequence)return;
   el.innerHTML='<p class="engr-alert" role="alert">'+esc(e.hint||"履歴を取得できません。更新を中止しました。")+'</p>'+
      '<button type="button" class="btn btn-secondary btn-sm" data-supply-retry>再取得</button>';
  }
 };
 document.addEventListener("enger:company-open",event=>{
  company=event.detail&&event.detail.company;
  if(!company)return;void load();
 });
 modal.addEventListener("click",async event=>{
  if(event.target.closest("[data-supply-retry]")){void load();return;}
  if(event.target.closest("#enger-supply-create")){
   const btn=event.target.closest("#enger-supply-create");if(!company||btn.disabled)return;
   const kind=modal.querySelector("#enger-supply-kind")?.value;
   const nextActionOn=modal.querySelector("#enger-supply-next")?.value||null;
   btn.disabled=true;report("依頼記録を登録中…");
   try{
    await window.API.api("/api/sales/enger-company-supply",
       {method:"POST",body:{companyId:company.id,kind,nextActionOn,note:""}},
    );
    await load();
   }catch(e){btn.disabled=false;report(e.hint||"登録できませんでした。");}
   return;
  }
  const save=event.target.closest("[data-supply-save]");if(!save||!company)return;
  const form=save.closest("[data-supply-id]");if(!form)return;
  const stage=form.querySelector("[data-supply-stage]").value;
  const nextActionOn=form.querySelector("[data-supply-next]").value||null;
  const note=form.querySelector("[data-supply-note]").value;
  const jobId=form.querySelector("[data-supply-job]").value.trim()||null;
  const candidateId=form.querySelector("[data-supply-candidate]").value.trim()||null;
  if(stage==="registered"&&!jobId&&!candidateId){
   report("ENGERに正式登録した案件IDまたは人材IDを入力してください。");return;
  }
  if(jobId&&!UUID.test(jobId)||candidateId&&!UUID.test(candidateId)){report("ENGER案件ID・人材IDの形式が不正です。");return;}
  save.disabled=true;report("進行状況を保存中…");
  try{
   await window.API.api("/api/sales/enger-company-supply",
    {method:"PATCH",body:{id:form.dataset.supplyId,companyId:company.id,stage,nextActionOn,note,jobId,candidateId}});
   await load();
  }catch(e){save.disabled=false;report(e.hint||"保存できませんでした。");}
 });
})();
