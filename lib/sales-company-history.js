import {COMPANY_FIELDS} from './sales-company-workbench.js';
export const HISTORY_KINDS=new Set(['','email','phone','form','memo','edit','plan']);
export function historyFilters(params){
 const page=Number(params.get('page')||1),kind=params.get('kind')||'',q=(params.get('q')||'').trim();
 if(!Number.isInteger(page)||page<1||page>10000||!HISTORY_KINDS.has(kind)||q.length>100)throw Error('invalid_filter');
 const date=v=>{if(!v)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)throw Error('invalid_filter');return v;};
 const from=date(params.get('from')),to=date(params.get('to'));if(from&&to&&from>to)throw Error('invalid_filter');
 return{page,kind,q,from:from?from+'T00:00:00+09:00':null,to:to?new Date(Date.parse(to+'T00:00:00+09:00')+86400000).toISOString():null};
}
const labels={segment:'移動先',blastTarget:'配信登録',priority:'優先度',relationshipStatus:'取引状態',evidence:'確認根拠',action:'操作'};
const values={current:'現在',past:'過去',future:'未来',broadcast:'配信',auto:'自動分類',active:'取引中',unknown:'未確認',none_confirmed:'取引なし確認済み'};
export function historyRow(r){
 let detail=r.detail||'';
 if(r.kind==='edit'&&detail.startsWith('{')){try{detail=Object.entries(JSON.parse(detail)).filter(([k])=>k!=='action').map(([k,v])=>(COMPANY_FIELDS[k]?.label||labels[k]||k)+'：'+(typeof v==='boolean'?(v?'あり':'なし'):values[v]||v||'未登録')).join('\n');}catch{}}
 return{id:r.id,companyId:r.company_id,salesId:r.sales_company_id,name:r.company_name,available:r.company_available,at:r.occurred_at,kind:r.kind,source:r.source,actor:r.actor_name||'記録者未登録',label:r.label,subject:r.subject||'',detail,nextAction:r.next_action||'',nextDate:r.next_date||''};
}
