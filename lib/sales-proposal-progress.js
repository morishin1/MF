// 営業の進捗と受注・金額の記録。契約確定は営業上の記録。
import { readWhen, isUuid } from './sales-proposals.js';

export const SALES_STAGES = [
  {key:'proposal',label:'提案中'}, {key:'meeting',label:'面談'},
  {key:'conditions',label:'条件調整'}, {key:'won',label:'成約'},
  {key:'active',label:'稼働中'}, {key:'hold',label:'保留'}, {key:'lost',label:'見送り'},
];
const money = v => v === '' || v == null ? null : typeof v === 'number' || /^\d+$/.test(v) ? Number(v) : NaN;
export function normalizeProgress(body, {now = new Date().toISOString()} = {}) {
  const p = body.progress;
  const fail = (field,hint) => ({error:'invalid_body',field,hint});
  if (!p || !SALES_STAGES.some(s=>s.key===p.stage)) return fail('stage','進捗を選んでください');
  const note = String(body.note || '').trim();
  if (!note || note.length>2000) return fail('note','対応結果・メモを2,000文字以内で入力してください');
  const nextAction = String(p.nextAction || '').trim();
  const dueAt = readWhen(p.dueAt);
  if (nextAction.length>200 || dueAt===undefined) return fail('nextAction','次の行動・期限を確認してください');
  if (['proposal','meeting','conditions','hold'].includes(p.stage) && (!nextAction || !dueAt))
    return fail('nextAction','次の行動と期限を入力してください');
  if (p.assigneeId && !isUuid(p.assigneeId)) return fail('assigneeId','担当を確認してください');
  if (!['monthly','one_time'].includes(p.revenueKind)) return fail('revenueKind','売上の種類を選んでください');
  const revenue = money(p.revenue), cost = money(p.cost);
  if ([revenue,cost].some(v=>v!==null&&(!Number.isSafeInteger(v)||v<0||v>100000000000)))
    return fail('revenue','金額は0以上の整数（円）で入力してください');
  const startOn = p.startOn || null;
  if (startOn && (!/^\d{4}-\d{2}-\d{2}$/.test(startOn)||Number.isNaN(Date.parse(startOn))||new Date(startOn).toISOString().slice(0,10)!==startOn))
    return fail('startOn','開始日を確認してください');
  if (['won','active'].includes(p.stage) && p.contractConfirmed!==true)
    return fail('contractConfirmed','契約が確定していることを確認してください');
  const todayJst = new Date(Date.parse(now)+9*3600000).toISOString().slice(0,10);
  if(p.stage==='active'&&(!startOn||startOn>todayJst)) return fail('startOn','実際に稼働を開始した日を入力してください');
  if(p.stage==='lost'&&!['client_declined','talent_declined','filled','other'].includes(p.reason))
    return fail('reason','見送りの理由を選んでください');
  return {value:{kind:'memo',occurred_at:now,note,detail:{salesProgress:{
    stage:p.stage,nextAction,dueAt:dueAt||null,assigneeId:p.assigneeId||null,
    revenueKind:p.revenueKind,revenue,cost,startOn,reason:p.reason||null,
    contractConfirmed: ['won','active'].includes(p.stage) && p.contractConfirmed === true,
  }}}};
}

export function progressSnapshot(activities) {
  return [...activities].filter(a=>a.detail?.salesProgress).sort((a,b)=>
    String(b.created_at||b.occurred_at).localeCompare(String(a.created_at||a.occurred_at))||String(b.id).localeCompare(String(a.id)))[0]?.detail.salesProgress || null;
}
export function salesStage(p,snapshot) {
  if(p.status==='won') return snapshot?.stage==='active'?'active':'won';
  if(['lost','stopped','closed_no_reply'].includes(p.status)) return 'lost';
  if(p.close_reason==='sales_hold') return 'hold';
  if(p.status==='considering'&&snapshot?.stage==='conditions') return 'conditions';
  if(['meeting_adjust','meeting_done'].includes(p.status)) return 'meeting';
  return 'proposal';
}
