// Renders only values already verified by the Sales meeting-brief API.
// AI hypothesis and ENGER-linked receipt facts are deliberately separate.
const esc = v => String(v == null ? "" : v).replace(/[&<>"']/g,c=>({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
}[c]));
const count = n => Number(n||0).toLocaleString("ja-JP");
const short = v => esc(String(v||"").slice(0,500));
const list = arr => Array.isArray(arr)?arr:[];

export function renderMeetingBrief(host,data,{filterBySkill,openTalent,minimal=false}={}) {
  if(!host)return;
  if(!data || !data.company || !data.summary || !data.suggestions) {
    host.innerHTML='<p class="lc-error">企業サマリーを取得できませんでした。</p>';
    return;
  }
  const c=data.company,s=data.summary,src=data.source||{},g=data.suggestions;
  const details=s.companyDetails||{};
  const companyDetails=[
    ["どんな事業",details.businessModel],
    ["企業規模",details.scale||s.sizeBand],
    ["関係する人材",details.talentHoldings],
    ["関係する案件",details.jobHoldings],
    ["営業の着眼点",details.salesPriorities],
  ].filter(([,value])=>value);
  const detailGrid=companyDetails.length?
    '<dl class="lp-brief-company-details">'+companyDetails.map(([name,value])=>
      '<div><dt>'+esc(name)+'</dt><dd>'+short(value)+'</dd></div>').join("")+'</dl>':
    '<p class="lp-brief-no-intel">事業・規模・関連案件・人材は未分析です。企業情報タブから分析結果を登録すると、ここに表示されます。</p>';
  const existing=c.mode!=="new";
  const type=c.mode==="existing-linked"?"既存・受領履歴あり":c.mode==="existing-unlinked"?"既存・受領履歴未照合":"新規・開拓候補";
  const facts=[
    ["関連案件",list(src.linkedJobs).length],
    ["関連人材",list(src.linkedTalents).length],
    ["提案履歴",src.proposalCount||0],
    ["受領データ",src.registeredRequests||0],
  ];
  const summaryLabel=s.type==="saved-ai"?"保存済みAI分析":"登録企業情報";
  const phrase=existing
    ? "過去の受領案件・人材と企業IDで紐づく提案履歴を優先します。"
    : "企業概要と保存済みのAI分析から、提案の仮説を整理します。";
  const jobRows=list(g.jobs).map(job=>
    '<li><div><strong>'+short(job.title)+'</strong><small>案件'+(job.no?' No.'+esc(job.no):'')+
    ' ／ 一致：'+esc(list(job.matchedSkills).join("・"))+'</small></div></li>').join("");
  const talentRows=list(g.talents).map(t=>
    '<li><div><strong>'+short(t.displayName)+'　'+short(t.title)+'</strong><small>人材'+
    (t.talentNo?' '+esc(t.talentNo):'')+' ／ 一致：'+esc(list(t.matchedSkills).join("・"))+
    '</small></div><button type="button" data-brief-talent="'+esc(t.id)+'">詳細</button></li>').join("");
  host.innerHTML=
    '<section class="lp-brief-card" aria-label="企業サマリー">' +
      '<header class="lp-brief-head"><div><h4>企業サマリー</h4><small>商談で最初に確認する情報</small></div><span class="lp-brief-tag">'+esc(type)+'</span></header>' +
      '<div class="lp-brief-meta"><strong>'+short(c.name)+'</strong><span>'+esc([c.industry,c.prefecture].filter(Boolean).join(" ／ ")||"業種・所在地未確認")+'</span></div>' +
      '<p class="lp-brief-summary">'+short(s.text)+'</p>' +
      detailGrid +
      '<small class="lp-brief-source">'+esc(summaryLabel)+'　'+esc(s.analysisAt?String(s.analysisAt).slice(0,10):"分析日時未確認")+'。'+short(s.note)+'</small>' +
      '<p class="lp-brief-instruction">'+esc(phrase)+'</p>' +
      '<div class="lp-brief-facts">'+facts.map(([label,value])=>'<div><b>'+count(value)+'</b><small>'+esc(label)+'</small></div>').join("")+'</div>' +
      (s.issue||s.opportunity?'<div class="lp-brief-insights">'+
         (s.issue?'<p><b>AIが挙げた課題（未確認）</b>'+short(s.issue)+'</p>':"")+
         (s.opportunity?'<p><b>AIが挙げた提案余地（未確認）</b>'+short(s.opportunity)+'</p>':"")+
        '</div>':"") +
    '</section>' +
    '<section class="lp-brief-card" aria-label="マッチング候補">' +
      '<header class="lp-brief-head"><div><h4>商談で見せる候補</h4><small>ENGER DBと一次照合した参考リスト</small></div>'+
        '<span class="lp-brief-tag '+(g.verified?"lp-brief-confirmed":"")+'">'+esc(g.verified?"登録条件ベース":"AI仮説・確認待ち")+'</span></header>'+
      '<p class="lc-detail-note">判定根拠：'+short(g.basis||"未登録")+'。'+short(g.disclaimer||"")+'</p>'+
      (list(g.skills).length?'<div class="lp-brief-skillline"><b>絞り込み条件</b>'+
         list(g.skills).map(skill=>'<button type="button" data-brief-skill="'+esc(skill)+'">'+esc(skill)+'</button>').join("")+
        '</div>':'<p class="lc-detail-note">確認済みの職種・スキル情報が不足しているため、自動絞り込みは未実施です。商談で条件を確認してください。</p>')+
      (existing&&!src.hasLinkedRecords?'<p class="lp-brief-warning">企業IDで確認できる受領案件・人材情報がありません。会社名から推測して関連付けることはできません。営業履歴とENGER登録情報の紐づけを確認してください。</p>':"")+
      '<div class="lp-brief-match-grid">'+
        '<div><h5>おすすめ人材（'+count(list(g.talents).length)+'）</h5><ul>'+ (talentRows||'<li><small>一致候補なし。条件を確認してください。</small></li>')+'</ul></div>'+
        '<div><h5>おすすめ案件（'+count(list(g.jobs).length)+'）</h5><ul>'+ (jobRows||'<li><small>一致候補なし。確認済み案件をENGER DXで検索してください。</small></li>')+'</ul></div>'+
      '</div>'+
      '<small class="lp-brief-source">直近各'+count(g.poolLimit||0)+'件の範囲でのスキル一致です。候補の網羅性・募集継続・単価・稼働条件は未確認です。</small>'+
    '</section>';
  if(minimal)host.querySelector('[aria-label="マッチング候補"]')?.remove();
  host.querySelectorAll("[data-brief-skill]").forEach(btn=>
    btn.addEventListener("click",()=>filterBySkill?.(btn.dataset.briefSkill)));
  host.querySelectorAll("[data-brief-talent]").forEach(btn=>
    btn.addEventListener("click",()=>openTalent?.(btn.dataset.briefTalent)));
}
