// 組み立ての画面と、WEB利用の画面を、実際に触って通す。
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const me = {
  email: "yamada@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" },
        roles: [], isAdmin: false, tenantId: "t1", stage: null },
};
const admin = {
  email: "zimu@8grp.co.jp", appRole: "admin", isAdmin: true, shows: {},
  gw: { employee: { id: "emp-0", display_name: "事務", status: "active" },
        roles: ["hr"], isAdmin: true, tenantId: "t1", stage: null },
};

const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const posted = [];
let claimed = false;
let agentArrived = false;

const WEB = {
  range: { key: "today", label: "今日", from: TODAY, to: TODAY },
  scope: "work", category: null,
  total: { seconds: 272 * 60, label: "4:32" },
  byCategory: [
    { key: "work", label: "業務", seconds: 201 * 60, text: "3:21" },
    { key: "ai", label: "AI", seconds: 42 * 60, text: "42分" },
    { key: "sns", label: "SNS", seconds: 18 * 60, text: "18分" },
    { key: "video", label: "動画", seconds: 27 * 60, text: "27分" },
    { key: "other", label: "その他", seconds: 24 * 60, text: "24分" },
  ],
  topHosts: [{ host: "mf.8grp.co.jp", seconds: 60 * 60, text: "1:00" }],
  visits: [
    { id: 1, at: `${TODAY}T09:02:00+09:00`, workDate: TODAY, seconds: 18 * 60, text: "18分",
      host: "mf.8grp.co.jp", path: "/home.html", category: "internal",
      categoryLabel: "社内システム", browser: "chrome", inWorkHours: true },
    { id: 2, at: `${TODAY}T09:25:00+09:00`, workDate: TODAY, seconds: 32 * 60, text: "32分",
      host: "chatgpt.com", path: null, category: "ai",
      categoryLabel: "AI", browser: "chrome", inWorkHours: true },
    { id: 3, at: `${TODAY}T10:20:00+09:00`, workDate: TODAY, seconds: 24 * 60, text: "24分",
      host: "youtube.com", path: null, category: "video",
      categoryLabel: "動画", browser: "edge", inWorkHours: true },
  ],
  truncated: false,
  day: {
    date: TODAY,
    work: { from: `${TODAY}T09:00:00+09:00`, to: `${TODAY}T18:00:00+09:00`,
            minutes: 540, text: "9:00" },
    usage: { firstAt: `${TODAY}T08:57:00+09:00`, lastAt: `${TODAY}T18:12:00+09:00`,
             activeMin: 314, activeText: "5:14", idleMin: 43, idleText: "0:43",
             lockedMin: 0, nightMin: 0 },
    appMin: 123, appText: "2:03", nightSec: 0,
    verdict: { key: "check", mark: "△", label: "要確認",
               note: "勤務中に SNS・動画・買い物が 0:45" },
  },
  alerts: [{ rule: "distract_in_work", severity: "warn",
             title: "勤務時間中に SNS・動画・買い物が 0:45 ありました" }],
  categories: [
    { key: "internal", label: "社内システム" }, { key: "work", label: "業務" },
    { key: "ai", label: "AI" }, { key: "sns", label: "SNS" },
    { key: "video", label: "動画" }, { key: "other", label: "その他" },
  ],
};

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

function wire(page, who) {
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => m.type() === "error"
    && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest/i.test(m.text())
    && errs.push(m.text()));

  return page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    const body = req.postData() ? JSON.parse(req.postData()) : {};

    if (/\/api\/me\b/.test(url)) return send(who);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    if (/\/api\/config/.test(url)) return send({});

    if (/\/api\/devices\/pair/.test(url)) {
      if (req.method() === "POST") {
        posted.push(body);
        if (body.claim) { claimed = true; setTimeout(() => { agentArrived = true; }, 1500); }
        return send({ ok: true, pc: { hostname: "DESKTOP-A123" }, waitSec: 60 });
      }
      return send({
        pc: { hostname: "DESKTOP-A123", os: "Windows 11",
              browsers: [{ key: "chrome", label: "Chrome" }, { key: "edge", label: "Edge" }] },
        used: false,
      });
    }
    if (/\/api\/devices\/me/.test(url)) {
      return send({
        devices: agentArrived
          ? [{ id: "ag1", source: "agent", hostname: "DESKTOP-A123", label: "DESKTOP-A123",
               confirmed: false, status: "unconfirmed", lastSeen: "たった今",
               state: { key: "waiting", label: "本人の確認待ち" } }]
          : [],
        notice: NOTICE_REAL,
      });
    }
    if (/\/api\/devices\/web/.test(url)) {
      posted.push({ url });
      const u = new URL(url);
      const cat = u.searchParams.get("category");
      const scope = u.searchParams.get("scope") || "work";
      return send({
        ...WEB, scope, category: cat,
        visits: cat ? WEB.visits.filter((v) => v.category === cat) : WEB.visits,
        range: { ...WEB.range, label: u.searchParams.get("range") === "week" ? "今週（7日）" : "今日" },
      });
    }
    if (/\/api\/devices\/policy/.test(url)) return send({ policy: {} });
    if (/\/api\/devices\?.*deviceId/.test(url)) {
      return send({
        device: { id: "ag1", label: "8GRP-PC-01", hostname: "8GRP-PC-01", source: "agent",
                  os: "Windows 11", status: "active", confirmed: true, installed: false,
                  employee: { id: "emp-1", name: "山田 太郎", department: "制作部" },
                  state: { key: "active", label: "利用中" }, linkedTo: null,
                  links: [
                    { browser: "chrome", label: "Chrome", installed: true, linked: true },
                    { browser: "edge", label: "Edge", installed: true, linked: false },
                  ] },
        usage: [], events: [], alerts: [], apps: [],
        web: [{ label: "業務系", minutes: 120, time: "2:00" }],
        browsers: [], views: [],
      });
    }
    if (/\/api\/devices/.test(url)) {
      return send({
        devices: [{ id: "ag1", label: "8GRP-PC-01", hostname: "8GRP-PC-01", source: "agent",
          os: "Windows 11", status: "active", confirmed: true, installed: false,
          lastSeen: "3分前", employee: { id: "emp-1", name: "山田 太郎", department: "制作部" },
          openAlerts: { critical: 0, warn: 0 }, state: { key: "active", label: "利用中" },
          links: [
            { browser: "chrome", label: "Chrome", installed: true, linked: true,
              lastSeen: "3分前", state: { key: "linked", label: "連携済" } },
            { browser: "edge", label: "Edge", installed: true, linked: false,
              lastSeen: "未受信", state: { key: "installed", label: "未連携" } },
          ] }],
        alerts: [], summary: { total: 1, agents: 1 }, people: [],
      });
    }
    return send({});
  });
}

// 告知の文は、作り物ではなく本物を使う。
// 写すと、片方だけ直ったときに気づけない
const { NOTICE: NOTICE_BASE, AGENT_NOTICE: AGENT_REAL, WEB_AREA } =
  await import("../../api/devices/me.js");

// WEB利用は、ブラウザ拡張をつないだ端末にだけ付く（api/devices/me.js の noticeFor）。
// ここで見ているのは会社のソフトが入ったパソコンなので、拡張もつながっている。
// 付ける・付けないの判定そのものは test/dvapitest.mjs の「告知に出すもの」で見る
const NOTICE_REAL = { ...NOTICE_BASE, areas: [...NOTICE_BASE.areas, WEB_AREA] };

const asMember = () => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "山田 太郎", shows: {}, stage: null }));
};
const asAdmin = () => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
};

// ===== 組み立て（社員が見る唯一の画面） =====
{
  posted.length = 0; claimed = false; agentArrived = false;
  const page = await br.newPage({ viewport: { width: 1100, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(asMember);
  await wire(page, me);

  console.log("— 組み立て —");
  await page.goto(`${BASE}/device-setup.html?pair=` + "t".repeat(43));
  await page.waitForTimeout(1400);

  check(!(await page.locator("#card-claim").isHidden()), "押す前の画面が出る");
  {
    const t = await page.locator("#pc").textContent();
    check(t.includes("DESKTOP-A123"), "どのパソコンか出る");
    check(t.includes("Windows 11"), "OSが出る");
    check(t.includes("Chrome") && t.includes("Edge"), "見つかったブラウザが出る");
  }
  check(await page.locator("input").count() === 0, "打ち込む欄が1つも無い（コードを打たせない）");

  await page.locator("#go").click();
  await page.waitForTimeout(900);
  {
    const c = posted.find((p) => p.claim);
    check(c, "押すとサーバへ伝わる");
    check(c && typeof c.deviceUid === "string" && c.deviceUid.length > 8,
      "このブラウザの印も渡す（1台にまとめるため）");
    check(!(await page.locator("#card-wait").isHidden()), "ソフトを待つ画面になる");
  }

  await page.waitForTimeout(5000);
  check(!(await page.locator("#card-done").isHidden()), "登録が終わると完了になる");
  check(await page.locator("#next").getAttribute("href") === "device-consent.html",
    "最後に「記録すること」へ送る（読むまで記録は始まらない）");

  await page.screenshot({ path: shotPath("setup-done.png") });
  await page.close();
}

// ===== 管理画面：1台1行 =====
{
  const page = await br.newPage({ viewport: { width: 1500, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(asAdmin);
  await wire(page, admin);
  page.on("dialog", (d) => d.accept());

  console.log("\n— 1台を1行に —");
  await page.goto(`${BASE}/admin-devices.html`);
  await page.waitForTimeout(1500);
  await page.click("#t-list");
  await page.waitForTimeout(300);

  check(await page.locator("#d-rows tr").count() === 1, "同じPCが1行にまとまる");
  {
    // 一覧は1台1行。Agent と Browser が ○△× で分かる
    const t = await page.locator("#d-rows tr").first().innerText();
    check(t.includes("8GRP-PC-01"), "パソコン名");
    check(/[○×]/.test(t), "Agent の状態が印で出る");
    // Chrome はつながっていて Edge は未連携。まとめて △
    check(t.includes("未連携"), "つながっていないブラウザがあると分かる");
  }
  check(await page.locator("#d-rows .dv-mk").count() >= 2, "それぞれに印が付く");

  console.log("\n— 1台を開く —");
  await page.locator("#d-rows tr").first().click();
  await page.waitForTimeout(1200);
  {
    // 詳細の頭に、Agent と各ブラウザの状態が並ぶ
    const h = await page.locator(".dv-dhead").innerText();
    check(/Agent/.test(h), "Agent の状態");
    check(h.includes("Chrome"), "Chrome の状態");
    check(h.includes("Edge") && h.includes("未連携"), "Edge は入っているが未連携");
    check(await page.locator(".dv-dhead .dv-mk.ok").count() >= 2, "つながっているものは緑");
    check(await page.locator(".dv-dhead .dv-mk.warn").count() >= 1, "未連携は黄");
  }

  console.log("\n— WEB利用 —");
  await page.locator("#dt-tabs button", { hasText: "WEB" }).click();
  await page.waitForTimeout(300);
  check(await page.locator("button:has-text('いつ・どのサイトを見たか')").count() === 1,
    "その人を開くと出る");
  check((await page.locator("#dt-body").textContent()).includes("山田 太郎 さんの画面に残ります"),
    "開くと本人に残ることを、押す前に書く");

  await page.locator("button:has-text('いつ・どのサイトを見たか')").click();
  await page.waitForTimeout(1400);
  {
    const t = await page.locator("#d-web").textContent();
    check(t.includes("WEB利用") && t.includes("4:32"), "その期間の合計が出る");
    check(t.includes("業務") && t.includes("3:21"), "カテゴリごとに出る");
    check(t.includes("AI") && t.includes("42分"), "AI も分かれて出る");
    check(t.includes("勤務") && t.includes("9:00"), "勤務時間が出る");
    check(t.includes("PC稼働") && t.includes("5:14"), "PC稼働が出る");
    check(t.includes("アプリ利用") && t.includes("2:03"), "アプリ利用が出る");
    check(t.includes("離席") && t.includes("0:43"), "離席が出る");
    check(t.includes("要確認"), "○△× の判定が出る");
    check(t.includes("「不正」の判定ではありません"), "不正とは判定しないと明記する");
  }
  check(await page.locator(".dv-mark.check").count() === 1, "△ の印が出る");

  console.log("\n— 履歴 —");
  {
    const t = await page.locator("#d-web .kp-items").textContent();
    check(t.includes("mf.8grp.co.jp") && t.includes("/home.html"), "ドメインとページの場所");
    check(t.includes("09:02"), "時刻");
    check(t.includes("18分"), "見ていた時間");
    check(t.includes("chrome") && t.includes("edge"), "どのブラウザで見たか");
  }

  console.log("\n— 絞り込み —");
  posted.length = 0;
  await page.locator("#d-web .dv-cat:has-text('AI')").click();
  await page.waitForTimeout(1000);
  check(posted.some((p) => p.url && p.url.includes("category=ai")), "カテゴリで絞れる");
  check((await page.locator("#d-web .kp-items").textContent()).includes("chatgpt.com"),
    "絞った結果が出る");
  check((await page.locator("#d-web").textContent()).includes("4:32"),
    "絞っても合計は動かない");

  posted.length = 0;
  await page.locator("#d-web .dv-tab:has-text('今週')").click();
  await page.waitForTimeout(900);
  check(posted.some((p) => p.url && p.url.includes("range=week")), "期間を変えられる");

  posted.length = 0;
  await page.locator("#d-web .dv-tab:has-text('時間外も含む')").click();
  await page.waitForTimeout(900);
  check(posted.some((p) => p.url && p.url.includes("scope=all")), "時間外も見られる");
  check((await page.locator("#d-web").textContent()).includes("勤務時間内」で見てください"),
    "時間外を見ているときは、そう書く");

  await page.screenshot({ path: shotPath("web-tab.png"), fullPage: true });

  await page.locator("#d-web button:has-text('閉じる')").click();
  await page.waitForTimeout(400);
  check((await page.locator("#d-web").innerHTML()).trim() === "", "閉じられる");
  await page.close();
}

// ===== 本人にも、取っていることが書いてある =====
{
  const page = await br.newPage({ viewport: { width: 1000, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(asMember);
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(me);
    if (/\/api\/devices\/me/.test(url)) {
      return send({
        devices: [{ id: "ag1", source: "agent", hostname: "PC1", label: "PC1",
                    confirmed: true, status: "active", lastSeen: "3分前",
                    state: { key: "active", label: "利用中" } }],
        notice: NOTICE_REAL,
        agentNotice: AGENT_REAL,
        views: [],
      });
    }
    return send({ notifications: [], unread: 0, badges: {} });
  });

  console.log("\n— 本人への告知 —");
  await page.goto(`${BASE}/device-consent.html`);
  await page.waitForTimeout(1400);
  {
    // 記録する内容の説明は、この画面から全部外した（依頼）。
    // 伝えるのは、管理部が送るお知らせのほう（docs/device-announce.md）。
    const all = await page.locator("body").innerText();
    check(!all.includes("記録する範囲"), "説明は画面に出さない");
    check(!all.includes("内容を確認しました"),
      "見せていない内容を「確認しました」と書かせない");

    // 文そのものは残っている（マイページと、送るお知らせが使う）。
    // 何を捨てるかという「削り方」は、社員向けには出さない（避け方になる）。
    // 出すのは「何を記録するか」と「いつのぶんを見るか」
    const an = [AGENT_REAL.lead, AGENT_REAL.scope, AGENT_REAL.yours].join(" ");
    check(an.includes("利用状況を記録します"), "何を記録するかを書く");
    check(an.includes("勤務時間内のぶん"), "勤務時間内が対象だと書く");
    check(an.includes("あなたの画面に残ります"), "見られたら分かると書く");
  }
  await page.close();
}

await br.close();
if (errs.length) { console.log("\n画面のエラー:"); for (const e of new Set(errs)) console.log("  -", e); bad += new Set(errs).size; }
console.log(bad ? `\nNG ${bad} 件` : "\nすべて通過");
process.exit(bad ? 1 : 0);
