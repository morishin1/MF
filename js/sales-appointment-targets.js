// /sales/companies.html の「アポイント候補」。既存企業マスターを読み取り、
// 根拠付きの行動順を表示する。アポ獲得可能性を断定せず、自動送信・企業追加もしない。
(() => {
  const root = document.getElementById("appointment-targets-panel");
  const btn = document.getElementById("btn-appointment-targets");
  if (!root || !btn) return;
  const esc = value => String(value ?? "").replace(/[&<>"']/g,
    c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const num = value => Number(value || 0).toLocaleString("ja-JP");
  let shown = false, loaded = false, rows = [], lastData = null;

  const csv = () => {
    if (!rows.length) return;
    const headers = ["企業名","分類","優先理由","次のアクション","担当企業ID","業種","地域"];
    const quote = value => '"' + String(value ?? "").replace(/"/g,'""') + '"';
    const values = rows.map(r => [r.name,r.category,r.reason,r.nextAction,r.companyId,r.industry,r.region]);
    const content = "\ufeff" + [headers,...values].map(r => r.map(quote).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([content],{type:"text/csv;charset=utf-8"}));
    const a = document.createElement("a"); a.href=url; a.download="sales_appointment_candidates.csv";
    document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  const draw = data => {
    lastData=data; rows=data.rows||[];
    const groups=data.groups||{};
    const tiles=Object.entries(groups).map(([name,n]) =>
      '<div class="appt-chip"><small>'+esc(name)+'</small><strong>'+num(n)+'</strong><span>社</span></div>').join("");
    const tr=rows.map((r,i)=>'<tr>'+
      '<td class="appt-num">'+(i+1)+'</td>'+
      '<td><strong>'+esc(r.name)+'</strong><small>'+esc(r.industry||"業種未登録")+' ／ '+esc(r.region||"地域未登録")+'</small></td>'+
      '<td><span class="sl-pill">'+esc(r.category)+'</span><small>'+esc(r.reason)+'</small></td>'+
      '<td>'+esc(r.nextAction)+(r.nextActionOn?'<small>期限 '+esc(r.nextActionOn)+'</small>':'')+'</td>'+
      '<td><button type="button" class="btn btn-secondary btn-sm" data-appointment-company="'+esc(r.companyId)+'">詳細を開く</button></td>'+
      '</tr>').join("");
    root.innerHTML =
      '<div class="appt-head"><div><h2>アポイントを取るための候補企業</h2>'+
      '<p>返信・クリック → 提案フォロー → 対応期限 → 追客 → 未接触調査の順。面談設定済み・営業NG・旧配信停止は除外。</p></div>'+
      '<div class="appt-actions"><button class="btn btn-secondary btn-sm" id="appt-refresh" type="button">再集計</button>'+
      '<button class="btn btn-secondary btn-sm" id="appt-csv" type="button" '+(!rows.length?"disabled":"")+'>表示中をCSV出力</button></div></div>'+
      '<div class="appt-tiles">'+tiles+'</div>'+
      '<p class="appt-note">候補 '+num(data.total)+'社／上位 '+num(rows.length)+'社を表示。'+
      'ENGERとの企業ID確定リンク '+num(data.sourceCounts?.engerLinkedCompanies)+'社。'+
      '相手の発注意思やアポイント取得は未確認です。</p>'+
      '<div class="appt-table-wrap"><table class="sl-table"><thead><tr><th>優先</th><th>企業</th><th>分類・根拠</th><th>次の行動</th><th>操作</th></tr></thead>'+
      '<tbody>'+(tr||'<tr><td colspan="5">該当する候補はありません</td></tr>')+'</tbody></table></div>'+
      '<p class="appt-note">停止情報を読めない場合は候補を出しません。個人連絡先・未確認のENGER取引先は自動追加していません。</p>';
  };
  const load = async () => {
    root.innerHTML='<p class="sl-empty" role="status">企業の反応・提案・履歴・営業NGを照合しています…</p>';
    try {
      const data=await window.API.api("/api/sales/appointment-targets?limit=50");
      if (!data.complete) throw new Error("全件が読み取れなかったため表示できません。");
      draw(data);loaded=true;
    } catch(error){
      loaded=false;
      root.innerHTML='<div class="sl-warn" role="alert">'+esc(error?.hint||"企業アポイント候補を確認できません。権限・データ連携を確認してください。")+
        ' <button class="btn btn-secondary btn-sm" type="button" id="appt-refresh">再試行</button></div>';
    }
  };
  btn.addEventListener("click",()=>{
    shown=!shown;root.hidden=!shown;
    btn.setAttribute("aria-expanded",String(shown));
    btn.textContent=shown?"アポ候補を閉じる":"アポ候補を表示";
    if(shown&&!loaded)void load();
  });
  root.addEventListener("click",event=>{
    if(event.target.closest("#appt-refresh")){loaded=false;void load();return;}
    if(event.target.closest("#appt-csv")){csv();return;}
    const detail=event.target.closest("[data-appointment-company]");
    if(detail&&typeof openDetail==="function")void openDetail(detail.dataset.appointmentCompany);
  });
})();
