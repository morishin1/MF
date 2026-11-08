// Daily goal confirmations: distinguish verified employee choice from AI suggestion.
import { jstDate, isDate, weekStart } from "./nippo.js";
export const ROLLOUT_DATE="2026-11-09";
export const requiredGoal=(body)=>{
  const taskTitle=String(body?.taskTitle||"").trim();
  const goalText=String(body?.goalText||"").trim();
  const doneWhen=String(body?.doneWhen||"").trim();
  if(taskTitle.length<2||taskTitle.length>300)return {error:"今日の仕事を2〜300字で入力してください"};
  if(goalText.length<5||goalText.length>500)return {error:"目指す結果を5〜500字で入力してください"};
  if(doneWhen.length<5||doneWhen.length>500)return {error:"完了条件を5〜500字で入力してください"};
  return {taskTitle,goalText,doneWhen};
};
export const timingFor=(date,{today=jstDate(),hour=new Date(Date.now()+9*3600000).getUTCHours(),forceLate=false}={})=>
  forceLate||date<today||hour>=16?"late":"on_time";
export const goalStatus=(report,confirmation,date)=>{
  if(confirmation?.goal_text?.trim()&&confirmation?.done_when?.trim())return "confirmed";
  // Existing historical morning reports are grandfathered: don't ask people to enter a new goal.
  if(date<ROLLOUT_DATE && report?.morning_at&&report?.goal_image?.trim()&&report?.top_priority?.trim())return "legacy";
  return "missing";
};
export const shouldEnforceGoal=(date,report)=>isDate(date)&&date>=ROLLOUT_DATE&&!report?.submitted_at;
export const isRetrospectiveGoal=(row)=>row?.timing==="late";
export const goalWeek=weekStart;
