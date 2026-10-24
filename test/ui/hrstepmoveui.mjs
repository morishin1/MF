// 採用HR：応募者詳細の上部ステップから「理由を残して直接移動」を、実際のブラウザで通す（PC 1280px・スマホ 390px）。
// サーバは偽物（page.route）。移動できる先・注意は、本物の lib/hr-step-move.js で作る（画面と API の判定がずれないように）。
//
// ■ 何を守るテストか
//   1. 上部のステップバーは1本だけ（内定より前は選考ステップ、内定からは採用フロー）
//   2. ステップに「現在／移動できる／移動できない」が付き、押すと移動の画面が開く（移動できない段は理由を見せるだけ）
//   3. 先に確認（dryRun）して、変更前→変更後・注意・「メールは送りません」を見せる。理由と注意の確認が無いと押せない
//   4. 送るのは moveStep（理由・確認つき）だけ。メール・合格通知の API は呼ばない
//   5. 390px で横にはみ出さない
import { launch, BASE } from "../_browser.mjs";
import { stepMoveOptions, stepMoveNotices, stepMoveLabel } from "../../lib/hr-step-move.js";
import { shapeApplicant } from "../../lib/hr.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { shotPath } from "../_shot.mjs";

// 画面写真：既定は _shot.mjs の置き場所（CI でも書ける）。SHOT_DIR を渡せばそこへ（確認用に人へ渡すとき）
const SHOTS = process.env.SHOT_DIR || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shotFile = (name) => (SHOTS ? join(SHOTS, `${name}.png`) : shotPath(`${name}.png`));
const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const ME = (roles) => ({ email: "hr@example.test", appRole: "member", isAdmin: false, shows: {}, access: { recruit: true },
  gw: { employee: { id: "e-hr", display_name: "採用 花子" }, roles, isAdmin: false, tenantId: "t1", stage: null } });

function makeState(row = {}, { canDecide = true, offers = [] } = {}) {
  return {
    canDecide, offers, calls: [],
    row: { id: "a1", tenant_id: "t1", name: "架空 候補者", email: "kakuu@example.test", phone: "000-0000-0000", job_title: "営業",
      source: "Wantedly", stage: "applied", status: "todo", decision: null, rank: null, recruiter_id: "e-hr", lead_category: "recruitment",
      offer_type: null, ...row },
  };
}
function detailOf(state) {
  const a = { ...shapeApplicant(state.row), recruiterName: "採用 花子", alerts: [] };
  const m = stepMoveOptions(state.row, { offers: state.offers, interviews: [], canDecide: state.canDecide });
  return { applicant: a, timeline: [], interviews: [], offers: [], salaryVisible: true,
    stepMoves: { current: m.current, locked: m.locked, options: m.options.map(({ key, label, state: s, reason }) => ({ key, label, state: s, reason })) } };
}

async function open(state, { width = 1280, roles = ["owner"] } = {}) {
  const ctx = await br.newContext({ viewport: { width, height: width < 500 ? 844 : 900 }, timezoneId: "Asia/Tokyo" });
  const page = await ctx.newPage();
  await ctx.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "hr@example.test" })));
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await ctx.route("**/api/**", (route) => {
    const req = route.request(), url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(ME(roles));
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      if (req.method() === "PATCH") {
        const b = JSON.parse(req.postData() || "{}");
        state.calls.push(b);
        if (b.action !== "moveStep") return send({ error: "unexpected" }, 400);
        const m = stepMoveOptions(state.row, { offers: state.offers, interviews: [], canDecide: state.canDecide });
        const opt = m.options.find((o) => o.key === b.to);
        if (!opt || opt.state !== "allowed") return send({ error: "step_blocked", hint: opt?.reason || "x" }, 409);
        const { warnings, notes } = stepMoveNotices(state.row, opt, { offers: state.offers, interviews: [] });
        const labels = { from: stepMoveLabel(state.row.stage, state.row.status), to: stepMoveLabel(opt.target.stage, opt.target.status) };
        if (b.dryRun) return send({ dryRun: true, warnings, notes, ...labels });
        if (!String(b.reason || "").trim()) return send({ error: "reason_required", hint: "移動の理由を入力してください" }, 400);
        if (warnings.length && !b.acknowledgeWarnings) return send({ error: "step_move_warning", warnings, hint: warnings.join("\n") }, 409);
        Object.assign(state.row, { stage: opt.target.stage, status: opt.target.status, ...(opt.target.decision ? { decision: opt.target.decision } : {}) });
        return send({ applicant: shapeApplicant(state.row), warnings, notes, ...labels });
      }
      return send(detailOf(state));
    }
    if (/\/api\/hr\/applicants\b/.test(url)) return send({ applicants: [{ ...shapeApplicant(state.row), alerts: [], priority: 1 }], employees: [] });
    if (/\/api\/hr\/offers/.test(url) || /\/api\/hr\/applicants\/mail/.test(url)) { state.calls.push({ forbidden: url }); return send({}); }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/hr\/documents/.test(url)) return send({ documents: [], limits: {} });
    return send({});
  });
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForSelector(".hr-detail #hr-detail-next", { timeout: 15000 });
  await page.waitForTimeout(400);
  return { ctx, page, errs };
}
const shot = (page, name) => page.screenshot({ path: shotFile(name) });

for (const width of [1280, 390]) {
  console.log(`\n=== [${width}px] 新規応募 → 電話で合格確認 → 内定へ直接移動（社長） ===`);
  const state = makeState();
  const { ctx, page, errs } = await open(state, { width });
  check(await page.locator(".hr-detail .hr-steps").count() === 1, `[${width}] ステップバーは1本`);
  const marks = await page.locator("#hr-stage-steps li").evaluateAll((ls) => ls.map((l) => `${l.dataset.stage}:${l.dataset.move}`));
  check(marks.join(",") === "applied:current,casual_interview:allowed,ceo_recommend:allowed,ceo_interview:allowed,offer:allowed,joining_scheduled:blocked",
    `[${width}] 現在／移動できる／移動できない（${marks.join(",")}）`);
  check((await page.locator('#hr-stage-steps li[data-stage="joining_scheduled"]').getAttribute("title")).includes("承諾と契約の記録"), `[${width}] 移動できない理由が見える（title）`);
  await shot(page, `steps-bar-${width}`);

  // 移動できない段を押すと、理由を見せるだけ（選べない）
  await page.locator('#hr-stage-steps li[data-stage="joining_scheduled"] .hr-step-go').click();
  await page.waitForSelector("#mv-opts");
  check(await page.locator('#mv-opts .hr-mv-opt[data-key="joining_scheduled"] input').isDisabled(), `[${width}] 入社予定は選べない`);
  check((await page.locator('#mv-opts .hr-mv-opt[data-key="joining_scheduled"] .why').innerText()).includes("承諾と契約の記録"), `[${width}] 理由を出す`);
  check(await page.locator("#mv-go").isDisabled(), `[${width}] 選ぶまでは押せない`);
  await page.locator("#action-root .btn", { hasText: "やめる" }).click();

  // 内定を押すと、選んだ状態で確認（dryRun）が走る
  await page.locator('#hr-stage-steps li[data-stage="offer"] .hr-step-go').click();
  await page.waitForSelector("#mv-diff");
  check(state.calls.at(-1)?.dryRun === true && state.calls.at(-1)?.to === "offer", `[${width}] 先に確認だけ（dryRun）`);
  const diff = await page.locator("#mv-diff").innerText();
  check(diff.includes("新規応募（未対応）") && diff.includes("内定（合格通知作成待ち）"), `[${width}] 変更前→変更後`);
  check(diff.includes("メールは送られません。合格通知・契約・署名・書類の送付も行いません"), `[${width}] メール・合格通知を送らないと明示`);
  check(!(await page.locator("#mv-warnings").innerText()).includes("選考段階が"), `[${width}] 移動後の段階で注意を出す`);
  check((await page.locator("#mv-warnings").innerText()).includes("途中のステップ（カジュアル面談・社長推薦・社長面談）を飛ばします"), `[${width}] 飛ばす注意`);
  check(await page.locator("#mv-go").isDisabled(), `[${width}] 理由が無いと押せない`);
  await page.fill("#mv-reason", "電話で社長面談を行い、合格を確認済み（架空）");
  check(await page.locator("#mv-go").isDisabled(), `[${width}] 注意を確認していないと押せない`);
  await page.check("#mv-ack");
  check(await page.locator("#mv-go").isEnabled(), `[${width}] 理由＋確認で押せる`);
  await shot(page, `move-modal-${width}`);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `[${width}] 横にはみ出さない（${over}px）`);
  const modalFits = await page.locator("#action-root .hr-modal").evaluate((m) => { const r = m.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; });
  check(modalFits, `[${width}] 移動の画面が画面内`);
  await page.click("#mv-go");
  await page.waitForFunction(() => !document.querySelector("#mv-go"));
  const sent = state.calls.find((c) => c.action === "moveStep" && !c.dryRun);
  check(sent?.reason === "電話で社長面談を行い、合格を確認済み（架空）" && sent?.acknowledgeWarnings === true && sent?.to === "offer", `[${width}] 理由・確認つきで moveStep を送る`);
  check(!state.calls.some((c) => c.forbidden), `[${width}] メール・合格通知の API は呼ばない`);
  await page.waitForSelector("#hr-steps");
  check(await page.locator(".hr-detail .hr-steps").count() === 1 && await page.locator("#hr-stage-steps").count() === 0, `[${width}] 内定からは採用フローのバー1本だけ（重ねない）`);
  check((await page.locator("#hr-steps li.now").innerText()).includes("合格"), `[${width}] 現在地は合格`);
  await shot(page, `steps-offer-${width}`);
  check(errs.length === 0, `[${width}] 画面のエラーなし ${errs.join(" / ")}`);
  await ctx.close();
}

console.log("\n=== 採用担当：内定へは移動できない（理由つき）・ほかへは移動できる ===");
{
  const state = makeState({ stage: "ceo_interview", status: "ceo_interview_pending" }, { canDecide: false });
  const { ctx, page, errs } = await open(state, { roles: ["recruiter"] });
  check((await page.locator('#hr-stage-steps li[data-stage="offer"]').getAttribute("data-move")) === "blocked", "内定は移動できない");
  await page.click("#hr-step-move-open");
  await page.waitForSelector("#mv-opts");
  check((await page.locator('#mv-opts .hr-mv-opt[data-key="offer"] .why').innerText()).includes("社長・管理者"), "理由：社長・管理者だけ");
  await page.locator('#mv-opts .hr-mv-opt[data-key="casual_interview"]').click();
  await page.waitForSelector("#mv-diff");
  check(await page.locator("#mv-warnings").count() === 0, "戻すだけなら注意なし");
  await page.fill("#mv-reason", "カジュアル面談をやり直す（架空）");
  check(await page.locator("#mv-go").isEnabled(), "注意が無ければ理由だけで押せる");
  check(errs.length === 0, `画面のエラーなし ${errs.join(" / ")}`);
  await ctx.close();
}

console.log("\n=== 承諾済み：どこへも動かせない（記録を守る） ===");
{
  const state = makeState({ stage: "offer", status: "accepted", decision: "hired", offer_type: "contractor" },
    { offers: [{ id: "o1", version: 1, sent_at: "2026-10-01T00:00:00Z", accepted_at: "2026-10-02T00:00:00Z" }] });
  const { ctx, page } = await open(state);
  await page.click("#hr-step-move-open");
  await page.waitForSelector("#mv-locked");
  check((await page.locator("#mv-locked").innerText()).includes("承諾・契約・引き渡しの記録"), "動かせない理由を上に出す");
  check(await page.locator("#mv-opts input:not([disabled])").count() === 0, "選べる先は無い");
  await shot(page, "move-locked-1280");
  await ctx.close();
}

await br.close();
console.log(bad ? `\nNG ${bad}件` : "\nすべて通過");
process.exit(bad ? 1 : 0);
