// 端末管理。実際の画面で通す
import { launch, BASE } from "../_browser.mjs";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { shotPath } from "../_shot.mjs";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(_HERE));
const atRoot = (p) => _join(ROOT, p);

const meAdmin = { email: "zimu@8grp.co.jp", appRole: "admin", shows: {},
  gw: { employee: { id: "emp-0", display_name: "事務", status: "active" },
        roles: ["hr"], isAdmin: true, tenantId: "t1", stage: null } };
const meMember = { email: "yamada@8grp.co.jp", appRole: "member", shows: {},
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" },
        roles: [], isAdmin: false, tenantId: "t1", stage: null } };

const now = Date.now();
const ago = (min) => new Date(now - min * 60000).toISOString();

const LIST = {
  devices: [
    { id: "ag1", label: "8GRP-PC-01", hostname: "8GRP-PC-01", source: "agent",
      os: "Windows 11", agentVersion: "1.2.0", serial: "ABC123",
      status: "active", confirmed: true, installed: false,
      notifiedAt: "2026-09-01T00:00:00Z", lastSeenAt: ago(3), lastSeen: "3分前",
      employee: { id: "emp-1", name: "山田 太郎", department: "制作部" },
      browsers: [{ id: "d1", label: "Windows 11 の Chrome", browser: "Chrome",
                   confirmed: true, lastSeen: "3分前" }],
      openAlerts: { critical: 1, warn: 0 }, state: { key: "critical", label: "重大" } },
    { id: "d1", label: "Windows 11 の Chrome", source: "browser", os: "Windows 11", browser: "Chrome",
      screen: "1920x1080", status: "active", confirmed: true, installed: true,
      notifiedAt: "2026-09-01T00:00:00Z", lastSeenAt: ago(3), lastSeen: "3分前",
      employee: { id: "emp-1", name: "山田 太郎", department: "制作部" },
      openAlerts: { critical: 0, warn: 1 }, state: { key: "warn", label: "要確認" } },
    { id: "d2", label: "macOS の Safari", source: "browser", os: "macOS", browser: "Safari",
      status: "unconfirmed", confirmed: false, installed: false,
      notifiedAt: null, lastSeenAt: ago(20), lastSeen: "20分前",
      employee: { id: "emp-2", name: "鈴木 花子", department: "営業部" },
      openAlerts: { critical: 0, warn: 0 },
      state: { key: "waiting", label: "本人の確認待ち",
               note: "確認するまで、この端末の利用時間は数えていません" } },
    { id: "ag2", label: "8GRP-PC-99", hostname: "8GRP-PC-99", source: "agent",
      os: "Windows 11", agentVersion: "1.2.0",
      status: "active", confirmed: true, installed: false,
      notifiedAt: "2026-09-01T00:00:00Z", lastSeenAt: ago(60 * 30), lastSeen: "1日前",
      employee: { id: "emp-2", name: "鈴木 花子", department: "営業部" },
      openAlerts: { critical: 0, warn: 1 },
      state: { key: "silent", label: "未通信",
               note: "24時間以上、このパソコンから届いていません。ソフトが止まっているか…" } },
    { id: "d3", label: "Windows の Edge", source: "browser", os: "Windows", browser: "Edge",
      status: "active", confirmed: true, installed: false,
      notifiedAt: "2026-06-01T00:00:00Z", lastSeenAt: ago(60 * 24 * 90), lastSeen: "90日前",
      employee: null, openAlerts: { critical: 0, warn: 0 },
      state: { key: "stale", label: "使われていない",
               note: "60日以上、この端末からの利用がありません" } },
  ],
  alerts: [
    { id: "a0", severity: "critical", severityLabel: "重大", rule: "unapproved_software",
      ruleLabel: "未承認のソフト",
      title: "未承認のソフト「TeamViewer 15」がインストールされました",
      occurredAt: ago(60), label: "8GRP-PC-01", employee: { name: "山田 太郎" } },
    { id: "a1", severity: "warn", severityLabel: "要確認", rule: "unknown_device",
      title: "見慣れない端末から社内システムに入りました（iOS の Safari）",
      occurredAt: ago(120), label: "iOS の Safari", employee: { name: "山田 太郎" } },
    { id: "a2", severity: "warn", severityLabel: "要確認", rule: "night_access",
      title: "深夜に社内システムを 1:30 使っていました", occurredAt: ago(600),
      label: "Windows 11 の Chrome", employee: { name: "山田 太郎" } },
  ],
  summary: { total: 5, agents: 2, active: 4, waiting: 1, stale: 1, silent: 1, unknown: 1 },
  people: [{ id: "emp-1", name: "山田 太郎", department: "制作部" },
           { id: "emp-2", name: "鈴木 花子", department: "営業部" }],
};

const DETAIL = {
  device: { id: "ag1", label: "8GRP-PC-01", hostname: "8GRP-PC-01", source: "agent",
    os: "Windows 11", osBuild: "22631", serial: "ABC123", agentVersion: "1.2.0",
    status: "active", note: "2026/4 貸与",
    confirmed: true, notifiedAt: "2026-09-01T00:00:00Z", installed: false,
    firstSeenAt: "2026-04-01T00:00:00Z", lastSeenAt: ago(3), lastSeen: "3分前",
    employee: { id: "emp-1", name: "山田 太郎", department: "制作部" },
    linkedTo: null,
    adminTouchedAt: ago(120), adminTouchedBy: "事務", adminTouchedWhat: "assign",
    state: { key: "warn", label: "要確認" } },
  apps: [
    { exeName: "EXCEL.EXE", product: "Microsoft Excel", minutes: 160, label: "2:40" },
    { exeName: "chrome.exe", product: "Google Chrome", minutes: 320, label: "5:20" },
  ],
  web: [
    { category: "work", label: "業務", minutes: 125, time: "2:05" },
    { category: "sns", label: "SNS", minutes: 22, time: "0:22" },
  ],
  browsers: [{ id: "d1", label: "Windows 11 の Chrome", browser: "Chrome",
               confirmed: true, lastSeen: "3分前" }],
  range: { from: "2026-08-11", to: "2026-09-09" },
  usage: [
    { date: "2026-09-09", activeMin: 372, idleMin: 58, nightMin: 0, holidayMin: 0, beats: 80,
      active: "6:12", idle: "0:58", night: "0:00",
      firstAt: "2026-09-08T23:55:00Z", lastAt: "2026-09-09T09:30:00Z" },
    { date: "2026-09-08", activeMin: 410, idleMin: 40, nightMin: 90, holidayMin: 0, beats: 90,
      active: "6:50", idle: "0:40", night: "1:30",
      firstAt: "2026-09-07T23:50:00Z", lastAt: "2026-09-08T15:20:00Z" },
  ],
  events: [
    { id: "e0", at: ago(10), date: "2026-09-09", kind: "usb_attach",
      label: "USB接続", detail: { class: "mass_storage", vid: "SanDisk", label: "Cruzer" } },
    { id: "e1", at: ago(30), date: "2026-09-09", kind: "confirmed",
      label: "本人がこの端末だと確認しました", detail: {} },
    { id: "e2", at: ago(400), date: "2026-09-09", kind: "first_seen",
      label: "はじめてこの端末から使いました", detail: {} },
  ],
  alerts: [],
};

const ENROLLMENTS = {
  enrollments: [
    { id: "e1", issuedBy: "事務", issuedAt: ago(60 * 24 * 3),
      forWhom: "山田 太郎", expiresAt: ago(-60 * 24 * 4),
      usedAt: ago(60 * 24 * 2), usedBy: "8GRP-PC-01", usedDeviceId: "ag1",
      revokedAt: null, revokedBy: null, state: { key: "used", label: "使用済み" } },
    { id: "e2", issuedBy: "事務", issuedAt: ago(60),
      forWhom: null, expiresAt: ago(-60 * 24),
      usedAt: null, usedBy: null, revokedAt: null, revokedBy: null,
      state: { key: "open", label: "使えます" } },
  ],
  tokenDays: [1, 3, 7, 30],
};

const POLICY = {
  policy: { night_from: "22:00", night_to: "05:00", unknown_alert: true, night_alert: true,
    usb_alert: true, blocked_software: ["teamviewer"], site_categories: {},
    night_min_minutes: 60, holiday_min_minutes: 120, stale_days: 60,
    idle_after_min: 5, send_interval_sec: 300,
    keep_events_days: 400, keep_daily_months: 13 },
  defaultSites: {}, categories: [],
};

// 文言は本物から取る。写しをここに置くと、片方だけ直って気づけなくなる
const { NOTICE: NOTICE_BASE, AGENT_NOTICE } = await import(atRoot("api/devices/me.js"));
const NOTICE = { ...NOTICE_BASE, scope: "この画面だけの場合、対象は社内システムを開いているあいだです。" };

const MY_UID = "TESTuid0123456789ab";

let mine = {
  notice: NOTICE,
  agentNotice: null,
  range: { from: "2026-08-27", to: "2026-09-09" },
  beatSec: 300,
  devices: [
    { id: "d9", uid: MY_UID, label: "Windows 11 の Chrome", os: "Windows 11",
      browser: "Chrome", screen: "1920x1080", status: "unconfirmed",
      confirmed: false, installed: false, lastSeen: "たった今",
      firstSeenAt: ago(1), state: { key: "waiting", label: "本人の確認待ち" } },
    { id: "d8", uid: "OTHERuid0123456789", label: "iPhone の Safari", os: "iOS",
      browser: "Safari", status: "active", confirmed: true, installed: false,
      lastSeen: "2日前", firstSeenAt: ago(9000), state: { key: "ok", label: "正常" } },
  ],
  usage: [{ date: "2026-09-09", activeMin: 372, nightMin: 0, holidayMin: 0, active: "6:12" }],
  events: [],
  views: [{ at: ago(240), who: "事務", what: "端末の記録" }],
};

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const sent = [];

function wire(page, me) {
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => m.type() === "error"
    && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest/i.test(m.text()) && errs.push(m.text()));
  return page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    const body = req.postData() ? JSON.parse(req.postData()) : {};

    if (/\/api\/devices\/me/.test(url) && req.method() === "POST") {
      sent.push(body);
      if (body.action === "beat") return send({ ok: true, deviceUid: body.deviceUid || MY_UID, confirmed: false });
      if (body.action === "confirm") {
        mine.devices = mine.devices.map((d) =>
          (d.uid === body.deviceUid || d.id === body.deviceId)
            ? { ...d, confirmed: true, status: "active" } : d);
        return send({ ok: true });
      }
      if (body.action === "link") {
        if (body.linkCode !== "GOODCODE") {
          return route.fulfill({ status: 400, contentType: "application/json",
            body: JSON.stringify({ error: "invalid_link", message: "この案内は使えません" }) });
        }
        mine.agentNotice = AGENT_NOTICE;
        mine.devices = [{
          id: "ag9", uid: "agent-uid-9", source: "agent",
          label: "8GRP-PC-77", hostname: "8GRP-PC-77", os: "Windows 11",
          agentVersion: "1.2.0", status: "unconfirmed", confirmed: false,
          installed: false, lastSeen: "未受信", firstSeenAt: ago(1),
          state: { key: "waiting", label: "本人の確認待ち" },
        }, ...mine.devices];
        return send({ ok: true, device: { id: "ag9", hostname: "8GRP-PC-77", confirmed: false } });
      }
      if (body.action === "rename") {
        mine.devices = mine.devices.map((d) =>
          d.uid === body.deviceUid ? { ...d, label: body.label } : d);
        return send({ ok: true });
      }
      if (body.action === "forget") {
        mine.devices = mine.devices.filter((d) =>
          d.uid !== body.deviceUid && d.id !== body.deviceId);
        return send({ ok: true });
      }
      return send({ ok: true });
    }
    if (req.method() === "PATCH") {
      sent.push({ url, ...body });
      if (body.action === "issue_token") {
        return send({ token: "ABCD-2345-KMNP", expiresAt: null });
      }
      if (/policy/.test(url)) return send(POLICY);
      return send({ ok: true });
    }

    if (/\/api\/me\b/.test(url)) return send(me);
    if (/\/api\/devices\/me/.test(url)) return send(mine);
    if (/\/api\/devices\/alerts/.test(url)) return send({ alerts: LIST.alerts.map((a) => ({ ...a, status: "open" })) });
    if (/\/api\/devices\?.*enrollments/.test(url)) return send(ENROLLMENTS);
    if (/\/api\/devices\/policy/.test(url)) return send(POLICY);
    if (/\/api\/devices\?.*deviceId/.test(url)) return send(DETAIL);
    if (/\/api\/devices/.test(url)) return send(LIST);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
}

// ===== 管理側 =====
{
  const page = await br.newPage({ viewport: { width: 1400, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  await wire(page, meAdmin);
  page.on("dialog", (d) => d.accept("テストのため"));

  await page.goto(`${BASE}/admin-devices.html`);
  await page.waitForTimeout(1500);

  // 一覧そのもの（登録済みだけを1台1行で出す・要確認は別）は
  // test/ui/dvui.mjs が見る。ここでは、開けることだけ確かめる
  console.log("— 一覧 —");
  check((await page.locator("#d-rows tr").count()) > 0, "一覧が出る");
  check((await page.locator("#d-rows").textContent()).includes("8GRP-PC-01"),
    "登録済みのパソコンが出る");

  console.log("— 取らないものを書く —");
  {
    const t = await page.locator(".dv-note").textContent();
    check(t.includes("2通りの載り方"), "載り方が2つあると書いてある");
    check(t.includes("キーボードで打った内容") && t.includes("パスワード"), "取らないものが並ぶ");
    check(t.includes("開いていた画面のタイトル") && t.includes("ページの中身"),
      "エージェントでも取らないものを明記する");
    // 057 でドメインとページの場所まで取るようになった。
    // 取ることを書かずに「取らない」だけ並べる案内にしない
    check(t.includes("ドメインとページの場所"), "取るようになったものを、書いてある");
    check(t.includes("検索したことば"), "検索語は捨てると書いてある");
    check(t.includes("勤務時間内"), "働き方を見るのは勤務時間内だけと書いてある");
    check(t.includes("周知が記録されるまで、記録は始まりません"), "収集の前提");
    // 端末管理は会社ルール。管理者がそう理解していないと、説明がぶれる
    check(t.includes("端末管理は会社ルールです"), "同意ではなく会社ルールだと書いてある");
    check(t.includes("社員が解除することはできません"), "解除できないことも書いてある");
    check(t.includes("業務は原則、会社貸与PCだけです"), "私物PCの扱いが書いてある");
    check(t.includes("社員には大分類だけを伝えます"),
      "この画面の説明は管理者向けだと、管理者に分かるようにしてある");
    check(t.includes("本人の画面に残ります"), "見たことが本人に残る");
  }

  console.log("— エージェントの1台を開く —");
  await page.locator("#d-rows tr:has-text('8GRP-PC-01')").click();
  await page.waitForTimeout(900);
  {
    // 頭には、その場で知りたいことだけ
    const h = await page.locator(".dv-dhead").textContent();
    check(h.includes("8GRP-PC-01"), "パソコン名");
    check(h.includes("Agent"), "Agent の状態");

    // 中身はタブの中。縦に全部積まない
    const pane = async (name) => {
      await page.locator("#dt-tabs button", { hasText: name }).click();
      await page.waitForTimeout(200);
      return page.locator("#dt-body").textContent();
    };

    const sum = await pane("概要");
    check(sum.includes("v1.2.0"), "エージェントの版");
    check(sum.includes("ABC123"), "製造番号（貸与品台帳と突き合わせられる）");

    const use = await pane("利用状況");
    check(use.includes("6:12"), "その日の稼働");
    check(use.includes("0:58"), "離席（エージェントだけが測れる）");
    check(use.includes("1:30"), "深夜の時間");

    const app = await pane("アプリ");
    check(app.includes("EXCEL.EXE") && app.includes("chrome.exe"), "使ったソフト");

    const web = await pane("WEB");
    check(web.includes("業務") && web.includes("SNS"), "サイトは種類だけ");

    const sec = await pane("セキュリティ");
    check(sec.includes("USB接続") && sec.includes("USBメモリ"), "USBが読める言葉で出る");
    check(sec.includes("Chrome"), "同じPCのブラウザが、その中に出る");

    await pane("概要");
  }
  await page.screenshot({ path: path: shotPath("dv2-admin.png"), fullPage: true });

  // 社員はログインしているので、誰なのかはもう分かっている。
  // コードを配って打たせるのは、配る手間と打ち間違いを足しているだけ
  console.log("— 登録コードは廃止 —");
  check(await page.locator("button:has-text('登録コードを出す')").count() === 0,
    "発行するボタンが無い");
  check(await page.locator("#t-codes").count() === 0, "登録コードのタブが無い");
  {
    const tabs = await page.locator(".dv-tabs button, .kp-subtab, [id^='t-']").allTextContents();
    check(!tabs.some((t) => t.includes("登録コード")), "タブのどこにも出てこない");
  }
  check((await page.locator("#d-about").textContent()).length > 100,
    "端末管理の説明は「端末管理について」に入っている");

  console.log("— 使う人を変えると、確認はやり直し —");
  sent.length = 0;
  await page.click("#ops-btn");
  await page.locator("#ops-menu button:has-text('使う人を変える')").click();
  await page.waitForTimeout(400);
  check(await page.locator("#d-assign select").count() === 1, "名前を打たせず、名簿から選ばせる");
  check((await page.locator("#d-assign").textContent()).includes("本人の確認はやり直し"),
    "やり直しになると、押す前に書いてある");
  await page.locator("#d-assign select").selectOption("emp-2");
  await page.locator("#d-assign button:has-text('変更する')").click();
  await page.waitForTimeout(800);
  check(sent.some((p) => p.action === "assign" && p.employeeId === "emp-2"), "選んだ人を送る");

  console.log("— 未通信がひと目で分かる —");
  {
    const t = await page.locator("#d-rows").textContent();
    check(t.includes("未通信"), "未通信と出る");
    // 「何が起きているか」は要確認タブで、次の行動と一緒に出す
    await page.click("#t-check");
    await page.waitForTimeout(300);
    check((await page.locator("#c-rows").textContent())
      .includes("ソフトが止まっているかもしれません"), "何が起きているか添える");
    await page.click("#t-list");
    await page.waitForTimeout(200);
  }
  check((await page.locator("#d-rows tr").first().textContent()).includes("8GRP-PC-99"),
    "未通信の端末が、いちばん上に出る");
  check((await page.locator("#d-sum").textContent()).includes("未通信"), "サマリにも出る");

  // 絞り込みのチップは廃止。手を打つものは「要確認」に集めてある
  await page.click("#t-check");
  await page.waitForTimeout(400);
  check((await page.locator("#c-rows").textContent()).includes("8GRP-PC-99"),
    "未通信は要確認に出る");
  check((await page.locator("#t-check").textContent()).match(/\d/), "タブに件数が出る");
  await page.click("#t-list");
  await page.waitForTimeout(300);

  console.log("— 紐付け解除 —");
  await page.locator("#d-rows tr:has-text('8GRP-PC-01')").click();
  await page.waitForTimeout(900);
  sent.length = 0;
  await page.click("#ops-btn");
  check(await page.locator("#ops-menu button:has-text('紐付けを解除')").count() === 1,
    "ブラウザが繋がっている端末には、外すボタンが出る");
  await page.locator("#ops-menu button:has-text('紐付けを解除')").click();
  await page.waitForTimeout(800);
  check(sent.some((p) => p.action === "unlink" && p.deviceId === "ag1"), "解除を送る");
  check((await page.locator("#d-detail").textContent()).includes("管理者の操作"),
    "誰がいつ何をしたかが、その端末の画面に出る");
  check((await page.locator("#d-detail").textContent()).includes("使う人を変えた"),
    "操作の中身が読める言葉で出る");

  console.log("— アラート —");
  await page.locator("#t-alerts").click();
  await page.waitForTimeout(900);
  {
    const t = await page.locator("#a-rows").textContent();
    check(t.includes("見慣れない端末"), "見慣れない端末");
    check(t.includes("深夜に社内システム"), "深夜の利用");
  }
  check((await page.locator("#p-alerts").textContent()).includes("働きすぎに気づくため"),
    "何のために出しているかが書いてある");

  sent.length = 0;
  await page.locator("#a-rows button:has-text('問題なし')").first().click();
  await page.waitForTimeout(700);
  check(sent.some((p) => p.action === "ignore" && p.note), "「問題なし」は理由を付けて残す");

  // 発行の画面はまるごと無くなった。
  // 過去に出したコードの記録は、監査のため DB に残してある
  console.log("— 管理画面のタブ —");
  {
    const tabs = [];
    for (const id of ["t-list", "t-check", "t-alerts", "t-exceptions", "t-codes", "t-policy"]) {
      if (await page.locator(`#${id}`).count()) tabs.push(await page.locator(`#${id}`).textContent());
    }
    check(tabs.length === 5, `タブは5つ（いま ${tabs.length}）`);
    check(tabs.some((t) => t.includes("登録済み")), "登録済み");
    check(tabs.some((t) => t.includes("要確認")), "要確認");
    check(tabs.some((t) => t.includes("アラート")), "アラート");
    check(tabs.some((t) => t.includes("私物PCの承認")), "私物PCの承認");
    check(tabs.some((t) => t.includes("設定")), "設定");
    check(!tabs.some((t) => t.includes("登録コード")), "登録コードは無い");
  }

  console.log("— 設定 —");
  await page.locator("#t-policy").click();
  await page.waitForTimeout(900);
  check(await page.locator("#p-unknown").isChecked(), "見慣れない端末の通知が入っている");
  check(await page.locator("#p-usb").isChecked(), "USBの通知が入っている");
  check(await page.locator("#p-nmin").inputValue() === "60", "深夜の閾値が出る");
  check(await page.locator("#p-stale").inputValue() === "60", "使われていないと判断する日数が出る");
  check((await page.locator("#p-sw").textContent()).includes("teamviewer"), "禁止ソフトが出る");

  await page.locator("#p-sw-new").fill("anydesk");
  await page.locator("button:has-text('追加')").click();
  await page.waitForTimeout(300);
  check((await page.locator("#p-sw").textContent()).includes("anydesk"), "その場で足せる");

  sent.length = 0;
  await page.locator("#p-stale").fill("30");
  await page.locator("button:has-text('保存')").click();
  await page.waitForTimeout(900);
  check(sent.some((p) => String(p.staleDays) === "30"), "保存で送られる");
  check(sent.some((p) => (p.blockedSoftware || []).includes("anydesk")), "禁止ソフトも送られる");
  await page.screenshot({ path: path: shotPath("dv2-policy.png"), fullPage: true });
  await page.close();
}

// ===== 本人側 =====
{
  const page = await br.newPage({ viewport: { width: 1100, height: 1200 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript((uid) => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "y@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "山田 太郎", shows: {}, stage: null }));
    localStorage.setItem("kp_device_uid", uid);
  }, MY_UID);
  await wire(page, meMember);
  page.on("dialog", (d) => d.accept("事務所のノート"));

  console.log("— 端末の画面 —");
  sent.length = 0;
  await page.goto(`${BASE}/device-consent.html`);
  await page.waitForTimeout(1500);

  check(sent.some((p) => p.action === "beat"), "開いた時点で合図を送る");
  check(sent.find((p) => p.action === "beat")?.deviceUid === MY_UID,
    "この端末の印を送る（前に置いたものを使う）");
  {
    const beat = sent.find((p) => p.action === "beat");
    const keys = Object.keys(beat.hints || {});
    check(!keys.some((k) => /url|page|path|title/i.test(k)),
      "どの画面を見ていたかは送らない");
  }
  {
    // 社員向けは大分類だけ。しきい値や技術仕様は出さない
    const t = await page.locator("#c-areas").textContent();
    for (const a of ["端末の利用状況", "アプリケーションの利用状況", "WEBの利用状況",
                     "外部機器の接続状況", "ソフトウェアの変更状況", "セキュリティ上必要な端末情報"]) {
      check(t.includes(a), `大分類が出る: ${a}`);
    }
    const all = await page.locator("body").innerText();
    check(!/90分|しきい値|Cookie/.test(all), "しきい値・技術仕様は出さない");
    check(!/監視/.test(all), "「監視」は使わない");
    check(all.includes("同意を求めるものではありません"), "同意ではなく周知だと書いてある");
    check(all.includes("私物PCでの業務利用は禁止します"), "私物PCの扱いが出る");
  }
  check((await page.locator("#c-scope").textContent()).includes("社内システムを開いているあいだ"),
    "常駐ソフトが無いときの範囲が本人にも出る");
  check((await page.locator("#c-this").textContent()).includes("Windows 11 の Chrome"),
    "いま使っている端末が分かる");
  check(await page.locator("#c-this button:has-text('内容を確認しました')").count() === 1,
    "まだの端末には押すところがある");
  check((await page.locator("#c-devs").textContent()).includes("iPhone の Safari"),
    "ほかの端末も出る");
  check((await page.locator("#c-install").textContent()).length > 10,
    "アプリとして入れる案内が出る");
  await page.screenshot({ path: path: shotPath("dv2-consent.png"), fullPage: true });

  sent.length = 0;
  await page.locator("#c-this button:has-text('内容を確認しました')").click();
  await page.waitForTimeout(1000);
  check(sent.some((p) => p.action === "confirm" && p.deviceUid === MY_UID),
    "押すと周知の確認として送られる");
  check(await page.locator("#c-this button:has-text('内容を確認しました')").count() === 0,
    "押したあとはボタンが消える");
  check((await page.locator("#c-this").textContent()).includes("確認済み"), "確認済みになる");

  console.log("— 名前を変える・外す —");
  sent.length = 0;
  await page.locator("#c-this button:has-text('名前を変える')").click();
  await page.waitForTimeout(900);
  check(sent.some((p) => p.action === "rename" && p.label === "事務所のノート"),
    "名前を変えられる");
  check((await page.locator("#c-this").textContent()).includes("事務所のノート"),
    "変えた名前がその場で出る");

  // 端末管理は会社ルール。本人が外して解除できる仕組みは作らない
  check(await page.locator("#c-devs button:has-text('外す')").count() === 0,
    "本人が端末を外すところは無い");
  check((await page.locator("body").innerText()).includes("管理者が台帳から外します"),
    "誰が外すのかを書いてある");

  console.log("— エージェントの案内から開いたとき —");
  sent.length = 0;
  await page.goto(`${BASE}/device-consent.html?link=GOODCODE`);
  await page.waitForTimeout(1600);
  check(sent.some((p) => p.action === "link" && p.linkCode === "GOODCODE"),
    "案内の合言葉を送る");
  check(sent.some((p) => p.action === "link" && p.deviceUid === MY_UID),
    "いま開いているブラウザの印も一緒に送る");
  check((await page.locator("#c-linked").textContent()).includes("8GRP-PC-77"),
    "つないだパソコンの名前が出る");
  check(!page.url().includes("link="), "合言葉はURLから消す（読み込み直しで2回投げない）");
  check(!(await page.locator("#c-agentcard").getAttribute("class")).includes("hidden"),
    "会社のソフトの欄が出る");
  check((await page.locator("#c-agent").textContent()).includes("8GRP-PC-77"),
    "そのパソコンが出る");
  check(await page.locator("#c-agent button:has-text('内容を確認しました')").count() === 1,
    "確認するところがある");
  {
    const t = await page.locator("#c-agentnotice").textContent();
    check(t.includes("このパソコンを使っているあいだ"), "対象が広がることが出る");
    check(t.includes("原則として勤務時間内"), "勤務時間の内と外が出る");
    check(!/90分|Cookie|しきい値/.test(t), "判定のしかたは出さない");
  }
  await page.screenshot({ path: path: shotPath("dv2-linked.png"), fullPage: true });

  sent.length = 0;
  await page.locator("#c-agent button:has-text('内容を確認しました')").click();
  await page.waitForTimeout(1000);
  check(sent.some((p) => p.action === "confirm" && p.deviceId === "ag9"),
    "パソコンのほうは id で確認する");
  check(await page.locator("#c-agent button:has-text('内容を確認しました')").count() === 0,
    "押したあとはボタンが消える");
  check((await page.locator("#c-agent").textContent()).includes("確認済み"),
    "確認した記録として残る");

  console.log("— 使えない案内 —");
  await page.goto(`${BASE}/device-consent.html?link=BADCODE`);
  await page.waitForTimeout(1600);
  check((await page.locator("#c-linked").textContent()).includes("やり直して"),
    "使えない案内では、次にどうするかを書く");

  console.log("— マイページ —");
  await page.goto(`${BASE}/mypage.html`);
  await page.waitForTimeout(1600);
  check(!(await page.locator("#dv-card").getAttribute("class")).includes("hidden"),
    "会社のパソコンの欄が出る");
  // ここまでで、この人には会社PC（ag9 = 8GRP-PC-77）が登録され、
  // 本人の確認も済んでいる。ふだんは1行で足りる
  {
    const t = await page.locator("#dv").textContent();
    check(t.includes("8GRP-PC-77"), "自分の会社PCが出る");
    check(/正常|確認待ち/.test(t), "状態がひと目で分かる");
    check(!t.includes("会社PCのセキュリティ設定が必要です"),
      "設定が済んだ人に、案内を出し続けない");
  }

  // 細かいところは「詳細を見る」の中。毎回おなじ説明を出さない
  await page.locator("#mypc-btn").click();
  await page.waitForTimeout(300);
  {
    const t = await page.locator("#mypc-more").textContent();
    check(t.includes("6:12"), "自分の利用時間");
    check(t.includes("自分の利用記録"), "自分の利用記録が見られる");
    check(t.includes("事務") && t.includes("端末の記録"), "誰が自分の記録を見たかが分かる");
    // 管理者向けのものは出さない
    check(!/使用終了にする|停止する|アラート条件/.test(t), "管理操作は本人に出さない");
  }
  await page.locator("#mypc-more details summary").click();
  await page.waitForTimeout(300);
  {
    const t = await page.locator("#mypc-more details").textContent();
    check(t.includes("WEBの利用状況") && t.includes("情報セキュリティ"),
      "端末管理の説明を、あとからでも読める");
    check(!/90分|しきい値|Cookie/.test(t), "ここでも判定のしかたは出さない");
  }
  await page.screenshot({ path: path: shotPath("dv2-mypage.png"), fullPage: true });

  console.log("— どの画面でも合図が出る —");
  sent.length = 0;
  await page.goto(`${BASE}/home.html`);
  await page.waitForTimeout(1500);
  check(sent.some((p) => p.action === "beat"), "ホームでも合図が出る");
  await page.close();
}

await br.close();
if (errs.length) { console.log("\nJSエラー:"); errs.forEach((e) => console.log(" ", e)); bad += errs.length; }
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
