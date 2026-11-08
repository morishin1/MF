// Sales 企業詳細の「マッチング・提案」で商談日時・URLを保存し、Googleカレンダーの予定作成画面を開く。
// Google APIの認証情報は使わない。ユーザーがGoogleカレンダーで保存した場合のみ予定が追加される。
const e=(tag,value,cls)=>{
 const node=document.createElement(tag);
 if(value!==undefined&&value!==null)node.textContent=String(value);
 if(cls)node.className=cls;
 return node;
};
const toJstInput=iso=>iso?
  new Date(new Date(iso).getTime()+9*3600000).toISOString().slice(0,16):"";
const asIso=value=>{
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value||""))return null;
 const result=new Date(value+":00+09:00");
 return Number.isFinite(result.getTime())?result.toISOString():null;
};
const sameFields=(saved,values)=>Boolean(saved?.scheduledAt&&
 saved.scheduledAt===values.scheduledAt&&
 String(saved.meetingUrl||"")===String(values.meetingUrl||"")&&
 Number(saved.durationMin||30)===values.durationMin);
export function mountMeetingCalendar(host,{companyId}={}){
 if(!host||!companyId)return {dispose(){}};
 let disposed=false,busy=false,latest=null,calendarUrl=null,canSchedule=false,fromTimerex=false;
 const wrap=e("section",undefined,"lp-calendar-card");
 const head=e("div",undefined,"lp-calendar-heading");
 head.append(e("strong","商談日時・Googleカレンダー"),
  e("small","日時と商談URLを保存し、そのままカレンダーに登録できます"));
 const form=e("form",undefined,"lp-calendar-form");
 const datetimeLabel=e("label",undefined,"lp-calendar-field");
 datetimeLabel.append(e("span","商談日時（日本時間）"));
 const datetime=e("input");datetime.type="datetime-local";datetime.required=true;datetime.step="300";
 datetime.setAttribute("aria-label","商談開始日時");
 datetimeLabel.append(datetime);
 const minsLabel=e("label",undefined,"lp-calendar-field");
 minsLabel.append(e("span","所要時間"));
 const mins=e("select");mins.setAttribute("aria-label","商談の所要時間");
 for(const min of [30,45,60,90]){
  const opt=e("option",min+"分");opt.value=String(min);mins.append(opt);
 }
 minsLabel.append(mins);
 const urlLabel=e("label",undefined,"lp-calendar-field lp-calendar-field-wide");
 urlLabel.append(e("span","オンライン商談URL（Google Meet / Zoomなど）"));
 const url=e("input");url.type="url";url.maxLength=1200;url.placeholder="https://meet.google.com/...";
 url.setAttribute("aria-label","オンライン商談URL");
 urlLabel.append(url);
 form.append(datetimeLabel,minsLabel,urlLabel);
 const buttons=e("div",undefined,"lp-calendar-buttons");
 const save=e("button","日時・URLをSalesへ保存","lp-calendar-save");save.type="submit";
 const add=e("button","Googleカレンダーに追加","lp-calendar-add");add.type="button";
 buttons.append(save,add);
 form.append(buttons);
 const customer=e("p",undefined,"lp-calendar-customer");
 const message=e("p","商談予定を確認しています…","lp-calendar-message");
 message.setAttribute("role","status");message.setAttribute("aria-live","polite");
 const tip=e("small","Googleカレンダーを開いた後、予定の内容を確認して「保存」を押してください。自動同期ではありません。","lp-calendar-note");
 wrap.append(head,form,customer,message,tip);host.replaceChildren(wrap);

 function setMessage(value,bad=false){
  if(disposed)return;
  message.textContent=value;
  message.classList.toggle("error",Boolean(bad));
 }
 function refreshButtons(){
  save.disabled=busy||!canSchedule||fromTimerex;
  add.disabled=busy||(!canSchedule&&!calendarUrl);
 }
 function setData(data,fill=true){
  if(disposed)return;
  canSchedule=data.canSchedule!==false;
  latest=data.meeting||null;
  calendarUrl=data.calendarUrl||null;
  fromTimerex=Boolean(latest?.fromTimerex);
  if(fill){
   datetime.value=toJstInput(latest?.scheduledAt);
   mins.value=String([30,45,60,90].includes(Number(latest?.durationMin))?Number(latest.durationMin):30);
   url.value=latest?.meetingUrl||"";
  }
  for(const input of [datetime,mins,url])input.disabled=fromTimerex||!canSchedule;
  customer.replaceChildren();
  if(data.customerMeetingUrl&&/^https:\/\/enger\.jp\/business\/meeting\?companyId=/.test(data.customerMeetingUrl)){
   const label=e("span","企業用商談ページ（ログイン必須）: ");
   const link=e("a","ページを開く");
   link.href=data.customerMeetingUrl;link.target="_blank";link.rel="noopener noreferrer";
   customer.append(label,link);
  }
  refreshButtons();
  if(fromTimerex)setMessage("TimeRexで日時が確定しています。変更はTimeRexから行ってください。Googleカレンダーへの登録はできます。");
  else if(!canSchedule)setMessage("この企業は営業停止・終了済みのため、新たな商談予定を保存できません。",true);
  else if(latest?.scheduledAt)setMessage("商談予定はSalesに保存済みです。Googleカレンダーへ登録できます。");
  else setMessage("日時が決まったら入力し、Salesへの保存またはGoogleカレンダー追加を選んでください。");
 }
 async function call(path,opts){
  return window.API.api(path,opts||{});
 }
 const endpoint="/api/sales/company-meeting-calendar";
 async function load(){
  try{
   const data=await call(endpoint+"?"+new URLSearchParams({companyId}));
   setData(data);
  }catch(error){setMessage(error?.hint||error?.message||"商談予定を取得できませんでした。",true);save.disabled=true;add.disabled=true;}
 }
 function values(){
  if(!form.reportValidity())return null;
  const scheduledAt=asIso(datetime.value);
  if(!scheduledAt){setMessage("商談日時を正しく入力してください。",true);return null;}
  if(url.value.trim()&&!/^https:\/\//i.test(url.value.trim())){
   setMessage("オンライン商談URLは https:// から入力してください。",true);return null;
  }
  return {companyId,scheduledAt,meetingUrl:url.value.trim(),durationMin:Number(mins.value)};
 }
 async function persist(fields){
  const result=await call(endpoint,{method:"POST",body:fields});
  if(!result?.ok||!result.calendarUrl)throw Error("商談予定の保存結果を確認できませんでした");
  setData(result);
  return result.calendarUrl;
 }
 form.addEventListener("submit",async event=>{
  event.preventDefault();
  if(busy||fromTimerex)return;
  const v=values();if(!v)return;
  busy=true;refreshButtons();setMessage("Salesに商談日時を保存しています…");
  try{await persist(v);setMessage("Salesに日時とURLを保存しました。Googleカレンダーへ登録できます。");}
  catch(error){setMessage(error?.hint||error?.message||"保存できませんでした。",true);}
  finally{busy=false;refreshButtons();}
 });
 add.addEventListener("click",async()=>{
  if(busy)return;
  if(fromTimerex&&calendarUrl){
   window.open(calendarUrl,"_blank","noopener,noreferrer");return;
  }
  const v=values();if(!v)return;
  if(!canSchedule){setMessage("企業の状態を確認してください。",true);return;}
  const current=sameFields(latest,v)&&calendarUrl;
  if(current){
   window.open(calendarUrl,"_blank","noopener,noreferrer");return;
  }
  // クリック直後に空タブを確保してブラウザのポップアップブロックを回避する。
  const tab=window.open("about:blank","_blank");
  if(tab){tab.opener=null;tab.document.title="Googleカレンダーへの登録";tab.document.body.textContent="予定の保存準備をしています…";}
  busy=true;refreshButtons();setMessage("Salesに商談予定を保存しています…");
  try{
   const link=await persist(v);
   if(tab&&!tab.closed)tab.location.replace(link);
   else{
    const a=e("a","Googleカレンダーの予定作成画面を開く");
    a.href=link;a.target="_blank";a.rel="noopener noreferrer";
    message.replaceChildren(a);
   }
   if(tab)setMessage("Googleカレンダーを開きました。Google側でも「保存」を押してください。");
  }catch(error){
   if(tab&&!tab.closed)tab.close();
   setMessage(error?.hint||error?.message||"保存できませんでした。",true);
  }finally{busy=false;refreshButtons();}
 });
 // 商談開始ボタンから呼ぶ。日時が空欄ならそのまま進めるが、
 // 入力されているときは先にSalesへ保存し、未保存の日時を残さない。
 async function saveIfFilled(){
  if(disposed)throw Error("商談の日時設定画面が閉じられました。");
  if(fromTimerex)return calendarUrl;
  if(!datetime.value && !url.value.trim())return null;
  if(!datetime.value){
   setMessage("オンラインURLを保存する場合は商談日時も選択してください。",true);
   throw Error("商談日時を入力するか、URLを空欄にしてください。");
  }
  if(!canSchedule)throw Error("この企業には新しい商談日時を登録できません。");
  const fields=values();
  if(!fields)throw Error("商談日時・URLの入力内容を確認してください。");
  if(sameFields(latest,fields)&&calendarUrl)return calendarUrl;
  if(busy)throw Error("商談日時の保存中です。");
  busy=true;refreshButtons();setMessage("商談日時を保存しています…");
  try{
   const link=await persist(fields);
   setMessage("商談日時をSalesに保存しました。");
   return link;
  }catch(err){
   setMessage(err?.hint||err?.message||"商談日時を保存できませんでした。",true);
   throw err;
  }finally{busy=false;refreshButtons();}
 }
 void load();
 return {saveIfFilled,dispose(){disposed=true;host.replaceChildren();}};
}
