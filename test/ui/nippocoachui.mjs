// 日報コーチの代表レビュー画面（admin-nippo-coach.html）を、実際のブラウザで通す。合成データ・偽の API だけ。
//
// ■ 何を守るテストか
//   1. 名簿の数（順調・要確認・要対応・未確認・対象外）と「合計が名簿と一致」が出る
//   2. 既定は「要対応・要確認」だけ。未確認・全員に切り替えられる。未確認は本人の問題ではないと書く
//   3. 根拠は ID・版・時刻だけ（本文は出さない）。下書き・宛先・不足情報が見える
//   4. 承認は、下書きの ID・本文・宛先の hash をそのまま送る。送信の API は呼ばない
//   5. 送信が無効のときは、その理由が出る
//   6. 1280・390px で横にはみ出さない
// スクリーンショットは test/_shot.mjs の一時領域（COACH_SHOT_DIR を指定すればそこ）
import { launch, BASE } from "../_browser.mjs";
import { accessOf } from "../../lib/gw.js";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
// 写真は判定に使わない。置き場所は _shot.mjs（一時領域）、COACH_SHOT_DIR があればそちら
const shot = (name) => (process.env.COACH_SHOT_DIR ? `${process.env.COACH_SHOT_DIR}/${name}` : shotPath(name));

const E = (n) => `cccc0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REVIEW = "99990001-0000-4000-8000-000000000000";
const DRAFT = { id: "draft-hash-1", text: "【EIGHT秘書P・下書き（ルール作成／代表確認前）】\n次勤務日に変える1つ：「合成の資料作成」の完了条件を1行で決めてから着手しましょう。",
  targetHash: "target-hash-1", needsContact: true, target: { members: ["BSYN", "USYN", "UM2"], senderId: "BSYN" },
  missing: ["シフト・実勤務の照合（休暇申請と会社休日は照合済み）"], goals: [{ review: { goal: { task: "合成の資料作成", quantity: null, unit: null, quantityStatus: "unset", completionCriteria: null }, missing: ["件数の根拠", "完了条件"] } }] };
const ref = (id, extra = {}) => ({ id, source: "tc_nippo", targetDate: "2026-10-21", submittedAt: "2026-10-21T09:30:00Z", version: "2026-10-21T09:30:00Z", ...extra });
const CHECKS = [
  { employee_id: E(1), name: "合成メンバー1", status: "ok", report_date: "2026-10-21", next_workday: "2026-10-22", revision: 1, checked_at: "2026-10-21T23:00:05Z", review_id: null, employmentType: "正社員", reasons: [], detail: { refs: [ref("report:2026-10-21")] } },
  { employee_id: E(2), name: "合成メンバー2", status: "check", report_date: "2026-10-21", next_workday: "2026-10-22", revision: 2, checked_at: "2026-10-21T23:00:05Z", review_id: REVIEW, employmentType: "アルバイト",
    reasons: [{ code: "no_plan_for_next_workday", label: "次勤務日の計画を確認できない" }], detail: { refs: [ref("report:2026-10-21"), { id: "roster:" + E(2), source: "gw_employees", version: "2026-10-01T00:00:00Z" }] } },
  { employee_id: E(3), name: "合成メンバー3", status: "action", report_date: "2026-10-21", next_workday: "2026-10-22", revision: 1, checked_at: "2026-10-21T23:00:05Z", review_id: null, employmentType: "正社員",
    reasons: [{ code: "overdue_tasks", label: "期限超過のタスクがある" }], detail: { refs: [] } },
  { employee_id: E(4), name: "合成メンバー4", status: "unconfirmed", report_date: null, next_workday: null, revision: 1, checked_at: "2026-10-21T23:00:05Z", review_id: null, employmentType: null,
    reasons: [{ code: "workdays_unknown", label: "勤務曜日が未設定" }], detail: { refs: [] } },
  { employee_id: E(5), name: "合成メンバー5", status: "excluded", report_date: null, next_workday: null, revision: 1, checked_at: "2026-10-21T23:00:05Z", review_id: null, employmentType: "正社員",
    reasons: [{ code: "left_confirmed", label: "退職を確認済み" }], detail: { refs: [] } },
];
const VIEW = { date: "2026-10-22", mode: "morning", checks: CHECKS,
  reviews: [{ id: REVIEW, employee_id: E(2), state: "owner_review", generation: 2, draft: DRAFT, approval: null }],
  outbox: [{ id: "88880000-0000-4000-8000-000000000000", kind: "owner_report", state: "draft", generation: 1, body: "【日報コーチ 朝の確認】2026-10-22\n名簿 5名：…", body_hash: "bh", target: { kind: "owner_dm", channelId: "DSYN", userId: "USYN" }, target_hash: "th" },
    { id: "88880001-0000-4000-8000-000000000000", kind: "team_advice", state: "blocked", generation: 1, body: "【日報コーチ・チーム向けのヒント】\n・次勤務日の最優先をひとつ決めましょう。", body_hash: "bh2", target: null, target_hash: null }],
  summary: { total: 5, ok: 1, check: 1, action: 1, unconfirmed: 1, excluded: 1, checked: 3, consistent: true },
  settings: { deliveryBlockedBy: "coach_delivery_disabled" }, deliveryEnabled: false };

async function open(width) {
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  const errs = [], posts = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" })); localStorage.removeItem("kp_layout"); localStorage.removeItem("kp_me"); });
  await page.route("**/api/**", (r) => {
    const u = r.request().url();
    const send = (b, status = 200) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(u)) {
      const roles = ["owner"];
      return send({ email: "a@b.c", appRole: "owner", isAdmin: true, roles,
        gw: { employee: { id: "e99", display_name: "合成代表", status: "active" }, roles, tenantId: "t1", isAdmin: true, stage: null }, access: accessOf({ isAdmin: true, roles }) });
    }
    if (/\/api\/nippo\/coach/.test(u)) {
      if (r.request().method() === "POST") { const b = JSON.parse(r.request().postData() || "{}"); posts.push(b); return send(b.action === "morning" ? { created: 0, changed: 1, unchanged: 4, reviewsWritten: 1 } : { approved: true, deliveryEnabled: false }); }
      return send(VIEW);
    }
    return send({});
  });
  await page.goto(`${BASE}/admin-nippo-coach.html`);
  await page.waitForSelector(".cc-person", { timeout: 15000 });
  return { page, errs, posts };
}

console.log("\n=== 1280px ===");
{
  const { page, errs, posts } = await open(1280);
  const sum = await page.locator("#cc-sum").innerText();
  check(/^5\s*名簿\s*1\s*順調\s*1\s*要確認\s*1\s*要対応\s*1\s*未確認\s*1\s*対象外/.test(sum), `名簿の数が出る（${sum.replace(/\n/g, " ")}）`);
  check((await page.locator("#cc-consistency").innerText()).includes("（一致）"), "合計が名簿と一致と出る");
  check((await page.locator("#cc-consistency").innerText()).includes("本人の問題ではありません"), "未確認は本人の問題ではないと書く");
  const names = await page.locator("#cc-list .cc-name").allInnerTexts();
  check(names.join("|") === "合成メンバー3|合成メンバー2", `既定は要対応・要確認だけ（${names.join("|")}）`);
  check((await page.locator("#notice").innerText()).includes("送信は無効"), "送信が無効の理由が出る");
  check((await page.locator(".cc-draft").first().innerText()).includes("完了条件"), "下書きが見える");
  check((await page.locator("#cc-list").innerText()).includes("限定グループ"), "宛先（全員）が見える");
  await page.locator("#cc-list details.cc-more").last().evaluate((d) => { d.open = true; });
  check((await page.locator(".cc-refs").last().innerText()).includes("report:2026-10-21"), "根拠のID・版が見える");
  await page.screenshot({ path: shot("coach-review-1280.png"), fullPage: true });
  await page.locator('#cc-filter button[data-f="unconfirmed"]').click();
  check((await page.locator("#cc-list .cc-name").allInnerTexts()).join("|") === "合成メンバー4", "未確認に切り替えられる");
  await page.locator('#cc-filter button[data-f="all"]').click();
  check(await page.locator("#cc-list .cc-person").count() === 5, "全員に切り替えられる");
  await page.locator("[data-approve]").click();
  await page.waitForTimeout(300);
  const ap = posts.find((p) => p.action === "approve");
  check(ap && ap.id === REVIEW && ap.draftId === DRAFT.id && ap.text === DRAFT.text && ap.targetHash === DRAFT.targetHash, "承認は下書きID・本文・宛先hashをそのまま送る");
  check(!posts.some((p) => p.action === "deliver"), "送信のAPIは呼ばない");
  await page.locator("[data-oapprove]").click();
  await page.waitForTimeout(300);
  const ao = posts.find((p) => p.action === "approve_outbox");
  check(ao && ao.bodyHash === "bh" && ao.targetHash === "th" && ao.generation === 1, "送信候補の承認は本文・宛先・世代に束縛");
  check(await page.locator("[data-oapprove]").count() === 1, "宛先未設定（blocked）の候補には承認ボタンがない");
  check(!errs.length, `画面のエラーなし：${errs.join(" / ")}`);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `横にはみ出さない（${over}）`);
  await page.close();
}

console.log("\n=== 390px ===");
{
  const { page, errs } = await open(390);
  await page.locator('#cc-filter button[data-f="all"]').click();
  await page.locator("#cc-list details.cc-more").evaluateAll((ds) => ds.forEach((d) => { d.open = true; }));
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `横にはみ出さない（${over}）`);
  check(!errs.length, `画面のエラーなし：${errs.join(" / ")}`);
  await page.screenshot({ path: shot("coach-review-390.png"), fullPage: true });
  await page.close();
}

await br.close();
console.log(bad ? `\nNG ${bad}` : "\nall ok");
process.exit(bad ? 1 : 0);
