// ENGER企業ページの案内。送信は明示操作時のみ、1回20社まで。
const MAX = 20;
const DAY = 86400000;
const $ = id => document.getElementById(id);
export function planEngerOutreach(row, portal, now = Date.now()) {
  if (!row?.companyId || row.salesOnly || row.blocked) return {reason:"営業停止・企業ID未照合"};
  if (!portal?.contactAllowed) return {reason:portal?.contactReason || "連絡先・連絡可否の確認が必要"};
  if (!portal.mail?.configured) return {reason:portal.mail?.reason || "企業招待メールの送信設定が未完了"};
  if (!portal.contact?.email || !portal.contact?.name || !portal.contactReady) return {reason:"企業担当者名・メールの確認が必要"};
  const contact = portal.contact;
  const members = portal.members || [];
  const existing = members.find(m => m.email?.toLowerCase() === contact.email.toLowerCase());
  if (members.length && !existing) return {reason:"発行済み担当者と企業基本情報の宛先が異なります。企業詳細で確認"};
  if (!existing) return {action:"invite",email:contact.email,name:contact.name,label:"初回招待"};
  if (existing.status === "disabled") return {reason:"企業アカウント停止中"};
  if (existing.status === "invited") return {reason:"有効な初回招待を送付済み"};
  if (existing.status === "active") {
    const recentlySent = (portal.events||[]).some(e =>
      e.action === "portal.link_sent" && e.member === existing.displayName &&
      now - Date.parse(e.at) < 7*DAY && now >= Date.parse(e.at));
    if (recentlySent) return {reason:"直近7日以内にログインリンクを案内済み"};
    return {action:"login_link",memberId:existing.id,email:existing.email,name:existing.displayName,label:"ログイン案内",
      lastLoginAt:existing.lastLoginAt};
  }
  if (["expired","not_invited"].includes(existing.status))
    return {action:"reinvite",memberId:existing.id,email:existing.email,name:existing.displayName,label:"再招待"};
  return {reason:"担当者状態を確認してください"};
}
export function createEngerOutreach({getSelected}) {
  const modal = $("lc-outreach-dialog"),button=$("lc-outreach"),body=$("lc-outreach-rows"),
    consent=$("lc-outreach-consent"),send=$("lc-outreach-send"),status=$("lc-outreach-status");
  let plans=[],busy=false;
  function caption(value) {status.textContent=value;}
  function lock(value) {busy=value;button.disabled=value;send.disabled=value||!consent.checked||!plans.some(p=>p.action);}
  function draw() {
    body.replaceChildren();
    for(const plan of plans){
      const tr=document.createElement("tr");
      for(const val of [plan.name,plan.email||"—",plan.action?plan.label:plan.reason,plan.result||"—"]){
        const td=document.createElement("td");td.textContent=val||"—";tr.append(td);
      }
      body.append(tr);
    }
    send.disabled=busy||!consent.checked||!plans.some(p=>p.action);
  }
  async function preview(){
    if(busy)return;
    const rows=getSelected();
    if(!rows.length||rows.length>MAX){caption("一度に選べるのは1〜"+MAX+"社です。");return;}
    const ids=rows.map(r=>r.companyId);
    if(ids.some(id=>!id)||new Set(ids).size!==ids.length){
      caption("企業ID未照合・重複企業を除いてください。");return;
    }
    plans=[];consent.checked=false;send.disabled=true;modal.showModal();lock(true);
    caption("企業担当者・認証状態・送信設定を確認中…");
    for(const row of rows){
      try{
        const portal=await API.api("/api/sales/company-portal?companyId="+encodeURIComponent(row.companyId));
        plans.push({companyId:row.companyId,name:row.name,contactName:portal?.contact?.name,...planEngerOutreach(row,portal)});
      }catch(e){plans.push({companyId:row.companyId,name:row.name,reason:e?.hint||"確認に失敗しました"});}
      draw();
    }
    lock(false);draw();
    caption(plans.filter(p=>p.action).length+"社が送信可能です。内容を確認し、適切な送信対象であることを確認してください。");
  }
  button.addEventListener("click",()=>void preview());
  $("lc-outreach-close").addEventListener("click",()=>{if(!busy)modal.close();});
  consent.addEventListener("change",draw);
  send.addEventListener("click",async()=>{
    if(busy||!consent.checked)return;
    const targets=plans.filter(p=>p.action&&!p.result);
    if(!targets.length)return;
    if(!confirm(targets.length+"社へENGER企業ページの案内メールを実送信します。宛先と送信可否を確認済みですか？"))return;
    lock(true);
    let ok=0,failed=0;
    for(const p of targets){
      caption(p.name+"に案内中…（"+(ok+failed+1)+"/"+targets.length+"）");
      try {
        const payload={companyId:p.companyId,action:p.action,outreach:true,confirmed:true};
        if(p.action==="invite")Object.assign(payload,{displayName:p.name,email:p.email,role:"member",sendMail:true});
        else if(p.action==="reinvite")Object.assign(payload,{memberId:p.memberId,sendMail:true});
        else payload.memberId=p.memberId;
        // 初回招待の表示名は企業担当者名であり、企業名ではない。
        if(p.action==="invite")payload.displayName=p.contactName;
        const result=await API.api("/api/sales/company-portal",{method:"POST",body:payload});
        if(result.mail!=="sent")throw Error("送信受付を確認できません。履歴で確認してください。");
        p.result="送信受付";ok++;
      }catch(e){
        p.result="要確認："+(e?.hint||e?.message||"送信結果不明");
        failed++;
        // 通信障害時の二重送信を避けるため、残り企業へは送らない。
        break;
      }
      draw();
    }
    lock(false);consent.checked=false;draw();
    caption("送信受付 "+ok+"社／要確認 "+failed+"社。未処理企業へは送信していません。メール到達・開封は別途確認してください。");
  });
  return {open:preview,isBusy:()=>busy};
}
