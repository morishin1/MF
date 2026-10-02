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
  // ホームの次に「タスク」を置く。
  // メンバーの動きは「ホームを見る → タスクを処理する」の2手で終わるのが理想で、
  // その2つが指の届くところに並んでいないと、結局メニューを開くことになる。
  const MEMBER_NAV = [
    { key: "home",     href: "home.html",      label: "ホーム",     icon: "home",      ready: true },
    { key: "tasks",    href: "tasks.html",     label: "タスク",     icon: "checklist", ready: true },
    { key: "nippo",    href: "nippo.html",     label: "日報",       icon: "edit_note", ready: true },
    { key: "messages", href: "messages.html",  label: "社内AI",     icon: "smart_toy", ready: true },
    { key: "menu",     href: "menu.html",      label: "メニュー",   icon: "apps",      ready: true },
  ];

  /**
   * 入社準備中（入社日前で、入社手続きがまだ終わっていない人）のメニュー。
   *
   * 通常メンバー向けの機能（今日やること・勤怠・キャリア・社内情報…）を最初から並べない。
   * 本人が迷わないよう、4つだけにする。入社準備が終わる（stage.unlocked）か、
   * 入社日が来て在籍になると、通常のメニューに切り替わる（lib/stages.js の stageInfo）。
   *
   *   ホーム
   *   入社準備          … ログイン直後に開く画面（/onboarding/）。契約も、ここから進める
   *   給与管理          … 本人用の給与管理の画面は無いので、マイページの労働条件（給与）へつなぐ
   *   ─────
   *   設定・セキュリティ … マイページの二段階認証・パスワード変更
   *
   * 行き先はどれも、入社準備中に開いている画面（lib/stages.js ALLOWED.preparing）。
   * 開けない画面への入口は置かない。
   */
  const PREPARING_NAV = [
    { key: "home",       href: "/home.html",     label: "ホーム",     icon: "home",       ready: true },
    { key: "onboarding", href: "/onboarding/",   label: "入社準備",   icon: "how_to_reg", ready: true, match: ["contracts"] },
    { key: "payroll",    href: "/mypage.html#cond-card", label: "給与管理", icon: "payments", ready: true },
    { section: "自分の設定" },
    { key: "settings_self", href: "/mypage.html#mfa", label: "設定・セキュリティ", icon: "lock", ready: true, match: ["mypage"] },
  ];

  /**
   * 本人（入社する人・メンバー）の画面に出すエラー文。
   *
   * 技術的な原因（DB名・migration番号・SQL・API名・サーバの詳細）は、本人画面に出さない。
   * 原因は管理画面・サーバログ・監査ログで見る。ここでは、本人が次に何をすればよいかだけを返す。
   *
   *   サーバが本人向けの言葉（hint）を返していれば、それをそのまま出す
   *   DB・サーバの失敗（5xx・not_ready・db_*）や、技術的な語を含む文は、
   *   「◯◯できませんでした。管理担当者へお問い合わせください。」にする
   *
   * @param {Error} e
   * @param {string} [fallback] 何ができなかったか。例: "保存できませんでした"
   */
  const FRIENDLY_LOAD = "入社手続き情報を現在確認できません";
  function friendlyError(e, fallback) {
    const what = fallback || FRIENDLY_LOAD;
    const text = `${e?.hint || ""} ${e?.message || ""}`;
    const technical = (e?.status >= 500) || e?.code === "not_ready" || /^db_/.test(String(e?.code || ""))
      || /db\/\d|\.sql|\bSQL\b|migration|テーブル|schema|relation|PGRST|column|\bapi\//i.test(text);
    if (technical) return `${what}。管理担当者へお問い合わせください。`;
    return e?.hint || `${what}。もう一度お試しください。`;
  }

  /** 入社準備中か（入社日前で、入社手続きがまだ終わっていない） */
  const isPreparing = (stage) => Boolean(stage && stage.key === "preparing" && !stage.unlocked);

  /**
   * メンバー: PCでの左サイドメニュー。7つ（＋入社準備中の入社手続き・権限のある人の営業）。
   *
   * ■ 管理者とは、完全に別の表にしてある
   *   同じ表を権限で出し分けると、メンバーに見せない項目が
   *   増えるたびに条件が増えて、誰に何が見えているのか分からなくなる。
   *   メンバーが使うのは「自分のこと」だけなので、表ごと分ける。
   *
   * ■ 増やさない
   *   入社手続き・研修・提出物のような「一時期だけ必要なもの」に
   *   専用のメニューを作らない。入社した週にしか使わない項目が
   *   その後ずっと並び続けると、毎日使うものが埋もれる。
   *   そういうものは「タスク」に出す。終われば自然に消える。
   *
   * ■ 2階層目は、ページの上のタブにする（tabs）
   *   スケジュールはタスクの中へ。契約書はマイページの中へ。
   *   お知らせ・社内文書・社員名簿は「社内文書」の中へ。
   *   左メニューに入口を増やさず、開いた先で行き来できるようにする。
   *
   * ■ 人によって出す・出さない
   *   スペース予約は通常メニューから外した（メニュー画面・タスクから開く）。
   *   会計書類は、経理・管理担当だけ。
   *   使わない人に見えていると、押してよいのか毎回考えることになる。
   */
  const MEMBER_SIDE_NAV = [
    { key: "home",     href: "home.html",     label: "ホーム",   icon: "home",      ready: true },
    // 毎日の手を動かすところは1つにまとめる。タスク → 日報 → 予定の順に帯で行き来する
    { key: "tasks",    href: "tasks.html",    label: "今日やること", icon: "checklist", ready: true,
      tabs: [
        { key: "tasks",    href: "tasks.html",    label: "タスク" },
        { key: "nippo",    href: "nippo.html",    label: "日報" },
        { key: "schedule", href: "schedule.html", label: "スケジュール" },
      ],
      // スペース予約（booking.html）は通常メニューに置かず、ここから誘導する
      match: ["tasks", "nippo", "schedule", "booking"] },
    { key: "messages", href: "messages.html", label: "社内AI",     icon: "smart_toy", ready: true },
    { key: "timecard", href: "timecard.html", label: "勤怠・申請", icon: "schedule",  ready: true,
      tabs: [
        { key: "timecard", href: "timecard.html", label: "勤怠" },
        { key: "requests", href: "requests.html", label: "休暇・申請" },
        { key: "expenses", href: "expenses.html", label: "経費精算" },
      ],
      // 申請の一覧（workflow.html）も、この項目が選ばれた状態にする
      match: ["timecard", "requests", "expenses", "workflow"] },
    // 自分の現在地・次のLevel・次にやること（career.html）
    { key: "career",   href: "career.html",   label: "キャリア", icon: "trending_up", ready: true },
    { key: "notices",  href: "notices.html",  label: "社内情報", icon: "menu_book", ready: true,
      tabs: [
        { key: "notices",   href: "notices.html",   label: "お知らせ" },
        { key: "library",   href: "library.html",   label: "社内文書" },
        { key: "directory", href: "directory.html", label: "社員名簿" },
      ] },
    { key: "mypage",   href: "mypage.html",   label: "マイページ", icon: "account_circle", ready: true,
      tabs: [
        { key: "mypage",    href: "mypage.html",    label: "基本情報" },
        // 署名は期日があるので、入口を無くさない。ここから開ける
        { key: "contracts", href: "contracts.html", label: "契約・署名" },
      ] },

    // 入社準備のあいだだけ。入社日が来ると消える
    { key: "onboarding", href: "onboarding.html", label: "入社手続き", icon: "how_to_reg", ready: true },
    // スペース予約は通常メニューに置かない（使う人が限られる）。
    // 画面（booking.html）はそのまま残し、メニュー画面とタスクから開く
    // Sales（/sales）は共通ヘッダーの近道から入る（権限のある人にだけ出る）。左には置かない

    // ここから下は別システム。
    // どれも同じ auth.users を使うので、別のIDもパスワードも要らない。
    // URL が設定されていないものは出さない（行き先の無いボタンを置かない）
    { section: "つながっている仕組み" },
    { key: "dojo", label: "無限道場", icon: "school",
      ready: true, external: true, urlKey: "lmsUrl" },
    // 以前から使っている外部のタイムカード。URL が設定されているあいだだけ出る
    { key: "timecard_ext", label: "外部タイムカード", icon: "schedule",
      ready: true, external: true, urlKey: "timecardUrl" },
    // 会計は経理・管理担当だけ。一般メンバーには出さない
    { key: "docs", href: "app.html", label: "会計書類", icon: "receipt_long",
      ready: true, external: true, when: "accounting" },
  ];

  /**
   * 「左は自分の仕事、上は担当業務」。
   *
   * ■ 左サイドメニュー（MEMBER_SIDE_NAV）は、管理者も含め全員が同じ
   *   ホーム・今日やること・社内AI・勤怠・申請・キャリア・社内情報・マイページ。
   *   他人・会社を管理する画面は左に置かない。
   *
   * ■ 担当業務はヘッダーから入る。入ったら、その業務だけの専用の左メニューになる。
   *   採用HR（/hr）・Sales（/sales）・経営（/keiei）・月次業務（/office）は別アプリ。
   *   管理者が使う管理画面（admin-*.html）は URL を変えず、次の3つの領域に分ける
   *   （areaOf が active から判定する）。
   *     office   … ダッシュボード／人事・労務／経理・事務（人事・労務・経理・事務だけ）
   *     keiei    … チーム状況・全員のタスク・全員の日報（チーム・会社全体の管理）
   *     settings … 権限・端末・アクセス分析・AIナレッジ・システム設定（ヘッダー右の⚙管理から）
   *   上のどちらにも属さない画面は、ホーム領域＝全員と同じ左メニュー。
   *
   * ■ 同じ名前でも「本人用」と「管理用」を分ける
   *   勤怠・申請（本人）／勤怠管理（全社員）、キャリア（本人）／評価・キャリア（他メンバー）。
   *
   * ■ 2階層目は、ページの上のタブにする（tabs）
   *   tabs に書いた鍵は、その項目が選ばれた状態になる（match は自動）。
   *
   * ready:false は枠だけ用意した項目（押しても遷移しない）。
   */
  // Office の最初の行。管理者向けのダッシュボード（全社の今日の状況）
  const OFFICE_TOP = [
    // Office の人事・労務／経理・事務のどちらかに入れる人に出す（中の行は、本人の担当分だけ）
    { key: "dashboard", href: "admin-dashboard.html", label: "ダッシュボード", icon: "dashboard", ready: true, when: "officeAny" },
  ];

  // Office: 人事・労務／経理・事務。グループごとに、入れる人が違う（when）。
  //   人事・労務 … officeHr（管理者・経営者・人事）
  //   経理・事務 … officeFinance（管理者・経営者・経理）
  // when は /api/me の access（サーバの canOfficeHr / canOfficeFinance）をそのまま使う。
  // 入れない人には、グループごと出さない（押して 403 になる入口を作らない）。API も同じ関数で守る（lib/gw.js）。
  // HR（/hr）・Sales（/sales）・経営（/keiei）と同じく、ヘッダー切替が正式な入口
  const OFFICE_GROUPS = [
    {
      key: "office-hr", label: "人事・労務", icon: "group", when: "officeHr",
      items: [
        { key: "members",   href: "admin-members.html",   label: "メンバー",     icon: "badge",      ready: true,
          // 新規登録（本採用の実行・gw_employees作成）は、応募者管理ではない。
          // 採用HRの「本採用へ進める」から ?applicantId= 付きで開く先でもあるので、
          // 入口は消さない。見出しまで同じにする必要はないので tabs（帯）では
          // なく match だけにする（帯を出すと、見出しをそろえる制約が働く）
          match: ["members", "onboard"] },
        { key: "hr_flow",   href: "admin-hr.html",        label: "入退社",       icon: "swap_horiz", ready: true },
        { key: "timecard",  href: "admin-timecard.html",  label: "勤怠管理",     icon: "schedule",   ready: true,
          tabs: [
            { key: "timecard", href: "admin-timecard.html", label: "勤怠" },
            { key: "requests", href: "admin-requests.html", label: "休暇・稟議" },
          ] },
        { key: "contracts", href: "admin-contracts.html", label: "雇用契約",     icon: "contract",   ready: true,
          // 業務順に並べる: ①契約・面談 → ②契約書作成依頼 → ③電子署名。
          // 「作成依頼」はadmin-esign.html自身の中のタブ（PANES）の1つで、
          // 新しい画面は作らない。?tab=order で開くと、そのタブが選ばれた
          // 状態で開く（admin-esign.html:openFromUrl）
          tabs: [
            { key: "contracts",   href: "admin-contracts.html",       label: "契約・面談" },
            { key: "esign_order", href: "admin-esign.html?tab=order", label: "契約書作成依頼" },
            { key: "esign",       href: "admin-esign.html",           label: "電子署名" },
          ] },
        // 評価・キャリア。入口は「キャリア」（admin-career.html）。
        // 3か月育成・自走レベルは既存画面をそのままタブに並べる（作り直さない）。
        // 自走レベル（任せられる範囲）とキャリアLevel（役割・給与レンジ）は別物
        { key: "career",    href: "admin-career.html",    label: "評価・キャリア", icon: "trending_up", ready: true,
          tabs: [
            { key: "career",         href: "admin-career.html",             label: "キャリア" },
            { key: "career_journey", href: "admin-career.html?tab=journey", label: "入社〜育成" },
            { key: "growth",         href: "admin-growth.html",             label: "3か月育成" },
            { key: "autonomy",       href: "admin-autonomy.html",           label: "自走レベル" },
            { key: "career_history", href: "admin-career.html?tab=history", label: "評価履歴" },
          ],
          // 試用期間は採用前ではなく入社後の人事管理なので、こちらへ
          // （既存データ・ロジックは変えず、導線だけ移す）。見出しは「試用期間」の
          // ままでよいので帯（tabs）には入れず、選ばれた状態にするmatchだけ足す
          match: ["career", "career_journey", "growth", "autonomy", "career_history", "career_master", "probation"] },
      ],
    },
    {
      key: "office-ops", label: "経理・事務", icon: "work", when: "officeFinance",
      items: [
        { key: "expenses",   href: "admin-expenses.html", label: "経費精算",     icon: "receipt",         ready: true },
        // 月次締めと月初作業管理は、同じ「月の区切りの仕事」なので1つにまとめる
        { key: "closing",    href: "admin-closing.html",  label: "月次業務",     icon: "event_available", ready: true,
          // 月末月初業務（勤務表・稼働・請求。/office/）も Office の「月次業務」の中。
          // /office/ に入れるのは access.office の人だけなので、when で出し分ける（入れない人に出さない）
          tabs: [
            { key: "closing",    href: "admin-closing.html",     label: "月次締め" },
            { key: "monthstart", href: "admin-month-start.html", label: "月初作業管理" },
            { key: "office_monthly", href: "/office/",           label: "月末月初業務", when: "officeApp" },
          ] },
        { key: "templates",  href: "admin-docs.html",     label: "社内文書",     icon: "folder_copy",     ready: true },
        // 会計（admin.html）とお知らせ配信は、管理者・経営者のまま（経理の権限では、会計の画面・お知らせの保存権限が無い）
        { key: "accounting", href: "admin.html",          label: "会計",         icon: "account_balance", ready: true, external: true, when: "adminApp" },
        // 社内のお知らせと、サイト（公開ページ）のお知らせを1つの入口に。社内事務・運営なのでOffice
        { key: "notices",   href: "admin-notices.html",   label: "お知らせ配信", icon: "campaign",  ready: true, when: "adminApp",
          tabs: [
            { key: "notices",  href: "admin-notices.html",   label: "社内のお知らせ" },
            { key: "sitenews", href: "admin-site-news.html", label: "サイトのお知らせ" },
          ] },
      ],
    },
  ];

  // 経営（チーム・会社全体の管理、判断）。経営は別アプリ（/keiei）だが、全社員のタスク・日報・チーム状況は
  // 既存の管理画面（admin-*.html）をそのまま使う。URL・API は変えず、左メニューと導線だけ経営側へ寄せた。
  // 管理者がこの画面を開いたときの左メニューはここ（先頭は経営ホームへ戻る入口）
  const KEIEI_ITEMS = [
    // 経営アプリそのものは経営者だけ（when）。管理者はチーム状況から入る
    { key: "keiei_home", href: "/keiei/", label: "経営ホーム", icon: "monitoring", ready: true, when: "keiei" },
    { key: "team", href: "admin-team.html", label: "チーム状況", icon: "groups", ready: true },
    // 今週のゴールは、全員のタスクの帯の中へ（左メニューの行は増やさない）
    { key: "tasks", href: "admin-tasks.html", label: "全員のタスク", icon: "checklist", ready: true,
      tabs: [
        { key: "tasks", href: "admin-tasks.html", label: "タスク・予定" },
        { key: "goals", href: "admin-goals.html", label: "今週のゴール" },
      ] },
    { key: "nippo", href: "admin-nippo.html", label: "全員の日報", icon: "edit_note", ready: true },
  ];

  // 管理（⚙）: 毎日使わない設定系だけ。ヘッダー右のアイコンが正式な入口
  const SETTINGS_ITEMS = [
    // 権限を渡すのは名簿の画面。行き先を分けず、その場所へ直接飛ばす
    { key: "roles",     href: "admin-members.html#roles", label: "権限",     icon: "key",      ready: true },
    { key: "devices",   href: "admin-devices.html",   label: "端末・貸与品", icon: "computer", ready: true,
      tabs: [
        { key: "devices", href: "admin-devices.html", label: "端末管理" },
        { key: "assets",  href: "admin-assets.html",  label: "アカウント・貸与品" },
      ] },
    { key: "analytics", href: "admin-analytics.html", label: "アクセス分析", icon: "monitoring", ready: true,
      tabs: [
        { key: "analytics", href: "admin-analytics.html", label: "アクセス分析" },
        { key: "blocks",    href: "admin-blocks.html",    label: "口コミ流入ブロック" },
      ] },
    // スペース予約（admin-bookings.html）は通常ナビゲーションに出さない（左メニューにも帯にも無い）。
    // 画面・DB・API は残し、直接URL・タスク・個別の導線から開く。
    // 開いたときにメニューのどこも光らないのを避けるため、match だけ置く（表示はしない）
    // 社内AI（本人が使うチャット）は左メニュー。ここは資料の管理と問い合わせ対応＝システム管理の側
    { key: "ai_admin",  href: "admin-ai.html",        label: "AIナレッジ",   icon: "psychology", ready: true },
    { key: "settings",  href: "admin-settings.html",  label: "システム設定", icon: "tune",     ready: true,
      match: ["settings", "bookings"] },
  ];

  /**
   * いま開いている画面が、Office／経営／管理（⚙）／ホーム（全員と同じ左メニュー）のどれか。
   *
   * 管理画面（admin-*.html）のときだけ、active の鍵で領域を決める。
   * メンバー画面（timecard.html など）は、同じ鍵（timecard・expenses・career…）を使っていても
   * 本人用なので、必ずホーム。鍵だけで見ると、管理者が自分の勤怠を開いたとき Office の左メニューになってしまう
   */
  function areaOf(active, path = location.pathname) {
    const file = String(path || "").split("/").pop();
    if (!active || !/^admin-/.test(file)) return "home";
    const hit = (i) => i.key === active || (i.match || []).includes(active);
    if (OFFICE_TOP.some(hit) || OFFICE_GROUPS.some((g) => g.items.some(hit))) return "office";
    if (KEIEI_ITEMS.some(hit)) return "keiei";
    if (SETTINGS_ITEMS.some(hit)) return "settings";
    return "home";
  }

  /**
   * tabs を書いた項目は、その中のどの画面を開いていても選ばれた状態にする。
   *
   * match を手で二重に書かせない。書き忘れると、開いたときに
   * メニューのどこも光らず「自分がどこにいるのか」が分からなくなる
   */
  for (const n of [...OFFICE_TOP, ...OFFICE_GROUPS.flatMap((g) => g.items), ...KEIEI_ITEMS, ...SETTINGS_ITEMS, ...MEMBER_SIDE_NAV]) {
    if (n.tabs && !n.match) n.match = n.tabs.map((t) => t.key);
  }

  // 社労士は社外の人。会計にも社内の他の画面にも入れず、共有された手続きだけを見る
  const ADVISOR_NAV = [
    { key: "hr", href: "advisor.html", label: "入社・退職手続き", icon: "badge", ready: true },
  ];

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /**
   * **ここ** を太字にする。それ以外の記法は解さない。
   *
   * 端末管理の告知で使う。踏み込んだ項目（見たサイトのドメインなど）を
   * ほかと同じ太さで並べたくない、というだけのためのもの。
   *
   * 先に esc してから ** を見る。中身が < や " でも、タグにはならない
   */
  const strong = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

  function icon(name, size) {
    return `<span class="material-symbols-outlined"${size ? ` style="font-size:${size}px;"` : ""}>${esc(name)}</span>`;
  }

  // 管理者側の画面をメンバーが開いた場合などに、行き先へ送り返す
  function homeFor(appRole, stage = null) {
    if (appRole === "sr") return "advisor.html";
    // 入社準備中は、ログインしたらまず入社準備。本人に「どこを見るか」を考えさせない
    if (appRole === "member" && isPreparing(stage)) return "/onboarding/";
    return "home.html";
  }

  /**
   * 採用HR・Sales・Office へのショートカット（ヘッダー）。
   *
   * 毎日のように行き来するので、左メニューを開かずに届くようにする。
   * ここが採用HR・Sales・Office の正式な入口。左メニュー（管理者・メンバーとも）には
   * 置かない（入口を二重にしない）。
   *
   * 出す・出さないは showsFor の hr / sales / office / keiei（/api/me の access ＝ サーバの
   * canAccessHr / canAccessSales / canAccessOffice / canAccessKeiei）で決める。新しい権限は増やさない。
   * 並びは ホーム｜採用HR｜Sales｜Office｜経営。複数の権限があれば、使えるものをすべて出す。
   * 経営者（owner）には全ツールが出る。経営は経営者だけ。
   * 管理画面でも、メンバーの画面でも同じ条件で出す（権限のある一般メンバーにも出る）。
   * 「メンバー表示で確認中」でも出す。この表示は権限を変えないので、
   * 同じ権限を持つメンバーに実際に見えているものと同じになる。
   *
   * 狭い画面では「HR」「Sales」「Office」「経営」まで縮める（CSS）。通知・ログアウトは押し出さない
   */
  //
  // ■ ツールの定義（データ）
  //   ツールを増やすときは、ここに1行足すだけ（lib/gw.js の accessOf にも1行）。
  //   key   … /api/me の access のキー（サーバの判定）と、showsFor の shows のキー
  //   ready … false のあいだは、権限があっても出さない。まだ実装されていないツールの
  //           リンク（存在しない画面）を出さないため
  //
  // ■ ヘッダーは「採用HR｜Sales｜Office｜経営｜⚙管理」の5つ。担当業務は1つの名前に1つだけ
  //   （同じ Office を「Office」と「月次業務」で二重に出さない。月次業務は Office の中の機能）
  //   altHref … 管理者（admin/owner）が開くときの入口。管理画面（admin-*.html）はそちらが正本で、
  //             /office・/keiei は access（canAccessOffice・canKeiei）の人だけが入れる別アプリ。
  //             入れない入口を出さない（出たのに押すと 403、を作らない）ため、人によって行き先を変える
  const TOOLS = [
    { key: "hr",     href: "/hr/",     label: "採用HR", short: "HR",     icon: "person_add",       ready: true },
    { key: "sales",  href: "/sales/",  label: "Sales",  short: "Sales",  icon: "storefront",       ready: true },
    { key: "office", href: "/office/", label: "Office", short: "Office", icon: "business_center",  ready: true,
      altHref: "admin-dashboard.html" },
    { key: "keiei",  href: "/keiei/",  label: "経営",   short: "経営",   icon: "monitoring",       ready: true,
      altHref: "admin-team.html" },
  ];

  /**
   * このツールを出すか／どこへ行くか。
   *   office … /api/me の access.office（経営者・責任者・経理）か、管理者（admin/owner）。
   *            管理者は管理画面（人事・労務・経理・事務）を開けるので Office に入れる。
   *            access.office の人は /office/（月次業務）、管理者は admin-dashboard.html から入る
   *   keiei  … 経営者（access.keiei）は /keiei/。管理者はチーム状況（admin-team.html）から
   *            （全員のタスク・日報・チーム状況は管理者も使う。経営アプリそのものは経営者だけ）
   * 権限の判定は showsFor（サーバの判定そのもの）に集めてある。ここでは並べ直さない
   */
  function toolVisible(t, shows) {
    if (t.key === "office") return Boolean(shows.office);
    if (t.key === "keiei") return Boolean(shows.keiei || shows.team);
    return Boolean(shows[t.key]);
  }
  function toolHref(t, shows) {
    // 人事・労務／経理・事務のどちらかに入れる人は、Office の画面（ダッシュボード）へ。月末月初（/office/）だけの人は /office/ へ
    if (t.key === "office") return shows.officeAny ? t.altHref : t.href;
    if (t.key === "keiei") return shows.keiei ? t.href : t.altHref;
    return t.href;
  }

  function shortcutsHtml(shows = {}, path = location.pathname, area = null) {
    const list = TOOLS.filter((t) => t.ready && toolVisible(t, shows));
    if (!list.length) return "";
    return `<nav class="kp-shortcuts" aria-label="業務ツール">${list.map((s) => {
      // /office・/keiei の中にいるとき、または管理画面でその領域（Office・経営）を開いているとき
      const on = path.startsWith(s.href) || (s.key === "office" && area === "office") || (s.key === "keiei" && area === "keiei");
      return `<a class="btn btn-secondary btn-sm kp-shortcut${on ? " on" : ""}" href="${toolHref(s, shows)}"
                 data-shortcut="${s.key}" title="${esc(s.label)}"${on ? ' aria-current="page"' : ""}>
          ${icon(s.icon, 18)}<span class="kp-sc-long">${esc(s.label)}</span><span class="kp-sc-short">${esc(s.short)}</span>
        </a>`;
    }).join("")}</nav>`;
  }

  function renderTopbar({ name, appRole, memberView, shows, active, stage }) {
    const tag = memberView
      ? "メンバー表示で確認中"
      : ({ admin: "管理者", owner: "経営者", sr: "社労士", member: "" }[appRole] || "");
    const home = memberView ? "home.html" : homeFor(appRole, stage);
    const canPreview = appRole === "admin" || appRole === "owner";
    // Office・⚙管理 は admin/owner だけ（メンバー表示で確認中は出さない。管理者機能を隠す意味が崩れるため）
    const showAdminTools = canPreview && !memberView;
    // 人事・経理の担当者（管理者ではない）も、Office の画面（admin-*.html）の中では「/ OFFICE」を出す
    const officeUser = !canPreview && appRole !== "sr" && Boolean(shows.officeAny);
    const area = (showAdminTools || (officeUser && areaOf(active) === "office")) ? areaOf(active) : null;

    const el = document.createElement("div");
    el.className = "topbar";
    el.innerHTML = `
      <div class="brand">
        <a href="${home}" style="text-decoration:none;color:inherit;">
          <img src="img/logo.svg" alt="" class="kp-logo">エイト</a>
        ${area && area !== "home" ? `<span class="kp-app">/ ${{ office: "OFFICE", keiei: "経営", settings: "管理" }[area]}</span>` : ""}
        ${tag ? `<span class="tag${memberView ? " preview" : (appRole !== "member" ? " admin" : "")}">${esc(tag)}</span>` : ""}
      </div>
      <div class="who">
        ${shortcutsHtml(shows, location.pathname, area)}
        <span class="kp-who-name">${esc(name)}</span>
        ${canPreview ? (memberView
          ? `<button class="btn btn-primary btn-sm" onclick="KPLayout.exitMemberView()">
               ${icon("admin_panel_settings", 18)}管理画面に戻る
             </button>`
          : `<button class="btn btn-secondary btn-sm" onclick="KPLayout.viewAsMember()"
                     title="メンバーに見える画面を、このアカウントのまま確認します">
               ${icon("visibility", 18)}メンバー表示
             </button>`) : ""}
        ${showAdminTools ? `
        <div class="kp-bell kp-admin-menu">
          <button class="icon-btn${area === "settings" ? " on" : ""}" id="kp-admin-menu-btn" title="管理"
                  data-shortcut="area-settings" onclick="KPLayout.toggleAdminMenu()">
            ${icon("settings", 20)}
          </button>
          <div class="kp-bell-panel hidden" id="kp-admin-menu-panel">${adminMenuHtml()}</div>
        </div>` : ""}
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

  /**
   * ⚙管理のドロップダウン中身。通知ベル（kp-bell-panel）と同じ器を使い回す。
   * SETTINGS_ITEMS（権限・端末・貸与品・アクセス分析・システム設定）への直リンクだけ。
   * サーバへ確かめに行く必要が無いので、通知と違って毎回その場で組み立てるだけでよい
   */
  function adminMenuHtml() {
    return `
      <div class="kp-bell-head"><b>管理</b></div>
      ${SETTINGS_ITEMS.map((n) => `
        <a class="kp-bell-item" href="${esc(n.href)}">
          ${icon(n.icon, 18)}<b style="display:inline;margin-left:8px;">${esc(n.label)}</b>
        </a>`).join("")}`;
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
  function renderMemberNav(active, shows = {}, stage = null) {
    if (isPreparing(stage)) return renderPreparingNav(active);
    // 出す・出さないの条件は3つ。
    //   when  … 使う人にだけ（設備予約・会計）
    //   stage … いまの段階で開いている画面だけ（入社準備は5つだけ）
    //   lms   … 無限道場の URL が設定されているときだけ
    const allowed = stage?.allowed || null;
    const items = dropEmptySections(MEMBER_SIDE_NAV
      .filter((n) => n.section || !n.when || shows[n.when])
      .filter((n) => n.section || !allowed || allowed.includes(n.key))
      // 入社手続きは、入社準備のあいだだけ出す
      .filter((n) => n.key !== "onboarding" || (stage?.preparingOnly || []).includes("onboarding"))
      // 別システムは、行き先が設定されているものだけ
      .filter((n) => !n.urlKey || shows[n.urlKey])
      .map((n) => (n.urlKey ? { ...n, href: shows[n.urlKey] } : n)));
    renderSidebar(active, items, "member");

    const el = document.createElement("nav");
    el.className = "kp-tabbar";
    el.innerHTML = MEMBER_NAV.filter((n) => !allowed || allowed.includes(n.key)).map((n) => {
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

  /** 入社準備中のメニュー。PCは左、スマホは下のタブ（どちらも同じ4つ） */
  function renderPreparingNav(active) {
    // 給与管理はマイページの中の#cond-card。同じ画面なので、どちらを見ているかは # で決める
    const key = active === "mypage" && /^#cond/.test(location.hash) ? "payroll" : active;
    renderSidebar(key, PREPARING_NAV, "member");

    const el = document.createElement("nav");
    el.className = "kp-tabbar";
    el.innerHTML = PREPARING_NAV.filter((n) => !n.section).map((n) => {
      const on = n.key === key || (n.match || []).includes(key);
      return `<a class="kp-tab${on ? " on" : ""}" href="${n.href}">${icon(n.icon, 22)}<span>${esc(n.key === "settings_self" ? "設定" : n.label)}</span></a>`;
    }).join("");
    document.body.appendChild(el);
    document.body.classList.add("kp-has-tabbar");

    // マイページの中で「給与管理」と「設定」を行き来したとき（同じ画面で # だけ変わる）、選んだ状態を合わせる
    window.addEventListener("hashchange", () => {
      const k = active === "mypage" && /^#cond/.test(location.hash) ? "payroll" : active;
      for (const a of document.querySelectorAll(".kp-sidebar .kp-side-item, .kp-tabbar .kp-tab")) {
        const item = PREPARING_NAV.find((n) => n.href === a.getAttribute("href"));
        if (item) a.classList.toggle("on", item.key === k || (item.match || []).includes(k));
      }
    });
  }

  /**
   * 中身が1つも残らなかった見出しを落とす。
   * 別システムがどれも未設定のとき、「つながっている仕組み」だけが
   * 宙に浮いて残るのを防ぐ
   */
  function dropEmptySections(items) {
    return items.filter((n, i) => {
      if (!n.section) return true;
      const next = items[i + 1];
      return Boolean(next) && !next.section;
    });
  }

  // ---- 管理者メニューの開け閉め -----------------------------------------------
  // 開いているグループの鍵を覚えておく。読めない・壊れているときは空で始める
  const NAV_OPEN_KEY = "kp_nav_open";
  const loadOpen = () => {
    try {
      const v = JSON.parse(localStorage.getItem(NAV_OPEN_KEY) || "[]");
      return new Set(Array.isArray(v) ? v : []);
    } catch { return new Set(); }
  };
  const saveOpen = (set) => {
    try { localStorage.setItem(NAV_OPEN_KEY, JSON.stringify([...set])); }
    catch { /* 保存できなくても、その画面のあいだは動く */ }
  };

  /** いま見ている画面が入っている Office サブグループ。ここは必ず開く */
  const groupOf = (active) =>
    OFFICE_GROUPS.find((g) => g.items.some((i) => i.key === active || (i.match || []).includes(active))) || null;

  /**
   * 管理者: 左サイドメニュー。いま選んでいる業務領域（ホーム／Office／管理）の中だけを出す。
   * ホーム・管理は項目が少ないので平らに並べる。Office だけ人事・労務／経理・事務の
   * 2グループに畳める（社労士のように項目が少ない相手には、従来どおり平らに並べる＝items引数）
   */
  function renderAdminNav(active, items = null, shows = {}) {
    if (items) return renderSidebar(active, items, "admin");

    // ホーム領域（全員と同じ左メニュー）は renderChrome が renderMemberNav で描く。ここは Office・管理だけ
    const area = areaOf(active);
    if (area === "settings") return renderSidebar(active, SETTINGS_ITEMS, "admin");
    if (area === "keiei") return renderSidebar(active, KEIEI_ITEMS.filter((n) => !n.when || shows[n.when]), "admin");

    const open = loadOpen();
    const here = groupOf(active);
    // PC では、いる場所のグループを必ず開く。
    // 狭い画面ではメニューが本文の上に積まれるので、開いたままにすると
    // 本文が下に押される。見出しに印を付けるだけにして、畳んでおく
    const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 860px)").matches;
    if (here && !narrow) open.add(here.key);

    const el = document.createElement("nav");
    el.className = "kp-sidebar grouped";
    // 自分の担当だけ出す（when は shows＝/api/me の access）。担当の無いグループは、グループごと出さない
    const vis = (n) => !n.when || Boolean(shows[n.when]);
    el.innerHTML = OFFICE_TOP.filter(vis).map((n) => sideItem(n, active)).join("") + OFFICE_GROUPS.filter(vis).map((g) => {
      const on = open.has(g.key);
      const hasActive = here && here.key === g.key;
      return `
        <button type="button" class="kp-side-group${on ? " open" : ""}${hasActive ? " here" : ""}"
                data-group="${esc(g.key)}" aria-expanded="${on}"
                onclick="KPLayout.toggleNavGroup('${esc(g.key)}')">
          ${icon(g.icon, 19)}<span class="lb">${esc(g.label)}</span>
          <span class="kp-side-dot hidden" title="中に対応が必要なものがあります"></span>
          <span class="ch material-symbols-outlined">expand_more</span>
        </button>
        <div class="kp-side-sub${on ? "" : " hidden"}" data-group="${esc(g.key)}">
          ${g.items.filter(vis).map((n) => sideItem(n, active)).join("")}
        </div>`;
    }).join("");
    document.body.appendChild(el);
    document.body.classList.add("kp-has-sidebar");
    document.documentElement.classList.add("kp-has-sidebar");
  }

  /** グループを1つ開け閉めする。描き直さず、その場で切り替える */
  function toggleNavGroup(key) {
    const btn = document.querySelector(`.kp-side-group[data-group="${key}"]`);
    const box = document.querySelector(`.kp-side-sub[data-group="${key}"]`);
    if (!btn || !box) return;

    const nowOpen = box.classList.toggle("hidden") === false;
    btn.classList.toggle("open", nowOpen);
    btn.setAttribute("aria-expanded", String(nowOpen));

    const open = loadOpen();
    if (nowOpen) open.add(key); else open.delete(key);
    saveOpen(open);
  }

  /**
   * ページの上に出す切り替え帯。
   *
   * ■ なぜ左メニューに置かないのか
   *   「勤怠」と「休暇・稟議」は、どちらも同じ仕事の続きで開くもの。
   *   左メニューに2つ並べると、毎日見る一覧が1行ずつ長くなっていく。
   *   左には「勤怠管理」1つだけ置き、行き来は開いた先でする。
   *
   * ■ 各HTMLには何も書かせない
   *   どの画面がどのタブに属するかは、この1か所（tabs）だけで決まる。
   *   HTML側に帯を書き写すと、増やしたときに書き忘れる画面が出る。
   *   .wrap の最初の見出しの直後に差し込む。
   */
  function renderSubnav(active, navs, shows = {}) {
    const owner = navs.find((n) => (n.tabs || []).some((t) => t.key === active));
    // when が付いたタブは、その権限（shows）のある人にだけ出す
    const tabs = owner ? owner.tabs.filter((t) => !t.when || shows[t.when]) : [];
    if (!owner || tabs.length < 2) return;

    const wrap = document.querySelector(".wrap");
    const head = wrap && wrap.querySelector("h1");
    if (!head) return;
    // 描き直しても2本にならない
    for (const old of wrap.querySelectorAll(".kp-subnav")) old.remove();

    const box = document.createElement("nav");
    box.className = "kp-subnav";
    box.setAttribute("aria-label", esc(owner.label));
    box.innerHTML = tabs.map((t) => {
      const on = t.key === active;
      return on
        ? `<span class="kp-subtab on" aria-current="page">${esc(t.label)}</span>`
        : `<a class="kp-subtab" href="${esc(t.href)}">${esc(t.label)}</a>`;
    }).join("");
    head.insertAdjacentElement("afterend", box);
  }

  /**
   * その項目が背負う件数の鍵。
   *
   * 2階層目をページの上のタブへ移したので、中の件数が外から見えなくなる。
   * たとえば「契約書」をマイページの中へ入れると、未署名が1件あっても
   * 左メニューには何も出ない。開かないと気づけないのでは、畳んだ意味が無い。
   * 自分の鍵と、タブの鍵をまとめて背負う
   */
  const badgeKeys = (n) => [...new Set([n.key, ...(n.tabs || []).map((t) => t.key)])]
    .filter(Boolean);

  function sideItem(n, active) {
    // match が書いてあれば、そこに挙げた画面のどれでも選ばれた状態にする
    const on = n.key === active || (n.match || []).includes(active);
    const cls = `kp-side-item${on ? " on" : ""}${n.ready ? "" : " soon"}${n.external ? " ext" : ""}`;
    // 件数はあとから /api/badges で入れる。ここでは器だけ置く
    const inner = `${icon(n.icon, 19)}<span>${esc(n.label)}</span>`
      + `<b class="kp-side-badge hidden" data-badge="${esc(badgeKeys(n).join(" "))}"></b>`
      + `${n.ready ? "" : '<em>準備中</em>'}`;
    return n.ready
      ? `<a class="${cls}" href="${n.href}">${inner}</a>`
      : `<span class="${cls}">${inner}</span>`;
  }

  /**
   * サイドメニューに「対応が要る件数」を出す。
   *
   * ■ なぜ必要か
   *   メッセージが届いても、経費の申請が上がっても、
   *   その画面を開くまで気づけなかった。
   *   ベルの通知は流れていくが、こちらは「片づくまで消えない」。
   *
   * ■ 0 は出さない
   *   いつも数字が付いているバッジは、そこにある時点で意味を失う。
   *   件数が返ってこない項目は、器ごと隠したままにする。
   *
   * ■ 取れなくても画面は動く
   *   バッジのために画面が止まる理由はない。
   */
  async function loadBadges() {
    let badges = {};
    try {
      const res = await API.badges();
      badges = res?.badges || {};
    } catch (e) {
      return;   // 数字が出ないだけ。黙って戻る
    }
    for (const node of document.querySelectorAll("[data-badge]")) {
      // 「mypage contracts」のように、複数の鍵を背負っていることがある。
      // 空白区切りにしてあるので、CSS からは [data-badge~="contracts"] で引ける
      const n = String(node.dataset.badge).split(/\s+/).filter(Boolean)
        .reduce((a, k) => a + (badges[k] || 0), 0);
      node.textContent = n > 99 ? "99+" : String(n);
      node.classList.toggle("hidden", !n);
    }
    // 畳んだグループにも、中に用があることを出す（畳めるのは Office の2グループだけ）。
    // 開かないと気づけないのでは、畳んだ意味が無くなる
    for (const g of OFFICE_GROUPS) {
      const sum = g.items.reduce((a, it) =>
        a + badgeKeys(it).reduce((b, k) => b + (badges[k] || 0), 0), 0);
      const mark = document.querySelector(`.kp-side-group[data-group="${g.key}"] .kp-side-dot`);
      if (mark) mark.classList.toggle("hidden", !sum);
    }
  }

  function renderSidebar(active, items, variant) {
    const el = document.createElement("nav");
    el.className = `kp-sidebar${variant === "member" ? " member" : ""}`;
    el.innerHTML = items.map((n) =>
      n.section
        ? `<div class="kp-side-section">${esc(n.section)}</div>`
        : sideItem(n, active)).join("");
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

  // /api/me の答えそのものも覚えておく。
  //
  // ■ なぜ枠だけでは足りないのか
  //
  //   枠（権限・名前）を覚えて先に描いていたので、見た目はすぐ出ていた。
  //   ところが各画面は init() の戻りを待ってから自分のデータを取りにいく。
  //   その init() が /api/me を待っていたので、
  //   画面の中身は結局1往復ぶん遅れて出ていた。「読み込み中…」はここ。
  //
  //   覚えているなら、それを先に返して、確かめるのは裏でやる。
  //   違っていれば描き直すか、送り返す（下の verify）。
  //
  // ■ 覚えておくのは短いあいだだけ
  //
  //   毎回かならず裏で確かめるので古いままにはならないが、
  //   何日も前のものを入口にはしない
  const ME_KEY = "kp_me";
  const ME_HOURS = 12;
  const loadMe = () => {
    try {
      const v = JSON.parse(localStorage.getItem(ME_KEY) || "null");
      if (!v?.me || Date.now() - (v.at || 0) > ME_HOURS * 3600000) return null;
      // 誰のぶんかを必ず見る。
      // ログアウトのときは消しているが、前の人のセッションが切れたところへ
      // 別の人がそのまま入ると、消さずに入れ替わる道がある。
      // 覚えていた人と、いま入っている人が違えば、使わない
      if (v.email && v.email !== API.currentEmail()) return null;
      return v.me;
    } catch { return null; }
  };
  const saveMe = (me) => {
    try {
      localStorage.setItem(ME_KEY,
        JSON.stringify({ at: Date.now(), email: API.currentEmail(), me }));
    } catch { /* 保存できなくても動く */ }
  };
  const clearCache = () => {
    try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem(ME_KEY); } catch { /* 同上 */ }
  };

  /**
   * 急がない通信を、画面のデータより後ろに回す。
   *
   * バッジも端末の合図も、その画面の中身より先に出す理由がない。
   * 先に投げると、ブラウザの手が空くのを待つあいだ、本体が並んで待つことになる
   */
  function soon(fn) {
    if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 1500 });
    else setTimeout(fn, 200);
  }

  /**
   * 身元と権限を、サーバに確かめる。
   *
   * 覚えているぶんで先に描いたときは、これを待たずに画面が動き出す。
   * 違っていたら、ここで描き直すか、開けない画面から送り返す。
   *
   * @param {{active?:string, roles?:string[]}} opts
   * @param {object|null} painted 先に描いた内容（描いていなければ null）
   * @returns {Promise<{me:object, appRole:string}|null>}
   */
  async function verify(opts, painted) {
    let me, cfg;
    try {
      // 身元と公開設定は、互いを待つ理由がない。同時に出す。
      // 直列にしていたぶん、そのまま1往復ぶんの待ちになっていた
      [me, cfg] = await Promise.all([API.me(), API.config().catch(() => null)]);
    } catch (e) {
      // トークン切れ等。ログイン画面に戻す
      API.logout();
      clearCache();
      showLogin("セッションが切れました。もう一度ログインしてください。");
      return null;
    }

    const appRole = me.appRole || (me.isAdmin ? "admin" : "member");
    const name = me.gw?.employee?.display_name || me.email || "";
    const shows = showsFor({ ...me, lmsUrl: cfg?.lmsUrl || null, timecardUrl: cfg?.timecardUrl || null });
    const stage = me.gw?.stage || null;
    saveCache({ appRole, name, shows, stage });
    saveMe(me);
    mfaNudge(me.mfa);

    // 入社準備のあいだは、開いていない画面へ直接来ても中身を出さない。
    // メニューから消すだけだと、ブックマークや共有リンクで入れてしまう
    if (appRole === "member" && stage && opts.active
        && !stage.allowed.includes(opts.active)) {
      location.replace(homeFor(appRole, stage));
      return null;
    }

    const allowed = opts.roles;
    if (allowed && !allowed.includes(appRole)) {
      location.replace(homeFor(appRole, stage));
      return null;
    }

    // roles（appRole）では表せない権限（例：人事・経理など、複数ロールにまたがるもの）は
    // access で見る。appRole は owner/admin/sr/member の4値しか無く、それ単体の人も
    // "member" になる。roles だけで入口を絞ると、API は通るのに画面へ入れない食い違いが起きる
    // access は1つでも、複数（どれか1つ）でもよい。例: Office のダッシュボードは ["officeHr", "officeFinance"]。
    // 社労士（sr）は Office・管理の画面を開かない（管理者を兼ねていても、advisor の画面だけ）
    const need = [].concat(opts.access || []);
    if (need.length && (appRole === "sr" || !need.some((k) => me.access?.[k]))) {
      location.replace(homeFor(appRole, stage));
      return null;
    }

    // メンバーが開けない画面（管理用）を開いたら、確認モードは終わりにする。
    // 下タブのままサイドメニューの画面に居ると、どちらの立場なのか分からなくなる
    if (isMemberView() && ((allowed && !allowed.includes("member")) || opts.access)) {
      setMemberView(false);
      painted = null;
    }

    // 覚えていた内容と違っていたときだけ描き直す
    if (!painted || painted.appRole !== appRole || painted.name !== name
        || JSON.stringify(painted.shows || {}) !== JSON.stringify(shows)
        || JSON.stringify(painted.stage || null) !== JSON.stringify(stage)) {
      renderChrome({ name, appRole, shows, stage }, opts.active);
    }

    return { me, appRole };
  }

  /**
   * 二段階認証の案内。対象で、まだ登録していない人にだけ、画面の上に1行。
   * 期限を過ぎたら、機密の API が mfa_required を返してマイページへ送るので、
   * ここで止めることはしない（登録の場所へ行く道を塞がない）
   */
  function mfaNudge(mfa) {
    if (!mfa?.required || mfa.enrolled) return;
    if (document.querySelector(".kp-mfa-nudge")) return;
    if (/mypage\.html/.test(location.pathname)) return;
    const wrap = document.querySelector(".wrap");
    if (!wrap) return;
    const box = document.createElement("div");
    box.className = "banner warn kp-mfa-nudge";
    box.style.marginBottom = "16px";
    box.innerHTML = `${icon("verified_user", 20)}<div>${mfa.enforced
      ? "二段階認証の登録が必要です。個人情報の画面は、登録するまで開けません。"
      : `二段階認証を <b>${esc(mfa.enrollUntil)}</b> までに登録してください。${esc(mfa.enforceFrom)} から必須になります。`}
      　<a href="mypage.html#mfa">マイページで登録する</a></div>`;
    wrap.insertBefore(box, wrap.firstChild);
  }

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

  function renderChrome({ name, appRole, shows, stage }, active) {
    clearChrome();
    const canPreview = appRole === "admin" || appRole === "owner";
    const memberView = canPreview && isMemberView();

    renderTopbar({ name, appRole, memberView, shows, active, stage });
    // 管理者は段階では絞らない。管理画面の並びになるので、この表は使わない
    // 管理者もホーム領域は全員と同じ左メニュー。Office・管理（⚙）に入ったときだけ専用の左メニュー
    // Office の担当者（人事・経理。管理者ではない）は、Office の領域の中だけ専用の左メニュー（自分の担当グループだけ）。
    // 管理（⚙）・経営の領域は管理者・経営者だけ
    const areaNow = areaOf(active);
    const officeUser = !canPreview && appRole !== "sr" && Boolean(shows.officeAny);
    const adminArea = areaNow !== "home" && ((canPreview && !memberView) || (officeUser && areaNow === "office"));
    if (adminArea) renderAdminNav(active, null, shows);
    else if (appRole === "sr") renderAdminNav(active, ADVISOR_NAV);
    else renderMemberNav(active, shows, stage);

    // 2階層目の帯。左メニューには出さず、ページの上に出す。
    // 管理者側は、いまどの領域を見ているかに関わらず全領域ぶんのタブ定義から探す
    // （領域をまたいで active を特定できるようにする。表示するサイドメニューとは別）
    renderSubnav(active, !adminArea
      ? MEMBER_SIDE_NAV
      : [...OFFICE_TOP, ...OFFICE_GROUPS.flatMap((g) => g.items), ...KEIEI_ITEMS, ...SETTINGS_ITEMS], shows);

    // メニューを描いたあとで件数を入れる。取れなくても画面は動く。
    // その画面のデータより先に投げない（バッジのために本文を待たせない）
    soon(() => {
      loadBadges();
      // この端末から社内システムに入っていることを、5分ごとに知らせる。
      // 送るのは端末の印と種類だけで、どの画面を見ていたかは送らない
      if (window.KPDevice) KPDevice.start();
    });
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
    // 管理画面（admin-*.html）を開ける人（appRole が admin / owner）
    const adminApp = ["admin", "owner"].includes(me?.appRole || (me?.isAdmin ? "admin" : ""));
    return {
      booking: staff || gwRoles.includes("booking"),
      adminApp,
      // 採用HR（/hr）・Sales（/sales）の入口。
      // サーバが判定した結果（/api/me の access = lib/gw.js の canAccessHr / canAccessSales）をそのまま使う。
      // 役割の並びを画面側で持たない（ヘッダーに出たのに 403、を作らない）。
      // access が無いのは、前の版の /api/me を覚えていたときだけ。採用HR・Sales は同じ基準で数える
      // 社内権限（メンバー管理のチェック）だけで決まる。会計の管理者・IT・管理だけでは出さない。
      hr: me?.access ? Boolean(me.access.recruit)
        : ["owner", "manager", "hr", "recruiter"].some((r) => gwRoles.includes(r)),
      sales: me?.access ? Boolean(me.access.sell)
        : ["owner", "manager", "sales"].some((r) => gwRoles.includes(r)),
      // Office。/office（月次業務）に入れる人は access.office だけ（金額を扱うので、access が無いときは出さない）。
      // 管理者（admin/owner）は管理画面の人事・労務・経理・事務に入れるので、Office の入口も出す。
      // 入口は人によって変える（toolHref）ので、押して 403 になる人は出ない
      officeApp: Boolean(me?.access?.office),
      // Office の業務ごと（人事・労務／経理・事務）。サーバの判定（canOfficeHr / canOfficeFinance）そのもの。
      // access が無い古い応答のときは、管理者（admin/owner）だけ両方に入れる。社労士（sr）は入れない
      officeHr: me?.appRole !== "sr" && (me?.access ? Boolean(me.access.officeHr) : adminApp),
      officeFinance: me?.appRole !== "sr" && (me?.access ? Boolean(me.access.officeFinance) : adminApp),
      // Office の画面（admin-*.html）のどれかに入れる人
      officeAny: me?.appRole !== "sr" && (me?.access ? Boolean(me.access.officeHr || me.access.officeFinance) : adminApp),
      // Office の入口を出す人 = 人事・労務／経理・事務／月末月初（/office）のどれか1つでも入れる人。
      // 入れない人にヘッダーの入口を出さない（押して 403 を作らない）
      office: me?.appRole !== "sr" && (Boolean(me?.access?.office) || adminApp
        || Boolean(me?.access?.officeHr) || Boolean(me?.access?.officeFinance)),
      // 経営（/keiei）は経営者だけ。サーバの判定（canKeiei）そのもの
      keiei: me?.access ? Boolean(me.access.keiei) : gwRoles.includes("owner"),
      // 全員のタスク・日報・チーム状況（管理画面）を開ける人。経営の入口（管理者はここから）
      team: adminApp,
      // 会計は経理・管理担当だけ。一般メンバーには入口を出さない。
      // memberships の role は、登録すると全員 'client' が付くので、
      // それでは判定にならない。admin / staff と社内ロールで見る
      accounting: staff || roles.includes("admin") || roles.includes("staff"),
      // 別システムの入口。同じ auth.users を使うので、別のIDもパスワードも要らない
      lmsUrl: me?.lmsUrl || null,
      timecardUrl: me?.timecardUrl || null,
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

  // ---- 大きく見る -------------------------------------------------------------
  //
  // 契約書のように「細かい字を確かめる」ものは、画面の半分では読めない。
  // 枠を広げる代わりに、画面いっぱいに出す器を1つ用意して、
  // どの画面からも同じ形で使う。閉じ方（Esc と ✕）も1つに揃う。
  //
  // 中身は2つだけ。PDF（src）か、文字（text）。
  // どちらも「元の画面はそのまま」なので、閉じれば続きから作業できる。
  let viewerEsc = null;

  function openViewer(opts = {}) {
    closeViewer();

    const box = document.createElement("div");
    box.className = "kp-viewer";
    box.id = "kp-viewer";
    box.innerHTML = `
      <div class="kp-viewer-bar">
        <span class="t">${esc(opts.title || "")}</span>
        ${opts.actions || ""}
        ${opts.src ? `<button type="button" data-kp-viewer-open>
          <span class="material-symbols-outlined">open_in_new</span>別のタブで開く</button>` : ""}
        <button type="button" data-kp-viewer-close>
          <span class="material-symbols-outlined">close</span>閉じる</button>
      </div>
      <div class="kp-viewer-body">
        ${opts.src
          ? `<iframe title="${esc(opts.title || "プレビュー")}" src="${esc(opts.src)}"></iframe>`
          : `<div class="kp-viewer-text"><div></div></div>`}
      </div>`;

    // 文字は textContent で入れる。契約書の本文に < が入っていても、
    // 消えたり壊れたりしない
    if (!opts.src) box.querySelector(".kp-viewer-text > div").textContent = opts.text || "";

    box.querySelector("[data-kp-viewer-close]").addEventListener("click", closeViewer);
    const openBtn = box.querySelector("[data-kp-viewer-open]");
    if (openBtn) openBtn.addEventListener("click", () => window.open(opts.src, "_blank", "noopener"));

    document.body.appendChild(box);
    // 後ろの画面が一緒に動くと、閉じたときに見ていた場所が変わる
    document.body.style.overflow = "hidden";

    viewerEsc = (e) => { if (e.key === "Escape") closeViewer(); };
    document.addEventListener("keydown", viewerEsc);
    return box;
  }

  // ファイルを保存させる。
  //
  // location.href に入れると、URLが切れていたときにJSONのエラー画面へ飛んでしまい、
  // いま開いていた画面ごと失う。a を作って押すと、うまくいけば保存、
  // ダメでも今の画面は残る（保存になるかは、返ってくる
  // Content-Disposition: attachment で決まる。別のドメインなので download 属性は効かない）
  function saveFile(url, filename) {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "";
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
  }

  function closeViewer() {
    const box = document.getElementById("kp-viewer");
    if (box) box.remove();
    if (viewerEsc) document.removeEventListener("keydown", viewerEsc);
    viewerEsc = null;
    document.body.style.overflow = "";
  }

  function showLogin(message) {
    document.body.innerHTML = `
      <div class="topbar"><div class="brand">
        <img src="img/logo.svg" alt="" class="kp-logo">エイト</div></div>
      <div class="wrap">
        <div class="card" style="max-width:420px;margin:40px auto;">
          <div style="text-align:center;margin-bottom:18px;">
            <img src="img/logo.svg" alt="エイト" style="width:64px;height:64px;">
          </div>
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

  // アプリとして入れられるようにする（PWA）。
  //
  // manifest と theme-color を、画面ごとの HTML に書き足すのではなく
  // ここで足す。40近いファイルに同じ2行を貼ると、必ず貼り忘れが出る。
  //
  // Service Worker は、通知をすでに許可している人にだけ登録する。
  // 許可していない人に登録しても、できることが無い
  function setupPwa() {
    if (!document.querySelector('link[rel="manifest"]')) {
      const l = document.createElement("link");
      l.rel = "manifest";
      l.href = "/manifest.json";
      document.head.appendChild(l);
    }
    if (!document.querySelector('meta[name="theme-color"]')) {
      const m = document.createElement("meta");
      m.name = "theme-color";
      m.content = "#2b6cb0";
      document.head.appendChild(m);
    }
    if (window.KPPush) KPPush.warm();
  }

  window.KPLayout = {
    /**
     * ログイン確認 → 権限確認 → レイアウト描画。
     * 権限が無ければ本来の画面へ送り返し、null を返す（呼び出し側は何もしない）。
     * @param {{active?:string, roles?:string[], access?:string}} opts
     * @returns {Promise<{me:object, appRole:string}|null>}
     */
    async init(opts = {}) {
      if (!API.isLoggedIn()) { clearCache(); showLogin(); return null; }
      setupPwa();

      const cached = loadCache();
      const cachedMe = loadMe();

      // 覚えている権限で、この画面を開いてよいか。
      // 入社準備のあいだの制限も、覚えているぶんで一度見る。
      // access（roles では表せない権限）を使う画面は、access を覚えていないので
      // 先描きはせず、毎回 verify() の確認を待つ
      const okRole = cached?.appRole && (!opts.roles || opts.roles.includes(cached.appRole)) && !opts.access;
      // 覚えている形が古いことがある（allowed を持たない頃のもの）。
      // そこで落ちると、画面が真っ白のまま何も出ない
      const okStage = !(cached?.appRole === "member" && cached?.stage?.allowed && opts.active
                        && !cached.stage.allowed.includes(opts.active));

      // 覚えている権限があれば、通信を待たずに先に描く。
      // この画面を開いてよい権限のときだけ描く（違えばこのあと送り返される）
      let painted = null;
      if (okRole && okStage) {
        painted = cached;
        renderChrome(cached, opts.active);
      }

      // 正しいかどうかは、いつも裏で確かめる。
      // 違っていれば描き直すか、送り返す
      const fresh = verify(opts, painted);

      // 覚えているものが使えるなら、確かめ終わるのを待たずに返す。
      // ここで待つと、各画面が自分のデータを取りにいくのが1往復ぶん遅れる。
      // それが「読み込み中…」の正体だった
      if (painted && cachedMe) {
        fresh.catch(() => { /* 送り返し・ログイン画面は verify の中で済ませる */ });
        return { me: cachedMe, appRole: cached.appRole, remembered: true };
      }
      return fresh;
    },

    /**
     * 「社内情報」の中の切り替え。
     * お知らせ・社内文書・社員名簿は、どれも「調べにいく」ときに開くもの。
     * サイドメニューの入口は1つにして、中はこの帯で行き来する。
     */
    infoTabs(active) {
      const tabs = [
        // 社内文書を先頭に。お知らせはホームで読むものなので、ここでは控えに回す
        { key: "library",   href: "library.html",   label: "社内文書・様式" },
        { key: "notices",   href: "notices.html",   label: "お知らせ" },
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

    // ⚙管理のドロップダウン開閉。中身は固定なので、通知と違って毎回組み立て直す必要はない
    toggleAdminMenu() {
      const panel = document.getElementById("kp-admin-menu-panel");
      if (panel) panel.classList.toggle("hidden");
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

    // 画面いっぱいに出す。{ title, src }（PDF）か { title, text }（本文）。
    // actions に HTML を渡すと、閉じるボタンの左に並ぶ
    viewer: openViewer,
    closeViewer,
    // 保存させる（開かずに落とす）
    save: saveFile,

    // 管理者メニューのグループを開け閉めする（サイドメニューの中から呼ばれる）
    toggleNavGroup,

    // メンバーに見える画面を、このアカウントのまま確認する／やめる
    viewAsMember() { setMemberView(true); location.href = "home.html"; },
    exitMemberView() { setMemberView(false); location.href = "admin-dashboard.html"; },
    isMemberView,

    logout() { API.logout(); clearCache(); setMemberView(false); location.href = "index.html"; },
    homeFor,
    friendlyError,
    esc, strong,
    icon,
    // 業務ツールの定義（HR・Sales・Office・経営）。/keiei など、別アプリの画面が切替を出すときに使う
    tools: TOOLS,
  };
})();
