// 採用HR「資料」タブだけを既存 hr-layout に追加する。
// 共有 hr-layout.js は immutable cache で全HR画面が使うため、この機能だけ別ファイルに分ける。
(function () {
  if (!window.HRLayout || HRLayout.__materialsPatched) return;
  const original = HRLayout.init;
  HRLayout.init = async function (opts = {}) {
    const out = await original(opts);
    if (!out) return out;
    const nav = document.querySelector(".hr-nav");
    if (nav && !nav.querySelector('a[href="/hr/materials.html"]')) {
      const a = document.createElement("a");
      a.href = "/hr/materials.html";
      a.innerHTML = '<span class="material-symbols-outlined">folder</span>資料';
      if (opts.active === "materials") a.classList.add("on");
      const ceo = nav.querySelector('a[href="/hr/ceo-review.html"]');
      if (ceo?.nextSibling) nav.insertBefore(a, ceo.nextSibling);
      else nav.appendChild(a);
    }
    return out;
  };
  HRLayout.__materialsPatched = true;
})();