// Sales→ENGER受領の明確な状態遷移。送信/自動登録の代理ではない。
export const SUPPLY_KIND=["job","talent","both"];
export const SUPPLY_STAGES=["planned","contacted","appointment","awaiting_info","received","registered","closed"];
export const SUPPLY_NEXT={
  planned:["contacted","appointment","awaiting_info","closed"],
  contacted:["appointment","awaiting_info","received","closed"],
  appointment:["contacted","awaiting_info","received","closed"],
  awaiting_info:["contacted","appointment","received","closed"],
  received:["awaiting_info","registered","closed"],
  registered:[],closed:[],
};
export function canSupplyTransition(before,after){
  return SUPPLY_STAGES.includes(before)&&SUPPLY_STAGES.includes(after)
    && (before===after || SUPPLY_NEXT[before].includes(after));
}
export function hasRegisteredSupply(kind,jobId,candidateId){
  return kind==="job"?Boolean(jobId&&!candidateId):
    kind==="talent"?Boolean(candidateId&&!jobId):
    kind==="both"?Boolean(jobId||candidateId):false;
}
