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
let root,distribution,analysis,openEditor,onSelectDistribution;
const landingById=new Map();
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
  window.location.assign(r.url);
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
 button("拡散する",()=>{
   if(selected.length!==1)return;
   state.distId=selected[0].id;
   state.selected=new Set([selected[0].id]);
   clearError();
   onSelectDistribution?.();
   render();
 },"of-btn mps-to-distribution",selected.length!==1),
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
const secureHttps=value=>{
 try{
  const u=new URL(value);
  return u.protocol==="https:"&&!u.username&&!u.password&&u.href.length<=1900?u:null;
 }catch{return null;}
};
const formatPost=(item,url)=>{
 const title=titleOf(item),intro=String(item.payload?.draft?.summary||"").trim().slice(0,130);
 return [title,intro,url||""].filter(Boolean).join("\n");
};
function trackedUrl(item,channel,rawUrl){
 const url=secureHttps(rawUrl);
 if(!url)return null;
 const out=new URL(url);
 out.searchParams.set("utm_source",channel);
 out.searchParams.set("utm_medium","pr");
 out.searchParams.set("utm_campaign","marketing_pr");
 out.searchParams.set("utm_content",item.id);
 return out.toString();
}
function renderDistribution(){
 if(!distribution)return;
 distribution.replaceChildren();
 const head=h("div","mps-head");
 head.append(h("h2","","拡散する"),
  h("p","","対象PRを選んで媒体をチェック。投稿文を用意し、公開後に掲載URLを記録します。"));
 distribution.append(head);
 const items=validatedItems();
 if(!items.length){distribution.append(h("p","mps-empty","PR原稿がありません。先にアップロードしてください。"));return;}
 const select=h("select","mps-select");
 select.setAttribute("aria-label","拡散したPRを選択");
 for(const item of items){const o=h("option","",titleOf(item));o.value=item.id;select.append(o);}
 if(!items.some(x=>x.id===state.distId))state.distId=items[0].id;
 select.value=state.distId;
 select.onchange=()=>{state.distId=select.value;clearError();renderDistribution();};
 distribution.append(select);
 const item=items.find(x=>x.id===state.distId);
 const records=Array.isArray(item.payload?.tracking)?item.payload.tracking:[];
 const landingWrap=h("label","mps-landing-label");
 landingWrap.append(h("span","","投稿から誘導する記事・LPのURL（任意）"));
 const landing=h("input","mps-url-input");
 landing.type="url";landing.placeholder="https://example.jp/news/...";
 landing.maxLength=1800;landing.value=landingById.get(item.id)??(item.payload?.draft?.url||records.find(x=>x.channel==="site")?.url||"");
 landing.oninput=()=>landingById.set(item.id,landing.value);
 landingWrap.append(landing);
 distribution.append(landingWrap);
 distribution.append(h("p","mps-muted","URLがあれば媒体別UTMを付けて投稿します。アップロードしたWord・PDFは公開されません。"));
 const grid=h("div","mps-channel-editor-grid");
 const entries=[];
 const showActionStatus=message=>{
  status.textContent=message;
 };
 const status=h("p","mps-notice");
 status.setAttribute("role","status");
 for(const [id,label,icon] of CHANNELS){
  const record=records.find(x=>x.channel===id);
  const card=h("section","mps-channel-editor");
  const checkLabel=h("label","mps-channel-editor-head");
  const checkbox=h("input");checkbox.type="checkbox";
  checkbox.checked=record?.status==="published"||record?.status==="scheduled"||record?.status==="planned";
  checkbox.disabled=state.busy;
  const glyph=h("span","material-symbols-outlined",icon);
  glyph.setAttribute("aria-hidden","true");
  const name=h("strong","",label);
  const badge=h("small","mps-channel-badge",
    record?.status==="published"&&record.url?"掲載記録あり":checkbox.checked?"拡散予定":"未選択");
  checkLabel.append(checkbox,glyph,name,badge);
  card.append(checkLabel);
  const detail=h("div","mps-channel-detail");
  detail.hidden=!checkbox.checked;
  checkbox.onchange=()=>{
   detail.hidden=!checkbox.checked;
   badge.textContent=checkbox.checked?"拡散予定":"未選択";
  };
  const urlLabel=h("label","mps-channel-field");
  urlLabel.append(h("span","","投稿・掲載したページのURL"));
  const postedUrl=h("input","mps-url-input");
  postedUrl.type="url";postedUrl.maxLength=1800;
  postedUrl.placeholder="公開後に https:// から入力";
  postedUrl.value=record?.url||"";
  postedUrl.setAttribute("aria-label",label+"の掲載URL");
  urlLabel.append(postedUrl);detail.append(urlLabel);
  const dateLabel=h("label","mps-channel-field");
  dateLabel.append(h("span","","配信日時（任意）"));
  const publishedAt=h("input","mps-url-input");publishedAt.type="datetime-local";
  if(record?.publishedAt&&Number.isFinite(Date.parse(record.publishedAt))){
   const d=new Date(record.publishedAt),pad=n=>String(n).padStart(2,"0");
   publishedAt.value=d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())+"T"+pad(d.getHours())+":"+pad(d.getMinutes());
  }
  publishedAt.setAttribute("aria-label",label+"の配信日時");
  dateLabel.append(publishedAt);detail.append(dateLabel);
  const metrics=h("div","mps-channel-metrics");
  const fields={};
  for(const [key,labelText] of [["views","閲覧数"],["clicks","リンククリック"],["conversions","問い合わせ・応募"]]){
   const row=h("label","mps-metric-field"),input=h("input","mps-url-input");
   input.type="number";input.min="0";input.max="1000000000";input.step="1";
   input.placeholder="未計測";input.value=Number.isSafeInteger(record?.[key])?String(record[key]):"";
   input.setAttribute("aria-label",label+"の"+labelText);
   row.append(h("span","",labelText),input);metrics.append(row);fields[key]=input;
  }
  detail.append(metrics);
  const actions=h("div","mps-post-actions");
  const compose=button("投稿文をコピー",async()=>{
   const target=landing.value.trim();
   if(target&&!secureHttps(target)){showActionStatus("誘導先URLはhttps://形式で入力してください。");return;}
   const text=formatPost(item,trackedUrl(item,id,target));
   if(!navigator.clipboard?.writeText){showActionStatus("コピー機能を使えません。原稿タイトルを選択してコピーしてください。");return;}
   try{await navigator.clipboard.writeText(text);showActionStatus(label+"用の投稿文をコピーしました。");}
   catch{showActionStatus("クリップボードへのコピーが許可されていません。");}
  },"of-btn sec");
  actions.append(compose);
  if(["x","facebook","linkedin","line"].includes(id)){
   const official=button("投稿画面を開く",()=>{
    const target=landing.value.trim();
    if(target&&!secureHttps(target)){showActionStatus("誘導先URLはhttps://形式で入力してください。");return;}
    const link=trackedUrl(item,id,target);
    let url;
    if(id==="x"){
     url=new URL("https://x.com/intent/tweet");
     url.searchParams.set("text",formatPost(item,null));
     if(link)url.searchParams.set("url",link);
    }else if(id==="facebook"){
     if(!link){showActionStatus("Facebookの共有には誘導先URLが必要です。");return;}
     url=new URL("https://www.facebook.com/sharer/sharer.php");
     url.searchParams.set("u",link);
    }else if(id==="linkedin"){
     if(!link){showActionStatus("LinkedInの共有には誘導先URLが必要です。");return;}
     url=new URL("https://www.linkedin.com/sharing/share-offsite/");
     url.searchParams.set("url",link);
    }else{
     if(!link){showActionStatus("LINEの共有には誘導先URLが必要です。");return;}
     url=new URL("https://social-plugins.line.me/lineit/share");
     url.searchParams.set("url",link);
    }
    // Opens the official composer only. It cannot confirm an actual publication.
    window.open(url.toString(),"_blank","noopener,noreferrer");
    showActionStatus(label+"の公式画面を開きました。投稿後に掲載URLを記録してください。");
   },"of-btn sec");
   actions.append(official);
  }
  detail.append(actions);
  card.append(detail);grid.append(card);
  entries.push({id,label,checkbox,postedUrl,publishedAt,fields,record});
 }
 distribution.append(grid);
 distribution.append(h("p","mps-muted","チェック＝拡散予定。掲載URLを保存した媒体だけが掲載記録ありになります。実際の公開は各媒体で行ってください。"));
 const save=button("拡散先を保存",async()=>{
  const target=landing.value.trim();
  if(target&&!secureHttps(target)){showActionStatus("誘導先URLはhttps://形式で入力してください。");return;}
  const updated=[];
  for(const e of entries){
   if(!e.checkbox.checked)continue;
   const url=e.postedUrl.value.trim();
   if(url&&!secureHttps(url)){showActionStatus(e.label+"の掲載URLをhttps://で入力してください。");e.postedUrl.focus();return;}
   const values={};
   for(const [k,field]of Object.entries(e.fields)){
    if(field.value===""){values[k]=null;continue;}
    const n=Number(field.value);
    if(!Number.isSafeInteger(n)||n<0||n>1_000_000_000){
     showActionStatus(e.label+"の実績は0以上の整数で入力してください。");field.focus();return;
    }
    values[k]=n;
   }
   const at=e.publishedAt.value?new Date(e.publishedAt.value):null;
   if(at&&Number.isNaN(at.getTime())){showActionStatus("配信日時が正しくありません。");return;}
   updated.push({
    channel:e.id,status:url?"published":"planned",url,
    publishedAt:at?at.toISOString():url?e.record?.publishedAt||new Date().toISOString():"",
    ...values
   });
  }
  const previous=item.payload?.tracking||[];
  const removedPublished=previous.filter(x=>x.status==="published"&&!updated.some(y=>y.channel===x.channel));
  if(removedPublished.length&&!window.confirm("掲載済みの媒体チェックを外しています。記録を削除しますか？"))return;
  state.busy=true;clearError();renderDistribution();
  try{
   await api("/api/marketing/pr-drafts",{action:"tracking",id:item.id,version:item.version,tracking:updated});
   await refresh();
   state.notice="拡散先・掲載URL・実績を保存しました。公開の自動実行はしていません。";
  }catch(err){state.error=err?.body?.hint||"拡散記録を保存できませんでした。再読み込みしてください。";}
  finally{state.busy=false;render();}
 },"of-btn");
 distribution.append(save,status);
 distribution.append(h("p","mps-muted","媒体の閲覧数・クリックは手入力データです。GA4・SNS等の自動取得は未連携で、未計測は0として扱いません。"));
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
 mount({createRoot,distributionRoot,analysisRoot,onOpenEditor,onOpenDistribution}){
  root=createRoot;distribution=distributionRoot;analysis=analysisRoot;
  openEditor=onOpenEditor;onSelectDistribution=onOpenDistribution;
  render();refresh();
  document.addEventListener("marketing:pr-updated",()=>refresh());
 },refresh
};
})();