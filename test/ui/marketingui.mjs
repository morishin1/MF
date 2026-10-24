// マーケティング（/office/marketing.html）と Office ホームの「今日やること」を、実際のブラウザで通す（PC 1280px・スマホ 390px）。
//
// ■ 守ること（docs/office-marketing.md）
//   ・取得済み／未連携／権限なし／未準備／取得失敗／0件 を別々に出す。未連携を0件と書かない
//   ・開いた・詳細を見ただけでは、既読にも対応済みにもしない（GET 以外を呼ばない）
//   ・返信は、宛先・送信元・件名・本文を確認してから。二度押しでも送信は1回
//   ・次のアクションの変更も確認してから（採用HRの既存の変更を使う）
//   ・制作予定：SNS文案の文字数・コピー、手で投稿したあとの公開URLの記録（自動投稿はしない）
//   ・YouTube：既存動画の確認・プレビュー（youtube-nocookie）。未対応のサイトには載せない（ボタンを押せない）
//   ・スマホ幅で横にはみ出さない
// サーバは偽物（page.route）。実データ・実メール・YouTube には一切つながない。
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
const { accessOf } = await import("../../lib/gw.js");
const M = await import("../../lib/marketing.js");

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const L1 = "bbbbbbbb-0000-4000-8000-000000000001", L2 = "bbbbbbbb-0000-4000-8000-000000000002", L3 = "bbbbbbbb-0000-4000-8000-000000000003";
const srcOf = (key, state, extra = {}) => {
  const s = M.WORK_SOURCES.find((x) => x.key === key);
  return { key, biz: s.biz, kind: s.kind, label: s.label, original: s.original, scope: s.scope || null, need: s.need || [], missing: s.missing || [],
    requires: s.requires || null, via: s.via || null, state, count: state === "ok" ? 2 : null, ...extra };
};
const item = (id, extra) => ({
  key: `hr_lead:${id}`, source: "hr_lead", sourceId: id, biz: "mugen", kind: "inquiry", typeLabel: "無料カウンセリング",
  from: `架空 ${id.slice(-1)}`, subject: "無限道場 カジュアル面談", points: ["職業：会社員", "興味：AI活用・転職"],
  quote: "AIを仕事に使いたいが…", receivedAt: iso(NOW - 3600000), isNew: false, owner: null,
  status: { key: "todo", label: "対応中", open: true }, stage: "新規リード", next: "カジュアル面談の予約URLを送ってください",
  due: null, read: false, href: `/hr/applicants.html?category=mugendojo&id=${id}`, canReply: true, updatedAt: iso(NOW), ...extra,
});
function workBody({ hrState = "ok", readsReady = true } = {}) {
  const items = hrState === "ok" ? [
    item(L1, { isNew: true, owner: { id: "e1", name: "架空 担当" }, due: "2026-10-30" }),
    item(L2, { read: true, receivedAt: iso(NOW - 5 * 86400000), status: { key: "eval_pending", label: "カジュアル面談済", open: true }, next: "面談後の次のアクションを選んでください" }),
    item(L3, { receivedAt: iso(NOW - 9 * 86400000), status: { key: "passed", label: "対象外", open: false }, next: "対応は不要です" }),
  ].map((x) => (readsReady ? x : { ...x, read: null })) : [];
  return {
    fetchedAt: iso(NOW),
    sources: [srcOf("hr_lead", hrState, hrState === "ok" ? { fetchedAt: iso(NOW), total: 3 } : { hint: "採用HRの権限がある人だけが見られます" }),
      ...["mugen_course", "space_inquiry", "ec_contact", "site_contact"].map((k) => srcOf(k, "forbidden", { hint: `${M.WORK_SOURCES.find((x) => x.key === k).requires} が必要です` })),
      srcOf("ec_order", "not_connected")],
    items, readsReady: hrState === "ok" ? readsReady : null, unreadCount: hrState === "ok" && readsReady ? 1 : null,
    newCount: hrState === "ok" ? 1 : 0, openCount: hrState === "ok" ? 2 : 0,
  };
}
const detailBody = (id) => ({
  item: item(id, { isNew: true }), readsReady: true,
  view: {
    contact: [["お名前", "架空 1"], ["メール", "lead1@example.com"], ["電話", "090-0000-0000"], ["流入", "google / cpc"]],
    body: { label: "本人が書いた内容（原文）", text: "AIを仕事に使いたいが、何から始めればよいか分からない。<script>alert(1)</script>" },
    fields: [["職業", "会社員"], ["地域", "福岡県"], ["興味", "AI活用"]], bookings: [],
    history: [{ label: "無限道場LPからカジュアル面談の申込", detail: null, at: iso(NOW - 3600000), kind: "event" }],
    owner: { name: "架空 担当", from: "採用HRの担当" }, next: "カジュアル面談の予約URLを送ってください", due: "2026-10-30",
    actions: { reply: true, nextAction: [{ key: "trial", label: "体験案内" }, { key: "hold", label: "保留" }] },
  },
});
const prodBody = ({ planReady = true } = {}) => ({
  fetchedAt: iso(NOW), today: "2026-10-24",
  sources: [
    { ...M.PRODUCTION_SOURCES[0], state: "ok", count: 2, fetchedAt: iso(NOW), olderPublished: 3 },
    planReady ? { ...M.PRODUCTION_SOURCES[1], state: "ok", count: 2 } : { ...M.PRODUCTION_SOURCES[1], state: "not_ready", count: null, hint: "制作予定の保存先が未準備です（db/proposal_marketing.sql が未適用）" },
    ...M.PRODUCTION_SOURCES.filter((s) => !s.connected).map((s) => ({ ...s, state: "not_connected", count: null })),
  ],
  items: [
    { key: "site_news:n1", origin: "site_news", biz: "site", medium: "column", mediumLabel: "エイトコラム", title: "架空コラム（下書き）", summary: "要約",
      owner: null, ownerFrom: "none", due: null, state: { key: "drafting", label: "作成中" }, originalState: "下書き", publicUrl: null, originalUrl: "/admin-site-news.html#n1" },
    ...(planReady ? [
      { key: "plan:p1", origin: "plan", id: "dddddddd-0000-4000-8000-000000000001", version: 3, biz: "mugen", medium: "sns", mediumLabel: "SNS投稿", snsChannel: "x",
        title: "AIの始め方（SNS）", summary: "AIを仕事に使いたい人が最初にやること3つ", ownerId: "e1", owner: "架空 担当", ownerFrom: "plan", due: "2026-10-29",
        state: { key: "review", label: "確認待ち" }, planState: "review", originalState: null, publicUrl: null, inquiries: [{ key: `hr_lead:${L1}`, href: "/hr/applicants.html?category=mugendojo&id=x" }], hiddenInquiries: 0 },
      { key: "plan:p2", origin: "plan", id: "dddddddd-0000-4000-8000-000000000002", version: 1, biz: "mugen", medium: "youtube", mediumLabel: "YouTube動画",
        title: "動画で見る無限道場", summary: "", ownerId: null, owner: null, ownerFrom: "plan", due: null, state: { key: "plan", label: "企画" }, planState: "plan",
        youtubeVideoId: "dQw4w9WgXcQ", inquiries: [], hiddenInquiries: 0 },
    ] : []),
  ],
  videoSites: M.VIDEO_SITES, employees: [{ id: "e1", name: "架空 担当" }], canManageSite: true, canLinkInquiries: true,
});


// ---- 原本がつながったとき（8sp・無限道場の受講申込・会社HP）。架空データ ----
const SP1 = "eeeeeeee-0000-4000-8000-000000000001", CO1 = "eeeeeeee-0000-4000-8000-000000000041", QS1 = "eeeeeeee-0000-4000-8000-000000000051";
const BK1 = "eeeeeeee-0000-4000-8000-000000000011";
function allBody() {
  const sp = { key: `space_inquiry:${SP1}`, source: "space_inquiry", sourceId: SP1, biz: "space", kind: "booking", typeLabel: "予約",
    from: "架空 花子（架空商事）", subject: "社内研修", points: ["希望：2026-11-05 13:00-17:00", "12名", "経路：instabase", "予約：仮予約"],
    quote: "11/5 の午後、12名で…", receivedAt: iso(NOW - 3600000), isNew: true, owner: { id: null, name: "架空 事務", free: true },
    status: { key: "仮予約済み", label: "仮予約済み", open: true }, next: "仮予約の内容を確認して、承認するか決める", due: null, read: false,
    href: "https://8sp.jp/member/admin.html", canReply: true };
  const co = { key: `mugen_course:${CO1}`, source: "mugen_course", sourceId: CO1, biz: "mugen", kind: "inquiry", typeLabel: "受講申込（法人）",
    from: "架空 受講（架空株式会社）", subject: "AIで仕事とアイデアを形にする実践講座", points: ["申込：法人"], quote: "業務の自動化…",
    receivedAt: iso(NOW - 7200000), isNew: true, owner: null, ownerMissing: true, status: { key: "new", label: "未対応", open: true }, next: "", due: null,
    read: false, href: "https://mugendojo.jp/mgn/admin/applications", canReply: false };
  const qs = { key: `site_contact:${QS1}`, source: "site_contact", sourceId: QS1, biz: "site", kind: "inquiry", typeLabel: "無料相談",
    from: "架空 会社HP（架空工業）", subject: "無料相談", points: ["ページ：8grp_lp"], quote: "DXの相談をしたいです", receivedAt: iso(NOW - 1800000),
    isNew: true, owner: null, ownerMissing: true, status: { key: "未対応", label: "未対応", open: true }, next: "", due: null, read: false,
    href: "https://8ec.jp/admin/contact/", canReply: false };
  return { fetchedAt: iso(NOW),
    sources: [srcOf("hr_lead", "forbidden", { hint: "採用HRの権限がある人だけが見られます" }), srcOf("mugen_course", "ok", { count: 1, fetchedAt: iso(NOW) }),
      srcOf("space_inquiry", "ok", { count: 1, fetchedAt: iso(NOW) }), srcOf("ec_contact", "ok", { count: 0, fetchedAt: iso(NOW) }),
      srcOf("site_contact", "ok", { count: 1, fetchedAt: iso(NOW) }), srcOf("ec_order", "not_connected")],
    items: [qs, sp, co], readsReady: true, unreadCount: 3, newCount: 3, openCount: 3 };
}
const allDetails = {
  space_inquiry: () => ({ item: allBody().items[1], readsReady: true, view: {
    contact: [["お名前", "架空 花子"], ["会社名", "架空商事"], ["メール", "hanako@example.com"], ["電話", "090-0000-0001"], ["経路", "instabase"]],
    body: { label: "お問い合わせの内容（原文）", text: "11/5 の午後、12名で研修に使いたいです。プロジェクターはありますか。" },
    fields: [["種類", "予約"], ["利用目的", "社内研修"], ["希望日時", "2026-11-05 13:00-17:00"], ["人数", "12名"], ["8sp の進み具合", "仮予約済み"]],
    bookings: [{ id: BK1, startsAt: "2026-11-05T04:00:00Z", endsAt: "2026-11-05T08:00:00Z", purpose: "社内研修", headcount: 12, status: "tentative", statusLabel: "仮予約", amount: 24000, comment: null, canDecide: true }],
    history: [{ at: iso(NOW - 1000), label: "メモ", detail: "折り返し電話する", who: "架空 事務", kind: "note" }, { at: iso(NOW - 3600000), label: "受付", detail: "instabase から", who: null, kind: "event" }],
    owner: { name: "架空 事務", from: "事務ポータルの担当（自由記述）" }, next: "仮予約の内容を確認して、承認するか決める", due: null, dueNote: "期限は原本に項目がありません",
    actions: { note: true, done: true, reopen: false, reply: true, replyVia: "space_mail", replyNote: null } } }),
  mugen_course: () => ({ item: allBody().items[2], readsReady: true, view: {
    contact: [["お名前", "架空 受講"], ["会社・団体", "架空株式会社"], ["部署", "総務部"], ["メール", "juko@example.com"]],
    body: { label: "受講で実現したいこと（原文）", text: "業務の自動化を学びたい" }, fields: [["申込", "法人"], ["状態", "未対応"]], bookings: [],
    history: [{ at: iso(NOW - 7200000), label: "受講申込", kind: "event" }], owner: null, ownerNote: "担当は原本に項目がありません",
    next: "", nextNote: "次の対応は原本に項目がありません", due: null, dueNote: "期限は原本に項目がありません",
    actions: { note: false, done: false, reopen: false, reply: false, readOnlyNote: "無限道場には、受講申込の状態を変える画面・関数がまだありません。ここでは読むだけです" } } }),
  site_contact: () => ({ item: allBody().items[0], readsReady: true, view: {
    contact: [["お名前", "架空 会社HP"], ["会社名", "架空工業"], ["メール", "site@example.com"]],
    body: { label: "お問い合わせの内容（原文）", text: "DXの相談をしたいです" }, fields: [["種別", "無料相談"], ["状態", "未対応"]], bookings: [],
    history: [{ at: iso(NOW - 1800000), label: "受付", kind: "event" }], owner: null, ownerNote: "担当は原本に項目がありません（担当メモはあります）",
    next: "", nextNote: "次の対応は原本に項目がありません", due: null, dueNote: "期限は原本に項目がありません",
    actions: { note: false, done: false, reopen: false, reply: false, status: { options: ["未対応", "対応中", "対応済"], current: "未対応", memo: "", updatedAt: iso(NOW - 1800000) },
      replyNote: "この問い合わせの返信は、既存の仕組みにメール送信がありません（返信はメールソフトから）" } } }),
};

async function openCtx(width, who = { roles: ["owner"], isAdmin: false }, opts = {}) {
  const ctx = await br.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, timezoneId: "Asia/Tokyo", permissions: ["clipboard-read", "clipboard-write"] });
  await ctx.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "owner@example.test" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open", "kp_view"]) localStorage.removeItem(k);
  });
  const calls = [];
  const st = { work: opts.work || workBody(), prod: opts.prod || prodBody(), failWork: Boolean(opts.failWork), count: opts.count, details: opts.details || null };
  await ctx.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    calls.push({ method: req.method(), path: url.pathname, search: url.search, body });
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (url.pathname === "/api/me") {
      return send({ email: "owner@example.test", appRole: who.roles.includes("owner") ? "owner" : "member", isAdmin: who.isAdmin, roles: [],
        gw: { employee: { id: "e1", display_name: "架空 経営者", status: "active" }, roles: who.roles, tenantId: "t1", stage: null },
        access: accessOf({ roles: who.roles, isAdmin: who.isAdmin, apps: who.apps }) });
    }
    if (url.pathname === "/api/marketing" && req.method() === "GET") {
      if (url.searchParams.get("count") === "1") return st.count === "fail" ? send({ error: "server_error" }, 500) : send(st.count || { sources: st.work.sources.map((s) => ({ key: s.key, biz: s.biz, label: s.label, state: s.state, count: s.count, newCount: s.state === "ok" ? 1 : null })) });
      if (st.failWork && !url.searchParams.get("view")) return send({ error: "server_error" }, 500);
      if (url.searchParams.get("view") === "production") return send(st.prod);
      if (url.searchParams.get("id")) {
        const [src, rid] = url.searchParams.get("id").split(":");
        return send(st.details?.[src] ? st.details[src](rid) : detailBody(rid));
      }
      if (st.failWork) return send({ error: "server_error" }, 500);
      return send(st.work);
    }
    if (url.pathname === "/api/marketing" && req.method() === "POST") {
      if (body.action === "read") return send({ ok: true, key: body.key, read: true });
      if (["space.done", "space.reopen", "space.note", "space.booking"].includes(body.action)) return send({ ok: true, result: null });
      if (body.action === "contact.update") return send({ ok: true, row: { id: body.key.split(":")[1], status: body.status, staff_memo: body.staffMemo, updated_at: iso(NOW) } });
      if (body.action === "space.mail.compose") return send({ ok: true, preview: { mailId: "ffffffff-0000-4000-8000-000000000001", to: "hanako@example.com",
        subject: "【8sp】お問い合わせありがとうございます", body: "架空 花子 様\nご案内です。", from: "8sp の送信設定（既定：Eight Space運営事務局 <notice@notify.8sp.jp>、返信先 rental@8sp.jp）" } });
      if (body.action === "space.mail.send") { await new Promise((r) => setTimeout(r, 300)); return send({ ok: true, outcome: "sent", to: "hanako@example.com" }); }
      if (body.action === "plan.update") return send({ ok: true, item: { id: body.id, version: body.version + 1 } });
      if (body.action === "video.check") return send({ ok: true, video: M.parseYouTubeUrl(body.url), oembed: { state: "embeddable", title: "架空の動画", author: "架空チャンネル", label: M.OEMBED_LABEL.embeddable }, checkedAt: iso(NOW) });
      if (body.action === "video.preview") {
        return send({ ok: true, video: M.parseYouTubeUrl(body.url), sites: body.sites.map((s) => {
          const site = M.videoSite(s.site);
          return { ...s, label: site.label, supported: false, reason: site.reason, need: site.need, confirmHash: "a".repeat(64) };
        }) });
      }
      return send({ error: "unknown_action" }, 400);
    }
    if (url.pathname === "/api/hr/applicants/mail" && req.method() === "GET") {
      return send({ applicant: { id: L1, name: "架空 1", email: "lead1@example.com" },
        templates: [{ id: "t1", name: "カジュアル面談案内", version: 2 }],
        rendered: { templateId: "t1", templateVersion: 2, templateName: "カジュアル面談案内", subject: "【無限道場】カジュアル面談のご案内", body: "架空 1 様\nお問い合わせありがとうございます。", missing: [] },
        mail: { configured: true, from: "saiyou@example.test", replyTo: "reply@example.test", reasons: [] }, sends: [] });
    }
    if (url.pathname === "/api/hr/applicants/mail" && req.method() === "POST") {
      await new Promise((r) => setTimeout(r, 300));
      return send({ status: "sent", send: { status: "sent" } });
    }
    if (url.pathname === "/api/hr/applicants/detail" && req.method() === "PATCH") return send({ ok: true });
    if (url.pathname === "/api/notifications") return send({ notifications: [], unread: 0 });
    if (url.pathname === "/api/badges") return send({ badges: {} });
    if (url.pathname === "/api/office-tasks/calendar") return send({ events: [], days: [] });
    return send({});
  });
  // 動画のプレビューは、本物の YouTube へつながない（中身の無いページを返す）
  await ctx.route(/^https:\/\/(www\.)?youtube-nocookie\.com\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>stub</title>" }));
  await ctx.route(/^https:\/\/(i\.ytimg\.com|www\.youtube\.com)\//, (route) => route.fulfill({ status: 204, body: "" }));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  return { ctx, page, calls, errs, st };
}
// 共通の枠（端末の合図など）は数えない。この画面が使う API（マーケティング・採用HR）の書き込みだけ
const writes = (calls) => calls.filter((c) => c.method !== "GET" && /^\/api\/(marketing|hr)\b/.test(c.path));
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

for (const W of [1280, 390]) {
  console.log(`\n=== ${W}px：対応が必要な業務 ===`);
  const { ctx, page, calls, errs } = await openCtx(W);
  await page.goto(`${BASE}/office/marketing.html`);
  await page.waitForSelector(".mk-item");
  check(await page.title() === "マーケティング - EIGHT OFFICE", "タイトル");
  const src = await page.$$eval("#workSources [data-source]", (xs) => xs.map((x) => [x.dataset.source, x.dataset.state]));
  check(await page.locator("#workSources [data-role=not-connected-list]").evaluate((d) => !d.open), "未連携の説明は折りたたみ（上でスクロールさせない）");
  check((await page.locator("#workSources [data-role=not-connected-list] > summary").innerText()).includes("未連携"), "未連携の件数と事業は1行で見える");
  await page.click("#workSources [data-role=not-connected-list] > summary");
  check(src.length === 6 && src.find(([k]) => k === "hr_lead")[1] === "ok" && src.filter(([, s]) => s === "forbidden").length === 4
    && src.filter(([, s]) => s === "not_connected").length === 1, `取得元：取得済み1・権限なし4・未連携1（${JSON.stringify(src)}）`);
  const spSrc = await page.locator('#workSources [data-source="space_inquiry"]').innerText();
  check(spSrc.includes("権限なし") && spSrc.includes("8sp の事務権限"), "スペースは「権限なし」と、必要な権限を出す");
  check(!spSrc.includes("0件"), "権限なしを0件と書かない");
  const chips = await page.$$eval("#bizChips button", (xs) => xs.map((x) => x.innerText.replace(/\s+/g, "")));
  check(chips.includes("無限道場2") && chips.includes("スペース—") && chips.includes("EC—"), `事業の件数：取得できない事業は「—」（${chips.join(" ")}）`);
  check(await page.locator(".mk-item").count() === 2, "初期は対応待ちだけ（2件）");
  check(await page.locator(".mk-item .mk-tag.new").count() === 1 && await page.locator(".mk-item.unread").count() === 1, "新着と未読は別の印");
  check((await page.locator("#workSum").innerText()).includes("未読 1件"), "未読の件数");
  check(!(await page.locator("#workList").innerText()).includes("@example.com"), "一覧に連絡先を出さない");
  await page.selectOption("#fState", "closed");
  check(await page.locator(".mk-item").count() === 1, "対応済みに切り替えると1件");
  await page.selectOption("#fState", "open");
  await page.selectOption("#fOwner", "unset");
  check(await page.locator(".mk-item").count() === 1, "担当：未設定で1件");
  await page.selectOption("#fOwner", "");
  await page.click('#bizChips button[data-biz="space"]');
  check((await page.locator("#workList").innerText()).includes("0件という意味ではありません") && page.url().includes("biz=space"), "スペース：読めない理由の説明（0件ではない）・URLに残る");
  await page.click('#bizChips button[data-biz=""]');

  // 詳細（開いただけでは何も書かない）
  await page.click(`.mk-item[data-key="hr_lead:${L1}"] .mk-hd`);
  await page.waitForSelector(`.mk-item[data-key="hr_lead:${L1}"] .mk-quote`);
  const body = await page.locator(`.mk-item[data-key="hr_lead:${L1}"] .mk-body`).innerText();
  check(body.includes("何から始めればよいか") && body.includes("lead1@example.com") && body.includes("<script>"), "詳細：原文（エスケープ）・連絡先");
  check(await page.locator(`.mk-item[data-key="hr_lead:${L1}"] .mk-hd`).getAttribute("aria-expanded") === "true", "開いた行は aria-expanded=true");
  check(writes(calls).length === 0, "一覧・絞り込み・詳細を開いても、書き込みの API は呼ばない");
  check(await page.locator(`.mk-item[data-key="hr_lead:${L1}"]`).evaluate((e) => e.classList.contains("unread")), "開いただけでは未読のまま");

  // 既読（押したときだけ）
  await page.click(`.mk-item[data-key="hr_lead:${L1}"] [data-act=read]`);
  await page.waitForFunction((k) => !document.querySelector(`.mk-item[data-key="${k}"]`).classList.contains("unread"), `hr_lead:${L1}`);
  const rd = writes(calls);
  check(rd.length === 1 && rd[0].body.action === "read" && rd[0].body.key === `hr_lead:${L1}`, "既読は押したときに1回");
  check((await page.locator(`.mk-item[data-key="hr_lead:${L1}"] .mk-l3`).innerText()).includes("対応中"), "既読にしても対応状態は変わらない");

  // 返信（確認してから。二度押しでも1回）
  await page.click(`.mk-item[data-key="hr_lead:${L1}"] [data-act=reply]`);
  await page.waitForSelector("[data-role=reply] #rp-subject");
  const rp = await page.locator("[data-role=reply]").innerText();
  check(rp.includes("lead1@example.com") && rp.includes("saiyou@example.test") && rp.includes("reply@example.test"), "宛先・送信元・返信先を送る前に出す");
  await page.fill("#rp-body", "架空 1 様\n直した本文です。");
  await page.click("[data-rp=confirm]");
  await page.waitForSelector(".mk-modal");
  const cf = await page.locator(".mk-modal").innerText();
  check(cf.includes("lead1@example.com") && cf.includes("saiyou@example.test") && cf.includes("カジュアル面談のご案内") && cf.includes("直した本文です"), "確認の窓：宛先・送信元・件名・本文");
  check(writes(calls).filter((c) => c.path === "/api/hr/applicants/mail").length === 0, "確認の窓を開いただけでは送らない");
  await page.locator("#mk-m-ok").dblclick();
  await page.waitForSelector("[data-role=reply-result]");
  const sends = writes(calls).filter((c) => c.path === "/api/hr/applicants/mail");
  check(sends.length === 1 && /^[A-Za-z0-9_-]{8,80}$/.test(sends[0].body.requestKey) && sends[0].body.body.includes("直した本文"), "二度押ししても送信は1回（送信の鍵つき）");
  check((await page.locator("[data-role=reply-result]").innerText()).includes("送信しました"), "送信の結果を出す");

  // 次のアクション（確認してから）
  await page.click(`.mk-item[data-key="hr_lead:${L1}"] [data-act=next]`);
  await page.selectOption("#nx-sel", "trial");
  await page.click("[data-nx=confirm]");
  await page.waitForSelector(".mk-modal");
  check((await page.locator(".mk-modal").innerText()).includes("体験案内") && (await page.locator(".mk-modal").innerText()).includes("メールは送りません"), "変更前に確認（メールは送らない）");
  await page.click("#mk-m-ok");
  await page.waitForFunction(() => !document.querySelector(".mk-modal"));
  const pt = writes(calls).filter((c) => c.path === "/api/hr/applicants/detail");
  check(pt.length === 1 && pt[0].method === "PATCH" && pt[0].body.action === "leadNextAction" && pt[0].body.nextAction === "trial", "採用HRの既存の変更（leadNextAction）を1回");
  await page.waitForSelector(`.mk-item[data-key="hr_lead:${L1}"] .mk-quote`);
  check(true, "変更のあと、開いていた行の詳細を取り直す（読み込み中のままにしない）");

  check(await noOverflow(page), `${W}px：横にはみ出さない`);
  const nav = await page.locator("text=マーケティング").first().count();
  check(nav > 0, "Office のメニューに「マーケティング」");
  await page.screenshot({ path: shotPath(`marketing-work-${W}.png`), fullPage: true });
  check(errs.length === 0, `画面のエラーなし ${errs.join(" / ")}`);
  await ctx.close();
}

console.log("\n=== 取得失敗・権限なし・既読の表が未準備 ===");
{
  const { ctx, page } = await openCtx(1280, { roles: ["owner"], isAdmin: false }, { failWork: true });
  await page.goto(`${BASE}/office/marketing.html`);
  await page.waitForSelector("[data-role=load-failed]");
  check((await page.locator("#workList").innerText()).includes("取得できませんでした") && !(await page.locator("#workList").innerText()).includes("0件"), "取得失敗は「取得できませんでした」（0件と書かない）");
  check(await page.locator("#workRetry").count() === 1, "もう一度読み込むボタン");
  await ctx.close();
}
{
  const { ctx, page } = await openCtx(1280, { roles: ["finance"], isAdmin: false, apps: ["office", "marketing"] }, { work: workBody({ hrState: "forbidden" }) });
  await page.goto(`${BASE}/office/marketing.html`);
  await page.waitForSelector("#workSources [data-source]");
  check((await page.locator('#workSources [data-source="hr_lead"]').innerText()).includes("権限なし"), "採用HRの権限が無い人には「権限なし」");
  check((await page.locator("#workList").innerText()).includes("0件という意味ではありません"), "権限なしを0件と書かない");
  await ctx.close();
}
{
  const { ctx, page } = await openCtx(1280, undefined, { work: workBody({ readsReady: false }) });
  await page.goto(`${BASE}/office/marketing.html`);
  await page.waitForSelector(".mk-item");
  check((await page.locator("#workSum").innerText()).includes("未読は確認できません"), "既読の表が未準備なら「未読は確認できません」");
  check(await page.locator(".mk-item.unread").count() === 0, "未読の印を出さない（分からないので）");
  await ctx.close();
}

for (const W of [1280, 390]) {
  console.log(`\n=== ${W}px：制作予定 ===`);
  const { ctx, page, calls, errs } = await openCtx(W);
  await page.goto(`${BASE}/office/marketing.html?tab=production`);
  await page.waitForSelector("#prodList .mk-item");
  check(await page.locator("#tab-production").getAttribute("aria-selected") === "true", "?tab=production で制作予定のタブ");
  const ps = await page.$$eval("#prodSources [data-source]", (xs) => xs.map((x) => [x.dataset.source, x.dataset.state]));
  check(ps.filter(([, s]) => s === "not_connected").length === 4 && ps.find(([k]) => k === "site_news")[1] === "ok", `制作の取得元：お知らせ取得済み・未連携4（${JSON.stringify(ps)}）`);
  check((await page.locator('#prodSources [data-source="site_news"]').innerText()).includes("30日より前の公開済み 3件は原本で"), "古い公開済みは原本で");
  check((await page.locator('.mk-item[data-key="site_news:n1"] .mk-l3').innerText()).includes("原本に項目なし"), "お知らせの担当は「原本に項目なし」");
  // SNS 文案
  await page.click('.mk-item[data-key="plan:p1"] .mk-hd');
  await page.waitForSelector('.mk-item[data-key="plan:p1"] [data-f=snsText]');
  await page.fill('.mk-item[data-key="plan:p1"] [data-f=snsText]', "あ".repeat(141));
  check(await page.locator('.mk-item[data-key="plan:p1"] [data-f=snsCount]').evaluate((e) => e.classList.contains("over") && e.textContent.startsWith("141 / 140")), "X は140文字を超えると赤");
  await page.fill('.mk-item[data-key="plan:p1"] [data-f=snsText]', "架空の告知文です");
  await page.click('.mk-item[data-key="plan:p1"] [data-pa=copy]');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(clip === "架空の告知文です", "文案をコピーできる");
  check(writes(calls).length === 0, "コピーしても何も送らない・保存しない");
  // 公開URLの記録
  await page.fill('.mk-item[data-key="plan:p1"] [data-f=publicUrl]', "http://x.example/1");
  await page.click('.mk-item[data-key="plan:p1"] [data-pa=publish]');
  check((await page.locator('.mk-item[data-key="plan:p1"] [data-f=err]').innerText()).includes("https://"), "http の URL は受けない");
  await page.fill('.mk-item[data-key="plan:p1"] [data-f=publicUrl]', "https://x.com/eight/status/1");
  await page.click('.mk-item[data-key="plan:p1"] [data-pa=publish]');
  await page.waitForSelector(".mk-modal");
  check((await page.locator(".mk-modal").innerText()).includes("記録だけです"), "記録だけ（投稿はしない）と確認");
  await page.click("#mk-m-ok");
  await page.waitForFunction(() => !document.querySelector(".mk-modal"));
  const up = writes(calls).filter((c) => c.body?.action === "plan.update");
  check(up.length === 1 && up[0].body.publicUrl === "https://x.com/eight/status/1" && up[0].body.state === "published" && up[0].body.version === 3, "公開URLと公開済みを版つきで保存");
  // YouTube
  await page.click('.mk-item[data-key="plan:p2"] .mk-hd');
  await page.waitForSelector('.mk-item[data-key="plan:p2"] [data-role=video]');
  await page.click('.mk-item[data-key="plan:p2"] [data-pa=vcheck]');
  await page.waitForSelector('.mk-item[data-key="plan:p2"] [data-role=oembed]');
  check((await page.locator('.mk-item[data-key="plan:p2"] [data-role=oembed]').innerText()).includes("限定公開かどうかは YouTube 上で確認"), "埋め込み可でも限定公開は人が確認");
  const site = page.locator('.mk-item[data-key="plan:p2"] .mk-site[data-site="site"]');
  await site.locator("[data-f=vsite]").check();
  await site.locator("[data-f=vtitle]").fill("動画で見る無限道場");
  await page.click('.mk-item[data-key="plan:p2"] [data-pa=vpreview]');
  await page.waitForSelector('.mk-item[data-key="plan:p2"] .mk-video iframe');
  const src2 = await page.locator('.mk-item[data-key="plan:p2"] .mk-video iframe').getAttribute("src");
  check(src2 === "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", `プレビューは youtube-nocookie の動画IDだけ（${src2}）`);
  check(await page.locator('.mk-item[data-key="plan:p2"] [data-pa=vplace]').isDisabled(), "未対応のサイトだけなら「確認して掲載」は押せない");
  check((await page.locator('.mk-item[data-key="plan:p2"] [data-role=vplace-off]').innerText()).includes("未対応"), "載せられない理由を出す");
  check(!writes(calls).some((c) => c.body?.action === "video.place"), "掲載は呼ばない");
  check(await noOverflow(page), `${W}px：横にはみ出さない`);
  await page.screenshot({ path: shotPath(`marketing-production-${W}.png`), fullPage: true });
  check(errs.length === 0, `画面のエラーなし ${errs.join(" / ")}`);
  await ctx.close();
}
{
  const { ctx, page } = await openCtx(1280, undefined, { prod: prodBody({ planReady: false }) });
  await page.goto(`${BASE}/office/marketing.html?tab=production`);
  await page.waitForSelector("#prodSources [data-source]");
  check(await page.locator("#newPlan").isDisabled() && (await page.locator("#planNote").innerText()).includes("未適用"), "保存先が未準備なら追加できない（理由つき）");
  await ctx.close();
}


for (const W of [1280, 390]) {
  console.log(`\n=== ${W}px：8sp・無限道場の受講申込・会社HP（原本がつながったとき） ===`);
  const { ctx, page, calls, errs } = await openCtx(W, { roles: [], isAdmin: false, apps: ["marketing"] }, { work: allBody(), details: allDetails });
  await page.goto(`${BASE}/office/marketing.html`);
  await page.waitForSelector(".mk-item");
  check(await page.locator(".mk-item").count() === 3, "3事業の問い合わせが1つの一覧に並ぶ");
  const chips = await page.$$eval("#bizChips button", (xs) => xs.map((x) => x.innerText.replace(/\s+/g, "")));
  check(chips.includes("スペース1") && chips.includes("自社サイト1") && chips.includes("EC0"), `事業ごとの件数（取得済みの EC は0件）（${chips.join(" ")}）`);
  // 8sp：詳細（送信者・本文・予約内容・予約・履歴・担当・次の対応）
  await page.click(`.mk-item[data-key="space_inquiry:${SP1}"] .mk-hd`);
  await page.waitForSelector(`.mk-item[data-key="space_inquiry:${SP1}"] [data-role=bookings]`);
  const body = await page.locator(`.mk-item[data-key="space_inquiry:${SP1}"] .mk-body`).innerText();
  check(["hanako@example.com", "プロジェクター", "2026-11-05 13:00-17:00", "12名", "仮予約", "折り返し電話する", "架空 事務", "承認するか決める"].every((t) => body.includes(t)),
    "8sp の詳細：送信者・原文・予約内容・予約・対応履歴・担当・次の対応");
  check(writes(calls).length === 0, "詳細を開いただけでは何も書かない");
  // 予約の承認（確認してから・1回だけ）
  await page.click(`.mk-item[data-key="space_inquiry:${SP1}"] [data-act=bk-approve]`);
  await page.waitForSelector(".mk-modal");
  check((await page.locator(".mk-modal").innerText()).includes("24,000円") && (await page.locator(".mk-modal").innerText()).includes("重なっている予約は 8sp が止めます"), "承認の前に、日時・人数・金額を確認");
  await page.locator("#mk-m-ok").dblclick();
  await page.waitForFunction(() => !document.querySelector(".mk-modal"));
  const bk = writes(calls).filter((c) => c.body?.action === "space.booking");
  check(bk.length === 1 && bk[0].body.decision === "approve" && bk[0].body.bookingId === BK1, "予約の承認は 8sp の処理を1回だけ");
  // 返信（8sp のメール：作る → 確認 → 送る。二度押しでも1回）
  await page.waitForSelector(`.mk-item[data-key="space_inquiry:${SP1}"] [data-act=space-reply]`);
  await page.click(`.mk-item[data-key="space_inquiry:${SP1}"] [data-act=space-reply]`);
  await page.click("[data-sr=compose]");
  await page.waitForSelector("[data-role=space-reply]");
  const rp = await page.locator("[data-role=space-reply]").innerText();
  check(rp.includes("hanako@example.com") && rp.includes("notice@notify.8sp.jp"), "宛先・送信元を送る前に出す");
  await page.click("[data-sr=confirm]");
  await page.waitForSelector(".mk-modal");
  check((await page.locator(".mk-modal").innerText()).includes("ご案内です") && (await page.locator(".mk-modal").innerText()).includes("同じ下書きは2回送れません"), "確認の窓：宛先・送信元・件名・本文");
  await page.locator("#mk-m-ok").dblclick();
  await page.waitForSelector("[data-role=space-reply-result]");
  const sends = writes(calls).filter((c) => c.body?.action === "space.mail.send");
  check(sends.length === 1 && sends[0].body.confirmed === true, "送信は1回だけ（確認済みの印つき）");
  // 対応完了（確認してから）
  await page.click(`.mk-item[data-key="space_inquiry:${SP1}"] [data-act=space-done]`);
  await page.waitForSelector(".mk-modal");
  check((await page.locator(".mk-modal").innerText()).includes("メールは送りません"), "対応完了の前に確認");
  await page.click("#mk-m-ok");
  await page.waitForFunction(() => !document.querySelector(".mk-modal"));
  check(writes(calls).some((c) => c.body?.action === "space.done"), "対応完了は 8sp の処理");
  // 無限道場の受講申込：読むだけ
  await page.click(`.mk-item[data-key="mugen_course:${CO1}"] .mk-hd`);
  await page.waitForSelector(`.mk-item[data-key="mugen_course:${CO1}"] .mk-quote`);
  const cb = await page.locator(`.mk-item[data-key="mugen_course:${CO1}"] .mk-body`).innerText();
  check(cb.includes("総務部") && cb.includes("読むだけ") && cb.includes("原本に項目がありません"), "受講申込：法人の項目・読むだけ・原本に無い項目を明示");
  check(await page.locator(`.mk-item[data-key="mugen_course:${CO1}"] [data-act=space-done], .mk-item[data-key="mugen_course:${CO1}"] [data-act=contact-edit]`).count() === 0, "受講申込には状態を変えるボタンを出さない");
  // 会社HP：状態とメモ（確認してから）
  await page.click(`.mk-item[data-key="site_contact:${QS1}"] .mk-hd`);
  await page.waitForSelector(`.mk-item[data-key="site_contact:${QS1}"] [data-act=contact-edit]`);
  check((await page.locator(`.mk-item[data-key="site_contact:${QS1}"] .mk-body`).innerText()).includes("メール送信がありません"), "返信の仕組みが無いことを出す");
  await page.click(`.mk-item[data-key="site_contact:${QS1}"] [data-act=contact-edit]`);
  await page.selectOption("#ct-st", "対応中");
  await page.fill("#ct-memo", "折り返し予定");
  await page.click("[data-ct=confirm]");
  await page.waitForSelector(".mk-modal");
  check((await page.locator(".mk-modal").innerText()).includes("未対応 → 対応中"), "変更前後を確認");
  await page.click("#mk-m-ok");
  await page.waitForFunction(() => !document.querySelector(".mk-modal"));
  const cu = writes(calls).filter((c) => c.body?.action === "contact.update");
  check(cu.length === 1 && cu[0].body.status === "対応中" && cu[0].body.expectUpdatedAt, "状態の更新は、開いたときの時刻つき（あとで変わっていたら上書きしない）");
  check(await noOverflow(page), `${W}px：横にはみ出さない`);
  await page.screenshot({ path: shotPath(`marketing-sources-${W}.png`), fullPage: true });
  check(errs.length === 0, `画面のエラーなし ${errs.join(" / ")}`);
  await ctx.close();
}

{
  console.log("\n=== マーケティングの利用権限が無い人（Office の権限だけ） ===");
  const { ctx, page, calls } = await openCtx(1280, { roles: ["finance"], isAdmin: false, apps: ["office"] });
  await page.goto(`${BASE}/office/marketing.html`);
  await page.waitForTimeout(1200);
  check(!page.url().includes("/office/marketing.html"), `Office の権限だけでは開けない（送り返される：${page.url().replace(BASE, "")}）`);
  check(!calls.some((c) => c.path === "/api/marketing"), "マーケティングの API も呼ばない");
  await ctx.close();
}

console.log("\n=== Office ホーム：今日やること ===");
{
  const { ctx, page, calls } = await openCtx(1280);
  await page.goto(`${BASE}/office/`);
  await page.waitForSelector("#todo .oh-row");
  const t = await page.locator("#todo").innerText();
  check(t.includes("無限道場：無料カウンセリング・お問い合わせ（対応待ち）") && t.includes("新着 1件"), "今日やることに無限道場の問い合わせ（新着つき）");
  check(t.includes("未連携"), "未連携の事業があることを添える");
  check(await page.locator('#todo a[href="/office/marketing.html?biz=mugen"]').count() === 1, "押すとマーケティング（無限道場）へ");
  check(!calls.some((c) => c.path === "/api/marketing" && c.method !== "GET"), "ホームは読むだけ");
  await ctx.close();
}
{
  const { ctx, page } = await openCtx(1280, undefined, { count: "fail" });
  await page.goto(`${BASE}/office/`);
  await page.waitForSelector("#todo .oh-row");
  check((await page.locator("#todo").innerText()).includes("問い合わせの件数を取得できませんでした"), "取れなかったら「取得できませんでした」（黙って消さない）");
  await ctx.close();
}

await br.close();
if (bad) { console.log(`\nNG ${bad}件`); process.exit(1); }
console.log("\nマーケティング画面：すべて通過");
