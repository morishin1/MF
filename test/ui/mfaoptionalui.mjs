// 二段階認証は任意。マイページと共通ヘッダを、実際のブラウザで見る。
//
// ■ 何を守りたいのか
//   ・マイページ#mfa は「任意のセキュリティ設定」。登録していなくても、エラー・警告（赤/黄）にしない。必須・期限・強制の文言が無い
//   ・どの役割（経営者・人事・管理者・社労士）でも同じ。サーバが昔の「必須・期限」の状態を返してきても、画面は警告を出さない
//   ・共通ヘッダに、二段階認証の案内帯が出ない（登録していない経営者・人事のホームでも）
//   ・登録する機能は残っている（登録を始める → 6桁入力欄。登録済みなら「登録済み」と、登録を外す導線）
//   ・スマホ幅（390px）で横スクロールしない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const meOf = (roles, mfa) => ({
  email: "taro@gw.8grp.co.jp",
  gw: { employee: { id: "emp-1", display_name: "森田 太郎", email: "taro@gw.8grp.co.jp", department: "経営", position: "", joined_on: "2026-04-01", status: "active" },
        roles, isAdmin: false, tenantId: "t1", stage: null },
  appRole: roles.includes("owner") ? "owner" : "member", shows: {}, mfa,
});

async function open(page, { roles, status, meMfa, width = 1100, path = "/mypage.html#mfa" }) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "taro@gw.8grp.co.jp" }));
    localStorage.removeItem("kp_layout"); localStorage.removeItem("kp_me");
  });
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b, st = 200) => route.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(meOf(roles, meMfa));
    if (/\/api\/mfa/.test(url) && route.request().method() === "GET") return send(status);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}${path}`);
  await page.waitForTimeout(1200);
}

// サーバが返す、いまの状態（lib/mfa.js mfaState）
const OPTIONAL_NONE = { required: false, enrolled: false, verified: false, enforced: false, enrollUntil: null, enforceFrom: null, blocked: false,
  factors: [], selfUnenroll: "reauth", selfUnenrollHint: "外す前に、認証アプリの6桁でもう一度確かめてください", reset: null };
const OPTIONAL_ON = { ...OPTIONAL_NONE, enrolled: true, factors: [{ id: "f1", status: "verified", name: "エイト" }] };
// 昔のサーバ（必須・期限つき）が返す形。画面は、これを受けても警告を出さない
const LEGACY_REQUIRED = { ...OPTIONAL_NONE, required: true, enforced: true, blocked: true, enrollUntil: "2026-09-30", enforceFrom: "2026-10-01" };

const ROLE_CASES = [["経営者", ["owner"]], ["人事", ["hr"]], ["社労士", ["labor_advisor"]], ["責任者", ["manager"]], ["経理", ["finance"]], ["一般メンバー", []]];

console.log("— マイページ：未登録でも、警告にしない（任意）—");
for (const [label, roles] of ROLE_CASES) {
  const page = await br.newPage();
  await open(page, { roles, status: OPTIONAL_NONE, meMfa: OPTIONAL_NONE });
  const t = await page.locator("#mfa").innerText();
  check(/二段階認証（任意のセキュリティ設定）/.test(t), `${label}: 見出しは「二段階認証（任意のセキュリティ設定）」`);
  check(t.includes("任意の設定です。登録しなくても、これまでどおり使えます"), `${label}: 「登録しなくても、これまでどおり使えます」`);
  check(!/必須|強制|期限|までの登録|開けなくなります|開けません|2026/.test(t), `${label}: 必須・強制・期限・開けない、の文言が無い`);
  check(await page.locator("#mfa .banner").count() === 0, `${label}: 警告・エラーの帯（banner）が無い`);
  check(await page.locator("#mfa .err-text").evaluateAll((ns) => ns.every((n) => n.textContent.trim() === "")), `${label}: エラー文も空`);
  check(await page.locator("#mfa button", { hasText: "登録を始める" }).isVisible(), `${label}: 「登録を始める」は残っている`);
  check(await page.locator(".kp-mfa-nudge").count() === 0, `${label}: 共通ヘッダの案内帯が無い`);
  if (label === "経営者") await page.screenshot({ path: shotPath("mfa-optional-pc.png"), fullPage: true });
  await page.close();
}

console.log("\n— 昔のサーバ（必須・期限つき）が返しても、警告を出さない —");
{
  const page = await br.newPage();
  await open(page, { roles: ["owner", "hr"], status: LEGACY_REQUIRED, meMfa: LEGACY_REQUIRED });
  const t = await page.locator("#mfa").innerText();
  check(await page.locator("#mfa .banner").count() === 0 && !/必須|強制|2026-10-01|2026-09-30/.test(t), "マイページ: 必須・期限・強制の案内を出さない");
  check(await page.locator(".kp-mfa-nudge").count() === 0, "共通ヘッダ: 案内帯を出さない");
  await page.close();
}

console.log("\n— ホーム：二段階認証が未登録の経営者・人事に、案内帯を出さない —");
for (const [label, roles] of [["経営者", ["owner"]], ["人事", ["hr"]]]) {
  const page = await br.newPage();
  await open(page, { roles, status: OPTIONAL_NONE, meMfa: { ...OPTIONAL_NONE, required: true, enforced: false, enrollUntil: "2026-09-30", enforceFrom: "2026-10-01" }, path: "/home.html" });
  const t = await page.locator("body").innerText();
  check(await page.locator(".kp-mfa-nudge").count() === 0 && !/二段階認証を .*登録してください|から必須/.test(t), `${label}: ホームに、二段階認証の案内帯が出ない`);
  await page.close();
}

console.log("\n— 登録済み・登録の機能 —");
{
  const page = await br.newPage();
  await open(page, { roles: ["owner"], status: OPTIONAL_ON, meMfa: OPTIONAL_ON });
  const t = await page.locator("#mfa").innerText();
  check(t.includes("登録済みです") && t.includes("ログインのたびに、認証アプリの6桁が要ります"), "登録済み: 「登録済みです」と、ログイン時の6桁の説明");
  check(await page.locator("#mfa .banner").count() === 0, "登録済み: 帯は無い");
  check(t.includes("外す前に、認証アプリの6桁でもう一度確かめてください") && !/強制期間中/.test(t), "パスワードだけのログイン（aal1）: 解除は6桁の再認証の案内。「強制期間中は外せない」ではない");
  await page.close();

  const p2 = await br.newPage();
  await open(p2, { roles: ["owner"], status: { ...OPTIONAL_ON, selfUnenroll: "ok", selfUnenrollHint: null }, meMfa: OPTIONAL_ON });
  check(await p2.locator("#mfa button", { hasText: "登録を外す" }).isVisible(), "6桁で確かめた人: 「登録を外す」が出る");
  let asked = "";
  p2.on("dialog", (d) => { asked = d.message(); d.dismiss(); });
  await p2.click('#mfa button:has-text("登録を外す")');
  await p2.waitForTimeout(300);
  check(asked.includes("ログインのときに認証アプリの6桁が要らなくなります") && !/必須|個人情報の画面が開けなく/.test(asked), `解除の確認は「6桁が要らなくなる」だけ（必須の脅しがない）: ${asked.slice(0, 40)}…`);
  await p2.close();

  const p3 = await br.newPage();
  await open(p3, { roles: ["hr"], status: { ...OPTIONAL_NONE, reset: { at: "2026-10-01T00:00:00Z", expiresAt: "2026-10-08T00:00:00Z" } }, meMfa: OPTIONAL_NONE });
  const rt = await p3.locator("#mfa").innerText();
  check(rt.includes("管理者が二段階認証をリセットしました。使う場合は、認証アプリで登録し直してください。"), "管理者がリセットした直後: 「使う場合は、登録し直してください」");
  check(await p3.locator("#mfa .banner.warn, #mfa .banner.err").count() === 0, "リセット後の案内も、警告の色にしない");
  await p3.close();
}

console.log("\n— スマホ幅 —");
for (const width of [390, 360]) {
  const page = await br.newPage();
  await open(page, { roles: ["owner"], status: OPTIONAL_NONE, meMfa: OPTIONAL_NONE, width });
  const of = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(of <= 0, `${width}px: 横スクロールが出ない（はみ出し ${of}px）`);
  if (width === 390) await page.screenshot({ path: shotPath("mfa-optional-sp.png"), fullPage: true });
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
