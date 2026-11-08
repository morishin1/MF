// 社内Sales商談：5ステップを進め、企業側の同じセッションを3秒間隔で更新する。
// 企業は別途ログイン。社内専用APIだけがステップを変更できる。
const STEPS=[
 {name:"会社紹介",title:"株式会社エイトのご紹介",
  description:"AI・DX開発、ENGERによるIT人材・案件紹介、教育などの支援内容を簡潔にご紹介します。"},
 {name:"課題確認",title:"御社の課題と希望条件の確認",
  description:"必要な人材・案件、担当業務、開始時期、予算・単価、決裁までの流れを双方で確認します。AIの需要仮説は未確認事項として扱います。"},
 {name:"マッチング提案",title:"公開承認した人材・案件のご提案",
  description:"今回選んだ候補を同じ商談セッションでご覧いただけます。スキル・稼働可能性・募集継続は個別確認が必要です。"},
 {name:"条件確認",title:"契約条件・稼働条件のすり合わせ",
  description:"費用・開始日・契約形態・稼働場所・面談回数などを確認します。正式な条件合意は担当営業の確認後に記録します。"},
 {name:"クロージング",title:"次のステップを決める",
  description:"面談調整・条件調整・正式契約の準備・見送りを確認し、担当と期限を決めます。画面の操作だけで契約は成立しません。"}
];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const qs=new URLSearchParams(location.search),companyId=qs.get("companyId"),sessionId=qs.get("sessionId");
if(UUID.test(companyId||"")&&UUID.test(sessionId||"")){
 const by=id=>document.getElementById(id);
 const holder=by("meeting-stages"),panel=by("meeting-step-description"),content=by("meeting-proposals"),
  back=by("meeting-back"),next=by("meeting-forward"),status=by("meeting-live-status");
 holder.hidden=false;panel.hidden=false;by("meeting-navigation").hidden=false;
 let current=null,updating=false;
 const route="/api/sales/meeting-session";
 function render(s){
  if(!s)return;
  current=s;
  holder.replaceChildren();
  STEPS.forEach((step,i)=>{
   const btn=document.createElement("button");btn.type="button";
   btn.textContent=(i<s.stage?"✓ ":"")+(i+1)+". "+step.name;
   btn.className="meeting-stage"+(i===s.stage?" active":i<s.stage?" completed":"");
   btn.setAttribute("aria-current",i===s.stage?"step":"false");
   btn.disabled=updating||s.status!=="active"||Math.abs(i-s.stage)!==1;
   btn.addEventListener("click",()=>changeStage(i));
   holder.append(btn);
  });
  const step=STEPS[s.stage];
  by("meeting-step-title").textContent=step.title;
  by("meeting-step-copy").textContent=step.description;
  content.hidden=false;
  const summary=by("meeting-company-summary");
  if(summary)summary.hidden=s.stage!==0;
  back.disabled=updating||s.status!=="active"||s.stage===0;
  next.disabled=updating||s.status!=="active"||s.stage===4;
  status.textContent=s.status==="closed"?"商談終了（過去の履歴を表示中）":
    "商談進行を企業ログイン後の画面と共有中。次へ進むと双方の表示が切り替わります。";
 }
 async function refresh(){
  try{
   const r=await API.api(route+"?"+new URLSearchParams({companyId,sessionId}));
   if(!updating&&r.session)render(r.session);
  }catch(e){status.textContent=e?.hint||e?.message||"商談進行を同期できません。再接続を確認してください。";}
 }
 async function changeStage(stage){
  if(updating||!current||Math.abs(stage-current.stage)!==1)return;
  updating=true;render(current);status.textContent="双方の画面を切り替えています…";
  try{
   const r=await API.api(route,{method:"PATCH",body:{
    companyId,sessionId,stage,version:current.version
   }});
   if(r.session)current=r.session;
   if(r.historySaved===false)status.textContent="進行は更新しましたが履歴保存を確認してください。";
  }catch(e){
   status.textContent=e?.hint||e?.message||"商談の進行を更新できませんでした。";
   await refresh();
  }finally{updating=false;render(current);}
 }
 back.addEventListener("click",()=>changeStage(Math.max(0,(current?.stage??0)-1)));
 next.addEventListener("click",()=>changeStage(Math.min(4,(current?.stage??0)+1)));
 refresh();
 const polling=setInterval(()=>{if(!document.hidden&&!updating)refresh();},3000);
 window.addEventListener("pagehide",()=>clearInterval(polling),{once:true});
}
