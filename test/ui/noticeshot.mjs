// 登録画面と、周知の文。
//
// ■ 画面から説明を外した
//
//   依頼で、記録する内容の説明を device-consent.html から全部外した。
//   画面は登録だけを引き受け、何を記録するかは
//   管理部が送るお知らせ（docs/device-announce.md）で伝える。
//
//   外した以上、押す文言も「内容を確認しました」ではいけない。
//   見せていないものを確認した、という記録になる。
//
// ■ 文そのものは残っている
//
//   マイページと、送るお知らせがこの文を使う。
//   だから言葉づかいの約束（監視と言わない・同意を求めない・
//   取っていないものを取ると言わない）は、文のほうで見張り続ける。
import { launch, BASE } from "../_browser.mjs";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { shotPath } from "../_shot.mjs";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(_HERE));
const atRoot = (p) => _join(ROOT, p);

const { NOTICE, AGENT_NOTICE, WEB_AREA } = await import(atRoot("api/devices/me.js"));

const me = { email: "y@8grp.co.jp", appRole: "member", shows: {},
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" },
        roles: [], isAdmin: false, tenantId: "t1", stage: null } };

const mine = {
  devices: [{ id: "ag1", uid: "u1", source: "agent", label: "8GRP-PC-01",
    hostname: "8GRP-PC-01", os: "Windows 11", agentVersion: "0.3.0",
    status: "active", confirmed: true, installed: true, lastSeen: "3分前",
    state: { key: "ok", label: "正常" } }],
  notice: NOTICE, agentNotice: AGENT_NOTICE, views: [],
};

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// ---- 画面 ------------------------------------------------------------------
console.log("— 登録画面 —");

const br = await launch();
const page = await br.newPage({ viewport: { width: 900, height: 1400 }, timezoneId: "Asia/Tokyo" });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));

await page.route("**/api/**", (r) => {
  const u = r.request().url();
  const send = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (/\/api\/devices\/me/.test(u)) return send(mine);
  if (/\/api\/me\b/.test(u)) return send(me);
  if (/\/api\/notifications/.test(u)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(u)) return send({ badges: {} });
  return send({});
});
await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "山田", shows: {}, stage: null }));
});

await page.goto(`${BASE}/device-consent.html`);
await page.waitForTimeout(1500);

const text = await page.locator("body").innerText();
check(!text.includes("**"), "アスタリスクが生で出ていない");

// 説明はここには無い
check(!text.includes("記録する範囲"), "記録する範囲を出していない");
check(!text.includes("業務に使うパソコン"), "私物PCの説明も出していない");
for (const a of NOTICE.areas.concat([WEB_AREA])) {
  check(!text.includes(a), `大分類を出していない: ${a}`);
}

// 押す文言は、見せていないものを確認したことにしない
check(!text.includes("内容を確認しました"),
  "「内容を確認しました」は使わない（見せていないので）");
check(text.includes("登録"), "登録の画面だと分かる");
check(!/監視/.test(text), "「監視」を出していない");
check(!/同意します|同意してください|同意する/.test(text), "同意を求める言い回しを出していない");
check(!/90分|しきい値|Cookie|\? から後ろ/.test(text), "しきい値・技術仕様を出していない");
check(errs.length === 0, `スクリプトのエラーなし${errs.length ? "：" + errs[0] : ""}`);

await page.screenshot({ path: shotPath("consent.png"), fullPage: true });
await page.close();
await br.close();

// ---- 文そのもの ------------------------------------------------------------
//
// マイページと、送るお知らせが使う。画面から外しても、ここは守り続ける
console.log("— 周知の文 —");

const all = [NOTICE.lead, NOTICE.scope, NOTICE.purpose, NOTICE.yours,
             NOTICE.rule, NOTICE.ack].join(" ");

check(!/監視/.test(all), "「監視」を使っていない");
check(!/同意します|同意してください/.test(all), "同意を求める言い回しを使っていない");
check(all.includes("同意を求めるものではありません"), "同意ではなく周知だと書いてある");
check(!/90分|しきい値/.test(all), "しきい値を書いていない");
check(NOTICE.rule.includes("私物PCでの業務利用は禁止します"), "私物PCの禁止が書いてある");
check(NOTICE.rule.includes("事前に管理者の承認"), "承認の道も書いてある");
check(NOTICE.yours.includes("あなたの画面に残ります"), "見たことが本人に残ると書いてある");

// EXE を入れた人にだけ足すぶん。全員向けに混ぜない
for (const gone of ["外部機器", "ソフトウェアの追加", "アプリケーションの利用状況"]) {
  check(!NOTICE.areas.some((a) => a.includes(gone)),
    `EXE でしか取れない「${gone}」を、全員向けに混ぜていない`);
}
check(AGENT_NOTICE.scope.includes("原則として勤務時間内"), "勤務時間の内と外が書いてある");
check(AGENT_NOTICE.scope.includes("時間外も対象"), "安全管理は時間外も、と書いてある");

console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
