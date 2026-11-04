// GET /api/sales/appointment-targets?limit=50
// Salesの既存企業1社を1行とする読み取り専用リスト。
// ENGERの7,197社を自動でSalesへ登録・自動名寄せしない。
import {json,methodNotAllowed} from "../../lib/http.js";
import {requireUser} from "../../lib/auth.js";
import {gwContext,canSell} from "../../lib/gw.js";
import {userClient,admin} from "../../lib/supabase.js";
import {selectAppointmentTargets} from "../../lib/sales-appointment-targets.js";

const PAGE=500;
const LIMITS={companies:5000,proposals:5000,meetings:5000,links:5000,legacy:1000};
async function allRows(makeQuery, max) {
  const all=[];
  for(let from=0;from<max;from+=PAGE) {
    const {data,error,count}=await makeQuery().order("id",{ascending:true})
      .range(from,from+PAGE-1);
    if(error)return {error};
    if(count==null)return {error:{message:"件数の完全性を確認できません。"}};
    if(count>max)return {error:{message:"集計対象が安全上限を超えています。省略した順位を表示しません。"}};
    all.push(...(data||[]));
    if(all.length>=count)break;
    if(!data?.length)return {error:{message:"全件を読み取れなかったため順位を表示しません。"}};
  }
  return {rows:all};
}
export default async function handler(req,res) {
  const user=await requireUser(req,res);if(!user)return;
  if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
  res.setHeader?.("Cache-Control","private, no-store");
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canSell(ctx))return json(res,403,{error:"forbidden"});
  const sp=new URL(req.url||"/","http://localhost").searchParams;
  const limit=Number(sp.get("limit")||50);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100)
    return json(res,400,{error:"invalid_limit",hint:"limitは1〜100件です。"});
  try {
    const sb=userClient(req),db=admin(),tenant=ctx.tenantId;
    // 全候補を同じtenantのRLS付きクエリで取得。ページ境界に依存した順位を作らない。
    // 操作に必要な個人連絡先は返さない（電話番号は有無だけ）。
    const [companies,proposals,meetings,links,legacy]=await Promise.all([
      allRows(()=>sb.from("gw_sales_companies").select(
        "id,name,domain,site_url,form_url,industry,region,status,owner_id,hidden_at,ng_reason,click_count,last_click_at,last_sent_at,followed_at,next_action_on,phone",
        {count:"exact"}).eq("tenant_id",tenant),LIMITS.companies),
      allRows(()=>sb.from("gw_sales_proposals").select(
        "id,company_id,status,sent_at,updated_at,contact_stop",
        {count:"exact"}).eq("tenant_id",tenant).is("archived_at",null),LIMITS.proposals),
      allRows(()=>sb.from("gw_sales_meetings").select(
        "id,company_id,status",
        {count:"exact"}).eq("tenant_id",tenant),LIMITS.meetings),
      allRows(()=>sb.from("gw_sales_company_links").select(
        "id,company_id,source_system,source_company_id",
        {count:"exact"}).eq("tenant_id",tenant).eq("source_system","enger"),LIMITS.links),
      allRows(()=>db.schema("enger").from("dx2_legacy_company_sources").select(
        "external_key,name_normalized,matched_company_id",
        {count:"exact"}).eq("hard_suppressed",true),LIMITS.legacy),
    ]);
    const failed=[["企業",companies],["提案",proposals],["面談",meetings],["ENGER企業ID対応",links],["配信停止",legacy]]
      .find(([,value])=>value.error);
    if(failed)return json(res,503,{error:"appointment_targets_unavailable",
      hint:`${failed[0]}データを安全に取得できません。欠損した順位は表示しません。`});
    const byLink=new Map((links.rows||[]).map(row=>[row.company_id,row.source_company_id]));
    const scoped=companies.rows.map(c=>({...c,enger_company_id:byLink.get(c.id)||null}));
    const result=selectAppointmentTargets({
      companies:scoped,proposals:proposals.rows,meetings:meetings.rows,
      legacyStops:legacy.rows,limit,
    });
    return json(res,200,{
      ...result,
      source:"sales_existing_companies",
      sourceCounts:{salesCompanies:scoped.length,engerLinkedCompanies:byLink.size},
      complete:true,
      caveat:"ENGER企業とSales企業のID照合が未確定の企業は、Salesに自動追加していません。企業ID不明の提案を営業実績として推定計上していません。",
    });
  }catch{
    return json(res,503,{error:"appointment_targets_unavailable",hint:"営業候補を取得できません。権限・接続を確認してください。"});
  }
}
