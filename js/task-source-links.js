// タスク詳細「関連URL」の安全なワンクリック導線。
// 版固定された task-drawer.js は変更せず、描画後にリンクだけ付ける。
(function () {
  "use strict";

  function externalTaskLink(raw) {
    try {
      const u = new URL(String(raw || "").trim());
      if (!["https:", "http:"].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
      const host = u.hostname.toLowerCase();
      const label = host === "mail.google.com" ? "Gmailを開く"
        : host === "app.slack.com" || host === "slack.com" || host.endsWith(".slack.com")
          ? "Slackを開く" : "関連URLを開く";
      return { href: u.href, label };
    } catch { return null; }
  }

  function decorate() {
    const input = document.getElementById("td-url");
    if (!input) return;
    const row = input.closest(".td-row");
    if (!row) return;

    const existing = row.querySelector(".td-source-open");
    const link = externalTaskLink(input.value);
    if (!link) {
      if (existing) existing.remove();
      return;
    }
    if (existing && existing.href === link.href && existing.textContent.trim() === link.label) return;
    const a = existing || document.createElement("a");
    a.className = "btn btn-secondary btn-sm td-source-open";
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("aria-label", link.label);
    a.textContent = link.label;
    a.style.cssText = "margin:8px 0 0;display:inline-flex;align-items:center;gap:5px;max-width:100%;overflow-wrap:anywhere";
    if (!existing) input.insertAdjacentElement("afterend", a);
  }

  // ドロワーの描き直し（概要/コメント/保存後の再取得）にも追従する。
  // MutationObserverが自身で追加したa要素を検出しても、内容が同じなら更新せず終了する。
  const observer = new MutationObserver(decorate);
  observer.observe(document.body, { childList: true, subtree: true });
  decorate();
})();
