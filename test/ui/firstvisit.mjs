// はじめてマイページを開いた人に、端末の欄が出るか。
//
// 端末の行を作るのは合図（KPDevice）。マイページはそれと同時に走るので、
// 待たないと「まだ0件」を読んでしまい、端末の欄がまるごと隠れる。
// 実際にそれで「画面に出ない」が起きた。
import { launch, BASE } from "../_browser.mjs";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(_HERE));
const atRoot = (p) => _join(ROOT, p);

const me = { email: "y@8grp.co.jp", appRole: "member", shows: {},
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" },
        roles: [], isAdmin: false, tenantId: "t1", stage: null } };

const { NOTICE } = await import(atRoot("api/devices/me.js"));

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function run(label, { beatCreatesRow }) {
  console.log(`— ${label} —`);
  const page = await br.newPage({ viewport: { width: 1100, height: 1200 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  // 台帳。はじめは空。合図が来たら1件できる
  let devices = [];
  let beats = 0;

  await page.route("**/api/**", async (r) => {
    const req = r.request();
    const url = req.url();
    const send = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/devices\/me/.test(url) && req.method() === "POST") {
      beats++;
      // 本物と同じで、合図は少し遅れて返る
      await new Promise((res) => setTimeout(res, 250));
      if (beatCreatesRow) {
        devices = [{ id: "d1", uid: "u1", label: "Windows 11 の Chrome", os: "Windows 11",
                     browser: "Chrome", source: "browser", confirmed: false,
                     lastSeen: "たった今", state: { key: "waiting", label: "本人の確認待ち" } }];
      }
      return send({ ok: true, deviceUid: "u1", confirmed: false });
    }
    if (/\/api\/devices\/me/.test(url)) {
      return send({ devices, notice: NOTICE, agentNotice: null, usage: [], views: [],
                    range: { from: "2026-09-01", to: "2026-09-13" } });
    }
    if (/\/api\/me\b/.test(url)) return send(me);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "山田", shows: {}, stage: null }));
  });

  await page.goto(`${BASE}/mypage.html`);
  await page.waitForTimeout(2000);

  const hidden = (await page.locator("#dv-card").getAttribute("class") || "").includes("hidden");
  const t = await page.locator("#dv").textContent();

  if (beatCreatesRow) {
    check(beats > 0, "合図を送っている");
    check(!hidden, "1回目の読み込みで、端末の欄が出る");
    check(t.includes("確認待ち"), "確認していないことが分かる");
    check((await page.locator("#dv a[href='device-consent.html']").count()) > 0,
      "確認しにいく入口がある");
    check(t.includes("確認するまで、利用時間は数えていません"),
      "押すまで数えない、と本人にも書いてある");
  } else {
    // 台帳に載らない環境（表がまだ無いなど）では、静かに隠れるだけ
    check(hidden, "台帳に載らないときは、端末の欄を出さない");
  }
  check(errs.length === 0, `スクリプトのエラーなし${errs.length ? "：" + errs[0] : ""}`);
  await page.screenshot({ path: `/tmp/claude-0/-home-user-MF/ded29588-4821-5de3-8900-cbdd762650f3/scratchpad/firstvisit-${beatCreatesRow ? "ok" : "none"}.png`, fullPage: true });
  await page.close();
}

await run("はじめて開いた人", { beatCreatesRow: true });
await run("台帳に載らないとき", { beatCreatesRow: false });

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
