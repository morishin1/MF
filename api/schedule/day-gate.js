// 日報入力欄を開く前の予定登録確認。必ず本人分だけを返す。
import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { checkNextWorkSchedule } from "../../lib/schedule-gate.js";

export default async function handler(req,res){
  if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
  const user=await requireUser(req,res);
  if(!user)return;
  const ctx=await gwContext(user.id);
  if(!ctx.tenantId||!ctx.employee)return json(res,403,{error:"not_enrolled"});
  const date=new URL(req.url,"http://localhost").searchParams.get("date");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date||""))return json(res,400,{error:"invalid_date"});
  const state=await checkNextWorkSchedule(admin(),ctx,date);
  if(state.error)return json(res,503,{error:"schedule_check_unavailable",hint:"予定を確認できません。時間をおいて再確認してください。"});
  res.setHeader?.("Cache-Control","no-store");
  return json(res,200,state);
}
