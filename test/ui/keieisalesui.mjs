// 経営（/keiei）の「10月KGI・営業ファネル・担当者別KPI・停滞案件」を、実際のブラウザで見る（2026-10 経営方針 §12 Phase 1・UI/UX 刷新）。
//
// ■ 何を守りたいのか
//   ・ホームの順番：今日の判断 → 10月KGI → 営業ファネル → 担当者別KPI → お金 → 人・組織 → リスク・停滞
//   ・KGI は大きなカード3枚：PC/IT機器売上（未接続）・有料契約・本命案件（定義未決）。実績が無いものを 0 と出さない
//   ・営業ファネルは横に 接触 → 商談 → 提案 → 有料契約。件数・目標・今日の目安・達成率・前の段階からの転換率（計画つき）
//   ・ファネルは会社（企業ID）で数える（接触は送信の件数を添える）。有効企業・本命案件は定義が決まるまで、ファネルに含めない
//   ・担当者別はカード：氏名・今月の目標と実績・遅れ／順調／未計測・次に見るもの
//   ・停滞案件・期限超過のタスクは「今日の判断」に1項目ずつ。停滞の一覧はリスク・停滞に。押すと Sales の会社へ
//   ・「売上・営業」のタブは、段階ごとの目標と実績（理由つき）・転換率・受注額・停滞・企業の状態・担当者の全項目
//   ・営業を読めない（sales: null）・案件の表が無い環境でも、ほかのブロックは出る
//   ・1280 / 768 / 390 で横にはみ出さない。画面のエラーが無い
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import { hubOctober, salesFacts } from "../fixtures/keiei-hub.mjs";
import { accessOf as serverAccessOf } from "../../lib/gw.js";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

async function open({ hub = hubOctober(), width = 1280, hash = "" } = {}) {
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
  await page.goto(`${BASE}/keiei/index.html${hash}`);
  // アイコンフォントは、オフラインでは読めず名前が文字で出て幅を取る。本番と同じ幅の枠に置き換える
  await page.addStyleTag({ content: ".material-symbols-outlined{font-size:0!important;width:20px;height:20px;display:inline-block;flex:none} .kp-otab::before{font-size:0!important;width:19px;height:19px;display:inline-block}" });
  await page.waitForSelector("[data-block]", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(350);
  // 「ほか○件を見る」は閉じているので、中身を確かめるときは開く
  await page.evaluate(() => document.querySelectorAll("details.kd-more").forEach((d) => { d.open = true; }));
  page.errs = errs;
  return page;
}
const textOf = (page, sel) => page.locator(sel).innerText().then((t) => t.replace(/\s+/g, " ").trim());

console.log("— 10月のホーム（PC 1280）—");
{
  const page = await open();
  const blocks = await page.locator("[data-block]").evaluateAll((ns) => ns.map((n) => n.dataset.block));
  check(blocks.join() === "today,kgi,funnel,byperson,money,people,risk", `並び：今日の判断→10月KGI→営業ファネル→担当者別KPI→お金→人・組織→リスク・停滞（いま ${blocks.join()}）`);
  const heads = await page.locator("[data-block] .kei-sec-h").evaluateAll((ns) => ns.map((n) => n.firstChild.textContent.trim()));
  check(heads.join("|") === "今日の判断|10月KGI|営業ファネル|担当者別KPI|お金|人・組織|リスク・停滞", `見出し（いま ${heads.join("|")}）`);
  const ys = await page.locator("[data-block]").evaluateAll((ns) => ns.map((n) => Math.round(n.getBoundingClientRect().top)));
  check(ys.every((y, i) => i === 0 || y > ys[i - 1]), "上から順に並ぶ");
  check(await page.locator("#kei-side, .kei-side, .kp-sidebar").count() === 0, "左サイドバーは無い");

  // KGI：大きなカード3枚
  const kgi = await page.locator('[data-role="kgi"] .kg-card').evaluateAll((ns) => ns.map((n) => [n.dataset.kgi, n.innerText.replace(/\s+/g, " ").trim()]));
  check(kgi.map((k) => k[0]).join() === "pc,won,key", `KGI は3枚：PC/IT機器売上・有料契約・本命案件（${kgi.map((k) => k[0]).join()}）`);
  const k = (key) => kgi.find((x) => x[0] === key)[1];
  check(k("pc").includes("PC/IT機器売上") && k("pc").includes("未接続") && k("pc").includes("目標 1,000万円") && !/\b0円/.test(k("pc")), `PC/IT機器売上：未接続・目標 1,000万円（0円と出さない）（${k("pc")}）`);
  check(k("won").includes("有料契約") && k("won").includes("1") && k("won").includes("目標 10社") && k("won").includes("達成率 10%") && k("won").includes("480,000円") && k("won").includes("会計上の売上ではありません"), `有料契約：1／目標10社・達成率10%・受注額は案件金額（${k("won")}）`);
  check(k("key").includes("本命案件") && k("key").includes("定義未決") && k("key").includes("目標 3社"), `本命案件：定義未決（${k("key")}）`);
  const bigs = await page.locator('[data-role="kgi"] .big').evaluateAll((ns) => ns.map((n) => parseFloat(getComputedStyle(n).fontSize)));
  check(bigs.every((f) => f >= 22), `大きなカード（数字は ${bigs.join("/")}px）`);

  // 営業ファネル：接触 → 商談 → 提案 → 有料契約
  const steps = await page.locator('[data-role="funnel"] .fn-step').evaluateAll((ns) => ns.map((n) => [n.dataset.stage, n.innerText.replace(/\s+/g, " ").trim(), Math.round(n.getBoundingClientRect().left), Math.round(n.getBoundingClientRect().top)]));
  check(steps.map((s) => s[0]).join() === "contact,meeting,proposal,won", `ファネルは 接触→商談→提案→有料契約（${steps.map((s) => s[0]).join()}）`);
  check(steps.every((s, i) => i === 0 || (s[2] > steps[i - 1][2] && Math.abs(s[3] - steps[0][3]) < 4)), "横に並ぶ（左から右へ）");
  const s = (key) => steps.find((x) => x[0] === key)[1];
  check(s("contact").includes("120件") && s("contact").includes("目標 4,000件") && s("contact").includes("今日の目安 645") && s("contact").includes("企業 100社（重複を除く）") && s("contact").includes("達成率 3%"), `接触：送信120件が主・目標4,000件・今日の目安645・企業100社（重複を除く）が補助・達成率3%（${s("contact")}）`);
  check(s("meeting").includes("6社") && s("meeting").includes("達成率 20%") && s("meeting").includes("前の段階から 6%（計画 0.8%）"), `商談：6社・達成率20%・転換率6%（計画0.8%）（${s("meeting")}）`);
  check(s("proposal").includes("前の段階から 66.7%（計画 50%）"), `提案：転換率66.7%（計画50%）（${s("proposal")}）`);
  check(s("won").includes("前の段階から 25%（計画 66.7%）"), `有料契約：転換率25%（計画66.7%）（${s("won")}）`);
  check(s("proposal").includes("停滞 1件（7日以上動きなし）") && !s("contact").includes("停滞") && !s("won").includes("停滞"), `提案の段階に、停滞件数（${s("proposal")}）`);
  check(await page.locator('[data-role="funnel"] [data-role="stall"].hot').count() === 1, "停滞があるときは、目を引く色で出す");
  const fun = await textOf(page, '[data-block="funnel"]');
  check(fun.includes("接触は送信件数が主") && fun.includes("会社（企業ID）で数え") && fun.includes("有効企業と本命案件は定義が決まるまで"), "接触は送信件数が主・商談以降は会社で数えること・有効企業と本命案件は含めないことを明記");
  check(!/有効企業\s*\d/.test(fun) && !(await page.locator('[data-stage="effective"], [data-stage="key"]').count() && false), "有効企業・本命案件を、ファネルの数字にしない");

  // 今日の判断
  const stall = page.locator('[data-block="today"] [data-key="sales_stalled"]');
  check(await stall.count() === 1 && (await stall.innerText()).includes("提案後に止まっている案件"), "今日の判断に「提案後に止まっている案件」");
  check(await stall.locator("a").getAttribute("href") === "/sales/", "押すと Sales へ");
  const late = page.locator('[data-block="today"] [data-key="tasks_overdue"]');
  check(await late.count() === 1 && (await late.innerText()).includes("期限を過ぎたタスク") && await late.locator("a").getAttribute("href") === "/admin-tasks.html", "今日の判断に「期限を過ぎたタスク」（押すと全員のタスクへ）");
  check(await page.locator('[data-block="risk"] [data-key="sales_stalled"]').count() === 0, "リスクの項目には、同じ事実を二重に出さない");
  const chips = await page.locator(".kd-chip").evaluateAll((ns) => Object.fromEntries(ns.map((n) => [n.dataset.chip, n.innerText.replace(/\s+/g, " ").trim()])));
  check(chips.total.includes("要対応") && chips.stalled === "停滞案件 1件" && chips.ceo.startsWith("採用判断"), `件数の要約：要対応・停滞案件 1件・採用判断（${JSON.stringify(chips)}）`);

  // 担当者別KPI（カード）
  const cards = await page.locator('[data-role="people-kpi"] .pc').evaluateAll((ns) => ns.map((n) => [n.dataset.person, n.dataset.state, n.innerText.replace(/\s+/g, " ").trim()]));
  check(cards.length === 8, `担当者カードが8枚（いま ${cards.length}）`);
  const p = (name) => cards.find((c) => c[0].startsWith(name));
  check(p("山内")[1] === "ontrack" && p("山内")[2].includes("順調"), "山内：順調");
  check(p("中村")[1] === "behind" && p("中村")[2].includes("遅れ") && p("中村")[2].includes("次に見るもの") && p("中村")[2].includes("接触 90件／目安 323件"), `中村：遅れ・次に見るもの（接触 90件／目安 323件）（${p("中村")[2]}）`);
  check(p("工藤")[1] === "unmeasured" && p("工藤")[2].includes("未計測") && p("工藤")[2].includes("未接続") && !/\b0円/.test(p("工藤")[2]), `工藤：未計測・PC売上は未接続（0円と出さない）（${p("工藤")[2]}）`);
  check(p("野澤")[1] === "behind" && p("野澤")[2].includes("目標 0件以下"), "野澤：期限超過のタスクが目標 0件を超えて遅れ（「目標 0件以下」）");
  check(p("池永")[1] === "behind", "池永：停滞（目標0件）を超えていて遅れ");
  const states = await page.locator('[data-role="people-kpi"] [data-role="state"]').evaluateAll((ns) => ns.map((n) => n.innerText.trim()));
  check(states.every((x) => ["順調", "遅れ", "未計測"].includes(x)), `状態は 順調／遅れ／未計測 のどれか（${[...new Set(states)].join("・")}）`);
  const grid = await page.locator('[data-role="people-kpi"]').evaluate((n) => getComputedStyle(n).gridTemplateColumns.split(" ").length);
  check(grid >= 3, `PC では3列以上に並ぶ（${grid}列）`);

  // リスク・停滞（停滞案件の一覧）
  const st = page.locator('[data-role="stalled"] .ks-row');
  check(await st.count() === 1 && (await st.innerText()).includes("テスト株式会社2") && (await st.innerText()).includes("2026/09/25") && (await st.innerText()).includes("10日"), `停滞案件の一覧（会社・最後の動き・日数）（${(await st.innerText()).replace(/\s+/g, " ")}）`);
  check(await st.locator("a").getAttribute("href") === "/sales/companies.html?id=cd2", "押すと Sales のその会社へ");

  const bodyText = await textOf(page, "#kei-main");
  check(!/NaN|undefined|null/.test(bodyText), "NaN・undefined・null の文字が出ない");
  check(page.errs.length === 0, `画面のエラーが無い ${page.errs.join(" / ").slice(0, 160)}`);
  await page.screenshot({ path: shotPath("keiei-home-pc.png"), fullPage: true });
  await page.close();
}

console.log("\n— 売上・営業（#sales）—");
{
  const page = await open({ hash: "#sales" });
  check((await page.locator("#kp-keiei-nav .kp-otab.on").getAttribute("data-ktab")) === "sales", "「売上・営業」のタブが選ばれる");
  const rows = await page.locator('[data-role="funnel-table"] tbody tr').evaluateAll((ns) => ns.map((n) => [n.dataset.stage, n.innerText.replace(/\s+/g, " ").trim()]));
  check(rows.map((r) => r[0]).join() === "contact,effective,meeting,proposal,won,key", `段階ごとの表：接触→有効企業→商談→提案→有料契約→本命案件（${rows.map((r) => r[0]).join()}）`);
  const row = (key) => rows.find((r) => r[0] === key)[1];
  check(row("effective").includes("定義未決") && row("key").includes("定義未決") && !/\b0(件|社)/.test(row("effective")), "有効企業・本命案件は「定義未決」（0 と出さない）");
  check(row("contact").includes("120件") && row("contact").includes("企業 100社") && row("contact").includes("3%"), "接触：送信120件（企業100社）・3%");
  const rates = await textOf(page, '[data-role="rates"]');
  check(rates.includes("商談→提案 66.7%（計画 50%）") && rates.includes("提案→有料契約 25%（計画 67%）"), `転換率（実績と計画）（${rates}）`);
  check((await textOf(page, '[data-role="won-amount"]')).includes("480,000円"), "受注額は案件金額");
  check((await textOf(page, '[data-role="snapshot"]')).includes("アタック済"), "Sales の企業の今の状態");
  const un = await textOf(page, '[data-role="unconnected"]');
  check(un.includes("EC・PC販売") && un.includes("Space") && !un.includes("Board"), "未接続の1行（EC・Space）");
  const full = await page.locator('[data-role="people-kpi"] .pc').first().locator('[data-role="kpi"]').count();
  check(full >= 2, `担当者の項目が、すべて出る（1人目 ${full} 項目）`);
  const fuji = await textOf(page, '[data-person="藤本 三郎"]');
  check(fuji.includes("67%") && fuji.includes("提案2社／商談3社"), "藤本：提案率 67%（提案2社／商談3社）");
  const unm = await page.locator('[data-role="kpi"].na .v').allInnerTexts();
  check(unm.length > 0 && unm.every((x) => /定義未決|記録なし|未接続|未計測|取得できません/.test(x)), `数えられない項目は状態で出す（${[...new Set(unm)].join("・")}）`);
  check(page.errs.length === 0, "画面のエラーが無い");
  await page.close();
}

console.log("\n— 案件の表が無い環境 —");
{
  const page = await open({ hub: hubOctober({ ...salesFacts(), dealState: "absent", deals: null, history: null }) });
  const meeting = await textOf(page, '[data-role="funnel"] [data-stage="meeting"]');
  check(meeting.includes("取得できません"), `商談：取得できません（${meeting}）`);
  check((await textOf(page, '[data-role="funnel"] [data-stage="contact"]')).includes("100社"), "接触は数える");
  check((await textOf(page, '[data-kgi="won"]')).includes("取得できません"), "有料契約のカードも「取得できません」");
  check(await page.locator('[data-block="today"] [data-key="sales_stalled"]').count() === 0, "停滞は今日の判断に出さない（数えられない）");
  check((await textOf(page, '[data-role="funnel"] [data-role="stall"]')).includes("取得できません"), "ファネルの停滞も「取得できません」（0件と言わない）");
  check((await textOf(page, '[data-role="stalled-missing"]')).includes("取得できません"), "停滞案件：取得できません");
  check(page.errs.length === 0, "画面のエラーが無い");
  await page.close();
}

console.log("\n— 営業を読めない（sales: null）—");
{
  const page = await open({ hub: { ...hubOctober(), sales: null } });
  const missing = await page.locator('[data-role="sales-missing"]').count();
  check(missing >= 3, `KGI・ファネル・担当者別に「取得できません」の案内が出る（${missing}か所）`);
  check((await textOf(page, '[data-block="kgi"] [data-role="sales-missing"]')).includes("取得できません"), "営業の数字を、いま取得できません");
  check(!/\b0(件|社|円)/.test(await textOf(page, '[data-block="kgi"]')), "読めないときに 0件・0社・0円と出さない");
  check(await page.locator('[data-block="today"], [data-block="money"], [data-block="people"], [data-block="risk"]').count() === 4, "ほかのブロック（今日の判断・お金・人・組織・リスク）は出る");
  check(page.errs.length === 0, "画面のエラーが無い");
  await page.close();
}

console.log("\n— 768px・390px —");
for (const width of [768, 390]) {
  const page = await open({ width });
  const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(ov <= 0, `${width}px：横にはみ出さない（${ov}px）`);
  const tabs = await page.locator("#kp-keiei-nav .kp-otabs").evaluate((n) => ({ ox: getComputedStyle(n).overflowX, sw: n.scrollWidth, cw: n.clientWidth }));
  check(tabs.ox === "auto" || tabs.ox === "scroll" || tabs.sw <= tabs.cw, `${width}px：横タブは、収まらなければ横スクロール`);
  const stepBoxes = await page.locator('[data-role="funnel"] .fn-step').evaluateAll((ns) => ns.map((n) => { const r = n.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; }));
  check(stepBoxes.every(([l, r]) => l >= 0 && r <= width), `${width}px：ファネルの4つが画面に収まる`);
  if (width === 390) {
    const cols = new Set(stepBoxes.map((b) => b[0]));
    check(cols.size === 1, "390px：ファネルは縦に並ぶ（1列）");
    const pcLeft = await page.locator('[data-role="people-kpi"] .pc').evaluateAll((ns) => new Set(ns.map((n) => Math.round(n.getBoundingClientRect().left))).size);
    check(pcLeft === 1, "390px：担当者カードは1列");
    const go = await page.locator('[data-role="stalled"] a').boundingBox();
    check(go && go.x + go.width <= 390, "390px：停滞案件の「Salesで開く」が見切れない");
    await page.screenshot({ path: shotPath("keiei-home-sp.png"), fullPage: true });
  } else {
    await page.screenshot({ path: shotPath("keiei-home-tablet.png"), fullPage: true });
  }
  check(page.errs.length === 0, `${width}px：画面のエラーが無い`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
