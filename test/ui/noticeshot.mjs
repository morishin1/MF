// 告知の画面に、アスタリスクが生で出ていないか。
import { launch, BASE } from "../_browser.mjs";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(_HERE));
const atRoot = (p) => _join(ROOT, p);
const { NOTICE, AGENT_NOTICE } = await import(atRoot("api/devices/me.js"));

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

const br = await launch();
const page = await br.newPage({ viewport: { width: 900, height: 1400 }, timezoneId: "Asia/Tokyo" });
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
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

// 会社ルールの周知であって、同意を取る画面ではない
check(text.includes("会社貸与パソコンの端末管理について"), "見出しが端末管理になっている");
check(text.includes("内容を確認しました"), "ボタンが「内容を確認しました」");
check(!text.includes("このパソコンです"), "「このパソコンです」は出ていない");
// 「同意を求めるものではありません」は、その否定なので通す。
// 求める側の言い回しだけを弾く
check(!/監視/.test(text), "「監視」を出していない");
check(!/同意します|同意してください|同意する/.test(text), "同意を求める言い回しを出していない");
check(text.includes("同意を求めるものではありません"), "同意ではないと書いてある");

// 大分類だけを出す。判定のしかたは出さない
for (const a of ["端末の利用状況", "アプリケーションの利用状況", "WEBの利用状況",
                 "外部機器の接続状況", "ソフトウェアの変更状況", "セキュリティ上必要な端末情報"]) {
  check(text.includes(a), `大分類が出ている: ${a}`);
}
check(!/90分|しきい値|Cookie|\? から後ろ/.test(text), "しきい値・技術仕様を出していない");

// 私物PCの扱い
check(text.includes("私物PCでの業務利用は禁止します"), "私物PCの禁止が出ている");
check(text.includes("事前に管理者の承認"), "承認の道も出ている");

// 勤務時間の内と外（ソフトが入っている人）
check(text.includes("原則として勤務時間内"), "勤務時間の内と外が出ている");
check(text.includes("あなたの画面に残ります"), "見たことが本人に残ると書いてある");

await page.screenshot({ path: "/tmp/claude-0/-home-user-MF/ded29588-4821-5de3-8900-cbdd762650f3/scratchpad/notice.png", fullPage: true });
await br.close();
if (errs.length) { console.log("エラー:", errs); bad++; }
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
