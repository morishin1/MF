// HR「資料」ナビを既存の hr-layout.js を変えずに足す。
// hr-layout.js は長期キャッシュの共有ファイルなので、db/136 の小さな変更で全GWの版を上げない。
(function () {
  if (!window.HRLayout || typeof HRLayout.init !== "function") return;
  const original = HRLayout.init;
  function addMaterials(active) {
    const nav = document.querySelector(".hr-nav");
    if (!nav || nav.querySelector('a[href="/hr/materials.html"]')) return;
    const a = document.createElement("a");
    a.href = "/hr/materials.html";
    a.className = active === "materials" ? "on" : "";
    a.innerHTML = '<span class="material-symbols-outlined">folder</span>資料';
    const ceo = nav.querySelector('a[href="/hr/ceo-review.html"]');
    if (ceo) ceo.insertAdjacentElement("afterend", a);
    else nav.appendChild(a);
  }
  HRLayout.init = async function (opts = {}) {
    const out = await original(opts);
    if (out) addMaterials(opts.active);
    return out;
  };
})();
