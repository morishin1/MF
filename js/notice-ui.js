/* 社内お知らせ共通: 長文は一覧に展開しない。開いただけでは既読にしない。 */
(function () {
  "use strict";
  const labels = { general:"お知らせ", important:"重要", event:"イベント", system:"システム" };
  const esc = (value) => KPLayout.esc(String(value == null ? "" : value));
  const safeCategory = (n) => Object.hasOwn(labels, n.category) ? n.category : "general";
  const dateTime = (n) => {
    const t = new Date(n.publish_at).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const date = (n) => dateTime(n) ? new Date(n.publish_at).toLocaleDateString("ja-JP",{year:"numeric",month:"numeric",day:"numeric"}) : "";
  // 優先順位: 未読の重要 → 未読の固定 → その他の未読 → 確認済み。各群は新着順。
  function score(n) {
    if (!n.read && n.category === "important") return 0;
    if (!n.read && n.pinned) return 1;
    if (!n.read) return 2;
    if (n.pinned) return 3;
    return 4;
  }
  const sort = (items) => [...items].sort((a,b) => score(a)-score(b) || dateTime(b)-dateTime(a));
  const excerpt = (n) => String(n.body || "").replace(/\s+/g," ").trim().slice(0,160);
  function chips(n) {
    const category = safeCategory(n);
    return '<span class="kp-chip '+category+'">'+esc(labels[category])+'</span>'
      + (n.pinned ? '<span class="kp-chip pinned">固定</span>' : "")
      + (!n.read ? '<span class="kp-chip important">未読</span>' : "");
  }
  function item(n, home) {
    const id = esc(n.id);
    const c = 'notice-item'+(n.read ? ' is-read' : ' is-unread')+(n.category === "important" ? " is-important" : "");
    const a = home ? '<button type="button" class="'+c+'" data-home-notice-id="'+id+'">' : '<button type="button" class="'+c+'" data-notice-id="'+id+'">';
    const end = '</button>';
    return a
      + '<span class="notice-item-top">'+chips(n)+'<time class="notice-date">'+esc(date(n))+'</time></span>'
      + '<span class="notice-item-main"><span class="notice-item-content">'
      + '<span class="notice-title">'+esc(n.title)+'</span>'
      + (!home && excerpt(n) ? '<span class="notice-excerpt">'+esc(excerpt(n))+'</span>' : '')
      + '</span><span class="material-symbols-outlined notice-arrow" aria-hidden="true">chevron_right</span></span>'
      + end;
  }
  function preview(items) {
    // ホームは未読のみ。既読は社内情報の履歴でいつでも確認できる。
    const unread = sort(items.filter((n) => !n.read));
    const prioritized = unread.slice(0, 3);
    if (!prioritized.length) return "";
    return '<div class="notice-list">'+prioritized.map((n)=>item(n,true)).join('')+'</div>'
      + (unread.length > 3 ? '<a href="notices.html?filter=unread" class="notice-all-link">ほかの未読 '+(unread.length-3)+' 件を見る <span aria-hidden="true">→</span></a>' : '');
  }
  function detail(n) {
    return '<div class="notice-dialog-inner">'
      + '<header class="notice-dialog-head"><div>'
      + '<div class="notice-dialog-meta">'+chips(n)+'<time class="notice-date">'+esc(date(n))+'</time></div>'
      + '<h2 id="notice-dialog-title">'+esc(n.title)+'</h2>'
      + '</div><button type="button" class="notice-dialog-close" data-close aria-label="閉じる"><span class="material-symbols-outlined" aria-hidden="true">close</span></button></header>'
      + '<div class="notice-dialog-body">'+esc(n.body)+'</div>'
      + '<footer class="notice-dialog-foot"><span class="notice-feedback" id="notice-feedback" role="alert"></span>'
      + (n.read ? '<span class="notice-dialog-read"><span class="material-symbols-outlined" aria-hidden="true">check_circle</span>確認済み</span>' : '<button class="btn btn-primary notice-ack" type="button" data-ack>確認して既読にする</button>')
      + '<button type="button" class="btn btn-secondary" data-close>閉じる</button></footer></div>';
  }
  window.NoticeUI = { sort, item, preview, detail };
})();