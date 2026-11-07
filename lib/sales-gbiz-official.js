// Public-company identity and gBizINFO v2 response normalization.
// Never use an unverified name-only match to update a company.
export const GBIZ_ORIGIN="https://info.gbiz.go.jp";
export const GBIZ_API_ORIGIN="https://api.info.gbiz.go.jp";
const allowedFields=new Set(["name","address","website","industry","prefecture"]);
export const corporateNumberOk=value=>/^[0-9]{13}$/.test(String(value||""));
export function officialProfileUrl(number){
  return corporateNumberOk(number)
    ? GBIZ_ORIGIN+"/hojin/ichiran?hojinBango="+number
    : GBIZ_ORIGIN+"/";
}
export function companySearchUrl(name){
  // gBizINFO has no documented name-search deep link as of its 2026 site renewal.
  // Use a prefilled, executed search limited to the government's official domain.
  const query='site:info.gbiz.go.jp/hojin/ichiran "'+String(name||"").trim().slice(0,150)+'"';
  return "https://www.google.com/search?"+new URLSearchParams({q:query});
}
export function normalizedName(name){
  return String(name??"").normalize("NFKC").replace(/[　\s.,，・･\-]/g,"")
   .replace(/^(?:株式会社|有限会社|合同会社|合資会社|一般社団法人)/,"")
   .replace(/(?:株式会社|有限会社|合同会社|合資会社|一般社団法人)$/,"")
   .toLowerCase();
}
export function namesCompatible(left,right) {
  const a=normalizedName(left),b=normalizedName(right);
  return Boolean(a&&b&&a===b);
}
function text(v,max=500){
  if(typeof v!=="string")return "";
  return v.normalize("NFKC").trim().slice(0,max);
}
function single(value){
  if(typeof value==="string")return text(value);
  if(value&&typeof value==="object"&&!Array.isArray(value))
    return text(value.name||value.value||value.label||value.text);
  return "";
}
function findRows(root) {
  if(Array.isArray(root))return root;
  if(!root||typeof root!=="object")return [];
  for(const key of ["hojin-infos","hojin_infos","hojinInfos","corporations","companies","results","items","data","body","response"]){
    const v=root[key];
    if(Array.isArray(v))return v;
    if(v&&typeof v==="object"){
      const nested=findRows(v);
      if(nested.length)return nested;
    }
  }
  return [root];
}
function basicObject(item){
  if(!item||typeof item!=="object")return {};
  const v=item.basicInfo||item.basic_info||item.basic||item;
  return v&&typeof v==="object"?v:{};
}
function prefecture(address){
  const m=String(address).match(/^(北海道|東京都|(?:京都|大阪)府|.{2,3}県)/);
  return m?.[1]||"";
}
export function normalizeGbizResults(payload,requestedNumber=""){
  const rows=findRows(payload).slice(0,30);
  return rows.map(item=>{
    const b=basicObject(item);
    const number=String(b.corporate_number||b.corporateNumber||b.hojinBango||b.corporate_num||item.corporate_number||"").trim();
    const name=single(b.name||b.corporate_name||b.company_name||b.corporateName||item.name);
    const address=single(b.location||b.address||b.head_office_location||b.headOfficeAddress||item.location);
    const website=single(b.company_url||b.website||b.url||b.homepage||item.company_url);
    const industry=single(b.industry_name||b.industry||item.industry_name);
    return {
      corporateNumber:number,name,address,website:/^https:\/\//i.test(website)?website.slice(0,500):"",
      industry,prefecture:prefecture(address),
      profileUrl:officialProfileUrl(number),
    };
  }).filter(x=>corporateNumberOk(x.corporateNumber)&&(!requestedNumber||x.corporateNumber===requestedNumber));
}
export function computeOfficialPatch(current,official,{overwrite=false}={}){
  const out={};
  const candidates={
    name:official.name,address:official.address,
    website:official.website,industry:official.industry,prefecture:official.prefecture,
  };
  for(const [key,raw] of Object.entries(candidates)){
    if(!allowedFields.has(key)||!raw)continue;
    const before=text(current?.[key]);
    if(!before||overwrite&&before!==raw)out[key]=text(raw,key==="address"||key==="website"?500:key==="name"?200:100);
  }
  return out;
}
export function summarizeDiff(current,official){
  return ["name","address","website","industry","prefecture"].map(field=>({
    field,before:single(current?.[field])||null,official:single(official?.[field])||null,
    different:Boolean(official?.[field])&&single(current?.[field])!==single(official?.[field]),
  }));
}
