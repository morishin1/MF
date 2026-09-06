// preview.js — 書類プレビュー用の共通モーダル。
// window.openPreview(documentId) … プレビューを開く（ヘッダに削除ボタン付き）
// window.KP_deleteDocument(documentId, filename) … 確認ダイアログ付きの削除。一覧の行からも使う
// 削除に成功すると window.KP_onDocumentDeleted(documentId) を呼ぶので、
// 各画面はそこで一覧を再読込する。API.documentPreviewUrl / API.deleteDocument に依存。
(function () {
  const JS_VERSION = "20260910m";   // このファイル自身の版
  // 画面のHTMLがどの版か（上部のビルド印から読む）。JSとHTMLの版ズレを検出できる。
  function htmlVersion() {
    const t = document.querySelector(".brand .tag.build");
    return (t && t.textContent.replace("build", "").trim()) || "不明";
  }

  // 開いている書類。削除ボタンの確認文とAPI呼び出しに使う。
  let current = null; // { id, filename, deletable }

  function ensureModal() {
    let m = document.getElementById("kp-preview");
    if (m) return m;
    m = document.createElement("div");
    m.id = "kp-preview";
    m.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;z-index:1000;padding:20px;";
    m.innerHTML = `
      <div style="background:#fff;border-radius:12px;max-width:900px;width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #e2e8f0;">
          <div id="kp-preview-title" style="font-weight:600;font-size:14px;color:#1a202c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>
          <div style="display:flex;gap:10px;align-items:center;flex:0 0 auto;">
            <button id="kp-preview-delete" type="button" onclick="KP_deleteFromPreview()" disabled
              title="削除" aria-label="削除"
              style="display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:none;border-radius:6px;background:transparent;color:#a0aec0;cursor:pointer;font-family:inherit;">
              <span class="material-symbols-outlined" style="font-size:19px;">delete</span>
            </button>
            <a id="kp-preview-open" href="#" target="_blank" rel="noopener" style="font-size:12px;color:#3182ce;font-weight:600;text-decoration:none;">新しいタブで開く</a>
            <button onclick="KP_closePreview()" style="border:none;background:#edf2f7;border-radius:6px;width:30px;height:30px;cursor:pointer;font-size:18px;line-height:1;">×</button>
          </div>
        </div>
        <div id="kp-preview-note" style="display:none;padding:8px 16px;font-size:12px;border-bottom:1px solid #e2e8f0;"></div>
        <div id="kp-preview-body" style="flex:1;overflow:auto;background:#f5f7fb;display:flex;align-items:center;justify-content:center;min-height:320px;"></div>
      </div>`;
    m.addEventListener("click", (e) => { if (e.target === m) KP_closePreview(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") KP_closePreview(); });
    document.body.appendChild(m);
    return m;
  }

  function note(msg, kind) {
    const n = document.getElementById("kp-preview-note");
    if (!n) return;
    if (!msg) { n.style.display = "none"; n.textContent = ""; return; }
    n.style.display = "block";
    n.style.background = kind === "err" ? "#fff5f5" : "#fffaf0";
    n.style.color = kind === "err" ? "#c53030" : "#975a16";
    n.textContent = msg;
  }

  // 会計ソフトへ登録済みの証憑はサーバ側でも削除を拒否する。ボタンも押せなくしておく。
  function setDeletable(ok, reason) {
    const b = document.getElementById("kp-preview-delete");
    if (!b) return;
    b.disabled = !ok;
    b.style.opacity = ok ? "1" : ".35";
    b.style.color = ok ? "#c53030" : "#a0aec0";
    b.style.cursor = ok ? "pointer" : "not-allowed";
    b.title = ok ? "削除" : (reason || "削除できません");
  }

  window.KP_closePreview = function () {
    const m = document.getElementById("kp-preview");
    if (m) { m.style.display = "none"; document.getElementById("kp-preview-body").innerHTML = ""; }
    note("");
    current = null;
  };

  window.openPreview = async function (documentId) {
    const m = ensureModal();
    const body = document.getElementById("kp-preview-body");
    const title = document.getElementById("kp-preview-title");
    current = { id: documentId, filename: "", deletable: false };
    note("");
    setDeletable(false);
    title.textContent = "読み込み中…";
    body.innerHTML = `<div style="color:#718096;padding:40px;">読み込み中…</div>`;
    m.style.display = "flex";
    try {
      const info = await API.documentPreviewUrl(documentId);
      if (!current || current.id !== documentId) return; // 別の書類に切り替わっていたら捨てる
      title.textContent = info.filename || "プレビュー";
      current.filename = info.filename || "";
      current.deletable = info.status !== "sent";
      setDeletable(current.deletable, "会計ソフトへ登録済みの書類は削除できません");
      if (!current.deletable) note("この書類は会計ソフトへ登録済みのため削除できません。", "warn");
      document.getElementById("kp-preview-open").href = info.url;
      const mt = info.mimeType || "";
      if (mt.startsWith("image/")) {
        body.innerHTML = `<img src="${info.url}" alt="preview" style="max-width:100%;max-height:88vh;object-fit:contain;">`;
      } else if (mt === "application/pdf") {
        body.innerHTML = `<iframe src="${info.url}" style="width:100%;height:88vh;border:0;"></iframe>`;
      } else {
        body.innerHTML = `<div style="padding:40px;text-align:center;color:#718096;">
          この形式（${mt || "不明"}）は画面プレビューに未対応です。<br>
          <a href="${info.url}" target="_blank" rel="noopener" style="color:#3182ce;font-weight:600;">ダウンロードして開く</a></div>`;
      }
    } catch (e) {
      // プレビューできない壊れたアップロードこそ消したいので、削除は許可したまま出す
      title.textContent = "プレビューできません";
      if (current && current.id === documentId) { current.deletable = true; setDeletable(true); }
      body.innerHTML = `<div style="padding:40px;color:#c53030;">プレビューに失敗しました: ${(e && e.message) || e}</div>`;
    }
  };

  // モーダルのヘッダから削除
  window.KP_deleteFromPreview = async function () {
    if (!current) return;
    const btn = document.getElementById("kp-preview-delete");
    const { id, filename } = current;
    if (btn) { btn.disabled = true; btn.style.opacity = ".45"; }
    const ok = await KP_deleteDocument(id, filename, (msg) => note(msg, "err"));
    if (ok) KP_closePreview();
    else if (btn) { btn.disabled = false; btn.style.opacity = "1"; }
  };

  // 確認 → 削除 → 画面へ通知。成功なら true。
  // onError を渡すとその関数へメッセージを流す（未指定なら alert）。
  window.KP_deleteDocument = async function (documentId, filename, onError) {
    const name = filename || "この書類";
    const okToGo = window.confirm(
      `「${name}」を削除します。\n\n` +
      `・この書類から作られた仕訳ドラフトも一緒に削除されます\n` +
      `・Google Drive に保存済みのファイルはゴミ箱へ移動します\n\n` +
      `元に戻せません。削除してよろしいですか？`
    );
    if (!okToGo) return false;
    try {
      const res = await API.deleteDocument(documentId);
      if (res.warnings && res.warnings.length) {
        // DBからは消えているので削除自体は成功。消し残りだけ知らせる。
        const where = res.warnings.map((w) => (w.step === "drive" ? "Google Drive" : "ストレージ")).join(" / ");
        alert(`削除しましたが、${where} 上のファイルが残った可能性があります。管理者にご確認ください。`);
      }
      if (typeof window.KP_onDocumentDeleted === "function") window.KP_onDocumentDeleted(documentId);
      return true;
    } catch (e) {
      const msg = `削除に失敗しました\n\n理由: ${e.message || e}`
        + (e.detail ? `\n詳細: ${e.detail}` : "")
        + `\n\n--- 問い合わせ用 ---\nid: ${documentId}\nhtml: ${htmlVersion()} / js: ${JS_VERSION}`;
      if (typeof onError === "function") onError(msg); else alert(msg);
      return false;
    }
  };
})();
