// 表がまだ無いときに、画面が何と言うか
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
const br = await launch();
const page = await br.newPage({ viewport: { width: 1100, height: 900 } });
await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "テスト", shows: {}, stage: null }));
});
await page.route("**/api/**", (route) => {
  const url = route.request().url();
  const send = (s, b) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(b) });
  if (/\/api\/me\b/.test(url)) return send(200, {
    email: "a@b.c", appRole: "member", shows: {},
    gw: { employee: { id: "e1", display_name: "テスト", status: "active" }, roles: [], isAdmin: false, tenantId: "t1" },
  });
  if (/\/api\/timecard/.test(url)) return send(503, {
    error: "not_installed",
    hint: "この機能に必要なテーブルがまだ作られていません。管理者に db/048_timecard.sql の実行を依頼してください",
  });
  if (/\/api\/notifications/.test(url)) return send(200, { notifications: [], unread: 0 });
  return send(200, {});
});
await page.goto(`${BASE}/timecard.html`);
await page.waitForTimeout(1400);
const txt = await page.locator("body").textContent();
const okMsg = txt.includes("db/048_timecard.sql");
console.log(okMsg ? "  ok 何をすればよいかが画面に出る" : "NG: 生のDBエラーのまま");
console.log(okMsg ? "" : txt.slice(0, 400));
await page.screenshot({ path: path: shotPath("tc-notinstalled.png"), fullPage: true });
await br.close();
process.exit(okMsg ? 0 : 1);
