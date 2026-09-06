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
  // メンバー: 画面下のタブ。片手で届く5つに絞る。
  //
  // ホームの次に「やること」を置く。
  // メンバーの動きは「ホームを見る → やることを処理する」の2手で終わるのが理想で、
  // その2つが指の届くところに並んでいないと、結局メニューを開くことになる。
  const MEMBER_NAV = [
    { key: "home",     href: "home.html",      label: "ホーム",     icon: "home",      ready: true },
    { key: "tasks",    href: "tasks.html",     label: "やること",   icon: "checklist", ready: true },
    { key: "nippo",    href: "nippo.html",     label: "日報",       icon: "edit_note", ready: true },
    { key: "messages", href: "messages.html",  label: "メッセージ", icon: "forum",     ready: true },
    { key: "menu",     href: "menu.html",      label: "メニュー",   icon: "apps",      ready: true },
  ];

  // メンバー: PCでの左サイドメニュー。基本は8つ。
  //
  // ■ 増やさない
  //   入社手続き・研修・提出物のような「一時期だけ必要なもの」に
  //   専用のメニューを作らない。入社した週にしか使わない項目が
  //   その後ずっと並び続けると、毎日使うものが埋もれる。
  //   そういうものは「やること」に出す。終われば自然に消える。
  //
  // ■ まとめたもの
  //   お知らせ・掲示板 ＋ 社内文書・様式 ＋ 社員名簿 → 社内情報
  //   どれも「調べにいく」ときに開くもので、入口が3つある必要がない。
  //
  // ■ 人によって出す・出さない
  //   設備・スペース予約は、設備を使う人だけ。
  //   会計書類は、経理・管理担当だけ。
  //   使わない人に見えていると、押してよいのか毎回考えることになる。
  const MEMBER_SIDE_NAV = [
    { key: "home",     href: "home.html",     label: "ホーム",       icon: "home",           ready: true },
    { key: "tasks",    href: "tasks.html",    label: "やること",     icon: "checklist",      ready: true },
    { key: "nippo",    href: "nippo.html",    label: "日報",         icon: "edit_note",      ready: true },
    { key: "schedule", href: "schedule.html", label: "スケジュール", icon: "calendar_month", ready: true },
    { key: "messages", href: "messages.html", label: "メッセージ",   icon: "forum",          ready: true },
    { key: "workflow", href: "workflow.html", label: "申請・承認",   icon: "approval",       ready: true },
    { key: "info",     href: "notices.html",  label: "社内情報",     icon: "menu_book",      ready: true,
      // お知らせ・社内文書・社員名簿は、どれを開いていてもここが選ばれた状態にする
      match: ["info", "notices", "library", "directory"] },
    { key: "mypage",   href: "mypage.html",   label: "マイページ",   icon: "account_circle", ready: true },

    // ここから下は、必要な人にだけ出す
    { key: "booking", href: "booking.html", label: "設備・スペース予約", icon: "meeting_room",
      ready: true, when: "booking" },
    { key: "docs", href: "app.html", label: "会計書類", icon: "receipt_long",
      ready: true, external: true, when: "accounting" },
  ];

  // 管理者: 左サイドメニュー。
  // 「日々の業務」と「組織・システムの管理」を分け、会計は別システムとして
  // 一番下に切り出す。ready:false は枠だけ用意した項目（押しても遷移しない）。
  const ADMIN_NAV = [
    { section: "業務" },
    { key: "dashboard", href: "admin-dashboard.html", label: "ダッシュボード",     icon: "dashboard",    ready: true  },
    { key: "analytics", href: "admin-analytics.html", label: "アクセス分析",       icon: "monitoring",   ready: true  },
    { key: "nippo",     href: "admin-nippo.html",     label: "日報",               icon: "edit_note",    ready: true  },
    { key: "notices",   href: "admin-notices.html",   label: "お知らせ配信",       icon: "campaign",     ready: true  },
    { key: "messages",  href: "messages.html",        label: "メッセージ",         icon: "forum",        ready: true  },
    { key: "tasks",     href: "admin-tasks.html",     label: "タスク・予定",       icon: "checklist",    ready: true  },
    { key: "bookings",  href: "admin-bookings.html",  label: "スペース予約",       icon: "calendar_month", ready: true  },
    { key: "expenses",  href: "admin-expenses.html",  label: "経費精算",           icon: "receipt",      ready: true  },
    { key: "requests",  href: "admin-requests.html",  label: "休暇・稟議",         icon: "approval",     ready: true  },

    { section: "組織・システム管理" },
    { key: "onboard",   href: "admin-onboard.html",   label: "新規メンバー登録",   icon: "person_add",   ready: true  },
    { key: "members",   href: "admin-members.html",   label: "メンバー・権限",     icon: "group",        ready: true  },
    { key: "hr",        href: "admin-hr.html",        label: "入社・退職手続き",   icon: "badge",        ready: true  },
    { key: "contracts", href: "admin-contracts.html", label: "雇用契約・面談",     icon: "contract",     ready: true  },
    { key: "probation", href: "admin-probation.html", label: "試用期間",           icon: "how_to_reg",   ready: true  },
    { key: "growth",    href: "admin-growth.html",    label: "3か月育成計画",      icon: "flag",         ready: true  },
    { key: "autonomy",  href: "admin-autonomy.html",  label: "自走レベル",         icon: "stairs",       ready: true  },
    { key: "templates", href: "admin-docs.html",      label: "社内文書・雛形",         icon: "folder_copy",  ready: true  },
    { key: "assets",    href: "admin-assets.html",    label: "アカウント・貸与品", icon: "devices",      ready: true  },
    { key: "blocks",    href: "admin-blocks.html",    label: "口コミ流入ブロック", icon: "block",        ready: true  },
    { key: "settings",  href: "admin-settings.html",  label: "組織設定・ログ",     icon: "settings",     ready: true  },

    { section: "会計（別システム）" },
    { key: "accounting", href: "admin.html", label: "会計書類・仕訳", icon: "receipt_long", ready: true, external: true },
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

  function renderTopbar({ name, appRole, memberView }) {
    const tag = memberView
      ? "メンバー表示で確認中"
      : ({ admin: "管理者", owner: "経営者", sr: "社労士", member: "" }[appRole] || "");
    const home = memberView ? "home.html" : homeFor(appRole);
    const canPreview = appRole === "admin" || appRole === "owner";

    const el = document.createElement("div");
    el.className = "topbar";
    el.innerHTML = `
      <div class="brand">
        <a href="${home}" style="text-decoration:none;color:inherit;">エイト</a>
        ${tag ? `<span class="tag${memberView ? " preview" : (appRole !== "member" ? " admin" : "")}">${esc(tag)}</span>` : ""}
      </div>
      <div class="who">
        <span>${esc(name)}</span>
        ${canPreview ? (memberView
          ? `<button class="btn btn-primary btn-sm" onclick="KPLayout.exitMemberView()">
               ${icon("admin_panel_settings", 18)}管理画面に戻る
             </button>`
          : `<button class="btn btn-secondary btn-sm" onclick="KPLayout.viewAsMember()"
                     title="メンバーに見える画面を、このアカウントのまま確認します">
               ${icon("visibility", 18)}メンバー表示
             </button>`) : ""}
        <div class="kp-bell">
          <button class="icon-btn" id="kp-bell-btn" title="通知" onclick="KPLayout.toggleBell()">
            ${icon("notifications", 20)}
            <span class="kp-bell-badge hidden" id="kp-bell-badge"></span>
          </button>
          <div class="kp-bell-panel hidden" id="kp-bell-panel"></div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="KPLayout.logout()">
          ${icon("logout", 18)}ログアウト
        </button>
      </div>`;
    document.body.prepend(el);
    loadNotifications();
  }

  // ---- 通知 ---------------------------------------------------------------
  let notifications = [];

  async function loadNotifications() {
    try {
      const res = await API.listNotifications();
      notifications = res.notifications || [];
      const badge = document.getElementById("kp-bell-badge");
      if (!badge) return;
      badge.textContent = res.unread > 9 ? "9+" : String(res.unread || "");
      badge.classList.toggle("hidden", !res.unread);
    } catch (e) {
      // 未適用の環境や名簿未登録では通知が無いだけ。画面は壊さない
    }
  }

  function renderBell() {
    const panel = document.getElementById("kp-bell-panel");
    if (!panel) return;
    if (!notifications.length) {
      panel.innerHTML = `<div class="empty" style="padding:18px;">通知はありません。</div>`;
      return;
    }
    const unread = notifications.filter((n) => !n.read_at).length;
    panel.innerHTML = `
      <div class="kp-bell-head">
        <b>通知</b>
        ${unread ? `<button class="btn btn-secondary btn-sm" onclick="KPLayout.readAllNotifications()">すべて既読</button>` : ""}
      </div>
      ${notifications.map((n) => `
        <a class="kp-bell-item${n.read_at ? "" : " unread"}" href="${esc(n.link || "#")}"
           onclick="KPLayout.openNotification('${esc(n.id)}')">
          <b>${esc(n.title)}</b>
          ${n.body ? `<small>${esc(n.body)}</small>` : ""}
          <small>${esc(new Date(n.created_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</small>
        </a>`).join("")}`;
  }

  // メンバー: PCでは左サイドメニュー、スマホでは画面下のタブ。
  // 両方を描いて CSS で出し分ける。同じ画面幅で2つ出ることはない。
  function renderMemberNav(active, shows = {}) {
    // when が付いている項目は、使う人にだけ出す
    renderSidebar(active, MEMBER_SIDE_NAV.filter((n) => !n.when || shows[n.when]), "member");

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
    document.body.classList.add("kp-has-tabbar");
  }

  // 管理者: 左サイドメニュー。PC前提だが、狭い画面では上部の横スクロールに変わる
  function renderAdminNav(active, items = ADMIN_NAV) {
    renderSidebar(active, items, "admin");
  }

  function renderSidebar(active, items, variant) {
    const el = document.createElement("nav");
    el.className = `kp-sidebar${variant === "member" ? " member" : ""}`;
    el.innerHTML = items.map((n) => {
      if (n.section) return `<div class="kp-side-section">${esc(n.section)}</div>`;
      // match が書いてあれば、そこに挙げた画面のどれでも選ばれた状態にする
      const on = n.key === active || (n.match || []).includes(active);
      const cls = `kp-side-item${on ? " on" : ""}${n.ready ? "" : " soon"}${n.external ? " ext" : ""}`;
      const inner = `${icon(n.icon, 19)}<span>${esc(n.label)}</span>${n.ready ? "" : '<em>準備中</em>'}`;
      return n.ready
        ? `<a class="${cls}" href="${n.href}">${inner}</a>`
        : `<span class="${cls}">${inner}</span>`;
    }).join("");
    document.body.appendChild(el);
    // html にも付ける。次に開く画面で、最初の描画から余白を確保するため
    document.body.classList.add("kp-has-sidebar");
    document.documentElement.classList.add("kp-has-sidebar");
  }

  // 前回の権限を覚えておき、次の画面では /api/me を待たずに枠を描く。
  // 待ってから描くと、画面を移るたびにメニューが消えて出て、本文がずれる。
  // 覚えた内容は毎回 /api/me で確かめ、違っていれば描き直す。
  const CACHE_KEY = "kp_layout";
  const loadCache = () => {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch { return null; }
  };
  const saveCache = (v) => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch { /* 保存できなくても動く */ }
  };
  const clearCache = () => {
    try { localStorage.removeItem(CACHE_KEY); } catch { /* 同上 */ }
  };

  function clearChrome() {
    for (const sel of [".topbar", ".kp-sidebar", ".kp-tabbar"]) {
      for (const n of document.querySelectorAll(sel)) n.remove();
    }
    document.body.classList.remove("kp-has-sidebar", "kp-has-tabbar");
    document.documentElement.classList.remove("kp-has-sidebar");
  }

  // 管理者が「メンバーにはどう見えるか」を確かめるための表示切替。
  //
  // 別アカウントに切り替える形にしなかった理由:
  //   デモ用のアカウントを作ると、そのパスワードを配って回ることになり、
  //   使われなくなったあとも生き続ける。見たいのは「メニューと画面の見え方」で、
  //   他人のデータではないので、自分のアカウントのまま枠だけメンバー用にする。
  //   データは自分のものが出る。権限は一切変わらない（管理者のままなので、
  //   この状態で管理用の画面を開けばそのまま開ける。そこで表示も元に戻す）。
  const VIEW_KEY = "kp_view";
  const isMemberView = () => {
    try { return localStorage.getItem(VIEW_KEY) === "member"; } catch { return false; }
  };
  const setMemberView = (on) => {
    try {
      if (on) localStorage.setItem(VIEW_KEY, "member");
      else localStorage.removeItem(VIEW_KEY);
    } catch { /* 保存できなくても、その画面の中では切り替わる */ }
  };

  function renderChrome({ name, appRole, shows }, active) {
    clearChrome();
    const canPreview = appRole === "admin" || appRole === "owner";
    const memberView = canPreview && isMemberView();

    renderTopbar({ name, appRole, memberView });
    if (memberView) renderMemberNav(active, shows);
    else if (canPreview) renderAdminNav(active);
    else if (appRole === "sr") renderAdminNav(active, ADVISOR_NAV);
    else renderMemberNav(active, shows);
  }

  /**
   * 人によって出す・出さないメニューを決める。
   *   booking    … 設備を使う人。予約を1件でも持っているか、管理側の人
   *   accounting … 会計のメンバーシップを持っている人（経理・管理担当）
   * 判断できないときは出さない。使わないものが見えているほうが迷う
   */
  function showsFor(me) {
    const gwRoles = me?.gw?.roles || [];
    const roles = me?.roles || [];
    const staff = me?.isAdmin || gwRoles.includes("owner") || gwRoles.includes("hr");
    return {
      booking: staff || gwRoles.includes("booking"),
      // 会計は別システム。閲覧できる立場の人にだけ入口を出す
      accounting: staff || roles.includes("admin") || roles.includes("staff"),
    };
  }

  // ボタンの押し心地。押した直後に無効化して回転アイコンに差し替え、
  // 終わったら元に戻す。「押せたのか分からない時間」を作らないため。
  async function withBusy(btn, label, fn) {
    if (!btn) return fn();
    const before = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML =
      `<span class="material-symbols-outlined icon-inline kp-spin">progress_activity</span>${esc(label || "処理中…")}`;
    try {
      return await fn();
    } finally {
      btn.disabled = false;
      btn.innerHTML = before;
    }
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
      if (!API.isLoggedIn()) { clearCache(); showLogin(); return null; }

      // 覚えている権限があれば、通信を待たずに先に描く。
      // この画面を開いてよい権限のときだけ描く（違えばこのあと送り返される）
      const cached = loadCache();
      let painted = null;
      if (cached?.appRole && (!opts.roles || opts.roles.includes(cached.appRole))) {
        painted = cached;
        renderChrome(cached, opts.active);
      }

      let me;
      try {
        me = await API.me();
      } catch (e) {
        // トークン切れ等。ログイン画面に戻す
        API.logout();
        clearCache();
        showLogin("セッションが切れました。もう一度ログインしてください。");
        return null;
      }

      const appRole = me.appRole || (me.isAdmin ? "admin" : "member");
      const name = me.gw?.employee?.display_name || me.email || "";
      const shows = showsFor(me);
      saveCache({ appRole, name, shows });

      const allowed = opts.roles;
      if (allowed && !allowed.includes(appRole)) {
        location.replace(homeFor(appRole));
        return null;
      }

      // メンバーが開けない画面（管理用）を開いたら、確認モードは終わりにする。
      // 下タブのままサイドメニューの画面に居ると、どちらの立場なのか分からなくなる
      if (isMemberView() && allowed && !allowed.includes("member")) {
        setMemberView(false);
        painted = null;
      }

      // 覚えていた内容と違っていたときだけ描き直す
      if (!painted || painted.appRole !== appRole || painted.name !== name
          || JSON.stringify(painted.shows || {}) !== JSON.stringify(shows)) {
        renderChrome({ name, appRole, shows }, opts.active);
      }

      return { me, appRole };
    },

    /**
     * 「社内情報」の中の切り替え。
     * お知らせ・社内文書・社員名簿は、どれも「調べにいく」ときに開くもの。
     * サイドメニューの入口は1つにして、中はこの帯で行き来する。
     */
    infoTabs(active) {
      const tabs = [
        { key: "notices",   href: "notices.html",   label: "お知らせ" },
        { key: "library",   href: "library.html",   label: "社内文書・様式" },
        { key: "directory", href: "directory.html", label: "社員名簿" },
      ];
      return `<div class="kp-subnav">${tabs.map((t) =>
        `<a class="kp-subtab${t.key === active ? " on" : ""}" href="${t.href}">${esc(t.label)}</a>`
      ).join("")}</div>`;
    },

    toggleBell() {
      const panel = document.getElementById("kp-bell-panel");
      if (!panel) return;
      const opening = panel.classList.contains("hidden");
      if (opening) renderBell();
      panel.classList.toggle("hidden", !opening);
    },

    // リンク先へ移動しつつ既読にする。移動が先に走ってもよいよう待たない
    openNotification(id) {
      const n = notifications.find((x) => x.id === id);
      if (n && !n.read_at) API.markNotificationRead(id).catch(() => {});
    },

    async readAllNotifications() {
      try {
        await API.markAllNotificationsRead();
        for (const n of notifications) n.read_at = n.read_at || new Date().toISOString();
        renderBell();
        const badge = document.getElementById("kp-bell-badge");
        if (badge) badge.classList.add("hidden");
      } catch (e) {
        alert(e.detail || e.message || "既読にできませんでした");
      }
    },

    busy: withBusy,

    // メンバーに見える画面を、このアカウントのまま確認する／やめる
    viewAsMember() { setMemberView(true); location.href = "home.html"; },
    exitMemberView() { setMemberView(false); location.href = "admin-dashboard.html"; },
    isMemberView,

    logout() { API.logout(); clearCache(); setMemberView(false); location.href = "index.html"; },
    homeFor,
    esc,
    icon,
  };
})();
