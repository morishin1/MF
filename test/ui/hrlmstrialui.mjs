// 採用HR：応募者ドロワーの「無限道場 体験」パネルと［お礼＋無限道場体験を案内］（js/hr-lms-trial.js）を実際のブラウザで通す。
// サーバは偽物（page.route）。実際のメール・無限道場は使わない。
//
// ■ 何を守るテストか
//   1. パネルは概要タブの NEXT ACTION の下にだけ出る。無限道場を運営していない会社には出さない
//   2. 面談前は案内ボタンを出さない。面談後は［お礼＋無限道場体験を案内］→ 文面を確かめて・直して送る
//   3. 本人専用の URL は画面に出さない（送る直前にサーバーが入れる）。URL の差し込み位置を消したら送らない
//   4. 二度押しで2通送らない。通信が切れてやり直すときは同じ鍵。失敗から送り直すときは新しい鍵
//   5. 送信済みは［再送する］［URLをコピー］だけ（案内ボタンは消える）。再送は resend:true
//   6. 体験状況（進捗・6条件・完了）を出す。取れないときは「最新情報を取得できません」（未完了と書かない）。［再試行］
//   7. 体験完了でも合否は決めない（［採用判断へ進む］は NEXT ACTION へ移るだけで、何も送らない）
//   8. スマホ（320・390px）で横にはみ出さない
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const A1 = "11111111-1111-4111-8111-111111111111";
const ME = { email: "recruit@example.jp", appRole: "member", isAdmin: false, shows: {}, access: { recruit: true },
  gw: { employee: { id: "e-hr", display_name: "人事 花子", status: "active" }, roles: ["hr"], isAdmin: false, tenantId: "t1", stage: null } };
const NAME = "山田 太郎";
const URL_TAG = "{{無限道場体験URL}}";
const DRAFT = {
  subject: "【株式会社エイト】本日の面談のお礼と無限道場体験のご案内",
  body: `${NAME} 様\n\n本日はカジュアル面談のお時間をいただき、ありがとうございました。\n\n▼無限道場 体験版（個別登録URL）\n${URL_TAG}\n（このURLの有効期限：{{体験URLの有効期限}}）\n\n体験や継続受講の申し込みは、採用・契約の成立を意味しません。\n\n株式会社エイト\n採用担当`,
  missing: [], tags: [URL_TAG, "{{体験URLの有効期限}}"],
};
const COND = (on) => ["必須レッスン", "考え方（MVV）への回答", "AIとのやり取り", "3分AIチャレンジ", "小さな成果物", "振り返り"]
  .map((label, i) => ({ key: `c${i}`, label, done: i < on, ...(i === 0 ? { detail: `${Math.min(6, on * 2)}/6` } : {}) }));

/**
 * @param {object} o
 *   available / configured / interviewDone / lms: "none"|"active"|"done"|"down" / postMode(n, body) → "sent"|"abort"|"failed"
 */
async function open(o = {}, viewport = { width: 1300, height: 1000 }) {
  const st = { gets: 0, posts: [], sends: [], lms: o.lms || "none", interviewDone: o.interviewDone !== false };
  const page = await br.newPage({ viewport, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "recruit@example.jp" })); });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  const applicant = { id: A1, name: NAME, email: "taro@example.jp", jobTitle: "エンジニア", source: "Wantedly", stage: "casual_interview", stageLabel: "カジュアル面談",
    status: "eval_pending", statusLabel: "評価待ち", nextAction: "面談の評価を入力してください", nextActionCta: null, nextActionKey: null, rank: null };
  const lmsBody = () => {
    if (st.lms === "down") return { ok: false, error: "network", hint: "無限道場に接続できませんでした（時間切れ・通信の失敗）。少し待ってからやり直してください" };
    if (st.lms === "active") return { ok: true, stage: { key: "active", label: "体験中" }, registered: true, enrolled: true,
      progress: { percent: 50, lessonsDone: 3, lessonsTotal: 6, lastActivityAt: "2026-10-12T06:00:00Z" }, conditions: COND(3), course: "無限道場 体験版" };
    if (st.lms === "done") return { ok: true, stage: { key: "done", label: "体験完了" }, registered: true, enrolled: true,
      progress: { percent: 100, lessonsDone: 6, lessonsTotal: 6, lastActivityAt: "2026-10-12T07:00:00Z" }, conditions: COND(6), course: "無限道場 体験版" };
    if (st.lms === "invited") return { ok: true, stage: { key: "invited", label: "招待済み" }, progress: null, conditions: [] };
    return { ok: true, stage: { key: "none", label: "未招待" }, progress: null, conditions: [] };
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(ME);
    if (/\/api\/hr\/applicants\/lms-trial/.test(url)) {
      if (req.method() === "POST") {
        const b = JSON.parse(req.postData() || "{}");
        st.posts.push(b);
        if (b.action === "link") return send({ url: "https://lms.example.test/mgn/register?invite=SECRET-TOKEN", expiresAt: "2026-10-19T05:05:00Z", result: "reused" });
        const mode = o.postMode ? o.postMode(st.posts.length, b) : "sent";
        if (mode === "abort") return route.abort("failed");
        await new Promise((r) => setTimeout(r, 300));
        if (mode === "failed") {
          st.sends.unshift({ id: `s${st.posts.length}`, status: "failed", createdAt: "2026-10-12T05:00:00Z", sentByName: "人事 花子", error: "送信サービスが断りました（422）" });
          return send({ status: "failed", hint: "送れませんでした（送信サービスが断りました（422））。もう一度送ると、同じ招待URLで送ります" }, 502);
        }
        const dup = st.posts.filter((p) => p.requestKey === b.requestKey).length > 1;
        if (!dup) { st.sends.unshift({ id: `s${st.posts.length}`, status: "sent", createdAt: "2026-10-12T05:05:00Z", sentByName: "人事 花子" }); st.lms = "invited"; }
        return send({ status: "sent", duplicate: dup, invite: { result: "issued", expiresAt: "2026-10-19T05:05:00Z" } });
      }
      st.gets++;
      if (o.available === false) return send({ available: false });
      if (o.configured === false) return send({ available: true, configured: false, missing: ["MUGENDOJO_HR_LMS_SECRET"],
        lms: { ok: false, error: "not_configured", hint: "無限道場との連携の設定がありません（MUGENDOJO_HR_LMS_SECRET）" } });
      return send({ available: true, configured: true, missing: [], applicant: { id: A1, name: NAME, email: "taro@example.jp" },
        interviewDone: st.interviewDone, mail: { configured: true, reason: null, from: "株式会社エイト 採用 <recruit@example.jp>" },
        draft: DRAFT, sends: st.sends, lms: lmsBody() });
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) return send({ applicant, timeline: [], interviews: [], offers: [] });
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [applicant] });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}/hr/applicants.html?id=${A1}`);
  await page.waitForSelector("#hr-detail-tab .hr-next");
  if (o.available !== false) await page.waitForSelector("[data-lms-trial] .hd");
  else await page.waitForTimeout(600);
  return { page, st, errs };
}

const dialogs = (page) => {
  const seen = [];
  let answer = true;
  page.on("dialog", (d) => { seen.push(d.message()); answer ? d.accept() : d.dismiss(); });
  return { seen, set: (v) => { answer = v; } };
};
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

console.log("\n=== 置き場所・面談前・設定なし・ほかの会社 ===");
{
  const { page, st, errs } = await open({ interviewDone: false });
  await page.waitForSelector("[data-lms-wait]");
  check(await page.evaluate(() => document.querySelector(".hr-next").nextElementSibling?.hasAttribute("data-lms-trial")), "パネルは NEXT ACTION のすぐ下");
  check((await page.locator("[data-lms-stage]").innerText()) === "未招待", "段階：未招待");
  check((await page.locator("[data-lms-invite]").count()) === 0, "面談前は［お礼＋無限道場体験を案内］を出さない");
  check((await page.locator("[data-lms-wait]").innerText()).includes("カジュアル面談を実施済みにすると"), "面談前は、実施済みにすると案内できることを出す");
  await page.click('.hr-tabs button[data-tab="interviews"]');
  check((await page.locator("[data-lms-trial]").count()) === 0, "面談タブにはパネルを出さない");
  await page.click('.hr-tabs button[data-tab="overview"]');
  await page.waitForSelector("[data-lms-trial] [data-lms-stage]");
  check(st.gets === 1, `タブを行き来しても無限道場へ問い合わせ直さない（${st.gets}回）`);
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}
{
  const { page } = await open({ configured: false });
  await page.waitForSelector("[data-lms-unconfigured]");
  check((await page.locator("[data-lms-unconfigured]").innerText()).includes("MUGENDOJO_HR_LMS_SECRET"), "連携の設定が無いと、何が足りないかを出す（ボタンは出さない）");
  check((await page.locator("[data-lms-invite]").count()) === 0, "設定が無いと案内ボタンを出さない");
  await page.close();
}
{
  const { page } = await open({ available: false });
  check((await page.locator("[data-lms-trial]").count()) === 0, "無限道場を運営していない会社にはパネルを出さない");
  await page.close();
}

console.log("\n=== 案内を送る（文面・URL を出さない・二度押し） ===");
{
  const { page, st, errs } = await open();
  const dlg = dialogs(page);
  check((await page.locator("[data-lms-invite]").innerText()).includes("お礼＋無限道場体験を案内"), "面談後は［お礼＋無限道場体験を案内］が出る");
  await page.click("[data-lms-invite]");
  await page.waitForSelector("#lms-body");
  check(await page.locator("#lms-subject").inputValue() === DRAFT.subject, "件名が入っている");
  const body = await page.locator("#lms-body").inputValue();
  check(body.startsWith(`${NAME} 様`) && body.includes(URL_TAG), "本文：氏名と URL の差し込み位置");
  { const html = await page.content(); const i = html.search(/register\?invite=|lms\.example\.test/);
    check(i < 0, `本人専用の URL は画面に出さない${i < 0 ? "" : `：…${html.slice(i - 80, i + 40)}…`}`); }
  check((await page.locator(".hr-modal").innerText()).includes("taro@example.jp"), "宛先のメールアドレスが出る");

  // URL の差し込み位置を消すと送らない
  await page.fill("#lms-body", body.replace(URL_TAG, ""));
  await page.click("#lms-send");
  check((await page.locator("#lms-msg").innerText()).includes(URL_TAG), "URL の差し込み位置が無いと、理由を出して送らない");
  check(st.posts.length === 0, "サーバーに送らない");
  await page.fill("#lms-body", `${body}\n追伸：個別の一文`);

  // 二度押し
  await page.click("#lms-send");
  await page.locator("#lms-send").click({ force: true, timeout: 500 }).catch(() => {});
  await page.waitForSelector("[data-lms-result]");
  check(dlg.seen.some((m) => m.includes("taro@example.jp") && m.includes("本人専用の登録URL")), "送る前に宛先と URL のことを確かめる");
  check(st.posts.length === 1, `二度押ししても1回だけ送る（${st.posts.length}回）`);
  check(st.posts[0].action === "send" && st.posts[0].body.includes("追伸：個別の一文") && st.posts[0].resend === undefined, "直した本文を送る（再送ではない）");
  check((await page.locator("[data-lms-result]").getAttribute("data-lms-result")) === "sent", "結果：送信済み");
  check((await page.locator("[data-lms-result]").innerText()).includes("有効期限"), "URL の有効期限を出す（LMS の値）");
  await page.click("#lms-modal >> text=閉じる");
  await page.waitForSelector("[data-lms-sent]");
  check((await page.locator("[data-lms-stage]").innerText()) === "招待済み", "送ったあと：段階が招待済みに変わる");
  check((await page.locator("[data-lms-invite]").count()) === 0, "送ったあと：案内ボタンは消える（2通目を送らない）");
  check((await page.locator("[data-lms-resend]").count()) === 1 && (await page.locator("[data-lms-copy]").count()) === 1, "送ったあと：［再送する］［URLをコピー］");

  // 再送
  await page.click("[data-lms-resend]");
  await page.waitForSelector("#lms-send");
  check((await page.locator(".hr-modal").innerText()).includes("届いていないこと"), "再送は、届いていないことを確かめるよう出す");
  await page.click("#lms-send");
  await page.waitForSelector("[data-lms-result]");
  check(st.posts.at(-1).resend === true && st.posts.at(-1).requestKey !== st.posts[0].requestKey, "再送は resend:true・新しい鍵");
  await page.click("#lms-modal >> text=閉じる");

  // URL をコピー：URL は画面のパネルに残らない
  await page.click("[data-lms-copy]");
  await page.waitForTimeout(500);
  check(st.posts.at(-1).action === "link", "［URLをコピー］は URL を受け取るだけ（メールは送らない）");
  check(dlg.seen.some((m) => m.includes("本人以外に送らないでください")), "コピーの前後に、本人以外に送らないよう出す");
  check(!(await page.locator("[data-lms-trial]").innerHTML()).includes("SECRET-TOKEN"), "パネルに URL を残さない");
  check(errs.length === 0, `画面のエラーなし：${errs.join(" / ")}`);
  await page.close();
}

console.log("\n=== 通信が切れた・失敗した ===");
{
  const { page, st } = await open({ postMode: (n) => (n === 1 ? "abort" : n === 2 ? "failed" : "sent") });
  dialogs(page);
  await page.click("[data-lms-invite]");
  await page.waitForSelector("#lms-send");
  await page.click("#lms-send");
  await page.waitForFunction(() => document.getElementById("lms-msg")?.textContent.includes("通信が切れました"));
  check(true, "通信が切れたら、送れたか確かめるよう出す");
  await page.click("#lms-send");
  await page.waitForSelector('[data-lms-result="failed"]');
  check(st.posts[1].requestKey === st.posts[0].requestKey, "通信が切れたあとのやり直しは同じ鍵（2通目にならない）");
  await page.click("text=内容を確かめて送り直す");
  await page.click("#lms-send");
  await page.waitForSelector('[data-lms-result="sent"]');
  check(st.posts[2].requestKey !== st.posts[1].requestKey, "失敗から送り直すときは新しい鍵");
  await page.close();
}

console.log("\n=== 体験状況（進捗・完了・取れない） ===");
{
  const { page, st } = await open({ lms: "active" });
  await page.waitForSelector("[data-lms-progress]");
  check((await page.locator("[data-lms-stage]").innerText()) === "体験中", "段階：体験中");
  check((await page.locator("[data-lms-progress]").innerText()).includes("50%") && (await page.locator("[data-lms-progress]").innerText()).includes("3/6"), "進捗％・レッスン数");
  check((await page.locator('[data-lms-conditions] li[data-done="1"]').count()) === 3 && (await page.locator("[data-lms-conditions] li").count()) === 6, "6条件の達成を出す");
  check((await page.locator("[data-lms-invite]").count()) === 0, "登録済み・体験中には案内ボタンを出さない");
  st.lms = "done";
  await page.click("[data-lms-refresh]");
  await page.waitForSelector("[data-lms-done]");
  check((await page.locator("[data-lms-done]").innerText()).includes("体験の結果で合否は決まりません"), "完了：合否は決まらないと出す");
  const before = st.posts.length;
  await page.click("text=採用判断へ進む");
  await page.waitForTimeout(300);
  check(st.posts.length === before, "［採用判断へ進む］は NEXT ACTION へ移るだけ（何も送らない）");
  await page.close();
}
{
  const { page, st } = await open({ lms: "down" });
  await page.waitForSelector("[data-lms-unavailable]");
  const t = await page.locator("[data-lms-trial]").innerText();
  check(t.includes("最新情報を取得できません") && !/未完了|不合格|未招待/.test(t), "取れないときは「最新情報を取得できません」（未完了・未招待と書かない）");
  check((await page.locator("[data-lms-invite]").count()) === 1, "取れなくても、面談後なら案内は送れる（サーバーで確かめる）");
  st.lms = "active";
  await page.click("text=再試行");
  await page.waitForSelector("[data-lms-progress]");
  check(true, "［再試行］で読み直せる");
  await page.close();
}

console.log("\n=== スマホ ===");
for (const width of [320, 390]) {
  const { page } = await open({ lms: "active" }, { width, height: 860 });
  await page.waitForSelector("[data-lms-progress]");
  check((await overflow(page)) <= 0, `${width}px：横にはみ出さない`);
  const box = await page.locator("[data-lms-refresh]").boundingBox();
  check(box && box.x + box.width <= width, `${width}px：［最新にする］が画面内`);
  await page.close();
}

await br.close();
console.log(bad ? `\nNG ${bad}` : "\nall ok");
process.exit(bad ? 1 : 0);
