// HR スポット勤務人材：採用権限がある同一テナントの担当者だけ管理
import { randomBytes, createHash } from "node:crypto";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canRecruit } from "../../lib/gw.js";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SQL="db/145_hr_spot_talents.sql";
const FIELDS="id,name,source,worked_on,work_note,survey_sent_at,survey_answered_at,survey_expires_at,survey_answers,survey_email,survey_phone,contact_consent,staff_scores,staff_note,scored_at,status,applicant_id,deleted_at,created_at";
const LEGACY_FIELDS=FIELDS.replace("survey_phone,","").replace("deleted_at,","");
const needsMigration=(e)=>["42703","PGRST204","PGRST200"].includes(e?.code)
  || /survey_phone|deleted_at|gw_hr_spot_bulk/.test(String(e?.message||""));
const migrationMessage="db/146_hr_spot_bulk.sql をSupabaseに適用してください（未適用でも一覧は閲覧できます）。";
const text=(s,max)=>typeof s==="string"?s.trim().slice(0,max):"";
function error(res,e){
  const missing=["42P01","PGRST205"].includes(e?.code);
  const message=missing ? SQL+" の適用状態を確認してください"
    : e?.code==="23503" ? "保存者のアカウント情報を確認できません。HR管理者へお知らせください"
    : e?.code==="23514" ? "評価データが保存条件を満たしていません。入力内容を確認してください"
    : "保存先でエラーが発生しました。もう一度お試しください。続く場合は管理者に連絡してください";
  // SQLの詳細や候補者データは利用者に返さない。診断に必要なDBエラーコードだけ記録。
  console.error("[hr/spot] database error",e?.code||"unknown");
  return json(res,missing?503:500,{error:missing?"not_ready":"db_failed",message});
}
async function one(sb,tenantId,id){
  const {data,error:e}=await sb.from("gw_hr_spot_talents").select("*").eq("tenant_id",tenantId).eq("id",id).maybeSingle();
  return {data,error:e};
}
export default async function handler(req,res){
  const user=await requireUser(req,res); if(!user)return;
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!canRecruit(ctx))return json(res,403,{error:"forbidden"});
  res.setHeader("Cache-Control","private, no-store");
  const sb=admin();
  if(req.method==="GET"&&String(req.query?.summary||"")==="1"){
    const {count,error:e}=await sb.from("gw_hr_spot_talents").select("id",{count:"exact",head:true})
      .eq("tenant_id",ctx.tenantId).is("deleted_at",null);
    if(e&&needsMigration(e)){
      const fallback=await sb.from("gw_hr_spot_talents").select("id",{count:"exact",head:true})
        .eq("tenant_id",ctx.tenantId);
      if(fallback.error)return error(res,fallback.error);
      return json(res,200,{count:fallback.count||0,upgradeRequired:true});
    }
    if(e)return error(res,e);
    return json(res,200,{count:count||0});
  }
  if(req.method==="GET"){
    const {data,error:e}=await sb.from("gw_hr_spot_talents").select(FIELDS).eq("tenant_id",ctx.tenantId).order("worked_on",{ascending:false}).limit(500);
    if(e&&needsMigration(e)){
      const old=await sb.from("gw_hr_spot_talents").select(LEGACY_FIELDS).eq("tenant_id",ctx.tenantId).order("worked_on",{ascending:false}).limit(500);
      if(old.error)return error(res,old.error);
      return json(res,200,{people:(old.data||[]).map(p=>({...p,deleted_at:null,survey_phone:null})),
        upgradeRequired:true,message:migrationMessage});
    }
    if(e)return error(res,e);
    return json(res,200,{people:data||[]});
  }
  if(req.method!=="POST")return methodNotAllowed(res,["GET","POST"]);
  const b=await readJson(req);
  if(!b||typeof b!=="object")return json(res,400,{error:"invalid_body"});
  // db/146 の追加列を利用する一括・基本情報操作だけはSQL適用を必須とする。
  // 既存db/145にある評価・メモ保存を、新しい一括機能のSQL未適用だけで止めない。
  if(["create","bulk","edit"].includes(b.action)){
    const probe=await sb.from("gw_hr_spot_talents").select("id,survey_phone,deleted_at").eq("tenant_id",ctx.tenantId).limit(0);
    if(probe.error&&needsMigration(probe.error))return json(res,503,{error:"not_ready",message:migrationMessage});
    if(probe.error)return error(res,probe.error);
  }
  if(b.action==="create"){
    const name=text(b.name,100), source=text(b.source,80)||"タイミー", date=text(b.workedOn,10);
    if(!name||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)||Number.isNaN(Date.parse(date+"T00:00:00Z")))
      return json(res,400,{error:"required_fields",message:"氏名と正しい勤務日を入力してください"});
    // 同じタイミー表示名の二重登録を防止。登録済みなら本人詳細から続ける。
    const {data:already,error:duplicateError}=await sb.from("gw_hr_spot_talents")
      .select("id").eq("tenant_id",ctx.tenantId).eq("source",source).eq("name",name)
      .is("deleted_at",null).limit(1);
    if(duplicateError)return error(res,duplicateError);
    if(already?.length)return json(res,409,{error:"already_registered",existingId:already[0].id,
      message:"同じ名前・媒体のスポット人材が既に登録されています。一覧でその人を開いてください"});
    const {data,error:e}=await sb.from("gw_hr_spot_talents")
      .insert({tenant_id:ctx.tenantId,name,source,worked_on:date,work_note:text(b.workNote,500)||null,created_by:user.id})
      .select(FIELDS).single();
    if(e)return error(res,e);
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.spot_create",target:"hr_spot:"+data.id,detail:{source}});
    return json(res,200,{person:data});
  }
  if(b.action==="bulk"){
    const ids=b.ids;
    if(!Array.isArray(ids)||ids.length<1||ids.length>50||
      new Set(ids).size!==ids.length||ids.some(id=>typeof id!=="string"||!UUID.test(id)))
      return json(res,400,{error:"invalid_selection",message:"重複のない1〜50人を選択してください"});
    if(!["archive","restore","candidate","closed"].includes(b.bulkAction))
      return json(res,400,{error:"invalid_bulk_action"});
    const {data,error:e}=await sb.rpc("gw_hr_spot_bulk",{
      p_tenant:ctx.tenantId,p_ids:ids,p_action:b.bulkAction,p_actor:user.id
    });
    if(e){
      if(["PGRST202","42883"].includes(e.code))return json(res,503,{error:"not_ready",message:"db/146_hr_spot_bulk.sql を適用してください"});
      if(["22023","P0001"].includes(e.code))return json(res,409,{error:"bulk_not_allowed",
        message:"選択した中に操作できない人がいます。選考に引継ぎ済み・削除済み・同意/評価未完了の人を確認してください。全件変更していません。"});
      return error(res,e);
    }
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.spot_bulk_"+b.bulkAction,
      target:"hr_spot:bulk",detail:{count:data,ids}});
    return json(res,200,{ok:true,changed:data});
  }
  const id=text(b.id,40);
  if(!UUID.test(id))return json(res,400,{error:"invalid_id"});
  const {data:p,error:oe}=await one(sb,ctx.tenantId,id);
  if(oe)return error(res,oe);
  if(!p)return json(res,404,{error:"not_found"});
  if(p.deleted_at)return json(res,409,{error:"archived",message:"削除済みの人材です。復元してから操作してください"});
  if(b.action==="edit"){
    if(p.applicant_id||p.status==="converted")return json(res,409,{error:"read_only",message:"HRに引き継いだ人材は編集できません"});
    if((p.name!==String(b.name||"").trim()||p.source!==String(b.source||"").trim())){
      const {data:existing,error:de}=await sb.from("gw_hr_spot_talents").select("id")
        .eq("tenant_id",ctx.tenantId).eq("name",String(b.name||"").trim())
        .eq("source",String(b.source||"").trim()).is("deleted_at",null).neq("id",id).limit(1);
      if(de)return error(res,de);
      if(existing?.length)return json(res,409,{error:"already_registered",message:"同じ名前・媒体の人材が既に登録されています"});
    }
    const name=String(b.name||"").trim(),source=String(b.source||"").trim(),date=String(b.workedOn||"").trim();
    if(!name||name.length>100||!source||source.length>80||
      !/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+"T00:00:00Z"))||
      (b.workNote!=null&&String(b.workNote).length>500))
      return json(res,400,{error:"invalid_fields",message:"氏名・勤務日・媒体・メモの入力を確認してください"});
    const {data:changed,error:e}=await sb.from("gw_hr_spot_talents")
      .update({name,source,worked_on:date,work_note:text(b.workNote,500)||null,updated_at:new Date().toISOString()})
      .eq("tenant_id",ctx.tenantId).eq("id",id).is("deleted_at",null).is("applicant_id",null)
      .select("id").maybeSingle();
    if(e)return error(res,e);
    if(!changed)return json(res,409,{error:"concurrent_update",message:"別の操作が行われました。再読み込みしてください"});
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.spot_edit",target:"hr_spot:"+id,detail:{fields:["name","source","worked_on","work_note"]}});
    return json(res,200,{ok:true});
  }
  if(b.action==="invite"){
    if(p.survey_answered_at||p.applicant_id||p.status==="closed")return json(res,409,{error:"already_completed",message:"回答済み・移行済み・終了済みの人には再発行できません"});
    const token=randomBytes(32).toString("hex"), hash=createHash("sha256").update(token).digest("hex");
    const expires=new Date(Date.now()+14*86400000).toISOString();
    const {error:e}=await sb.from("gw_hr_spot_talents").update({
      survey_token_hash:hash,survey_expires_at:expires,survey_sent_at:new Date().toISOString(),status:"invited",updated_at:new Date().toISOString()
    }).eq("tenant_id",ctx.tenantId).eq("id",id).is("survey_answered_at",null);
    if(e)return error(res,e);
    return json(res,200,{url:"/hr/spot-survey.html#token="+token,expiresAt:expires});
  }
  if(b.action==="score"||b.action==="note"){
    if(p.applicant_id||p.status==="closed")return json(res,409,{
      error:"read_only",message:"終了・選考へ移動済みの人材は、この画面から評価を変更できません"});
    if(typeof b.note!=="string"||b.note.length>1000)
      return json(res,400,{error:"invalid_note",message:"評価メモは1000文字以内で入力してください"});
    if(b.action==="score"&&(!Array.isArray(b.scores)||b.scores.length!==5||
       b.scores.some(v=>!Number.isInteger(v)||v<1||v>5)))
      return json(res,400,{error:"invalid_scores",message:"5項目すべてを1〜5点で評価してください"});
    const changes={
      staff_note:text(b.note,1000)||null,updated_at:new Date().toISOString()
    };
    if(b.action==="score"){
      Object.assign(changes,{
        staff_scores:b.scores,scored_by:user.id,scored_at:new Date().toISOString(),
        status:p.status==="candidate"?"candidate":"evaluated"
      });
    }
    const {data:saved,error:e}=await sb.from("gw_hr_spot_talents")
      .update(changes).eq("tenant_id",ctx.tenantId).eq("id",id)
      .select("id,staff_scores,staff_note,scored_at,status").maybeSingle();
    if(e)return error(res,e);
    if(!saved)return json(res,409,{error:"stale_record",
      message:"保存対象を確認できません。画面を再読み込みしてからお試しください"});
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,
      action:b.action==="score"?"hr.spot_score":"hr.spot_note",
      target:"hr_spot:"+id,detail:{hasScores:Array.isArray(saved.staff_scores)}});
    return json(res,200,{ok:true,person:saved});
  }
  if(b.action==="mark"){
    if(!["candidate","closed"].includes(b.status)||p.applicant_id)return json(res,400,{error:"invalid_status"});
    if(b.status==="candidate"&&(!Array.isArray(p.staff_scores)||p.staff_scores.length!==5))
      return json(res,409,{error:"evaluation_required",message:"先に社員評価の5項目を保存してください"});
    if(b.status==="candidate"&&(!p.contact_consent||!p.survey_answered_at||!["ぜひ継続したい","条件が合えば"].includes(p.survey_answers?.longTerm)))
      return json(res,409,{error:"consent_required",message:"本人アンケートの連絡同意が必要です"});
    const {error:e}=await sb.from("gw_hr_spot_talents").update({status:b.status,updated_at:new Date().toISOString()})
      .eq("tenant_id",ctx.tenantId).eq("id",id);
    if(e)return error(res,e);
    return json(res,200,{ok:true});
  }
  if(b.action==="promote"){
    if(p.applicant_id)return json(res,409,{error:"already_converted",applicantId:p.applicant_id});
    if(p.status!=="candidate"||!p.contact_consent||!p.survey_answered_at||!EMAIL.test(p.survey_email||""))
      return json(res,409,{error:"consent_required",message:"本人同意・メールアドレス・採用候補への登録が必要です"});
    const email=p.survey_email.toLowerCase();
    // 同じ連絡先を既存の応募者へ無条件で複製しない
    const {data:existing,error:dupeErr}=await sb.from("gw_hr_applicants").select("id")
      .eq("tenant_id",ctx.tenantId).ilike("email",email.replace(/[\\%_]/g,x=>"\\"+x)).limit(1);
    if(dupeErr)return error(res,dupeErr);
    if(existing?.length)return json(res,409,{error:"existing_applicant",message:"同じメールアドレスの応募者が既に存在します。既存応募者を確認してください"});
    const {data:a,error:ce}=await sb.from("gw_hr_applicants").insert({
      tenant_id:ctx.tenantId,name:p.name,email,source:p.source,job_title:"AI・IT営業アシスタント",
      stage:"applied",status:"todo",created_by:user.id,
      note:"スポット勤務から長期採用選考へ移行。勤務日: "+p.worked_on
    }).select("id").single();
    if(ce)return error(res,ce);
    const {data:claimed,error:ue}=await sb.from("gw_hr_spot_talents")
      .update({status:"converted",applicant_id:a.id,updated_at:new Date().toISOString()})
      .eq("tenant_id",ctx.tenantId).eq("id",id).is("applicant_id",null).eq("status","candidate").select("id").maybeSingle();
    if(ue||!claimed){
      // 同時操作の二重応募者を残さない。既存 applicant への昇格が失敗したので新規分のみ取り消す
      await sb.from("gw_hr_applicants").delete().eq("tenant_id",ctx.tenantId).eq("id",a.id);
      return json(res,409,{error:"concurrent_update",message:"別の操作が行われました。再読み込みしてください"});
    }
    await sb.from("gw_hr_timeline").insert({tenant_id:ctx.tenantId,applicant_id:a.id,event_key:"applied",label:"スポット勤務から選考へ",created_by:user.id});
    await gwLog({tenantId:ctx.tenantId,actorId:user.id,action:"hr.spot_promote",target:"hr_applicant:"+a.id,detail:{source:p.source}});
    return json(res,200,{ok:true,applicantId:a.id});
  }
  return json(res,400,{error:"invalid_action"});
}
