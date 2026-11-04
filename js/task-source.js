/* タスクの依頼元表示。保存済みのURL／occ_key／category以外から推測しない。 */
(function (global) {
  "use strict";

  const LOGOS = {
    slack: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
      + '<path fill="#36C5F0" d="M9 1a2 2 0 0 1 2 2v6H9a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2ZM3 9a2 2 0 0 1 0-4h4a2 2 0 0 1 2 2v2H3Z"/>'
      + '<path fill="#2EB67D" d="M21 9a2 2 0 0 1-2 2h-6V9a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2Zm-8-6a2 2 0 0 1 4 0v4a2 2 0 0 1-2 2h-2V3Z"/>'
      + '<path fill="#ECB22E" d="M15 23a2 2 0 0 1-2-2v-6h2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2Zm6-10a2 2 0 0 1 0 4h-4a2 2 0 0 1-2-2v-2h6Z"/>'
      + '<path fill="#E01E5A" d="M1 15a2 2 0 0 1 2-2h6v2a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2Zm10 6a2 2 0 0 1-4 0v-4a2 2 0 0 1 2-2h2v6Z"/>'
      + '</svg>',
    gmail: '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
      + '<path fill="#4285F4" d="M2 5.2h4v14.3H4a2 2 0 0 1-2-2V5.2Z"/>'
      + '<path fill="#34A853" d="M18 5.2h4v12.3a2 2 0 0 1-2 2h-2V5.2Z"/>'
      + '<path fill="#EA4335" d="M2 5.2V4a2.5 2.5 0 0 1 4-2l6 4.6L18 2a2.5 2.5 0 0 1 4 2v1.2L12 13 2 5.2Z"/>'
      + '<path fill="#C5221F" d="M2 4a2.5 2.5 0 0 1 4-2v6.3L2 5.2V4Z"/>'
      + '<path fill="#FBBC04" d="M18 2a2.5 2.5 0 0 1 4 2v1.2l-4 3.1V2Z"/>'
      + '</svg>'
  };

  function fromLink(link) {
    if (typeof link !== "string" || !link.trim()) return null;
    try {
      const url = new URL(link.trim());
      if (url.protocol !== "https:") return null;
      const host = url.hostname.toLowerCase();
      if ((host === "slack.com" || host.endsWith(".slack.com"))
          && /^\/archives\/[^/]+\/p\d{10,}(?:\/|$)/.test(url.pathname)) {
        return { kind: "slack", href: url.href };
      }
      if (host === "mail.google.com" && url.pathname.startsWith("/mail/")) {
        return { kind: "gmail", href: url.href };
      }
    } catch (_error) { /* 無効なリンクには遷移しない */ }
    return null;
  }

  function getOrigin(task) {
    if (!task || typeof task !== "object") return null;
    const linked = fromLink(task.link);
    const occ = String(task.occ_key || "").toLowerCase();
    const category = String(task.category || "").trim();
    let hinted = null;
    if (occ.startsWith("slack:") || /^slack(?:依頼)?$/i.test(category)) hinted = "slack";
    if (occ.startsWith("gmail:") || /^gmail(?:依頼)?$/i.test(category)) {
      if (hinted && hinted !== "gmail") return null;
      hinted = "gmail";
    }
    // 保存済みの参照情報が食い違う場合、依頼元を推測して表示しない。
    if (linked && hinted && linked.kind !== hinted) return null;
    const kind = linked?.kind || hinted;
    return kind ? { kind, href: linked?.href || null } : null;
  }

  function escapeAttribute(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[ch]);
  }

  function iconHtml(task) {
    const origin = getOrigin(task);
    if (!origin) return "";
    const label = origin.kind === "slack" ? "Slack" : "Gmail";
    const title = label + (origin.href ? "の元メッセージを開く" : "からの依頼");
    const common = 'class="gw-task-source" aria-label="' + title + '" title="' + title
      + '" style="display:inline-flex;width:21px;height:21px;align-items:center;justify-content:center;vertical-align:middle;flex:0 0 21px;margin-right:6px;border-radius:4px;text-decoration:none"';
    if (origin.href) {
      return '<a ' + common + ' href="' + escapeAttribute(origin.href)
        + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">'
        + LOGOS[origin.kind] + '</a>';
    }
    return '<span ' + common + ' role="img">' + LOGOS[origin.kind] + '</span>';
  }

  global.GWTaskSource = Object.freeze({ getOrigin, iconHtml });
})(window);
