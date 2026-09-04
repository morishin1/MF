// layout.js — グループウェア共通レイアウト。
//
// 役割:
//   - ログイン確認と、権限（appRole）による画面の振り分け
//   - トップバーとナビゲーションの描画
//       メンバー  … 画面下のタブ4つ（スマホ優先）
//       管理者/経営者 … 左サイドメニュー
//       社労士    … 許可された画面のみ
//
// 使い方（各HTMLの末尾）:
//   <script src="js/api-client.js"></script>
//   <script src="js/layout.js"></script>
//   <script>
//     KPLayout.init({ active: 'home', roles: ['member','admin','owner'] })
//       .then(ctx => { if (ctx) start(ctx); });
//   </script>
//
// 既存の app.html / admin.html はこのファイルを読み込まない。会計画面は
// 独立して動くまま維持し、グループウェア側からはメニュー項目として参照する。

(function () {
  // ready:false は「枠だけ用意し、実装はこれから」の意味。押しても遷移させない。
  const MEMBER_NAV = [
    { key: "home",     href: "home.html",     label: "ホーム",     icon: "home",        ready: true  },
    { key: "messages", href: "messages.html", label: "メッセージ", icon: "forum",       ready: true  },
    { key: "tasks",    href: "tasks.html",    label: "やること",   icon: "checklist",   ready: true  },
    { key: "docs",     href: "app.html",      label: "書類",       icon: "description", ready: true  },
  ];

  const ADMIN_NAV = [
    { key: "dashboard", href: "admin-dashboard.html", label: "ダッシュボード",   icon: "dashboard",    ready: true  },
    { key: "notices",   href: "admin-notices.html",   label: "お知らせ",         icon: "campaign",     ready: true  },
    { key: "messages",  href: "messages.html",        label: "メッセージ",       icon: "forum",        ready: true  },
    { key: "members",   href: "admin-members.html",   label: "メンバー",         icon: "group",        ready: true  },
    { key: "hr",        href: "admin-hr.html",        label: "入社・退職手続き", icon: "badge",        ready: true  },
    { key: "tasks",     href: "admin-tasks.html",     label: "タスク・予定",     icon: "checklist",    ready: true  },
    { key: "templates", href: "admin-docs.html",      label: "書類・雛形",       icon: "folder_copy",  ready: true  },
    { key: "assets",    href: "admin-assets.html",    label: "アカウント・貸与品", icon: "devices",    ready: true  },
    { key: "accounting",href: "admin.html",           label: "会計書類",         icon: "receipt_long", ready: true  },
    { key: "settings",  href: "admin-settings.html",  label: "管理設定",         icon: "settings",     ready: true  },
  ];

  // 社労士は社外の人。会計にも社内の他の画面にも入れず、共有された手続きだけを見る
  const ADVISOR_NAV = [
    { key: "hr", href: "advisor.html", label: "入社・退職手続き", icon: "badge", ready: true },
  ];

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function icon(name, size) {
    return `<span class="material-symbols-outlined"${size ? ` style="font-size:${size}px;"` : ""}>${esc(name)}</span>`;
  }

  // 管理者側の画面をメンバーが開いた場合などに、行き先へ送り返す
  function homeFor(appRole) {
    if (appRole === "admin" || appRole === "owner") return "admin-dashboard.html";
    if (appRole === "sr") return "advisor.html";
    return "home.html";
  }

  function renderTopbar(ctx) {
    const name = ctx.me?.gw?.employee?.display_name || ctx.me?.email || "";
    const tag = { admin: "管理者", owner: "経営者", sr: "社労士", member: "" }[ctx.appRole] || "";
    const el = document.createElement("div");
    el.className = "topbar";
    el.innerHTML = `
      <div class="brand">
        <a href="${homeFor(ctx.appRole)}" style="text-decoration:none;color:inherit;">エイト</a>
        ${tag ? `<span class="tag${ctx.appRole !== "member" ? " admin" : ""}">${esc(tag)}</span>` : ""}
      </div>
      <div class="who">
        <span>${esc(name)}</span>
        <button class="btn btn-secondary btn-sm" onclick="KPLayout.logout()">
          ${icon("logout", 18)}ログアウト
        </button>
      </div>`;
    document.body.prepend(el);
  }

  // メンバー: 画面下のタブ。片手で届く位置に置く
  function renderMemberNav(active) {
    const el = document.createElement("nav");
    el.className = "kp-tabbar";
    el.innerHTML = MEMBER_NAV.map((n) => {
      const on = n.key === active;
      const cls = `kp-tab${on ? " on" : ""}${n.ready ? "" : " soon"}`;
      const inner = `${icon(n.icon, 22)}<span>${esc(n.label)}</span>`;
      return n.ready
        ? `<a class="${cls}" href="${n.href}">${inner}</a>`
        : `<span class="${cls}" title="準備中">${inner}</span>`;
    }).join("");
    document.body.appendChild(el);
  }

  // 管理者: 左サイドメニュー。PC前提だが、狭い画面では上部の横スクロールに変わる
  function renderAdminNav(active, items = ADMIN_NAV) {
    const el = document.createElement("nav");
    el.className = "kp-sidebar";
    el.innerHTML = items.map((n) => {
      const on = n.key === active;
      const cls = `kp-side-item${on ? " on" : ""}${n.ready ? "" : " soon"}`;
      const inner = `${icon(n.icon, 19)}<span>${esc(n.label)}</span>${n.ready ? "" : '<em>準備中</em>'}`;
      return n.ready
        ? `<a class="${cls}" href="${n.href}">${inner}</a>`
        : `<span class="${cls}">${inner}</span>`;
    }).join("");
    document.body.appendChild(el);
    document.body.classList.add("kp-has-sidebar");
  }

  function showLogin(message) {
    document.body.innerHTML = `
      <div class="topbar"><div class="brand">エイト</div></div>
      <div class="wrap">
        <div class="card" style="max-width:420px;margin:40px auto;">
          <h2>${icon("login")}ログイン</h2>
          ${message ? `<div class="banner warn">${icon("warning")}<div>${esc(message)}</div></div>` : ""}
          <div style="margin-bottom:12px;">
            <label>メールアドレス</label>
            <input id="kp-email" type="email" autocomplete="username" placeholder="you@8grp.co.jp">
          </div>
          <div style="margin-bottom:16px;">
            <label>パスワード</label>
            <input id="kp-pw" type="password" autocomplete="current-password" placeholder="••••••••">
          </div>
          <button id="kp-login" class="btn btn-primary" style="width:100%;justify-content:center;">ログイン</button>
          <div id="kp-login-err" class="err-text"></div>
        </div>
      </div>`;
    const btn = document.getElementById("kp-login");
    const go = async () => {
      const email = document.getElementById("kp-email").value.trim();
      const pw = document.getElementById("kp-pw").value;
      const err = document.getElementById("kp-login-err");
      err.textContent = "";
      if (!email || !pw) { err.textContent = "メールとパスワードを入力してください"; return; }
      btn.disabled = true; btn.textContent = "ログイン中…";
      try { await API.login(email, pw); location.reload(); }
      catch (e) { err.textContent = e.message || "ログインに失敗しました"; btn.disabled = false; btn.textContent = "ログイン"; }
    };
    btn.addEventListener("click", go);
    document.getElementById("kp-pw").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  }

  window.KPLayout = {
    /**
     * ログイン確認 → 権限確認 → レイアウト描画。
     * 権限が無ければ本来の画面へ送り返し、null を返す（呼び出し側は何もしない）。
     * @param {{active?:string, roles?:string[]}} opts
     * @returns {Promise<{me:object, appRole:string}|null>}
     */
    async init(opts = {}) {
      if (!API.isLoggedIn()) { showLogin(); return null; }

      let me;
      try {
        me = await API.me();
      } catch (e) {
        // トークン切れ等。ログイン画面に戻す
        API.logout();
        showLogin("セッションが切れました。もう一度ログインしてください。");
        return null;
      }

      const appRole = me.appRole || (me.isAdmin ? "admin" : "member");
      const allowed = opts.roles;
      if (allowed && !allowed.includes(appRole)) {
        location.replace(homeFor(appRole));
        return null;
      }

      renderTopbar({ me, appRole });
      if (appRole === "admin" || appRole === "owner") renderAdminNav(opts.active);
      else if (appRole === "sr") renderAdminNav(opts.active, ADVISOR_NAV);
      else renderMemberNav(opts.active);

      return { me, appRole };
    },

    logout() { API.logout(); location.href = "index.html"; },
    homeFor,
    esc,
    icon,
  };
})();
