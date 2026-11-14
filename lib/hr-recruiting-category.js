// 採用予定区分の変更ルール。正式雇用形態・給与・採用判断・契約を更新しない。
import { OFFER_TYPE_KEYS } from './hr-offer-types.js';
export const RECRUITING_CATEGORY_KEYS=Object.freeze([...OFFER_TYPE_KEYS]);
export function checkRecruitingCategoryChange(row,category,{hasOffer=false,hasContract=false,hasPdfFlow=false}={}){
  if(!row||!row.id)return {ok:false,code:'not_found',hint:'応募者を確認できません。'};
  if(!RECRUITING_CATEGORY_KEYS.includes(category))return {ok:false,code:'invalid_category',hint:'採用予定区分を選んでください。'};
  if(row.lead_category==='mugendojo'||String(row.stage||'').startsWith('md_'))return {ok:false,code:'lead_not_supported',hint:'無限道場は専用受付で管理してください。'};
  if(row.employee_id||row.handoff_state==='done'||['accepted','done','passed','declined','position_closed'].includes(row.status)||['rejected','hold'].includes(row.decision))
    return {ok:false,code:'category_locked',hint:'採用・見送り・保留・入社済みの人は予定区分を直接変更できません。'};
  if(hasOffer||hasContract||hasPdfFlow)return {ok:false,code:'category_locked',hint:'通知書または契約手続きが始まっています。正式な修正手続きから変更してください。'};
  return {ok:true};
}
