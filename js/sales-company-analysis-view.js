// Compact three-stage Sales company detail: AI evidence and proposal handoff.
// All external values are written with textContent; no source HTML is trusted.
const by=(tag,text,cls)=>{
 const el=document.createElement(tag);if(cls)el.className=cls;
 if(text!==undefined&&text!==null)el.textContent=String(text);
 return el;
};
const arr=x=>Array.isArray(x)?x.slice(0,7):[];
function createList(items){
 const ul=by('ul',null,'lc-analysis-list');
 const values=arr(items);
 if(!values.length)return by('p','まだ登録されていません。','lc-detail-note');
 for(const x of values){
   const li=by('li'),primary=typeof x==='string'?x:x?.role||x?.type||x?.reason||'';
   li.append(by('strong',String(primary||'—').slice(0,160)));
   if(typeof x==='object'){
    if(x.reason&&x.reason!==primary)li.append(by('small',String(x.reason).slice(0,260)));
    if(x.source_url)li.append(by('small','出典：'+String(x.source_url).slice(0,500)));
   }
   ul.append(li);
 }
 return ul;
}
const section=(title,extra)=>{
 const el=by('section',null,'lc-analysis-card');
 el.append(by('h3',title));
 if(extra)el.append(by('small',extra,'lc-analysis-muted'));
 return el;
};
export function renderAnalysisView(host,data){
 if(!host)return;
 const a=data?.analysis||{},stage=data?.steps?.analysis||{};
 host.replaceChildren();
 const wrap=by('div',null,'lc-analysis-wrap');
 const base=section('AI企業サマリー',stage.label||'未生成');
 base.append(by('p',a.summary||
   'AI分析結果はまだありません。公式サイト・登録企業情報から分析を開始します。','lc-analysis-summary'));
 const facts=a.facts||{};
 const dl=by('dl',null,'lc-analysis-facts');
 for(const [label,value] of [
  ['主な事業',facts.business],['企業規模',facts.size],
  ['技術領域',arr(facts.technology).join(' / ')],
  ['確認済みニーズ',a.confirmedNeeds==null?'取得できません':a.confirmedNeeds+'件']
 ]){
  const item=by('div');item.append(by('dt',label),by('dd',value||'未確認'));dl.append(item);
 }
 base.append(dl);wrap.append(base);
 const pair=by('div',null,'lc-analysis-cards');
 const human=section('求めていそうな人材','AI仮説・先方未確認');
 human.append(createList(a.demandHypotheses));
 const jobs=section('持っていそうな案件','AI仮説・先方未確認');
 jobs.append(createList(a.supplyHypotheses));
 pair.append(human,jobs);wrap.append(pair);
 const actions=section('商談前に聞くこと');
 actions.append(createList(a.nextActions));
 const unknown=section('確認できていないこと');
 unknown.append(createList(a.unknowns));
 wrap.append(actions,unknown);
 const source=by('details',null,'lc-analysis-card');
 source.append(by('summary','情報源・確認日'));
 const ul=by('ul');
 for(const s of arr(a.sources)){
  try{
   const u=new URL(s.url);if(u.protocol!=='https:')continue;
   const li=by('li'),anchor=by('a',u.href);anchor.href=u.href;anchor.target='_blank';anchor.rel='noopener noreferrer';
   li.append(anchor,by('small',' '+(s.checked_at||'')));ul.append(li);
  }catch{}
 }
 source.append(ul);wrap.append(source);
 wrap.append(by('p','公式求人などの公開情報は参考です。実際の募集・発注・単価・商流条件は相手に確認してから提案してください。','lc-detail-note'));
 host.append(wrap);
}
export function renderProposalNext(host,data){
 if(!host)return;
 const p=data?.proposal||{},count=Number(p.publishedCount||0),ready=count>0;
 host.replaceChildren();
 const bar=by('div',null,'lp-proposal-next-bar');
 const title=by('div');
 title.append(by('strong',ready?'商談用に公開した候補：'+count+'件':'提案する案件・人材を用意してください'));
 title.append(by('small',ready?'相手企業の担当者は自分のアカウントでログインします。':
  '候補を選び、公開用の情報を確認してから「商談用に準備」を実行してください。'));
 const actions=by('div',null,'lp-proposal-next-links');
 for(const [label,href] of [
   ['商談画面を確認',p.staffMeetingUrl],
   ['企業ログインへ',p.clientLoginUrl]
 ]){
  const a=by('a',label);a.href=ready&&href?href:'#';
  a.target='_blank';a.rel='noopener noreferrer';
  if(!ready){a.setAttribute('aria-disabled','true');a.addEventListener('click',e=>e.preventDefault());}
  actions.append(a);
 }
 if(!p.portalAccounts)actions.append(by('small','企業ログイン用アカウントの発行・有効性を確認してください。','lc-analysis-muted'));
 bar.append(title,actions);host.append(bar);
}