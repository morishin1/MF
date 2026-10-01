// 勤務表の確認・確定の規則（lib/office-timesheet.js）。
//
// ■ 何を守るテストか
//
//   1. 日ごとの評価：実働の計算、要確認の印、人の確認が要るか（値を直した日は確認済み）
//   2. 月の評価：合計・不明な日・要確認の数・勤務表の合計との照合
//   3. 確定の条件：不明な日が0／要確認の日は確認済み／全日の行がある／下書きの状態。
//      勤務表の合計が合わないときだけ「承知」で進める
//   4. 人の入力の検査：読めない入力は errors（黙って直さない）。休みにしたら時刻を空にする
//   5. まとめて直す操作は、人が押したものだけ。提出状態・同じファイルの見つけ方
//   期待値は、規則から手で計算した数字（10/1 は木曜。8時間 = 480分）
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const S = await import(join(ROOT, "lib/office-timesheet.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const H = (h, m = 0) => h * 60 + m;
const M = "2026-10";
const D = (n) => `${M}-${String(n).padStart(2, "0")}`;

// 全日が「休み・印なし」の月を作り、指定の日だけ上書きする
const sheet = (over = {}) => S.blankDays(M).map((d) => ({ ...d, kind: "off", source: "ai", ...(over[Number(d.workDate.slice(8))] || {}) }));
const work = (o = {}) => ({ kind: "work", startMin: H(9), endMin: H(18), breakMin: 60, ...o });
const ev = (days, o = {}) => S.evaluateSheet(days, { month: M, ...o });
const codes = (d) => d.flags.map((f) => f.code);
const dayOf = (e, n) => e.days.find((d) => d.workDate === D(n));

console.log("— 日ごとの評価 —");

await ok("9:00〜18:00・休憩1:00 → 実働 480、印なし、確認は不要", async () => {
  const d = S.evaluateDay(sheet({ 1: work() })[0]);
  assert.equal(d.worked, 480);
  assert.equal(d.gross, 540);
  assert.deepEqual(d.flags, []);
  assert.equal(d.blocking, false);
  assert.equal(d.needsReview, false);
});
await ok("勤務か休みか未確認（kind なし）→ blocking の kind_missing。時刻があっても実働は出さない", async () => {
  const d = S.evaluateDay({ ...sheet()[0], kind: null, startMin: H(9), endMin: H(18), breakMin: 60 });
  assert.equal(d.worked, null);
  assert.deepEqual(codes(d), ["kind_missing"]);
  assert.equal(d.blocking, true);
  assert.equal(d.needsReview, false, "実働を出せない日は、確認待ちではなく、値を入れる日");
});
await ok("休憩が不明 → blocking（休憩は補完しない）。休憩 0 は実働 = 拘束", async () => {
  const a = S.evaluateDay({ ...work({ breakMin: null }), workDate: D(1) });
  assert.equal(a.worked, null);
  assert.ok(codes(a).includes("break_unknown"));
  assert.equal(a.blocking, true);
  assert.equal(S.evaluateDay({ ...work({ breakMin: 0 }), workDate: D(1) }).worked, 540);
});
await ok("勤務表の実働と計算が違う → 非 blocking の worked_mismatch（両方の値を文に入れる）。確認待ちになる", async () => {
  const d = S.evaluateDay({ ...work({ sheetWorkedMin: 450 }), workDate: D(1) });
  assert.equal(d.worked, 480);
  const f = d.flags.find((x) => x.code === "worked_mismatch");
  assert.equal(f.blocking, false);
  assert.match(f.text, /07:30/);
  assert.match(f.text, /08:00/);
  assert.equal(d.needsReview, true);
});
await ok("勤務表の実働と一致すれば印なし", async () => {
  const d = S.evaluateDay({ ...work({ sheetWorkedMin: 480 }), workDate: D(1) });
  assert.deepEqual(d.flags, []);
});
await ok("AI読取の印は origin: ai で残り、人が確認済みにするまで確認待ち。確認済みなら待たない", async () => {
  const flagged = { ...work(), workDate: D(1), aiFlags: [{ code: "low_confidence", text: "AI：かすれ" }] };
  const a = S.evaluateDay(flagged);
  assert.deepEqual(a.flags.map((f) => [f.code, f.origin, f.blocking]), [["low_confidence", "ai", false]]);
  assert.equal(a.needsReview, true);
  assert.equal(S.evaluateDay({ ...flagged, reviewedAt: "2026-10-05T00:00:00Z" }).needsReview, false);
});
await ok("日跨ぎの推定（22:00〜06:00）は非 blocking の印で、確認待ち", async () => {
  const d = S.evaluateDay({ ...work({ startMin: H(22), endMin: H(6), breakMin: 60 }), workDate: D(1) });
  assert.equal(d.worked, 420);
  assert.ok(codes(d).includes("overnight_assumed"));
  assert.equal(d.needsReview, true);
});

console.log("— 月の評価 —");

await ok("3日勤務：合計 1440分（24h）・稼働日数 3・不明 0・要確認 0", async () => {
  const e = ev(sheet({ 1: work(), 2: work(), 5: work() }));
  assert.equal(e.summary.totalMinutes, 1440);
  assert.equal(e.summary.rawMinutes, 1440);
  assert.equal(e.summary.workDays, 3);
  assert.equal(e.summary.unresolvedCount, 0);
  assert.equal(e.summary.reviewCount, 0);
  assert.equal(e.days.length, 31);
  assert.deepEqual(e.missingDates, []);
});
await ok("休憩が不明な日は、合計に入れず unresolved（補完しない）", async () => {
  const e = ev(sheet({ 1: work(), 2: work({ breakMin: null }) }));
  assert.equal(e.summary.totalMinutes, 480);
  assert.deepEqual(e.summary.unresolved, [D(2)]);
  assert.equal(e.summary.unresolvedCount, 1);
});
await ok("勤務か休みか未確認の日は、時刻があっても合計に入れない（unresolved）", async () => {
  const e = ev(sheet({ 1: work(), 3: { ...work(), kind: null } }));
  assert.equal(e.summary.totalMinutes, 480);
  assert.deepEqual(e.summary.unresolved, [D(3)]);
});
await ok("白紙の月（blankDays）は全日 unresolved", async () => {
  const e = ev(S.blankDays(M));
  assert.equal(e.summary.unresolvedCount, 31);
  assert.equal(e.summary.totalMinutes, 0);
});
await ok("月末日の勤務が翌日にかかる：月内 60分・翌月 360分。month_split の印で確認待ち", async () => {
  const e = ev(sheet({ 31: work({ startMin: H(22), endMin: H(30), breakMin: 60 }) }));
  assert.equal(e.summary.totalMinutes, 60);
  assert.equal(e.summary.spillMinutes, 360);
  assert.ok(codes(dayOf(e, 31)).includes("month_split"));
  assert.equal(dayOf(e, 31).needsReview, true);
  assert.equal(dayOf(e, 31).worked, 420, "その日の実働は元のまま（分割は合計にだけ効く）");
  assert.equal(dayOf(e, 31).counted, 60);
});
await ok("前月から入ってくるぶん（carry-in）を足す", async () => {
  const e = ev(sheet({ 1: work() }), { carryInMinutes: 300 });
  assert.equal(e.summary.totalMinutes, 780);
  assert.equal(e.summary.carryInMinutes, 300);
});
await ok("対象月ではない日付の行は合計に入れず、blocking の out_of_month", async () => {
  const days = [...sheet({ 1: work() }), { ...work(), workDate: "2026-09-30", source: "manual", aiFlags: [] }];
  const e = ev(days);
  assert.equal(e.summary.totalMinutes, 480);
  assert.deepEqual(e.outOfMonth, ["2026-09-30"]);
  assert.ok(e.summary.unresolved.includes("2026-09-30"));
  assert.equal(S.canConfirm("draft", e).ok, false);
});
await ok("行が足りない日は missingDates（合計は出るが、確定できない）", async () => {
  const days = sheet({ 1: work() }).filter((d) => d.workDate !== D(10) && d.workDate !== D(11));
  const e = ev(days);
  assert.deepEqual(e.missingDates, [D(10), D(11)]);
  const c = S.canConfirm("draft", e);
  assert.equal(c.ok, false);
  assert.match(c.blockers.join(), /2日ぶんの行がありません/);
});
await ok("丸め（30分・切捨て）：530分が2日 → 日ごと 1020／月合計 1050", async () => {
  const days = sheet({ 1: work({ endMin: H(18, 50) }), 2: work({ endMin: H(18, 50) }) });
  assert.equal(ev(days, { rounding: { unit: 30, mode: "floor", scope: "day" } }).summary.totalMinutes, 1020);
  assert.equal(ev(days, { rounding: { unit: 30, mode: "floor", scope: "month" } }).summary.totalMinutes, 1050);
  assert.equal(ev(days, { rounding: { unit: 30, mode: "floor", scope: "month" } }).summary.rawMinutes, 1060);
  assert.equal(ev(days).summary.totalMinutes, 1060, "丸めの条件が無ければ丸めない");
});

console.log("— 勤務表の合計との照合 —");

await ok("合計が一致（1440）→ match。書かれていなければ none。不明な日があれば incomplete（比べない）", async () => {
  const days = sheet({ 1: work(), 2: work(), 5: work() });
  assert.deepEqual(ev(days, { sheetTotalMin: 1440 }).summary.totalCheck, { status: "match", sheetMinutes: 1440, calcMinutes: 1440 });
  assert.deepEqual(ev(days).summary.totalCheck, { status: "none" });
  const bad = sheet({ 1: work(), 2: work({ breakMin: null }) });
  assert.equal(ev(bad, { sheetTotalMin: 960 }).summary.totalCheck.status, "incomplete");
});
await ok("合計が違う → mismatch と差（計算 − 勤務表）。承知（ack）が要るが、blocker にはしない", async () => {
  const days = sheet({ 1: work(), 2: work(), 5: work() });
  const e = ev(days, { sheetTotalMin: 1500 });
  assert.deepEqual(e.summary.totalCheck, { status: "mismatch", sheetMinutes: 1500, calcMinutes: 1440, diffMinutes: -60 });
  const c = S.canConfirm("draft", e);
  assert.equal(c.ok, true);
  assert.deepEqual(c.acks, ["total_mismatch"]);
  assert.match(S.ACK_LABEL.total_mismatch, /合計/);
});

console.log("— 確定の条件 —");

await ok("条件を満たした下書きは確定できる（blockers なし・ack なし）", async () => {
  const c = S.canConfirm("draft", ev(sheet({ 1: work() })));
  assert.deepEqual(c, { ok: true, blockers: [], acks: [] });
});
await ok("不明な日があれば確定できない（日数を文に入れる）", async () => {
  const c = S.canConfirm("draft", ev(sheet({ 1: work({ breakMin: null }), 2: work({ startMin: null }) })));
  assert.equal(c.ok, false);
  assert.match(c.blockers.join(), /実働を出せない日が 2 日/);
});
await ok("要確認の日が未確認なら確定できない。値を直すか、確認済みにすると確定できる", async () => {
  const flagged = sheet({ 1: { ...work(), aiFlags: [{ code: "low_confidence", text: "x" }] } });
  const c1 = S.canConfirm("draft", ev(flagged));
  assert.equal(c1.ok, false);
  assert.match(c1.blockers.join(), /要確認の日が 1 日/);
  const reviewed = flagged.map((d) => (d.workDate === D(1) ? { ...d, reviewedAt: "2026-10-02T00:00:00Z" } : d));
  assert.equal(S.canConfirm("draft", ev(reviewed)).ok, true);
});
await ok("下書きでなければ確定できない（確定済み・差し戻し中）", async () => {
  const e = ev(sheet({ 1: work() }));
  assert.match(S.canConfirm("confirmed", e).blockers.join(), /すでに確定/);
  assert.match(S.canConfirm("returned", e).blockers.join(), /差し戻し/);
  assert.equal(S.canConfirm("confirmed", e).ok, false);
});
await ok("理由は重ねて返す（不明な日・要確認・行不足の全部）", async () => {
  const days = sheet({ 1: work({ breakMin: null }), 2: { ...work(), aiFlags: [{ code: "low_confidence", text: "x" }] } }).slice(0, 20);
  const c = S.canConfirm("draft", ev(days));
  assert.equal(c.blockers.length, 3);
});

console.log("— 人の入力の検査（parseDayInput） —");

await ok("正しい入力：時刻は分に。翌日は 26:00。休憩は '1:00'・'60分'・数値（分）", async () => {
  const r = S.parseDayInput({ kind: "work", start: "9:00", end: "26:00", break: "1:00", note: " 客先常駐 " });
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, { kind: "work", start_min: 540, end_min: 1560, break_min: 60, note: "客先常駐" });
  assert.equal(S.parseDayInput({ break: "60分" }).patch.break_min, 60);
  assert.equal(S.parseDayInput({ break: 45 }).patch.break_min, 45);
  assert.equal(S.parseDayInput({ break: "なし" }).patch.break_min, 0);
});
await ok("入っていない項目は触らない。空文字・null は「空にする」", async () => {
  assert.deepEqual(S.parseDayInput({}).patch, {});
  assert.deepEqual(S.parseDayInput({ start: "", end: null, break: "", note: "", kind: "" }).patch,
    { start_min: null, end_min: null, break_min: null, note: null, kind: null });
});
await ok("読めない入力は errors（直して通さない）：開始 24:00・終了 48:00・9:5・休憩 '1'・数値の時刻・不明な kind・長い備考", async () => {
  for (const b of [{ start: "24:00" }, { end: "48:00" }, { start: "9:5" }, { break: "1" }, { break: "abc" }, { start: 540 }, { end: 1080 },
    { kind: "holiday" }, { note: "あ".repeat(201) }, { break: 2000 }]) {
    const r = S.parseDayInput(b);
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.ok(r.errors.length >= 1);
  }
});
await ok("休みにしたら、時刻・休憩は空にする（休みの日に時刻を残さない）", async () => {
  const r = S.parseDayInput({ kind: "off", start: "9:00", end: "18:00", break: "1:00" });
  assert.deepEqual(r.patch, { kind: "off", start_min: null, end_min: null, break_min: null });
});
await ok("実働（sheetWorkedMin）は人が書き換える項目ではない（入力に含めても取り込まない）", async () => {
  const r = S.parseDayInput({ sheetWorkedMin: 1, sheet_worked_min: 1, worked: 1, reviewed_at: "x", status: "confirmed" });
  assert.deepEqual(r.patch, {});
});

console.log("— 編集を当てる（applyPatch） —");

await ok("値が変わった項目だけを数え、直した日は確認済み（reviewedAt）と edited にする", async () => {
  const before = { ...work({ breakMin: null }), workDate: D(1), aiFlags: [], reviewedAt: null, edited: false };
  const r = S.applyPatch(before, { break_min: 60, start_min: H(9) }, "2026-10-05T01:00:00Z");
  assert.deepEqual(r.changed, ["break_min"]);
  assert.equal(r.row.breakMin, 60);
  assert.equal(r.row.edited, true);
  assert.equal(r.row.reviewedAt, "2026-10-05T01:00:00Z");
  assert.equal(r.reviewed, true);
});
await ok("同じ値を入れ直しても、変更・確認済みにはしない", async () => {
  const before = { ...work(), workDate: D(1), aiFlags: [], reviewedAt: null, edited: false };
  const r = S.applyPatch(before, { start_min: H(9), end_min: H(18), break_min: 60 }, "2026-10-05T01:00:00Z");
  assert.deepEqual(r.changed, []);
  assert.equal(r.row.reviewedAt, null);
  assert.equal(r.row.edited, false);
});
await ok("直して確認済みになった日は、確定の条件を満たす（実働は再計算される）", async () => {
  const flagged = sheet({ 1: { ...work({ breakMin: null }), aiFlags: [{ code: "low_confidence", text: "x" }] } });
  assert.equal(S.canConfirm("draft", ev(flagged)).ok, false);
  const fixed = flagged.map((d) => (d.workDate === D(1) ? S.applyPatch(d, { break_min: 60 }, "2026-10-05T00:00:00Z").row : d));
  const e = ev(fixed);
  assert.equal(S.canConfirm("draft", e).ok, true);
  assert.equal(e.summary.totalMinutes, 480);
});

console.log("— まとめて直す操作（人が押したときだけ） —");

await ok("mark_off_unread：読み取れていない日（kind も時刻も空）だけを休みにする。値のある日は触らない", async () => {
  const days = sheet({ 1: work(), 2: { kind: null }, 3: { kind: null, startMin: H(9) }, 4: { kind: null, breakMin: 60 } });
  const r = S.bulkPatches("mark_off_unread", { month: M }, ev(days).days);
  assert.deepEqual(r.targets.map((t) => t.workDate), [D(2)]);
  assert.deepEqual(r.targets[0].patch, { kind: "off", start_min: null, end_min: null, break_min: null });
});
await ok("mark_off_dates：指定日を休みに。対象月にない日付・空の指定は断る", async () => {
  const days = ev(sheet()).days;
  const ok1 = S.bulkPatches("mark_off_dates", { month: M, dates: [D(3), D(4)] }, days);
  assert.deepEqual(ok1.targets.map((t) => t.workDate), [D(3), D(4)]);
  assert.equal(S.bulkPatches("mark_off_dates", { month: M, dates: ["2026-09-30"] }, days).ok, false);
  assert.equal(S.bulkPatches("mark_off_dates", { month: M, dates: [] }, days).ok, false);
  assert.equal(S.bulkPatches("mark_off_dates", { month: "2026-13", dates: [D(3)] }, days).ok, false);
});
await ok("fill_break：勤務で休憩が空、かつ開始・終了がある日にだけ入れる。時刻が空の日・休憩のある日は触らない", async () => {
  const days = sheet({ 1: work({ breakMin: null }), 2: work({ breakMin: 30 }), 3: work({ breakMin: null, startMin: null }), 4: { kind: "off" } });
  const r = S.bulkPatches("fill_break", { month: M, minutes: 60 }, ev(days).days);
  assert.deepEqual(r.targets.map((t) => t.workDate), [D(1)]);
  assert.deepEqual(r.targets[0].patch, { break_min: 60 });
  assert.equal(S.bulkPatches("fill_break", { month: M, minutes: "1" }, ev(days).days).ok, false, "単位のない 1 は読まない");
  assert.equal(S.bulkPatches("fill_break", { month: M, minutes: -5 }, ev(days).days).ok, false);
  assert.equal(S.bulkPatches("fill_break", { month: M, minutes: "60分" }, ev(days).days).targets.length, 1);
});
await ok("review_flagged：要確認の日だけを確認済みにする。実働を出せない日（blocking）は確認済みにしない", async () => {
  const days = sheet({ 1: { ...work(), aiFlags: [{ code: "low_confidence", text: "x" }] }, 2: work({ breakMin: null }), 3: work() });
  const r = S.bulkPatches("review_flagged", { month: M }, ev(days).days);
  assert.deepEqual(r.targets, [{ workDate: D(1), review: true }]);
});
await ok("知らない操作は断る", async () => {
  assert.equal(S.bulkPatches("delete_all", { month: M }, []).ok, false);
});

console.log("— 提出状態・同じファイル —");

await ok("sheetState：ファイルなし → none／あり → submitted／下書き → draft／差し戻し → returned／確定 → confirmed", async () => {
  assert.equal(S.sheetState({}), "none");
  assert.equal(S.sheetState({ submissions: [{ id: "s1" }] }), "submitted");
  assert.equal(S.sheetState({ submissions: [{ id: "s1" }], timesheet: { status: "draft" } }), "draft");
  assert.equal(S.sheetState({ timesheet: { status: "draft" } }), "draft", "手入力（ファイルなし）でも下書きは下書き");
  assert.equal(S.sheetState({ submissions: [{ id: "s1" }], timesheet: { status: "returned" } }), "returned");
  assert.equal(S.sheetState({ submissions: [], timesheet: { status: "confirmed" } }), "confirmed");
  for (const k of ["none", "submitted", "draft", "returned", "confirmed"]) assert.ok(S.SHEET_STATE[k].label, k);
});

const sub = (id, o = {}) => ({ id, employee_id: "e1", target_month: M, site_contract_id: "c1", sha256: "a".repeat(64), submitted_at: `2026-10-0${id.slice(1)}T00:00:00Z`, ...o });

await ok("同じ人・月・契約に同じ中身が2つ → 最初は original、2つめ以降は duplicate", async () => {
  const m = S.classifyFiles([sub("s1"), sub("s2"), sub("s3")]);
  assert.equal(m.get("s1").state, "original");
  assert.equal(m.get("s2").state, "duplicate");
  assert.equal(m.get("s3").state, "duplicate");
  assert.deepEqual(m.get("s1").sameKey.sort(), ["s2", "s3"]);
});
await ok("同じ中身が別の人・別の月・別の契約にもある → 両方 cross（流用の疑い）。相手の所在を返す", async () => {
  for (const other of [{ employee_id: "e2" }, { target_month: "2026-09" }, { site_contract_id: "c2" }]) {
    const m = S.classifyFiles([sub("s1"), sub("s2", other)]);
    assert.equal(m.get("s1").state, "cross", JSON.stringify(other));
    assert.equal(m.get("s2").state, "cross");
    assert.equal(m.get("s1").cross[0].id, "s2");
  }
  const m = S.classifyFiles([sub("s1"), sub("s2", { employee_id: "e2" })]);
  assert.deepEqual(m.get("s1").cross[0], { id: "s2", employeeId: "e2", targetMonth: M, siteContractId: "c1" });
});
await ok("中身が違えば unique。sha256 が空の行は unchecked（重複の判定をしない）", async () => {
  const m = S.classifyFiles([sub("s1"), sub("s2", { sha256: "b".repeat(64) }), sub("s3", { sha256: null })]);
  assert.equal(m.get("s1").state, "unique");
  assert.equal(m.get("s2").state, "unique");
  assert.equal(m.get("s3").state, "unchecked");
  assert.equal(S.classifyFiles([sub("s1", { sha256: null }), sub("s2", { sha256: null })]).get("s1").state, "unchecked", "空どうしは同じとみなさない");
});
await ok("提出時刻が同じでも、id の順で原本が決まる（毎回同じ結果）", async () => {
  const t = "2026-10-01T00:00:00Z";
  const a = S.classifyFiles([sub("s1", { submitted_at: t }), sub("s2", { submitted_at: t })]);
  const b = S.classifyFiles([sub("s2", { submitted_at: t }), sub("s1", { submitted_at: t })]);
  assert.equal(a.get("s1").state, "original");
  assert.equal(b.get("s1").state, "original");
  assert.equal(b.get("s2").state, "duplicate");
});
await ok("latestSubmission：いちばん新しい1件。無ければ null", async () => {
  assert.equal(S.latestSubmission([sub("s1"), sub("s3"), sub("s2")]).id, "s3");
  assert.equal(S.latestSubmission([]), null);
  assert.equal(S.latestSubmission(null), null);
});
await ok("nameMatches：空白・全角空白を無視し、どちらかが含まれれば合う。氏名が無ければ null（判定しない）", async () => {
  assert.equal(S.nameMatches("山田 太郎", "山田太郎"), true);
  assert.equal(S.nameMatches("山田　太郎", "山田 太郎"), true);
  assert.equal(S.nameMatches("山田太郎 殿", "山田太郎"), true);
  assert.equal(S.nameMatches("鈴木花子", "山田太郎"), false);
  assert.equal(S.nameMatches(null, "山田太郎"), null);
  assert.equal(S.nameMatches("山田太郎", ""), null);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
