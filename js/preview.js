// preview.js — 書類プレビュー用の共通モーダル。
// window.openPreview(documentId) を提供。API.documentPreviewUrl に依存。
(function () {
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
            <a id="kp-preview-open" href="#" target="_blank" rel="noopener" style="font-size:12px;color:#3182ce;font-weight:600;text-decoration:none;">新しいタブで開く</a>
            <button onclick="KP_closePreview()" style="border:none;background:#edf2f7;border-radius:6px;width:30px;height:30px;cursor:pointer;font-size:18px;line-height:1;">×</button>
          </div>
        </div>
        <div id="kp-preview-body" style="flex:1;overflow:auto;background:#f5f7fb;display:flex;align-items:center;justify-content:center;min-height:320px;"></div>
      </div>`;
    m.addEventListener("click", (e) => { if (e.target === m) KP_closePreview(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") KP_closePreview(); });
    document.body.appendChild(m);
    return m;
  }

  window.KP_closePreview = function () {
    const m = document.getElementById("kp-preview");
    if (m) { m.style.display = "none"; document.getElementById("kp-preview-body").innerHTML = ""; }
  };

  window.openPreview = async function (documentId) {
    const m = ensureModal();
    const body = document.getElementById("kp-preview-body");
    const title = document.getElementById("kp-preview-title");
    title.textContent = "読み込み中…";
    body.innerHTML = `<div style="color:#718096;padding:40px;">読み込み中…</div>`;
    m.style.display = "flex";
    try {
      const info = await API.documentPreviewUrl(documentId);
      title.textContent = info.filename || "プレビュー";
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
      body.innerHTML = `<div style="padding:40px;color:#c53030;">プレビューに失敗しました: ${(e && e.message) || e}</div>`;
    }
  };
})();
