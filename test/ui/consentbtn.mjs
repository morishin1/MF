// 確認画面に、押す場所が必ずあるか（device-consent.html）。
//
// ■ なぜこのテストが要るのか
//
//   「リンクを開いたが押すボタンが無い」と言われた。
//   画面はこう書いていた。
//
//     この端末はまだ登録されていません。画面を開き直してください。
//
//   ところが開き直しても、届かない理由が同じなら同じ画面がまた出る。
//   押す場所の無い画面を、何度も開き直させることになっていた。
//
//   この画面の用は「読んで、押してもらう」こと。
//   だから、どの状態でも次にやることが画面にある、を守る。
//
//     台帳に載った          → この端末を登録する
//     1回目だけ載らなかった → 送り直して、この端末を登録する
//     合図が届かない        → もう一度ためす（押すと直る）
//     表がまだ無い          → 管理部へ、と出す（本人にはどうにもできない）
import { launch, BASE } from "../_browser.mjs";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { shotPath } from "../_shot.mjs";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(_HERE));
const atRoot = (p) => _join(ROOT, p);

const { NOTICE } = await import(atRoot("api/devices/me.js"));

const me = { email: "y@8grp.co.jp", appRole: "member", shows: {},
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" },
        roles: [], isAdmin: false, tenantId: "t1", stage: null } };

const ROW = { id: "d1", uid: "u1", label: "Windows 11 の Chrome", os: "Windows 11",
  browser: "Chrome", source: "browser", status: "unconfirmed", confirmed: false,
  lastSeen: "たった今", state: { key: "waiting", label: "本人の確認待ち" } };

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

/**
 * @param beatsUntilRow  何回目の合図で台帳に載るか（0 なら最初から載っている）
 * @param beatFails      合図そのものが落ちる
 * @param notReady       表がまだ無い
 */
async function open({ beatsUntilRow = 0, beatFails = false, notReady = false }) {
  const page = await br.newPage({ viewport: { width: 1100, height: 1400 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  const st = { beats: 0, devices: beatsUntilRow === 0 && !notReady ? [ROW] : [] };

  await page.route("**/api/**", async (r) => {
    const req = r.request();
    const url = req.url();
    const send = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });

    if (/\/api\/devices\/me/.test(url) && req.method() === "POST") {
      const body = req.postData() ? JSON.parse(req.postData()) : {};
      if (body.action === "beat") {
        st.beats++;
        if (beatFails) {
          return r.fulfill({ status: 503, contentType: "application/json",
            body: JSON.stringify({ error: "not_ready", message: "いまつながりませんでした" }) });
        }
        if (notReady) return send({ ok: true, deviceUid: "u1", notReady: true });
        if (beatsUntilRow && st.beats >= beatsUntilRow) st.devices = [ROW];
        return send({ ok: true, deviceUid: "u1", confirmed: false });
      }
      if (body.action === "confirm") {
        st.devices = st.devices.map((d) => ({ ...d, confirmed: true, status: "active",
          notifiedAt: "2026-09-16T01:00:00Z" }));
        return send({ ok: true });
      }
      return send({ ok: true });
    }
    if (/\/api\/devices\/me/.test(url)) {
      if (notReady) return send({ devices: [], notice: NOTICE, notReady: true });
      return send({ devices: st.devices, notice: NOTICE, agentNotice: null,
                    usage: [], views: [], range: { from: "2026-09-01", to: "2026-09-16" } });
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

  await page.goto(`${BASE}/device-consent.html`);
  await page.waitForTimeout(1600);
  return { page, errs, st };
}

const textOf = (page) => page.locator("#c-this").textContent();

console.log("— 台帳に載っているとき —");
{
  const { page, errs } = await open({});
  check((await page.locator("#c-this button:has-text('この端末を登録する')").count()) > 0,
    "「この端末を登録する」が出る");

  // 記録する内容の説明は、この画面には置かない（依頼で全部外した）。
  // 外した以上、「内容を確認しました」という文言も残してはいけない。
  // 見せていないものを確認した、という記録になるため
  const body = await page.locator("body").innerText();
  check(!body.includes("内容を確認しました"),
    "見せていない内容を「確認しました」と書かせない");
  check(!body.includes("記録する範囲"), "説明は出さない");

  await page.locator("#c-this button:has-text('この端末を登録する')").click();
  await page.waitForTimeout(700);
  check((await textOf(page)).includes("登録済み"), "押すと登録済みになる");
  check(errs.length === 0, `スクリプトのエラーなし${errs.length ? "：" + errs[0] : ""}`);
  await page.close();
}

console.log("— 1回目の合図では載らなかったとき —");
{
  // 本物でも起きる。載る前に読むと、押す場所の無い画面になっていた
  const { page, errs, st } = await open({ beatsUntilRow: 2 });
  check(st.beats >= 2, "台帳に出てこなければ、黙って合図を送り直す");
  check((await page.locator("#c-this button:has-text('この端末を登録する')").count()) > 0,
    "送り直したあと、ちゃんと押せる");
  check(errs.length === 0, `スクリプトのエラーなし${errs.length ? "：" + errs[0] : ""}`);
  await page.screenshot({ path: shotPath("consent-retry.png"), fullPage: true });
  await page.close();
}

console.log("— 合図が届かないとき —");
{
  const { page, errs } = await open({ beatFails: true });
  const t = await textOf(page);
  check(!t.includes("画面を開き直してください"),
    "直らないものを、開き直させない");
  check(t.includes("いまつながりませんでした"), "届かなかった理由を出す");
  check((await page.locator("#c-this button:has-text('もう一度ためす')").count()) > 0,
    "次にやることが画面にある");
  check(t.includes("管理部"), "それでもだめなときの行き先を書いてある");
  check(errs.length === 0, `スクリプトのエラーなし${errs.length ? "：" + errs[0] : ""}`);
  await page.screenshot({ path: shotPath("consent-failed.png"), fullPage: true });
  await page.close();
}

console.log("— 表がまだ無いとき —");
{
  const { page, errs } = await open({ notReady: true });
  const t = await textOf(page);
  check(t.includes("準備"), "準備が終わっていないと書く");
  check(t.includes("管理部"), "本人にはどうにもできないので、行き先を書く");
  check(!/db\/|sql|table/i.test(t), "本人の画面で、流すSQLの話はしない");
  check((await page.locator("#c-this button:has-text('もう一度ためす')").count()) === 0,
    "押しても直らないボタンは出さない");
  check(errs.length === 0, `スクリプトのエラーなし${errs.length ? "：" + errs[0] : ""}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
