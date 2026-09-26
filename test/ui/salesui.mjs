// 営業アタック管理（/sales）を、実際のブラウザで通す。
//
// ■ 何を守るテストか
//
//   1. 営業担当としてログインすると、専用ヘッダー（EIGHT/SALES・5ナビ）が出る
//   2. ダッシュボードの「今やること」に、未対応クリックが件数つきで出る
//   3. 企業一覧 → 右ドロワー → フォームアタック → 本文に専用URLが入る →
//      「送信完了」で本文つきの記録が送られる
//   4. 直近30日以内にアタック済みなら、警告が出て送れない（営業担当には押し切りボタンを出さない）
//   5. 権限の無い人は home.html へ送り返される
//   6. スマホ幅でも横にはみ出さない
import { launch, BASE, jstToday } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const SALES = { id: "emp-s1", display_name: "営業 一郎", status: "active" };
const TODAY = jstToday();
const NOW = new Date().toISOString();

function company(over) {
  return {
    id: "c1", name: "株式会社サンプル", domain: "sample.co.jp", siteUrl: "https://sample.co.jp/",
    formUrl: "https://sample.co.jp/contact", industry: "製造", region: "東京都", service: "AI / DX",
    ownerId: "emp-s1", ownerName: "営業 一郎", status: "untouched", statusLabel: "未アタック",
    ngReason: null, ngLabel: null, attackCount: 0, lastSentAt: null, clickCount: 0, firstClickAt: null,
    lastClickAt: null, unhandledClick: false, next: "フォームアタック", nextKey: "attack", nextDue: null,
    overdue: false, campaignId: null, campaignName: null, ...over,
  };
}

async function openAs({ roles = ["sales"], isAdmin = false, recent = null } = {}) {
  const calls = [];
  const companies = [
    company({}),
    company({ id: "c2", name: "反応商事", domain: "hannou.jp", status: "clicked", statusLabel: "クリックあり",
      attackCount: 1, lastSentAt: NOW, clickCount: 2, firstClickAt: NOW, lastClickAt: NOW, unhandledClick: true,
      next: "クリックあり・要フォロー", nextKey: "follow_click", nextDue: TODAY }),
    // 返信まで進んだ会社（クリック1回・対応済み）。リードでは、クリックだけの会社より上に出る
    company({ id: "c3", name: "返信工業", domain: "henshin.jp", status: "replied", statusLabel: "返信あり",
      attackCount: 1, lastSentAt: NOW, clickCount: 1, firstClickAt: NOW, lastClickAt: NOW, unhandledClick: false,
      next: "返信対応", nextKey: "manual", nextDue: TODAY }),
  ];
  const page = await br.newPage({ viewport: { width: 1300, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "sales@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());

  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");

    if (/\/api\/me\b/.test(url)) {
      return send({ email: "sales@8grp.co.jp", appRole: isAdmin ? "admin" : "member", isAdmin, shows: {},
        gw: { employee: SALES, roles, isAdmin, tenantId: "t1", stage: null } });
    }
    if (/\/api\/sales\/companies\/detail/.test(url)) {
      const id = new URL(url).searchParams.get("id");
      const c = companies.find((x) => x.id === id);
      return send({
        today: TODAY, company: c, approaches: [], recent,
        timeline: c.lastSentAt ? [{ at: c.lastSentAt, kind: "attack", label: "フォーム送信" },
          { at: c.lastClickAt, kind: "click", label: "リンククリック" }] : [],
        canForce: isAdmin, members: [{ id: "emp-s1", display_name: "営業 一郎" }], campaigns: [],
        statuses: [{ key: "untouched", label: "未アタック" }, { key: "attacked", label: "アタック済" }],
        ngReasons: [{ key: "no_sales", label: "営業禁止" }],
        eventKinds: [{ key: "follow", label: "フォロー" }, { key: "reply", label: "返信あり" }],
      });
    }
    if (/\/api\/sales\/lookup\b/.test(url)) {
      const u = new URL(url).searchParams.get("url");
      calls.push({ kind: "lookup", url: u });
      if (/sample\.co\.jp/.test(u)) return send({ url: u, domain: "sample.co.jp", duplicate: { id: "c1", name: "株式会社サンプル" }, ok: true });
      if (/noname/.test(u)) return send({ url: `https://${new URL(u).hostname}/`, domain: new URL(u).hostname, duplicate: null, ok: false, reason: "http" });
      const host = new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "");
      return send({ url: `https://${host}/`, domain: host, duplicate: null, ok: true,
        name: `株式会社${host.split(".")[0].toUpperCase()}`, formUrl: `https://${host}/contact/`, phone: "03-1234-5678", address: null });
    }
    if (/\/api\/sales\/companies\b/.test(url)) {
      if (req.method() === "POST") {
        const b = body();
        calls.push({ kind: b.companies ? "bulk" : "create", body: b });
        if (b.companies) return send({ created: b.companies.length, skipped: 0 });
        const made = company({ id: "c-new", name: b.name, siteUrl: b.siteUrl, formUrl: b.formUrl, service: b.service });
        companies.push(made);
        return send({ company: made });
      }
      return send({ today: TODAY, me: "emp-s1", members: [{ id: "emp-s1", display_name: "営業 一郎" }], companies });
    }
    if (/\/api\/sales\/templates\b/.test(url)) {
      return send({ services: [], templates: [{ id: "t1", name: "DX基本", service: "AI / DX", subject: null,
        body: "{{company}}\nご担当者様\n\n{{sender}}です。\n詳細はこちら\n{{url}}", destinationUrl: "https://8grp.co.jp/service/dx",
        archived: false, uses: 0 }] });
    }
    if (/\/api\/sales\/approaches\b/.test(url)) {
      if (req.method() === "POST") {
        calls.push({ kind: "prepare", body: body() });
        if (recent && !body().force) return send({ error: "recent_attack", recent, canForce: isAdmin, hint: "直近30日以内にアタックされています" }, 409);
        return send({ approach: { id: "ap1", trackingToken: "X7K92PABCD", sentAt: null },
          trackingUrl: "https://gw.8grp.co.jp/r/X7K92PABCD" });
      }
      if (req.method() === "PATCH") {
        calls.push({ kind: "act", body: body() });
        return send({ approach: { id: "ap1", sentAt: NOW } });
      }
      return send({ approaches: [] });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  return { page, calls, errs };
}

console.log("\n=== 営業担当：ダッシュボード ===");
{
  const { page, errs } = await openAs();
  await page.goto(`${BASE}/sales/index.html`);
  await page.waitForTimeout(1000);

  check((await page.locator(".sl-logo").innerText()).includes("SALES"), "EIGHT/SALES のロゴが出る");
  const nav = await page.locator(".sl-nav a").allInnerTexts();
  check(nav.length === 5, `ナビは5つ（いま ${nav.length}: ${nav.join(" / ")}）`);
  check(["ダッシュボード", "企業", "アタック", "リード", "分析"].every((l) => nav.some((t) => t.includes(l))),
    "ダッシュボード／企業／アタック／リード／分析");
  check(!nav.some((t) => t.includes("反応")), "「反応」タブは無くなった（リードへ）");
  check((await page.locator(".sl-nav a.on").innerText()).includes("ダッシュボード"), "いま見ているタブが選ばれている");

  const order = await page.locator(".db-sec .db-sec-h .t").allInnerTexts();
  check(order.join("|") === "🔥 ① リード・未対応|② 返信あり|③ 今日フォロー|④ 今日アタック|⑤ 最近の営業履歴",
    `上から クリック→返信→フォロー→アタック→履歴（いま ${order.join(" / ")}）`);
  check(await page.locator(".db-sec").first().evaluate((e) => e.id) === "sec-click", "いちばん上はリード・未対応");
  const bg = await page.locator("#sec-click").evaluate((e) => getComputedStyle(e).backgroundColor);
  check(bg !== "rgba(0, 0, 0, 0)", `クリックありは色で目立たせる（${bg}）`);
  check((await page.locator("#list-click").innerText()).includes("反応商事"), "クリックした企業が①に出る");
  check((await page.locator(".db-sum a.hot").innerText()).includes("リード・未対応"), "件数の段でもリード・未対応を強調");
  check(/1\s*社/.test(await page.locator(".db-sum a.hot").innerText()), "リード・未対応は1社");
  check((await page.locator("#list-attack").innerText()).includes("株式会社サンプル"), "未アタックの企業は④に出る");
  check(!(await page.locator("#list-attack").innerText()).includes("反応商事"), "①に出した企業は下の段に重ねて出さない");
  check((await page.locator("#history").innerText()).includes("直近14日の送信はありません"), "最近の営業履歴の段が出る（送信なし）");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 営業担当：企業 → フォームアタック → 送信完了 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.waitForTimeout(1000);

  check((await page.locator("#rows tr").count()) === 3, "一覧に3社");
  await page.locator("#rows tr", { hasText: "株式会社サンプル" }).click();
  await page.waitForTimeout(500);
  check(await page.locator(".sl-detail").isVisible(), "右ドロワーで詳細が開く");
  check((await page.locator(".sl-next h3").innerText()).includes("フォームアタック"), "NEXTはフォームアタック");

  await page.locator(".sl-next button", { hasText: "フォームアタック" }).click();
  await page.waitForTimeout(800);
  check(await page.locator(".atk").isVisible(), "フォームアタック画面が開く");
  const text = await page.locator("#at-body").inputValue();
  check(text.startsWith("株式会社サンプル"), "企業名が差し込まれる");
  check(text.includes("営業 一郎"), "送る人の名前が差し込まれる");
  check(text.includes("https://gw.8grp.co.jp/r/X7K92PABCD"), "専用URLが本文に入る");
  check(calls.some((c) => c.kind === "prepare" && c.body.companyId === "c1" && c.body.templateId === "t1"),
    "開いた時点で専用URLを発行している（テンプレートつき）");
  check(await page.locator(".atk a", { hasText: "問い合わせフォームを開く" }).count() === 1, "フォームを開くボタンがある");

  await page.locator("button", { hasText: "送信完了" }).click();
  await page.waitForTimeout(800);
  const sent = calls.find((c) => c.kind === "act");
  check(sent && sent.body.action === "sent" && sent.body.id === "ap1", "送信完了を記録した");
  check(sent && sent.body.body.includes("/r/X7K92PABCD"), "送った本文（専用URLつき）を残す");
  check(sent && sent.body.service === "AI / DX", "提案サービスも残す");
  check(!(await page.locator(".atk").count()), "送信完了で閉じる");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 直近30日以内：警告して送らせない ===");
{
  const recent = { sentAt: NOW, employeeName: "営業 二郎", service: "PCレンタル", days: 30 };
  const { page, errs } = await openAs({ recent });
  await page.goto(`${BASE}/sales/companies.html?id=c1`);
  await page.waitForTimeout(1000);
  check((await page.locator(".sl-detail").innerText()).includes("営業 二郎さんがアタック済み"), "企業ページに「〇〇さんがアタック済み」");

  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.waitForTimeout(1000);
  const t = await page.locator(".atk").innerText();
  check(t.includes("直近30日以内にアタックされています"), "警告が出る");
  check(t.includes("営業 二郎") && t.includes("PCレンタル"), "前回の担当・サービスが出る");
  check(!(await page.locator("#at-body").count()), "営業文は出さない");
  check(!(await page.locator("button", { hasText: "それでもアタックする" }).count()), "営業担当には押し切りボタンを出さない");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();

  const admin = await openAs({ recent, isAdmin: true, roles: [] });
  await admin.page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await admin.page.waitForTimeout(1000);
  check(await admin.page.locator("button", { hasText: "それでもアタックする" }).count() === 1, "管理者には押し切りボタンが出る");
  await admin.page.locator("button", { hasText: "それでもアタックする" }).click();
  await admin.page.waitForTimeout(800);
  check(admin.calls.some((c) => c.kind === "prepare" && c.body.force === true), "押し切りは force つきで頼む");
  check(await admin.page.locator("#at-body").count() === 1, "押し切ると営業文が出る");
  await admin.page.close();
}

console.log("\n=== 企業追加：URLだけで登録 → そのままアタックへ ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?new=1`);
  await page.waitForTimeout(900);
  const drawer = page.locator(".sl-drawer");
  // 最初に見えているのは URL・企業名・提案サービスだけ。詳細は折りたたみ
  check(await page.locator("#q-url").isVisible() && await page.locator("#q-name").isVisible()
    && await page.locator("#q-service").isVisible(), "URL・企業名・提案サービスが見えている");
  check(!(await page.locator("#q-form").isVisible()) && !(await page.locator("#q-phone").isVisible())
    && !(await page.locator("#q-note").isVisible()), "フォームURL・電話・メモなどは折りたたまれている");
  check((await drawer.locator("button").first().innerText()).includes("追加してアタックへ"), "Primary は「追加してアタックへ」");

  await page.fill("#q-url", "https://www.abc-kogyo.co.jp/");
  await page.locator("#q-url").dispatchEvent("change");
  await page.waitForTimeout(700);
  check((await page.inputValue("#q-name")) === "株式会社ABC-KOGYO", `企業名が自動で入る（${await page.inputValue("#q-name")}）`);
  check((await page.inputValue("#q-form")) === "https://abc-kogyo.co.jp/contact/", "問い合わせフォームURLも裏で入る");
  check((await page.locator("#q-look").innerText()).includes("取得できました"), "何が取れたかを出す");

  await page.selectOption("#q-service", "PCレンタル");
  await page.locator("button", { hasText: "追加してアタックへ" }).click();
  await page.waitForTimeout(1200);
  const made = calls.find((c) => c.kind === "create");
  check(made && made.body.siteUrl === "https://www.abc-kogyo.co.jp/" && made.body.service === "PCレンタル"
    && made.body.formUrl === "https://abc-kogyo.co.jp/contact/", "URL・企業名・サービス・フォームURLで登録する");
  check(made && made.body.ownerId === undefined, "担当は送らない（サーバが登録した人にする）");
  check(await page.locator(".atk").isVisible(), "登録したら、そのままフォームアタック画面が開く");
  check((await page.locator("#at-body").inputValue()).startsWith("株式会社ABC-KOGYO"), "営業文に企業名が入っている");

  // 登録済みのドメインは、追加ボタンを押せない
  await page.goto(`${BASE}/sales/companies.html?new=1`);
  await page.waitForTimeout(700);
  await page.fill("#q-url", "sample.co.jp");
  await page.locator("#q-url").dispatchEvent("change");
  await page.waitForTimeout(600);
  check((await page.locator("#q-look").innerText()).includes("登録済みです"), "登録済みの企業は、その場で分かる");
  check(await page.locator("#q-go").isDisabled(), "登録済みなら「追加してアタックへ」は押せない");

  // サイトが開けなくても、URLだけで登録できる（企業名はドメイン名）
  await page.goto(`${BASE}/sales/companies.html?new=1`);
  await page.waitForTimeout(700);
  await page.fill("#q-url", "https://noname.example.jp");
  await page.locator("#q-url").dispatchEvent("change");
  await page.waitForTimeout(600);
  check((await page.locator("#q-look").innerText()).includes("URLだけで登録できます"), "取れなくても止めないと伝える");
  await page.locator("button", { hasText: "追加だけする" }).click();
  await page.waitForTimeout(900);
  const made2 = calls.filter((c) => c.kind === "create").pop();
  check(made2?.body.name === "noname.example.jp", `企業名が無ければドメイン名で登録（${made2?.body.name}）`);
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== URLをまとめて追加 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.waitForTimeout(900);
  await page.locator("button", { hasText: "URLをまとめて追加" }).click();
  await page.fill("#bu-text", [
    "https://aaa.co.jp", "bbb.jp", "https://www.aaa.co.jp/about", "https://sample.co.jp/", "hannou.jp", "ccc.com", "これはURLではない",
  ].join("\n"));
  await page.selectOption("#bu-service", "AI / DX");
  await page.locator("#bu-go").click();
  await page.waitForTimeout(2500);
  const bulk = calls.find((c) => c.kind === "bulk");
  const names = (bulk?.body.companies || []).map((c) => c.name).sort();
  check(JSON.stringify(names) === JSON.stringify(["株式会社AAA", "株式会社BBB", "株式会社CCC"]),
    `重複・登録済みを除いて3社（${names.join(", ")}）`);
  check(!calls.some((c) => c.kind === "lookup" && /hannou/.test(c.url)), "一覧にある企業のドメインは、取りにいく前に除く");
  check((bulk?.body.companies || []).every((c) => c.service === "AI / DX" && c.formUrl), "サービスとフォームURLも一緒に登録");
  check((await page.locator("#bu-progress").innerText()).includes("3社を追加しました"), "結果を出す");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== リード ===");
{
  const { page, errs } = await openAs();
  await page.goto(`${BASE}/sales/leads.html`);
  await page.waitForTimeout(1000);
  check((await page.locator(".sl-nav a.on").innerText()).includes("リード"), "上部タブの「リード」が選ばれている");
  const cards = await page.locator(".ld-card .nm").allInnerTexts();
  check(cards.length === 2, `反応した2社だけ（未アタックは出さない）（${cards.length}）`);
  check(cards[0]?.includes("返信工業") && cards[1]?.includes("反応商事"), `返信あり → クリックの順（${cards.map((c) => c.split("\n")[0]).join(" / ")}）`);
  check(cards[0]?.includes("リード") && cards[1]?.includes("ウォームリード"), "返信はリード、クリックだけはウォームリード");
  check(cards[1]?.includes("🔥"), "未対応クリックは🔥");
  const meta = await page.locator(".ld-card").nth(1).innerText();
  check(meta.includes("クリック 2回") && meta.includes("NEXT：クリックあり・要フォロー"), "クリック回数とNEXTを出す");
  const tabs = await page.locator("#stages button").allInnerTexts();
  check(["すべて", "クリックあり", "返信あり", "面談", "提案中", "成約"].every((l) => tabs.some((t) => t.startsWith(l))), `段階で絞れる（${tabs.join(" / ")}）`);
  await page.locator("#stages button", { hasText: "返信あり" }).click();
  check((await page.locator(".ld-card").count()) === 1, "「返信あり」で絞ると1社");
  await page.locator(".ld-card").first().click();
  await page.waitForTimeout(900);
  check(/companies\.html\?id=c3/.test(page.url()) && await page.locator(".sl-detail").isVisible(), "開くと企業詳細の右ドロワー");
  const d = await page.locator(".sl-detail").innerText();
  check(d.includes("初回クリック") && d.includes("最終クリック"), "詳細に初回・最終クリックが出る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 権限の無い人 ===");
{
  const { page } = await openAs({ roles: [] });
  await page.goto(`${BASE}/sales/index.html`);
  await page.waitForTimeout(1000);
  check(/home\.html/.test(page.url()), `home.html へ送り返す（いま ${page.url()}）`);
  await page.close();
}

console.log("\n=== スマホ幅 ===");
{
  const { page, errs } = await openAs();
  await page.setViewportSize({ width: 375, height: 800 });
  for (const p of ["index", "companies", "attack", "leads", "analytics", "templates", "campaigns"]) {
    await page.goto(`${BASE}/sales/${p}.html`);
    await page.waitForTimeout(700);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(over <= 1, `${p}.html 横にはみ出さない（${over}px）`);
  }
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通りました");
process.exit(bad ? 1 : 0);
