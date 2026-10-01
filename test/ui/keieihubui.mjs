// 経営ハブ（/keiei ホーム・経営設定・セキュリティ）を、実際のブラウザで見る。
//
// ■ 何を守りたいのか
//   ・4ブロックだけ。上から ①今日の確認 ②人・組織 ③お金 ④リスク・未処理
//   ・①は最上部。重要度の高い順。何をすればいいかが先（押す先の名前つき）。0件なら、大きく出さず1行
//   ・Board は「売上・請求は Board 連携後に表示します」の1表示だけ。「データ未連携」の空カードを並べない
//   ・押したら、決めた元システムへ移る（HR・経費精算・会計・月次締め … ）。ここで処理を終わらせない
//   ・給与・手当・単価の金額は、どこにも出ない
//   ・読めなかった元データは、0 ではなく「取得できません」＋注意書き
//   ・旧 view（dashboard など）は、画面から呼ばない
//   ・PC（1280）でもスマホ（390）でも、横スクロールしない・押す先が見切れない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import { hubBusy, hubQuiet, hubUnreadable, securityBody } from "../fixtures/keiei-hub.mjs";
import { LINKS } from "../../lib/keiei-hub.js";
import { accessOf as serverAccessOf } from "../../lib/gw.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open({ hub = hubBusy(), security = securityBody(), width = 1280, hash = "" } = {}) {
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  const calls = [];
  const moved = [];
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.removeItem("kp_layout"); localStorage.removeItem("kp_me");
  });
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@b.c", appRole: "owner", isAdmin: false, roles: [],
        gw: { employee: { id: "e1", display_name: "森田 経営", status: "active" }, roles: ["owner"], tenantId: "t1", stage: null },
        access: serverAccessOf({ isAdmin: false, roles: ["owner"] }) });
    }
    if (/\/api\/keiei/.test(url)) {
      const view = new URL(url).searchParams.get("view");
      calls.push(view);
      if (view === "hub") return send(hub);
      if (view === "security") return send(security);
      return send({});
    }
    return send({});
  });
  // 元システムへの遷移は、ページを読み込まずに行き先だけ記録する（行き先の画面のテストではない）
  await page.route(/\/(admin[^/]*\.html|hr\/.*|hr\/?)(\?.*)?$/, (route) => {
    if (route.request().isNavigationRequest()) { moved.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 200, contentType: "text/html", body: "<title>元システム</title>" }); }
    return route.continue();
  });
  await page.goto(`${BASE}/keiei/index.html${hash}`);
  // アイコンフォント（Google Fonts）は、オフラインの環境では読めず、アイコン名が文字で出て幅を取る。
  // 本番と同じ幅（20px の枠）に置き換えて、配置を確かめる
  await page.addStyleTag({ content: ".material-symbols-outlined{font-size:0!important;width:20px;height:20px;display:inline-block;flex:none}" });
  await page.waitForSelector('[data-block="today"], [data-role="owners"], .kei-banner', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  page.calls = calls; page.moved = moved;
  return page;
}
const text = (page) => page.locator("#kei-main").innerText();
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

console.log("— 忙しい日（PC）—");
{
  const page = await open();
  const blocks = await page.locator("[data-block]").evaluateAll((ns) => ns.map((n) => n.dataset.block));
  check(blocks.join() === "today,people,money,risk", `4ブロックだけ。順は ①今日の確認 ②人・組織 ③お金 ④リスク・未処理（いま ${blocks.join()}）`);
  const heads = await page.locator("[data-block] .hub-h").evaluateAll((ns) => ns.map((n) => n.firstChild.textContent.trim()));
  check(heads.join("|") === "今日の確認|人・組織|お金|リスク・未処理", `見出し（いま ${heads.join("|")}）`);
  const ys = await page.locator("[data-block]").evaluateAll((ns) => ns.map((n) => Math.round(n.getBoundingClientRect().top)));
  check(ys.every((y, i) => i === 0 || y > ys[i - 1]), `上から順に並ぶ（${ys.join(",")}）`);
  check(page.calls.join() === "hub", `呼ぶ API は hub だけ（いま ${page.calls.join()}）`);
  check((await text(page)).includes("2026年9月30日（水）"), "今日の日付が出る");

  // ①
  const today = page.locator('[data-block="today"]');
  const keys = await today.locator(".hub-it").evaluateAll((ns) => ns.map((n) => n.dataset.key));
  check(["expense_approval", "request_approval", "ceo_decision", "onboarding_company", "blocker_owner", "renewal_soon", "closing"].every((k) => keys.includes(k)),
    `①に、承認・社長判断・会社の対応待ち・経営判断待ち・契約期限・月次締めが出る（いま ${keys.join()}）`);
  const sevs = await today.locator(".hub-it").evaluateAll((ns) => ns.map((n) => n.dataset.severity));
  const rank = { high: 0, mid: 1, low: 2 };
  check(sevs.every((s, i) => i === 0 || rank[s] >= rank[sevs[i - 1]]), `①は重要度の高い順（${sevs.join(",")}）`);
  check(await today.locator(".hub-it").first().locator(".hub-sev.high").count() === 1, "先頭は「重要」");
  const t1 = await today.innerText();
  check(t1.includes("経費の承認（代表）") && t1.includes("2件が代表の承認待ちです（計 150,000円）"), "何をするか＋件数・金額");
  check(t1.includes("経費精算で承認する") && t1.includes("CEO REVIEWで判断する") && t1.includes("入社準備を開く"), "押す先の名前が、動詞つきで出る");
  check(t1.includes("2026年8月の月次締め") && t1.includes("5日を過ぎても、まだ締まっていません"), "月次締めの未完了");
  check(await today.locator(".hub-count").innerText() === `${keys.length}件`, "①の件数の表示");

  // ②
  const ppl = await page.locator('[data-block="people"] .hub-tile').evaluateAll((ns) => ns.map((n) => [n.dataset.key, n.querySelector(".lb").textContent, n.querySelector(".val").textContent]));
  check(ppl.map((p) => p[0]).join() === "headcount,joining,recruiting,offers,onboarding_open", "②は5つ（在籍・入社予定・採用選考中・内定・入社準備未完了）");
  check(ppl.map((p) => p[2]).join() === "12人,2人,4人,2人,3人", `②の数字（いま ${ppl.map((p) => p[2]).join()}）`);
  check((await page.locator('[data-block="people"]').innerText()).includes("プロパー 10・BP 2"), "在籍の内訳");

  // ③
  const money = page.locator('[data-block="money"]');
  check(await money.locator('[data-role="board"]').count() === 1, "Board の表示は1つだけ");
  check((await money.locator('[data-role="board"]').innerText()) === "売上・請求は Board 連携後に表示します", "Board 未接続の1行");
  check(await money.locator(".hub-tile").count() === 3, "社内の数字は3つ（経費承認待ち・立替支払待ち・会計確認待ち）");
  const mt = await money.innerText();
  check(mt.includes("230,000円") && mt.includes("41,800円") && mt.includes("仕訳（承認前）"), "金額・件数");
  check(!/データ未連携/.test(await page.locator("#kei-main").innerText()), "「データ未連携」の空カードを並べない");
  check(!/今月売上|粗利|入金予定|未入金|キャッシュ/.test(await page.locator("#kei-main").innerText()), "Board 接続前は、売上・粗利・入金の項目を出さない（空カードを置かない）");

  // ④
  const risk = page.locator('[data-block="risk"]');
  const rkeys = await risk.locator(".hub-it").evaluateAll((ns) => ns.map((n) => n.dataset.key));
  check(["join_near", "mfa_missing", "blocker_long", "billing_stale", "recruit_overdue", "renewal_watch"].every((k) => rkeys.includes(k)), `④のリスク（いま ${rkeys.join()}）`);
  const rs = await risk.locator(".hub-it").evaluateAll((ns) => ns.map((n) => n.dataset.severity));
  check(rs.every((s, i) => i === 0 || rank[s] >= rank[rs[i - 1]]), `④は重要度の高い順（${rs.join(",")}）`);
  check(rs[0] === "high", "④の先頭は「重要」");
  check(!keys.some((k) => rkeys.includes(k)), "同じ項目が①と④の両方に出ない");
  check((await risk.locator('[data-key="mfa_missing"] a').getAttribute("href")) === "#security", "二段階認証の警告は、経営設定・セキュリティへ");

  // 給与
  const all = await page.locator("#kei-main").innerText();
  // 入口の説明にある「給与の監査ログ」（給与管理の監査ログへの入口）は、金額ではないので除く
  check(!/給与|基本給|手当|単価|月給|年俸|時給/.test(all.replace("給与の監査ログ", "")), "給与の金額・基本給・手当・単価に関わる項目は出ない");
  check(!/\b0円/.test(all), "「0円」を出さない");

  // 経営設定・セキュリティの入口
  check(await page.locator('[data-role="to-security"]').count() === 1, "経営設定・セキュリティへの小さな入口");
  await page.screenshot({ path: shotPath("keiei-hub-pc.png"), fullPage: true });
  await page.close();
}

console.log("\n— 押した先（元システム）—");
{
  const page = await open();
  const hrefs = await page.locator("#kei-main a[href]").evaluateAll((ns) => ns.map((n) => n.getAttribute("href")));
  const allowed = new Set(Object.values(LINKS));
  check(hrefs.length > 20, `リンクが十分にある（${hrefs.length}）`);
  check(hrefs.every((h) => allowed.has(h)), `リンクは、決めた行き先だけ（外れ: ${hrefs.filter((h) => !allowed.has(h)).join(",") || "なし"}）`);
  check(hrefs.every((h) => h.startsWith("/") || h.startsWith("#")), "外部サイトへは出ない（同じサイトの画面だけ）");

  const goTo = async (selector, expect) => {
    const p = await open();
    await p.click(selector);
    await p.waitForTimeout(600);
    check(p.moved.includes(expect), `${selector} → ${expect}（いま ${p.moved.join() || p.url()}）`);
    await p.close();
  };
  await goTo('[data-block="today"] [data-key="expense_approval"] a', "/admin-expenses.html");
  await goTo('[data-block="today"] [data-key="request_approval"] a', "/admin-requests.html");
  await goTo('[data-block="today"] [data-key="ceo_decision"] a', "/hr/ceo-review.html");
  await goTo('[data-block="today"] [data-key="blocker_owner"] a', "/admin-nippo.html");
  await goTo('[data-block="today"] [data-key="renewal_soon"] a', "/admin-members.html");
  await goTo('[data-block="today"] [data-key="closing"] a', "/admin-closing.html");
  await goTo('[data-block="risk"] [data-key="billing_stale"] a', "/admin-month-start.html");
  await goTo('[data-block="risk"] [data-key="recruit_overdue"] a', "/hr/applicants.html");
  await goTo('[data-block="people"] [data-key="headcount"]', "/admin-members.html");
  await goTo('[data-block="people"] [data-key="recruiting"]', "/hr/applicants.html");
  await goTo('[data-block="money"] [data-key="journals"]', "/admin.html");
  await goTo('[data-block="money"] [data-key="payable"]', "/admin-expenses.html");

  // /keiei の中へ
  await page.click('[data-block="today"] [data-key="onboarding_company"] a');
  await page.waitForTimeout(500);
  check(page.url().endsWith("#onboarding"), "入社準備へ（/keiei の中）");
  check(page.calls.at(-1) === "onboarding", "入社準備の画面が、自分の view を呼ぶ");
  await page.goBack();
  await page.waitForTimeout(500);
  check(page.url().endsWith("#home") || !page.url().includes("#onboarding"), "戻るでホームに戻る");
  await page.click('[data-block="risk"] [data-key="mfa_missing"] a');
  await page.waitForTimeout(500);
  check(page.url().endsWith("#security") && (await text(page)).includes("経営者（owner）"), "二段階認証の警告から、経営設定・セキュリティへ");
  await page.close();
}

console.log("\n— 静かな日（0件は、大きく出さない）—");
{
  const page = await open({ hub: hubQuiet() });
  const today = page.locator('[data-block="today"]');
  check(await today.locator(".hub-it").count() === 0 && await today.locator(".hub-panel").count() === 0, "①: 項目もパネルも出ない");
  check((await today.locator('[data-role="none"]').innerText()) === "今日、経営者が対応するものはありません。", "①: 1行だけ");
  const fs = await today.locator('[data-role="none"]').evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
  check(fs <= 13, `①: 小さく（${fs}px）`);
  check(await today.locator(".hub-count").innerText() === "0件", "①: 0件");
  check((await page.locator('[data-block="risk"] [data-role="none"]').innerText()) === "気付くべき異常はありません。", "④: 1行だけ");
  check(await page.locator('[data-role="unreadable"]').count() === 0, "未読込の注意は出ない");
  check((await page.locator('[data-block="money"] [data-role="board"]').innerText()).includes("Board 連携後"), "Board は未接続の1行のまま");
  await page.screenshot({ path: shotPath("keiei-hub-quiet-pc.png"), fullPage: true });
  await page.close();
}

console.log("\n— 読めなかった元データを、0 にしない —");
{
  const page = await open({ hub: hubUnreadable() });
  const banner = await page.locator('[data-role="unreadable"]').innerText();
  check(banner.includes("経費") && banner.includes("採用") && banner.includes("止まっている仕事"), `注意書きに、読めなかったものが並ぶ（${banner.slice(0, 60)}…）`);
  check(banner.includes("問題がないという意味ではありません"), "「問題なし」と読ませない");
  const miss = await page.locator(".hub-tile .val.miss").count();
  check(miss === 4, `読めなかった数字は「取得できません」（採用選考中・内定・経費承認待ち・立替支払待ち = 4。いま ${miss}）`);
  check(await page.locator('[data-block="money"] [data-key="expense_pending"] .val').innerText() === "取得できません", "経費承認待ち: 取得できません");
  const tiles = await page.locator(".hub-tile").evaluateAll((ns) => ns.map((n) => n.querySelector(".val").textContent));
  check(!tiles.some((v) => v === "0" || v === "0件" || v === "0人"), "読めない数字を 0 と出さない");
  await page.close();
}

console.log("\n— 経営設定・セキュリティ —");
{
  const page = await open({ hash: "#security" });
  const t = await text(page);
  check(page.calls.join() === "security", "security だけを呼ぶ");
  check(t.includes("経営設定・セキュリティ") && (await page.locator("#kei-side a.on").getAttribute("data-view")) === "security", "見出しとメニューの強調");
  const rows = await page.locator('[data-role="owners"] tbody tr').evaluateAll((ns) => ns.map((n) => n.innerText.replace(/\s+/g, " ").trim()));
  check(rows.length === 3 && rows[0].includes("森田 経営") && rows[0].includes("登録済み") && rows[1].includes("未登録") && rows[2].includes("退職"), `経営者と二段階認証の状態（${rows.join(" / ")}）`);
  check(await page.locator('[data-role="warning"][data-key="mfa_missing"]').count() === 1, "未登録の経営者の警告");
  const hist = await page.locator('[data-role="history"] tbody tr').evaluateAll((ns) => ns.map((n) => n.innerText.replace(/\s+/g, " ").trim()));
  check(hist.length === 2 && hist[0].includes("経営者に追加") && hist[0].includes("2026/09/29") && hist[0].includes("経営 二郎"), `経営者の変更履歴（${hist[0]}）`);
  check(hist[1].includes("経営者の二段階認証リセットを断った"), "断った記録も出る");
  check(await page.locator('[data-role="to-pay-audit"]').getAttribute("href") === "#pay-audit", "給与の監査ログへの入口");
  check(t.includes("docs/keiei-owner-recovery.md") && t.includes("2026-10-01"), "復旧手順の案内・強制日");
  check(!/給与の額|基本給|月給/.test(t), "給与の金額は出ない");
  await page.screenshot({ path: shotPath("keiei-security-pc.png"), fullPage: true });
  await page.click('[data-role="to-pay-audit"]');
  await page.waitForTimeout(600);
  check(page.url().endsWith("#pay-audit"), "給与の監査ログへ移る");
  await page.close();

  const p2 = await open({ hash: "#security", security: { status: "missing", reason: "経営者の一覧を読めませんでした", missingLabel: "データ未連携" } });
  check((await text(p2)).includes("データ未連携") && !(await text(p2)).includes("0人"), "経営者の一覧が読めないときは「データ未連携」（0人と出さない）");
  await p2.close();
}

console.log("\n— スマホ幅（390px / 360px）—");
for (const width of [390, 360]) {
  const page = await open({ width });
  check(await overflow(page) <= 0, `${width}px ホーム: 横スクロールが出ない（はみ出し ${await overflow(page)}px）`);
  const goes = await page.locator('[data-block="today"] .hub-go').evaluateAll((ns) => ns.map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }));
  check(goes.length >= 6 && goes.every(([l, r]) => l >= 0 && r <= width), `${width}px: 押す先のボタンが、画面の中に収まる`);
  const tiles = await page.locator('[data-block="people"] .hub-tile').evaluateAll((ns) => ns.map((n) => Math.round(n.getBoundingClientRect().left)));
  check(new Set(tiles).size === 2, `${width}px: 人数の数字は2列（${[...new Set(tiles)].join(",")}）`);
  if (width === 390) await page.screenshot({ path: shotPath("keiei-hub-sp.png"), fullPage: true });
  await page.close();

  const q = await open({ width, hub: hubQuiet() });
  check(await overflow(q) <= 0, `${width}px 静かな日: 横スクロールが出ない`);
  if (width === 390) await q.screenshot({ path: shotPath("keiei-hub-quiet-sp.png"), fullPage: true });
  await q.close();

  const s = await open({ width, hash: "#security" });
  check(await overflow(s) <= 0, `${width}px 経営設定・セキュリティ: 横スクロールが出ない（はみ出し ${await overflow(s)}px）`);
  await s.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
