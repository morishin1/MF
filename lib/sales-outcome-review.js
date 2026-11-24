import { isUuid } from './sales-proposals.js';
import { IMPROVEMENT_DAYS, OBSERVATION_DAYS } from './sales-proposal-flow.js';

const DAY = 86400000;
const normDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const jstDay = v => new Date(Date.parse(v) + 9 * 3600000).toISOString().slice(0,10);
const short = (v, max=700) => typeof v === 'string' && v.trim().length <= max ? v.trim() : '';
export const reviewKey = (kind, key) => kind + '/' + key;
export const reviewIndex = records => new Map(records.map(r => [reviewKey(r.kind,r.entity_key), r]));
const get = (state, kind, key) => state.get(reviewKey(kind,key));
export const problem = (message,status=400) => Object.assign(new Error(message),{status});
function requireValue(condition, message, status) { if (!condition) throw problem(message,status); }

function proof(raw, today) {
  const channel = raw.channel, quote = short(raw.quote), observed = raw.observed;
  requireValue(['client','candidate','internal','relay'].includes(channel) && quote && normDay(observed) && observed <= today,
    '確認先・確認日・相手の発言または照合した記録を入力してください。');
  return { channel, quote, observed };
}

export function normalizeReview(body, {model, input, records, allowRank, allowTerms, now}) {
  const {kind, entity, revision, requestId, data} = body || {};
  requireValue(isUuid(requestId) && Number.isSafeInteger(revision) && revision>=0 && data && typeof data==='object' && !Array.isArray(data),
    '画面を再読み込みして再度保存してください。');
  requireValue(['affiliation','feedback','proposal','closing','meeting','terms','clearance'].includes(kind) && typeof entity==='string' && entity.length<=160,'記録の種類を確認してください。');
  if (['proposal','closing'].includes(kind)) requireValue(allowRank,'評価根拠の確定には営業管理権限が必要です。',403);
  if (['terms','clearance'].includes(kind)) requireValue(allowTerms,'取引条件の確定には管理者権限が必要です。',403);
  const today = jstDay(now), states = reviewIndex(records);
  const row = model.rows.find(r=>r.sourceProposalId===entity && !r.sourceMissing);
  let payload;
  if (['affiliation','feedback','proposal','closing'].includes(kind)) {
    requireValue(row, '対象の提案が見つかりません。',404);
    const evidence = proof(data,today);
    requireValue(!row.facts.lastReopen || evidence.observed >= jstDay(row.facts.lastReopen),'再開後に確認した根拠を入力してください。');
    const cycle = row.facts.lastReopen || null;
    if (kind==='feedback') {
      requireValue(row.facts.lost && ['job','candidate','external','unknown'].includes(data.side) && ['skill','terms','timing','filled','intent','process','other','unknown'].includes(data.category),
        '見送りになった提案の確認先と理由を選択してください。');
      if(data.category!=='unknown') requireValue(evidence.channel!=='internal','確認できた理由には相手の回答が必要です。');
      payload={...evidence,side:data.side,category:data.category,cycle};
    } else if (kind==='affiliation') {
      requireValue(['available','unavailable','waiting'].includes(data.status),'所属確認の結果を選択してください。');
      payload={...evidence,status:data.status,cycle};
    } else {
      requireValue(input.employees.some(e=>e.id===data.ownerId),'当時の担当者を選択してください。');
      requireValue(['A','B','C','D','unknown'].includes(data.grade) && ['normal','hard','unknown'].includes(data.difficulty)
        && ['individual','blast','unknown'].includes(data.delivery) && ['role','external','unknown'].includes(data.cause),'比較条件と確認した理由を選択してください。');
      requireValue(row.facts.blast==null || data.delivery==='unknown' || (row.facts.blast ? data.delivery==='blast' : data.delivery==='individual'),
        'ENGERの送信区分と一致する値を選択してください。');
      if (data.cause!=='unknown') requireValue(evidence.channel!=='internal','責任区分には企業・人材・所属会社から確認した根拠が必要です。');
      const sent=row.facts.currentSend;
      if (kind==='proposal') requireValue(sent,'案件側への送信記録が必要です。');
      const handoffAt=data.handoffAt,heldAt=data.heldAt;
      if (kind==='closing') {
        requireValue(row.facts.resultDue && validTime(heldAt,now) && validTime(handoffAt,heldAt) &&
          (!sent || Date.parse(heldAt)>=Date.parse(sent)) && (!cycle || Date.parse(handoffAt)>=Date.parse(cycle)),
          '実施済みの面談について、実施前の正式引継ぎ日時と実施日時を確認してください。');
      }
      payload={...evidence,ownerId:data.ownerId,grade:data.grade,difficulty:data.difficulty,delivery:data.delivery,cause:data.cause,cycle,
        ...(kind==='closing'?{handoffAt:new Date(handoffAt).toISOString(),heldAt:new Date(heldAt).toISOString()}: {sentAt:sent})};
    }
  } else {
    const companyKey=kind==='clearance'?data.company:entity;
    const rows=model.rows.filter(r=>r.company.key===companyKey);
    requireValue(rows.length,'対象企業の提案履歴が見つかりません。',404);
    const verified=companyKey.startsWith('enger:') && rows.some(r=>r.company.identity.kind==='id') &&
      input.engerCompanies.some(c=>'enger:'+c.id===companyKey);
    if (kind==='meeting') {
      const status=data.status, agenda=short(data.agenda), action=short(data.action), cause=short(data.cause);
      requireValue(['planned','scheduled','done'].includes(status) && agenda,'商談で確認する議題を入力してください。');
      requireValue(input.employees.some(e=>e.id===data.ownerId) && normDay(data.nextDate),'商談担当と次の確認日を入力してください。');
      if (status!=='planned') requireValue(validTime(data.meetingAt, status==='done'?now:null),'商談の日時を確認してください。');
      if (status==='done') requireValue(cause && action,'相手に確認した原因と、次の提案で実行する改善策を記録してください。');
      const previous=get(states,'meeting',entity)?.payload;
      const localIds=new Set((input.companyLinks||[]).filter(l=>'enger:'+l.source_company_id===companyKey).map(l=>l.company_id));
      if (companyKey.startsWith('sales:')) localIds.add(companyKey.slice(6));
      const salesCompanyId=localIds.size===1?[...localIds][0]:null;
      const meetingId=previous?.meetingId && !(previous.status==='done' && status!=='done') ? previous.meetingId : requestId;
      payload={status,agenda,meetingId,salesCompanyId,ownerId:data.ownerId,nextDate:data.nextDate,cause,action,
        meetingAt:status==='planned'?null:new Date(data.meetingAt).toISOString()};
    } else if (kind==='terms') {
      requireValue(verified,'企業IDとの紐付けを先に確認してください。');
      const evidence=proof(data,today);
      const condition=short(data.condition),refs=[...new Set(Array.isArray(data.refs)?data.refs:[])];
      requireValue(['A','B','C','D'].includes(data.grade) && condition && normDay(data.nextDate) && data.nextDate>=today,'取引区分・具体的な条件・見直し日を入力してください。');
      requireValue(refs.length<=10 && refs.every(id=>isUuid(id) && rows.some(r=>r.sourceProposalId===id && r.company.identity.kind==='id')),'企業IDで確認できる提案から根拠を選択してください。');
      if (['C','D'].includes(data.grade)) requireValue(refs.length && evidence.channel==='client','条件の適用には企業の回答と対象提案が必要です。');
      if (data.grade==='D') {
        const meeting=get(states,'meeting',entity)?.payload;
        const jobLosses=rows.filter(r=>{
          if(!refs.includes(r.sourceProposalId) || !r.facts.lost) return false;
          const fb=get(states,'feedback',r.sourceProposalId)?.payload;
          return (r.lossSideRaw==='案件側' && !!r.lossDetail) || (fb && fb.cycle===(r.facts.lastReopen||null) &&
            fb.side==='job' && fb.channel==='client' && fb.category!=='unknown');
        });
        requireValue(meeting?.status==='done' && meeting.action && jobLosses.length>=2 &&
          jobLosses.some(r=>Date.parse(r.facts.currentSend)>Date.parse(meeting.meetingAt)),
          '停止には改善商談の実施記録と、商談後に送った提案を含む2件以上の案件側の具体的な見送り理由が必要です。');
      }
      payload={...evidence,grade:data.grade,condition,refs,nextDate:data.nextDate};
    } else {
      const terms=get(states,'terms',companyKey);
      const linkedJob=input.confirmedHistoryLinks.some(l=>l.entity_type==='job'&&l.entity_id===entity&&'enger:'+l.company_id===companyKey);
      requireValue(verified && isUuid(entity) && (linkedJob || rows.some(r=>r.facts.jobId===entity && r.company.identity.kind==='id')),'企業に紐づく案件を選択してください。');
      requireValue(terms?.payload.grade==='C' && terms.revision===data.termsRevision,'取引条件が変わりました。再度確認してください。',409);
      const evidence=proof(data,today);
      requireValue(evidence.channel==='client' && normDay(data.until) && data.until>=today && data.until<=terms.payload.nextDate,'企業との確認内容と、条件見直し日までの有効期限を入力してください。');
      payload={...evidence,company:companyKey,termsRevision:terms.revision,until:data.until};
    }
  }
  return {kind,entity,revision,requestId,payload};
}

function validTime(value, ceiling) {
  return typeof value==='string' && /^\d{4}-\d\d-\d\dT.*(Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value)) && (!ceiling || Date.parse(value)<=Date.parse(ceiling));
}

export function staffOutcomes(model, records, handoffs, employees, asOf) {
  const index=reviewIndex(records), groups=new Map(), coverage={proposal:{total:0,linked:0},closing:{total:0,linked:0}};
  const now=Date.parse(asOf), names=new Map(employees.map(e=>[e.id,e.display_name]));
  const byProposal=new Map();
  for (const h of handoffs.filter(h=>h.to_stage==='closing')) {
    if (!byProposal.has(h.proposal_id)) byProposal.set(h.proposal_id,[]);
    byProposal.get(h.proposal_id).push(h);
  }
  for (const row of model.rows) {
    if (!row.sourceProposalId || row.sourceMissing || row.facts.blast===true) continue;
    for (const role of ['proposal','closing']) {
      let r=get(index,role,row.sourceProposalId)?.payload || {};
      if ((r.cycle || null)!==(row.facts.lastReopen || null)) r={};
      if (r.delivery==='blast' || (role==='closing' && !row.facts.resultDue)) continue;
      const event=role==='proposal'?row.facts.currentSend:r.heldAt || row.facts.performedAt;
      const age=now-Date.parse(event);
      if (!Number.isFinite(age) || age<OBSERVATION_DAYS*DAY || age>IMPROVEMENT_DAYS*DAY) continue;
      coverage[role].total++;
      const h=role==='closing' && row.facts.actualHeldAt ? (byProposal.get(row.salesProposalId)||[]).filter(x=>Date.parse(x.created_at)<=Date.parse(row.facts.actualHeldAt) &&
        (!row.facts.lastReopen || Date.parse(x.created_at)>=Date.parse(row.facts.lastReopen))).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0] : null;
      const actor=r.ownerId || (role==='proposal'?row.facts.sentBy:h?.to_owner_id);
      const direct=row.facts.blast===false || r.delivery==='individual';
      if (!actor || !names.has(actor) || !direct) continue;
      const grade=r.grade || 'unknown', difficulty=r.difficulty || 'unknown';
      const comparable=grade!=='unknown' && difficulty!=='unknown' && row.service!=='unknown';
      if (comparable) coverage[role].linked++;
      const cohort=JSON.stringify([role,row.service,grade,difficulty]),key=cohort+actor;
      if (!groups.has(key)) groups.set(key,{cohort,role,service:row.service,grade,difficulty,ownerId:actor,name:names.get(actor),total:0,success:0,external:0,pending:0,unknown:0,rank:null});
      const g=groups.get(key); g.total++;
      const success=role==='proposal'?row.facts.resultDue:row.facts.interviewResult==='passed';
      if (success) g.success++;
      else if (role==='closing' && row.facts.interviewResult!=='failed' || role==='proposal' && !row.facts.lost) g.pending++;
      else if (r.cause==='external') g.external++;
      else if (r.cause!=='role') g.unknown++;
    }
  }
  const rated=new Map(), results=[...groups.values()];
  for (const g of results) {
    const known=g.total-g.pending, complete=known-g.unknown;
    g.adjustedN=complete-g.external; g.raw=known?g.success/known:null;
    g.adjusted=g.adjustedN?g.success/g.adjustedN:null; g.coverage=complete/g.total;
    const gate=coverage[g.role];
    if (g.adjustedN<(g.role==='proposal'?20:10) || g.coverage<.90 || gate.linked/gate.total<.90 ||
      g.grade==='unknown' || g.difficulty==='unknown' || g.service==='unknown') continue;
    if (!rated.has(g.cohort)) rated.set(g.cohort,[]);
    rated.get(g.cohort).push(g);
  }
  for (const peers of rated.values()) if(peers.length>=2) for (const g of peers)
    g.rank=1+peers.filter(p=>p.success*g.adjustedN>g.success*p.adjustedN).length;
  return {coverage,results:results.sort((a,b)=>a.cohort.localeCompare(b.cohort)|| (a.rank??Infinity)-(b.rank??Infinity)||a.name.localeCompare(b.name,'ja'))};
}
