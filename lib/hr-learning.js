import {validateTrialFit} from './hr-trial-fit.js';
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY=86400000;
export const todayJst=(now=Date.now())=>new Date(now+9*3600000).toISOString().slice(0,10);
export function trialDates(plan,now=Date.now()){
 if(!plan?.startOn)return null;
 const start=Date.parse(plan.startOn+'T00:00:00Z'),today=Date.parse(todayJst(now)+'T00:00:00Z');
 const day=Math.floor((today-start)/DAY)+1;
 return {day:Math.max(0,day),remaining:Math.max(0,14-Math.max(0,day)),active:day>=1&&day<=14,checkpoint:day>=14?'day14':day>=7?'day7':null};
}
export function validatePlan(p){
 if(!p||typeof p!=='object'||!/^\d{4}-\d{2}-\d{2}$/.test(p.startOn||''))return {error:'invalid_start_date'};
 const date=new Date(p.startOn+'T00:00:00Z');
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==p.startOn)return {error:'invalid_start_date'};
 const endOn=new Date(date.getTime()+13*DAY).toISOString().slice(0,10);
 if(!Array.isArray(p.goals)||!p.goals.length||p.goals.length>20)return {error:'invalid_goals'};
 const goals=[];
 for(const g of p.goals){
  if(typeof g?.label!=='string'||!g.label.trim()||g.label.length>200||!Number.isFinite(g.target)||g.target<=0||g.target>100000||!Number.isFinite(g.current)||g.current<0||g.current>100000)return {error:'invalid_goals'};
  goals.push({label:g.label.trim(),target:g.target,current:g.current});
 }
 return {value:{startOn:p.startOn,endOn,goals}};
}
export function goalPercent(plan){return plan?.goals?.length?Math.round(plan.goals.reduce((s,g)=>s+Math.min(1,g.current/g.target),0)/plan.goals.length*100):null;}
export function validateReview(body,plan,now=Date.now()){
 if(!['day7','day14'].includes(body?.checkpoint)||!plan)return {error:'invalid_checkpoint'};
 const dates=trialDates(plan,now);
 if(dates.day<(body.checkpoint==='day7'?7:14))return {error:'checkpoint_not_due'};
 const fit=validateTrialFit(body.evaluation);if(fit.error)return fit;
 if(typeof body.evaluation?.note!=='string'||body.evaluation.note.length>2000)return {error:'invalid_note'};
 return {value:{checkpoint:body.checkpoint,evaluation:{...fit,note:body.evaluation.note.trim(),recordedAt:new Date(now).toISOString()}}};
}
// Bindings survive applicant email edits: never silently read another learner's account.
export function learningView(applicant,state,lms,now=Date.now()){
 const email=String(applicant.email||'').trim().toLowerCase();
 const boundMismatch=Boolean(state?.lms_email&&state.lms_email!==email)||Boolean(state?.lms_user_id&&lms?.userId&&state.lms_user_id!==lms.userId);
 const verified=!boundMismatch&&lms?.status==='verified';
 const courses=verified&&Array.isArray(lms.courses)?lms.courses.map(safeCourse).filter(Boolean):[];
 const started=verified&&courses.some(c=>c.started);
 const manual=typeof state?.participation==='boolean'?state.participation:null;
 const participation=started?'on':manual===true?'on':manual===false&&verified?'off':'unknown';
 const dates=trialDates(state?.plan,now);
 const due=dates?.checkpoint&&!state?.reviews?.[dates.checkpoint];
 return {id:applicant.id,name:applicant.name,email:applicant.email,version:state?.version||0,
  participation,source:started?'LMS':manual===true?'HR':manual===false&&verified?'HR':'未確認',
  lmsStatus:verified?'verified':'unknown',reason:boundMismatch?'identity_changed':lms?.reason||(!verified?'learning_unavailable':null),
  courses,plan:state?.plan||null,reviews:state?.reviews||{},dates,goalPercent:goalPercent(state?.plan),
  evaluationStatus:due?'評価待ち':state?.reviews?.day14?'最終評価済み':state?.reviews?.day7?'途中評価済み':dates?'評価前':'未設定',
  updatedAt:state?.updated_at||null,checkedAt:verified?new Date(now).toISOString():null,learning:courses.some(c=>c.started&&!c.completed),trialActive:Boolean(dates?.active),evaluationPending:Boolean(due)};
}

// Explicit output contract: even a future LMS response must not forward private answer fields.
function safeCourse(c){
 if(!c||!['regular','trial'].includes(c.kind)||typeof c.title!=='string')return null;
 const number=k=>Number.isFinite(c[k])&&c[k]>=0?c[k]:null;
 const out={id:String(c.id||''),title:c.title.slice(0,300),kind:c.kind,started:c.started===true,completed:c.completed===true,enrolledAt:c.enrolledAt||null,lastActivityAt:c.lastActivityAt||null};
 for(const k of ['lessonsDone','lessonsTotal','progressPercent','assignmentsDone','assignmentsTotal','aiChallengeCount','outputCount','aiFeedbackCount','teacherFeedbackCount'])out[k]=number(k);
 out.trial=c.trial?Object.fromEntries(['mvvAnswered','aiTried','challengeSubmitted','outputSubmitted','reflectionSubmitted'].map(k=>[k,c.trial[k]===true])):null;
 return out;
}

export function learningTimelineDetail(row){
 if(!['learning_participation','learning_plan','learning_review'].includes(row?.event_key))return null;
 try{
  const value=JSON.parse(row.detail||'{}'),state=value.after;
  if(!state)return '育成・評価の記録を更新しました';
  if(row.event_key==='learning_participation')return '無限道場の参加確認：'+(state.participation?'ON':'OFF');
  if(row.event_key==='learning_plan')return '到達目標を更新（'+state.plan.startOn+'〜'+state.plan.endOn+'）';
  const a=Object.keys(state.reviews||{}).filter(k=>JSON.stringify(state.reviews[k])!==JSON.stringify(value.before?.reviews?.[k]));
  return (a.includes('day14')?'14日目の最終評価':a.includes('day7')?'7日目の途中評価':'担当者評価')+'を保存しました';
 }catch{return '育成・評価の記録を更新しました';}
}
