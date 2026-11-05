// Read the same ENGER records; no mirrored company master or synchronization queue.
export const CONTACT_RESULT_LIMIT = 1000;
export function normalizeContactResults(contacts, proposals, companies, names = new Map()) {
  const clean = v => typeof v === 'string' ? v : '';
  const url = v => { try {const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;} };
  return [
    ...contacts.map(t => {
      const r=t.dx2_contact_result||{};
      return {id:t.id,kind:'contact',companyId:t.company_id,company:names.get(t.company_id)||'企業名未取得',
        proposalId:clean(r.proposalId),date:t.occurred_at,status:clean(r.outcomeLabel)||'状況未記録',statusCode:clean(r.outcome),
        reason:clean(r.reasonLabel)||'理由未記録',reasonCode:clean(r.reason),owner:clean(r.ownerName)||'担当未記録',ownerId:clean(r.ownerId),
        recorder:clean(r.recordedByName)||'記録者未記録',contact:clean(r.contactName),channel:clean(r.channelLabel),
        side:r.side==='candidate'?'人材側':'案件側',note:clean(r.note),nextAction:clean(r.nextAction),nextDue:clean(r.nextDue),evidenceUrl:url(r.evidenceUrl)};
    }),
    ...proposals.map(p => ({id:p.id,kind:'proposal_ng',companyId:p.company_id,company:names.get(p.company_id)||p.company||'企業名未記録',
      proposalId:p.id,date:p.stage_updated_at,status:p.stage,statusCode:'proposal_ng',
      reason:p.lost_detail_reason||p.lost_reason_category||p.lost_reason||'理由未記録',
      reasonCode:p.lost_detail_reason||p.lost_reason_category||p.lost_reason||'unknown',owner:p.closer||p.proposer||p.owner||'担当未記録',ownerId:'',
      recorder:'既存の提案履歴で確認',contact:p.client_contact||'',channel:'',side:p.dx2_lost_side||'不明',note:p.lost_reason_note||'',
      nextAction:p.next_action||'',nextDue:'',evidenceUrl:null,job:p.job_title,candidate:p.candidate_name})),
    ...companies.map(c => ({id:c.company_id,kind:'company_ng',companyId:c.company_id,company:names.get(c.company_id)||'企業名未取得',
      proposalId:null,date:c.ng_at,status:'企業NG',statusCode:'company_ng',reason:c.ng_reason||'理由未記録',reasonCode:c.ng_reason||'unknown',
      owner:c.owner||'担当未記録',ownerId:c.owner_user_id||'',recorder:c.ng_by||'記録者未記録',contact:'',channel:'',side:'企業全体',
      note:'現在NGが有効な企業です。登録理由は既存データの内容を表示しています。',nextAction:c.next_action||'',nextDue:c.next_due||'',evidenceUrl:null})),
  ].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
}
export function summarizeContactResults(rows) {
  const reasons=new Map(),owners=new Map();
  for(const r of rows){
    const key=r.kind+':'+r.reasonCode;
    const item=reasons.get(key)||{key,label:r.reason,count:0};item.count++;reasons.set(key,item);
    const ownerKey=r.ownerId||r.owner;
    const owner=owners.get(ownerKey)||{key:ownerKey,label:r.owner,count:0};owner.count++;owners.set(ownerKey,owner);
  }
  return {reasons:[...reasons.values()].sort((a,b)=>b.count-a.count),owners:[...owners.values()].sort((a,b)=>b.count-a.count)};
}
