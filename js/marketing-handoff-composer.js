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
 contact_email:"",contact_hours:"",images:[],sections:[]
});
const state={tab:0,stage:"edit",draft:init(),bodyOverride:"",id:null,version:null,ready:false,
 apiChecked:false,items:[],busy:false,savedSignature:null,dirty:false,error:"",notice:"",
 editingBody:false,registeredAt:null,tracking:[]};
let root;
let savedRoot, onSavedOpen, savedPage=1;
let selectedSaved=new Set(),savedFilter="all",savedPeriod="30";
const inSavedPeriod=(item,period)=>{
 if(period==="all")return true;
 const date=Date.parse(item.updatedAt||item.createdAt||"");
 return Number.isFinite(date)&&date>=Date.now()-Number(period)*86400000;
};
let disposePublication=null;
const signature=()=>JSON.stringify({draft:state.draft,body_override:state.bodyOverride});
const payload=()=>({draft:state.draft,body_override:state.bodyOverride,media:{},tracking:state.tracking});
const basePlain=()=>state.bodyOverride||R.buildDraft({...state.draft,images:state.draft.images.map(i=>({path:i.name,caption:i.caption}))});
const extraPlain=()=> (state.draft.sections||[]).map(s=>[s.title&&"■ "+s.title,s.body,s.imageKey&&state.draft.images.find(i=>i.key===s.imageKey)?.caption].filter(Boolean).join("\n")).filter(Boolean).join("\n\n");
const plain=()=>[basePlain(),extraPlain()].filter(Boolean).join("\n\n");
function renderBody(card){
 card.append(h("pre","mpr-preview",basePlain()));
 for(const section of state.draft.sections||[]){
  const box=h("section","mpr-body-section");
  if(section.title)box.append(h("h4","",section.title));
  if(section.body)box.append(h("pre","mpr-preview",section.body));
  const image=state.draft.images.find(i=>i.key&&i.key===section.imageKey);
  if(image)window.MarketingImagePreview?.render(box,[image],!!state.registeredAt);
  card.append(box);
 }
}
function customSections(box){
 const list=state.draft.sections||(state.draft.sections=[]);
 box.append(h("h4","","本文セクション（任意・最大20件）"));
 box.append(h("p","mpr-hint","見出し・本文を自由に追加できます。写真は『5.画像・仕上げ』で選択したものを本文に挿入できます。追加セクションは基本原稿の後に表示されます。"));
 list.forEach((section,index)=>{
  const card=h("div","mpr-feature");card.append(h("strong","","追加セクション "+(index+1)));
  const title=h("input");title.value=section.title;title.maxLength=120;title.placeholder="見出し";title.setAttribute("aria-label","追加セクション"+(index+1)+"の見出し");
  title.oninput=()=>{if(state.busy)return;section.title=title.value;dirty();};
  const body=h("textarea");body.rows=5;body.value=section.body;body.maxLength=6000;body.placeholder="本文";body.setAttribute("aria-label","追加セクション"+(index+1)+"の本文");
  body.oninput=()=>{if(state.busy)return;section.body=body.value;dirty();};
  const photo=h("select");photo.setAttribute("aria-label","追加セクション"+(index+1)+"の写真");
  const none=h("option","","写真なし");none.value="";photo.append(none);
  state.draft.images.forEach((image,n)=>{const option=h("option","",image.name);option.value=String(n);photo.append(option);});
  const current=state.draft.images.findIndex(i=>i.key&&i.key===section.imageKey);photo.value=current<0?"":String(current);
  photo.onchange=()=>{if(state.busy)return;const image=photo.value===""?null:state.draft.images[Number(photo.value)];if(image&&!image.key)image.key=crypto.randomUUID();section.imageKey=image?.key||"";dirty();};
  card.append(title,body,photo);
  card.append(action("セクションを削除","mpr-textbtn",()=>{list.splice(index,1);dirty();render();}));
  if(index>0)card.append(action("上へ","mpr-textbtn",()=>{[list[index-1],list[index]]=[list[index],list[index-1]];dirty();render();}));
  if(index<list.length-1)card.append(action("下へ","mpr-textbtn",()=>{[list[index+1],list[index]]=[list[index],list[index+1]];dirty();render();}));
  box.append(card);
 });
 if(list.length<20)box.append(action("＋ 本文セクションを追加","mpr-secondary",()=>{list.push({title:"",body:"",imageKey:""});dirty();render();}));
}
const dirty=()=>{state.dirty=true;state.notice="";state.error="";renderSavedList();};
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
 customSections(box);
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
 box.append(h("p","mpr-hint","画像はJPEG/PNG/WebP/GIF、各10MB以下。現時点では画像のアップロードは未接続です。登録するのはファイル名と説明のみです。選択した画像はこの画面内でプレビューできます。先頭の画像をトップに表示します。本文への写真の挿入は『2.発表内容』の追加セクションで選べます（この画面内のプレビューのみ。公開本文には画像説明の文字だけが入ります）。"));
 const input=h("input");input.type="file";input.multiple=true;input.accept="image/jpeg,image/png,image/webp,image/gif";
 input.setAttribute("aria-label","掲載画像を選択");
 const selectedImages=state.draft.images;
 input.onchange=()=>{
  if(state.busy||state.stage!=="edit"||state.tab!==4||state.draft.images!==selectedImages)return;
  let errors=0;
  for(const f of Array.from(input.files||[])){
   if(!["image/jpeg","image/png","image/webp","image/gif"].includes(f.type)||f.size>10*1024*1024||state.draft.images.length>=10){errors++;continue;}
   const image={name:f.name,caption:"",size:f.size};
   if(window.MarketingImagePreview&&!window.MarketingImagePreview.attach(image,f)){errors++;continue;}
   state.draft.images.push(image);dirty();
  }
  if(errors)state.error="画像を追加できないものがありました（形式・枚数・容量を確認してください）。";
  render();
 };
 box.append(input);
 state.draft.images.forEach((image,i)=>{
  const r=h("div","mpr-image");
  r.append(h("small","",(i===0?"トップ画像：":"画像：")+image.name));
  const cap=h("input");cap.value=image.caption;cap.placeholder="画像の説明";cap.setAttribute("aria-label","画像"+(i+1)+"の説明");
  cap.oninput=()=>{image.caption=cap.value;dirty();};
  const del=h("button","mpr-textbtn","原稿から外す");del.type="button";del.onclick=()=>{state.draft.images.splice(i,1);for(const s of state.draft.sections||[])if(s.imageKey===image.key)s.imageKey="";dirty();render();};
  const replace=h("input");replace.type="file";replace.accept=input.accept;replace.setAttribute("aria-label","画像"+(i+1)+"を差し替え");
  replace.onchange=()=>{
   if(state.busy||state.stage!=="edit"||state.tab!==4||state.draft.images[i]!==image)return;const file=replace.files?.[0];if(!file)return;
   const next={name:file.name,caption:image.caption,size:file.size,...(image.key?{key:image.key}:{})};
   if(!window.MarketingImagePreview?.attach(next,file)){state.error="画像を差し替えできません（形式・容量を確認してください）。";render();return;}
   state.draft.images[i]=next;dirty();render();
  };
  r.append(cap,replace,del);
  if(i>0)r.append(action("トップにする","mpr-textbtn",()=>{state.draft.images.splice(i,1);state.draft.images.unshift(image);dirty();render();}));
  box.append(r);
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
  rememberSaved(data.item);
  window.MarketingImagePreview?.remember(data.item.id,state.draft.images);
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
  rememberSaved(data.item);
  // Show the registered original, never an editor changed while the request was pending.
  const registeredPayload=data.item.payload||confirmedPayload;
  window.MarketingImagePreview?.remember(state.id,state.draft.images);
  state.draft=JSON.parse(JSON.stringify(registeredPayload.draft));
  window.MarketingImagePreview?.restore(state.id,state.draft.images);
  state.bodyOverride=registeredPayload.body_override||"";
  state.tracking=registeredPayload.tracking||[];
  state.savedSignature=signature();state.dirty=false;
  state.version=data.item.version;state.registeredAt=data.item.registeredAt;state.stage="complete";
  state.notice="社内PRとして本登録しました（PR TIMESには投稿していません）。";
 }catch(err){onError(err);}
 finally{state.busy=false;render();}
}
function openSaved(item){
 if(state.busy||!item||!item.payload?.draft)return;
 window.MarketingWordImportUI?.clear();
 state.draft={...init(),...JSON.parse(JSON.stringify(item.payload.draft))};
 window.MarketingImagePreview?.restore(item.id,state.draft.images);
 state.bodyOverride=item.payload.body_override||"";
 state.tracking=JSON.parse(JSON.stringify(item.payload.tracking||[]));
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
function applyImported(fields){
 if(state.busy||state.registeredAt||state.stage!=="edit")return false;
 if(state.bodyOverride)state.bodyOverride="";
 for(const [key,value] of Object.entries(fields)){
  if(key==="features"){
   state.draft.features=value.map(x=>({title:x.title||"",body:x.body||""})).slice(0,3);
  }else if(Object.hasOwn(state.draft,key))state.draft[key]=value;
 }
 dirty();state.notice="Word原稿の選択内容を反映しました。確認・編集してから下書き保存してください。";
 state.tab=0;render();
 return true;
}
function renderEditing(){
 const importRoot=h("div","mpr-import-mount");root.append(importRoot);
 window.MarketingWordImportUI?.mount(importRoot,{
  getDraft:()=>state.draft,
  hasOverride:()=>!!state.bodyOverride,
  canApply:()=>!state.busy&&!state.registeredAt&&state.stage==="edit",
  apply:applyImported
 });
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
 window.MarketingImagePreview?.render(card,state.draft.images,!!state.registeredAt);
 renderBody(card);
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
 window.MarketingImagePreview?.render(card,state.draft.images,!!state.registeredAt);
 renderBody(card);
 card.append(action("新しいPRを作成","mpr-primary",()=>{window.MarketingWordImportUI?.clear();Object.assign(state,{tab:0,stage:"edit",draft:init(),bodyOverride:"",id:null,version:null,savedSignature:null,dirty:false,error:"",notice:"",registeredAt:null,tracking:[]});render();}));
 root.append(card);
 if(window.MarketingSitePublication?.mount){
  const publication=h("section");root.append(publication);
  disposePublication=window.MarketingSitePublication.mount(publication,{id:state.id,version:state.version});
 }
}
function rememberSaved(item){
 const i=state.items.findIndex(x=>x.id===item.id);
 if(i<0)state.items.unshift(item);else state.items[i]=item;
}

const CHANNELS=[
 ["site","自社","home"],["prtimes","PR TIMES","newspaper"],["x","X","alternate_email"],
 ["instagram","Instagram","photo_camera"],["facebook","Facebook","groups"],["linkedin","LinkedIn","work"],
 ["line","LINE","chat"],["other","その他","language"]
];
const formatWhen=(value)=>{
 if(!value)return "日時未登録";
 const t=new Date(value);return Number.isNaN(t.getTime())?"日時未登録":new Intl.DateTimeFormat("ja-JP",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(t);
};
const trackingOf=(item)=>Array.isArray(item?.payload?.tracking)?item.payload.tracking:[];
function totalMetric(items,key){
 let sum=0,measured=false;
 for(const item of items)for(const record of trackingOf(item)){
  if(record.status==="published"&&Number.isSafeInteger(record[key])&&record[key]>=0){sum+=record[key];measured=true;}
 }
 return measured?sum.toLocaleString("ja-JP"):"—";
}
function closePRDialog(dialog,escListener){
 document.removeEventListener("keydown",escListener);dialog.remove();
}
function modalShell(title){
 const backdrop=h("div","mpr-dialog-backdrop");
 backdrop.setAttribute("role","presentation");
 const modal=h("section","mpr-dialog");modal.setAttribute("role","dialog");modal.setAttribute("aria-modal","true");
 modal.setAttribute("aria-label",title);
 const head=h("div","mpr-dialog-head");head.append(h("h3","",title));
 const close=h("button","mpr-textbtn","閉じる");close.type="button";close.setAttribute("aria-label","閉じる");
 const escListener=e=>{if(e.key==="Escape")closePRDialog(backdrop,escListener);};
 close.onclick=()=>closePRDialog(backdrop,escListener);
 head.append(close);modal.append(head);backdrop.append(modal);
 backdrop.onclick=e=>{if(e.target===backdrop)closePRDialog(backdrop,escListener);};
 document.addEventListener("keydown",escListener);document.body.append(backdrop);close.focus();
 return {backdrop,modal,escListener};
}
function newPR(mode="create"){
 if(state.dirty&&!window.confirm("編集中の未保存原稿を破棄して、新規作成しますか？"))return;
 window.MarketingWordImportUI?.clear();
 Object.assign(state,{tab:0,stage:"edit",draft:init(),bodyOverride:"",id:null,version:null,
  savedSignature:null,dirty:false,error:"",notice:"",registeredAt:null,tracking:[]});
 render();
 onSavedOpen?.(mode);
}
function openPRPreview(item){
 const shell=modalShell("PR原稿プレビュー"),d=item.payload?.draft||{};
 shell.modal.append(h("p","mpr-dialog-sub",formatWhen(item.updatedAt)+" 更新・"+(item.status==="registered"?"社内本登録済み":"下書き")));
 shell.modal.append(h("h4","",d.title||"無題"));
 const text=item.payload?.body_override||R.buildDraft({...init(),...d,images:(d.images||[]).map(i=>({path:i.name,caption:i.caption}))});
 const sections=(d.sections||[]).map(section=>[section.title,section.body].filter(Boolean).join("\n")).filter(Boolean).join("\n\n");
 shell.modal.append(h("pre","mpr-dialog-preview",[text,sections].filter(Boolean).join("\n\n")));
 const actions=h("div","mpr-dialog-actions");
 if(item.status==="draft")actions.append(action("編集する","mpr-secondary",()=>{
  if(state.dirty&&state.id!==item.id){state.error="編集中の原稿を先に保存してください。";render();return;}
  openSaved(item);closePRDialog(shell.backdrop,shell.escListener);onSavedOpen?.("edit");
 },state.busy));
 actions.append(action("掲載先・実績を記録","mpr-primary",()=>{
  closePRDialog(shell.backdrop,shell.escListener);openPRTracking(item,"site");
 }));
 shell.modal.append(actions);
}
function openPRTracking(item,startChannel){
 if(state.busy){return;}
 const shell=modalShell("配信先・反響の記録");
 shell.modal.append(h("p","mpr-dialog-sub",(item.payload?.draft?.title||"無題")+"／掲載状況と手入力の実績を記録します。外部投稿は行いません。"));
 const select=h("select","mpr-dialog-input");select.setAttribute("aria-label","配信媒体");
 CHANNELS.forEach(([key,label])=>{const opt=h("option","",label);opt.value=key;select.append(opt);});
 select.value=startChannel||"site";shell.modal.append(select);
 const form=h("form","mpr-track-form");
 function field(label,type,placeholder){
  const wrap=h("label","mpr-track-label");wrap.append(h("span","",label));
  const input=h("input","mpr-dialog-input");input.type=type;
  if(placeholder)input.placeholder=placeholder;
  wrap.append(input);form.append(wrap);return input;
 }
 const statusLabel=h("label","mpr-track-label");statusLabel.append(h("span","","配信状況"));
 const status=h("select","mpr-dialog-input");
 for(const [key,label] of [["planned","未配信"],["scheduled","予約・予定"],["published","配信済み（手動記録）"]]){
  const opt=h("option","",label);opt.value=key;status.append(opt);
 }
 statusLabel.append(status);form.append(statusLabel);
 const url=field("掲載URL（任意・https）","url","https://…");
 const when=field("配信・予定日時","datetime-local");
 const pv=field("媒体側PV（不明なら空欄）","number","—");
 const clicks=field("リンククリック数（不明なら空欄）","number","—");
 const conversions=field("問い合わせ・応募・申込数（不明なら空欄）","number","—");
 for(const box of [pv,clicks,conversions]){box.min="0";box.max="1000000000";box.step="1";}
 const note=h("p","mpr-dialog-sub","数値は手入力です。未入力は0ではなく「—」と表示します。UTM付きリンクは計測先の設定が必要です。");
 form.append(note);
 const landing=item.payload?.draft?.url||"";
 if(landing&&window.navigator?.clipboard?.writeText){
  try{
   const candidate=new URL(landing);
   if(candidate.protocol==="https:"&&!candidate.username&&!candidate.password){
    const linkButton=h("button","mpr-secondary","このPRの計測用URLをコピー");
    linkButton.type="button";linkButton.onclick=async()=>{
     const url=new URL(landing);
     url.searchParams.set("utm_source",select.value);
     url.searchParams.set("utm_medium","pr");
     url.searchParams.set("utm_campaign","marketing_pr");
     url.searchParams.set("utm_content",item.id);
     try{await navigator.clipboard.writeText(url.toString());note.textContent="UTM付きURLをコピーしました。自社側のアクセス解析・フォーム連携が必要です。";}
     catch{error.textContent="URLをコピーできませんでした。ブラウザ権限を確認してください。";}
    };
    form.append(linkButton);
   }
  }catch{}
 }
 const error=h("p","mpr-error");error.setAttribute("role","alert");form.append(error);
 const actions=h("div","mpr-dialog-actions");
 const saveBtn=h("button","mpr-primary","記録を保存");saveBtn.type="submit";
 const clearBtn=h("button","mpr-secondary","この媒体の記録を解除");clearBtn.type="button";
 actions.append(clearBtn,saveBtn);form.append(actions);shell.modal.append(form);
 const use=(record)=>{
  status.value=record?.status||"planned";url.value=record?.url||"";
  if(record?.publishedAt){
   const d=new Date(record.publishedAt),pad=n=>String(n).padStart(2,"0");
   when.value=Number.isNaN(d.getTime())?"":d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+"T"+pad(d.getHours())+":"+pad(d.getMinutes());
  }else when.value="";
  for(const [box,key] of [[pv,"views"],[clicks,"clicks"],[conversions,"conversions"]]){
   box.value=Number.isSafeInteger(record?.[key])?String(record[key]):"";
  }
 };
 const getRecord=()=>trackingOf(item).find(x=>x.channel===select.value);
 select.onchange=()=>use(getRecord());use(getRecord());
 async function persist(remove=false){
  if(state.busy)return;
  if(state.dirty&&state.id===item.id){error.textContent="編集中の原稿を先に保存してください。";return;}
  const entries=trackingOf(item).filter(x=>x.channel!==select.value).map(x=>({...x}));
  if(!remove){
   if(status.value==="published"&&!url.value.trim()){error.textContent="配信済みとして記録する場合は掲載URLを入力してください。";return;}
   const metrics={};
   for(const [box,key] of [[pv,"views"],[clicks,"clicks"],[conversions,"conversions"]]){
    if(box.value!==""&&(!Number.isSafeInteger(Number(box.value))||Number(box.value)<0||Number(box.value)>1e9)){
     error.textContent="実績は0以上の整数で入力してください。";return;
    }
    metrics[key]=box.value===""?null:Number(box.value);
   }
   entries.push({channel:select.value,status:status.value,url:url.value.trim(),
    publishedAt:when.value?new Date(when.value).toISOString():"",...metrics});
  }
  state.busy=true;saveBtn.disabled=true;clearBtn.disabled=true;error.textContent="";
  let saved=false;
  try{
   const data=await API.api("/api/marketing/pr-drafts",{method:"POST",body:{
    action:"tracking",id:item.id,version:item.version,tracking:entries
   }});
   rememberSaved(data.item);item=data.item;
   if(state.id===item.id&&!state.dirty){state.version=item.version;state.tracking=JSON.parse(JSON.stringify(trackingOf(item)));}
   state.notice="掲載先・手入力実績を更新しました。";saved=true;
   closePRDialog(shell.backdrop,shell.escListener);
  }catch(err){error.textContent=err?.body?.hint||err?.hint||err?.message||"保存できませんでした。再読込してください。";}
  finally{state.busy=false;saveBtn.disabled=false;clearBtn.disabled=false;if(saved)render();}
 }
 form.onsubmit=e=>{e.preventDefault();persist(false);};
 clearBtn.onclick=()=>{if(window.confirm("この媒体の手入力記録を解除しますか？"))persist(true);};
}
async function deleteSaved(){
 const candidates=state.items.filter(x=>selectedSaved.has(x.id));
 if(!candidates.length)return;
 if(candidates.some(x=>x.status!=="draft")){window.alert("社内本登録済みの原稿は削除できません。下書きのみ選択してください。");return;}
 if(!window.confirm(candidates.length+"件の下書きを削除しますか？この操作は元に戻せません。"))return;
 state.busy=true;renderSavedList();let deleted=0,failed=0;
 for(const item of candidates){
  try{
   await API.api("/api/marketing/pr-drafts",{method:"POST",body:{action:"delete",id:item.id,version:item.version,confirmed:true}});
   state.items=state.items.filter(x=>x.id!==item.id);selectedSaved.delete(item.id);deleted++;
   if(state.id===item.id)Object.assign(state,{id:null,version:null,stage:"edit",draft:init(),bodyOverride:"",tracking:[],registeredAt:null,savedSignature:null,dirty:false});
  }catch{failed++;}
 }
 state.busy=false;state.notice=deleted+"件削除しました。"+(failed?failed+"件は更新競合などで削除できませんでした。":"");
 render();
}


function renderSavedList(){
 if(!savedRoot)return;
 savedRoot.replaceChildren();
 const tabs=h("nav","mpr-workspace-tabs");tabs.setAttribute("aria-label","PR管理");
 const listTab=h("button","mpr-workspace-tab active","一覧");listTab.type="button";listTab.setAttribute("aria-current","page");
 const uploadTab=h("button","mpr-workspace-tab","アップロード");uploadTab.type="button";
 uploadTab.onclick=()=>newPR("upload");
 const newTab=h("button","mpr-workspace-tab","新規作成");newTab.type="button";newTab.onclick=()=>newPR("create");
 tabs.append(listTab,uploadTab,newTab);savedRoot.append(tabs);
 const heading=h("div","mpr-workspace-heading");
 heading.append(h("h3","","PR原稿一覧"),h("p","mk-note","日時・配信先・反響をまとめて確認。行をクリックするとプレビューを表示します。"));
 savedRoot.append(heading);
 if(!state.apiChecked){savedRoot.append(h("p","mk-state","PR原稿を読み込み中…"));return;}
 if(!state.ready){savedRoot.append(h("p","mk-state","PR原稿を取得できません。接続・権限を確認してください（0件ではありません）。"));return;}
 const data=state.items.filter(item=>inSavedPeriod(item,savedPeriod));
 const periodTools=h("div","mpr-period-tools");
 const periodSelect=h("select");periodSelect.setAttribute("aria-label","PR原稿の集計期間");
 for(const [key,label] of [["7","直近7日"],["30","直近30日"],["90","直近90日"],["all","全期間（取得範囲）"]]){
  const opt=h("option","",label);opt.value=key;periodSelect.append(opt);
 }
 periodSelect.value=savedPeriod;
 periodSelect.onchange=()=>{savedPeriod=periodSelect.value;savedPage=1;selectedSaved.clear();renderSavedList();};
 periodTools.append(h("span","","原稿の更新期間"),periodSelect);savedRoot.append(periodTools);
 const kpis=h("div","mpr-metric-summary");
 for(const [label,key] of [["媒体PV","views"],["リンククリック","clicks"],["問い合わせ・応募","conversions"]]){
  const card=h("div","mpr-metric-card");card.append(h("small","",label),h("strong","",totalMetric(data,key)));
  kpis.append(card);
 }
 const cv=h("div","mpr-metric-card"),pairs=data.flatMap(item=>trackingOf(item)).filter(x=>x.status==="published"&&x.clicks!==null&&Number.isSafeInteger(x.clicks)&&x.conversions!==null&&Number.isSafeInteger(x.conversions));
 const clickSum=pairs.reduce((n,x)=>n+x.clicks,0),convSum=pairs.reduce((n,x)=>n+x.conversions,0);
 cv.append(h("small","","CV率（計測組のみ）"),h("strong","",clickSum?(100*convSum/clickSum).toFixed(1)+"%":"—"));kpis.append(cv);
 savedRoot.append(kpis);
 savedRoot.append(h("p","mpr-measure-caption","対象期間に更新された原稿の累計手入力値です（アクセス発生日の期間集計ではありません）。未入力は「—」。外部媒体の自動計測は未接続です。"));
 const tools=h("div","mpr-selection-tools"),select=h("select");
 for(const [key,label] of [["all","すべて"],["draft","下書き"],["registered","社内本登録済み"]]){
  const opt=h("option","",label);opt.value=key;select.append(opt);
 }
 select.setAttribute("aria-label","PRの状態");select.value=savedFilter;select.onchange=()=>{savedFilter=select.value;savedPage=1;renderSavedList();};
 tools.append(select);
 const edit=action("選択して更新","of-btn sec",()=>{
  const item=data.find(x=>selectedSaved.has(x.id));
  if(item?.status==="draft"){
   if(state.dirty&&state.id!==item.id){window.alert("編集中の原稿を先に保存してください。");return;}
   openSaved(item);onSavedOpen?.("edit");
  }else if(item)openPRTracking(item,"site");
 },selectedSaved.size!==1||state.busy);
 const remove=action("選択した下書きを削除","of-btn sec",deleteSaved,!selectedSaved.size||state.busy);
 tools.append(edit,remove);savedRoot.append(tools);
 const rows=data.filter(item=>savedFilter==="all"||item.status===savedFilter);
 const pageCount=Math.max(1,Math.ceil(rows.length/20));savedPage=Math.min(savedPage,pageCount);
 const visible=rows.slice((savedPage-1)*20,savedPage*20);
 const info=h("div","mpr-list-scope");
 info.append(h("span","",rows.length+"件（API取得上限40件）"));
 const all=h("label","mpr-all-select");const allInput=h("input");allInput.type="checkbox";
 allInput.checked=visible.length>0&&visible.every(x=>selectedSaved.has(x.id));
 allInput.onchange=()=>{for(const x of visible)allInput.checked?selectedSaved.add(x.id):selectedSaved.delete(x.id);renderSavedList();};
 all.append(allInput,h("span","","表示中を全選択"));info.append(all);savedRoot.append(info);
 if(!rows.length)savedRoot.append(h("p","mk-state","この条件に該当するPR原稿はありません。"));
 for(const item of visible){
  const row=h("div","mpr-pr-row");
  const publishedDates=trackingOf(item).filter(x=>x.status==="published"&&x.publishedAt&&Number.isFinite(Date.parse(x.publishedAt))).map(x=>x.publishedAt);
  const lastPublished=publishedDates.length?publishedDates.sort((a,b)=>Date.parse(b)-Date.parse(a))[0]:null;
  const dateValue=lastPublished||(item.status==="registered"?item.registeredAt||item.updatedAt:item.updatedAt);
  const dateGroup=h("div","mpr-date-group"),date=h("time","mpr-pr-datetime",formatWhen(dateValue));
  date.dateTime=dateValue||"";
  dateGroup.append(date,h("small","",lastPublished?"最終配信":item.status==="registered"?"社内登録":"最終更新"));
  const checkbox=h("input");checkbox.type="checkbox";checkbox.checked=selectedSaved.has(item.id);
  checkbox.setAttribute("aria-label",(item.payload?.draft?.title||"無題")+"を選択");
  checkbox.onchange=()=>{checkbox.checked?selectedSaved.add(item.id):selectedSaved.delete(item.id);renderSavedList();};
  const title=h("button","mpr-pr-title",item.payload?.draft?.title||"無題");title.type="button";
  title.title="クリックしてプレビュー";title.onclick=()=>openPRPreview(item);
  const text=h("div","mpr-pr-text");
  text.append(title,h("small","",item.status==="registered"?"社内本登録済み（外部公開ではありません）":"下書き"));
  const channels=h("div","mpr-pr-channels");
  channels.setAttribute("aria-label","配信先（クリックで記録）");
  for(const [key,label,icon] of CHANNELS){
   const record=trackingOf(item).find(x=>x.channel===key);
   const button=h("button","mpr-channel "+(record?.status==="published"?"published":record?.status==="scheduled"?"scheduled":"unpublished"));
   button.type="button";button.title=label+"："+(record?.status==="published"?"配信済み（手入力）":record?.status==="scheduled"?"予約・予定":"未配信・未記録");
   button.setAttribute("aria-label",button.title);
   const glyph=h("span","material-symbols-outlined",icon);glyph.setAttribute("aria-hidden","true");
   button.append(glyph);button.onclick=()=>openPRTracking(item,key);
   channels.append(button);
  }
  const stats=h("div","mpr-pr-stats");
  for(const [label,key] of [["PV","views"],["クリック","clicks"],["反響","conversions"]]){
   const stat=h("span","mpr-pr-stat");
   stat.append(h("small","",label),h("b","",totalMetric([item],key)));stats.append(stat);
  }
  row.append(checkbox,dateGroup,text,channels,stats);
  row.onclick=e=>{if(!e.target.closest("button,input,a,select"))openPRPreview(item);};
  savedRoot.append(row);
 }
 if(state.dirty)savedRoot.append(h("p","mk-note","編集中の原稿を保存すると、別の原稿を編集できます。"));
 if(pageCount>1){
  const nav=h("nav","mkt-list-pagination");nav.setAttribute("aria-label","社内PR原稿のページ");
  nav.append(action("前へ","of-btn sec",()=>{savedPage--;renderSavedList();},savedPage===1),
   h("span","",savedPage+" / "+pageCount+"ページ"),
   action("次へ","of-btn sec",()=>{savedPage++;renderSavedList();},savedPage===pageCount));savedRoot.append(nav);
 }
 savedRoot.append(action("PR原稿を再読込","of-btn sec",()=>load()));
}

function render(){
 window.MarketingImagePreview?.current(state.draft.images);
 renderSavedList();
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
 mountSavedList(el,onOpen){savedRoot=el;onSavedOpen=onOpen;renderSavedList();},
 newPR,openPRPreview,openSavedById(id){const item=state.items.find(x=>x.id===id);if(item){openSaved(item);return true;}return false;},
 reload(){if(!state.busy)return load();},
 snapshot(){return {tab:state.tab,stage:state.stage,id:state.id,version:state.version,ready:state.ready};},
 buildDraft:plain,missing:()=>R.missing(state.draft),
 // Only for synthetic UI tests, not a service action.
 __test:{check}
};
})();
