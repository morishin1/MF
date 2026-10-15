// /api/hr/interview-materials — 面談とHR共通資料の紐付け（db/136）
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const SQL="db/136_hr_materials.sql";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req,res){
  const user=await requireUser(req,res); if(!user)return;
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId)return json(res,403,{error:"no_membership"});
  if(!canRecruit(ctx))return json(res,403,{error:"forbidden"});
  try{
    if(req.method==="GET")return get(req,res,ctx);
    if(req.method==="PUT")return put(req,res,ctx,user);
    return methodNotAllowed(res,["GET","PUT"]);
  }catch(e){
    const m=String(e?.message||e||"");
    if(/gw_hr_materials|gw_hr_interview_materials|relation .* does not exist/i.test(m))
      return json(res,503,{error:"not_ready",hint:`面談資料を使うには ${SQL} を Supabase に流してください`});
    return json(res,500,{error:"db_error",detail:m});
  }
}

async function get(req,res,ctx){
  const q=new URL(req.url,"http://localhost").searchParams;
  const interviewId=q.get("interviewId");
  if(!UUID.test(String(interviewId||"")))return json(res,400,{error:"invalid_interview"});
  const sb=admin();
  const {data:iv,error:ie}=await sb.from("gw_hr_interviews").select("id,tenant_id,kind")
    .eq("id",interviewId).eq("tenant_id",ctx.tenantId).maybeSingle();
  if(ie)throw ie; if(!iv)return json(res,404,{error:"not_found"});
  const {data,error}=await sb.from("gw_hr_interview_materials")
    .select("material_id,sort_order,gw_hr_materials(id,name,category,kind,url,filename,is_active,share_external)")
    .eq("interview_id",interviewId).order("sort_order");
  if(error)throw error;
  return json(res,200,{materials:(data||[]).map(x=>({...x.gw_hr_materials,sortOrder:x.sort_order})).filter(Boolean)});
}

async function put(req,res,ctx,user){
  const body=await readJson(req);
  const interviewId=String(body?.interviewId||"");
  if(!UUID.test(interviewId))return json(res,400,{error:"invalid_interview"});
  const ids=[...new Set(Array.isArray(body?.materialIds)?body.materialIds.map(String):[])];
  if(ids.some(id=>!UUID.test(id)))return json(res,400,{error:"invalid_material"});
  const sb=admin();
  const {data:iv,error:ie}=await sb.from("gw_hr_interviews").select("id,tenant_id")
    .eq("id",interviewId).eq("tenant_id",ctx.tenantId).maybeSingle();
  if(ie)throw ie; if(!iv)return json(res,404,{error:"not_found"});
  if(ids.length){
    const {data:mats,error:me}=await sb.from("gw_hr_materials").select("id,is_active")
      .eq("tenant_id",ctx.tenantId).in("id",ids);
    if(me)throw me;
    const got=new Set((mats||[]).filter(m=>m.is_active!==false).map(m=>m.id));
    if(ids.some(id=>!got.has(id)))return json(res,400,{error:"invalid_material",hint:"無効または別会社の資料が含まれています"});
  }
  const {error:de}=await sb.from("gw_hr_interview_materials").delete().eq("interview_id",interviewId);
  if(de)throw de;
  if(ids.length){
    const rows=ids.map((id,i)=>({interview_id:interviewId,material_id:id,sort_order:(i+1)*10,created_by:user.id}));
    const {error}=await sb.from("gw_hr_interview_materials").insert(rows); if(error)throw error;
  }
  await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.interview_materials",target:`hr_interview:${interviewId}`,detail:{count:ids.length}});
  return json(res,200,{ok:true,materialIds:ids});
}
