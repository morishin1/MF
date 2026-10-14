// 採用HR：応募者へメールを送る（/hr/applicants.html の［メールを送る］）と、メールひな型の管理（/hr/templates.html）を
// 実際のブラウザで通す。サーバは偽物（page.route）。実際のメールは送らない。
//
// ■ 何を守るテストか
//   1. 宛先（氏名・メールアドレス）がはっきり出る。名前の中の HTML は文字として出る
//   2. 直したあとにひな型を変えると確かめる（キャンセルなら直した内容が残る）
//   3. 差し込めない項目は理由つきで出し、［送信］しても送らない
//   4. ［送信］を押したときだけ送る。二度押しで2通送らない。通信が切れてやり直すときは同じ鍵（2通目にならない）
//   5. 結果を分けて出す：送信済み（受け付け）／失敗（直して送り直せる・鍵は新しく）／結果不明（送り直しのボタンを出さない）
//   6. ひな型の一覧（名前・用途・使用状態・更新日）・差し込みボタン・非表示の確かめ・複製
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const A1 = "11111111-1111-4111-8111-111111111111";
const ME = { email: "recruit@example.jp", appRole: "member", isAdmin: false, shows: {}, access: { recruit: true },
  gw: { employee: { id: "e-hr", display_name: "人事 花子", status: "active" }, roles: ["hr"], isAdmin: false, tenantId: "t1", stage: null } };
const NAME = `山田 <img src=x onerror="window.__xss=1"> 太郎`;

function templatesFixture() {
  return [
    { id: "t-std", name: "応募受付・事前質問・面談案内", purpose: "application", purposeLabel: "応募受付／カジュアル面談案内", active: true, isDefault: true, version: 1, standard: true, updatedAt: "2026-10-06T01:00:00Z" },
    { id: "t-ceo", name: "社長面談のご案内", purpose: "ceo", purposeLabel: "社長面談案内", active: true, isDefault: true, version: 3, standard: false, updatedAt: "2026-10-05T01:00:00Z" },
  ];
}
const RENDER = {
  "t-std": { templateId: "t-std", templateVersion: 1, templateName: "応募受付・事前質問・面談案内",
    subject: "ご応募ありがとうございます／事前質問とカジュアル面談のご案内",
    body: `${NAME} 様\nこのたびは…\nhttps://timerex.example/casual?applicant_id=${A1}\n株式会社エイト\n採用担当`, missing: [], unknown: [] },
  "t-ceo": { templateId: "t-ceo", templateVersion: 3, templateName: "社長面談のご案内", subject: "社長面談のご案内",
    body: `${NAME} 様\n{{面談予約URL}}`, missing: [{ key: "面談予約URL", reason: "社長面談の予約URL（TIMEREX_CEO_INTERVIEW_URL）が未設定です" }], unknown: [] },
};

async function openApplicants({ postMode }) {
  const posts = [];
  const sends = [];
  const page = await br.newPage({ viewport: { width: 1300, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@example.jp" })); });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  const applicant = { id: A1, name: NAME, email: "taro@example.jp", jobTitle: "エンジニア", source: "Wantedly", stage: "applied", stageLabel: "新規応募",
    status: "new", statusLabel: "新規", nextAction: "日程調整URLを送ってください", nextActionCta: null, nextActionKey: null, rank: null };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/applicants\/mail/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        posts.push(b);
        const mode = typeof postMode === "function" ? postMode(posts.length, b) : postMode;
        if (mode === "abort") return route.abort("failed");
        await new Promise((r) => setTimeout(r, 300));    // 送信中に二度押しされる時間
        if (mode === "failed") {
          sends.unshift({ id: `s${posts.length}`, status: "failed", subject: b.subject, templateName: "応募受付・事前質問・面談案内", templateVersion: 1, sentByName: "人事 花子", createdAt: "2026-10-06T02:00:00Z" });
          return send({ status: "failed", hint: "送れませんでした（送信サービスが断りました（422））。内容はそのまま残っています" }, 502);
        }
        if (mode === "unknown") {
          sends.unshift({ id: `s${posts.length}`, status: "unknown", subject: b.subject, templateName: "応募受付・事前質問・面談案内", templateVersion: 1, sentByName: "人事 花子", createdAt: "2026-10-06T02:00:00Z" });
          return send({ status: "unknown", hint: "送信サービスの応答がなく、送れたかどうか分かりません。相手に届いているか確かめるまで、送り直さないでください" }, 202);
        }
        const dup = posts.filter((p) => p.requestKey === b.requestKey).length > 1;
        if (!dup) sends.unshift({ id: `s${posts.length}`, status: "sent", subject: b.subject, templateName: "応募受付・事前質問・面談案内", templateVersion: 1, sentByName: "人事 花子", createdAt: "2026-10-06T02:00:00Z" });
        return send({ status: "sent", duplicate: dup });
      }
      const tid = new URL(url).searchParams.get("templateId") || "t-std";
      return send({ applicant: { id: A1, name: NAME, email: "taro@example.jp", jobTitle: "エンジニア" },
        templates: templatesFixture(), rendered: RENDER[tid], fields: [], sends,
        mail: { configured: true, reason: null, from: "株式会社エイト 採用 <recruit@example.jp>", replyTo: "hr@example.jp" } });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) return send({ applicant, timeline: [], interviews: [], offers: [] });
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [applicant] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/hr/applicants.html?id=${A1}`);
  await page.waitForSelector("#hr-mail-btn");
  return { page, posts, errs };
}

const dialogs = (page) => {
  const seen = [];
  let answer = true;
  page.on("dialog", (d) => { seen.push(d.message()); answer ? d.accept() : d.dismiss(); });
  return { seen, set: (v) => { answer = v; } };
};

console.log("\n=== 宛先・ひな型の切り替え・差し込めない項目 ===");
{
  const { page, posts, errs } = await openApplicants({ postMode: "sent" });
  const dlg = dialogs(page);
  await page.click("#hr-mail-btn");
  await page.waitForSelector("#mail-subject");
  check((await page.locator("#mail-to-name").innerText()).includes("山田 <img src=x onerror=\"window.__xss=1\"> 太郎 様"), "宛先の氏名が出る（HTML は文字のまま）");
  check((await page.locator("#mail-to-email").innerText()).includes("taro@example.jp"), "宛先のメールアドレスが出る");
  check((await page.locator(".hr-mail-to").innerText()).includes("hr@example.jp"), "返信先が出る");
  check(!(await page.evaluate(() => window.__xss)), "名前の中のスクリプトは動かない");
  check(await page.locator("#mail-tpl").inputValue() === "t-std", "既定のひな型が選ばれている");
  check((await page.locator("#mail-body").inputValue()).includes(`applicant_id=${A1}`), "この応募者の予約URLが入っている");

  // 直してからひな型を変える → 確かめる。キャンセルなら直した内容が残る
  await page.fill("#mail-body", `${await page.locator("#mail-body").inputValue()}\n追伸：個別の一文`);
  dlg.set(false);
  await page.selectOption("#mail-tpl", "t-ceo");
  await page.waitForTimeout(300);
  check(dlg.seen.some((m) => m.includes("直した内容は消えます")), "直したあとにひな型を変えると確かめる");
  check(await page.locator("#mail-tpl").inputValue() === "t-std", "キャンセルすると、ひな型は元のまま");
  check((await page.locator("#mail-body").inputValue()).includes("追伸：個別の一文"), "キャンセルすると、直した内容が残る");

  dlg.set(true);
  await page.selectOption("#mail-tpl", "t-ceo");
  await page.waitForSelector("#mail-missing");
  const miss = await page.locator("#mail-missing").innerText();
  check(miss.includes("{{面談予約URL}}") && miss.includes("TIMEREX_CEO_INTERVIEW_URL"), "差し込めない項目と理由が出る");
  await page.click("#mail-send");
  await page.waitForTimeout(300);
  check((await page.locator("#mail-msg").innerText()).includes("差し込まれていない項目"), "［送信］しても送らず、理由を出す");
  check(posts.length === 0, "サーバへ送っていない");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 送信：二度押しで2通送らない・送信済みの表示 ===");
{
  const { page, posts, errs } = await openApplicants({ postMode: "sent" });
  const dlg = dialogs(page);
  await page.click("#hr-mail-btn");
  await page.waitForSelector("#mail-subject");
  check(posts.length === 0, "開いただけでは送らない");
  await page.locator("#mail-send").dblclick();
  await page.waitForSelector("#mail-result-banner");
  check(dlg.seen.filter((m) => m.includes("へ送信します")).length >= 1, "送る前に宛先を出して確かめる");
  check(posts.length === 1, `二度押ししても送るのは1回（${posts.length}）`);
  check(/^[A-Za-z0-9_-]{8,80}$/.test(posts[0]?.requestKey || ""), "送信の鍵を付けて送る");
  check(posts[0]?.templateId === "t-std" && posts[0]?.templateVersion === 1, "ひな型の ID と版を付けて送る");
  const res = await page.locator("#mail-result-banner").innerText();
  check(res.includes("送信済み") && res.includes("受け付けました") && res.includes("届いた・開いた、ではありません"), "送信済み＝受け付け（到達・開封ではない）と出る");
  check(await page.locator("#mail-send").count() === 0, "送ったあとは［送信］を出さない");
  check((await page.locator("#mail-history").innerText()).includes("送信済み"), "送った記録に出る");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 通信が切れたら、同じ鍵でやり直す（2通目にならない） ===");
{
  const { page, posts } = await openApplicants({ postMode: (n) => (n === 1 ? "abort" : "sent") });
  dialogs(page);
  await page.click("#hr-mail-btn");
  await page.waitForSelector("#mail-subject");
  await page.click("#mail-send");
  await page.waitForFunction(() => document.getElementById("mail-msg")?.innerText.includes("通信が切れました"));
  check(true, "通信が切れたことを出す");
  await page.click("#mail-send");
  await page.waitForSelector("#mail-result-banner");
  check(posts.length === 2 && posts[0].requestKey === posts[1].requestKey, "やり直しは同じ鍵（サーバが2通目を送らない）");
  await page.close();
}

console.log("\n=== 失敗：直して送り直せる（鍵は新しく）／結果不明：送り直しのボタンを出さない ===");
{
  const { page, posts } = await openApplicants({ postMode: (n) => (n === 1 ? "failed" : "sent") });
  dialogs(page);
  await page.click("#hr-mail-btn");
  await page.waitForSelector("#mail-subject");
  await page.fill("#mail-subject", "【個別】件名");
  await page.click("#mail-send");
  await page.waitForSelector("#mail-result-banner");
  const r = await page.locator("#mail-result-banner").innerText();
  check(r.includes("失敗") && r.includes("送れませんでした"), "失敗と出る");
  check(await page.locator("#mail-subject").inputValue() === "【個別】件名", "直した内容は残っている");
  await page.locator("button", { hasText: "内容を確かめて送り直す" }).click();
  check(await page.locator("#mail-subject").inputValue() === "【個別】件名", "送り直すときも、直した内容のまま");
  await page.click("#mail-send");
  await page.waitForFunction(() => document.getElementById("mail-result-banner")?.dataset.status === "sent");
  check(posts.length === 2 && posts[0].requestKey !== posts[1].requestKey, "失敗のあとの送り直しは、新しい鍵");
  await page.close();
}
{
  const { page } = await openApplicants({ postMode: "unknown" });
  dialogs(page);
  await page.click("#hr-mail-btn");
  await page.waitForSelector("#mail-subject");
  await page.click("#mail-send");
  await page.waitForSelector("#mail-result-banner");
  const r = await page.locator("#mail-result-banner").innerText();
  check(r.includes("結果不明") && r.includes("送り直さないでください"), "結果不明と出る（すぐに送り直さない）");
  check(await page.locator("#mail-send").count() === 0 && await page.locator("button", { hasText: "送り直す" }).count() === 0, "送り直しのボタンを出さない");
  await page.close();
}

console.log("\n=== メールひな型の管理 ===");
{
  const page = await br.newPage({ viewport: { width: 1300, height: 1000 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@example.jp" })); });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  const posts = [];
  const list = [
    ...templatesFixture().map((t) => ({ ...t, subject: "件名", body: "{{応募者名}} 様" })),
    { id: "t-old", name: "古いひな型", purpose: "other", purposeLabel: "その他", active: false, isDefault: false, version: 2, standard: false, updatedAt: "2026-09-01T01:00:00Z", subject: "古い", body: "古い" },
  ];
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/mail-templates/.test(url)) {
      if (req.method() === "POST") { const b = JSON.parse(req.postData() || "{}"); posts.push(b); return send({ template: list[0] }); }
      return send({ templates: list, purposes: [
        { key: "application", label: "応募受付／カジュアル面談案内" }, { key: "casual", label: "カジュアル面談案内" },
        { key: "ceo", label: "社長面談案内" }, { key: "other", label: "その他" }],
        fields: ["応募者名", "募集職種", "面談予約URL", "担当者名", "会社名"].map((key) => ({ key, hint: key })) });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  const dlg = dialogs(page);
  await page.goto(`${BASE}/hr/templates.html`);
  await page.waitForSelector("tr[data-id]");
  check((await page.locator(".hr-nav a.on").innerText()).includes("メールひな型"), "HR のナビに「メールひな型」があり、選ばれている");
  const rows = await page.locator("#rows").innerText();
  check(rows.includes("応募受付・事前質問・面談案内") && rows.includes("応募受付／カジュアル面談案内") && rows.includes("使用中") && rows.includes("既定"), "名前・用途・使用状態・既定が出る");
  const upd = await page.locator('tr[data-id="t-std"] td').nth(3).innerText();
  check(/10:00|10\/6|10月6日/.test(upd) && upd.includes("版1"), `更新日（日本時間）と版が出る（${upd.replace(/\n/g, " ")}）`);
  check(!rows.includes("古いひな型"), "非表示のものは、はじめは出さない");
  await page.check("#show-off");
  check((await page.locator("#rows").innerText()).includes("古いひな型"), "「非表示のものも出す」で出る");
  check((await page.locator('tr[data-id="t-old"]').innerText()).includes("非表示"), "非表示と出る");

  // 作る：差し込みボタンでカーソルの位置に入る
  await page.locator("button", { hasText: "ひな型を作る" }).click();
  await page.fill("#mt-name", "テスト用");
  await page.selectOption("#mt-purpose", "casual");
  await page.fill("#mt-subject", "面談のご案内");
  await page.fill("#mt-body", " 様\n");
  await page.focus("#mt-body");
  await page.evaluate(() => { const b = document.getElementById("mt-body"); b.selectionStart = b.selectionEnd = 0; });
  await page.locator(".mt-fields button", { hasText: "{{応募者名}}" }).click();
  await page.evaluate(() => { const b = document.getElementById("mt-body"); b.selectionStart = b.selectionEnd = b.value.length; });
  await page.locator(".mt-fields button", { hasText: "{{面談予約URL}}" }).click();
  check(await page.locator("#mt-body").inputValue() === "{{応募者名}} 様\n{{面談予約URL}}", "差し込みボタンで、カーソルの位置に入る");
  await page.locator("#mt-save").click();
  await page.waitForTimeout(400);
  const c = posts.find((p) => p.action === "create");
  check(c && c.purpose === "casual" && c.body === "{{応募者名}} 様\n{{面談予約URL}}", "作成がサーバへ送られる");

  // 編集は版を付けて送る（他人の変更を上書きしない）
  await page.locator('tr[data-id="t-ceo"] button', { hasText: "編集" }).click();
  check((await page.locator(".mt-modal").innerText()).includes("版3 → 版4"), "編集すると版が上がることを出す");
  await page.fill("#mt-subject", "社長面談のご案内（改）");
  await page.locator("#mt-save").click();
  await page.waitForTimeout(400);
  const u = posts.find((p) => p.action === "update");
  check(u && u.id === "t-ceo" && u.version === 3, "編集は、読んだときの版を付けて送る");

  // 非表示は確かめる（キャンセルなら送らない）
  dlg.set(false);
  await page.locator('tr[data-id="t-std"] button', { hasText: "非表示" }).click();
  check(dlg.seen.some((m) => m.includes("消えません")), "非表示の前に確かめる（消えない・記録は残る）");
  check(!posts.some((p) => p.action === "set_active"), "キャンセルなら送らない");
  dlg.set(true);
  await page.locator('tr[data-id="t-std"] button', { hasText: "非表示" }).click();
  await page.waitForTimeout(300);
  check(posts.some((p) => p.action === "set_active" && p.active === false && p.id === "t-std"), "非表示を送る");
  await page.locator('tr[data-id="t-std"] button', { hasText: "複製" }).click();
  await page.waitForTimeout(300);
  check(posts.some((p) => p.action === "duplicate" && p.id === "t-std"), "複製を送る");
  await page.locator('tr[data-id="t-old"] button', { hasText: "使用" }).click();
  await page.waitForTimeout(300);
  check(posts.some((p) => p.action === "set_active" && p.active === true && p.id === "t-old"), "使用に戻せる");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

await br.close();
console.log(bad ? `\nNG ${bad}` : "\nall ok");
process.exit(bad ? 1 : 0);
