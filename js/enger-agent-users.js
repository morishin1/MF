// ENGERエージェント｜Officeメンバー管理タブ
// 社外本人へのアクセス権付与はAPIでのみ行う。ブラウザにサービスロールを置かない。
(function(){
"use strict";
const el=id=>document.getElementById(id);
const api=async(url,method="GET",body)=>API.api(url,
  method==="GET"?undefined:{method,body});
const state={agents:[],names:{},selected:null,selectedIds:new Set(),companyIds:new Set(),busy:false,loading:false,loaded:false,seq:0};
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

let loadingTask=null;
async function load(force=false){
  if(loadingTask)return loadingTask;
  if(state.loaded&&!force)return;
  loadingTask=(async()=>{
  state.loading=true;msg("ENGERエージェントを確認しています。");
  try{
    const data=await api("/api/enger/agent-users");
    state.agents=Array.isArray(data.agents)?data.agents:[];
    state.names=data.companyNames||{};
    if(data.loginStatus&&el("ag-login-status"))el("ag-login-status").textContent=String(data.loginStatus);
    state.loaded=true;
    render();
    msg(state.agents.length+"名の営業エージェントを確認しました。");
  }catch(e){
    state.loaded=false;state.agents=[];state.selectedIds.clear();renderSelection();
    msg(e.hint||e.message||"エージェントを読み込めませんでした。",true);
    el("ag-rows").replaceChildren();
    const row=document.createElement("tr"),cell=document.createElement("td");
    cell.colSpan=6;cell.textContent="読み込みに失敗しました。";
    row.append(cell);el("ag-rows").append(row);
  }finally{state.loading=false;}
  })();
  try{return await loadingTask;}finally{loadingTask=null;}
}
function render(){
  const tbody=el("ag-rows");clear(tbody);
  if(!state.agents.length){
    const tr=document.createElement("tr"),td=textNode("td","まだエージェントが登録されていません。");
    state.selectedIds.clear();td.colSpan=6;tr.append(td);tbody.append(tr);renderSelection();return;
  }
  const currentIds=new Set(state.agents.map(a=>a.employeeId));
  for(const id of [...state.selectedIds])if(!currentIds.has(id))state.selectedIds.delete(id);
  for(const agent of state.agents){
    const tr=document.createElement("tr");
    const selected=document.createElement("td"),check=document.createElement("input");
    check.type="checkbox";check.checked=state.selectedIds.has(agent.employeeId);
    check.setAttribute("aria-label",agent.name+"を選択");
    check.addEventListener("change",()=>{
      if(check.checked)state.selectedIds.add(agent.employeeId);
      else state.selectedIds.delete(agent.employeeId);
      renderSelection();
    });
    selected.append(check);
    const ident=document.createElement("td");
    const mail=textNode("small",agent.email||"","muted");mail.style.display="block";
    ident.append(textNode("strong",agent.name),mail);
    const type=textNode("td",agent.employmentType||"—");
    // 状態は1つだけ見せる（役割の正本が無い旧方式の人は付与待ち）
    const active=textNode("td",statusLabel(agent));
    const count=textNode("td",(agent.companyIds||[]).length+"社");
    const td=document.createElement("td");
    const button=textNode("button","設定","btn btn-secondary btn-sm");
    // 役割の付与待ち（旧方式など）は、付与の確認から始める
    button.type="button";button.addEventListener("click",()=>
      agent.roleAssigned||agent.hasConflict?edit(agent.employeeId):window.EngerAgentUsers.openEmployee(agent.employeeId));
    td.append(button);tr.append(selected,ident,type,active,count,td);tbody.append(tr);
  }
  renderSelection();
}
function statusLabel(agent){
  if(agent.hasConflict)return "要確認（ENGERに別の所属）";
  if(agent.legacyOnly||!agent.roleAssigned)return "役割の付与待ち";
  if(agent.status!=="active")return "停止中（在籍外）";
  return agent.enabled?"利用中":"停止中・設定待ち";
}
function renderSelection(){
  const count=state.selectedIds.size,all=state.agents.length;
  el("ag-selected-count").textContent=count+"名を選択中";
  const check=el("ag-select-all");
  check.checked=Boolean(all&&count===all);
  check.indeterminate=Boolean(count&&count<all);
  check.disabled=state.busy||!all;
  el("ag-bulk-disable").disabled=state.busy||!count;
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
  el("ag-detail-person").textContent=agent.name+" ／ "+(agent.email||"")+" ／ "+statusLabel(agent)+
    (agent.hasConflict?" ／ ENGERに既存の社内・取引先の所属があるため設定できません":"");
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
el("ag-select-all").addEventListener("change",ev=>{
  if(ev.currentTarget.checked)state.agents.forEach(a=>state.selectedIds.add(a.employeeId));
  else state.selectedIds.clear();
  render();
});
el("ag-bulk-disable").addEventListener("click",async()=>{
  if(state.busy||!state.selectedIds.size)return;
  const targets=state.agents.filter(a=>state.selectedIds.has(a.employeeId));
  const active=targets.filter(a=>a.enabled);
  if(!active.length){msg("選択した人はすでに停止しています。");return;}
  if(!confirm(active.length+"名のENGER営業を停止し、担当企業の閲覧権限を取り消しますか？商談履歴は残します。"))return;
  state.busy=true;renderSelection();
  const failed=[];let done=0;
  for(const a of active){
    try {
      await api("/api/enger/agent-users","PATCH",{
        employeeId:a.employeeId,enabled:false,
        companyIds:[],contractConfirmed:false,ndaConfirmed:false
      });
      done++;state.selectedIds.delete(a.employeeId);
    }catch(e){failed.push(a.name+"："+(e.hint||e.message||"停止できませんでした"));}
  }
  state.busy=false;state.loaded=false;
  await load(true);
  msg(done+"名のENGER利用を停止しました。"+(failed.length?failed.join("／"):""));
});
el("ag-create-form").addEventListener("submit",async ev=>{
  ev.preventDefault();if(state.busy)return;
  const form=ev.currentTarget;
  if(!form.reportValidity())return;
  if(!el("ag-create-confirm").checked){msg("氏名・メールと雇用・契約区分の確認をしてください。",true);return;}
  state.busy=true;el("ag-create-submit").disabled=true;
  el("ag-first-access").hidden=true;
  try{
    const email=el("ag-create-email").value.trim().toLowerCase();
    const data=await api("/api/enger/agent-users","POST",{
      name:el("ag-create-name").value.trim(),email,
      employmentType:el("ag-create-type").value,
      department:el("ag-create-dept").value.trim(),confirm:true
    });
    if(!data.ok||!data.initialPassword)throw Error("ログイン情報を確認できませんでした。");
    el("ag-first-email").textContent=email;
    el("ag-first-password").textContent=data.initialPassword;
    el("ag-first-access").hidden=false;
    el("ag-create-form").hidden=true;form.reset();state.loaded=false;
    msg(data.partial?(data.note||"役割の付与をやり直してください。"):"名簿とログインを作成し、役割を付与しました（停止中）。続けて担当企業を設定してください。",Boolean(data.partial));
    await load();
  }catch(e){msg(e.hint||e.message||"アカウントを作成できませんでした。",true);}
  finally{state.busy=false;el("ag-create-submit").disabled=false;}
});
el("ag-copy-credential").addEventListener("click",async()=>{
  const pass=el("ag-first-password").textContent;
  if(!pass)return;
  // ENGERのエージェント用ホームは未公開のため、ENGERのログインURLは渡さない
  const lines=["グループウェア共通ログイン",
    "メール: "+el("ag-first-email").textContent,"初回パスワード: "+pass];
  try{await navigator.clipboard.writeText(lines.join("\n"));msg("ログイン情報をコピーしました。");}
  catch{msg("コピーできませんでした。画面の情報を選択してください。",true);}
});
el("ag-password-reset").addEventListener("click",()=>{
  if(state.busy||!state.selected)return;
  // 1人1ログイン：パスワードはGW共通の「ログイン・パスワード」で再発行する（ここに別の再発行を持たない）
  const id=state.selected.employeeId;closeEditor();
  if(typeof window.openAgentAccount==="function")window.openAgentAccount(id);
  else msg("メンバー詳細の「ログイン・パスワード」から再発行してください。",true);
});
el("ag-name-save").addEventListener("click",async()=>{
  if(state.busy||!state.selected)return;
  const displayName=el("ag-edit-name").value.trim();
  if(!displayName){msg("氏名を入力してください。",true);el("ag-edit-name").focus();return;}
  state.busy=true;el("ag-name-save").disabled=true;
  try{
    const response=await api("/api/enger/agent-users","PATCH",{
      action:"update_name",employeeId:state.selected.employeeId,displayName
    });
    if(!response.ok)throw Error("氏名を保存できませんでした。");
    state.selected.name=displayName;msg("氏名を保存しました。");
    state.loaded=false;render();await load(true);
  }catch(e){msg(e.hint||e.message||"氏名を保存できませんでした。",true);}
  finally{state.busy=false;el("ag-name-save").disabled=false;}
});
el("ag-save").addEventListener("click",async()=>{
  if(state.busy||!state.selected)return;
  const enabled=el("ag-active").checked;
  if(state.selected.hasConflict||!state.selected.roleAssigned){
    msg("先にENGER営業エージェントの役割を付与してください。",true);return;
  }
  if(enabled&&(!state.companyIds.size||
    !el("ag-contract-confirm").checked||!el("ag-nda-confirm").checked)){
    msg("利用開始には担当企業、契約書・秘密保持の確認が必要です。",true);return;
  }
  const reason=enabled?"利用開始":"利用停止";
  if(!confirm(state.selected.name+" のENGER"+reason+"を保存しますか？"))return;
  state.busy=true;el("ag-save").disabled=true;
  try{
    await api("/api/enger/agent-users","PATCH",{
      employeeId:state.selected.employeeId,
      enabled,companyIds:[...state.companyIds],
      contractConfirmed:enabled&&el("ag-contract-confirm").checked,
      ndaConfirmed:enabled&&el("ag-nda-confirm").checked
    });
    msg(reason+"を保存しました。");closeEditor();state.loaded=false;await load(true);
  }catch(e){msg(e.hint||e.message||"ENGER利用設定を保存できませんでした。",true);}
  finally{state.busy=false;el("ag-save").disabled=false;}
});
window.EngerAgentUsers={
  load:()=>load(false),
  openEmployee:async employeeId=>{
    await load(false);
    const found=state.agents.find(a=>a.employeeId===employeeId);
    if(found&&found.roleAssigned){edit(employeeId);return;}
    if(found&&found.hasConflict){edit(employeeId);return;}
    // 既存メンバーへ役割を付与する。新しいログインは作らない（1人1アカウント）
    if(!confirm("このメンバーに「ENGER営業エージェント」の役割を付与しますか？\n"+
      "・ログインは今のもの（GW共通）を使います。新しいアカウントは作りません。\n"+
      "・雇用区分・部署は変わりません。\n・付与直後は停止中で、企業情報は閲覧できません。"))return;
    if(state.busy)return;
    state.busy=true;
    try{
      const r=await api("/api/enger/agent-users","PATCH",{action:"grant_role",employeeId,confirm:true});
      if(!r.ok)throw Error("役割を付与できませんでした。");
      state.loaded=false;await load(true);
      msg("役割を付与しました（停止中）。担当企業と契約・秘密保持を確認して利用開始してください。");
      if(state.agents.some(a=>a.employeeId===employeeId))edit(employeeId);
    }catch(e){msg(e.hint||e.message||"役割を付与できませんでした。",true);}
    finally{state.busy=false;renderSelection();}
  }
};
})();