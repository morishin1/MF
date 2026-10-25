// Read-only visualization of already-authorized API responses; never fetches or mutates.
(function () {
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function render(root, input, openEvidence) {
    const m=window.MarketingDashboardMetrics.build(input);
    const rows=m.sourceBars;
    const max=Math.max(1,...rows.map(r=>r.openValue??0));
    const bar=(label,value,scale)=>`<span class="md-label">${esc(label)}</span><span class="md-track" aria-hidden="true"><i style="width:${value==null?0:Math.max(0,Math.min(100,value/scale*100))}%"></i></span><strong>${value==null?'未取得':esc(value)+'件'}</strong>`;
    root.innerHTML=`<h2>成果と改善のダッシュボード</h2><p>対象：${esc(({mugen:"無限道場",space:"スペース",site:"自社サイト",ec:"EC（保留）"})[input.biz]||"取得可能な全事業（EC除外）")}</p>
      <div class="md-goals"><section><h3>目標との差</h3><p>未設定</p><small>目標値・期間の設定が未接続のため、達成率は算出できません。</small></section><section><h3>媒体の反応・成果</h3><p>未計測</p><small>PV・視聴・SNS反応と問い合わせ／予約の施策への紐付けは未接続です。問い合わせ件数を売上とは扱いません。</small></section></div>
      <p class="mk-note">以下は閲覧権限で取得できた原本の現状です。全期間の成果・ユニーク顧客ではありません。媒体をまたぐ重複と帰属不明を解消できていないため合計しません。推移データ未接続のため折れ線グラフは未表示です。ECは保留です。原本ごとに取得期間・上限が異なり、棒の大小は効果の優劣を示しません。電話のGW対応受付はこの比較に含みません。</p>
      <div class="md-panels"><section><h3>原本別・対応待ちの比較</h3><p class="mk-note">横棒：取得範囲内の未完了原本件数。全期間の問い合わせ発生件数ではありません。</p>
      ${rows.length?`<ul class="md-bars">${rows.map(r=>`<li><div class="md-bar">${bar(r.label,r.openValue,max)}</div><small>${esc(r.scope||'取得範囲は原本一覧で確認')}／${r.capped?'上限あり':r.coverage==='unknown'?'網羅性未確認':'取得範囲限定'}${r.fetchedAt?'／取得 '+esc(r.fetchedAt):''}${r.openValue==null?'／'+esc(r.state):''}</small>${r.openValue==null?'':` <button type="button" class="of-btn sec" data-evidence="work" data-biz="${esc(r.biz)}">この事業の原本一覧</button>`}</li>`).join('')}</ul>`:'<p>未取得。接続状態は下の原本一覧で確認してください。</p>'}
      </section><section><h3>制作の進行上の課題</h3><p class="mk-note">制作予定原本の未公開分のみ。原本ニュースの担当欄欠落を「担当未定」とは数えません。同じ企画が複数の課題に該当する場合があります。</p>
      <ul class="md-bars"><li class="md-bar">${bar('期限超過',m.production.overdue,Math.max(1,m.production.overdue??0,m.production.unassigned??0))}</li><li class="md-bar">${bar('担当未定',m.production.unassigned,Math.max(1,m.production.overdue??0,m.production.unassigned??0))}</li></ul>
      <p class="mk-note">最大300件の取得範囲。期限超過は日本時間の今日より前の期限（停滞日数・更新履歴は未計測）。</p>
      ${m.production.state==='ok'?'<button type="button" class="of-btn sec" data-evidence="production">制作予定の根拠一覧</button>':'<p>制作予定は未取得・未準備です。0件とは判定しません。</p>'}
      </section></div><section><h3>次の改善</h3><ul><li>目標の指標・期間と、施策から反応／問い合わせ／予約へ紐付ける計測方法を決める。</li>${m.production.overdue>0?'<li>期限超過の制作予定を開き、担当と次の対応を確認する。</li>':''}${m.production.unassigned>0?'<li>担当未定の制作予定を開き、担当を決める。</li>':''}${rows.some(r=>r.openValue==null)?'<li>未取得の原本について、必要な接続・本人権限を確認する（自動付与しません）。</li>':''}</ul></section>`;
    root.onclick=e=>{const b=e.target.closest('[data-evidence]');if(b&&root.contains(b))openEvidence(b.dataset.evidence,b.dataset.biz||input.biz||'');};
  }
  window.MarketingDashboardUI={render};
})();
