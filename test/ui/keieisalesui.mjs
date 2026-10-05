// 経営ハブ（/keiei ホーム）の「10月の目標と実績」「営業ファネル・担当者別」を、実際のブラウザで見る（2026-10 経営方針 §12 Phase 1）。
//
// ■ 何を守りたいのか
//   ・並び：今日の確認 → 10月の目標と実績 → お金 → 人・組織 → 営業ファネル・担当者別 → リスク・未処理
//   ・ファネル：目標・今日の目安・実績・達成率。有効企業・本命案件は「定義未決」（0 と出さない）
//   ・PC/IT機器売上（1,000万円）は「未接続」（金額を作らない）。EC・Space は未接続の1行だけ
//   ・停滞案件は「今日の確認」に1項目＋営業の欄に一覧。押すと Sales の会社へ
//   ・担当者別：実績のあるものは 実績／目標、数えられないものは「記録なし」「定義未決」「未接続」
//   ・営業を読めない（sales: null）ときも、ほかのブロックは出る
//   ・1280 / 768 / 390 で横にはみ出さない。画面のエラーが無い
import { launch, BASE } from "../_browser.mjs";
import { hubOctober, salesFacts } from "../fixtures/keiei-hub.mjs";
import { accessOf as serverAccessOf } from "../../lib/gw.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open({ hub = hubOctober(), width = 1280 } = {}) {
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.(googleapis|gstatic)|net::ERR|Failed to load resource/.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.removeItem("kp_layout"); localStorage.removeItem("kp_me");
  });
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) {
      return send({ email: "a@b.c", appRole: "owner", isAdmin: false, roles: [],
        gw: { employee: { id: "e1", display_name: "テスト 経営", status: "active" }, roles: ["owner"], tenantId: "t1", stage: null },
        access: serverAccessOf({ isAdmin: false, roles: ["owner"] }) });
    }
    if (/\/api\/keiei/.test(url)) return send(hub);
    return send({});
  });
  await page.goto(`${BASE}/keiei/index.html`);
  await page.addStyleTag({ content: ".material-symbols-outlined{font-size:0!important;width:20px;height:20px;display:inline-block;flex:none}" });
  await page.waitForSelector('[data-block="today"]', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  page.errs = errs;
  return page;
}
const textOf = (page, sel) => page.locator(sel).innerText();

console.log("— 10月のホーム（PC 1280）—");
{
  const page = await open();
  const blocks = await page.locator("[data-block]").evaluateAll((ns) => ns.map((n) => n.dataset.block));
  check(blocks.join() === "today,kgi,money,people,sales,risk", `並び：今日の確認→目標と実績→お金→人・組織→営業→リスク（いま ${blocks.join()}）`);
  const kgiHead = (await page.locator('[data-block="kgi"] .hub-h').innerText()).trim();
  check(kgiHead === "10月の目標と実績", `見出し「10月の目標と実績」（いま ${kgiHead}）`);

  // ファネル
  const rows = await page.locator('[data-role="funnel"] tbody tr').evaluateAll((ns) => ns.map((n) => [n.dataset.stage, n.innerText.replace(/\s+/g, " ").trim()]));
  check(rows.map((r) => r[0]).join() === "contact,effective,meeting,proposal,won,key", `段階：接触→有効企業→商談→提案→有料契約→本命案件（${rows.map((r) => r[0]).join()}）`);
  const row = (k) => rows.find((r) => r[0] === k)[1];
  check(row("contact").includes("4,000件") && row("contact").includes("645件") && row("contact").includes("120件") && row("contact").includes("3%"), `接触：目標4,000・今日の目安645・実績120・3%（${row("contact")}）`);
  check(row("meeting").includes("30件") && row("meeting").includes("5件") && row("meeting").includes("17%"), `商談：目標30・実績5・17%（${row("meeting")}）`);
  check(row("effective").includes("定義未決") && !/\b0件/.test(row("effective")), `有効企業は「定義未決」で、0件と出さない（${row("effective")}）`);
  check(row("key").includes("定義未決"), "本命案件は「定義未決」");
  const kgi = await textOf(page, '[data-block="kgi"]');
  check(kgi.includes("商談→提案 60%（計画 50%）") && kgi.includes("提案→有料契約 33.3%（計画 67%）"), "転換率（実績と計画）");
  check(kgi.includes("480,000円") && kgi.includes("会計上の売上・粗利ではありません"), "受注額は案件金額で、会計上の売上と区別して出す");
  const pc = await textOf(page, '[data-role="pc"]');
  check(pc.includes("PC/IT機器売上") && pc.includes("1,000万円") && pc.includes("未接続"), `PC/IT機器売上：目標1,000万円・未接続（${pc.replace(/\s+/g, " ")}）`);

  // 今日の確認に停滞
  const stall = page.locator('[data-block="today"] [data-key="sales_stalled"]');
  check(await stall.count() === 1 && (await stall.innerText()).includes("提案後に止まっている案件"), "今日の確認に「提案後に止まっている案件」");
  check(await stall.locator("a").getAttribute("href") === "/sales/", "押すと Sales へ");
  check(await page.locator('[data-block="risk"] [data-key="sales_stalled"]').count() === 0, "リスクには同じ事実を出さない");

  // 営業ファネル・担当者別
  const sales = await textOf(page, '[data-block="sales"]');
  const nakamura = (await textOf(page, '[data-person="中村 次郎"]')).replace(/\s+/g, " ");
  check(nakamura.includes("90件") && nakamura.includes("目標 2,000件") && nakamura.includes("定義未決"), `中村：接触 90／2,000・有効企業は定義未決（${nakamura}）`);
  const kudo = (await textOf(page, '[data-person="工藤 五郎"]')).replace(/\s+/g, " ");
  check(kudo.includes("1,000万円") && kudo.includes("未接続") && kudo.includes("記録なし"), `工藤：PC売上は未接続・診断送客は記録なし（${kudo}）`);
  const fujimoto = (await textOf(page, '[data-person="藤本 三郎"]')).replace(/\s+/g, " ");
  check(fujimoto.includes("50%") && fujimoto.includes("提案1／商談2"), `藤本：提案率 50%（提案1／商談2）（${fujimoto}）`);
  check(await page.locator('[data-person="池永 四郎"] .v.ng').count() === 1, "池永：停滞（目標0件）を超えていれば赤");
  const st = page.locator('[data-role="stalled"] .st-row');
  check(await st.count() === 1 && (await st.innerText()).includes("テスト株式会社2") && (await st.innerText()).includes("10日"), "停滞案件の一覧（会社・日数）");
  check(await st.locator("a").getAttribute("href") === "/sales/companies.html?id=cd2", "押すと Sales のその会社へ");
  check(sales.includes("アタック済") && sales.includes("今月分ではありません"), "Sales の企業の今の状態（今月分ではないと明記）");
  const un = await textOf(page, '[data-role="unconnected"]');
  check(un.includes("EC・PC販売") && un.includes("Space") && !un.includes("Board"), "未接続の1行（EC・Space。Board はお金の欄にある）");
  const bodyText = await textOf(page, "#kei-main");
  check(!/NaN|undefined|null/.test(bodyText), "NaN・undefined・null の文字が出ない");
  check(page.errs.length === 0, `画面のエラーが無い ${page.errs.join(" / ").slice(0, 160)}`);
  await page.close();
}

console.log("\n— 案件の表が無い環境 —");
{
  const page = await open({ hub: hubOctober({ ...salesFacts(), dealState: "absent", deals: null, history: null }) });
  const rows = await page.locator('[data-role="funnel"] tbody tr').evaluateAll((ns) => Object.fromEntries(ns.map((n) => [n.dataset.stage, n.innerText.replace(/\s+/g, " ")])));
  check(rows.meeting.includes("取得できません") && rows.meeting.includes("まだ使えません"), `商談：取得できません（理由つき）（${rows.meeting}）`);
  check(rows.contact.includes("120件"), "接触は数える");
  check(await page.locator('[data-block="today"] [data-key="sales_stalled"]').count() === 0, "停滞は今日の確認に出さない（数えられない）");
  check((await textOf(page, '[data-role="stalled-missing"]')).includes("取得できません"), "停滞案件：取得できません");
  check((await textOf(page, '[data-role="won-amount"]')).includes("取得できません"), "受注額：取得できません");
  check(page.errs.length === 0, "画面のエラーが無い");
  await page.close();
}

console.log("\n— 営業を読めない（sales: null）—");
{
  const page = await open({ hub: { ...hubOctober(), sales: null } });
  const blocks = await page.locator("[data-block]").evaluateAll((ns) => ns.map((n) => n.dataset.block));
  check(blocks.join() === "today,kgi,money,people,risk", `目標の欄に「取得できません」、ほかのブロックは出る（${blocks.join()}）`);
  check((await textOf(page, '[data-role="sales-missing"]')).includes("取得できません"), "営業の数字を、いま取得できません");
  check(page.errs.length === 0, "画面のエラーが無い");
  await page.close();
}

console.log("\n— 768px・390px —");
for (const width of [768, 390]) {
  const page = await open({ width });
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(ov <= 0, `${width}px：横にはみ出さない（${ov}px）`);
  const funnelOv = await page.locator('[data-role="funnel"]').evaluate((t) => t.scrollWidth - t.parentElement.clientWidth);
  check(funnelOv <= 0, `${width}px：ファネルの表が枠に収まる（${funnelOv}px）`);
  if (width === 390) {
    check(!(await page.locator('[data-role="funnel"] th.pace').isVisible()), "390px：「今日の目安」の列は畳む（実績・達成率を優先）");
    const go = await page.locator('[data-role="stalled"] a').boundingBox();
    check(go && go.x + go.width <= 390, "390px：停滞案件の「Salesで開く」が見切れない");
  }
  check(page.errs.length === 0, `${width}px：画面のエラーが無い`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
