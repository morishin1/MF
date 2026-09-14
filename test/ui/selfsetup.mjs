// 社員がマイページから会社PCを設定する流れ。
//
//   マイページ →「会社PCのセキュリティ設定」
//     → この会社PCを設定する（落とす）
//     → 実行を待つ
//     → インストーラがブラウザを開く（?pair=）
//     → 押さずに進む
//     → 内容を確認しました
//
// 社員にさせないこと: 登録コードの入力 / 社員名の選択 / コマンド / 拡張の手動設定
import { launch, BASE } from "../_browser.mjs";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { shotPath } from "../_shot.mjs";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(_HERE));
const atRoot = (p) => _join(ROOT, p);

const me = { email: "y@8grp.co.jp", appRole: "member", shows: {},
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" },
        roles: [], isAdmin: false, tenantId: "t1", stage: null } };

const { NOTICE, AGENT_NOTICE } = await import(atRoot("api/devices/me.js"));
const TOKEN = "HB84rDZMlz2tsQ-jB3GO8GMVEDEw42VgHd2FVGpAZBM";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function wire(page, opts) {
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => m.type() === "error"
    && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest|Download is not/i.test(m.text())
    && errs.push(m.text()));
  await page.route("**/api/**", (r) => {
    const req = r.request();
    const url = req.url();
    const send = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/devices\/setup/.test(url) && /policy=/.test(url)) {
      return send({ selfInstall: Boolean(opts.selfInstall) });
    }
    if (/\/api\/devices\/setup/.test(url) && req.method() === "POST") {
      opts.sent.push({ what: "mint" });
      return send({ ok: true, token: TOKEN, expiresInSec: 900,
                    downloadUrl: `/api/devices/setup?download=${TOKEN}`,
                    fileName: `EIGHT-Agent-Setup-${TOKEN}.exe` });
    }
    if (/\/api\/devices\/setup/.test(url) && /download=/.test(url)) {
      opts.sent.push({ what: "download" });
      return r.fulfill({ status: 200, contentType: "application/octet-stream", body: "MZ" });
    }
    if (/\/api\/devices\/setup/.test(url)) {
      return send({ state: opts.state || "waiting", pc: opts.pc || null });
    }
    if (/\/api\/devices\/pair/.test(url) && req.method() === "POST") {
      opts.sent.push({ what: "claim", body: JSON.parse(req.postData() || "{}") });
      return send({ ok: true, pc: { hostname: "DESKTOP-A123" }, waitSec: 60 });
    }
    if (/\/api\/devices\/pair/.test(url)) {
      return send(opts.pairInfo);
    }
    if (/\/api\/devices\/me/.test(url) && req.method() === "POST") return send({ ok: true, deviceUid: "u1" });
    if (/\/api\/devices\/me/.test(url)) {
      return send({ devices: opts.devices || [], notice: NOTICE,
                    agentNotice: opts.agent ? AGENT_NOTICE : null, usage: [], views: [] });
    }
    if (/\/api\/me\b/.test(url)) return send(me);
    if (/\/api\/devices/.test(url)) return send({ devices: [] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "山田", shows: {}, stage: null }));
  });
  return errs;
}

// ===== ① マイページの入口 =====
{
  console.log("— マイページの入口 —");
  const page = await br.newPage({ viewport: { width: 1100, height: 1200 }, timezoneId: "Asia/Tokyo" });
  const opts = { sent: [], devices: [{ id: "d1", uid: "u1", label: "Windows 11 の Chrome",
    os: "Windows 11", browser: "Chrome", source: "browser", confirmed: true,
    lastSeen: "たった今", state: { key: "ok", label: "正常" } }] };
  const errs = await wire(page, opts);
  await page.goto(`${BASE}/mypage.html`);
  await page.waitForTimeout(1800);

  const t = await page.locator("#dv").textContent();
  check(t.includes("会社PCのセキュリティ設定"), "入口が分かりやすい名前になっている");
  check((await page.locator("#dv a[href='device-setup.html']").count()) === 1,
    "端末設定ページへ行ける");
  check(!/登録コード/.test(await page.locator("body").innerText()),
    "登録コードの話が出てこない");
  check(errs.length === 0, `エラーなし${errs.length ? "：" + errs[0] : ""}`);
  await page.close();
}

// ===== ② 端末設定ページ（マイページから来た） =====
{
  console.log("— この会社PCを設定する —");
  const page = await br.newPage({ viewport: { width: 1100, height: 1300 }, timezoneId: "Asia/Tokyo" });
  const opts = { sent: [] };
  const errs = await wire(page, opts);
  await page.goto(`${BASE}/device-setup.html`);
  await page.waitForTimeout(1500);

  check(await page.locator("#card-start").isVisible(), "「この会社PCを設定する」が出る");
  check((await page.locator("#card-start input").count()) === 0, "打ち込む欄が1つも無い");
  check((await page.locator("#card-start select").count()) === 0, "社員名を選ぶ欄が無い");
  check(/山田 太郎/.test(await page.locator("#st-who").textContent()), "誰のPCになるか出る");
  {
    check(await page.locator("#st-byadmin").isVisible(), "管理者向けの案内が出ている");
    check(!(await page.locator("#st-byself").isVisible()), "社員向けの手順は出ていない");
    const t = await page.locator("#card-start").innerText();
    // 既定は管理者・IT担当が入れる。
    // 「警告が出たら詳細情報→実行」を社員に覚えさせない
    check(t.includes("管理者・IT担当にかわってください"), "誰が入れるのか書いてある");
    check(!/詳細情報/.test(t), "社員に警告の越え方を教えない");
    check(t.includes("ご自身では警告を進めないでください"), "進めないでと書いてある");
    check(t.includes("無視してはいけません"), "ほかの警告も無視しないと書いてある");
    check(t.includes("自動でもどってきます"), "戻ってくると書いてある");
    check(!/登録コード|コマンド|拡張/.test(t), "コード・コマンド・拡張の話をしない");
  }
  await page.screenshot({ path: shotPath("setup1.png"), fullPage: true });

  // 落とす
  const dl = page.waitForEvent("download").catch(() => null);
  await page.click("#go-dl");
  await page.waitForTimeout(1200);
  await dl;

  check(opts.sent.some((x) => x.what === "mint"), "札を作りに行く");
  check(await page.locator("#card-run").isVisible(), "設定を待つ画面に進む");
  check((await page.locator("#card-run").textContent()).includes("管理者・IT担当にかわって"),
    "待ちの画面でも、誰が入れるか書いてある");
  check((await page.locator("#run-file").textContent()).includes("EIGHT-Agent-Setup-"),
    "落とすファイル名を見せる（名前を変えさせないため）");
  await page.screenshot({ path: shotPath("setup2.png"), fullPage: true });
  check(errs.length === 0, `エラーなし${errs.length ? "：" + errs[0] : ""}`);
  await page.close();
}

// ===== ②-2 将来: 社員が自分で入れる形に切り替えたとき =====
{
  console.log("— 設定で社員のセルフインストールに切り替えたとき —");
  const page = await br.newPage({ viewport: { width: 1100, height: 1300 }, timezoneId: "Asia/Tokyo" });
  const opts = { sent: [], selfInstall: true };
  const errs = await wire(page, opts);
  await page.goto(`${BASE}/device-setup.html`);
  await page.waitForTimeout(1500);

  check(await page.locator("#st-byself").isVisible(), "社員向けの手順に変わる");
  check(!(await page.locator("#st-byadmin").isVisible()), "管理者に渡す案内は消える");
  const t = await page.locator("#card-start").innerText();
  check(t.includes("そのまま実行"), "自分で実行する手順が出る");
  check(errs.length === 0, `エラーなし${errs.length ? "：" + errs[0] : ""}`);
  await page.close();
}

// ===== ③ インストーラが開いた（本人の札） =====
{
  console.log("— インストーラが戻してきた（本人の札） —");
  const page = await br.newPage({ viewport: { width: 1100, height: 1200 }, timezoneId: "Asia/Tokyo" });
  const opts = { sent: [], pairInfo: {
    kind: "selfserve", auto: true, otherPerson: false, used: false, members: null,
    me: { id: "emp-1", name: "山田 太郎" },
    pc: { hostname: "DESKTOP-A123", os: "Windows 11",
          browsers: [{ key: "chrome", label: "Chrome" }, { key: "edge", label: "Edge" }] },
  } };
  const errs = await wire(page, opts);
  await page.goto(`http://127.0.0.1:8713/device-setup.html?pair=${TOKEN}`);
  await page.waitForTimeout(1800);

  check(opts.sent.some((x) => x.what === "claim"), "押さずに、そのまま確定する");
  check(!(await page.locator("#card-claim").isVisible()),
    "「このパソコンですか」と聞き直す画面を出さない");
  check((await page.locator("#pick").isVisible().catch(() => false)) === false,
    "社員名を選ばせない");
  check(await page.locator("#card-wait").isVisible(), "つないでいる画面になる");
  {
    const c = opts.sent.find((x) => x.what === "claim");
    check(c.body.deviceUid, "このブラウザの印も渡す（1台にまとまる）");
    check(!c.body.employeeId, "社員は選ばない");
  }
  await page.screenshot({ path: shotPath("setup3.png"), fullPage: true });
  check(errs.length === 0, `エラーなし${errs.length ? "：" + errs[0] : ""}`);
  await page.close();
}

// ===== ④ 別の人がログインしているブラウザで開かれた =====
{
  console.log("— 別の人がログインしていた —");
  const page = await br.newPage({ viewport: { width: 1100, height: 900 }, timezoneId: "Asia/Tokyo" });
  const opts = { sent: [], pairInfo: {
    kind: "selfserve", auto: false, otherPerson: true, used: false, members: null,
    me: { id: "emp-9", name: "別の人" }, pc: { hostname: "DESKTOP-A123", os: "Windows 11", browsers: [] },
  } };
  const errs = await wire(page, opts);
  await page.goto(`http://127.0.0.1:8713/device-setup.html?pair=${TOKEN}`);
  await page.waitForTimeout(1500);

  check(!opts.sent.some((x) => x.what === "claim"), "勝手に結びつけない");
  const t = await page.locator("#gate").textContent();
  check(t.includes("別の方が始めたもの"), "何が起きたか言う");
  check(t.includes("ログインし直して"), "どうすればよいか言う");
  check(errs.length === 0, `エラーなし${errs.length ? "：" + errs[0] : ""}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
