// GET  /api/sales/meeting-company?mode=name&name=... | ?mode=number&number=...
// POST /api/sales/meeting-company {action:'register',corporateNumber,expectedName,website,requestKey}
// Official search is server-side. New records are created ONLY after explicit
// confirmation via an atomic, service_role-only RPC (db/173).
import {requireUser} from '../../lib/auth.js';
import {gwContext,canSell} from '../../lib/gw.js';
import {canAccessEightEngerDirectory} from '../../lib/sales-enger-scope.js';
import {admin} from '../../lib/supabase.js';
import {json,readJson,methodNotAllowed} from '../../lib/http.js';
import {gwLog} from '../../lib/gw-audit.js';
import {isUuid} from '../../lib/sales.js';
import {namesCompatible,corporateNumberOk} from '../../lib/sales-gbiz-official.js';
import {cleanSearchName,searchMeetingCompanies,lookupMeetingCompanyNumber,safeMeetingWebsite}
  from '../../lib/sales-meeting-company-research.js';

const hints={
  invalid_name:'企業名は2文字以上で検索してください。',
  invalid_number:'法人番号は13桁で入力してください。',
  nta_app_id_missing:'国税庁APIの設定を確認してください。',
  nta_app_id_invalid:'国税庁APIの設定を確認してください。',
  gbiz_token_missing:'gBizINFO APIの設定を確認してください。',
  http_401:'公式APIの認証を確認してください。',
  http_403:'公式APIの利用権限を確認してください。',
  http_429:'公式APIの利用上限に達しました。',
  timeout:'公式APIがタイムアウトしました。もう一度お試しください。',
  query_too_broad:'検索候補が多いため、より具体的な企業名または法人番号を入力してください。',
  not_found:'公式の企業情報が見つかりませんでした。法人番号で検索するか、企業名を見直してください。',
  connection_failed:'公式APIに接続できませんでした。通信状況を確認してください。',
  possible_existing_enger_company:'同じ企業名がENGERに登録されています。既存企業から選択し、法人番号を確認してください。',
  existing_sales_domain_review_required:'同じドメインの企業がSalesにあります。二重登録せず既存企業を確認してください。',
  request_key_conflict:'別の登録操作と競合しました。画面を開き直してください。',
  actor_not_in_tenant:'所属する企業のSales権限が必要です。',
  soft_deleted_company_review_required:'過去に登録された企業があるため、管理者による復元・照合が必要です。',
  invalid_verified_company:'企業情報に不備があります。もう一度検索してください。',
  invalid_website:'公式サイトはhttps://から始まるURLを指定してください。',
  invalid_website_domain:'公式サイトのURLを確認してください。',
};
const hint=code=>hints[code]||'企業を登録できませんでした。公式情報・既存企業の照合を確認してください。';
export const config={maxDuration:60};
const clean=val=>String(val??'').trim();
const sanitize=company=>({
  name:String(company.name||'').slice(0,200),
  corporateNumber:String(company.corporateNumber||''),
  address:String(company.address||'').slice(0,500),
  prefecture:String(company.prefecture||'').slice(0,100),
  website:safeMeetingWebsite(company.website)||'',
  industry:String(company.industry||'').slice(0,100),
  profileUrl:String(company.profileUrl||'').slice(0,500)
});
async function duplicates(db,tenant,rows){
  const numbers=[...new Set(rows.map(x=>x.corporateNumber).filter(corporateNumberOk))];
  if(!numbers.length)return [];
  const found=await db.schema('enger').from('companies')
    .select('id,corporate_number,name,deleted_at').in('corporate_number',numbers).limit(30);
  if(found.error)throw Error('existing_companies_unavailable');
  const ids=(found.data||[]).filter(x=>!x.deleted_at).map(x=>x.id);
  const scope=ids.length?await db.schema('enger').from('dx2_sales_company_directory_for_tenant')
    .select('id').eq('tenant_id',tenant).in('id',ids):{data:[],error:null};
  if(scope.error)throw Error('existing_company_scope_unavailable');
  const allowed=new Set((scope.data||[]).map(x=>x.id));
  const byNum=new Map((found.data||[]).map(x=>[x.corporate_number,x]));
  return rows.map(item=>{
    const row=byNum.get(item.corporateNumber);
    return {...sanitize(item),
      existingCompanyId:row&&!row.deleted_at&&allowed.has(row.id)?row.id:null,
      reviewExisting:Boolean(row&&(!allowed.has(row.id)||row.deleted_at))
    };
  });
}
export default async function handler(req,res){
  res.setHeader?.('Cache-Control','private, no-store');
  const user=await requireUser(req,res);if(!user)return;
  if(!['GET','POST'].includes(req.method))return methodNotAllowed(res,['GET','POST']);
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx)||!canAccessEightEngerDirectory(ctx))
    return json(res,403,{error:'forbidden',hint:'Salesの企業管理権限が必要です。'});
  const db=admin();
  if(req.method==='GET'){
    const u=new URL(req.url||'/','http://localhost'),mode=u.searchParams.get('mode');
    if(mode==='name'){
      const name=u.searchParams.get('name');
      if(!cleanSearchName(name))return json(res,400,{error:'invalid_name',hint:hint('invalid_name')});
      const fetched=await searchMeetingCompanies(name);
      if(!fetched.rows.length)return json(res,200,{results:[],configured:fetched.configured,
        error:fetched.error||'not_found',hint:hint(fetched.error||'not_found')});
      try{
        return json(res,200,{source:fetched.source,results:await duplicates(db,ctx.tenantId,fetched.rows),
          count:fetched.rows.length,note:'候補の法人番号と所在地を確認してください。'});
      }catch{return json(res,503,{error:'duplicate_check_unavailable',hint:'既存企業の照合ができません。登録はできません。'});}
    }
    if(mode==='number'){
      const number=clean(u.searchParams.get('number'));
      if(!corporateNumberOk(number))return json(res,400,{error:'invalid_number',hint:hint('invalid_number')});
      const found=await lookupMeetingCompanyNumber(number);
      if(!found.verified)return json(res,200,{verified:false,error:found.error,
        hint:hint(found.error||'not_found')});
      try{
        const [item]=await duplicates(db,ctx.tenantId,[found.official]);
        return json(res,200,{verified:true,source:found.source,company:item});
      }catch{return json(res,503,{error:'duplicate_check_unavailable',hint:'既存企業の照合ができません。登録はできません。'});}
    }
    return json(res,400,{error:'invalid_mode',hint:'検索方法を確認してください。'});
  }
  let body;try{body=await readJson(req);}catch{return json(res,400,{error:'invalid_json'});}
  if(body?.action!=='register'||!corporateNumberOk(body.corporateNumber)||!isUuid(body.requestKey))
    return json(res,400,{error:'invalid_registration',hint:'検索結果を選択し、確認してから登録してください。'});
  if(body.confirmed!==true)return json(res,409,{error:'confirmation_required',hint:'企業名・法人番号・所在地を確認してください。'});
  const official=await lookupMeetingCompanyNumber(body.corporateNumber);
  if(!official.verified)return json(res,503,{error:'official_not_verified',hint:hint(official.error||'not_found')});
  const c=official.official;
  if(!namesCompatible(c.name,body.expectedName||''))return json(res,409,{
    error:'legal_name_changed',hint:'公的企業名に変更があります。もう一度検索して確認してください。'});
  if(c.closed)return json(res,409,{error:'corporation_closed',hint:'登記記録が閉鎖されています。'});
  const website=safeMeetingWebsite(clean(body.website)||c.website);
  if(website===null)return json(res,400,{error:'invalid_website',hint:hint('invalid_website')});
  // Block a guessed company and do not write until duplicates are checked.
  let precheck;try{[precheck]=await duplicates(db,ctx.tenantId,[c]);}
  catch{return json(res,503,{error:'duplicate_check_unavailable',hint:'登録済み企業の照合に失敗しました。'});}
  if(precheck.reviewExisting)return json(res,409,{
    error:'existing_company_review_required',hint:'既存データに同じ法人番号があります。管理者が確認してください。'});
  if(precheck.existingCompanyId)return json(res,200,{
    created:false,existing:true,companyId:precheck.existingCompanyId,
    name:precheck.name,corporateNumber:precheck.corporateNumber
  });
  const payload={
    p_tenant:ctx.tenantId,p_actor:user.id,p_actor_name:ctx.employee?.display_name||user.email||'Sales',
    p_request:body.requestKey,p_corporate_number:c.corporateNumber,p_name:c.name,
    p_address:c.address||'',p_prefecture:c.prefecture||'',p_website:website||'',
    p_industry:c.industry||'',p_source:official.source,
  };
  const saved=await db.rpc('gw_sales_register_meeting_company',payload);
  if(saved.error){
    const message=String(saved.error.message||'');
    const code=Object.keys(hints).find(key=>message.includes(key));
    return json(res,saved.error.code==='42883'?503:409,{
      error:saved.error.code==='42883'?'registration_rpc_missing':code||'registration_failed',
      hint:saved.error.code==='42883'?'企業登録のDB設定が未適用です（db/173）。':hint(code)});
  }
  const result=saved.data||{};
  if(!isUuid(result.companyId))return json(res,503,{error:'invalid_registration_result',
    hint:'登録結果の企業IDを確認できません。重複操作せず、企業一覧から再検索してください。'});
  if(result.created){
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,
      action:'sales.company_meeting_registered',target:'enger_company:'+result.companyId,
      detail:{officialSource:official.source,corporateNumber:c.corporateNumber}}).catch(()=>{});
  }
  return json(res,200,{ok:true,created:Boolean(result.created),existing:Boolean(result.existing),
    companyId:result.companyId,salesCompanyId:result.salesCompanyId||null,
    displayId:result.displayId||null,name:result.name||c.name,
    corporateNumber:c.corporateNumber});
}
