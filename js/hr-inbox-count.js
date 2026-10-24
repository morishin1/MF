// 採用ダッシュボード（/hr/applicants.html）の「採用メールの新着受付」リンクに、件数を付ける。
//   新着マーク … 未対応（新着・確認中）が1件以上あるとき
//   未対応 N件 … 登録・対応終了がまだのメール（全員で同じ）
//   未読 N件   … 自分がまだ本文を開いていないもの（人ごと）。既読の記録が未設定なら「未読は確認できません」
// 取得に失敗したら「件数を取得できません」と出す（0件と出さない）。
(function (root) {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** API の返り値から、リンクの横に出す表示を作る（テスト用に分けてある） */
  function view(r) {
    if (!r || typeof r !== "object") return { html: '<span class="hic-pill err">件数を取得できません</span>', label: "件数を取得できません" };
    const open = Number(r.openCount) || 0;
    const parts = [];
    if (open > 0) parts.push('<span class="hic-pill new">新着あり</span>');
    parts.push(`<span class="hic-pill">未対応 ${open}${r.capped ? "+" : ""}件</span>`);
    if (r.readsReady === false || r.unreadCount === null || r.unreadCount === undefined) {
      parts.push('<span class="hic-pill muted" title="既読の記録が未設定です">未読は確認できません</span>');
    } else {
      parts.push(`<span class="hic-pill${r.unreadCount > 0 ? " unread" : ""}">未読 ${Number(r.unreadCount) || 0}件</span>`);
    }
    const label = `未対応 ${open}件` + (r.readsReady === false || r.unreadCount == null ? "（未読は確認できません）" : `、未読 ${Number(r.unreadCount) || 0}件`);
    return { html: parts.join(""), label };
  }

  function css() {
    if (document.getElementById("hic-css")) return;
    const s = document.createElement("style");
    s.id = "hic-css";
    s.textContent = `.hic-wrap{display:inline-flex;gap:4px;flex-wrap:wrap;align-items:center;margin-left:6px}
      .hic-pill{display:inline-block;font-size:11px;border-radius:999px;padding:2px 8px;background:#eef1f7;color:#1b2440;font-weight:700;white-space:nowrap}
      .hic-pill.new{background:#b3261e;color:#fff}.hic-pill.unread{background:#fff3d4;color:#804f00}
      .hic-pill.muted{background:#f2f2ee;color:#6b7080;font-weight:500}.hic-pill.err{background:#fde8e6;color:#8c1d18}`;
    document.head.appendChild(s);
  }

  async function mount(link) {
    if (!link || !root.API) return null;
    css();
    let box = link.querySelector(".hic-wrap");
    if (!box) { box = document.createElement("span"); box.className = "hic-wrap"; link.appendChild(box); }
    box.innerHTML = '<span class="hic-pill muted">件数を確認中…</span>';
    let r = null;
    try { r = await root.API.api("/api/hr/inbox?count=1"); } catch { r = null; }
    const v = view(r);
    box.innerHTML = v.html;
    link.setAttribute("aria-label", "採用メールの新着受付（" + v.label + "）");
    return r;
  }

  root.HrInboxCount = { view, mount, esc };
})(typeof window !== "undefined" ? window : globalThis);
