// Inline corporate-number verification. No modal, no redundant actions.
// The 13th digit triggers a server-side lookup with a small debounce.
// Official data is never saved without a single, explicit staff confirmation.
const VALID=/^[0-9]{13}$/;
const $=id=>document.getElementById(id);
export function createInlineCorporateLookup({companyId,onSaved}={}){
 let generation=0,timer=null,disposed=false,pending=null,busy=false,registeredNumber="",companyName="";
 const input=$("lc-corporate-number"),state=$("lc-corp-state"),result=$("lc-corp-result"),search=$("lc-corp-search");
 const spinner=$("lc-corp-spin"),apply=$("lc-corp-apply"),link=$("lc-corp-official-link");
 const confirmations=$("lc-corp-confirmations"),manual=$("lc-corp-manual"),different=$("lc-corp-mismatch");
 const safe=()=>!disposed&&input?.isConnected&&$("lc-dialog")?.open;
 const text=(value)=>{if(state)state.textContent=value||"";};
 const loading=value=>{busy=value;if(spinner)spinner.hidden=!value;
   if(search){search.disabled=value||!VALID.test(input.value.trim());search.textContent=value?"照合中…":"検索";}
   if(apply)apply.disabled=value||!pending;};
 const make=(tag,content,cls="")=>{const n=document.createElement(tag);n.textContent=String(content??"");
   if(cls)n.className=cls;return n;};
 function reset(){
   pending=null;confirmations.hidden=true;manual.checked=false;different.checked=false;
   result.replaceChildren();apply.hidden=true;link.hidden=true;loading(false);
 }
 function sourceLink(number,url){
   const isNta=/^https:\/\/www\.houjin-bangou\.nta\.go\.jp\//.test(url||"");
   link.textContent=isNta?"国税庁の公表サイトで確認":"gBizINFOで確認";
   link.href=isNta?url:
     url&&/^https:\/\/info\.gbiz\.go\.jp\//.test(url)?url:
       "https://info.gbiz.go.jp/hojin/ichiran?hojinBango="+encodeURIComponent(number);
   link.hidden=false;
 }
 function showNameSearch(){
   if(!companyName)return;
   const q='site:info.gbiz.go.jp/hojin/ichiran "'+companyName.slice(0,120)+'"';
   link.href="https://www.google.com/search?"+new URLSearchParams({q});
   link.textContent="法人番号を調べる";
   link.hidden=false;
 }
 function show(p){
   pending=p;
   const isSaved=p.current?.corporateNumber===p.number;
   sourceLink(p.number,p.profileUrl);
   result.replaceChildren();
   if(p.verified){
     const row=make("div","","lc-corp-verified");
     row.append(make("strong",p.official?.name||"法人名を確認"),make("small",p.official?.address||"所在地は未取得"));
     result.append(row);
     if(p.source==="nta_v4"){
       result.append(make("small",
         "取得元：国税庁法人番号システム Web-API。取得データを利用した本サービスの内容は国税庁による保証ではありません。",
         "lc-corp-muted"));
     }
     const fields=Object.keys(p.patch||{});
     text((p.source==="nta_v4"?"国税庁":"gBizINFO")+"照合済み"+(fields.length?"・基本情報"+fields.length+"項目を補完できます":"・企業基本情報は登録済み"));
     if(p.differentName){
       confirmations.hidden=false;
       $("lc-corp-mismatch-line").hidden=false;
       $("lc-corp-manual-line").hidden=true;
     }
     if(fields.length||!isSaved){
       apply.hidden=false;apply.textContent="この情報を反映";
     }
   }else{
     text(isSaved?"法人番号は登録済み（APIの基本情報は未取得）":"APIで確認できませんでした");
     result.append(make("small",isSaved?
       "公的な基本情報を取得できませんでした。必要に応じて公式サイトで確認してください。":
       "公式サイトで法人番号と会社名を確認した場合だけ登録できます。","lc-corp-muted"));
     const diagnostics=p.diagnostics||{};
     if(diagnostics.tokenConfigured){
       const attempts=(diagnostics.attempts||[]).map(x=>
         x.version+"：HTTP "+(x.httpStatus??"接続不可")+
         (x.error?" ("+x.error+")":"")+
         (x.normalizedRecords?"／解析 "+x.normalizedRecords+"件":"")).join(" ／ ");
       result.append(make("small",attempts||"公式APIの応答を確認できませんでした。","lc-corp-muted"));
     }else{
       result.append(make("small","APIトークン未設定","lc-corp-muted"));
     }
     if(!isSaved){
       confirmations.hidden=false;
       $("lc-corp-mismatch-line").hidden=true;
       $("lc-corp-manual-line").hidden=false;
       apply.hidden=false;
       apply.textContent="確認した番号を保存";
     }
   }
   apply.disabled=busy;
 }
 async function verify(number){
   if(!safe()||!VALID.test(number))return;
   const n=++generation;reset();loading(true);text("公的法人情報を照合中…");
   try{
     const p=await API.api("/api/sales/company-official",{method:"POST",
       body:{companyId,action:"preview",corporateNumber:number,overwrite:false}});
     if(!safe()||n!==generation||input.value.trim()!==number)return;
     show(p);
   }catch(e){
     if(!safe()||n!==generation)return;
     text("公式情報を取得できませんでした");
     result.append(make("small",e?.hint||"通信状態を確認し、再度番号を入力してください。","lc-corp-muted"));
     sourceLink(number);
   }finally{if(safe()&&n===generation)loading(false);}
 }
 function changed(){
   const number=input.value.trim().replace(/[^0-9]/g,"").slice(0,13);
   if(input.value!==number)input.value=number;
   ++generation;clearTimeout(timer);reset();
   text(number.length===0?"法人番号を入力して「検索」を押してください":number.length<13?"13桁の法人番号を入力してください":"「検索」を押すと国税庁APIで照合します");
   search.disabled=!VALID.test(number);
   if(!VALID.test(number))showNameSearch();
 }
 function update(company){
   if(!safe())return;
   const number=String(company?.corporateNumber||"");
   registeredNumber=number;companyName=String(company?.name||"");
   input.value=number;
   ++generation;clearTimeout(timer);reset();
   if(VALID.test(number)){text("法人番号は登録済みです。「検索」を押すと公的基本情報を取得します");search.disabled=false;}
   else {text("法人番号を入力して「検索」を押してください");search.disabled=true;showNameSearch();}
 }
 async function save(){
   if(!pending||busy||!safe())return;
   const p=pending;
   if(p.differentName&&!different.checked){
     text("登録企業名と異なります。同一法人であることを確認してください。");return;
   }
   if(!p.verified&&!manual.checked){
     text("公式サイトで法人番号を確認してからチェックしてください。");return;
   }
   loading(true);text("基本情報を保存中…");
   apply.disabled=true;
   try{
     const saved=await API.api("/api/sales/company-official",{method:"POST",body:{
       action:"save",companyId,corporateNumber:p.number,
       expectedCorporateNumber:p.current?.corporateNumber||"",overwrite:false,
       previewDigest:p.digest,confirmed:true,
       manualConfirmed:manual.checked,allowDifferentName:different.checked,
       requestKey:crypto.randomUUID(),
     }});
     if(!safe())return;
     pending=null;loading(false);apply.hidden=true;confirmations.hidden=true;
     text(saved.verified?"公的情報を反映しました":"法人番号を保存しました");
     result.replaceChildren(make("small",saved.verified?
       "基本情報を最新の登録内容に更新しました。":"公式基本情報は未取得です。必要な項目は「企業情報を編集」から補完できます。","lc-corp-muted"));
     registeredNumber=saved.company?.corporateNumber||p.number;
     onSaved?.(saved);
   }catch(e){if(safe()){text(e?.hint||"保存できませんでした。再度照合してください。");loading(false);apply.disabled=false;}}
 }
 input.addEventListener("input",changed);
 search.addEventListener("click",()=>{clearTimeout(timer);if(VALID.test(input.value.trim()))void verify(input.value.trim());});
 input.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();clearTimeout(timer);
   const n=input.value.trim();if(VALID.test(n))void verify(n);}});
 apply.addEventListener("click",()=>void save());
 const removeListeners=()=>{disposed=true;clearTimeout(timer);generation++;};
 return {update,dispose:removeListeners,refresh:()=>{if(VALID.test(input.value))void verify(input.value)}};
}
