// 保存・提出・次へ進めないとき、理由と次にすることを1つのダイアログで伝える。
// 全アプリ（HR / Sales / Office / KEIEI）から同じ手順で使用できる。
// KPActionFeedback.show({title, message, actionLabel, actionHref})
// KPActionFeedback.show({title, message, actionLabel, onAction: () => ...})
(function () {
  "use strict";
  let dialog = null;
  let currentAction = null;

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "kp-action-feedback";
    dialog.className = "kp-action-feedback";
    dialog.setAttribute("aria-labelledby", "kp-action-feedback-title");
    dialog.setAttribute("aria-describedby", "kp-action-feedback-message");

    const wrap = document.createElement("div");
    wrap.className = "kp-action-feedback-body";
    const mark = document.createElement("span");
    mark.className = "material-symbols-outlined kp-action-feedback-icon";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = "info";
    const title = document.createElement("h2");
    title.id = "kp-action-feedback-title";
    const message = document.createElement("p");
    message.id = "kp-action-feedback-message";
    const actions = document.createElement("div");
    actions.className = "kp-action-feedback-actions";
    const close = document.createElement("button");
    close.className = "btn btn-secondary";
    close.type = "button";
    close.textContent = "閉じる";
    close.addEventListener("click", () => dialog.close());
    const primary = document.createElement("a");
    primary.className = "btn btn-primary";
    primary.id = "kp-action-feedback-primary";
    primary.href = "#";
    primary.textContent = "確認する";
    primary.addEventListener("click", async (event) => {
      if (!currentAction) return; // 通常の同一オリジンリンクはブラウザに任せる
      event.preventDefault();
      const callback = currentAction;
      dialog.close();
      try { await callback(); }
      catch (e) { console.error("[action-feedback] action failed", e); }
    });
    actions.append(close, primary);
    wrap.append(mark, title, message, actions);
    dialog.append(wrap);
    document.body.append(dialog);
    return dialog;
  }

  function show({ title, message, actionLabel, actionHref, onAction } = {}) {
    const el = ensureDialog();
    const primary = el.querySelector("#kp-action-feedback-primary");
    el.querySelector("#kp-action-feedback-title").textContent = String(title || "確認が必要です");
    el.querySelector("#kp-action-feedback-message").textContent =
      String(message || "入力内容を確認してください。");
    currentAction = typeof onAction === "function" ? onAction : null;
    primary.hidden = !actionLabel;
    primary.textContent = String(actionLabel || "");
    if (actionLabel && actionHref) {
      // 遷移先はアプリ内URLのみ。画面・API由来の文字列をそのまま外部リンクにしない。
      const url = new URL(actionHref, location.origin);
      if (url.origin !== location.origin) throw new Error("action_href_must_be_same_origin");
      primary.href = url.pathname + url.search + url.hash;
    } else {
      primary.href = "#";
    }
    if (!el.open) el.showModal();
    el.querySelector(".kp-action-feedback-actions button").focus();
    return el;
  }

  function hide() { if (dialog?.open) dialog.close(); }
  window.KPActionFeedback = Object.freeze({ show, hide });
}());
