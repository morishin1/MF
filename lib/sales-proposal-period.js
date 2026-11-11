// ENGER proposals: one JST sent-date period drives both list and stage counts.
// Unsent proposals have no proposal date and therefore appear only in 全期間.
import {resolvePeriod,PERIOD_LABEL} from "./sales-period.js";

export const PROPOSAL_PERIOD_KEYS=Object.freeze(["all","today","this_week","last_week","this_month","last_month","last_7","last_30","custom"]);
export const PROPOSAL_PERIOD_LABEL=Object.freeze({all:"全期間",...PERIOD_LABEL});

export function resolveProposalPeriod(key="all",opts={},now=new Date()){
  const selected=key||"all";
  if(!PROPOSAL_PERIOD_KEYS.includes(selected))
    return {error:"bad_period",hint:"集計期間を選び直してください。"};
  if(selected==="all")return {key:"all",label:"全期間",from:null,to:null,sinceIso:null,untilIso:null,days:null};
  return resolvePeriod(selected,opts,now);
}

export function sentInProposalPeriod(row,period){
  if(period?.error)return false;
  if(period?.key==="all")return true;
  // The basisAt/updatedAt/next task date must NEVER substitute for sentAt.
  const ms=Date.parse(row?.sentAt||"");
  return Number.isFinite(ms)&&ms>=Date.parse(period.sinceIso)&&ms<Date.parse(period.untilIso);
}

export function proposalsForPeriod(rows,period){
  return (rows||[]).filter(row=>sentInProposalPeriod(row,period));
}

// "止まっている" uses the existing Sales overdue flag, NOT a new definition.
// Archived/closed cases are already excluded by that overdue flag.
export function countOutsideStalled(rows,period){
  if(period?.key==="all")return 0;
  return (rows||[]).filter(r=>!r.archived&&r.overdue===true&&!sentInProposalPeriod(r,period)).length;
}
