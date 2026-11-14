import {ymd} from './jst.js';
export const PLAN_FIELDS={oneYear:'1年後に実現したいこと',threeYears:'3年後の姿',strengths:'強み・これまでの経験',interests:'やってみたい仕事・分野',priorities:'大切にしたい働き方',learning:'身につけたいスキル',ninetyDays:'3か月後の目標',reflection:'振り返り'};
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const emptyPlan=()=>({...Object.fromEntries(Object.keys(PLAN_FIELDS).map(k=>[k,''])),actions:[]});
export function normalizePlan(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('目標・計画の内容を確認してください。');
 const plan=emptyPlan();
 for(const key of Object.keys(PLAN_FIELDS)){const value=input[key]??'';if(typeof value!=='string'||value.length>600)throw Error(`${PLAN_FIELDS[key]}は600文字以内で入力してください。`);plan[key]=value.trim();}
 if(!Array.isArray(input.actions)||input.actions.length>5)throw Error('行動計画は5件まで登録できます。');
 const ids=new Set();
 plan.actions=input.actions.map(a=>{
  if(!a||!UUID.test(a.id||'')||ids.has(a.id)||typeof a.title!=='string'||!a.title.trim()||a.title.length>160||typeof a.completed!=='boolean')throw Error('行動の内容を確認してください。');ids.add(a.id);
  const dueOn=a.dueOn||'';if(typeof dueOn!=='string'||(dueOn&&(!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)||ymd(new Date(dueOn+'T00:00:00Z'))!==dueOn)))throw Error('行動の期限を確認してください。');
  return {id:a.id,title:a.title.trim(),dueOn,completed:a.completed};
 });return plan;
}
export function normalizeAdvice(raw){
 const text=(v,max)=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('invalid_coach_output');return v.trim();};
 if(!raw||!Array.isArray(raw.questions)||raw.questions.length>3||!Array.isArray(raw.actions)||raw.actions.length>3)throw Error('invalid_coach_output');
 return {reply:text(raw.reply,1000),questions:raw.questions.map(v=>text(v,200)),proposal:{oneYear:text(raw.proposal?.oneYear,600),ninetyDays:text(raw.proposal?.ninetyDays,600),learning:text(raw.proposal?.learning,600)},actions:raw.actions.map(v=>text(v,160))};
}
