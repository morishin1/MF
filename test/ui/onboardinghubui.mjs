// 本人の入社準備（/onboarding/）を、実際のブラウザで見る。
//
// ■ 何を守りたいのか
//   ・本人向けのステップ（契約条件 / 契約書 / 入社情報 / 必要書類 / オリエンテーション / 会社の確認 / 完了。案内があれば先頭に入社案内）が、この並びで出る
//   ・上に「あなたの契約条件」。未登録の項目は「会社で準備中です」（空白・エラーにしない）
//   ・入社準備中の本人は、左メニューが4つだけ（ホーム／入社準備／給与管理／設定・セキュリティ）
//   ・エラーに、DB名・migration番号を出さない
//   ・「次にやること」が1つ、先に出る。本人の番なら押せるボタン、会社の番なら「操作は要りません」
//   ・入社案内は、確認ボタンで確認済みになる（サーバの返した状態をそのまま出す）
//   ・社内準備の内訳は出ない（契約条件の給与は、本人の自分のことなので、登録されていれば出る）
//   ・Primary CTA（黄色いボタン）は1つだけ
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
const { selfSteps, documentRows } = await import("../../lib/onboard-self.js");
const { stageFlags } = await import("../../lib/onboard-stage.js");
const { conditionRows } = await import("../../lib/onboard-conditions.js");

const it = (owner, status = "todo", required = true) => ({ owner, status, required, ...(owner === "employee" ? { item_key: "doc_id", title: "本人確認書類" } : { item_key: "pc", title: "PC の準備（社内）" }) });
const facts = (o = {}) => ({ procedure: { status: "in_progress" }, order: null, sign: null, consentsOk: false, profile: null,
  items: [it("employee"), it("hr")], ...o });
const INTAKE = { order: { status: "signed" }, sign: { status: "signed" }, consentsOk: true };
const GUIDE = { name: "山田 太郎", joinOn: "2026-10-01", department: "開発", position: "エンジニア", role: "バックエンド",
  meeting_time: "9:45", start_time: "10:00", location: "原宿オフィス", schedule: "会社説明\nPC受取", belongings: "印鑑", contact: "03-0000-0000", staff: "人事 山田", message: "ようこそ" };
const FIELDS = GUIDE_FIELDS.map((f) => ({ key: f.key, label: f.label }));

const EMP = { display_name: "山田 太郎", joined_on: "2026-10-01", department: "開発" };
const ACTIVE = { id: "c1", status: "active", contract_type: "契約社員", fixed_term: true, period_from: "2026-10-01", period_to: "2026-12-31",
  probation_months: 3, weekly_hours: 30, work_hours: "9:00〜17:00", job_content: "ITS事業部", wage_type: "月給", wage_amount: 250000 };

function startBody({ f, guide = null, confirmed = false, career = null, hasProcedure = true, contract = null }) {
  const six = mapSix({
    facts: f, career, audience: "self",
    guide: guide ? { status: "issued", version: 1, confirmedVersion: confirmed ? 1 : null, confirmedAt: confirmed ? "2026-09-20T01:00:00Z" : null } : null,
  });
  // API（api/onboarding/start.js）と同じ「本人向けの並べ方」と「押す先」
  const self = selfSteps(six, f ? stageFlags(f) : null);
  if (six.after) six.after.cta = six.after.actor === "employee" ? { label: "キャリアプランを確認する", href: "/career.html#confirm" } : null;
  return {
    companyName: "株式会社エイト", employee: { name: "山田 太郎", department: "開発", position: "エンジニア", joinOn: "2026-10-01" },
    hasProcedure, six, self,
    conditions: conditionRows(EMP, contract, contract ? "上長 花子" : null),
    documents: documentRows(f?.items),
    orientation: [{ id: "o1", title: "情報セキュリティ", required: true, confirmed: false }],
    guide: { issued: Boolean(guide), version: guide ? 1 : 0, confirmed, confirmedAt: confirmed ? "2026-09-20T01:00:00Z" : null,
      view: guide ? GUIDE : null, fields: FIELDS },
    links: { contracts: "/contracts.html", form: "/onboarding.html" },
  };
}

async function open({ url = "/onboarding/", loggedIn = true, start, guidePublic, width = 1280, startStatus = 200, me = null }) {
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
    if (me && /\/api\/me(\?|$)/.test(u)) return send(me);
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
    === "入社案内を確認|契約条件を確認|契約書を確認・署名|入社情報を入力|必要書類を提出|オリエンテーションを確認|会社の確認|入社準備完了", `ステップの並び（いま ${labels.join("|")}）`);
  check((await page.locator('[data-role="greeting"]').innerText()) === "山田 太郎さん、入社準備を進めましょう", "最上部の挨拶");
  check(t.includes("入社予定日") && t.includes("2026/10/01"), "入社予定日");
  check((await page.locator('[data-role="phase"]').innerText()) === "本人手続き中", "現在＝本人手続き中");
  check(await page.locator('[data-role="next"]').count() === 1, "NEXT ACTION は1つ");
  check((await page.locator('[data-role="next"]').innerText()).includes("入社案内を確認してください"), "NEXT ACTION＝入社案内を確認してください");
  check(await page.locator(".ob-btn:not(.sec):not(.dark)").count() === 1, "Primary CTA（黄色いボタン）は、画面で1つだけ");
  check(await page.locator('[data-role="next"] .ob-btn:not(.sec):not(.dark)').count() === 1, "Primary CTA は NEXT ACTION の中");
  check((await page.locator('.ob-st[data-step="guide"]').getAttribute("data-state")) === "current", "入社案内は要対応");
  check((await page.locator('.ob-st[data-step="contract"]').getAttribute("data-state")) === "done", "契約書は完了");
  check((await page.locator('.ob-st[data-step="conditions"]').getAttribute("data-state")) === "done", "契約条件の確認は完了");
  check((await page.locator('.ob-st[data-step="info"] .ob-chip').innerText()).includes("あなたの番です"), "入社情報は「あなたの番です」");
  check((await page.locator('.ob-st[data-step="company"] .ob-chip').innerText()).includes("会社が対応中"), "会社の確認は「会社が対応中」（本人がやることと会社がやることが分かれる）");
  check((await page.locator('.ob-st[data-step="company"] .nt').innerText()) === "会社が準備・確認しています", "会社確認は内訳を出さない");
  check(await page.locator(".ob-st a, .ob-st button").count() === 0, "ステップの行にはボタンを置かない（押す先は NEXT ACTION の1つ）");
  check(await page.locator("#guide").count() === 1 && (await page.locator("#guide").innerText()).includes("原宿オフィス"), "入社案内の内容が出る");
  check((await page.locator("#guide").innerText()).includes("9:45"), "集合時間が出る");
  check(!t.includes("PC の準備") && !t.includes("社内準備"), "社内準備の内訳・件数は出ない（本人の書類の残りだけは、本人のものなので出る）");
  check(/\d+ \/ \d+ 完了/.test(t), "進み具合");
  check(!/db\/\d|migration|SQL|テーブル/.test(t), "DB名・migration番号を出さない");

  // あなたの契約条件（契約がまだ登録されていない: 空白にせず「会社で準備中です」）
  const cond = page.locator('[data-role="conditions"]');
  check((await cond.innerText()).includes("あなたの契約条件"), "あなたの契約条件が出る");
  check((await cond.locator("dt").allInnerTexts()).join("|") === "入社日|雇用形態|契約期間|試用期間|勤務時間|勤務形態|担当|業務範囲|給与|相談先", "契約条件の項目");
  check((await cond.locator('dd[data-key="joinedOn"]').innerText()) === "2026/10/01", "名簿の入社日は出る");
  check((await cond.locator('dd[data-key="period"]').innerText()) === "会社で準備中です", "未登録は「会社で準備中です」");
  check((await cond.locator('dd[data-key="wage"]').innerText()) === "会社で準備中です", "給与も、未登録なら「準備中」（空白・エラーにしない）");
  check((await cond.locator('a.ob-btn.sec').getAttribute("href")) === "/contracts.html", "契約書を確認する → 既存の契約画面");
  check((await cond.locator('a[href="/mypage.html#cond-card"]').count()) === 1, "入社後はマイページで見返せる");

  // 必要書類・オリエンテーション
  const docs = page.locator('[data-role="documents"]');
  check((await docs.innerText()).includes("本人確認書類") && (await docs.innerText()).includes("未提出"), "必要書類: 何を・提出済みか");
  check(!(await docs.innerText()).includes("PC の準備"), "社内準備の項目は書類に出ない");
  check((await docs.locator("a.ob-btn.sec").getAttribute("href")) === "/onboarding.html#step-4", "書類の提出は、これまでの画面へ");
  const ori = page.locator('[data-role="orientation"]');
  check((await ori.innerText()).includes("情報セキュリティ") && (await ori.innerText()).includes("未確認"), "オリエンテーション: 確認済みか");
  check((await page.locator('a[href="/mypage.html#password"]').count()) === 1, "パスワード変更の案内");

  await page.click("#confirm-guide");
  await page.waitForTimeout(500);
  check(page.calls.posts.length === 1 && page.calls.posts[0].action === "confirm_guide" && page.calls.posts[0].version === 1, "確認は、版を付けて送る");
  check((await page.locator("#guide").innerText()).includes("確認済み"), "確認済みと出る");
  check((await page.locator('.ob-st[data-step="guide"]').getAttribute("data-state")) === "done", "入社案内が完了になる（サーバの返した状態のまま）");
  check(await page.locator("#confirm-guide").count() === 0, "確認ボタンは消える");
  await page.close();
}

console.log("— 契約条件が登録されている本人（管理側の契約がそのまま出る）—");
{
  const page = await open({ start: { body: startBody({ f: facts(INTAKE), contract: ACTIVE }) } });
  const cond = page.locator('[data-role="conditions"]');
  const v = (k) => cond.locator(`dd[data-key="${k}"]`).innerText();
  check(await v("contract") === "契約社員・有期契約", "雇用形態");
  check(await v("period") === "2026/10/01 ～ 2026/12/31", "契約期間");
  check(await v("probation") === "3か月", "試用期間");
  check(await v("hours") === "週30時間", "勤務時間");
  check(await v("workStyle") === "9:00〜17:00", "勤務形態");
  check(await v("role") === "ITS事業部", "担当");
  check(await v("wage") === "月給 250,000円", "給与（本人の自分のこと）");
  check(await v("manager") === "上長 花子", "相談先");
  check(await v("workScope") === "現在確認中", "契約は有効だが、ある項目だけ空のときは「現在確認中」");
  check(!(await cond.innerText()).includes("会社で準備中です"), "登録済みなら「準備中」は出ない");
  await page.close();
}

console.log("— 入社案内が無い・契約前の本人（案内は対象外。会社が準備中）—");
{
  const page = await open({ start: { body: startBody({ f: facts() }) } });
  const t = await text(page);
  check(await page.locator('.ob-st[data-step="guide"]').count() === 0, "案内が無ければ、案内のステップは出ない");
  check(await page.locator("#guide").count() === 0, "案内が無ければ、案内の欄は出ない");
  check((await page.locator('[data-role="phase"]').innerText()) === "会社確認中", "現在＝会社確認中");
  check((await page.locator('[data-role="next"]').innerText()).includes("いまは、あなたの操作は必要ありません"), "会社の番なら「操作は要りません」");
  check(await page.locator('[data-role="next"] a, [data-role="next"] button').count() === 0, "押すボタンは出ない");
  check(t.includes("会社が契約条件を準備しています"), "契約前は「会社が準備中」");
  check(t.includes("契約条件は、会社の準備が整うとここに表示されます"), "契約条件は「準備中」と伝える");
  await page.close();
}

console.log("— 入社準備が完了・キャリアは次の一手 —");
{
  const page = await open({ start: { body: startBody({ f: facts({ procedure: { status: "done" } }), guide: true, confirmed: true }) } });
  const t = await text(page);
  check(t.includes("入社準備は完了しました"), "完了と出る");
  check((await page.locator('[data-role="greeting"]').innerText()) === "山田 太郎さん、入社準備は完了しました", "挨拶も完了");
  check(await page.locator(".ob-st.done").count() === 8, "ステップすべて完了");
  check(/8 \/ 8 完了/.test(t), "進み具合 8/8");
  check((await page.locator('[data-role="phase"]').innerText()) === "入社準備完了", "現在＝入社準備完了");
  check((await page.locator('[data-role="after"]').innerText()).includes("キャリア設定待ち"), "このあと: キャリア設定待ち（ステップには入らない）");
  await page.close();
}

console.log("— 入社手続きがまだ無い本人 —");
{
  const page = await open({ start: { body: startBody({ f: null, hasProcedure: false }) } });
  const t = await text(page);
  check(t.includes("入社手続きの情報は、会社で準備しています"), "準備中と伝える（本人の入力漏れに見せない）");
  check(!t.includes("入社準備は完了しました"), "完了とは言わない");
  check(t.includes("現在確認できていません"), "確認できないステップは、そう言う");
  check(!/db\/\d|migration|SQL|テーブル|データ未連携/.test(t), "技術的な語を出さない");
  await page.close();
}

console.log("— 読み込めなかったとき: 本人向けの文言だけ（DB名・migration番号を出さない）—");
for (const [status, body] of [
  [503, { error: "not_ready", message: "この機能に必要なテーブルがまだ作られていません。管理者に db/104_onboarding_guide.sql の実行を依頼してください" }],
  [500, { error: "db_read_failed", detail: "column gw_procedure_items.item_key does not exist" }],
  [500, { error: "start_failed", detail: "relation \"gw_procedures\" does not exist" }],
]) {
  const page = await open({ start: { status, body } });
  const t = await text(page);
  check(t.includes("入社手続き情報を現在確認できません。管理担当者へお問い合わせください。"), `${status} ${body.error}: 本人向けの文言`);
  check(!/db\/\d|migration|SQL|テーブル|gw_|column|relation|\.sql/i.test(t), `${status} ${body.error}: 技術的な語は出ない`);
  await page.close();
}

console.log("— 入社準備中の本人のメニュー: 4つだけ —");
{
  const ME = { email: "a@b.c", appRole: "member", isAdmin: false, access: {},
    gw: { employee: { display_name: "山田 太郎", status: "invited" }, roles: [],
      stage: { key: "preparing", label: "入社準備", unlocked: false, preparingOnly: ["onboarding"],
        allowed: ["home", "tasks", "dojo", "onboarding", "contracts", "mypage", "menu", "help"] } } };
  const page = await open({ me: ME, start: { body: startBody({ f: facts(INTAKE) }) } });
  const side = (await page.locator(".kp-sidebar .kp-side-item > span:not(.material-symbols-outlined)").allInnerTexts()).map((x) => x.replace(/\s+/g, ""));
  check(side.join("|") === "ホーム|入社準備|給与管理|設定・セキュリティ", `左メニューは4つ（いま ${side.join("|")}）`);
  check((await page.locator(".kp-sidebar a.on > span:not(.material-symbols-outlined)").allInnerTexts()).map((x) => x.trim()).join("|") === "入社準備", "いまは「入社準備」が選ばれている");
  check((await page.locator(".kp-sidebar a[href='/mypage.html#cond-card']").count()) === 1, "給与管理は、マイページの労働条件（給与）へ");
  const t = await text(page);
  check(!/今日やること|勤怠・申請|キャリア|社内情報|社内AI/.test(side.join("|")), "通常メンバー向けの機能は並べない");
  check(t.includes("山田 太郎さん、入社準備を進めましょう"), "共通メニュー付きでも、本文は出る");
  await page.close();

  // 入社準備が終わった（unlocked）本人は、通常のメニューに切り替わる
  const done = { ...ME, gw: { ...ME.gw, stage: { ...ME.gw.stage, unlocked: true, allowed: ["home", "tasks", "nippo", "schedule", "messages", "workflow", "info", "notices", "library", "directory", "mypage", "contracts", "timecard", "requests", "expenses", "career", "dojo", "timecard_ext", "onboarding", "booking", "docs", "menu", "help"] } } };
  const p2 = await open({ me: done, start: { body: startBody({ f: facts(INTAKE) }) } });
  const side2 = (await p2.locator(".kp-sidebar .kp-side-item > span:not(.material-symbols-outlined)").allInnerTexts()).map((x) => x.replace(/\s+/g, ""));
  check(side2.includes("今日やること") && side2.includes("勤怠・申請") && side2.includes("マイページ"), `入社準備が終わると通常のメニュー（いま ${side2.join("|")}）`);
  await p2.close();

  // スマホ幅の下タブも、同じ4つ
  const p3 = await open({ me: ME, width: 390, start: { body: startBody({ f: facts(INTAKE) }) } });
  const tabs = (await p3.locator(".kp-tabbar .kp-tab > span:not(.material-symbols-outlined)").allInnerTexts()).map((x) => x.replace(/\s+/g, ""));
  check(tabs.join("|") === "ホーム|入社準備|給与管理|設定", `下タブも4つ（いま ${tabs.join("|")}）`);
  await p3.close();
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
