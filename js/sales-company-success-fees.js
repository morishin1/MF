// 売上に至るまでのオファー別成果報酬。管理者の明示操作なしに確定させない。
export async function renderSuccessFeeLedger(host,{companyId,offers}={}){
 if(!host||!companyId)return;
 const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 const money=n=>Number(n||0).toLocaleString("ja-JP")+"円";
 const nowParts=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit"}).formatToParts(new Date()).map(x=>[x.type,x.value]));
 const month=nowParts.year+"-"+nowParts.month;
 const statusText=(code)=>({draft:"見込",confirmed:"契約確認済",invoiced:"請求記録済",paid:"入金確認済",void:"取消"}[code]||code);
 const next={draft:[["confirmed","契約確認"],["void","取消"]],confirmed:[["invoiced","請求記録"],["void","取消"]],invoiced:[["paid","入金確認"]],paid:[],void:[]};
 const input=(key,label,placeholder="",type="text",required=false)=>'<label>'+label+
   '<input name="'+key+'" type="'+type+'" '+(required?"required ":"")+'placeholder="'+esc(placeholder)+'"></label>';
 host.innerHTML='<section class="lp-card lp-success-fee"><h3>成果報酬・入金管理</h3>'+
  '<p class="lc-detail-note">オファー成立後の手数料を記録します。金額は営業管理用であり、請求書発行・会計上の売上計上とは別です。</p>'+
  '<p class="lc-detail-note" id="sf-global-status" role="status">読み込み中…</p><div id="sf-content"></div></section>';
 const content=host.querySelector("#sf-content"),message=host.querySelector("#sf-global-status");
 if(!content||!message)return;
 let response;
 try{response=await API.api("/api/sales/success-fees?"+new URLSearchParams({companyId}));}
 catch(e){message.textContent=e?.hint||"成果報酬台帳を読み込めませんでした。";return;}
 const {items=[],summary={},isManager=false}=response;
 message.textContent="";
 const totals=summary.totals||{};
 const cards=[["見込",totals.draft],["契約確認済",totals.confirmed],["請求記録済",totals.invoiced],["入金確認済",totals.paid]];
 const kpi='<div class="sf-kpis">'+cards.map(([label,sum])=>'<div><small>'+label+'</small><b>'+money(sum)+'</b></div>').join("")+'</div>';
 const validOffers=(offers||[]).filter(x=>x.status!=="lost");
 const offerOptions=validOffers.map(x=>'<option value="'+esc(x.id)+'">'+esc((x.itemNo||"")+' '+(x.title||"案件・人材")+' ／ '+statusText(x.status))+'</option>').join("");
 const form=validOffers.length?'<form id="sf-create" class="sf-create"><h4>成果報酬の見込を登録</h4>'+
   '<label>企業からの提案<select name="offerId" required>'+offerOptions+'</select></label>'+
   '<label>報酬モデル<select name="feeModel"><option value="once">成約時の一時金</option><option value="monthly">稼働月ごとの継続手数料</option></select></label>'+
   input("feeYen","手数料（円）","例：50000","number",true)+
   input("payerName","請求先の企業名","契約で決めた支払企業", "text",true)+
   '<label data-sf-month hidden>対象の稼働月<input name="feeMonth" type="month" value="'+esc(month)+'"></label>'+
   input("note","社内メモ（任意）","条件・担当者など")+
   '<button type="submit" class="lc-primary">見込として登録</button></form>':
   '<p class="lc-detail-note">企業のオファーを受け付けると、ここで成果報酬の見込を登録できます。</p>';
 const grid=items.length?'<div class="lc-table-wrap"><table class="lc-table sf-table"><thead><tr><th>対象</th><th>報酬</th><th>支払企業</th><th>状態・次の対応</th></tr></thead><tbody>'+
    items.map(f=>{
      const offer=validOffers.find(x=>x.id===f.offerId);
      const action=next[f.status]||[];
      let controls="";
      if(isManager&&action.length){
        controls='<div class="sf-actions" data-fee-id="'+esc(f.id)+'">';
        if(f.status==="draft")controls+=input("agreementReference","契約書・申込書の参照番号","契約確認時に必須（8文字以上）");
        if(f.status==="confirmed")controls+=input("invoiceNumber","請求書番号","請求済み番号を入力");
        controls+=action.map(([status,label])=>'<button type="button" data-sf-next="'+status+'">'+label+'</button>').join("");
        controls+='</div>';
      }
      return '<tr><td>'+esc((offer?.itemNo||"")+' '+(offer?.title||"オファー"))+
       '<small>'+esc(f.model==="once"?"一時金":"継続："+(f.feeMonth||"").slice(0,7))+'</small></td>'+
       '<td><strong>'+money(f.feeYen)+'</strong></td><td>'+esc(f.payerName)+'</td>'+
       '<td><strong>'+esc(f.statusLabel||statusText(f.status))+'</strong>'+
       (f.agreementReference?'<small>契約根拠：'+esc(f.agreementReference)+'</small>':'')+
       (f.invoiceNumber?'<small>請求書番号：'+esc(f.invoiceNumber)+'</small>':'')+
       (f.paidOn?'<small>入金日：'+esc(f.paidOn)+'</small>':'')+
       controls+'</td></tr>';
    }).join("")+'</tbody></table></div>':'<p class="lc-detail-note">成果報酬の登録はまだありません。</p>';
 content.innerHTML=kpi+form+grid;
 const create=content.querySelector("#sf-create");
 if(create){
   const model=create.elements.namedItem("feeModel"),monthWrap=create.querySelector("[data-sf-month]");
   const toggle=()=>{const recurring=model.value==="monthly";monthWrap.hidden=!recurring;};
   model.onchange=toggle;toggle();
   create.onsubmit=async event=>{
     event.preventDefault();if(!create.reportValidity())return;
     const btn=create.querySelector('button[type="submit"]');btn.disabled=true;
     message.textContent="成果報酬の見込を保存しています…";
     const data=new FormData(create);
     try{
       const body={companyId,offerId:data.get("offerId"),feeModel:data.get("feeModel"),
         feeYen:Number(data.get("feeYen")),payerName:data.get("payerName"),
         feeMonth:data.get("feeModel")==="monthly"?data.get("feeMonth"):"",
         note:data.get("note")};
       await API.api("/api/sales/success-fees",{method:"POST",body});
       await renderSuccessFeeLedger(host,{companyId,offers});
     }catch(e){message.textContent=e?.hint||e?.message||"登録に失敗しました。";btn.disabled=false;}
   };
 }
 content.querySelectorAll("[data-sf-next]").forEach(button=>button.onclick=async()=>{
   const target=button.dataset.sfNext,group=button.closest("[data-fee-id]");
   const id=group?.dataset.feeId,fee=items.find(x=>x.id===id);
   if(!fee)return;
   if(!confirm(statusText(target)+"に変更しますか？"+(target==="confirmed"?"契約書の根拠を確認してください。":"")))return;
   const read=n=>group.querySelector('[name="'+n+'"]')?.value?.trim()||"";
   group.querySelectorAll("button").forEach(b=>b.disabled=true);
   message.textContent="状態を更新しています…";
   try{
     await API.api("/api/sales/success-fees",{method:"PATCH",body:{
       companyId,feeId:id,status:target,expectedStatus:fee.status,confirmed:true,
       agreementReference:read("agreementReference"),invoiceNumber:read("invoiceNumber")
     }});
     await renderSuccessFeeLedger(host,{companyId,offers});
   }catch(e){message.textContent=e?.hint||e?.message||"変更に失敗しました。";
     group.querySelectorAll("button").forEach(b=>b.disabled=false);}
 });
}
