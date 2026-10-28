// Safe review UI for client-side document import. Never auto-saves or publishes.
(function(){
 "use strict";
 const M=window.MarketingWordImport;
 if(!M)throw Error("MarketingWordImport parser is required");
 let root=null,opts={},pending=null,selected=new Set(),busy=false,warning="",requestId=0;
 const h=(tag,cls,text)=>{
  const e=document.createElement(tag);if(cls)e.className=cls;
  if(text!==undefined)e.textContent=String(text);
  return e;
 };
 const plain=(value)=>typeof value==="string"?value:Array.isArray(value)?value.map(x=>x.title+(x.body?"："+x.body:"")).join("\n"):"";
 const isEmpty=(value)=>!value||(Array.isArray(value)&&value.every(x=>!x.title&&!x.body));
 function render(){
  if(!root)return;
  root.replaceChildren();
  const panel=h("section","mpr-import");
  const header=h("div","mpr-import-heading");
  const group=h("div");
  group.append(h("strong","","Word原稿から取り込む"),h("p","","Word（.docx）やテキストの内容を読み取り、入力欄に反映できます。"));
  header.append(group);panel.append(header);
  const control=h("div","mpr-import-controls");
  const picker=h("input");
  picker.type="file";picker.accept=".docx,.txt,.md";
  picker.setAttribute("aria-label","PR原稿のWordファイルを選択");
  picker.disabled=busy||!opts.canApply?.();
  const hint=h("span","",busy?"文章を解析しています…":"最大8MB／ファイルはサーバへ送信されません");
  picker.onchange=async()=>{
   const file=picker.files?.[0];if(!file)return;
   const thisRequest=++requestId;busy=true;warning="";render();
   try{
    const result=await M.parseFile(file);
    if(thisRequest!==requestId)return;
    pending=result;
    selected=new Set(Object.keys(result.fields).filter(key=>isEmpty(opts.getDraft?.()?.[key])));
   }catch(err){
    if(thisRequest!==requestId)return;
    warning=err?.message||"原稿を解析できませんでした。";pending=null;selected.clear();
   }finally{
    if(thisRequest===requestId){busy=false;render();}
   }
  };
  control.append(picker,hint);panel.append(control);
  if(warning)panel.append(h("p","mpr-import-error",warning));
  if(pending){
   const title=h("div","mpr-import-review-head");
   title.append(h("b","",pending.filename+"（"+pending.chars+"文字）"));
   const reset=h("button","mpr-textbtn","選び直す");reset.type="button";
   reset.onclick=()=>{requestId++;pending=null;selected.clear();warning="";render();};
   title.append(reset);panel.append(title);
   if(pending.warnings.length){
    panel.append(h("p","mpr-import-alert","確認が必要："+pending.warnings.join("／")));
   }
   const found=Object.keys(pending.fields);
   if(found.length){
    panel.append(h("p","mpr-import-sub","反映する項目にチェックを入れてください。既存の内容は標準では上書きしません。"));
    const list=h("div","mpr-import-fields");
    for(const key of found){
     const row=h("label","mpr-import-field");
     const check=h("input");check.type="checkbox";check.checked=selected.has(key);
     check.onchange=()=>{check.checked?selected.add(key):selected.delete(key);};
     const text=h("span");
     text.append(h("b","",M.fieldLabels[key]||key));
     const preview=plain(pending.fields[key]);
     text.append(h("small","",preview.length>170?preview.slice(0,170)+"…":preview));
     const original=plain(opts.getDraft?.()?.[key]);
     if(original)text.append(h("em","","現在の入力あり（選択すると上書き）"));
     row.append(check,text);list.append(row);
    }
    panel.append(list);
    if(typeof opts.hasOverride==="function"&&opts.hasOverride()){
     const message=h("p","mpr-import-alert","全文プレビューに手動編集の本文があります。取込項目を表示へ反映するには、手動編集した本文を解除する必要があります。");
     panel.append(message);
    }
    const actions=h("div","mpr-import-actions");
    const apply=h("button","mpr-primary","選択した項目を入力欄に反映する");apply.type="button";
    apply.disabled=busy||!opts.canApply?.();
    apply.onclick=()=>{
      const entries={};
      for(const key of selected)if(Object.hasOwn(pending.fields,key))entries[key]=pending.fields[key];
      if(!Object.keys(entries).length){warning="反映する項目を選択してください。";render();return;}
      if(opts.hasOverride?.()&&!window.confirm("手動編集した全文を解除して、取り込んだ項目を基に原稿を作り直しますか？"))return;
      const ok=opts.apply?.(entries);
      if(ok===false){warning="現在の原稿は変更できません。";render();return;}
      requestId++;pending=null;selected.clear();warning="";
     };
    actions.append(apply);panel.append(actions);
   }else panel.append(h("p","mpr-import-alert","タイトルや概要などを判別できませんでした。元原稿を確認し、入力欄に転記してください。"));
   const disclosure=h("details","mpr-import-original");
   disclosure.append(h("summary","","元原稿の文章をすべて確認"),h("pre","",pending.raw));
   panel.append(disclosure);
   panel.append(h("p","mpr-import-notice","項目の反映は下書きの入力内容を更新するだけです。保存・社内本登録・PR TIMESへの投稿は行いません。取り込み対象は本文テキストで、画像・表の装飾・変更履歴は引き継ぎません。"));
  }
  root.append(panel);
 }
 window.MarketingWordImportUI={
  mount(node,options){root=node;opts=options||{};render();},
  clear(){requestId++;pending=null;selected.clear();warning="";render();},
  // pure inspection for synthetic tests only
  snapshot(){return {ready:!!pending,fields:pending?Object.keys(pending.fields):[],selected:[...selected],busy};}
 };
})();
