// Official corporate lookup for the Sales meeting on-boarding flow.
// Source text is untrusted, and all endpoints are fixed government hosts.
import {lookupNtaCorporate,parseNtaCorporateXml} from './sales-nta-corporate.js';
import {corporateNumberOk,normalizeGbizResults,normalizedName} from './sales-gbiz-official.js';
import {isIP} from 'node:net';

const NTA_NAME='https://api.houjin-bangou.nta.go.jp/4/name';
const GBIZ_SEARCH='https://api.info.gbiz.go.jp/hojin/v2/hojin';
const GBIZ_NUMBER=GBIZ_SEARCH+'/';
const APP_ID=/^[a-zA-Z0-9]{13}$/;
const NAME_SAFE=/[\u0000-\u001f\u007f]/;
const trim=(s,n=200)=>String(s??'').normalize('NFKC').trim().slice(0,n);
const err=e=>e?.name==='TimeoutError'?'timeout':'connection_failed';
const fail=(error,configured)=>({configured,error,rows:[]});

export function safeMeetingWebsite(raw){
  if(!raw)return '';
  let u;try{u=new URL(String(raw).trim());}catch{return null;}
  const host=u.hostname.toLowerCase().replace(/^www\./,'');
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||u.href.length>500
    ||isIP(host)||!host.includes('.')||!/^[a-z0-9.-]+$/.test(host)
    ||host==='localhost'||host.endsWith('.local')||host.endsWith('.internal')
    ||host.startsWith('.')||host.endsWith('.')||host.includes('..'))
      return null;
  return u.href;
}
export function cleanSearchName(raw){
  const name=trim(raw,81);
  if(name.length<2||name.length>80||NAME_SAFE.test(name))return null;
  // NTA name mode=2 accepts part of the legal name; omit the corporate suffix
  // only for the query, never for the official record shown to staff.
  const normalized=normalizedName(name);
  return normalized.length>=2?trim(normalized,80):null;
}
export function parseNtaMeetingNameXml(xml,limit=15){
  const raw=String(xml||'');
  if(raw.length>250000||/<!DOCTYPE|<!ENTITY/i.test(raw))return [];
  const out=[],seen=new Set();
  for(const match of raw.matchAll(/<corporation(?:\s[^>]*)?>[\s\S]*?<\/corporation>/gi)){
    const part=match[0],number=(part.match(/<corporateNumber>([0-9]{13})<\/corporateNumber>/i)||[])[1];
    if(!number||seen.has(number))continue;
    const item=parseNtaCorporateXml('<corporations>'+part+'</corporations>',number);
    if(!item||item.closed)continue;
    seen.add(number);
    out.push(item);
    if(out.length>=limit)break;
  }
  return out;
}
export async function searchNtaCompanyName(query,{env=process.env,fetcher=fetch}={}){
  const appId=String(env.HOUJIN_BANGOU_APP_ID||'').trim();
  const name=cleanSearchName(query);
  if(!name)return fail('invalid_name',Boolean(appId));
  if(!APP_ID.test(appId))return fail(appId?'nta_app_id_invalid':'nta_app_id_missing',Boolean(appId));
  const url=NTA_NAME+'?'+new URLSearchParams({id:appId,name,type:'12',mode:'2',close:'0'});
  try{
    const response=await fetcher(url,{redirect:'error',headers:{Accept:'application/xml,text/xml'},
      signal:AbortSignal.timeout(8500)});
    if(!response.ok)return fail('http_'+response.status,true);
    if(Number(response.headers?.get?.('content-length')||0)>250000)return fail('query_too_broad',true);
    const xml=await response.text();
    if(xml.length>250000)return fail('query_too_broad',true);
    return {configured:true,source:'nta_v4',rows:parseNtaMeetingNameXml(xml)};
  }catch(e){return fail(err(e),true);}
}
async function gbizRequest(url,{token=process.env.GBIZINFO_API_TOKEN||process.env.GBIZINFO_TOKEN,fetcher=fetch}={}){
  if(!token)return fail('gbiz_token_missing',false);
  try{
    const response=await fetcher(url,{redirect:'error',
      headers:{'X-hojinInfo-api-token':token,Accept:'application/json'},
      signal:AbortSignal.timeout(8500)});
    if(!response.ok)return fail('http_'+response.status,true);
    if(Number(response.headers?.get?.('content-length')||0)>250000)return fail('response_too_large',true);
    const raw=await response.text();
    if(raw.length>250000)return fail('response_too_large',true);
    const rows=normalizeGbizResults(JSON.parse(raw));
    return {configured:true,source:'gbiz_api_v2',rows};
  }catch(e){return fail(err(e),true);}
}
export async function searchMeetingCompanies(raw,{env=process.env,fetcher=fetch}={}){
  const name=cleanSearchName(raw);
  if(!name)return fail('invalid_name',true);
  // Both APIs are used server-side. NTA is the primary authoritative source.
  const nta=await searchNtaCompanyName(name,{env,fetcher});
  if(nta.rows.length)return {...nta,rows:nta.rows.slice(0,15)};
  const gbiz=await gbizRequest(GBIZ_SEARCH+'?'+new URLSearchParams({name,limit:'15'}),
    {token:env.GBIZINFO_API_TOKEN||env.GBIZINFO_TOKEN,fetcher});
  if(gbiz.rows.length)return {...gbiz,rows:gbiz.rows.slice(0,15)};
  return {configured:nta.configured||gbiz.configured,
    error:gbiz.error||nta.error||'not_found',rows:[],
    sourcesTried:['nta_v4','gbiz_api_v2']};
}
export async function lookupMeetingCompanyNumber(number,{env=process.env,fetcher=fetch}={}){
  if(!corporateNumberOk(number))return {verified:false,error:'invalid_number'};
  const nta=await lookupNtaCorporate(number,{env,fetcher});
  if(nta.official)return {verified:true,source:'nta_v4',official:nta.official};
  const gbiz=await gbizRequest(GBIZ_NUMBER+encodeURIComponent(number),
    {token:env.GBIZINFO_API_TOKEN||env.GBIZINFO_TOKEN,fetcher});
  const match=gbiz.rows.find(x=>x.corporateNumber===number);
  if(match)return {verified:true,source:'gbiz_api_v2',official:match};
  return {verified:false,error:gbiz.error||nta.error||'not_found',
    configured:nta.configured||gbiz.configured};
}
