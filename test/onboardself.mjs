// 入社前の人が、ログインすれば「契約条件・今やること・手続きの進み具合」が分かる状態にする（本人の入社準備）。
//
// 見ること
//   ・契約条件（lib/onboard-conditions.js）: 管理側の契約（active）をそのまま読む。未登録は null（画面は「会社で準備中です」）
//   ・本人向けのステップ（lib/onboard-self.js）: 契約条件→契約書→入社情報→必要書類→オリエンテーション→会社→完了。
//     本人の番と会社の番が分かる。判定は mapSix / stageFlags と同じ事実から（4つ目の判定を作らない）
//   ・必要書類: 提出済みか・まだ必要か・会社確認済みか。社内準備の項目・マイナンバーは出ない
//   ・契約の更新: 現在の契約と過去の契約を混ぜない。次回の更新確認日
//   ・本人画面のエラー文: DB名・migration番号・SQL・API名を出さない（KPLayout.friendlyError）
//   ・ログイン直後の行き先（KPLayout.homeFor）: 入社準備中の本人は /onboarding/。完了後・管理者は今までどおり
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mapSix } from "../lib/onboard-six.js";
import { stageFlags } from "../lib/onboard-stage.js";
import { selfSteps, documentRows } from "../lib/onboard-self.js";
import { conditionRows, knownOf, contractHistory } from "../lib/onboard-conditions.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const it = (owner, status = "todo", extra = {}) => ({ owner, status, required: true, ...extra });
const facts = (o = {}) => ({ procedure: { status: "in_progress" }, order: null, sign: null, consentsOk: false, profile: null,
  items: [it("employee", "todo", { item_key: "doc_id", title: "本人確認書類" }), it("hr", "todo", { item_key: "pc", title: "PC の準備（社内）" })], ...o });
const SIGNED = { order: { status: "signed" }, sign: { status: "signed" }, consentsOk: true };
const view = (f) => {
  const six = mapSix({ facts: f, audience: "self" });
  return selfSteps(six, f ? stageFlags(f) : null);
};
const st = (v, k) => v.steps.find((s) => s.key === k);

console.log("\n— 契約条件（あなたの契約条件）—");

const EMP = { id: "e1", display_name: "山田 太郎", email: "y@example.com", joined_on: "2026-10-01", department: "ITS事業部" };
const ACTIVE = { id: "c1", status: "active", contract_type: "契約社員", fixed_term: true, period_from: "2026-10-01", period_to: "2026-12-31",
  probation_months: 3, weekly_hours: 30, work_hours: "9:00〜17:00", job_content: "ITS事業部", wage_type: "月給", wage_amount: 250000, renewal_notice_days: 30 };

ok("契約が無い・未確定のあいだは、値が null（空白・エラーにしない）。画面は「会社で準備中です」", () => {
  const c = conditionRows(EMP, null, null);
  assert.equal(c.ready, false);
  const v = (k) => c.rows.find((r) => r.key === k).value;
  for (const k of ["contract", "period", "probation", "hours", "wage"]) assert.equal(v(k), null, k);
  assert.equal(v("joinedOn"), "2026/10/01", "名簿にある入社日は出る");
  assert.equal(c.rows.map((r) => r.label).join("／"), "入社日／雇用形態／契約期間／試用期間／勤務時間／勤務形態／担当／業務範囲／給与／相談先");
});

ok("有効な契約: 雇用形態・契約期間・試用期間・勤務時間・勤務形態・担当・給与・相談先がそのまま出る", () => {
  const c = conditionRows(EMP, ACTIVE, "上長 花子");
  const v = (k) => c.rows.find((r) => r.key === k).value;
  assert.equal(c.ready, true);
  assert.equal(v("contract"), "契約社員・有期契約");
  assert.equal(v("period"), "2026/10/01 ～ 2026/12/31");
  assert.equal(v("probation"), "3か月");
  assert.equal(conditionRows(EMP, { ...ACTIVE, probation_months: null }, null).rows.find((r) => r.key === "probation").value, "なし", "有効な契約で試用期間が無ければ「なし」");
  assert.equal(v("hours"), "週30時間");
  assert.equal(v("workStyle"), "9:00〜17:00");
  assert.equal(v("role"), "ITS事業部");
  assert.equal(v("wage"), "月給 250,000円");
  assert.equal(v("manager"), "上長 花子");
});

ok("期間の定めなしの契約は「期間の定めなし」。有期の文言にならない", () => {
  const c = conditionRows(EMP, { ...ACTIVE, fixed_term: false, period_to: null }, null);
  assert.equal(c.rows.find((r) => r.key === "contract").value, "契約社員・期間の定めなし");
  assert.equal(c.rows.find((r) => r.key === "period").value, "2026/10/01 ～（期間の定めなし）");
});

ok("管理側（/api/onboarding/me の known）と、同じ関数から出ている（別に持たない）", () => {
  const k = knownOf(EMP, ACTIVE, "上長 花子");
  assert.equal(k.wage, "月給 250,000円");
  assert.equal(k.contract, "有期（2026-10-01 〜 2026-12-31）");
  const meSrc = readFileSync(join(ROOT, "api/onboarding/me.js"), "utf8");
  assert.ok(meSrc.includes("knownOf(ctx.employee"), "me.js は knownOf を使う");
  const startSrc = readFileSync(join(ROOT, "api/onboarding/start.js"), "utf8");
  assert.ok(startSrc.includes("conditionRows("), "start.js は conditionRows を使う");
});

console.log("\n— 契約の更新（現在の契約・次回の更新確認・過去の契約）—");

ok("現在有効な契約と、更新済みの契約を混ぜない。次回の更新確認は満了の30日前", () => {
  const h = contractHistory([
    { id: "c0", status: "superseded", fixed_term: true, period_from: "2026-04-01", period_to: "2026-09-30", created_at: "2026-03-01" },
    { id: "c1", status: "active", fixed_term: true, period_from: "2026-10-01", period_to: "2026-12-31", renewal_notice_days: 30, created_at: "2026-09-01" },
    { id: "cd", status: "draft", fixed_term: true, period_from: "2027-01-01", period_to: "2027-03-31" },
  ]);
  assert.equal(h.current.id, "c1");
  assert.equal(h.current.statusLabel, "有効");
  assert.equal(h.current.period, "2026/10/01 ～ 2026/12/31");
  assert.equal(h.nextRenewalOn, "2026/12/01");
  assert.deepEqual(h.past.map((c) => [c.id, c.statusLabel]), [["c0", "更新済み"]]);
  assert.ok(!h.past.some((c) => c.status === "active"), "過去に有効な契約は入らない");
});

ok("契約が無い人: current は null・過去も空", () => {
  assert.deepEqual(contractHistory([]), { current: null, nextRenewalOn: null, past: [] });
  assert.equal(contractHistory([{ id: "x", status: "active", fixed_term: false, period_from: "2026-10-01" }]).nextRenewalOn, null, "期間の定めなしは更新確認が無い");
});

console.log("\n— 本人向けのステップ —");

const LABELS = ["契約条件を確認", "契約書を確認・署名", "入社情報を入力", "必要書類を提出", "オリエンテーションを確認", "会社の確認", "入社準備完了"];

ok("7つ。案内が無ければ数えない。並びは 契約条件→契約書→入社情報→必要書類→オリエンテーション→会社→完了", () => {
  const v = view(facts());
  assert.deepEqual(v.steps.map((s) => s.label), LABELS);
});

ok("契約の準備前: 会社が準備中。本人の操作は無い（現在＝会社確認中）。NEXT は会社待ち・ボタン無し", () => {
  const v = view(facts());
  assert.equal(st(v, "conditions").state, "current");
  assert.equal(st(v, "conditions").actorLabel, "会社");
  assert.equal(st(v, "contract").state, "todo");
  assert.equal(v.phase.label, "会社確認中");
  assert.equal(v.next.mine, false);
  assert.equal(v.next.cta, null);
});

ok("通知書を公開した（確認前）: 契約条件は確認できる状態（done）。契約書の確認が本人の番。Primary CTA は1つ（労働条件を確認する）", () => {
  const v = view(facts({ notice: { published: true, confirmed: false } }));
  assert.equal(st(v, "conditions").state, "done");
  assert.equal(st(v, "contract").state, "current");
  assert.equal(st(v, "contract").actor, "employee");
  assert.equal(v.phase.label, "本人手続き中");
  assert.equal(v.next.title, "労働条件通知書を確認してください");
  assert.equal(v.next.cta.label, "労働条件を確認する");
  assert.equal(v.next.cta.action, "notice");
  assert.equal(v.steps.filter((s) => s.cta).length, 1, "ボタンが付くのは、本人の番の1つだけ");
});

ok("電子署名の依頼が届いている: 契約書を確認して署名（契約書の画面へ）", () => {
  const v = view(facts({ order: { status: "sent" }, sign: { status: "sent" } }));
  assert.equal(v.next.title, "契約書を確認して、署名してください");
  assert.equal(v.next.cta.href, "/contracts.html");
});

ok("署名が済んだら入社情報の入力。入力はこれまでのフォーム（#step-3）へ", () => {
  const v = view(facts({ ...SIGNED }));
  assert.equal(st(v, "contract").state, "done");
  assert.equal(st(v, "info").state, "current");
  assert.equal(v.next.title, "入社情報を入力してください");
  assert.equal(v.next.cta.href, "/onboarding.html#step-3");
});

ok("入社情報が済み・書類が残っている: 必要書類が本人の番。件数が分かる", () => {
  const v = view(facts({ ...SIGNED, profile: { status: "submitted" } }));
  assert.equal(st(v, "info").state, "done");
  assert.equal(st(v, "docs").state, "current");
  assert.equal(st(v, "docs").note, "書類の提出が 1 件残っています");
  assert.equal(v.next.cta.href, "/onboarding.html#step-4");
});

ok("書類が済み・オリエンテーションが残っている: オリエンテーションが本人の番（書類と分かれる）", () => {
  const f = facts({ ...SIGNED, profile: { status: "submitted" }, orientationOk: false,
    items: [it("employee", "submitted", { item_key: "doc_id", title: "本人確認書類" }), it("hr")] });
  const v = view(f);
  assert.equal(st(v, "docs").state, "done");
  assert.equal(st(v, "orientation").state, "current");
  assert.equal(v.next.title, "オリエンテーションを確認してください");
  assert.equal(v.next.cta.href, "/onboarding.html#step-2");
});

ok("本人の分が全部済み・社内準備が残る: 会社の確認中（本人の操作は無い）。内訳は出さない", () => {
  const f = facts({ ...SIGNED, profile: { status: "submitted" }, items: [it("employee", "submitted", { item_key: "doc_id" }), it("hr")] });
  const v = view(f);
  assert.equal(st(v, "company").state, "current");
  assert.equal(st(v, "company").actorLabel, "会社");
  assert.equal(v.phase.label, "会社確認中");
  assert.equal(v.next.mine, false);
  assert.ok(!JSON.stringify(v).includes("PC の準備"), "社内準備の項目名は出ない");
});

ok("すべて済むと入社準備完了。ボタンは出ない", () => {
  const f = facts({ ...SIGNED, profile: { status: "submitted" }, orientationOk: true, procedure: { status: "done" },
    items: [it("employee", "done", { item_key: "doc_id" }), it("hr", "done")] });
  const v = view(f);
  assert.equal(st(v, "complete").state, "done");
  assert.equal(v.phase.label, "入社準備完了");
  assert.equal(v.next.done, true);
  assert.equal(v.done, v.total);
});

ok("事実が読めないとき: 「現在確認できません」。完了とは言わない。本人に技術的な語を出さない", () => {
  const v = view(null);
  assert.equal(st(v, "complete").state, "unlinked");
  assert.equal(v.next.title, "入社手続き情報を現在確認できません");
  assert.equal(v.next.sub, "管理担当者へお問い合わせください");
  assert.ok(!/db\/|SQL|migration|API|テーブル/i.test(JSON.stringify(v)));
});

ok("案内が発行されていれば、先頭に「入社案内を確認」が出る（本人の番）", () => {
  const six = mapSix({ facts: facts({ ...SIGNED }), audience: "self", guide: { status: "issued", version: 1, confirmedVersion: null } });
  const v = selfSteps(six, stageFlags(facts({ ...SIGNED })));
  assert.equal(v.steps[0].key, "guide");
  assert.equal(v.next.cta.action, "guide");
});

console.log("\n— 必要書類 —");

ok("提出済みか・まだ必要か・会社確認済みか。社内準備・マイナンバー・書類でない項目は出ない", () => {
  const rows = documentRows([
    { item_key: "doc_id", owner: "employee", title: "本人確認書類", required: true, status: "todo" },
    { item_key: "doc_employment", owner: "employee", title: "雇用関連書類", required: true, status: "submitted" },
    { item_key: "doc_other", owner: "employee", title: "その他", required: false, status: "done" },
    { item_key: "doc_pension", owner: "employee", title: "年金手帳", required: false, status: "na" },
    { item_key: "doc_mynumber", owner: "employee", title: "マイナンバー確認書類", required: true, status: "todo" },
    { item_key: "form_profile", owner: "employee", title: "入社情報フォーム", required: true, status: "todo" },
    { item_key: "pc", owner: "hr", title: "PC の準備（社内）", required: true, status: "todo" },
  ]);
  assert.deepEqual(rows.map((r) => [r.title, r.label]), [
    ["本人確認書類", "未提出"], ["雇用関連書類", "提出済み（会社が確認中）"], ["その他", "会社確認済み"], ["年金手帳", "提出は不要"],
  ]);
  assert.equal(rows[3].required, false);
});

console.log("\n— 本人画面のエラー文・ログイン直後の行き先（js/layout.js）—");

// layout.js は、画面の中で動く1つの塊（IIFE）。ここでは、中の純粋な関数だけを取り出して試す
const layout = readFileSync(join(ROOT, "js/layout.js"), "utf8");
const grab = (re) => { const m = layout.match(re); assert.ok(m, `${re} を読めません`); return m[0]; };
const fnSrc = [
  grab(/const FRIENDLY_LOAD = [^\n]+\n/),
  grab(/function friendlyError\(e, fallback\) \{[\s\S]*?\n  \}\n/),
  grab(/const isPreparing = [^\n]+\n/),
  grab(/function homeFor\(appRole, stage = null\) \{[\s\S]*?\n  \}\n/),
].join("\n");
const { friendlyError, homeFor } = Function(`${fnSrc}\nreturn { friendlyError, homeFor };`)();

ok("本人向けの言葉（hint）はそのまま出す", () => {
  assert.equal(friendlyError({ status: 409, code: "version_changed", hint: "入社案内が更新されました。もう一度、内容をご確認ください" }, "確認できませんでした"),
    "入社案内が更新されました。もう一度、内容をご確認ください");
});

ok("DB名・migration番号・SQL・API名・サーバの失敗（5xx・not_ready・db_*）は、本人に出さない", () => {
  const generic = "入社手続き情報を現在確認できません。管理担当者へお問い合わせください。";
  for (const e of [
    { status: 503, code: "not_ready", hint: "この機能に必要なテーブルがまだ作られていません。管理者に db/110_labor_notice.sql の実行を依頼してください" },
    { status: 500, code: "db_read_failed", message: "column gw_procedure_items.item_key does not exist" },
    { status: 200, hint: "データ未連携。入社手続きの表が読めません（db/070 が未適用の可能性があります）" },
    { status: 400, message: "relation \"gw_procedures\" does not exist" },
    { status: 502, message: "fetch /api/onboarding/me failed" },
  ]) {
    const m = friendlyError(e);
    assert.equal(m, generic, JSON.stringify(e));
    assert.ok(!/db\/|SQL|migration|テーブル|gw_|api\//i.test(m));
  }
  assert.equal(friendlyError({ status: 500, code: "db_update_failed" }, "保存できませんでした"), "保存できませんでした。管理担当者へお問い合わせください。");
});

ok("理由が分からない失敗は「もう一度お試しください」。e.detail は見ない", () => {
  assert.equal(friendlyError({ message: "Failed to fetch", detail: "SELECT * FROM gw_x" }, "保存できませんでした"), "保存できませんでした。もう一度お試しください。");
});

ok("ログイン直後: 入社準備中の本人は /onboarding/。入社準備が終わった本人・管理者・社労士は今までどおり", () => {
  const preparing = { key: "preparing", unlocked: false };
  assert.equal(homeFor("member", preparing), "/onboarding/");
  assert.equal(homeFor("member", { key: "preparing", unlocked: true }), "home.html", "手続きが終わったら通常のホーム");
  assert.equal(homeFor("member", { key: "member", unlocked: false }), "home.html");
  assert.equal(homeFor("member", null), "home.html");
  assert.equal(homeFor("admin", preparing), "home.html", "管理者は段階で動かさない");
  assert.equal(homeFor("owner", preparing), "home.html");
  assert.equal(homeFor("sr", preparing), "advisor.html");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
