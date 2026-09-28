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
//   7. 送信完了は送信チャネル（必須）・送信元を中央モーダルで選ぶ。「送信できなかった」は理由必須（db/096）
//   8. 非表示：一括で非表示 → 通常の一覧から消える → 「非表示」で見える → 再表示
//   9. 返信・やり取りを記録：返信元・いまの連絡手段・連絡先・メモ・NEXT。企業詳細に「現在の連絡状況」
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
    overdue: false, campaignId: null, campaignName: null, hidden: false, hiddenLabel: null,
    contactChannel: null, contactChannelLabel: null, contactValue: null, contacts: {}, ...over,
  };
}

async function openAs({ roles = ["sales"], isAdmin = false, recent = null, timerex = true } = {}) {
  const calls = [];
  // 企業詳細の応答を遅らせる／失敗させる（ドロワーの競合を再現するため）。テストの途中で書き換えてよい
  const ctl = { delay: {}, fail: new Set() };
  const meetings = [];
  const shapeM = (m) => ({ kindLabel: "初回商談", durationMin: 30, ownerName: "営業 一郎",
    statusLabel: { scheduling: "日程調整中", scheduled: "面談予定", canceled: "取りやめ" }[m.status], ...m });
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

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");

    if (/\/api\/me\b/.test(url)) {
      return send({ email: "sales@8grp.co.jp", appRole: isAdmin ? "admin" : "member", isAdmin, shows: {},
        gw: { employee: SALES, roles, isAdmin, tenantId: "t1", stage: null } });
    }
    if (/\/api\/sales\/companies\/bulk/.test(url)) {
      const b = body();
      calls.push({ kind: `bulk-${b.action}${b.dryRun ? "-dry" : ""}`, body: b });
      const hit = companies.filter((c) => b.ids.includes(c.id));
      // 本物（api/sales/companies/bulk.js）と同じく、アタック・クリック・成約・営業禁止のある企業は消さない
      const why = (c) => [c.attackCount && "アタック履歴あり", c.clickCount && "クリック履歴あり",
        c.status === "won" && "成約済み", c.ngReason && "営業禁止"].filter(Boolean);
      if (b.action === "delete") {
        const ok = hit.filter((c) => !why(c).length);
        const blocked = hit.filter((c) => why(c).length).map((c) => ({ id: c.id, name: c.name, reasons: why(c) }));
        if (b.dryRun) return send({ dryRun: true, notFound: 0, deletable: ok.map((c) => ({ id: c.id, name: c.name })), blocked });
        for (const c of ok) companies.splice(companies.indexOf(c), 1);
        return send({ deleted: ok.length, failed: 0, notFound: 0, blocked });
      }
      const HIDE = { link_broken: "リンク切れ", closed: "閉業", not_target: "営業対象外" };
      for (const c of hit) {
        if (b.action === "hide") { c.hidden = true; c.hiddenReason = b.reason; c.hiddenLabel = HIDE[b.reason] || b.reason; }
        if (b.action === "unhide") { c.hidden = false; c.hiddenReason = null; c.hiddenLabel = null; }
        if (b.action === "change_status") { c.status = b.status; c.statusLabel = { lost: "失注", excluded: "対象外" }[b.status] || b.status; }
        if (b.action === "change_owner") { c.ownerId = b.ownerId; c.ownerName = b.ownerId ? "営業 一郎" : null; }
      }
      return send({ updated: hit.length, skipped: 0, failed: 0, notFound: 0 });
    }
    if (/\/api\/sales\/campaigns\b/.test(url)) {
      return send({ campaigns: [{ id: "cp1", name: "秋の製造業", archived: false }] });
    }
    if (/\/api\/sales\/companies\/detail/.test(url)) {
      const id = new URL(url).searchParams.get("id") || body().id;
      calls.push({ kind: "detail", id, method: req.method() });
      if (ctl.delay[id]) await new Promise((r) => setTimeout(r, ctl.delay[id]));
      if (ctl.fail.has(id)) return send({ error: "db_failed", detail: "わざと失敗" }, 500);
      const c = companies.find((x) => x.id === id);
      if (req.method() === "POST" && body().action === "contact") {
        const b = body();
        calls.push({ kind: "contact", body: b });
        const LBL = { email: "メール", instagram: "Instagram", line: "LINE" };
        if (b.contactChannel) { c.contactChannel = b.contactChannel; c.contactChannelLabel = LBL[b.contactChannel] || b.contactChannel; }
        c.contacts = { ...c.contacts, ...(b.contacts || {}) };
        c.contactValue = c.contacts[c.contactChannel] || null;
        if (b.replied) { c.status = "replied"; c.statusLabel = "返信あり"; c.replyChannel = b.replyChannel; }
        return send({ company: c });
      }
      const ch = (keys) => keys.map(([key, label]) => ({ key, label }));
      return send({
        today: TODAY, company: c, approaches: [], recent,
        contactStatus: {
          firstChannelLabel: c.lastSentAt ? "お問い合わせフォーム" : null,
          replyChannelLabel: c.replyChannel === "instagram" ? "Instagram" : null,
          currentChannelLabel: c.contactChannelLabel, currentValue: c.contactValue,
          lastContactAt: c.lastSentAt,
        },
        sendChannels: ch([["form", "お問い合わせフォーム"], ["email", "メール"], ["instagram", "Instagram"], ["x", "X"]]),
        replyChannels: ch([["form", "お問い合わせフォーム経由"], ["email", "メール"], ["instagram", "Instagram"], ["phone", "電話"]]),
        contactChannels: ch([["email", "メール"], ["line", "LINE"], ["instagram", "Instagram"], ["phone", "電話"]]),
        sendFailReasons: ch([["no_form", "問い合わせフォームがない"], ["captcha", "CAPTCHA等で送信できない"], ["other", "その他"]]),
        hideReasons: ch([["link_broken", "リンク切れ"], ["other", "その他"]]),
        timeline: c.lastSentAt ? [{ at: c.lastSentAt, kind: "attack", label: "フォーム送信" },
          { at: c.lastClickAt, kind: "click", label: "リンククリック" }] : [],
        canForce: isAdmin, members: [{ id: "emp-s1", display_name: "営業 一郎" }], campaigns: [],
        meetings: meetings.filter((m) => m.companyId === id).map(shapeM), meetingsReady: true, timerexConfigured: timerex,
        statuses: [{ key: "untouched", label: "未アタック" }, { key: "attacked", label: "アタック済" }],
        ngReasons: [{ key: "no_sales", label: "営業禁止" }],
        eventKinds: [{ key: "follow", label: "フォロー" }, { key: "reply", label: "返信あり" }],
      });
    }
    if (/\/api\/sales\/meetings\b/.test(url)) {
      const b = body();
      calls.push({ kind: `meeting-${req.method()}`, body: b });
      if (req.method() === "POST") {
        const m = { id: `m${meetings.length + 1}`, companyId: b.companyId, ownerId: b.ownerId || "emp-s1", kind: "first_meeting",
          status: "scheduling", schedulingUrl: timerex ? `https://timerex.net/s/eight/first30?sales_company_id=${b.companyId}&sales_meeting_id=m${meetings.length + 1}` : null,
          schedulingSentAt: null, scheduledAt: null, meetingUrl: null };
        meetings.push(m);
        return send({ meeting: shapeM(m), reused: false, timerexConfigured: timerex });
      }
      const m = meetings.find((x) => x.id === b.id);
      if (b.action === "sent") m.schedulingSentAt = NOW;
      if (b.action === "schedule") { m.status = "scheduled"; m.scheduledAt = b.scheduledAt; m.meetingUrl = b.meetingUrl; }
      if (b.action === "cancel") m.status = "canceled";
      return send({ meeting: shapeM(m) });
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
      // 表示状態（既定は表示中だけ。本物の api/sales/companies と同じ）
      const vis = new URL(url).searchParams.get("visibility") || "shown";
      calls.push({ kind: "list", visibility: vis });
      const listed = companies.filter((c) => (vis === "all" ? true : vis === "hidden" ? c.hidden : !c.hidden));
      return send({ today: TODAY, me: "emp-s1", members: [{ id: "emp-s1", display_name: "営業 一郎" }], companies: listed });
    }
    if (/\/api\/sales\/templates\b/.test(url)) {
      return send({ services: [], templates: [{ id: "t1", name: "DX基本", service: "AI / DX", subject: null,
        body: "{{company}}\nご担当者様\n\n{{sender}}です。\n詳細はこちら\n{{url}}", destinationUrl: "https://8grp.co.jp/service/dx",
        archived: false, uses: 0 }] });
    }
    if (/\/api\/sales\/approaches\b/.test(url)) {
      if (req.method() === "POST") {
        calls.push({ kind: "prepare", body: body() });
        // 直近アタックの警告は同じチャネル（ここではフォーム）だけ。別チャネルなら準備できる
        if (recent && !body().force && (body().channel || "form") === "form") {
          return send({ error: "recent_attack", recent, canForce: isAdmin, hint: "直近30日以内にお問い合わせフォームでアタックされています" }, 409);
        }
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
  return { page, calls, errs, ctl };
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

  check((await page.locator("#at-channel").inputValue()) === "form", "送信チャネルの初期値はお問い合わせフォーム");
  await page.locator("button", { hasText: "送信完了" }).click();
  await page.locator(".sl-modal").waitFor();
  check(await page.locator('.sl-modal input[name="sd-channel"][value="form"]').isChecked(), "送信完了モーダル：チャネルが選ばれている");
  check(!calls.some((c) => c.kind === "act"), "モーダルで記録するまでは送らない");
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  await page.waitForTimeout(800);
  const sent = calls.find((c) => c.kind === "act");
  check(sent && sent.body.action === "sent" && sent.body.id === "ap1", "送信完了を記録した");
  check(sent && sent.body.channel === "form", "送信チャネル（フォーム）を送る");
  check(sent && sent.body.body.includes("/r/X7K92PABCD"), "送った本文（専用URLつき）を残す");
  check(sent && sent.body.service === "AI / DX", "提案サービスも残す");
  check(!(await page.locator(".atk").count()), "送信完了で閉じる");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 直近30日以内：警告して送らせない ===");
{
  const recent = { sentAt: NOW, employeeName: "営業 二郎", service: "PCレンタル", days: 30, channel: "form", channelLabel: "お問い合わせフォーム" };
  const { page, errs } = await openAs({ recent });
  await page.goto(`${BASE}/sales/companies.html?id=c1`);
  await page.waitForTimeout(1000);
  check((await page.locator(".sl-detail").innerText()).includes("営業 二郎さんがアタック済み"), "企業ページに「〇〇さんがアタック済み」");

  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.waitForTimeout(1000);
  const t = await page.locator(".atk").innerText();
  check(t.includes("直近30日以内にお問い合わせフォームでアタックされています"), "警告が出る（どのチャネルで送ったか）");
  check(t.includes("営業 二郎") && t.includes("PCレンタル"), "前回の担当・サービスが出る");
  check(!(await page.locator("#at-body").count()), "営業文は出さない");
  check(!(await page.locator("button", { hasText: "それでもアタックする" }).count()), "営業担当には押し切りボタンを出さない");
  // 別のチャネル（Instagram など）なら送れる
  check(!(await page.locator('#at-other-channel option[value="form"]').count()), "別チャネルの候補に、止められたチャネルは出さない");
  await page.locator("#at-other-channel").selectOption("instagram");
  await page.locator("button", { hasText: "別のチャネルで送る" }).click();
  await page.locator("#at-body").waitFor();
  check((await page.locator("#at-channel").inputValue()) === "instagram", "別チャネル（Instagram）の営業文画面に進める");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();

  // 押し切りできるのは Sales を使える人の中の経営者・管理者（社内権限 owner）
  const admin = await openAs({ recent, isAdmin: true, roles: ["owner"] });
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
  check(["すべて", "クリックあり", "返信あり", "面談調整中", "面談予定", "提案中", "成約"].every((l) => tabs.some((t) => t.startsWith(l))), `段階で絞れる（${tabs.join(" / ")}）`);
  const btns = await page.locator(".ld-card button").allInnerTexts();
  check(btns.length === 2 && btns.every((t) => t === "面談を設定"), `リードのボタンは「面談を設定」1つ（${btns.join(" / ")}）`);
  await page.locator("#stages button", { hasText: "返信あり" }).click();
  check((await page.locator(".ld-card").count()) === 1, "「返信あり」で絞ると1社");
  await page.locator(".ld-card").first().click();
  // 画面遷移＋詳細の取得を待つ（CI は遅いので、決め打ちの待ち時間にしない）
  await page.locator(".sl-detail").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(/companies\.html\?id=c3/.test(page.url()) && await page.locator(".sl-detail").isVisible(), "開くと企業詳細の右ドロワー");
  const d = await page.locator(".sl-detail").innerText();
  check(d.includes("初回クリック") && d.includes("最終クリック"), "詳細に初回・最終クリックが出る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 面談：リード → 面談を設定 → 日程確定 → 面談予定 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/leads.html`);
  await page.waitForTimeout(1000);
  await page.locator(".ld-card", { hasText: "反応商事" }).locator("button", { hasText: "面談を設定" }).click();
  await page.locator(".sl-modal h2", { hasText: "営業面談を設定" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.locator(".sl-next .btn-primary").first().waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
  check(/companies\.html\?id=c2&meeting=1/.test(page.url()) || /companies\.html\?id=c2/.test(page.url()), "リードから企業詳細へ");
  check(await page.locator(".sl-modal h2", { hasText: "営業面談を設定" }).isVisible(), "そのまま「営業面談を設定」が開く");
  const primary = await page.locator(".sl-next .btn-primary").allInnerTexts();
  check(primary.length === 1 && primary[0].includes("面談を設定"), `リード詳細の Primary CTA は「面談を設定」1つ（${primary.join(" / ")}）`);
  const d0 = await page.locator(".sl-modal").innerText();
  check(d0.includes("初回商談（30分）") && /担当/.test(d0), "初回商談30分・担当が出る");

  await page.locator("button", { hasText: "日程調整URLを発行" }).click();
  await page.waitForTimeout(900);
  const sched = await page.inputValue("#mt-sched");
  check(/^https:\/\/timerex\.net\/s\/eight\/first30\?sales_company_id=c2&sales_meeting_id=m1$/.test(sched), `TimeRex URL に会社と面談のID（${sched}）`);
  check((await page.inputValue("#mt-mail")).includes(sched), "送る文面にもURLが入っている");
  check(calls.some((c) => c.kind === "meeting-POST" && c.body.companyId === "c2" && c.body.ownerId === "emp-s1"), "担当つきで発行した");

  await page.locator("button", { hasText: "送付済みにする" }).click();
  await page.waitForTimeout(900);
  check((await page.locator(".sl-modal").innerText()).includes("相手の予約を待っています"), "送付済みになる");

  await page.locator(".sl-modal summary", { hasText: "日程が決まった" }).click();
  await page.fill("#mt-when", "2099-10-05T14:00");
  await page.fill("#mt-url", "https://meet.google.com/abc-defg-hij");
  await page.locator("button", { hasText: "日程を確定" }).click();
  await page.waitForTimeout(900);
  const sc = calls.find((c) => c.kind === "meeting-PATCH" && c.body.action === "schedule");
  check(sc && sc.body.scheduledAt === "2099-10-05T05:00:00.000Z" && sc.body.meetingUrl === "https://meet.google.com/abc-defg-hij", "日時（JST 14:00）とMeet URLで確定");
  const d1 = await page.locator(".sl-modal").innerText();
  check(d1.includes("面談予定") && await page.locator(".sl-modal a", { hasText: "面談に参加" }).count() === 1, "面談予定・「面談に参加」が出る");
  check((await page.locator(".sl-detail").innerText()).includes("初回商談（30分）"), "企業詳細の「面談」にも出る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();

  // TimeRex 未設定でも、面談を作って手入力で進められる
  const off = await openAs({ timerex: false });
  await off.page.goto(`${BASE}/sales/companies.html?id=c3&meeting=1`);
  await off.page.locator(".sl-modal h2", { hasText: "営業面談を設定" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check((await off.page.locator(".sl-modal").innerText()).includes("TIMEREX_SALES_MEETING_URL"), "未設定なら、そう出す");
  await off.page.locator("button", { hasText: "面談を作成" }).click();
  await off.page.waitForTimeout(900);
  check(await off.page.locator("#mt-when").isVisible(), "未設定なら手入力の欄を開いておく");
  await off.page.close();
}

console.log("\n=== 企業詳細：取得中に閉じる・切り替える（古い応答を捨てる） ===");
{
  const { page, errs, ctl } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#list tr.click").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const box = () => page.locator("#detail-box").count();

  // 1) 取得中にドロワーを閉じる → 応答が戻っても書かない・落ちない
  ctl.delay.c1 = 1200;
  await page.evaluate(() => { openDetail("c1"); });
  await page.waitForTimeout(150);
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(1600);
  check(await box() === 0 && !/[?&]id=/.test(page.url()), "取得中に閉じたら、あとから戻った応答で詳細を開き直さない");
  check(!errs.length, `取得中に閉じても JSエラーなし ${errs.join(" / ")}`);

  // 2) 失敗する応答でも同じ（catch 側も消えた #detail-box に書かない）
  ctl.fail.add("c1");
  await page.evaluate(() => { openDetail("c1"); });
  await page.waitForTimeout(150);
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(1600);
  check(await box() === 0 && !errs.length, `失敗した応答が閉じたあとに戻っても JSエラーなし ${errs.join(" / ")}`);
  ctl.fail.delete("c1");

  // 3) 遅いA → 速いB と切り替える → Aの応答がBの詳細を上書きしない
  ctl.delay.c2 = 1500;
  await page.evaluate(() => { openDetail("c2"); });
  await page.waitForTimeout(150);
  await page.evaluate(() => { openDetail("c3"); });
  await page.locator(".sl-detail", { hasText: "返信工業" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1800);
  const t = await page.locator("#detail-box").innerText().catch(() => "");
  check(t.includes("返信工業") && !t.includes("反応商事"), "あとから開いた企業の詳細だけが出る（古い応答で上書きしない）");
  check(/[?&]id=c3\b/.test(page.url()), `URL もあとから開いた企業のまま（${page.url()}）`);
  check(await page.evaluate(() => detail?.company?.id) === "c3", "内部の詳細データもあとから開いた企業");
  delete ctl.delay.c2;

  // 4) 面談の操作中（再取得の途中）にドロワーを閉じる → 面談パネルを開き直さない・落ちない
  await page.evaluate(() => { openDetail("c2"); });
  await page.locator(".sl-detail", { hasText: "反応商事" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.evaluate(() => openMeeting());
  await page.locator(".sl-modal h2", { hasText: "営業面談を設定" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  ctl.delay.c2 = 1200;
  await page.locator("button", { hasText: "日程調整URLを発行" }).click();
  await page.waitForTimeout(200);
  await page.evaluate(() => closeModal());
  await page.waitForTimeout(1600);
  check(await box() === 0 && await page.locator(".sl-modal").count() === 0, "再取得の途中で閉じたら、詳細も面談パネルも開き直さない");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  delete ctl.delay.c2;

  // 5) ふつうに開けば、これまでどおり出る
  await page.evaluate(() => { openDetail("c1"); });
  await page.locator(".sl-detail", { hasText: "株式会社サンプル" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(await page.locator(".sl-detail", { hasText: "株式会社サンプル" }).isVisible(), "ふつうに開けば詳細が出る");
  await page.close();
}

console.log("\n=== 企業詳細からの操作は中央モーダル（2つ目の右ドロワーは出さない） ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?id=c1`);
  await page.locator(".sl-detail", { hasText: "株式会社サンプル" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const vp = page.viewportSize();
  const drawers = () => page.locator(".sl-drawer").count();
  const modals = () => page.locator(".sl-modal").count();
  for (const [label, title] of [["履歴を記録", "履歴を記録"], ["ステータス・NEXT", "ステータス・NEXT"],
    ["基本情報を編集", "基本情報を編集"], ["営業禁止にする", "営業禁止にする"]]) {
    await page.locator(".sl-detail button", { hasText: label }).first().click();
    await page.locator(".sl-modal h2", { hasText: title }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    const bb = await page.locator(".sl-modal").boundingBox().catch(() => null);
    const centered = bb && Math.abs(bb.x + bb.width / 2 - vp.width / 2) < 4 && Math.abs(bb.y + bb.height / 2 - vp.height / 2) < 4;
    check(await modals() === 1 && await drawers() === 0 && centered, `「${label}」は中央モーダル1つ（右ドロワーは重ねない）`);
    // 背景を押して閉じても、閉じるのはモーダルだけ
    await page.mouse.click(20, vp.height / 2);
    await page.waitForTimeout(200);
    check(await modals() === 0 && await page.locator("#detail-box").isVisible(), `「${label}」を閉じても企業詳細ドロワーは残る`);
  }

  // 保存後：モーダルを閉じ、企業詳細を取り直して背後のドロワーへ反映（ドロワーは閉じない）
  const before = calls.filter((c) => c.kind === "detail" && c.method === "GET").length;
  await page.locator(".sl-detail button", { hasText: "ステータス・NEXT" }).click();
  await page.locator(".sl-modal").waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.selectOption("#st-status", "attacked");
  await page.locator(".sl-modal button", { hasText: "保存する" }).click();
  await page.waitForFunction(() => !document.querySelector(".sl-modal"), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  check(calls.some((c) => c.kind === "detail" && c.method === "PATCH"), "保存した");
  check(await modals() === 0 && await page.locator("#detail-box").isVisible()
    && calls.filter((c) => c.kind === "detail" && c.method === "GET").length > before, "保存後はモーダルを閉じ、企業詳細を取り直してドロワーに反映");
  check(!(await page.locator("#detail-box").innerText()).includes("読み込み中"), "ドロワーは開き直さない（読み込み中に戻らない）");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();

  // 面談を設定（リード）も中央モーダル
  const m = await openAs();
  await m.page.goto(`${BASE}/sales/companies.html?id=c2`);
  await m.page.locator(".sl-detail", { hasText: "反応商事" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await m.page.locator(".sl-next button", { hasText: "面談を設定" }).click();
  await m.page.locator(".sl-modal h2", { hasText: "営業面談を設定" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(await m.page.locator(".sl-modal").count() === 1 && await m.page.locator(".sl-drawer").count() === 0, "「面談を設定」も中央モーダル1つ");
  const mt = await m.page.locator(".sl-modal").innerText();
  check(mt.includes("反応商事") && mt.includes("初回商談（30分）") && mt.includes("担当"), "企業名・面談種別・担当が出る");
  await m.page.locator(".sl-modal button", { hasText: "閉じる" }).click();
  check(await m.page.locator(".sl-modal").count() === 0 && await m.page.locator("#detail-box").isVisible(), "閉じても企業詳細は残る");
  await m.page.close();
}

console.log("\n=== 企業一覧：複数選択 → 画面下のバー → 中央モーダルで一括変更 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(await page.locator(".sl-bulkbar").count() === 0, "選ぶまではバーを出さない");
  await page.locator('#rows tr[data-id="c1"] td.sl-check input').click();
  await page.locator('#rows tr[data-id="c2"] td.sl-check input').click();
  await page.waitForTimeout(200);
  check(await page.locator("#detail-box").count() === 0, "チェックボックスを押しても企業詳細は開かない");
  check((await page.locator(".sl-bulkbar").innerText()).includes("2社選択中"), "「2社選択中」と出る");
  const vp = page.viewportSize();
  const bb = await page.locator(".sl-bulkbar").boundingBox();
  check(bb && Math.abs(bb.x + bb.width / 2 - vp.width / 2) < 4 && vp.height - (bb.y + bb.height) <= 30, "バーは画面下の中央");
  const barText = await page.locator(".sl-bulkbar").innerText();
  check(["ステータス変更", "担当変更", "その他", "選択解除"].every((t) => barText.includes(t)) && !barText.includes("削除"),
    "表に出すのは ステータス変更・担当変更・その他・選択解除 だけ（削除は「その他」の中）");
  check(await page.locator('#rows tr[data-id="c1"]').evaluate((e) => e.classList.contains("sel")), "選んだ行は薄く色が付く");

  await page.locator(".sl-bulkbar button", { hasText: "ステータス変更" }).click();
  await page.locator(".sl-modal h2", { hasText: "2社のステータスを変更します" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  check(await page.locator(".sl-modal").count() === 1 && await page.locator(".sl-drawer").count() === 0, "ステータス変更は中央モーダル");
  await page.selectOption("#bk-status", "excluded");
  await page.locator(".sl-modal button", { hasText: "2社を変更する" }).click();
  await page.waitForFunction(() => !document.querySelector(".sl-modal"), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  const sc = calls.find((c) => c.kind === "bulk-change_status");
  check(sc && sc.body.status === "excluded" && JSON.stringify([...sc.body.ids].sort()) === JSON.stringify(["c1", "c2"]), "2社をまとめて1回で変更");
  const t = await page.locator("#rows").innerText();
  check((t.match(/対象外/g) || []).length === 2, "2社とも更新される");
  check(await page.locator(".sl-bulkbar").count() === 0 && await page.locator("#rows input:checked").count() === 0, "選択が解除され、バーが消える");

  // 担当変更
  await page.locator('#rows tr[data-id="c3"] td.sl-check input').click();
  await page.locator(".sl-bulkbar button", { hasText: "担当変更" }).click();
  await page.locator(".sl-modal h2", { hasText: "1社の担当を変更します" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.locator(".sl-modal button", { hasText: "1社を変更する" }).click();
  await page.waitForTimeout(500);
  check(calls.some((c) => c.kind === "bulk-change_owner" && c.body.ids.join() === "c3" && c.body.ownerId === "emp-s1"), "担当もまとめて変更");

  // 「その他」メニュー
  await page.locator('#rows tr[data-id="c1"] td.sl-check input').click();
  await page.locator(".sl-bulkbar button", { hasText: "その他" }).click();
  const menu = await page.locator("#bulk-menu").innerText();
  check(["提案サービス変更", "キャンペーン変更", "営業禁止にする", "削除"].every((x) => menu.includes(x))
    && menu.trim().endsWith("削除"), "その他：提案サービス・キャンペーン・営業禁止・削除（削除はいちばん下）");
  await page.locator("#bulk-menu button", { hasText: "キャンペーン変更" }).click();
  await page.locator("#bk-campaign:not([disabled])").waitFor({ timeout: 15000 }).catch(() => {});
  await page.selectOption("#bk-campaign", "cp1");
  await page.locator(".sl-modal button", { hasText: "1社を変更する" }).click();
  await page.waitForTimeout(500);
  check(calls.some((c) => c.kind === "bulk-change_campaign" && c.body.campaignId === "cp1"), "キャンペーンもまとめて変更");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 全選択は、いま表示している企業だけ ===");
{
  const { page, calls } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.fill("#f-q", "hannou");
  await page.waitForTimeout(200);
  check(await page.locator("#rows tr[data-id]").count() === 1, "絞り込むと1社");
  await page.locator("#sel-all").click();
  await page.waitForTimeout(200);
  check((await page.locator(".sl-bulkbar").innerText()).includes("1社選択中"), "全選択で選ばれるのは表示中の1社だけ");
  await page.fill("#f-q", "");
  await page.waitForTimeout(200);
  check(await page.locator("#rows input:checked").count() === 1 && await page.locator('#rows tr[data-id="c2"] td.sl-check input').isChecked(),
    "非表示だった企業は選ばれていない");
  await page.locator(".sl-bulkbar button", { hasText: "担当変更" }).click();
  await page.locator(".sl-modal button", { hasText: "1社を変更する" }).click();
  await page.waitForTimeout(500);
  check(calls.find((c) => c.kind === "bulk-change_owner")?.body.ids.join() === "c2", "一括操作の対象も表示中に選んだ企業だけ");
  // 絞り込みで見えなくなった企業は、選択から外す（見えない企業に一括操作が及ばない）
  await page.locator('#rows tr[data-id="c2"] td.sl-check input').click();
  await page.fill("#f-q", "サンプル");
  await page.waitForTimeout(200);
  check(await page.locator(".sl-bulkbar").count() === 0, "絞り込みで見えなくなった企業は選択から外れる");
  await page.close();
}

console.log("\n=== 削除：確認モーダル → 履歴の無い企業だけ消す ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.locator('#rows tr[data-id="c1"] td.sl-check input').click();
  await page.locator('#rows tr[data-id="c2"] td.sl-check input').click();
  await page.locator(".sl-bulkbar button", { hasText: "その他" }).click();
  await page.locator("#bulk-menu button.danger", { hasText: "削除" }).click();
  await page.locator(".sl-modal", { hasText: "削除する企業" }).waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const txt = await page.locator(".sl-modal").innerText();
  check(txt.includes("選択した2社を削除します"), "すぐには消さず、確認モーダルを出す");
  check(calls.some((c) => c.kind === "bulk-delete-dry") && !calls.some((c) => c.kind === "bulk-delete"), "先にサーバで関連履歴を確かめる（まだ消さない）");
  check(/削除できない企業：1社/.test(txt) && txt.includes("反応商事") && txt.includes("アタック履歴あり"), "履歴のある企業は削除できない（理由つき）");
  check(txt.includes("対象外"), "消せない企業は「対象外」などのステータスを案内");
  check(await page.locator(".sl-modal button.btn-danger", { hasText: "1社を削除する" }).count() === 1, "削除ボタンは赤で、消せる企業の数だけ");
  await page.locator(".sl-modal button", { hasText: "1社を削除する" }).click();
  await page.waitForTimeout(600);
  const del = calls.find((c) => c.kind === "bulk-delete");
  check(del && del.body.ids.join() === "c1", "消すのは履歴の無い企業だけ");
  check(await page.locator('#rows tr[data-id="c1"]').count() === 0 && await page.locator('#rows tr[data-id="c2"]').count() === 1,
    "一覧から消え、履歴のある企業は残る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 送信チャネル：Instagram・送信元つきで送信完了 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.locator("#at-body").waitFor();
  await page.locator("#at-channel").selectOption("instagram");
  await page.waitForTimeout(500);
  const preps = calls.filter((c) => c.kind === "prepare");
  check(preps.at(-1)?.body.channel === "instagram", "チャネルを変えると、そのチャネルで専用URLを準備し直す（同じチャネルの30日チェック）");
  check((await page.locator(".atk").innerText()).includes("Instagramで貼り付け"), "手順の案内がチャネルに合わせて変わる");
  await page.locator("button", { hasText: "送信完了" }).click();
  await page.locator(".sl-modal").waitFor();
  check(await page.locator('.sl-modal input[name="sd-channel"][value="instagram"]').isChecked(), "選んだチャネルがモーダルで選ばれている");
  await page.locator("#sd-from").fill("@eight_xxx");
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  await page.waitForTimeout(800);
  const sent = calls.find((c) => c.kind === "act");
  check(sent && sent.body.channel === "instagram" && sent.body.sendFrom === "@eight_xxx", "Instagram・送信元を記録する");
  // 次に開いたときは、同じチャネルの送信元を覚えている（この端末だけ）
  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.locator("#at-body").waitFor();
  await page.locator("#at-channel").selectOption("instagram");
  await page.waitForTimeout(400);
  await page.locator("button", { hasText: "送信完了" }).click();
  await page.locator(".sl-modal").waitFor();
  check((await page.locator("#sd-from").inputValue()) === "@eight_xxx", "送信元は前回の値が入る");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 送信できなかった：理由を選んで記録 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?attack=c1`);
  await page.locator("#at-body").waitFor();
  await page.locator("button", { hasText: "送信できなかった" }).click();
  await page.locator(".sl-modal").waitFor();
  check((await page.locator(".sl-modal").innerText()).includes("問い合わせフォームがない"), "理由の候補が出る");
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  check((await page.locator("#fl-msg").innerText()).includes("理由を選んでください"), "理由なしでは記録しない");
  await page.locator('.sl-modal input[name="fl-reason"][value="other"]').check();
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  check((await page.locator("#fl-msg").innerText()).includes("メモ"), "「その他」はメモ必須");
  check(!calls.some((c) => c.kind === "act"), "ここまでは送らない");
  await page.locator('.sl-modal input[name="fl-reason"][value="no_form"]').check();
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  await page.waitForTimeout(800);
  const f = calls.find((c) => c.kind === "act");
  check(f && f.body.action === "failed" && f.body.reason === "no_form" && f.body.channel === "form", "送信できなかった（理由・チャネル）を記録した");
  check(!(await page.locator(".atk").count()), "記録するとアタック画面を閉じる");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 非表示：一括で非表示 → 一覧から消える → 非表示フィルター → 再表示 ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html`);
  await page.locator("#rows tr[data-id]").first().waitFor();
  const heads = await page.locator(".sl-table thead th").allInnerTexts();
  check(heads.join("|").includes("連絡手段") && !heads.includes("業種") && !heads.includes("フォーム"),
    `一覧の列は基本列（連絡手段あり・業種/フォームなし）：${heads.join(" ")}`);
  await page.locator('#rows tr[data-id="c1"] td.sl-check input').check();
  await page.locator("#bulk-more").click();
  await page.locator("#bulk-menu button", { hasText: "非表示にする" }).click();
  await page.locator(".sl-modal").waitFor();
  await page.locator("#bk-go").click();
  check((await page.locator("#bk-msg").innerText()).includes("理由"), "理由なしでは非表示にしない");
  await page.locator('.sl-modal input[name="bk-hide"][value="link_broken"]').check();
  await page.locator("#bk-go").click();
  await page.waitForFunction(() => !document.querySelector('#rows tr[data-id="c1"]'));
  const h = calls.find((c) => c.kind === "bulk-hide");
  check(h && h.body.reason === "link_broken" && h.body.ids.join() === "c1", "一括APIで非表示（理由つき）");
  check(!(await page.locator('#rows tr[data-id="c1"]').count()), "通常の一覧から消える");

  await page.locator("#f-visible").selectOption("hidden");
  await page.locator('#rows tr[data-id="c1"]').waitFor();
  check(calls.some((c) => c.kind === "list" && c.visibility === "hidden"), "「非表示」で取り直す");
  check((await page.locator('#rows tr[data-id="c1"]').innerText()).includes("非表示：リンク切れ"), "非表示の理由が状態に出る");
  await page.locator('#rows tr[data-id="c1"] td.sl-check input').check();
  await page.locator("#bulk-more").click();
  await page.locator("#bulk-menu button", { hasText: "再表示する" }).click();
  await page.locator("#bk-go").click();
  await page.waitForFunction(() => !document.querySelector('#rows tr[data-id="c1"]'));
  check(calls.some((c) => c.kind === "bulk-unhide"), "再表示した");
  await page.locator("#f-visible").selectOption("shown");
  await page.locator('#rows tr[data-id="c1"]').waitFor();
  check(true, "表示中に戻っている");
  check(!errs.length, `JSエラーなし ${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 返信・やり取りを記録：Instagramで返信 → メールへ ===");
{
  const { page, calls, errs } = await openAs();
  await page.goto(`${BASE}/sales/companies.html?id=c3`);
  await page.locator(".sl-detail #contact-status").waitFor();
  check((await page.locator("#contact-status").innerText()).includes("現在の連絡手段"), "企業詳細の上部に「現在の連絡状況」");
  await page.locator(".sl-detail button", { hasText: "返信・やり取りを記録" }).first().click();
  await page.locator(".sl-modal").waitFor();
  check(!(await page.locator(".sl-drawer").count()), "2つ目の右ドロワーではなく中央モーダル");
  // 返信あり（c3）の会社は「こちらから連絡」が初期値。返信に切り替える
  await page.locator('.sl-modal input[name="ct-kind"][value="reply"]').check();
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  check((await page.locator("#ct-msg").innerText()).includes("どこから返信"), "返信元は必須");
  await page.locator('.sl-modal input[name="ct-reply"][value="instagram"]').check();
  check((await page.locator("#ct-channel").inputValue()) === "instagram", "返信元と同じチャネルを連絡手段に入れておく");
  await page.locator("#ct-channel").selectOption("email");
  await page.locator("#ct-c-email").fill("tanaka@example.co.jp");
  await page.locator("#ct-note").fill("詳細資料はメールで送付");
  await page.locator("#ct-next").fill("資料送付");
  await page.locator("#ct-next-on").fill("2026-10-01");
  await page.locator(".sl-modal button", { hasText: "記録する" }).click();
  await page.waitForFunction(() => !document.querySelector(".sl-modal"));
  const r = calls.find((c) => c.kind === "contact");
  check(r && r.body.replied === true && r.body.replyChannel === "instagram" && r.body.contactChannel === "email",
    "返信元・いまの連絡手段を送る");
  check(r && r.body.contacts?.email === "tanaka@example.co.jp" && r.body.note.includes("資料"), "連絡先・メモを送る");
  check(r && r.body.nextAction === "資料送付" && r.body.nextActionOn === "2026-10-01", "NEXT も一緒に送る");
  await page.waitForFunction(() => (document.querySelector("#contact-status")?.innerText || "").includes("tanaka@example.co.jp"));
  check((await page.locator("#contact-status").innerText()).includes("メール"), "現在の連絡手段がメールになる");
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
