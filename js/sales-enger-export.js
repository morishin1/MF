// ENGER企業DBの経営者用CSV全件ダウンロード。
// 通常ユーザーにはボタン自体を出さない。APIでも owner role を検証。
// 画面の50件を連結せず、DB側で7,000社超を正確に取り直す。
(() => {
  const root = document.getElementById("enger-company-directory");
  const toolbar = root?.querySelector(".engr-controls");
  if (!toolbar || !window.API?.getToken) return;
  const box = document.createElement("div");
  box.className = "engr-owner-export";
  box.hidden = true;
  box.style.cssText = "display:flex;gap:7px;align-items:center;flex-wrap:wrap;";
  box.innerHTML = '<button type="button" class="btn btn-secondary btn-sm" id="enger-owner-export-filtered">絞り込み全件CSV</button>' +
    '<button type="button" class="btn btn-secondary btn-sm" id="enger-owner-export-all">全企業CSV</button>' +
    '<small id="enger-owner-export-message" role="status" style="font-size:11px;color:#697387"></small>';
  toolbar.appendChild(box);
  const message = box.querySelector("#enger-owner-export-message");
  const filtered = box.querySelector("#enger-owner-export-filtered");
  const full = box.querySelector("#enger-owner-export-all");
  let allowed=false;
  const endpoint = "/api/sales/enger-company-export";

  function getParams(scope) {
    const p = new URLSearchParams({scope});
    if (scope === "filtered") {
      const active = root.querySelector('[data-engr-bucket][aria-selected="true"]');
      p.set("bucket", active?.dataset.engrBucket || "revive");
      const q = root.querySelector("#enger-dir-search")?.value?.trim();
      const priority = root.querySelector("#enger-dir-priority")?.value;
      if (q) p.set("q", q);
      if (priority) p.set("priority", priority);
      if (root.querySelector("#enger-dir-sector")?.checked) p.set("siSes", "1");
      if (root.querySelector("#enger-dir-hidden")?.checked) p.set("includeHidden", "1");
    }
    return p;
  }

  window.openEngerDownload=()=>{
    if(!allowed){openActionModal('<h2>CSVダウンロード</h2><p>企業DBの全件CSVは経営者のみ利用できます。権限の確認中は少し待ってから再度お試しください。</p><button class="btn btn-secondary" onclick="closeAction()">閉じる</button>');return;}
    openActionModal('<h2>CSVでダウンロード</h2><label><input type="radio" name="engr-dl-scope" value="filtered" checked> 現在のタブ・絞り込み結果すべて</label><label><input type="radio" name="engr-dl-scope" value="all"> ENGER全企業（除外済みを含む）</label><p id="engr-dl-message" role="status"></p><div class="sl-modal-foot"><button class="btn btn-primary" onclick="downloadEngerScope(this)">ダウンロード</button><button class="btn btn-secondary" onclick="closeAction()">閉じる</button></div>');
  };
  window.downloadEngerScope=async btn=>{btn.disabled=true;try{await download(document.querySelector('input[name="engr-dl-scope"]:checked')?.value||'filtered');}finally{btn.disabled=false;}};
  async function download(scope) {
    const btn = scope === "all" ? full : filtered;
    filtered.disabled = true;
    full.disabled = true;
    message.textContent = scope === "all" ? "全企業CSV作成中…" : "絞り込みCSV作成中…";
    const modalMessage=document.getElementById("engr-dl-message");
    if(modalMessage)modalMessage.textContent=message.textContent;
    try {
      const token = await window.API.getToken();
      if (!token) throw new Error("再ログインが必要です。");
      const response = await fetch(endpoint + "?" + getParams(scope), {
        headers: { Authorization: "Bearer " + token },
        cache: "no-store",
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.hint || error.message || "CSV出力に失敗しました。");
      }
      const blob = await response.blob();
      const cd = response.headers.get("Content-Disposition") || "";
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m?.[1] || "enger_companies.csv";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message.textContent = "CSVを作成しました。";
    } catch (error) {
      message.textContent = error?.message || "ダウンロードに失敗しました。";
    } finally {
      if(modalMessage)modalMessage.textContent=message.textContent;
      filtered.disabled = false;
      full.disabled = false;
    }
  }
  filtered.addEventListener("click", () => download("filtered"));
  full.addEventListener("click", () => download("all"));

  // 権限のある社員がアクセスできるだけでは足りない。owner のみ表示。
  (async () => {
    try {
      const result = await window.API.api(endpoint + "?permission=1");
      if (result?.allowed === true && result.role === "owner") {
        allowed=true;
        box.hidden = true;
      }
    } catch {
      // 権限不足や認証失敗の場合は一切表示しない。
    }
  })();
})();
