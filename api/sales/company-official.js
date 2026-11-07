// Sales company official enrichment. Fixed gBizINFO host; token stays server-side.
// All writes are an atomic, idempotent, audited RPC (db/163).
import {createHash} from "node:crypto";
import {json,readJson,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {canAccessEightEngerDirectory} from "../../lib/sales-enger-scope.js";
import {admin} from "../../lib/supabase.js";
import {isUuid} from "../../lib/sales.js";
import {companyInScope} from "../../lib/sales-company-portal-db.js";
import {
  corporateNumberOk,officialProfileUrl,companySearchUrl,namesCompatible,
  normalizeGbizResults,computeOfficialPatch,summarizeDiff,
} from "../../lib/sales-gbiz-official.js";

const BASE="https://api.info.gbiz.go.jp/hojin";
const BASE_V1="https://info.gbiz.go.jp/hojin";
const ERR=(res,error,hint,status=400)=>json(res,status,{error,hint});
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const TOK=()=>process.env.GBIZINFO_API_TOKEN||"";
function publicCompany(row){
  return {id:row.id,name:row.name||"",corporateNumber:row.corporate_number||"",
    address:row.address||"",prefecture:row.prefecture||"",website:row.website||"",
    industry:row.industry||""};
}
async function officialRequest(path,origin=BASE){
  const token=TOK();
  if(!token)return {configured:false,rows:[]};
  const endpoint=origin+path;
  // Never accept an arbitrary URL or expose the API token to the browser.
  let response;
  try{
    response=await fetch(endpoint,{
      headers:{"X-hojinInfo-api-token":token,"Accept":"application/json"},
      redirect:"error",signal:AbortSignal.timeout(9000),
    });
  }catch{return {configured:true,error:"connection_failed",rows:[]};}
  if(!response.ok)return {configured:true,error:"http_"+response.status,rows:[]};
  let parsed;
  try{parsed=await response.json();}catch{return {configured:true,error:"invalid_response",rows:[]};}
  return {configured:true,rows:normalizeGbizResults(parsed),sourceVersion:origin===BASE?"v2":"v1"};
}
async function readCompany(db,id){
  const found=await db.schema("enger").from("companies")
    .select("id,name,corporate_number,address,prefecture,website,industry")
    .eq("id",id).is("deleted_at",null).maybeSingle();
  if(found.error||!found.data)throw Error("company_unavailable");
  return publicCompany(found.data);
}
async function verifiedByNumber(number){
  // ENGER crawler verified the official v1 endpoint in September 2026.
  // Some tokens/networks cannot use the v2 host; fall back to official v1.
  let response=await officialRequest("/v2/hojin/"+encodeURIComponent(number));
  let official=response.rows?.find(r=>r.corporateNumber===number)||null;
  if(official)return {...response,official};
  const fallback=await officialRequest("/v1/hojin/"+encodeURIComponent(number),BASE_V1);
  official=fallback.rows?.find(r=>r.corporateNumber===number)||null;
  return official?{...fallback,official}:({...response,official:null,
    error:fallback.error||response.error||"not_found"});
}
function preview(company,number,fromApi,{overwrite=false}={}){
  const official=fromApi?.official||null;
  const verified=Boolean(fromApi?.configured&&official);
  const patch=verified?computeOfficialPatch(company,official,{overwrite}):{};
  const differentName=Boolean(verified&&official.name&&!namesCompatible(company.name,official.name));
  const digest=hash({company,number,official,patch,overwrite,verified});
  return {
    number,profileUrl:officialProfileUrl(number),current:company,
    verified,configured:Boolean(fromApi?.configured),
    source:verified?(fromApi.sourceVersion==="v1"?"gbiz_api_v1":"gbiz_api_v2"):"manual_official_review",
    official:verified?official:null,
    diff:verified?summarizeDiff(company,official):[],
    patch,digest,differentName,
    note:verified?"公式情報の差分を確認して登録してください。"
      :fromApi?.error?"公式APIから情報を取得できませんでした。法人番号のみ手動で登録できます。"
      :"gBizINFO APIトークンが未設定です。法人番号のみ登録できます。基本情報はAPI接続後に照合して補完します。",
  };
}
export default async function handler(req,res){
  const user=await requireUser(req,res);if(!user)return;
  res.setHeader?.("Cache-Control","private, no-store");
  if(!["GET","POST"].includes(req.method))return methodNotAllowed(res,["GET","POST"]);
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
    return ERR(res,"forbidden","Salesの企業管理権限が必要です。",403);
  const url=new URL(req.url||"/","http://localhost"),body=req.method==="POST"?await readJson(req):null;
  const companyId=String(req.method==="GET"?url.searchParams.get("companyId")||"":body?.companyId||"");
  if(!isUuid(companyId))return ERR(res,"invalid_company","ENGER企業IDが正しくありません。");
  const db=admin();
  const scope=await companyInScope(db,ctx.tenantId,companyId);
  if(!scope.ok)return ERR(res,scope.error,"対象企業の利用権限を確認できません。",scope.status);
  let current;
  try{current=await readCompany(db,companyId);}
  catch{return ERR(res,"company_unavailable","企業の基本情報を確認できません。",503);}
  if(req.method==="GET"){
    const mode=url.searchParams.get("mode")||"state";
    if(mode==="state")return json(res,200,{company:current,configured:Boolean(TOK()),
      officialProfileUrl:officialProfileUrl(current.corporateNumber),
      companySearchUrl:companySearchUrl(current.name)});
    if(mode==="search"){
      const name=String(url.searchParams.get("name")||current.name).trim().slice(0,120);
      if(!name)return ERR(res,"name_required","企業名を入力してください。");
      let lookup=await officialRequest("/v2/hojin?"+new URLSearchParams({name,limit:"15"}));
      if(lookup.error||!lookup.rows?.length){
        const backup=await officialRequest("/v1/hojin?"+new URLSearchParams({name,limit:"15"}),BASE_V1);
        if(backup.rows?.length||!lookup.rows?.length)lookup=backup;
      }
      return json(res,200,{company:current,searchName:name,
        configured:lookup.configured,results:(lookup.rows||[]).slice(0,15),
        companySearchUrl:companySearchUrl(name),
        hint:lookup.error?"公式APIの応答を取得できませんでした。公式サイトで照合してください。":
          lookup.configured?"法人番号と所在地を確認して選択してください。":
          "公式APIは未接続です。企業名を入力済みの公式サイト限定検索を開いて確認できます。"});
    }
    if(mode==="number"){
      const n=String(url.searchParams.get("number")||"").trim();
      if(!corporateNumberOk(n))return ERR(res,"invalid_number","法人番号は13桁で入力してください。");
      const found=await verifiedByNumber(n);
      const result=preview(current,n,found);
      return json(res,200,result);
    }
    return ERR(res,"invalid_mode","検索方法が正しくありません。");
  }
  if(!body||!["preview","save"].includes(body.action))return ERR(res,"invalid_action","操作を確認してください。");
  const number=String(body.corporateNumber||"").trim();
  if(!corporateNumberOk(number))return ERR(res,"invalid_number","法人番号は13桁の数字で入力してください。");
  const overwrite=body.overwrite===true;
  const official=await verifiedByNumber(number);
  const result=preview(current,number,official,{overwrite});
  if(body.action==="preview")return json(res,200,result);
  if(!body.confirmed||result.digest!==body.previewDigest)
    return ERR(res,"review_required","最新の照合結果をプレビューしてから登録してください。",409);
  if(result.differentName&&body.allowDifferentName!==true)
    return ERR(res,"different_company_name","公式の法人名が登録企業名と異なります。別法人でないことを確認してから登録してください。",409);
  const expected=String(body.expectedCorporateNumber||"");
  if(expected!==current.corporateNumber)
    return ERR(res,"company_changed","法人番号が別の担当者により更新されました。再読込してください。",409);
  if(!result.verified&&body.manualConfirmed!==true)
    return ERR(res,"manual_confirmation_required","公式プロフィールで法人番号・法人名を確認してから登録してください。",409);
  if(!isUuid(body.requestKey))
    return ERR(res,"invalid_request","再保存防止用のリクエストIDを確認できません。");
  const saved=await db.rpc("gw_sales_company_official_save",{
    p_tenant:ctx.tenantId,p_company:companyId,p_actor:user.id,
    p_actor_name:ctx.employee?.display_name||user.email||"Sales",
    p_request:body.requestKey,p_corporate_number:number,
    p_expected_number:expected,p_basic:result.patch,
    p_source:result.source,
  });
  if(saved.error)return ERR(res,"save_failed",
    saved.error.code==="P0001"?
      "会社の照合情報に変更・重複があります。再検索し、法人番号・企業名を確認してください。":
      "法人番号を保存できません。db/163の適用状況を確認してください。",409);
  const updated=await readCompany(db,companyId).catch(()=>null);
  return json(res,200,{saved:true,verified:result.verified,company:updated,
    updatedFields:Object.keys(result.patch),profileUrl:result.profileUrl,
    hint:result.verified?"法人番号と公式基本情報を更新しました。":
      "法人番号を登録しました。基本情報の自動補完は公式APIトークン接続後に利用できます。"});
}
