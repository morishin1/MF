/* ファイルの受け口をひとつにする。
 *
 * ■ なぜ共通にするのか
 *   画面ごとに「ボタンを押してファイルを選ぶ」「枠に落とす」がばらばらだと、
 *   使う人は毎回やり方を思い出さないといけない。
 *   どの画面でも 落とす／押して選ぶ の両方が効く、を守るためのもの。
 *
 * ■ 複数ファイル
 *   領収書も、身分証の表と裏も、まとめて落とせる。
 *   送るのは1つずつ（順番に）。同時に投げると、
 *   どれが失敗したのか分からなくなるし、回線の細い場所で落ちる。
 *
 * ■ 使い方
 *     <div class="dz" data-drop="<なにか渡したい値>">…</div>
 *     KPDrop.scan(container, (key, files) => …);
 *   もしくは
 *     KPDrop.attach(node, (files) => …);
 *
 *   どちらも中に隠しの <input type="file"> を作る。
 *   HTML 側に input を書く必要はない。
 */
(function () {
  "use strict";

  const DEFAULT_ACCEPT = ".pdf,.jpg,.jpeg,.png,.heic,.webp,.doc,.docx,.xls,.xlsx";

  // 画面の外に落としたとき、ブラウザがそのファイルを開いてしまうのを止める。
  // 入力中の内容が消えるので、これは必ず要る
  let guarded = false;
  function guard() {
    if (guarded) return;
    guarded = true;
    const stop = (e) => {
      if (e.target.closest?.("[data-drop-zone]")) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
  }

  /** 拡張子で受けられるかを見る。落とした場合は accept 属性が効かないため */
  function accepted(file, accept) {
    const list = String(accept || DEFAULT_ACCEPT)
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!list.length) return true;
    const name = String(file.name || "").toLowerCase();
    const type = String(file.type || "").toLowerCase();
    return list.some((a) =>
      a.startsWith(".") ? name.endsWith(a)
        : a.endsWith("/*") ? type.startsWith(a.slice(0, -1))
          : type === a);
  }

  /**
   * 要素を受け口にする。
   * @param {HTMLElement} node
   * @param {(files:File[], node:HTMLElement)=>void} handler
   * @param {{accept?:string, multiple?:boolean, clickToPick?:boolean}} opts
   *   clickToPick:false … 落とすだけ受ける。メッセージの本文欄のように、
   *                       押したときに別の意味がある場所で使う
   */
  function attach(node, handler, opts) {
    if (!node || node.dataset.dropWired === "1") return;
    guard();
    node.dataset.dropWired = "1";
    node.setAttribute("data-drop-zone", "");

    const accept = node.dataset.dropAccept || opts?.accept || DEFAULT_ACCEPT;
    const multiple = opts?.multiple !== false;

    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.tabIndex = -1;
    input.style.display = "none";
    node.appendChild(input);

    const take = (files) => {
      const all = Array.from(files || []);
      const ok = all.filter((f) => accepted(f, accept));
      const ng = all.filter((f) => !accepted(f, accept));
      if (ng.length) {
        alert(`この形式は受け取れません：${ng.map((f) => f.name).join("、")}\n`
          + `受け取れるのは ${accept.replace(/\./g, "").toUpperCase()} です。`);
      }
      if (ok.length) handler(multiple ? ok : [ok[0]], node);
    };

    input.addEventListener("change", () => {
      const files = input.files;
      const picked = Array.from(files || []);
      input.value = "";                       // 同じファイルをもう一度選べるように
      if (picked.length) take(picked);
    });

    // 中身を描き直すと、この隠し input も一緒に消える。
    // 開く前に置き直しておけば、描き直しのあとでも押して選べる
    const pick = () => {
      if (input.parentNode !== node) node.appendChild(input);
      input.click();
    };

    const clickToPick = opts?.clickToPick !== false;
    if (clickToPick) {
      node.addEventListener("click", (e) => {
        // 中に置いたリンクやボタン（雛形のダウンロードなど）を押したときは開かない
        if (e.target.closest("a, button, input, label, textarea, select")) return;
        pick();
      });
      node.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target !== node) return;
        e.preventDefault();
        pick();
      });
    }

    // dragenter / dragleave は中の要素をまたぐたびに飛ぶので、数えて判定する
    let depth = 0;
    const hot = (on) => node.classList.toggle("is-over", on);
    node.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; hot(true); });
    node.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      hot(true);
    });
    node.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; hot(false); } });
    node.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      depth = 0; hot(false);
      take(e.dataTransfer?.files);
    });

    if (clickToPick) {
      if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "0");
      if (!node.hasAttribute("role")) node.setAttribute("role", "button");
    }
    return { pick };
  }

  /**
   * 中にある [data-drop] を全部受け口にする。
   * 描き直すたびに呼んでよい（一度付けた要素には二重に付かない）
   * @param {HTMLElement|Document} root
   * @param {(key:string, files:File[], node:HTMLElement)=>void} handler
   */
  function scan(root, handler, opts) {
    (root || document).querySelectorAll("[data-drop]").forEach((node) => {
      attach(node, (files) => handler(node.dataset.drop, files, node), opts);
    });
  }

  /**
   * 1つずつ順番に送る。途中で失敗しても残りは続ける。
   * @param {File[]} files
   * @param {(file:File, index:number)=>Promise<any>} send
   * @param {(done:number, total:number, file:File)=>void} onProgress
   * @returns {Promise<{ok:string[], ng:{name:string,message:string}[]}>}
   */
  async function run(files, send, onProgress) {
    const ok = [], ng = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      onProgress?.(i, files.length, f);
      try {
        await send(f, i);
        ok.push(f.name);
      } catch (e) {
        ng.push({ name: f.name, message: e?.hint || e?.detail || e?.message || "失敗しました" });
      }
    }
    onProgress?.(files.length, files.length, null);
    return { ok, ng };
  }

  /** 「3件中2件を送りました」のような文。失敗の理由も出す */
  function summary(res) {
    const lines = [];
    if (res.ok.length) lines.push(`${res.ok.length}件を送りました`);
    for (const n of res.ng) lines.push(`${n.name}：${n.message}`);
    return lines.join("\n");
  }

  window.KPDrop = { attach, scan, run, summary, accepted, DEFAULT_ACCEPT };
})();
