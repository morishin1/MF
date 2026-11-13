const choices={
 dispatchPermit:new Set(['yes','no','unknown']),
 commercialFlow:new Set(['end_direct','contract','mixed','other','unknown']),
 supportFee:new Set(['possible','not_possible','needs_review','unknown']),
};
const methods=new Set(['email','line']);
export function meetingStepDetails(input){
 if(!input||typeof input!=='object'||Array.isArray(input))return null;
 const materialUrl=String(input.materialUrl||'').trim();
 if(materialUrl.length>500)return null;
 if(materialUrl){
  try{const url=new URL(materialUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;}
  catch{return null;}
 }
 const dispatchPermit=String(input.dispatchPermit||'unknown');
 const commercialFlow=String(input.commercialFlow||'unknown');
 const supportFee=String(input.supportFee||'unknown');
 if(!choices.dispatchPermit.has(dispatchPermit)||!choices.commercialFlow.has(commercialFlow)||!choices.supportFee.has(supportFee))return null;
 if(!Array.isArray(input.contactMethods)||input.contactMethods.length>2||
  input.contactMethods.some(x=>!methods.has(x))||new Set(input.contactMethods).size!==input.contactMethods.length)return null;
 return {materialUrl,dispatchPermit,contactMethods:[...input.contactMethods],commercialFlow,supportFee};
}

