// 採用HR：日本時間の表示・NEXT ACTION の面談を ID で実施済みにする・状態プルダウンを、実際のブラウザで通す。
//
// ■ 何を守るテストか
//   1. 端末が日本以外のタイムゾーン（ここでは米国西海岸）でも、HR の日時は日本時間
//      UTC 07:15 → 「本日 16:15」（面談タブ・履歴・NEXT ACTION・CEO REVIEW で同じ）
//   2. 日付またぎ（UTC 9/30 16:30 = 日本 10/1 01:30＝日本では「本日」）と、datetime-local の編集前後で 9 時間ずれない
//   3. 古いカジュアル面談が残っていても、NEXT ACTION の「実施済みにする」は nextInterviewId（社長面談）を送る
//      実施後は NEXT ACTION「社長判断をしてください」・CTA「採用判断」
//   4. 「選考」「状態（プルダウン）」「NEXT ACTION」を並べて出す。状態の変更は確認ダイアログ（注意つき）→
//      保存 → 応募者一覧・右ドロワーを読み直す。キャンセルしたら何も送らない
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const OWNER_ME = { email: "ceo@8grp.co.jp", appRole: "member", isAdmin: false, shows: {},
  gw: { employee: { id: "emp-o1", display_name: "社長" }, roles: ["owner"], isAdmin: false, tenantId: "t1", stage: null } };
const NOW = new Date("2026-10-01T03:00:00Z");           // 日本時間 2026/10/1 12:00（米国ではまだ 9/30）
const CEO_AT = "2026-10-01T07:15:00Z";                  // 日本時間 16:15
const OLD_AT = "2026-09-30T16:30:00Z";                  // 日本時間 10/1 01:30（UTC では前日）
const STATUS_OPTIONS = [
  ["todo", "未対応"], ["scheduling", "日程調整中"], ["interview_scheduled", "面談予定"], ["eval_pending", "評価入力待ち"],
  ["ceo_interview_pending", "社長面談設定待ち"], ["ceo_decision_pending", "社長判断待ち"],
].map(([key, label]) => ({ key, label }));

function makeState() {
  return {
    applicant: {
      id: "a1", name: "匿名 候補者", jobTitle: "エンジニア", source: "Wantedly",
      stage: "ceo_interview", stageLabel: "社長面談", status: "interview_scheduled", statusLabel: "面談予定",
      nextAction: "本日 16:15 社長面談", nextActionCta: "面談を実施済みにする", nextActionKey: "conduct",
      nextInterviewId: "iv-ceo", nextInterviewKind: "ceo",
      rank: "A", decision: null, decisionDueOn: null,
    },
    interviews: [
      // 作成の新しい順で先に来る、古いカジュアル面談（未完了のまま・手動登録）
      { id: "iv-old", applicantId: "a1", kind: "casual", kindLabel: "カジュアル面談", scheduledAt: OLD_AT,
        conductedAt: null, canceled: false, canceledAt: null, done: false, interviewerId: null, meetingUrl: null,
        recordingUrl: null, scores: {}, rank: null, timerex: null },
      { id: "iv-ceo", applicantId: "a1", kind: "ceo", kindLabel: "社長面談", scheduledAt: CEO_AT,
        conductedAt: null, canceled: false, canceledAt: null, done: false, interviewerId: null,
        meetingUrl: "https://meet.google.com/anon", recordingUrl: null, scores: {}, rank: null,
        timerex: { linked: true, syncedAt: null, rescheduleUrl: null, cancelUrl: null } },
    ],
    timeline: [{ id: "t1", eventKey: "interview_scheduled", label: "社長面談が決まりました（TimeRex）", detail: null, occurredAt: CEO_AT }],
  };
}

async function open(state, calls) {
  const ctx = await br.newContext({ viewport: { width: 1300, height: 1100 }, timezoneId: "America/Los_Angeles" });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(NOW);
  await ctx.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ceo@8grp.co.jp" }));
  });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await ctx.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => JSON.parse(req.postData() || "{}");
    if (/\/api\/me\b/.test(url)) return send(OWNER_ME);
    if (/\/api\/hr\/interviews\b/.test(url) && req.method() === "PATCH") {
      const b = body(); calls.push(["interview", b]);
      if (b.action === "conduct") {
        const iv = state.interviews.find((x) => x.id === b.id);
        Object.assign(iv, { done: true, conductedAt: "2026-10-01T07:50:00Z" });
        Object.assign(state.applicant, { status: "ceo_decision_pending", statusLabel: "社長判断待ち",
          nextAction: "社長判断をしてください", nextActionCta: "採用判断", nextActionKey: "decide", nextInterviewId: null });
        return send({ interview: iv, status: "ceo_decision_pending" });
      }
      if (b.action === "update") return send({ interview: state.interviews.find((x) => x.id === b.id) });
      return send({});
    }
    if (/\/api\/hr\/applicants\/detail/.test(url)) {
      if (req.method() === "PATCH") {
        const b = body(); calls.push(["applicant", b]);
        if (b.action === "setStatus") {
          const to = STATUS_OPTIONS.find((o) => o.key === b.status);
          const warnings = b.status === "ceo_decision_pending" && !state.interviews.some((i) => i.kind === "ceo" && i.done)
            ? ["実施済みの社長面談がありません。社長面談をせずに社長判断待ちになります。"] : [];
          if (b.dryRun) return send({ dryRun: true, warnings, from: state.applicant.statusLabel, to: to.label });
          if (warnings.length && !b.acknowledgeWarnings) return send({ error: "status_change_warning", warnings }, 409);
          Object.assign(state.applicant, { status: to.key, statusLabel: to.label,
            nextAction: to.key === "ceo_decision_pending" ? "社長判断をしてください" : state.applicant.nextAction,
            nextActionCta: to.key === "ceo_decision_pending" ? "採用判断" : state.applicant.nextActionCta,
            nextActionKey: to.key === "ceo_decision_pending" ? "decide" : state.applicant.nextActionKey });
          state.timeline.push({ id: "t2", eventKey: "status_manual", label: "状態を手動変更",
            detail: `面談予定 → ${to.label}`, occurredAt: NOW.toISOString() });
          return send({ applicant: state.applicant, warnings });
        }
        return send({ applicant: state.applicant });
      }
      calls.push(["detail-get"]);
      return send({ applicant: state.applicant, interviews: state.interviews, interviewers: [],
        timeline: state.timeline, offers: [], evalItems: [], evalScale: [], ranks: [], rankLabel: {},
        interviewKinds: [], statusOptions: STATUS_OPTIONS });
    }
    if (/\/api\/hr\/applicants\b/.test(url)) { calls.push(["list-get"]); return send({ applicants: [state.applicant] }); }
    if (/\/api\/hr\/ceo-review/.test(url)) {
      const card = { ...state.applicant, ceoInterview: state.interviews.find((i) => i.kind === "ceo") };
      return send({ todayMeetings: [card], recommended: [], decisionPending: [] });
    }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  return { ctx, page, errs };
}

console.log("\n=== 日本時間の表示（端末は米国西海岸） ===");
{
  const state = makeState(); const calls = [];
  const { ctx, page, errs } = await open(state, calls);
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1000);
  check(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) === "America/Los_Angeles", "端末のタイムゾーンは日本ではない");

  const next = await page.locator(".hr-next").innerText();
  check(next.includes("本日 16:15 社長面談"), "NEXT ACTION：本日 16:15 社長面談");
  check(/選考\s*社長面談/.test(next), "選考：社長面談（どこまで進んでいるか）");
  check(await page.locator(".hr-next #hr-status").inputValue() === "interview_scheduled", "状態：プルダウンで「面談予定」");
  check(next.indexOf("選考") < next.indexOf("状態") && next.indexOf("状態") < next.indexOf("NEXT ACTION"), "選考 → 状態 → NEXT ACTION の順");

  await page.locator('.hr-tabs button[data-tab="interviews"]').click();
  await page.waitForTimeout(300);
  const tab = await page.locator("#hr-detail-tab").innerText();
  check(tab.includes("予定：本日 16:15"), "面談タブ：社長面談 本日 16:15（UTC 07:15）");
  check(tab.includes("予定：本日 01:30"), "面談タブ：日付またぎ（UTC では前日 9/30 16:30 → 日本では本日 01:30）");
  check(!tab.includes("9/30"), "UTC の日付（9/30）を出さない");

  // 手動の古い面談の「日時を変更」：datetime-local は日本時間。保存しても 9 時間ずれない
  await page.locator("button", { hasText: "日時を変更" }).click();
  await page.waitForTimeout(300);
  const v = await page.locator("#rs-when").inputValue();
  check(v === "2026-10-01T01:30", `datetime-local は日本時間（${v}）`);
  await page.locator(".hr-modal button", { hasText: "保存する" }).click();
  await page.waitForTimeout(500);
  const upd = calls.find(([k, b]) => k === "interview" && b.action === "update")?.[1];
  check(upd?.scheduledAt === "2026-09-30T16:30:00.000Z", `そのまま保存しても同じ時刻（${upd?.scheduledAt}）`);
  calls.length = 0;
  await page.evaluate(() => typeof closeHrModal === "function" && closeHrModal());

  await page.locator('.hr-tabs button[data-tab="history"]').click();
  await page.waitForTimeout(300);
  check((await page.locator("#hr-detail-tab").innerText()).includes("本日 16:15"), "履歴：本日 16:15");

  // CEO REVIEW：同じ面談が同じ時刻
  const ceo = await ctx.newPage();
  await ceo.goto(`${BASE}/hr/ceo-review.html`);
  await ceo.waitForTimeout(1000);
  check((await ceo.locator("#today").innerText()).includes("本日 16:15"), "CEO REVIEW：本日 16:15（応募者詳細と同じ）");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await ctx.close();
}

console.log("\n=== NEXT ACTION の「実施済みにする」は社長面談だけ ===");
{
  const state = makeState(); const calls = [];
  const { ctx, page, errs } = await open(state, calls);
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1000);
  page.once("dialog", (d) => d.accept());
  await page.locator(".hr-next button", { hasText: "面談を実施済みにする" }).click();
  await page.waitForTimeout(800);
  const sent = calls.filter(([k, b]) => k === "interview" && b.action === "conduct").map(([, b]) => b.id);
  check(sent.length === 1 && sent[0] === "iv-ceo", `社長面談（nextInterviewId）だけを送る（${sent.join(",")}）`);
  check(!state.interviews.find((i) => i.id === "iv-old").done, "古いカジュアル面談は実施済みにならない");
  const next = await page.locator(".hr-next").innerText();
  check(next.includes("社長判断をしてください"), "NEXT ACTION：社長判断をしてください");
  check(await page.locator(".hr-next button", { hasText: "採用判断" }).count() === 1, "CTA：採用判断");
  check(!/社長面談を設定|面談を予定する/.test(next), "面談の設定へ戻らない");
  check(await page.locator(".hr-next #hr-status").inputValue() === "ceo_decision_pending", "状態：社長判断待ち");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await ctx.close();
}

console.log("\n=== 状態のプルダウン ===");
{
  const state = makeState(); const calls = [];
  const { ctx, page, errs } = await open(state, calls);
  await page.goto(`${BASE}/hr/applicants.html?id=a1`);
  await page.waitForTimeout(1000);
  const opts = await page.locator("#hr-status option").allInnerTexts();
  check(opts.map((s) => s.trim()).join("/") === STATUS_OPTIONS.map((o) => o.label).join("/"), "選択肢は API（lib/hr.js）のとおり");

  console.log("— 確認ダイアログでやめる → 何も変えない —");
  let msg = "";
  page.once("dialog", (d) => { msg = d.message(); d.dismiss(); });
  await page.selectOption("#hr-status", "ceo_decision_pending");
  await page.waitForTimeout(600);
  check(msg.includes("状態を") && msg.includes("「面談予定」→「社長判断待ち」") && msg.includes("に変更しますか？"), "確認：「面談予定」→「社長判断待ち」に変更しますか？");
  check(msg.includes("実施済みの社長面談がありません"), "データの食い違いの注意も出す");
  check(msg.includes("面談の日時・予約は変わりません"), "面談（TimeRex）は変わらないことを伝える");
  check(!calls.some(([k, b]) => k === "applicant" && !b.dryRun), "やめたら保存しない");
  check(await page.locator("#hr-status").inputValue() === "interview_scheduled", "プルダウンは元に戻る");

  console.log("— 確認して変更 → 一覧・ドロワーを読み直す —");
  calls.length = 0;
  page.once("dialog", (d) => d.accept());
  await page.selectOption("#hr-status", "ceo_decision_pending");
  await page.waitForTimeout(900);
  const saved = calls.find(([k, b]) => k === "applicant" && b.action === "setStatus" && !b.dryRun)?.[1];
  check(saved?.status === "ceo_decision_pending" && saved.acknowledgeWarnings === true, "注意を確認したうえで保存する");
  check(calls.some(([k]) => k === "detail-get") && calls.some(([k]) => k === "list-get"), "右ドロワーと応募者一覧を読み直す");
  check((await page.locator(".hr-next").innerText()).includes("社長判断をしてください"), "NEXT ACTION もすぐ変わる");
  check(await page.locator(".hr-next button", { hasText: "採用判断" }).count() === 1, "CTA：採用判断");
  check((await page.locator("#rows").innerText()).includes("社長判断待ち"), "応募者一覧の状態もすぐ変わる");
  await page.locator('.hr-tabs button[data-tab="history"]').click();
  await page.waitForTimeout(300);
  const hist = await page.locator("#hr-detail-tab").innerText();
  check(hist.includes("状態を手動変更") && hist.includes("面談予定 → 社長判断待ち"), "履歴に「状態を手動変更 面談予定 → 社長判断待ち」");
  check(!calls.some(([k]) => k === "interview"), "面談（日時・取消・Meet URL）は操作しない");
  check(!errs.length, `画面のエラーなし${errs.length ? `：${errs[0].slice(0, 120)}` : ""}`);
  await ctx.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
