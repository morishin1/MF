// ENGERエージェント｜Officeメンバー管理タブ
// 社外本人へのアクセス権付与はAPIでのみ行う。ブラウザにサービスロールを置かない。
(function(){
"use strict";
const el=id=>document.getElementById(id);
const api=async(url,method="GET",body)=>API.api(url,
  method==="GET"?undefined:{method,body});
const state={agents:[],names:{},selected:null,companyIds:new Set(),busy:false,loading:false,loaded:false,seq:0};
const msg=(value,error=false)=>{
  const target=el("ag-message");target.textContent=String(value||"");
  target.style.color=error?"#a13629":"#53715f";
};
const clear=(node)=>{if(node)node.replaceChildren();};
const textNode=(tag,value,className)=>{
  const item=document.createElement(tag);item.textContent=String(value??"");
  if(className)item.className=className;
  return item;
};
const isUuid=value=>typeof value==="string"&&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function load(force=false){
  if(state.loading||state.loaded&&!force)return;
  state.loading=true;msg("ENGERエージェントを確認しています。");
  try{
    const data=await api("/api/enger/agent-users");
    state.agents=Array.isArray(data.agents)?data.agents:[];
    state.names=data.companyNames||{};
    state.loaded=true;
    render();
    msg(state.agents.length+"名のエージェントを確認しました。");
  }catch(e){
    msg(e.hint||e.message||"エージェントを読み込めませんでした。",true);
    el("ag-rows").replaceChildren();
    const row=document.createElement("tr"),cell=document.createElement("td");
    cell.colSpan=5;cell.textContent="読み込みに失敗しました。";
    row.append(cell);el("ag-rows").append(row);
  }finally{state.loading=false;}
}
function render(){
  const tbody=el("ag-rows");clear(tbody);
  if(!state.agents.length){
    const tr=document.createElement("tr"),td=textNode("td","まだエージェントが登録されていません。");
    td.colSpan=5;tr.append(td);tbody.append(tr);return;
  }
  for(const agent of state.agents){
    const tr=document.createElement("tr");
    const ident=document.createElement("td");
    ident.append(textNode("strong",agent.name),textNode("small",agent.email||""));
    const type=textNode("td",agent.employmentType||"—");
    const active=textNode("td",agent.enabled?"利用中":"停止・設定待ち");
    const count=textNode("td",(agent.companyIds||[]).length+"社");
    const td=document.createElement("td");
    const button=textNode("button","設定","btn btn-secondary btn-sm");
    button.type="button";button.addEventListener("click",()=>edit(agent.employeeId));
    td.append(button);tr.append(ident,type,active,count,td);tbody.append(tr);
  }
}
function renderCompanies(){
  const box=el("ag-company-selected");clear(box);
  if(!state.companyIds.size){
    box.append(textNode("small","未設定です。企業を検索して追加してください。","muted"));return;
  }
  for(const id of state.companyIds){
    const pill=textNode("button",(state.names[id]||id.slice(0,8)+"…")+" ×","btn btn-secondary btn-sm");
    pill.type="button";pill.setAttribute("aria-label","担当企業を解除する");
    pill.addEventListener("click",()=>{state.companyIds.delete(id);renderCompanies();});
    box.append(pill);
  }
}
function edit(employeeId){
  const agent=state.agents.find(a=>a.employeeId===employeeId);
  if(!agent)return;
  state.selected=agent;state.companyIds=new Set(agent.companyIds||[]);
  el("ag-active").checked=agent.enabled===true;
  el("ag-contract-confirm").checked=false;
  el("ag-nda-confirm").checked=false;
  el("ag-detail-person").textContent=agent.name+" ／ "+(agent.email||"")+
    (agent.hasConflict?" ／ 既存の社内権限があり設定を確認する必要があります":"");
  el("ag-edit-name").value=agent.name||"";
  clear(el("ag-company-results"));el("ag-company-query").value="";
  renderCompanies();el("ag-detail").hidden=false;
  el("ag-detail").scrollIntoView({behavior:"smooth",block:"start"});
}
function closeEditor(){el("ag-detail").hidden=true;state.selected=null;state.companyIds.clear();}
function showSuggestions(items){
  const host=el("ag-company-results");clear(host);
  if(!items.length){
    host.append(textNode("small","候補はありません。正式な企業名や法人番号をご確認ください。","muted"));return;
  }
  for(const company of items){
    if(!isUuid(company.id))continue;
    const button=textNode("button",company.name||"会社名未設定","btn btn-secondary btn-sm");
    button.type="button";button.setAttribute("role","option");
    button.disabled=state.companyIds.has(company.id)||state.companyIds.size>=20;
    button.addEventListener("click",()=>{
      state.companyIds.add(company.id);state.names[company.id]=company.name;
      renderCompanies();clear(host);el("ag-company-query").value="";
    });
    host.append(button);
  }
}
let searchTimer=null;
el("ag-company-query").addEventListener("input",()=>{
  clearTimeout(searchTimer);const q=el("ag-company-query").value.trim();
  if(q.length<2){clear(el("ag-company-results"));return;}
  searchTimer=setTimeout(async()=>{
    const ticket=++state.seq;
    try{
      const data=await api("/api/enger/agent-users?companyQuery="+encodeURIComponent(q));
      if(ticket!==state.seq||!state.selected)return;
      showSuggestions(Array.isArray(data.companies)?data.companies:[]);
    }catch(e){if(ticket===state.seq)msg(e.hint||e.message||"企業検索ができませんでした。",true);}
  },300);
});
el("ag-create-toggle").addEventListener("click",()=>{
  el("ag-create-form").hidden=!el("ag-create-form").hidden;
  if(!el("ag-create-form").hidden)el("ag-create-name").focus();
});
el("ag-create-cancel").addEventListener("click",()=>{el("ag-create-form").hidden=true;});
el("ag-detail-close").addEventListener("click",closeEditor);
el("ag-create-form").addEventListener("submit",async ev=>{
  ev.preventDefault();if(state.busy)return;
  const form=ev.currentTarget;
  if(!form.reportValidity())return;
  if(!el("ag-create-confirm").checked){msg("氏名・メールと契約区分の確認をしてください。",true);return;}
  state.busy=true;el("ag-create-submit").disabled=true;
  el("ag-first-access").hidden=true;
  try{
    const email=el("ag-create-email").value.trim().toLowerCase();
    const data=await api("/api/enger/agent-users","POST",{
      name:el("ag-create-name").value.trim(),email,
      employmentType:el("ag-create-type").value,confirm:true
    });
    if(!data.ok||!data.initialPassword)throw Error("ログイン情報を確認できませんでした。");
    el("ag-first-email").textContent=email;
    el("ag-first-password").textContent=data.initialPassword;
    el("ag-first-access").hidden=false;
    el("ag-create-form").hidden=true;form.reset();state.loaded=false;
    msg("アカウントを作成しました。続けて利用権限と担当企業を設定してください。");
    await load();
  }catch(e){msg(e.hint||e.message||"アカウントを作成できませんでした。",true);}
  finally{state.busy=false;el("ag-create-submit").disabled=false;}
});
el("ag-copy-credential").addEventListener("click",async()=>{
  const pass=el("ag-first-password").textContent;
  if(!pass)return;
  const lines=["ENGERログイン: https://enger.jp/business/login",
    "メール: "+el("ag-first-email").textContent,"初回パスワード: "+pass];
  try{await navigator.clipboard.writeText(lines.join("\n"));msg("ログイン情報をコピーしました。");}
  catch{msg("コピーできませんでした。画面の情報を選択してください。",true);}
});
el("ag-save").addEventListener("click",async()=>{
  if(state.busy||!state.selected)return;
  const enabled=el("ag-active").checked;
  const displayName=el("ag-edit-name").value.trim();
  if(!displayName){msg("エージェントの氏名を入力してください。",true);el("ag-edit-name").focus();return;}
  if(enabled&&(!state.companyIds.size||
    !el("ag-contract-confirm").checked||!el("ag-nda-confirm").checked)){
    msg("利用開始には担当企業、契約書・秘密保持の確認が必要です。",true);return;
  }
  const reason=enabled?"利用開始":"利用停止";
  if(!confirm(state.selected.name+" のENGER"+reason+"を保存しますか？"))return;
  state.busy=true;el("ag-save").disabled=true;
  try{
    await api("/api/enger/agent-users","PATCH",{
      employeeId:state.selected.employeeId,displayName,
      enabled,companyIds:[...state.companyIds],
      contractConfirmed:enabled&&el("ag-contract-confirm").checked,
      ndaConfirmed:enabled&&el("ag-nda-confirm").checked
    });
    msg(reason+"を保存しました。");closeEditor();state.loaded=false;await load(true);
  }catch(e){msg(e.hint||e.message||"ENGER利用設定を保存できませんでした。",true);}
  finally{state.busy=false;el("ag-save").disabled=false;}
});
window.EngerAgentUsers={load:()=>load(false)};
})();