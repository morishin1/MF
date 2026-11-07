// A single calm company profile: read-only by default, one edit mode, one atomic save.
import {COMPANY_FIELDS,profileBatch} from "../lib/sales-company-workbench.js";
import {safeWebsite,validEmail} from "../lib/sales-contact-preview.js";
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
export const MAIN_FIELDS=["name","address","industry","website","contactName","contactEmail","phone","status"];
export const EXTRA_FIELDS=["formUrl","note","isFavorite","isEndClient"];
const KEY_LIST=[...MAIN_FIELDS,...EXTRA_FIELDS];
function printValue(key,value){
 const meta=COMPANY_FIELDS[key];
 if(meta.type==="boolean")return value?(key==="isFavorite"?"注力企業":"あり"):"未設定";
 return value===null||value===undefined||value===""?"未登録":String(value);
}
function display(key,company){
 const meta=COMPANY_FIELDS[key],value=company[key];
 let shown=esc(printValue(key,value));
 if(key==="website"&&safeWebsite(value))
   shown='<a class="lc-link" href="'+esc(value)+'" target="_blank" rel="noopener noreferrer">'+shown+'</a>';
 if(key==="contactEmail"&&validEmail(value))
   shown='<a class="lc-link" href="mailto:'+esc(value)+'">'+shown+'</a>';
 return '<div class="lc-profile-field"><dt>'+esc(meta.label)+'</dt><dd>'+shown+'</dd></div>';
}
function editField(key,company){
 const meta=COMPANY_FIELDS[key],value=company[key];
 let input;
 if(meta.type==="boolean"){
   input='<select data-profile-key="'+key+'"><option value="false">いいえ</option><option value="true"'+(value?' selected':'')+'>はい</option></select>';
 }else if(meta.options){
   const other=value&&!meta.options.includes(value)?
     '<option value="'+esc(value)+'" selected>'+esc(value)+'（登録済み）</option>':'';
   input='<select data-profile-key="'+key+'"><option value="">未登録</option>'+other+
     meta.options.map(x=>'<option value="'+esc(x)+'"'+(x===value?' selected':'')+'>'+esc(x)+'</option>').join("")+'</select>';
 }else if(meta.type==="textarea"){
   input='<textarea data-profile-key="'+key+'" rows="3" maxlength="'+meta.max+'">'+esc(value||"")+'</textarea>';
 }else{
   input='<input data-profile-key="'+key+'" type="'+(meta.type||"text")+'" maxlength="'+(meta.max||100)+'" value="'+esc(value||"")+'"'+(meta.required?' required':'')+'>';
 }
 return '<label class="lc-profile-field"><span>'+esc(meta.label)+'</span>'+input+'</label>';
}
export function renderCompanyProfile(host,company,{companyId,onSaved}={}){
 if(!host)return;
 host.innerHTML=
  '<div class="lc-profile-head"><h3>企業情報</h3><button type="button" id="lc-profile-edit" class="lc-profile-edit">企業情報を編集</button></div>'+
  '<section id="lc-company-ai-summary" class="lc-company-ai-summary" aria-label="AI企業サマリー">'+
    '<div class="lc-company-ai-summary-head"><strong>企業サマリー</strong><small id="lc-company-ai-source">読み込み中…</small></div>'+
    '<p id="lc-company-ai-text" class="lc-company-ai-text">企業分析を確認しています…</p>'+
    '<details id="lc-company-ai-full" class="lc-company-ai-full" hidden><summary>サマリー全文を見る</summary><p id="lc-company-ai-full-text"></p></details>'+
    '<dl id="lc-company-ai-facts" class="lc-company-ai-facts"></dl>'+
    '<details id="lc-company-ai-sources" class="lc-company-ai-sources" hidden><summary>分析に使った公開情報</summary><div id="lc-company-ai-links"></div></details>'+
    '</section>'+
  '<div id="lc-profile-view"><dl class="lc-profile-grid">'+MAIN_FIELDS.map(k=>display(k,company)).join("")+'</dl>'+
    '<details class="lc-profile-more"><summary>その他の情報</summary><dl class="lc-profile-grid">'+
       EXTRA_FIELDS.map(k=>display(k,company)).join("")+'</dl></details></div>'+
  '<form id="lc-profile-form" hidden><div class="lc-profile-grid lc-profile-form-grid">'+
     MAIN_FIELDS.map(k=>editField(k,company)).join("")+'</div>'+
    '<details class="lc-profile-more"><summary>その他の項目を編集</summary><div class="lc-profile-grid lc-profile-form-grid">'+
      EXTRA_FIELDS.map(k=>editField(k,company)).join("")+'</div></details>'+
    '<div class="lc-profile-form-actions"><button type="submit" id="lc-profile-save" class="lc-primary">保存</button>'+
      '<button type="button" id="lc-profile-cancel">キャンセル</button></div>'+
    '<p id="lc-profile-save-status" role="status" aria-live="polite"></p></form>'+
  '<p id="lc-edit-status" role="status" aria-live="polite"></p>';
 const aiCard=host.querySelector("#lc-company-ai-summary");
 const aiText=host.querySelector("#lc-company-ai-text");
 const aiFacts=host.querySelector("#lc-company-ai-facts");
 const aiSource=host.querySelector("#lc-company-ai-source");
 void API.api("/api/sales/company-ai-summary?"+new URLSearchParams({companyId}))
   .then(result=>{
     if(!host.isConnected||host.querySelector("#lc-company-ai-summary")!==aiCard)return;
     const intel=result.companyIntelligence||{};
     const full=String(result.summary||"");
     aiText.textContent=full?full.slice(0,330)+(full.length>330?"…":""):
       "企業サマリーはまだありません。企業情報MDファイルから調査し、MDアップロードで登録できます。";
     const fullDetails=host.querySelector("#lc-company-ai-full");
     fullDetails.hidden=full.length<=330;
     host.querySelector("#lc-company-ai-full-text").textContent=full;
     aiSource.textContent=[result.source,result.approvedAt?String(result.approvedAt).slice(0,10):""].filter(Boolean).join(" ／ ");
     aiFacts.replaceChildren();
     const entries=[
       ["事業内容",intel.business_model],
       ["企業規模",intel.company_scale||company.employeeBand||""],
       ["関連人材",intel.talent_holdings],
       ["関連案件",intel.job_holdings],
       ["提案の方向性",intel.sales_priorities],
     ];
     for(const [label,value] of entries){
       if(!value)continue;
       const row=document.createElement("div");row.className="lc-company-ai-fact";
       const name=document.createElement("dt");name.textContent=label;
       const content=document.createElement("dd");content.textContent=String(value);
       row.append(name,content);aiFacts.append(row);
     }
     const sources=host.querySelector("#lc-company-ai-sources");
     const list=host.querySelector("#lc-company-ai-links");
     list.replaceChildren();
     for(const source of (intel.external_sources||[])){
       try{
         const parsed=new URL(source.url);
         if(parsed.protocol!=="https:")continue;
         const anchor=document.createElement("a");
         anchor.href=parsed.href;anchor.target="_blank";anchor.rel="noopener noreferrer";
         anchor.textContent=(source.title||parsed.hostname)+(source.checked_at?"（"+source.checked_at+"）":"");
         list.append(anchor);
       }catch{}
     }
     if(intel.research_note){
       const note=document.createElement("p");note.textContent=intel.research_note;list.append(note);
     }
     sources.hidden=!list.childNodes.length;
   })
   .catch(e=>{
     if(host.isConnected&&host.querySelector("#lc-company-ai-summary")===aiCard){
       aiText.textContent=e?.hint||"企業サマリーを取得できませんでした。";
       aiSource.textContent="取得エラー";
     }
   });
 const edit=host.querySelector("#lc-profile-edit");
 const form=host.querySelector("#lc-profile-form");
 const displayPane=host.querySelector("#lc-profile-view");
 const save=host.querySelector("#lc-profile-save");
 const status=host.querySelector("#lc-profile-save-status");
 const hint=host.querySelector("#lc-edit-status");
 let busy=false,pending=null;
 function toggle(show){
   form.hidden=!show;displayPane.hidden=show;
   edit.textContent=show?"編集を閉じる":"企業情報を編集";
   if(show)form.querySelector("input,select,textarea")?.focus();
 }
 edit.onclick=()=>{if(busy)return;toggle(form.hidden);};
 host.querySelector("#lc-profile-cancel").onclick=()=>{if(busy)return;toggle(false);hint.textContent="変更を破棄しました。";};
 form.onsubmit=async event=>{
   event.preventDefault();
   if(busy)return;
   const raw={},expected={};
   for(const key of KEY_LIST){
     const input=form.querySelector('[data-profile-key="'+key+'"]');
     if(!input)continue;
     const boolean=COMPANY_FIELDS[key].type==="boolean";
     const now=boolean?input.value==="true":input.value.trim();
     const old=boolean?Boolean(company[key]):String(company[key]??"").trim();
     if(now!==old){
       raw[key]=now;
       expected[key]=company.editSource&&Object.hasOwn(company.editSource,key)?
         company.editSource[key]:company[key]??null;
     }
   }
   if(!Object.keys(raw).length){toggle(false);hint.textContent="変更はありません。";return;}
   let patch;
   try{patch=profileBatch(raw);}catch(e){status.textContent=e.message;return;}
   const signature=JSON.stringify({patch,expected});
   if(!pending||pending.signature!==signature)pending={signature,key:crypto.randomUUID()};
   busy=true;save.disabled=true;edit.disabled=true;
   status.textContent="企業情報を保存中…";
   try{
     await API.api("/api/sales/company-workbench",{method:"PATCH",body:{
       id:companyId,operation:"profile_batch",patch,expected,requestKey:pending.key,
     }});
     if(!host.isConnected)return;
     pending=null;status.textContent="保存しました。";
     await onSaved?.();
   }catch(e){
     if(host.isConnected)status.textContent=e?.hint||e?.message||"保存できませんでした。再取得して確認してください。";
   }finally{busy=false;if(host.isConnected){save.disabled=false;edit.disabled=false;}}
 };
 return {get busy(){return busy;}};
}
