// トライアルは「業務日報・週次KPI」ではなく、エイトとの相性を短く評価する。
// ここでの推薦・保留・見送りは採用の合否ではない。
export const TRIAL_FIT_EVENT = 'trial_fit_evaluated';
export const TRIAL_FIT_ITEMS = Object.freeze([
  {key:'communication',label:'コミュニケーション'},
  {key:'mvv',label:'MVVへの共感・実践'},
  {key:'teamwork',label:'協力・報連相'},
  {key:'initiative',label:'主体的な行動'},
  {key:'attitude',label:'仕事への向き合い方'},
]);
export const TRIAL_FIT_GRADES = Object.freeze([
  {key:'great',label:'◎'}, {key:'good',label:'○'},
  {key:'fair',label:'△'}, {key:'bad',label:'×'},
]);
export const TRIAL_FIT_DECISIONS = Object.freeze([
  {key:'recommend',label:'一緒に働きたい'},
  {key:'hold',label:'もう少し確認'},
  {key:'decline',label:'見送りを提案'},
]);
export function validateTrialFit(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return {error:'invalid_body'};
  const scores=value.scores;
  if(!scores||typeof scores!=='object'||Array.isArray(scores))return {error:'invalid_scores'};
  const keys=TRIAL_FIT_ITEMS.map(x=>x.key);
  const grades=TRIAL_FIT_GRADES.map(x=>x.key);
  if(Object.keys(scores).length!==keys.length||keys.some(k=>!grades.includes(scores[k])))
    return {error:'invalid_scores'};
  if(!TRIAL_FIT_DECISIONS.some(x=>x.key===value.decision))return {error:'invalid_decision'};
  return {scores:Object.fromEntries(keys.map(k=>[k,scores[k]])),decision:value.decision};
}
export function trialFitEvent(row) {
  if(!row)return null;
  try {
    const value=JSON.parse(row.detail);
    const clean=validateTrialFit(value);
    return clean.error?null:{...clean,recordedAt:row.occurred_at,actorId:row.created_by||null};
  } catch {return null;}
}
