// 本人の入社準備（/onboarding/）を、実際のブラウザで見る。
//
// ■ 何を守りたいのか
//   ・6ステップ（入社案内確認 / 雇用契約 / 入社情報入力 / 必要書類提出 / 会社確認 / 入社準備完了）が、この並びで出る
//   ・「次にやること」が1つ、先に出る。本人の番なら押せるボタン、会社の番なら「操作は要りません」
//   ・入社案内は、確認ボタンで確認済みになる（サーバの返した状態をそのまま出す）
//   ・金額（円）は、どこにも出ない。社内準備の内訳も出ない
//   ・ログイン前でも、案内URLで案内だけ読める。ログインへ進める（戻り先つき）。開けないURLは理由を言う
//   ・別の人のURLでログインしていたら止まる
//   ・スマホ幅で横スクロールしない
//   ・ログイン後の戻り先（?next=）は、このサイトの中だけ（外へは行かない）
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const { mapSix } = await import("../../lib/onboard-six.js");
const { GUIDE_FIELDS } = await import("../../lib/onboard-guide.js");

const it = (owner, status = "todo", required = true) => ({ owner, status, required });
const facts = (o = {}) => ({ procedure: { status: "in_progress" }, order: null, sign: null, consentsOk: false, profile: null,
  items: [it("employee"), it("hr")], ...o });
const INTAKE = { order: { status: "signed" }, sign: { status: "signed" }, consentsOk: true };
const GUIDE = { name: "山田 太郎", joinOn: "2026-10-01", department: "開発", position: "エンジニア", role: "バックエンド",
  meeting_time: "9:45", start_time: "10:00", location: "原宿オフィス", schedule: "会社説明\nPC受取", belongings: "印鑑", contact: "03-0000-0000", staff: "人事 山田", message: "ようこそ" };
const FIELDS = GUIDE_FIELDS.map((f) => ({ key: f.key, label: f.label }));

function startBody({ f, guide = null, confirmed = false, career = null, hasProcedure = true }) {
  const six = mapSix({
    facts: f, career, audience: "self",
    guide: guide ? { status: "issued", version: 1, confirmedVersion: confirmed ? 1 : null, confirmedAt: confirmed ? "2026-09-20T01:00:00Z" : null } : null,
  });
  // API（api/onboarding/start.js）と同じ「押す先」
  const ctas = { guide: { label: "入社案内を確認する", action: "guide" }, info: { label: "入社情報を入力する", href: "/onboarding.html#step-3" },
    docs: { label: "必要書類を提出する", href: "/onboarding.html#step-4" }, contract: { label: "労働条件通知書を確認して署名する", href: "/contracts.html" } };
  for (const s of six.steps) s.cta = s.state === "current" && s.actor === "employee" ? ctas[s.key] || null : null;
  six.next.cta = (six.steps.find((s) => s.key === six.next.key) || {}).cta || null;
  if (six.after) six.after.cta = six.after.actor === "employee" ? { label: "キャリアプランを確認する", href: "/career.html#confirm" } : null;
  return {
    companyName: "株式会社エイト", employee: { name: "山田 太郎", department: "開発", position: "エンジニア", joinOn: "2026-10-01" },
    hasProcedure, six,
    guide: { issued: Boolean(guide), version: guide ? 1 : 0, confirmed, confirmedAt: confirmed ? "2026-09-20T01:00:00Z" : null,
      view: guide ? GUIDE : null, fields: FIELDS },
    links: { contracts: "/contracts.html", form: "/onboarding.html" },
  };
}

async function open({ url = "/onboarding/", loggedIn = true, start, guidePublic, width = 1280, startStatus = 200 }) {
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  const calls = { start: [], guide: [], posts: [] };
  await page.addInitScript((li) => {
    if (li) localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    else localStorage.removeItem("kp_session");
  }, loggedIn);
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const u = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/onboarding\/start/.test(u)) {
      if (req.method() === "POST") {
        const body = JSON.parse(req.postData() || "{}");
        calls.posts.push(body);
        const cur = typeof start === "function" ? start(body) : start;
        return send(cur.body, cur.status || 200);
      }
      calls.start.push(u);
      const cur = typeof start === "function" ? start() : start;
      return send(cur.body, cur.status || startStatus);
    }
    if (/\/api\/onboarding\/guide/.test(u)) {
      calls.guide.push(u);
      const g = typeof guidePublic === "function" ? guidePublic() : guidePublic;
      return send(g.body, g.status || 200);
    }
    return send({});
  });
  await page.goto(`${BASE}${url}`);
  await page.waitForTimeout(700);
  page.calls = calls;
  return page;
}
const text = (page) => page.locator("body").innerText();
const pathOf = (page) => { const u = new URL(page.url()); return u.pathname + u.search; };

console.log("— 案内が届いている・契約が済んで入力へ進んだ本人 —");
{
  let confirmed = false;
  const page = await open({
    start: (post) => {
      if (post) confirmed = true;
      return { body: startBody({ f: facts(INTAKE), guide: true, confirmed }) };
    },
  });
  const t = await text(page);
  const labels = await page.locator(".ob-st .tt").allInnerTexts();
  check(labels.map((x) => x.replace(/\s*(あなたの番です|会社が対応中).*$/, "").trim()).join("|")
    === "入社案内確認|雇用契約|入社情報入力|必要書類提出|会社確認|入社準備完了", `6ステップの並び（いま ${labels.join("|")}）`);
  check(t.includes("山田 太郎 さん") && t.includes("10月1日のご入社"), "宛名と入社日");
  check(await page.locator('[data-role="next"]').count() === 1, "「次にやること」は1つ");
  check((await page.locator('[data-role="next"]').innerText()).includes("入社案内の確認"), "次にやること＝入社案内の確認");
  check((await page.locator('.ob-st[data-step="guide"]').getAttribute("data-state")) === "current", "① は要対応");
  check((await page.locator('.ob-st[data-step="contract"]').getAttribute("data-state")) === "done", "② 雇用契約は完了");
  check((await page.locator('.ob-st[data-step="info"] .ob-chip').innerText()).includes("あなたの番です"), "③ は「あなたの番です」");
  check((await page.locator('.ob-st[data-step="company"] .ob-chip').innerText()).includes("会社が対応中"), "⑤ は「会社が対応中」");
  check((await page.locator('.ob-st[data-step="company"] .nt').innerText()) === "会社が準備・確認しています", "会社確認は内訳を出さない");
  check(await page.locator('.ob-st[data-step="company"] a, .ob-st[data-step="company"] button').count() === 0, "会社の番のステップに、本人のボタンは出ない");
  check((await page.locator('.ob-st[data-step="info"] a').getAttribute("href")) === "/onboarding.html#step-3", "入力は、これまでの画面へ");
  check(await page.locator("#guide").count() === 1 && (await page.locator("#guide").innerText()).includes("原宿オフィス"), "入社案内の内容が出る");
  check((await page.locator("#guide").innerText()).includes("9:45"), "集合時間が出る");
  check(!/円/.test(t), "金額（円）は、どこにも出ない");
  check(!t.includes("PC の準備") && !t.includes("社内準備"), "社内準備の内訳・件数は出ない（本人の書類の残りだけは、本人のものなので出る）");
  check(t.includes("1 / 4 完了") || /\d+ \/ \d+ 完了/.test(t), "進み具合（案内を含めて数える）");

  await page.click("#confirm-guide");
  await page.waitForTimeout(500);
  check(page.calls.posts.length === 1 && page.calls.posts[0].action === "confirm_guide" && page.calls.posts[0].version === 1, "確認は、版を付けて送る");
  check((await page.locator("#guide").innerText()).includes("確認済み"), "確認済みと出る");
  check((await page.locator('.ob-st[data-step="guide"]').getAttribute("data-state")) === "done", "① が完了になる（サーバの返した状態のまま）");
  check(await page.locator("#confirm-guide").count() === 0, "確認ボタンは消える");
  await page.close();
}

console.log("— 入社案内が無い・契約前の本人（案内は対象外。会社が準備中）—");
{
  const page = await open({ start: { body: startBody({ f: facts() }) } });
  const t = await text(page);
  check((await page.locator('.ob-st[data-step="guide"]').getAttribute("data-state")) === "na", "① は「対象外」");
  check(await page.locator("#guide").count() === 0, "案内が無ければ、案内の欄は出ない");
  check((await page.locator('[data-role="next"]').innerText()).includes("いまは、あなたの操作は必要ありません"), "会社の番なら「操作は要りません」");
  check(await page.locator('[data-role="next"] a, [data-role="next"] button').count() === 0, "押すボタンは出ない");
  check(t.includes("会社が労働条件通知書を準備しています"), "契約前は「会社が準備中」");
  await page.close();
}

console.log("— 入社準備が完了・キャリアは次の一手 —");
{
  const page = await open({ start: { body: startBody({ f: facts({ procedure: { status: "done" } }), guide: true, confirmed: true }) } });
  const t = await text(page);
  check(t.includes("入社準備は完了しました"), "完了と出る");
  check(await page.locator(".ob-st.done").count() === 6, "6ステップすべて完了");
  check(t.includes("6 / 6 完了"), "進み具合 6/6");
  check((await page.locator('[data-role="after"]').innerText()).includes("キャリア設定待ち"), "このあと: キャリア設定待ち（ステップには入らない）");
  await page.close();
}

console.log("— 入社手続きがまだ無い本人 —");
{
  const page = await open({ start: { body: startBody({ f: null, hasProcedure: false }) } });
  const t = await text(page);
  check(t.includes("入社手続きがまだ作られていません"), "作られていないと伝える");
  check(!t.includes("入社準備は完了しました"), "完了とは言わない");
  check(t.includes("確認できていません"), "確認できないステップは、そう言う");
  await page.close();
}

console.log("— ログイン前: 案内URLで案内だけ読める —");
{
  const page = await open({ url: "/onboarding/?t=" + "a".repeat(43), loggedIn: false,
    guidePublic: { body: { companyName: "株式会社エイト", guide: GUIDE, fields: FIELDS, version: 1, expiresAt: "2026-10-08T00:00:00Z" } } });
  const t = await text(page);
  check(t.includes("ご入社にあたって") && t.includes("原宿オフィス"), "案内が読める");
  check(page.calls.start.length === 0, "ログイン前は、本人の API を呼ばない");
  check(page.calls.guide.length === 1, "案内URLのAPIを1回呼ぶ");
  const href = await page.locator("#login").getAttribute("href");
  check(href === "/index.html?next=" + encodeURIComponent("/onboarding/?t=" + "a".repeat(43)), `ログインへ（戻り先つき）: ${href}`);
  check(!/円/.test(t), "金額は出ない");
  check(!t.includes("入社案内を確認する") && !t.includes("内容を確認しました"), "確認はログイン後（ここには確認ボタンが無い）");
  check((await page.locator('meta[name="referrer"]').getAttribute("content")) === "no-referrer", "URLのトークンを外部へ渡さない（no-referrer）");
  await page.close();
}

console.log("— ログイン前: 開けないURL —");
for (const [status, body, want] of [
  [404, { error: "invalid_token", hint: "このURLは開けません。担当者までお問い合わせください。" }, "このURLは開けません"],
  [410, { error: "expired", hint: "このURLの有効期限を過ぎています。恐れ入りますが、担当者までお問い合わせください。" }, "有効期限を過ぎています"],
]) {
  const page = await open({ url: "/onboarding/?t=" + "b".repeat(43), loggedIn: false, guidePublic: { status, body } });
  const t = await text(page);
  check(t.includes(want), `${status}: ${want}`);
  check(await page.locator("dl.ob-g").count() === 0, `${status}: 案内の中身は出ない`);
  await page.close();
}

console.log("— ログインしていない・URLも無い: ログインへ送る —");
{
  const page = await open({ url: "/onboarding/", loggedIn: false, guidePublic: { body: {} } });
  await page.waitForTimeout(500);
  check(pathOf(page) === "/index.html?next=" + encodeURIComponent("/onboarding/"), `ログインへ（いま ${pathOf(page)}）`);
  await page.close();
}

console.log("— 別の人のURLでログイン —");
{
  const page = await open({ url: "/onboarding/?t=" + "c".repeat(43),
    start: { status: 403, body: { error: "wrong_account", hint: "このURLは、別の方あてです。ログインしているアカウントをご確認ください。" } } });
  const t = await text(page);
  check(t.includes("別の方あてです"), "止まって、理由を言う");
  check(!t.includes("山田"), "別の人の情報は出ない");
  check(await page.locator("#relogin").count() === 1, "ログインし直すボタン");
  await page.close();
}

console.log("— スマホ幅：横スクロールしない —");
for (const width of [390, 360]) {
  const page = await open({ width, start: { body: startBody({ f: facts(INTAKE), guide: true }) } });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(overflow <= 0, `${width}px: 横スクロールが出ない（はみ出し ${overflow}px）`);
  if (width === 390) await page.screenshot({ path: shotPath("onboarding-hub-sp.png"), fullPage: true });
  await page.close();
}

console.log("— ログイン後の戻り先（?next=）は、このサイトの中だけ —");
{
  const page = await br.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route("**/api/**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.goto(`${BASE}/index.html`);
  const cases = [
    ["/onboarding/?t=abc_DEF-123", "/onboarding/?t=abc_DEF-123"],
    ["/onboarding/", "/onboarding/"],
    ["//evil.example.com", null],
    ["https://evil.example.com/", null],
    ["/\\evil.example.com", null],
    ["javascript:alert(1)", null],
    ["evil", null],
    ["", null],
    ["/a b", null],
    ["/<script>", null],
  ];
  for (const [n, want] of cases) {
    const got = await page.evaluate((v) => { history.replaceState(null, "", `/index.html?next=${encodeURIComponent(v)}`); return nextPath(); }, n);
    check(got === want, `next=${JSON.stringify(n)} → ${JSON.stringify(got)}（期待 ${JSON.stringify(want)}）`);
  }
  await page.close();
}

await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
