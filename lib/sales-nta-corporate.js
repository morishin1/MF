// NTA 法人番号システム Web-API Ver.4 official three-field lookup.
// 13-character application ID is a secret supplied ONLY server-side via env.
// HTTP request query contains the ID: never print URL or response in logs.
export const NTA_BASE="https://api.houjin-bangou.nta.go.jp/4/num";
const NUMBER=/^[0-9]{13}$/;
const APP_ID=/^[A-Za-z0-9]{13}$/;
function decodeXml(raw){
 return String(raw||"").replace(/&#(x[0-9A-Fa-f]+|[0-9]+);|&(amp|lt|gt|quot|apos);/g,(all,num,entity)=>{
   if(entity)return {amp:"&",lt:"<",gt:">",quot:'"',apos:"'"}[entity]||all;
   try{const n=num[0]==="x"?parseInt(num.slice(1),16):parseInt(num,10);
     return n<=0x10ffff&&n>=0&&!((n>=0xd800)&&(n<=0xdfff))?String.fromCodePoint(n):all;
   }catch{return all;}
 });
}
const extract=(xml,tag)=>{
 const pattern=new RegExp("<"+tag+"(?:\\s[^>]*)?>([\\s\\S]*?)<\\/"+tag+">","i");
 return decodeXml((String(xml||"").match(pattern)||[])[1]||"").trim();
};
export function parseNtaCorporateXml(xml,requestedNumber){
 if(!NUMBER.test(String(requestedNumber)))return null;
 const source=String(xml||"");
 if(source.length>160000||/<!DOCTYPE|<!ENTITY/i.test(source))return null;
 const rows=[...source.matchAll(/<corporation(?:\s[^>]*)?>([\s\S]*?)<\/corporation>/gi)]
   .map(x=>x[1]).filter(x=>extract(x,"corporateNumber")===requestedNumber);
 if(!rows.length)return null;
 const row=rows.find(x=>extract(x,"latest")==="1")||rows[rows.length-1];
 const name=extract(row,"name");
 const prefecture=extract(row,"prefectureName");
 const city=extract(row,"cityName");
 const street=extract(row,"streetNumber");
 const address=[prefecture,city,street].filter(Boolean).join("");
 if(!name||!prefecture||!address||address.length>500||name.length>200)return null;
 const closed=Boolean(extract(row,"closeDate"));
 return {
  corporateNumber:requestedNumber,name,address,prefecture,
  website:"",industry:"",closed,sourceVersion:"nta_v4",
  // NTA does not offer an authoritative website/industry in the basic-three dataset.
  profileUrl:"https://www.houjin-bangou.nta.go.jp/",
 };
}
export async function lookupNtaCorporate(number,{env=process.env,fetcher=fetch}={}){
 const appId=String(env.HOUJIN_BANGOU_APP_ID||"").trim();
 if(!NUMBER.test(String(number)))return {configured:!!appId,official:null,error:"invalid_number",version:"国税庁v4",httpStatus:null};
 if(!appId)return {configured:false,official:null,error:"nta_app_id_missing",version:"国税庁v4",httpStatus:null};
 if(!APP_ID.test(appId))return {configured:true,official:null,error:"nta_app_id_invalid",version:"国税庁v4",httpStatus:null};
 const url=NTA_BASE+"?"+new URLSearchParams({id:appId,number:String(number),type:"12",history:"0"});
 let response;
 try{
   response=await fetcher(url,{
     method:"GET",redirect:"error",headers:{Accept:"application/xml,text/xml"},
     signal:AbortSignal.timeout(8500),
   });
 }catch(e){
   return {configured:true,official:null,error:e?.name==="TimeoutError"?"timeout":"connection_failed",version:"国税庁v4",httpStatus:null};
 }
 const httpStatus=Number(response.status)||null;
 if(!response.ok)return {configured:true,official:null,error:"http_"+response.status,version:"国税庁v4",httpStatus};
 const contentLength=Number(response.headers?.get?.("content-length")||0);
 if(contentLength>160000)return {configured:true,official:null,error:"response_too_large",version:"国税庁v4",httpStatus};
 let xml;
 try{xml=await response.text();}catch{return {configured:true,official:null,error:"invalid_response",version:"国税庁v4",httpStatus};}
 const official=parseNtaCorporateXml(xml,number);
 if(!official)return {configured:true,official:null,error:"no_matching_corporation",version:"国税庁v4",httpStatus};
 if(official.closed)return {configured:true,official:null,error:"corporation_closed",version:"国税庁v4",httpStatus};
 return {configured:true,official,rows:[official],sourceVersion:"nta_v4",version:"国税庁v4",httpStatus};
}
