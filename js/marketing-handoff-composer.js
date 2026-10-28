// Short PR TIMES editor: five small input tabs -> save -> preview -> internal registration.
// Shares 8sp's SpaceRelease formatter. Social publication belongs in the separate Distribution tab.
(function(){
"use strict";
const R=window.SpaceRelease;
if(!R)throw Error("8sp formatter not loaded");
const h=(tag,cls,text)=>{
 const e=document.createElement(tag);if(cls)e.className=cls;
 if(text!==undefined)e.textContent=String(text);
 if(["input","textarea","select","button"].includes(tag))e.disabled=state.busy;
 return e;
};
const sections=["基本情報","発表内容","開催・提供情報","会社・問い合わせ","画像・仕上げ"];
const init=()=>({
 kind:"service",title:"",subtitle:"",summary:"",background:"",features:[{title:"",body:""}],
 event_on:"",event_end_on:"",event_start:"",event_end:"",event_allday:false,
 event_time_tbd:false,event_date:"",venue:"",venue_name:"",venue_address:"",
 fee_type:"",fee_amount:"",fee_tax:"incl",partner:"",target:"",url:"",future:"",
 company:"株式会社エイト",company_kana:"",representative:"",founded:"",location:"",
 business:"",company_url:"",contact_dept:"",contact_name:"",contact_tel:"",
 contact_email:"",contact_hours:"",images:[]
});
const state={tab:0,stage:"edit",draft:init(),bodyOverride:"",id:null,version:null,ready:false,
 apiChecked:false,items:[],busy:false,savedSignature:null,dirty:false,error:"",notice:"",
 editingBody:false,registeredAt:null};
let root;
let disposePublication=null;
const signature=()=>JSON.stringify({draft:state.draft,body_override:state.bodyOverride});
const payload=()=>({draft:state.draft,body_override:state.bodyOverride,media:{}});
const plain=()=>state.bodyOverride||R.buildDraft({...state.draft,images:state.draft.images.map(i=>({path:i.name,caption:i.caption}))});
const dirty=()=>{state.dirty=true;state.notice="";state.error="";};
function createInput(label,key,opts={}){
 const wrapper=h("label","mpr-field");
 const cap=h("span","",label);
 if(opts.required)cap.append(h("b","mpr-required","必須"));
 wrapper.append(cap);
 const input=h(opts.values?"select":opts.multi?"textarea":"input");
 if(opts.values){
  for(const [v,t] of opts.values){const o=h("option","",t);o.value=v;input.append(o);}
 }else if(opts.multi)input.rows=opts.rows||3;
 else input.type=opts.type||"text";
 if(opts.max)input.maxLength=opts.max;
 input.value=state.draft[key]??"";
 if(opts.placeholder)input.placeholder=opts.placeholder;
 input.oninput=()=>{state.draft[key]=input.value;dirty();};
 if(opts.values)input.onchange=()=>{state.draft[key]=input.value;dirty();if(opts.dynamic)render();};
 wrapper.append(input);
 if(opts.hint)wrapper.append(h("small","",opts.hint));
 return wrapper;
}
const row=(...items)=>{const x=h("div","mpr-two");x.append(...items);return x;};
function flags(label,key){
 const lab=h("label","mpr-flag"),x=h("input");x.type="checkbox";x.checked=!!state.draft[key];
 x.onchange=()=>{state.draft[key]=x.checked;dirty();};
 lab.append(x,h("span","",label));return lab;
}
function basic(box){
 box.append(createInput("リリース種別","kind",{values:R.KINDS.map(k=>[k.value,k.label]),dynamic:true}));
 box.append(createInput("タイトル","title",{required:true,max:120,placeholder:"何を発表するのか、30〜45字が目安"}));
 box.append(createInput("サブタイトル","subtitle",{max:120,placeholder:"任意"}));
}
function features(box){
 const shell=h("div","mpr-features");
 state.draft.features.forEach((item,index)=>{
  const card=h("div","mpr-feature");
  const top=h("div","mpr-feature-head");top.append(h("strong","",String(index+1)+". ポイント"));
  if(state.draft.features.length>1){
   const remove=h("button","mpr-textbtn","削除");remove.type="button";
   remove.onclick=()=>{state.draft.features.splice(index,1);dirty();render();};top.append(remove);
  }
  const title=h("input");title.type="text";title.maxLength=120;title.value=item.title;title.placeholder="見出し";
  title.setAttribute("aria-label","特徴"+(index+1)+"の見出し");
  title.oninput=()=>{item.title=title.value;dirty();};
  const body=h("textarea");body.rows=2;body.value=item.body;body.placeholder="具体的な説明";
  body.setAttribute("aria-label","特徴"+(index+1)+"の説明");
  body.oninput=()=>{item.body=body.value;dirty();};
  card.append(top,title,body);shell.append(card);
 });
 box.append(shell);
 if(state.draft.features.length<3){
  const add=h("button","mpr-textbtn","＋ ポイントを追加");add.type="button";
  add.onclick=()=>{state.draft.features.push({title:"",body:""});dirty();render();};box.append(add);
 }
}
function content(box){
 box.append(createInput("概要・リード文","summary",{required:true,multi:true,rows:5,max:600,hint:"いつ・誰が・何を・どうするのか。200〜300字が目安"}));
 box.append(createInput("背景・目的","background",{multi:true,rows:4}));
 box.append(h("h4","","主な特徴・ポイント（最大3件）"));
 features(box);
 box.append(createInput("今後の展開","future",{multi:true,rows:3}));
}
function activity(box){
 const type=R.formOf(state.draft.kind);
 box.append(createInput(type.date||"日付","event_on",{type:"date"}));
 if(!state.draft.event_on)box.append(createInput("日付未定の場合の表記","event_date",{placeholder:"例：2027年春ごろ"}));
 if(type.end)box.append(createInput(type.end,"event_end_on",{type:"date"}));
 if(type.time){
  box.append(row(createInput("開始時刻","event_start",{type:"time"}),createInput("終了時刻","event_end",{type:"time"})));
  box.append(row(flags("終日","event_allday"),flags("時間未定","event_time_tbd")));
 }
 if(type.venue){
  box.append(createInput("会場","venue",{values:[["","未選択"],...R.VENUES.map(v=>[v.value,v.label])],dynamic:true}));
  if(state.draft.venue==="other")box.append(createInput("会場名","venue_name"));
  box.append(createInput("住所","venue_address"));
 }
 if(type.fee){
  box.append(createInput(type.fee,"fee_type",{values:[["","未設定"],["free","無料"],["paid","有料"],["invite","招待制"]],dynamic:true}));
  if(state.draft.fee_type==="paid")box.append(row(createInput("金額（円）","fee_amount",{type:"number"}),createInput("税区分","fee_tax",{values:[["incl","税込"],["excl","税別"]]})));
 }
 if(type.target)box.append(createInput("対象となる方","target"));
 if(type.partner)box.append(createInput("提携先","partner"));
 box.append(createInput(type.url||"詳細URL","url",{type:"url",placeholder:"https://"}));
}
function company(box){
 box.append(row(createInput("会社・団体名","company",{required:true}),createInput("フリガナ","company_kana")));
 box.append(row(createInput("代表者","representative"),createInput("設立","founded")));
 box.append(createInput("所在地","location"));
 box.append(createInput("事業内容","business"));
 box.append(createInput("会社URL","company_url",{type:"url",placeholder:"https://"}));
 box.append(h("h4","","本件に関するお問い合わせ"));
 box.append(row(createInput("担当部署","contact_dept"),createInput("担当者名","contact_name")));
 box.append(row(createInput("電話番号","contact_tel",{type:"tel"}),createInput("メールアドレス","contact_email",{type:"email"})));
 box.append(createInput("受付時間","contact_hours"));
 box.append(h("p","mpr-hint","電話番号またはメールアドレスのいずれかは必須です。"));
}
function images(box){
 box.append(h("p","mpr-hint","画像はJPEG/PNG/WebP/GIF、各10MB以下。現時点では画像のアップロードは未接続です。登録するのはファイル名と説明のみです。"));
 const input=h("input");input.type="file";input.multiple=true;input.accept="image/jpeg,image/png,image/webp,image/gif";
 input.setAttribute("aria-label","掲載画像を選択");
 input.onchange=()=>{
  let errors=0;
  for(const f of Array.from(input.files||[])){
   if(!["image/jpeg","image/png","image/webp","image/gif"].includes(f.type)||f.size>10*1024*1024||state.draft.images.length>=10){errors++;continue;}
   state.draft.images.push({name:f.name,caption:"",size:f.size});dirty();
  }
  if(errors)state.error="画像を追加できないものがありました（形式・枚数・容量を確認してください）。";
  render();
 };
 box.append(input);
 state.draft.images.forEach((image,i)=>{
  const r=h("div","mpr-image");
  r.append(h("small","",image.name));
  const cap=h("input");cap.value=image.caption;cap.placeholder="画像の説明";cap.setAttribute("aria-label","画像"+(i+1)+"の説明");
  cap.oninput=()=>{image.caption=cap.value;dirty();};
  const del=h("button","mpr-textbtn","削除");del.type="button";del.onclick=()=>{state.draft.images.splice(i,1);dirty();render();};
  r.append(cap,del);box.append(r);
 });
 box.append(h("p","mpr-hint","入力が終わったら『下書き保存』または『プレビューを見る』を選んでください。"));
}
const handlers=[basic,content,activity,company,images];
function check(){
 const missing=R.missing(state.draft);
 if(missing.length){state.error="入力が必要です："+missing.join("・");return false;}
 for(const k of ["url","company_url"]){
  const raw=state.draft[k];
  if(raw){
   try{const u=new URL(raw);if(u.protocol!=="https:"||u.username||u.password)throw Error();}
   catch{state.error="URLはhttps://から入力してください。";return false;}
  }
 }
 if(state.draft.fee_type==="paid"&&!(Number(state.draft.fee_amount)>0)){state.error="有料の場合は金額を入力してください。";return false;}
 if(state.draft.event_on&&state.draft.event_end_on&&state.draft.event_end_on<state.draft.event_on){state.error="終了日を開始日以降にしてください。";return false;}
 if(state.draft.images.some(x=>!x.caption)){state.error="画像の説明を入力してください。";return false;}
 state.error="";return true;
}
function onError(err){
 state.error=err?.body?.hint||err?.hint||err?.message||"保存できませんでした。";
}
async function save(){
 if(state.busy)return false;
 if(!state.ready||!window.API?.api){state.error="保存先が未準備です。SQL適用・マーケティング権限を確認してください。";render();return false;}
 if(state.registeredAt){state.error="本登録済みの原稿は上書きできません。";render();return false;}
 // Capture the exact request before awaiting; later edits must never become "saved".
 const requestPayload=JSON.parse(JSON.stringify(payload()));
 const requestSignature=JSON.stringify({draft:requestPayload.draft,body_override:requestPayload.body_override});
 state.busy=true;state.error="";render();
 try{
  const data=await API.api("/api/marketing/pr-drafts",{method:"POST",body:{action:"save",id:state.id,version:state.version,payload:requestPayload}});
  state.id=data.item.id;state.version=data.item.version;state.savedSignature=requestSignature;
  state.dirty=signature()!==requestSignature;
  state.notice=state.dirty?"下書きを保存しました。保存中の変更は未保存です。":"下書きを保存しました。";
  return true;
 }catch(err){onError(err);return false;}
 finally{state.busy=false;render();}
}
async function register(){
 if(state.busy)return;
 if(!state.ready||!state.id||!state.version||state.dirty||state.savedSignature!==signature()){
  state.error="本登録の前に最新の下書きを保存してください。";render();return;
 }
 if(!check()){render();return;}
 const confirmedPayload=JSON.parse(JSON.stringify(payload()));
 state.busy=true;render();
 try{
  const data=await API.api("/api/marketing/pr-drafts",{method:"POST",body:{action:"register",id:state.id,version:state.version,confirmed:true}});
  // Show the registered original, never an editor changed while the request was pending.
  const registeredPayload=data.item.payload||confirmedPayload;
  state.draft=JSON.parse(JSON.stringify(registeredPayload.draft));
  state.bodyOverride=registeredPayload.body_override||"";
  state.savedSignature=signature();state.dirty=false;
  state.version=data.item.version;state.registeredAt=data.item.registeredAt;state.stage="complete";
  state.notice="社内PRとして本登録しました（PR TIMESには投稿していません）。";
 }catch(err){onError(err);}
 finally{state.busy=false;render();}
}
function openSaved(item){
 if(state.busy||!item||!item.payload?.draft)return;
 state.draft={...init(),...JSON.parse(JSON.stringify(item.payload.draft))};
 state.bodyOverride=item.payload.body_override||"";
 state.id=item.id;state.version=item.version;state.registeredAt=item.registeredAt;
 state.savedSignature=signature();state.dirty=false;
 state.stage=item.status==="registered"?"complete":"edit";
 state.tab=0;state.error="";state.notice="保存された原稿を開きました。";
 render();
}
async function load(){
 if(!window.API?.api){window.MarketingStatusUI?.set("pr","failed","ログインと接続を確認してください");return;}
 let issue=null;
 try{
  const data=await API.api("/api/marketing/pr-drafts");
  state.ready=!!data?.ready;state.items=data.items||[];
 }catch(err){
  issue=err;state.ready=false;
  state.notice=err?.body?.error==="not_ready"?"PR原稿の保存先が未準備です。管理者に確認してください。":"保存先の接続・権限を確認してください。";
 }finally{
  state.apiChecked=true;
  window.MarketingStatusUI?.set("pr",state.ready?"ok":issue?window.MarketingStatusUI.normalized(issue):"not_ready",state.ready?"PR原稿の読み取りができました":state.notice);
  render();
 }
}
function action(label,klass,fn,disabled=false){const b=h("button",klass,label);b.type="button";b.disabled=state.busy||disabled;b.onclick=()=>{if(!state.busy&&!disabled)return fn();};return b;}
function renderEditing(){
 const tabs=h("div","mpr-tabs");tabs.setAttribute("role","tablist");tabs.setAttribute("aria-label","PR入力の項目");
 sections.forEach((label,i)=>{
  const tab=action((i+1)+". "+label,"mpr-tab"+(state.tab===i?" active":""),()=>{state.tab=i;render();});
  tab.setAttribute("role","tab");tab.setAttribute("aria-selected",String(state.tab===i));
  tabs.append(tab);
 });
 root.append(tabs);
 const card=h("section","mpr-card");card.append(h("h3","",sections[state.tab]));
 const content=h("div","mpr-body");handlers[state.tab](content);card.append(content);root.append(card);
 const actions=h("div","mpr-actions");
 actions.append(action("前へ","mpr-secondary",()=>{state.tab=Math.max(0,state.tab-1);render();},state.tab===0));
 if(state.tab<sections.length-1){
  actions.append(action("次へ： "+sections[state.tab+1],"mpr-primary",()=>{state.tab++;render();}));
 }else{
  actions.append(action(state.busy?"保存中…":"下書き保存","mpr-secondary",()=>save(),state.busy||!state.ready));
  actions.append(action("プレビューを見る","mpr-primary",()=>{if(check()){state.stage="preview";render();}else render();},state.busy));
 }
 root.append(actions);
}
function preview(){
 const card=h("section","mpr-card");
 card.append(h("h3","","PR TIMES掲載用の原稿プレビュー"));
 card.append(h("p","mpr-hint","入力内容から生成した掲載用文章です。ここでOKなら社内の本登録に進みます。"));
 const draft=h("pre","mpr-preview",plain());
 card.append(draft);
 const tools=h("div","mpr-tools");
 tools.append(action("入力画面へ戻る","mpr-secondary",()=>{state.stage="edit";render();}));
 if(window.navigator?.clipboard?.writeText){
  tools.append(action("本文をコピー","mpr-secondary",async()=>{try{await navigator.clipboard.writeText(plain());state.notice="本文をコピーしました。";}catch{state.error="コピーできませんでした。";}render();}));
 }
 card.append(tools);
 const status=h("p","mpr-save-state",
  state.registeredAt?"社内登録済み":
  !state.ready?"保存先未接続：プレビューのみ利用できます。":
  state.savedSignature===signature()&&!state.dirty?"下書き保存済み":"未保存のプレビュー");
 card.append(status);
 if(state.ready&&!state.registeredAt){
  const actions=h("div","mpr-actions");
  actions.append(action(state.busy?"保存中…":"下書き保存","mpr-secondary",()=>save(),state.busy));
  actions.append(action("内容を確認して本登録","mpr-primary",()=>register(),
   state.busy||!state.id||state.dirty||state.savedSignature!==signature()));
  card.append(actions);
  if(!state.id||state.dirty)card.append(h("p","mpr-hint","先に下書きを保存すると本登録ボタンが有効になります。"));
 }else{
  card.append(h("p","mpr-hint","本登録には社内保存機能の準備が必要です。公開やSNS投稿は行われません。"));
 }
 root.append(card);
}
function complete(){
 const card=h("section","mpr-card");
 card.append(h("h3","","社内PRの本登録"));
 card.append(h("p","mpr-success","社内のPR原稿として本登録しました。"));
 card.append(h("p","mpr-hint","この社内本登録だけでは、PR TIMESへの掲載・サイト公開・SNS投稿・ブラストメール送信は行われません。自社サイトへの公開状態は下の欄で確認してください。"));
 card.append(h("pre","mpr-preview",plain()));
 card.append(action("新しいPRを作成","mpr-primary",()=>{Object.assign(state,{tab:0,stage:"edit",draft:init(),bodyOverride:"",id:null,version:null,savedSignature:null,dirty:false,error:"",notice:"",registeredAt:null});render();}));
 root.append(card);
 if(window.MarketingSitePublication?.mount){
  const publication=h("section");root.append(publication);
  disposePublication=window.MarketingSitePublication.mount(publication,{id:state.id,version:state.version});
 }
}
function render(){
 if(!root)return;
 if(disposePublication){disposePublication();disposePublication=null;}
 root.replaceChildren();
 const head=h("div","mpr-head");
 const left=h("div");left.append(h("h2","","PR TIMES用の原稿を作成"));
 left.append(h("p","","項目ごとに入力し、最後にプレビューで確認して社内本登録へ。"));
 head.append(left);root.append(head);
 if(state.apiChecked){
  const bar=h("div","mpr-draft-bar");
  bar.append(h("span","",state.ready?"社内保存に接続済み":"社内保存は準備中（プレビューは利用できます）"));
  if(state.ready&&state.items.length){
   const select=h("select");select.setAttribute("aria-label","保存されたPRを開く");
   const o=h("option","","過去の下書きを開く");o.value="";select.append(o);
   for(const item of state.items){
    const label=(item.payload?.draft?.title||"無題")+"（"+(item.status==="registered"?"本登録済":"下書き")+"）";
    const opt=h("option","",label);opt.value=item.id;select.append(opt);
   }
   select.onchange=()=>{const item=state.items.find(x=>x.id===select.value);if(item)openSaved(item);};
   bar.append(select);
  }
  root.append(bar);
 }
 if(state.stage==="edit")renderEditing();
 else if(state.stage==="preview")preview();
 else complete();
 if(state.notice)root.append(h("p","mpr-notice",state.notice));
 if(state.error)root.append(h("p","mpr-error",state.error));
 root.append(h("p","mpr-footnote","『本登録』は社内PR原稿の登録です。PR TIMESへの入稿・SNSへの投稿・画像アップロードとは別です。"));
}
window.MarketingHandoffComposer={
 mount(el){root=el;render();load();},
 reload(){if(!state.busy)return load();},
 snapshot(){return {tab:state.tab,stage:state.stage,id:state.id,version:state.version,ready:state.ready};},
 buildDraft:plain,missing:()=>R.missing(state.draft),
 // Only for synthetic UI tests, not a service action.
 __test:{check}
};
})();
