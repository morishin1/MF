// ログイン不要の本人回答：256-bit乱数トークンのハッシュ照合。自社HRのデータを公開しない。
import { createHash } from "node:crypto";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
const TOKEN=/^[a-f0-9]{64}$/;
const EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE=/^[0-9+()\-\s]{9,24}$/;
const choices={
  experience:["とても楽しかった","楽しかった","普通","少し合わなかった"],
  longTerm:["ぜひ継続したい","条件が合えば","単発のみ","希望しない"],
  weekly:["週1日","週2〜3日","週4〜5日","相談したい","希望しない／未定"],
  start:["すぐに","1週間以内","1か月以内","未定"]
};
const days=["月","火","水","木","金","土","日"];
const hours=["9:00〜13:00","13:00〜17:00","9:00〜17:00","相談"];
const interests=["AI活用","企業フォロー","営業支援","IT・AI企画","AIまち","事務・入力","幅広く"];
function validList(v,options){return Array.isArray(v)&&v.length<=options.length&&v.every(s=>options.includes(s));}
export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("X-Content-Type-Options","nosniff");
  if(req.method!=="POST")return methodNotAllowed(res,["POST"]);
  const b=await readJson(req);
  const token=b?.token;
  if(typeof token!=="string"||!TOKEN.test(token))return json(res,404,{error:"not_found"});
  const hash=createHash("sha256").update(token).digest("hex");
  const sb=admin();
  const {data:p,error:e}=await sb.from("gw_hr_spot_talents")
    .select("id,name,tenant_id,survey_expires_at,survey_answered_at,status,deleted_at,survey_phone")
    .eq("survey_token_hash",hash).maybeSingle();
  if(e)return json(res,503,{error:"not_ready",message:"現在、アンケート機能を更新中です。管理者にお問い合わせください。"});
  if(!p||!p.survey_expires_at||new Date(p.survey_expires_at).getTime()<Date.now()||p.survey_answered_at||p.status==="closed"||p.status==="converted"||p.deleted_at)
    return json(res,410,{error:"expired",message:"このアンケートURLは期限切れか回答済みです。"});
  if(b?.action==="check")return json(res,200,{ok:true,name:p.name});
  if(b?.action!=="submit")return json(res,400,{error:"invalid_action"});
  const a=b.answers;
  if(!a||!Object.keys(choices).every(k=>choices[k].includes(a[k]))
    ||!validList(a.days,days)||!validList(a.hours,hours)||!validList(a.interests,interests)
    ||typeof a.comment!=="string"||a.comment.length>500
    ||typeof a.contactConsent!=="boolean")
    return json(res,400,{error:"invalid_answers",message:"選択内容を確認してください"});
  const email=typeof a.email==="string"?a.email.trim().toLowerCase():"";
  const phone=typeof a.phone==="string"?a.phone.trim():"";
  if(a.contactConsent&&(!EMAIL.test(email)||email.length>200))
    return json(res,400,{error:"email_required",message:"継続勤務の案内を希望する場合はメールアドレスを入力してください"});
  if(a.contactConsent&&!PHONE.test(phone))
    return json(res,400,{error:"phone_required",message:"継続勤務の案内を希望する場合は電話番号を入力してください"});
  const answer={experience:a.experience,longTerm:a.longTerm,weekly:a.weekly,
    days:a.days,hours:a.hours,interests:a.interests,start:a.start,comment:a.comment};
  const {data:updated,error:ue}=await sb.from("gw_hr_spot_talents").update({
    survey_answers:answer,survey_email:a.contactConsent?email:null,survey_phone:a.contactConsent?phone:null,contact_consent:a.contactConsent,
    survey_answered_at:new Date().toISOString(),status:"answered",
    updated_at:new Date().toISOString()
  }).eq("id",p.id).eq("tenant_id",p.tenant_id).eq("survey_token_hash",hash).is("survey_answered_at",null)
    .select("id").maybeSingle();
  if(ue)return json(res,503,{error:"save_failed"});
  if(!updated)return json(res,409,{error:"already_answered"});
  return json(res,200,{ok:true});
}
