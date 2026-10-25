// Confirmation-only UI. One existing authorized GET; no edit, AI, publication or new ledger.
(function(){
  const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let data=null,sequence=0;
  const channels=[['無限道場サイト','対象原本の公開接続・本人権限をこの確認版では未検証'],['自社サイト','既存制作原本の読取のみ。公開操作は無効'],['Spaceサイト','space_articles の既存CMSを再利用予定。Marketing接続は未有効化'],['ECサイト','後回し・対象外'],['Instagram / X / その他SNS','外部投稿API・接続権限・費用は未承認。既存Space機能は文案生成/手動共有まで'],['PR TIMES','既存Space草案のコピー/画像アップロード等は外部操作。直接配信APIは未接続']];
  function rows(){const k=$('pub-kind').value;return (data?.items||[]).filter(x=>x.biz!=='ec'&&x.medium===k&&['plan','site_news'].includes(x.origin)&&data.sources?.some(s=>s.key===x.origin&&s.state==='ok'));}
  function render(){
    const items=rows(),k=$('pub-kind').value,previous=$('pub-source').value;
    $('pub-source').innerHTML='<option value="">原稿を選択</option>'+items.map(x=>`<option value="${esc(x.key)}">${esc(x.title||'無題')}（${esc(x.biz)}）</option>`).join('');
    $('pub-source').disabled=!items.length; if(items.some(x=>x.key===previous))$('pub-source').value=previous;
    $('pub-scope').textContent=k==='press'?'Spaceに既存のリリース草案機能がありますが、この画面の読取接続は未実装です。0件ではありません。':'既存Marketing APIが本人権限で返した制作予定のみ。最大300件等の原本制限があり、全原稿ではありません。Space記事/文案はこの一覧へ未接続です。';
    detail();
  }
  function detail(){
    const x=rows().find(x=>x.key===$('pub-source').value);
    const state=x?.state?.label||'未確認';
    $('pub-detail').innerHTML=x?`<h2>${esc(x.title)}</h2><dl><dt>既存原稿参照</dt><dd>${esc(x.key)}</dd><dt>種別 / 原本ID</dt><dd>${esc(x.sourceType||x.origin)} / ${esc(x.sourceId||x.id||(x.origin==='site_news'?x.key.slice('site_news:'.length):'未提供'))}</dd><dt>事業 / 原本の表示状態</dt><dd>${esc(x.biz)} / ${esc(state)}</dd></dl><h3>保存済み要約・抜粋の確認（原本全文は未取得）</h3><pre>${esc(x.summary||'本文・文案はこの応答にはありません。未取得です。')}</pre><p>これはAPIが返した要約・文案のテキスト確認（サイト記事は最大120文字の抜粋）であり、各媒体の実際の公開画面プレビューではありません。</p>${x.medium==='youtube'?`<p>既存YouTube動画ID：${esc(x.youtubeVideoId||'未登録/未取得')}。新規アップロードは行いません。</p>`:''}`:'<h2>原稿プレビュー</h2><p>取得済み原稿を選んでください。未接続の原稿を架空データで補いません。</p>';
    $('pub-detail').insertAdjacentHTML('beforeend','<button type="button" disabled>原稿を編集</button><button type="button" disabled>AIで派生文を生成</button><p>編集接続・本人の書込権限・AI費用承認が未確認のため無効です。外部へ内容は送信しません。</p>');
    $('pub-destinations').innerHTML=channels.map(([name,reason])=>`<section><h3>${esc(name)}</h3><p>${esc(reason)}</p><p>媒体別の公開状態：未確認 ／ 実媒体プレビュー：未接続</p><button type="button" disabled>公開先に選ぶ</button><button type="button" disabled>媒体別プレビュー</button><button type="button" disabled>確認して公開</button></section>`).join('');
  }
  async function load(){const n=++sequence;data=null;$('pub-kind').disabled=true;$('pub-source').disabled=true;$('pub-status').textContent='原本を読込中です';$('pub-retry').hidden=true;render();try{const got=await API.api('/api/marketing?view=production');if(n!==sequence)return;if(!got||!Array.isArray(got.items)||!Array.isArray(got.sources)||got.items.some(x=>!x||typeof x!=='object'||typeof x.key!=='string')||got.sources.some(s=>!s||typeof s!=='object'||typeof s.key!=='string'))throw Error('原本応答を確認できません');data=got;$('pub-status').textContent='取得できた原本のみ表示しています。保存・公開は無効です。';}catch(e){if(n!==sequence)return;$('pub-status').textContent='取得できませんでした。未接続・権限・接続状態を確認してください。0件ではありません。';$('pub-retry').hidden=false;}if(n===sequence){$('pub-kind').disabled=false;render();}}
  $('pub-kind').onchange=()=>{$('pub-source').value='';render();};$('pub-source').onchange=detail;$('pub-retry').onclick=load;
  MarketingLayout.init().then(ctx=>{if(ctx)return load();}).catch(()=>{$('pub-status').textContent='ログイン・Marketing権限を確認できませんでした';});
})();
