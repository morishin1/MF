// Compact Marketing workflow: PR upload/list -> manual distribution checkmarks -> existing analytics.
// Never automatically posts to external services or treats missing metrics as zero.
(function(){
"use strict";
const CHANNELS=[
 ["site","自社サイト","home"],["prtimes","PR TIMES","newspaper"],["x","X","alternate_email"],
 ["instagram","Instagram","photo_camera"],["facebook","Facebook","groups"],
 ["linkedin","LinkedIn","work"],["line","LINE","chat"],["other","その他","public"]
];
const h=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
const date=value=>{
 if(!value||!Number.isFinite(Date.parse(value)))return "—";
 return new Intl.DateTimeFormat("ja-JP",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(value));
};
const fmtNum=value=>value===null||value===undefined?"—":value.toLocaleString("ja-JP");
const metric=(items,key)=>{
 let total=0,seen=false;
 items.forEach(item=>(item.payload?.tracking||[]).forEach(x=>{
  if(x.status==="published"&&Number.isSafeInteger(x[key])){seen=true;total+=x[key];}
 }));
 return seen?total:null;
};
let state={items:[],files:new Map(),selected:new Set(),busy:false,ready:false,filesReady:false,
 error:"",notice:"",distId:""};
let root,distribution,analysis,openEditor;
const api=(path,body)=>window.API.api(path,body?{method:"POST",body}:undefined);
const fileFor=id=>state.files.get(id);
const validatedItems=()=>state.items.filter(item=>item.payload?.source!=="upload"||state.files.has(item.id));
const clearError=()=>{state.error="";state.notice="";};
const announce=(msg,error=false)=>{state[error?"error":"notice"]=msg;state[error?"notice":"error"]="";render();};
const busyButton=(button,flag)=>{button.disabled=flag;};
async function refresh(){
 try{
  const data=await api("/api/marketing/pr-drafts");
  state.ready=data?.ready===true;state.items=data.items||[];
  try{
   const files=await api("/api/marketing/pr-files");
   state.files=new Map((files.files||[]).map(x=>[x.prId,x]));state.filesReady=files.ready===true;
  }catch{state.filesReady=false;state.files=new Map();}
  state.selected=new Set([...state.selected].filter(id=>state.items.some(x=>x.id===id)));
 }catch(err){
  state.ready=false;state.error=err?.body?.hint||"原稿一覧の読み込みに失敗しました。";
 }finally{render();}
}
async function upload(file){
 if(state.busy)return;
 const ext=file.name.toLowerCase().split(".").pop();
 const mime={pdf:"application/pdf",docx:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}[ext];
 if(!mime||file.size<=0||file.size>8388608){announce("Word（.docx）かPDF（8MB以下）を選んでください。",true);return;}
 state.busy=true;clearError();render();
 try{
  const started=await api("/api/marketing/pr-files",{action:"start",filename:file.name,mimeType:mime,sizeBytes:file.size});
  const response=await fetch(started.uploadUrl,{method:"PUT",headers:{"content-type":mime},body:file});
  if(!response.ok)throw Error("ファイル転送に失敗しました（HTTP "+response.status+"）。");
  await api("/api/marketing/pr-files",{action:"complete",prId:started.prId});
  state.notice="アップロードしました。下の一覧に追加されました。";
  await refresh();
 }catch(err){
  state.error=err?.body?.hint||err?.message||"アップロードできませんでした。";
 }finally{state.busy=false;render();}
}
function button(label,fn,cls="mps-action",disabled=false){
 const b=h("button",cls,label);b.type="button";b.disabled=disabled||state.busy;b.onclick=fn;return b;
}
function titleOf(item){return item.payload?.draft?.title||"無題";}
function openDocument(item){
 const f=fileFor(item.id);
 if(!f){openEditor?.(item.id);return;}
 api("/api/marketing/pr-files?id="+encodeURIComponent(item.id)).then(r=>{
  if(!r?.url)throw Error("閲覧URLがありません");
  window.open(r.url,"_blank","noopener,noreferrer");
 }).catch(e=>announce(e?.body?.hint||e?.message||"ファイルを開けませんでした。",true));
}
function editItem(item){
 if(!item||item.status!=="draft"){announce("本登録済みの原稿は編集できません。",true);return;}
 if(!fileFor(item.id)){openEditor?.(item.id);return;}
 const next=window.prompt("PRタイトルを編集",titleOf(item));
 if(next===null)return;
 const title=next.trim();
 if(!title||title.length>120){announce("タイトルは1〜120文字で入力してください。",true);return;}
 state.busy=true;render();
 api("/api/marketing/pr-files",{action:"rename",prId:item.id,version:item.version,title})
 .then(()=>refresh()).then(()=>{state.notice="タイトルを更新しました。";})
 .catch(e=>{state.error=e?.body?.hint||"編集に失敗しました。再読込してください。";})
 .finally(()=>{state.busy=false;render();});
}
async function removeSelected(){
 const items=validatedItems().filter(x=>state.selected.has(x.id));
 if(!items.length)return;
 if(items.some(x=>x.status!=="draft")){announce("削除できるのは下書きだけです。",true);return;}
 if(!window.confirm(items.length+"件のPR下書きと添付ファイルを削除しますか？（元に戻せません）"))return;
 state.busy=true;clearError();render();
 let success=0,failed=0;
 for(const item of items){
  try{await api("/api/marketing/pr-drafts",{action:"delete",id:item.id,version:item.version,confirmed:true});success++;}
  catch{failed++;}
 }
 await refresh();
 state.busy=false;
 state.selected.clear();
 announce(success+"件削除しました。"+(failed?failed+"件は削除できませんでした。":""));
}
function renderCreate(){
 if(!root)return;root.replaceChildren();
 const head=h("div","mps-head");head.append(h("h2","","PRをつくる"),h("p","","Word・PDFをアップロードすると、下の一覧に追加されます。"));
 root.append(head);
 const uploadBox=h("div","mps-upload");
 const picker=h("input");picker.type="file";picker.accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
 picker.setAttribute("aria-label","Word・PDFをアップロード");picker.disabled=state.busy;
 picker.onchange=async()=>{if(picker.files?.[0])await upload(picker.files[0]);picker.value="";};
 uploadBox.append(h("span","material-symbols-outlined","upload_file"),h("strong","","Word・PDFをアップロード"),picker,h("small","","対応形式：.docx / .pdf　最大8MB。ファイルは社内の非公開保存先に保管します。"));
 const actions=h("div","mps-upload-actions");
 actions.append(button("原稿を手入力する",()=>openEditor?.(null),"of-btn sec"));
 uploadBox.append(actions);root.append(uploadBox);
 if(!state.filesReady)root.append(h("p","mps-warning","Word・PDFの保存先は未接続です。専用SQLと非公開Storageの準備が必要です。"));
 root.append(h("h3","mps-list-title","PR原稿一覧"));
 const tools=h("div","mps-list-actions");
 const selected=validatedItems().filter(x=>state.selected.has(x.id));
 const all=h("label","mps-select-all");const cb=h("input");cb.type="checkbox";
 cb.checked=validatedItems().length>0&&validatedItems().every(x=>state.selected.has(x.id));
 cb.onchange=()=>{for(const item of validatedItems())cb.checked?state.selected.add(item.id):state.selected.delete(item.id);render();};
 all.append(cb,h("span","","すべて選択"));tools.append(all);
 tools.append(button("編集",()=>editItem(selected[0]),"of-btn sec",selected.length!==1),
 button("削除",removeSelected,"of-btn sec",selected.length===0),
 button("更新",refresh,"of-btn sec"));
 root.append(tools);
 const table=h("div","mps-table");const labels=h("div","mps-th");
 for(const label of ["選択","アップロード／作成日時","PRタイトル","ファイル・状態"])labels.append(h("span","",label));
 table.append(labels);
 const items=validatedItems();
 if(!state.ready)table.append(h("p","mps-warning","PR一覧に接続できません。接続・権限を確認してください。"));
 else if(!items.length)table.append(h("p","mps-empty","まだPR原稿がありません。Word・PDFをアップロードしてください。"));
 for(const item of items){
  const row=h("div","mps-tr"),sel=h("input");sel.type="checkbox";sel.checked=state.selected.has(item.id);
  sel.setAttribute("aria-label",titleOf(item)+"を選択");
  sel.onchange=()=>{sel.checked?state.selected.add(item.id):state.selected.delete(item.id);render();};
  const f=fileFor(item.id),when=h("time","mps-date",date(f?.uploadedAt||item.createdAt));
  const text=button(titleOf(item),()=>openDocument(item),"mps-title");
  text.title=f?"原稿ファイルを開く":"PR編集画面を開く";
  const meta=h("div","mps-file-meta");
  meta.append(h("strong","",f?f.filename:item.status==="registered"?"社内本登録済み":"手入力下書き"));
  meta.append(h("small","",item.status==="draft"?"下書き":"本登録済み"));
  row.append(sel,when,text,meta);table.append(row);
 }
 root.append(table);
 if(state.error)root.append(h("p","mps-error",state.error));
 if(state.notice)root.append(h("p","mps-notice",state.notice));
}
function renderDistribution(){
 if(!distribution)return;distribution.replaceChildren();
 const head=h("div","mps-head");head.append(h("h2","","拡散する"),h("p","","PRを選び、掲載・投稿した媒体にチェックを入れて保存します。チェックは手動記録で、自動投稿ではありません。"));
 distribution.append(head);
 const items=validatedItems();
 if(!items.length){distribution.append(h("p","mps-empty","PR原稿がありません。先にアップロードしてください。"));return;}
 const select=h("select","mps-select");
 select.setAttribute("aria-label","拡散したPRを選択");
 for(const item of items){const o=h("option","",titleOf(item));o.value=item.id;select.append(o);}
 if(!items.some(x=>x.id===state.distId))state.distId=items[0].id;
 select.value=state.distId;select.onchange=()=>{state.distId=select.value;renderDistribution();};
 distribution.append(select);
 const item=items.find(x=>x.id===state.distId);
 const checked=new Set((item.payload?.tracking||[]).filter(x=>x.status==="published").map(x=>x.channel));
 const wrap=h("div","mps-channel-grid");
 const entries=[];
 for(const [id,label,icon] of CHANNELS){
  const row=h("label","mps-channel");const input=h("input");input.type="checkbox";input.checked=checked.has(id);input.disabled=state.busy;
  const glyph=h("span","material-symbols-outlined",icon);glyph.setAttribute("aria-hidden","true");
  row.append(input,glyph,h("b","",label));wrap.append(row);entries.push({id,input});
 }
 distribution.append(wrap);
 const save=button("拡散先を保存",async()=>{
  const original=item.payload?.tracking||[],now=new Date().toISOString();
  const updated=original.filter(x=>!CHANNELS.some(([key])=>key===x.channel)||entries.some(e=>e.id===x.channel&&e.input.checked))
   .map(x=>({...x}));
  for(const e of entries){
   if(!e.input.checked)continue;
   const existing=updated.find(x=>x.channel===e.id);
   if(existing){existing.status="published";existing.publishedAt=existing.publishedAt||now;}
   else updated.push({channel:e.id,status:"published",url:"",publishedAt:now,views:null,clicks:null,conversions:null});
  }
  state.busy=true;clearError();renderDistribution();
  try{
   await api("/api/marketing/pr-drafts",{action:"tracking",id:item.id,version:item.version,tracking:updated});
   await refresh();state.notice="拡散先を保存しました（手動記録）。";
  }catch(err){state.error=err?.body?.hint||"拡散先を保存できませんでした。再読み込みしてください。";}
  finally{state.busy=false;render();}
 },"of-btn");
 distribution.append(save);
 distribution.append(h("p","mps-muted","チェックした媒体への投稿は行いません。配信元の閲覧数・いいね等は、各媒体の分析データと連携するまで未計測です。"));
 if(state.error)distribution.append(h("p","mps-error",state.error));
 if(state.notice)distribution.append(h("p","mps-notice",state.notice));
}
function renderAnalysis(){
 if(!analysis)return;analysis.replaceChildren();
 const head=h("div","mps-head");head.append(h("h3","","PR別・媒体別の反響"),h("p","","記録済みのPV・クリック・問い合わせ数を媒体ごとに確認できます。自動取得は未接続です。"));
 analysis.append(head);
 const items=validatedItems();
 const stats=h("div","mps-channel-analysis");
 for(const [key,label,icon] of CHANNELS){
  const records=items.flatMap(x=>(x.payload?.tracking||[])).filter(x=>x.channel===key&&x.status==="published");
  if(!records.length)continue;
  const sum=k=>{let count=0,seen=false;for(const r of records)if(Number.isSafeInteger(r[k])){count+=r[k];seen=true;}return seen?count:null;};
  const row=h("div","mps-analytics-row");
  row.append(h("span","material-symbols-outlined",icon),h("b","",label));
  for(const [name,v] of [["PV",sum("views")],["クリック",sum("clicks")],["反響",sum("conversions")]]){
   const metricBox=h("div","mps-analysis-metric");metricBox.append(h("small","",name),h("strong","",fmtNum(v)));row.append(metricBox);
  }
  stats.append(row);
 }
 if(!stats.children.length)stats.append(h("p","mps-empty","媒体別の計測データはありません。拡散チェック後も、アクセス数の計測には媒体側のデータ連携が必要です。"));
 analysis.append(stats);
}
function render(){renderCreate();renderDistribution();renderAnalysis();}
window.MarketingPRSimple={
 mount({createRoot,distributionRoot,analysisRoot,onOpenEditor}){
  root=createRoot;distribution=distributionRoot;analysis=analysisRoot;openEditor=onOpenEditor;
  render();refresh();
  document.addEventListener("marketing:pr-updated",()=>refresh());
 },refresh
};
})();