// HR共通パートナー実証: 社内管理者だけが扱う。外部パートナー向け公開APIではない。
// 社員/応募者/BP企業の既存マスターを改変しない。送信、支払、外部アクセス権発行は行わない。
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit, canManageHr } from "../../lib/gw.js";
import { aalOf } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { ymd as jstYmd } from "../../lib/jst.js";

const SQL = "db/183_hr_external_partner_pilot.sql";
const PARTNERS = "gw_hr_external_partners";
const WORK = "gw_hr_partner_work";
const BUDGET = "gw_hr_partner_pilot_budget";
const AUDIT = "gw_hr_partner_audit_events";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TYPES = new Set(["research","appointment","matching","sales","content","local_support","other"]);
const STYLES = new Set(["side_job","remote","professional"]);
const PROGRAMS = new Set(["enger","aimachi"]);
const P_FIELDS = "id,display_name,email,programs,work_style,skills_note,status,nda_reference,contract_reference,nda_confirmed_at,contract_confirmed_at,created_at,updated_at";
const W_FIELDS = "id,partner_id,program,work_type,title,source_reference,status,planned_revenue_yen,planned_direct_cost_yen,planned_partner_fee_yen,actual_revenue_yen,actual_direct_cost_yen,confirmed_partner_fee_yen,accepted_at,completed_on,created_at,updated_at";
const B_FIELDS = "investment_ceiling_yen,monthly_fixed_ceiling_yen,spent_initial_yen,spent_monthly_fixed_yen,updated_at";

const safeText = (x, max) => typeof x === "string" && x.trim().length > 0 && x.trim().length <= max ? x.trim() : null;
const amount = (x) => Number.isSafeInteger(Number(x)) && x !== "" && x !== null
  && Number(x) >= 0 && Number(x) <= 1000000000 ? Number(x) : null;
const isUuid = x => typeof x === "string" && UUID.test(x);
const validPrograms = p => Array.isArray(p) && p.length >= 1 && p.length <= 2
  && new Set(p).size === p.length && p.every(x => PROGRAMS.has(x));
const isOwner = ctx => (ctx.roles || []).includes("owner");
const dbError = (res, error, empty = {}) => {
  const hint = dbSetupHint(error, SQL);
  if (hint) return json(res, 503, { error:"not_ready", message:hint, ...empty });
  if (error?.code === "23505") return json(res, 409, { error:"duplicate", message:"すでに登録されています" });
  if (error?.code === "23503") return json(res, 409, { error:"invalid_reference" });
  return json(res, error?.code === "42501" ? 403 : 500, { error:"database_error" });
};
async function log(ctx, user, entityType, id, action, details = {}) {
  // 名前・メール・顧客名は監査イベントに残さない。
  const row = { tenant_id:ctx.tenantId, actor_id:user.id, entity_type:entityType,
    entity_id:id, action, details };
  const { error } = await admin().from(AUDIT).insert(row);
  if (error) console.error("[hr-partner-audit]", error.code);
  await gwLog({ tenantId:ctx.tenantId, actorId:user.id,
    action:"hr.partner_"+action, target:entityType+":"+id, detail:details });
}
function partnerShape(x) {
  return { id:x.id, name:x.display_name, email:x.email, programs:x.programs,
    workStyle:x.work_style, skills:x.skills_note, status:x.status,
    ndaConfirmed:!!x.nda_confirmed_at, contractConfirmed:!!x.contract_confirmed_at,
    ndaReference:x.nda_reference||"", contractReference:x.contract_reference||"",
    createdAt:x.created_at, updatedAt:x.updated_at };
}
function workShape(x) {
  return {id:x.id, partnerId:x.partner_id, program:x.program, workType:x.work_type,
    title:x.title, reference:x.source_reference||"", status:x.status,
    plannedRevenue:Number(x.planned_revenue_yen), plannedCost:Number(x.planned_direct_cost_yen),
    plannedFee:Number(x.planned_partner_fee_yen),
    actualRevenue:x.actual_revenue_yen==null?null:Number(x.actual_revenue_yen),
    actualCost:x.actual_direct_cost_yen==null?null:Number(x.actual_direct_cost_yen),
    confirmedFee:x.confirmed_partner_fee_yen==null?null:Number(x.confirmed_partner_fee_yen),
    acceptedAt:x.accepted_at, completedOn:x.completed_on, createdAt:x.created_at };
}
function budgetShape(x) {
  return { investmentCeiling:Number(x?.investment_ceiling_yen??300000),
    fixedCeiling:Number(x?.monthly_fixed_ceiling_yen??50000),
    spentInitial:Number(x?.spent_initial_yen??0), spentFixed:Number(x?.spent_monthly_fixed_yen??0),
    updatedAt:x?.updated_at||null };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canRecruit(ctx) || !canManageHr(ctx))
    return json(res, 403, { error:"forbidden" });
  // 個人の連絡先・契約・報酬を扱う新設機能は、既存のMFA全体スイッチにかかわらず aal2 を必須とする。
  if (aalOf(req) !== "aal2")
    return json(res, 403, { error:"mfa_required", message:"パートナー管理は二段階認証後に利用できます。" });
  const sb = admin();
  if (req.method === "GET") return list(res, sb, ctx);
  if (req.method === "POST") return create(req, res, sb, ctx, user);
  if (req.method === "PATCH") return update(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET","POST","PATCH"]);
}

async function list(res, sb, ctx) {
  const [p,w,b] = await Promise.all([
    sb.from(PARTNERS).select(P_FIELDS).eq("tenant_id",ctx.tenantId)
      .order("created_at",{ascending:false}).limit(250),
    sb.from(WORK).select(W_FIELDS).eq("tenant_id",ctx.tenantId)
      .order("created_at",{ascending:false}).limit(400),
    sb.from(BUDGET).select(B_FIELDS).eq("tenant_id",ctx.tenantId).maybeSingle()
  ]);
  if (p.error || w.error || b.error) return dbError(res, p.error||w.error||b.error);
  return json(res,200,{partners:(p.data||[]).map(partnerShape), work:(w.data||[]).map(workShape),
    budget:budgetShape(b.data), limited:(p.data||[]).length===250 || (w.data||[]).length===400,
    // このAPIは報酬承認・振込をしない。予算は入力済み金額のみ。
    payoutEnabled:false });
}

async function create(req, res, sb, ctx, user) {
  const b = await readJson(req);
  if (b?.action === "partner") {
    const name=safeText(b.name,120), email=safeText(b.email,254)?.toLowerCase();
    if (!name || !EMAIL.test(email||"") || !validPrograms(b.programs)
        || !STYLES.has(b.workStyle) || (b.skills && !safeText(b.skills,1000)))
      return json(res,400,{error:"invalid_partner"});
    const row={tenant_id:ctx.tenantId,display_name:name,email,
      programs:b.programs,work_style:b.workStyle,skills_note:String(b.skills||"").trim(),
      created_by:user.id};
    const {data,error}=await sb.from(PARTNERS).insert(row).select(P_FIELDS).single();
    if(error)return dbError(res,error);
    await log(ctx,user,"partner",data.id,"registered",{programs:data.programs});
    return json(res,200,{partner:partnerShape(data)});
  }
  if (b?.action === "work") {
    if (!isUuid(b.partnerId) || !PROGRAMS.has(b.program) || !TYPES.has(b.workType))
      return json(res,400,{error:"invalid_work"});
    const title=safeText(b.title,160), reference=b.reference?safeText(b.reference,160):null;
    const revenue=amount(b.plannedRevenue), cost=amount(b.plannedCost), fee=amount(b.plannedFee);
    if (!title || (b.reference && !reference) || [revenue,cost,fee].some(x=>x===null))
      return json(res,400,{error:"invalid_work_values"});
    const {data:partner,error:pe}=await sb.from(PARTNERS)
      .select("id,status,programs").eq("tenant_id",ctx.tenantId).eq("id",b.partnerId).maybeSingle();
    if(pe)return dbError(res,pe);
    if(!partner || !partner.programs.includes(b.program))return json(res,404,{error:"partner_not_available"});
    if(partner.status!=="active")return json(res,409,{error:"partner_contract_required",
      message:"契約と秘密保持を確認し稼働中にしてから業務を作成してください"});
    // 直接収益のない作業も計画登録可能。発注・支払は別承認。負の見込みはUIと管理画面で可視化する。
    const row={tenant_id:ctx.tenantId,partner_id:b.partnerId,program:b.program,
      work_type:b.workType,title,source_reference:reference,planned_revenue_yen:revenue,
      planned_direct_cost_yen:cost,planned_partner_fee_yen:fee,created_by:user.id};
    const {data,error}=await sb.from(WORK).insert(row).select(W_FIELDS).single();
    if(error)return dbError(res,error);
    await log(ctx,user,"work",data.id,"planned",{program:data.program,partnerId:data.partner_id,
      plannedRevenue:revenue,plannedCost:cost,plannedFee:fee});
    return json(res,200,{work:workShape(data)});
  }
  return json(res,400,{error:"unknown_action"});
}

async function update(req, res, sb, ctx, user) {
  const b=await readJson(req);
  if (b?.action==="budget") {
    if (!isOwner(ctx))return json(res,403,{error:"owner_required"});
    const initial=amount(b.investmentCeiling),fixed=amount(b.fixedCeiling),
      spentInitial=amount(b.spentInitial),spentFixed=amount(b.spentFixed);
    if([initial,fixed,spentInitial,spentFixed].some(x=>x===null)
       || initial>100000000||fixed>100000000||spentInitial>100000000||spentFixed>100000000)
      return json(res,400,{error:"invalid_budget"});
    const {data,error}=await sb.from(BUDGET).upsert({tenant_id:ctx.tenantId,
      investment_ceiling_yen:initial,monthly_fixed_ceiling_yen:fixed,
      spent_initial_yen:spentInitial,spent_monthly_fixed_yen:spentFixed,
      updated_at:new Date().toISOString(),updated_by:user.id},{onConflict:"tenant_id"})
      .select(B_FIELDS).single();
    if(error)return dbError(res,error);
    await log(ctx,user,"budget",null,"updated",{initial,fixed,spentInitial,spentFixed});
    return json(res,200,{budget:budgetShape(data)});
  }
  if (b?.action==="activate" || b?.action==="suspend") {
    if (!isUuid(b.id))return json(res,400,{error:"invalid_partner_id"});
    const {data:current,error:pe}=await sb.from(PARTNERS).select("*")
      .eq("tenant_id",ctx.tenantId).eq("id",b.id).maybeSingle();
    if(pe)return dbError(res,pe);
    if(!current)return json(res,404,{error:"not_found"});
    let change;
    if(b.action==="activate"){
      if(!["screening","approved","suspended"].includes(current.status))
        return json(res,409,{error:"invalid_transition"});
      const nda=safeText(b.ndaReference,300),contract=safeText(b.contractReference,300);
      if(!nda||!contract)return json(res,400,{error:"contract_required",
        message:"秘密保持と業務委託の合意済み文書の管理番号が必要です"});
      change={status:"active",nda_reference:nda,contract_reference:contract,
        nda_confirmed_at:new Date().toISOString(),
        contract_confirmed_at:new Date().toISOString(),confirmed_by:user.id};
    }else{
      if(current.status!=="active")return json(res,409,{error:"invalid_transition"});
      if(!safeText(b.reason,300))return json(res,400,{error:"reason_required"});
      change={status:"suspended"};
    }
    const {data,error}=await sb.from(PARTNERS)
      .update({...change,updated_at:new Date().toISOString()})
      .eq("id",current.id).eq("tenant_id",ctx.tenantId).eq("status",current.status)
      .select(P_FIELDS).maybeSingle();
    if(error)return dbError(res,error);
    if(!data)return json(res,409,{error:"concurrent_update"});
    await log(ctx,user,"partner",current.id,b.action,{status:data.status,
      ...(b.action==="suspend"?{reason:b.reason.trim().slice(0,300)}:{contractVerified:true})});
    return json(res,200,{partner:partnerShape(data)});
  }
  if (b?.action==="advanceWork") {
    if(!isUuid(b.id))return json(res,400,{error:"invalid_work_id"});
    const {data:current,error:we}=await sb.from(WORK).select("*")
      .eq("tenant_id",ctx.tenantId).eq("id",b.id).maybeSingle();
    if(we)return dbError(res,we);
    if(!current)return json(res,404,{error:"not_found"});
    const next={planned:"assigned",assigned:"submitted",submitted:"accepted"}[current.status];
    if(!next || b.to!==next)return json(res,409,{error:"invalid_transition"});
    const {data:partner}=await sb.from(PARTNERS).select("status")
      .eq("tenant_id",ctx.tenantId).eq("id",current.partner_id).maybeSingle();
    if(!partner || partner.status!=="active")
      return json(res,409,{error:"partner_inactive"});
    let change={status:next,updated_at:new Date().toISOString()};
    if(next==="accepted"){
      if(!isOwner(ctx))return json(res,403,{error:"owner_required"});
      const revenue=amount(b.actualRevenue),cost=amount(b.actualCost),fee=amount(b.confirmedFee);
      if([revenue,cost,fee].some(x=>x===null))
        return json(res,400,{error:"actuals_required"});
      // 実績承認は台帳への記録だけ。契約・請求・支払の自動実行をしない。
      change={...change,actual_revenue_yen:revenue,actual_direct_cost_yen:cost,
        confirmed_partner_fee_yen:fee,accepted_at:new Date().toISOString(),
        accepted_by:user.id,completed_on:jstYmd()};
    }
    const {data,error}=await sb.from(WORK).update(change)
      .eq("id",current.id).eq("tenant_id",ctx.tenantId).eq("status",current.status)
      .select(W_FIELDS).maybeSingle();
    if(error)return dbError(res,error);
    if(!data)return json(res,409,{error:"concurrent_update"});
    await log(ctx,user,"work",data.id,"advanced",{status:data.status,program:data.program});
    return json(res,200,{work:workShape(data)});
  }
  return json(res,400,{error:"unknown_action"});
}
