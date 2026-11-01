// Salesのダッシュボード：根拠行を押すと表示する小型の読み取り専用モーダル。
// 原因と確認できた事実を区別し、未回答/記録不足を勝手に失注理由として推測しない。
window.SalesDashboardQuick = (() => {
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let opener=null, activeId=null, onDetail=null, requestSeq=0;
  const root = () => document.getElementById("pp-quick-root");
  const displayDate = iso => {
    if (!iso || !Number.isFinite(Date.parse(iso))) return "未登録";
    return new Date(iso).toLocaleString("ja-JP", {
      timeZone:"Asia/Tokyo",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"
    });
  };
  const usable = v => v != null && String(v).trim() ? String(v) : null;
  function knownReason(p, row) {
    if (usable(p?.closeReasonLabel)) {
      if (p.closeReason === "client_declined" || p.closeReason === "other")
        return { reason:"見送り区分：" + p.closeReasonLabel, verified:false,
          note:"具体的な見送り理由までは確認できていません。" };
      return {reason:"終了理由：" + p.closeReasonLabel,verified:true,note:"Salesに記録されている区分です。"};
    }
    if (p?.candidateResponse === "pass") return {reason:"人材側：見送り",verified:true,note:"ENGERの回答区分です。具体理由は未取得です。"};
    if (p?.companyResponse === "pass") return {reason:"企業側：見送り",verified:true,note:"ENGERの回答区分です。具体理由は未取得です。"};
    if (row.category === "no_call") return {reason:"提案後の電話実施記録がありません",verified:true,
      note:"実際の未実施か、登録漏れかは未確認です。"};
    if (row.category === "overdue" || row.overdue) return {reason:"期限を過ぎた未完了タスクがあります",verified:true,
      note:"なぜ遅れたかは未確認です。対応履歴を確認してください。"};
    if (row.category === "unassigned") return {reason:"営業担当が未割当です",verified:true,
      note:"担当者が設定されていないことを確認できています。"};
    if (row.category === "proposal_wait") return {reason:"企業への提案送信日時が未登録です",verified:true,
      note:"実際の未送信か、連携・記録漏れかは未確認です。"};
    return {reason:"停滞の原因は未確認です",verified:false,
      note:"記録から確定できる理由はありません。担当者へ状況確認が必要です。"};
  }
  function close() {
    ++requestSeq;
    if (root()) root().innerHTML="";
    activeId=null;onDetail=null;
    if (opener?.isConnected) opener.focus({preventScroll:true});
    opener=null;
  }
  function open(row, proposal, detailAction, trigger) {
    if (!row?.proposalId || !root()) return;
    const token=++requestSeq;
    activeId=row.proposalId;
    opener=trigger || document.activeElement;
    onDetail=detailAction;
    const draw = (detail=null,loading=false,error="") => {
      if (activeId!==row.proposalId || token!==requestSeq) return;
      const p=detail?.proposal || proposal || {};
      const r=knownReason(p,row);
      const actions=(detail?.activities||[]).slice().sort((a,b)=>
        String(b.occurredAt||"").localeCompare(String(a.occurredAt||""))).slice(0,3);
      const last = actions.length ? actions.map(a =>
        `<div class="pp-quick-event"><span>${esc(displayDate(a.occurredAt))}</span><b>${esc(a.label||a.kind||"対応記録")}</b>
          ${a.note ? `<small>${esc(String(a.note).slice(0,180))}</small>` : ""}</div>`).join("") :
          '<p class="pp-quick-muted">表示できる対応履歴はありません。</p>';
      root().innerHTML=`<div class="pp-quick-overlay" onclick="SalesDashboardQuick.close()"></div>
        <section class="pp-quick-dialog" role="dialog" aria-modal="true" aria-labelledby="pp-quick-title" tabindex="-1">
          <header><div><small>案件のクイック確認</small><h2 id="pp-quick-title">${esc(row.companyName)}</h2>
            <p>${esc(row.title)} ／ ${esc(p.statusLabel||row.statusLabel)}</p></div>
            <button type="button" class="pp-quick-close" onclick="SalesDashboardQuick.close()" aria-label="閉じる">×</button>
          </header>
          <div class="pp-quick-grid">
            <div><small>次にやること</small><b>${esc(row.action)}</b></div>
            <div><small>タスク担当</small><b>${esc(row.assigneeName)}</b></div>
            <div><small>期限</small><b class="${row.overdue?"pp-quick-danger":""}">${esc(displayDate(row.dueAt))}${row.overdue?"（超過）":""}</b></div>
            <div><small>電話の最終記録</small><b>${esc(p.call?.label||"記録なし")}</b></div>
          </div>
          <div class="pp-quick-reason"><h3>状況・理由の確認</h3>
            <b>${esc(r.reason)}</b><p>${esc(r.note)}</p>
            ${p.sourceStatePending ? '<p>ENGER同期状況：未確認</p>' : ""}
            ${p.companyResponseLabel ? `<p>企業回答：${esc(p.companyResponseLabel)}</p>` : ""}
            ${p.candidateResponseLabel ? `<p>人材回答：${esc(p.candidateResponseLabel)}</p>` : ""}
          </div>
          <div class="pp-quick-history"><h3>最近の対応記録</h3>
            ${loading?'<p class="pp-quick-muted">詳細履歴を確認中…</p>':
              error?`<p class="pp-quick-muted">詳細履歴を取得できません：${esc(error)}</p>`:
              last}</div>
          <footer><button type="button" class="btn btn-secondary btn-sm" onclick="SalesDashboardQuick.close()">閉じる</button>
            <button type="button" class="btn btn-primary btn-sm" onclick="SalesDashboardQuick.showDetail()">詳細で確認・対応する</button></footer>
        </section>`;
    };
    draw(null,true);
    root().querySelector(".pp-quick-close")?.focus({preventScroll:true});
    if (!window.API?.api) { draw(null,false,"APIが利用できません"); return; }
    window.API.api("/api/sales/proposals/detail?id="+encodeURIComponent(row.proposalId))
      .then(d=>{if(token===requestSeq && activeId===row.proposalId) draw(d);})
      .catch(e=>{if(token===requestSeq && activeId===row.proposalId) draw(null,false,e?.hint||e?.message||"詳細の取得に失敗");});
  }
  function showDetail() {
    const action=onDetail;
    close();
    if (typeof action==="function") action();
  }
  document.addEventListener("keydown",e=>{
    if (e.key==="Escape" && root()?.innerHTML) { e.preventDefault();e.stopPropagation();close(); }
  });
  return {open,close,showDetail,knownReason};
})();