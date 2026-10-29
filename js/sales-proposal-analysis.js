// /sales/analytics.html 提案分析。アタック分析は既存のロジックを維持する。
window.SalesProposalAnalysis = (() => {
  const esc = SalesLayout.esc;
  const GRADE_LABEL = {A:"A・優先", B:"B・継続", C:"C・改善", blast:"ブラスト限定", review:"評価中"};
  const REASON_LABEL = {client_declined:"企業側見送り（詳細不明）",talent_declined:"人材側辞退",
    filled:"募集終了・充足",no_reply:"無回答",contact_stop:"連絡停止希望",other:"その他",
    other_candidate:"別候補希望",sales_hold:"営業保留",client_considering:"企業検討中",unknown:"理由未取得"};
  const el = id => document.getElementById(id);
  const nf = n => Number(n || 0).toLocaleString("ja-JP");
  const rate = (n,d) => d ? (Math.round(n*1000/d)/10)+"%" : "—";
  const jstDay = iso => iso ? new Date(Date.parse(iso)+9*3600000).toISOString().slice(0,10) : "";
  const startDay = days => {
    const d = new Date(Date.now()+9*3600000);
    d.setUTCDate(d.getUTCDate()-days+1);
    return d.toISOString().slice(0,10);
  };
  let data = null, days = 90, sequence = 0, visible = [];
  const lost = p => ["lost","closed_no_reply","stopped"].includes(p.status);
  const reasonUnclear = p => [null,"client_declined","other"].includes(p.closeReason);
  const badge = g => `<span class="an-rank ${esc(g.grade)}" title="${g.blastOnly?"15件以上提案・面談実施0件。ブラスト候補":"提案実績からの自動判定"}">${esc(GRADE_LABEL[g.grade]||"評価中")}</span>`;
  async function load(nextDays) {
    days = nextDays;
    const seq = ++sequence;
    el("an-proposal-body").style.opacity = ".5";
    try {
      const res = await API.api("/api/sales/proposals?filter=all&sort=sent&days=365");
      if (seq!==sequence) return;
      if (!Array.isArray(res.proposals) || !Array.isArray(res.companyQualifications)) throw new Error("提案分析用APIの更新を確認できません。");
      data=res;
      render();
    } catch(e) {
      if (seq!==sequence) return;
      el("an-proposal-body").innerHTML = `<div class="banner err"><span class="material-symbols-outlined">error</span><div>提案分析を表示できません：${esc(e.hint||e.detail||e.message)}</div></div>`;
    } finally {if(seq===sequence)el("an-proposal-body").style.opacity="";}
  }
  function periodRows() {
    const from=startDay(days);
    return (data?.proposals||[]).filter(p=>!p.archived&&!p.sourceDeleted&&p.sentAt&&jstDay(p.sentAt)>=from);
  }
  function byCompany(period) {
    const counts=new Map();
    for(const p of period) {
      const g=p.companyQualification;
      if (!g?.key) continue;
      if(!counts.has(g.key))counts.set(g.key,{sent:0,meetings:0,lost:0,unclear:0});
      const s=counts.get(g.key);
      s.sent++;
      if(p.meetingCompleted)s.meetings++;
      if(lost(p)){s.lost++;if(reasonUnclear(p))s.unclear++;}
    }
    return counts;
  }
  function render() {
    const ps=periodRows();
    const meetings=ps.filter(p=>p.meetingCompleted).length;
    const closed=ps.filter(lost);
    const blast=data.companyQualifications.filter(g=>g.blastOnly);
    const kpi=(label,value,note)=>`<div><div class="l">${esc(label)}</div><div class="v">${esc(String(value))}</div><div class="s">${esc(note)}</div></div>`;
    const gradeCount=grade=>data.companyQualifications.filter(g=>g.grade===grade).length;
    const reasons=new Map();
    for(const p of closed){const k=p.closeReason||"unknown";reasons.set(k,(reasons.get(k)||0)+1);}
    const reasonsSorted=[...reasons].sort((a,b)=>b[1]-a[1]);
    el("an-proposal-body").innerHTML=`
      ${data.truncated?'<div class="banner warn" style="margin-bottom:12px;">提案の表示上限2,000件に到達しているため、ランクは暫定です。全件取得が必要です。</div>':''}
      ${data.notice?`<p class="an-prop-note">${esc(data.notice)}</p>`:""}
      <div class="an-prop-kpis">
        ${kpi("期間内の提案",nf(ps.length),"企業へ送信済みのみ")}
        ${kpi("面談実施",nf(meetings),"面談調整は含めない")}
        ${kpi("提案 → 面談率",rate(meetings,ps.length),"目標10%以上")}
        ${kpi("見送り・クローズ",nf(closed.length),`理由不明瞭 ${closed.filter(reasonUnclear).length}件`)}
        ${kpi("ブラスト限定",nf(blast.length)+"社","15件以上提案・面談0")}
      </div>
      <div class="an-prop-title">企業別｜取引先の評価とブラスト判定</div>
      <p class="an-prop-note">A：10件以上提案、面談率20%以上／B：10件以上、10%以上／C：10件以上、10%未満／ブラスト限定：15件以上、面談実施0件。10件未満は評価中。ランクは取得できる全履歴で判定し、期間の集計とは区別します。</p>
      <div class="an-prop-tools">
        <select id="an-company-grade" aria-label="企業ランク" onchange="SalesProposalAnalysis.filter()">
          <option value="">全企業</option>
          <option value="blast">ブラスト限定 ${gradeCount("blast")}社</option>
          <option value="C">C・改善 ${gradeCount("C")}社</option>
          <option value="B">B・継続 ${gradeCount("B")}社</option>
          <option value="A">A・優先 ${gradeCount("A")}社</option>
          <option value="review">評価中 ${gradeCount("review")}社</option>
        </select>
        <input type="search" id="an-company-search" aria-label="企業名検索" placeholder="企業名で検索" oninput="SalesProposalAnalysis.filter()">
        <button type="button" onclick="SalesProposalAnalysis.exportCsv()">CSVダウンロード</button>
      </div>
      <div class="an-prop-table" id="an-company-table"></div>
      <p class="an-prop-note">ブラスト限定マークは提案先を見直す目印です。自動でメール送信・配信登録・取引禁止にはしません。配信停止や連絡停止の企業はブラスト対象から除外してください。</p>
      <div class="an-prop-title">見送り理由（直近${days}日）</div>
      <div class="an-prop-reasons">${reasonsSorted.length?reasonsSorted.map(([k,n])=>`
        <div class="an-reason-row"><span>${esc(REASON_LABEL[k]||k)}</span><div class="an-reason-bar"><span style="width:${Math.round(100*n/closed.length)}%"></span></div><b>${nf(n)}件</b></div>`).join(""):"<div class='sl-empty'>この期間の見送り記録はありません。</div>"}</div>
      <div class="an-prop-title">担当別｜提案と面談実施</div>
      <div class="an-prop-table" id="an-owner-table"></div>
      <p class="an-prop-note">担当者は現在の提案担当で集計。面談は実施履歴で数えます。企業側見送りのみの回答は、詳細を未回収として表示します。</p>`;
    filter();
    const owners=new Map();
    for(const p of ps){
      const id=p.proposalOwnerId||p.salesOwnerId||"none";
      if(!owners.has(id))owners.set(id,{name:p.proposalOwnerName||p.salesOwnerName||"担当未割当",n:0,m:0,l:0,u:0});
      const o=owners.get(id);o.n++;if(p.meetingCompleted)o.m++;if(lost(p)){o.l++;if(reasonUnclear(p))o.u++;}
    }
    const os=[...owners.values()].sort((a,b)=>b.n-a.n);
    el("an-owner-table").innerHTML=os.length?`<table class="sl-table">
      <thead><tr><th>提案担当</th><th class="num">提案</th><th class="num">面談実施</th><th class="num">面談率</th><th class="num">失注</th><th class="num">理由不明瞭</th></tr></thead>
      <tbody>${os.map(o=>`<tr><td>${esc(o.name)}</td><td class="num">${nf(o.n)}</td><td class="num">${nf(o.m)}</td><td class="num">${rate(o.m,o.n)}</td><td class="num">${nf(o.l)}</td><td class="num">${nf(o.u)}</td></tr>`).join("")}</tbody></table>`:
      "<div class='sl-empty'>期間内の提案データはありません。</div>";
  }
  function filter() {
    if (!data) return;
    const grade=el("an-company-grade")?.value||"";
    const q=(el("an-company-search")?.value||"").trim().toLowerCase();
    const counts=byCompany(periodRows());
    visible=data.companyQualifications.filter(g=>g.sent>0&&(!grade||g.grade===grade)&&(!q||g.companyName.toLowerCase().includes(q)))
      .map(g=>({...g,period:counts.get(g.key)||{sent:0,meetings:0,lost:0,unclear:0}}))
      .sort((a,b)=>Number(b.blastOnly)-Number(a.blastOnly)||b.sent-a.sent||a.companyName.localeCompare(b.companyName,"ja"));
    el("an-company-table").innerHTML=visible.length?`<table class="sl-table">
      <thead><tr><th>企業</th><th>取引判定</th><th class="num">期間提案</th><th class="num">期間面談</th>
      <th class="num">期間面談率</th><th class="num">全提案</th><th class="num">全面談</th>
      <th class="num">全期間率</th><th class="num">期間失注</th><th class="num">理由不明瞭</th></tr></thead>
      <tbody>${visible.map(g=>`<tr class="${g.blastOnly?"is-blast":""}">
        <td><a href="${g.companyId?"/sales/companies.html?id="+encodeURIComponent(g.companyId):"/sales/proposals.html?q="+encodeURIComponent(g.companyName)}">${esc(g.companyName)}</a>
        ${g.stopContact?'<span class="an-rank blast" title="配信停止・連絡停止履歴があります">配信不可・要確認</span>':""}</td>
        <td>${badge(g)}</td><td class="num">${nf(g.period.sent)}</td>
        <td class="num">${nf(g.period.meetings)}</td><td class="num">${rate(g.period.meetings,g.period.sent)}</td>
        <td class="num">${nf(g.sent)}</td><td class="num">${nf(g.meetings)}</td><td class="num">${rate(g.meetings,g.sent)}</td>
        <td class="num">${nf(g.period.lost)}</td><td class="num">${nf(g.period.unclear)}</td></tr>`).join("")}</tbody></table>`:
      "<div class='sl-empty'>該当する企業がありません。</div>";
  }
  function exportCsv() {
    if(!visible.length)return;
    const safe=v=>{
      let s=String(v??"");
      if(/^[=+\-@\t\r]/.test(s))s="'"+s;
      return '"'+s.replace(/"/g,'""')+'"';
    };
    const rows=[["企業","判定","期間提案","期間面談","期間面談率","全提案","全面談","全期間面談率","期間失注","理由不明瞭","連絡停止要確認","企業ID"],
      ...visible.map(g=>[g.companyName,GRADE_LABEL[g.grade],g.period.sent,g.period.meetings,rate(g.period.meetings,g.period.sent),
        g.sent,g.meetings,rate(g.meetings,g.sent),g.period.lost,g.period.unclear,g.stopContact?"要確認":"",g.companyId||g.sourceCompanyId||""])];
    const blob=new Blob(["\uFEFF"+rows.map(r=>r.map(safe).join(",")).join("\r\n")],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob),a=document.createElement("a");
    a.href=url;a.download="sales-proposal-companies-"+days+"d.csv";document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
  }
  return {load,filter,exportCsv};
})();