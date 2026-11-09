// ENGER 成果報酬：営業用の見込・契約確認・請求記録・入金記録。
// 会計上の売上計上や請求書発行の代わりにはしない。
export const FEE_STATUS={
 draft:"見込・条件確認中",
 confirmed:"契約確認済み",
 invoiced:"請求記録済み",
 paid:"入金確認済み",
 void:"取消",
};
export const FEE_MODEL={once:"成約時の一時金",monthly:"稼働月ごとの継続手数料"};
const YYYY_MM=/^(20\d{2})-(0[1-9]|1[0-2])$/;
const YMD=/^\d{4}-\d{2}-\d{2}$/;
const str=(x,max=200)=>typeof x==="string"?x.normalize("NFKC").trim().slice(0,max+1):"";
export const validYmd=(x)=>{
 if(typeof x!=="string"||!YMD.test(x))return false;
 const d=new Date(x+"T00:00:00Z");
 return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===x;
};
export function parseFeeDraft(body){
 const model=body?.feeModel;
 if(!Object.hasOwn(FEE_MODEL,model))return {error:"invalid_fee_model"};
 const yen=Number(body?.feeYen);
 if(!Number.isSafeInteger(yen)||yen<1||yen>100000000)return {error:"invalid_fee_amount"};
 const payer=str(body?.payerName,160);
 if(payer.length<2||payer.length>160)return {error:"payer_required"};
 const m=str(body?.feeMonth,7);
 if(model==="monthly"&&!YYYY_MM.test(m))return {error:"invalid_fee_month"};
 if(model==="once"&&m)return {error:"once_fee_month_forbidden"};
 const note=str(body?.note,1000);
 if(note.length>1000)return {error:"note_too_long"};
 return {value:{
   fee_model:model,fee_month:model==="monthly"?m+"-01":null,fee_yen:yen,
   payer_name:payer,note:note||null,
 }};
}
export function feeTransition(row,body,{manager,offerStatus,now}){
 if(!manager)return {error:"manager_required"};
 const from=row?.status,to=body?.status;
 if(!Object.hasOwn(FEE_STATUS,to)||!Object.hasOwn(FEE_STATUS,from))return {error:"invalid_status"};
 const transitions={draft:["confirmed","void"],confirmed:["invoiced","void"],invoiced:["paid"],paid:[],void:[]};
 if(!transitions[from].includes(to))return {error:"invalid_transition"};
 const today=now||new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 if(to==="confirmed"){
   if(offerStatus!=="won")return {error:"contract_not_yet_agreed"};
   const evidence=str(body.agreementReference,500);
   if(evidence.length<8||evidence.length>500)return {error:"agreement_reference_required"};
   const signed=body.confirmedOn||today;
   if(!validYmd(signed))return {error:"invalid_confirmed_date"};
   return {value:{status:to,agreement_reference:evidence,confirmed_on:signed}};
 }
 if(to==="invoiced"){
   const invoice=str(body.invoiceNumber,100);
   if(!invoice||invoice.length>100)return {error:"invoice_reference_required"};
   const billed=body.invoicedOn||today;
   if(!validYmd(billed))return {error:"invalid_invoiced_date"};
   return {value:{status:to,invoice_number:invoice,invoiced_on:billed}};
 }
 if(to==="paid"){
   const paid=body.paidOn||today;
   if(!validYmd(paid))return {error:"invalid_paid_date"};
   return {value:{status:to,paid_on:paid}};
 }
 return {value:{status:"void"}};
}
export function feeSummary(rows){
 const totals={draft:0,confirmed:0,invoiced:0,paid:0,void:0};
 const counts={draft:0,confirmed:0,invoiced:0,paid:0,void:0};
 for(const r of rows||[])if(Object.hasOwn(totals,r.status)){
   counts[r.status]++;totals[r.status]+=Number(r.fee_yen)||0;
 }
 return {totals,counts,
   forecastYen:totals.draft,confirmedYen:totals.confirmed,
   invoicedYen:totals.invoiced,receivedYen:totals.paid};
}
