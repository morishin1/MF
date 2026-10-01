// 勤務表の確認・確定の規則（/office の稼働時間確定）。純関数だけ。DB にも API にも触らない。
//
// ■ 何を決めているか
//   ・日ごとの評価：実働の計算、要確認の印（計算から出るもの＋AI読取のときのもの）、人の確認が要るか
//   ・月の評価：合計、確定できない理由（blockers）、人が承知して進める注意（acks）、勤務表の合計との照合
//   ・人が編集した値の検査（parseDayInput）と、まとめて直す操作（bulkPatches）
//   ・提出状態（未提出／提出済み／確認待ち／差し戻し／確定）と、同じファイルの見つけ方
//
// ■ 確定できる条件（AI の結果は、これを満たしても自動では確定しない。確定は人の操作）
//   1. 状態が draft
//   2. 実働を出せない日（休憩が不明・開始または終了が空・勤務か休みか未確認…）が 0 日
//   3. 要確認の印が付いた日は、人が確認済みにしている（値を直した日は、確認したものとして扱う）
//   4. 対象月のすべての日の行がある
//   勤務表の合計と計算が合わないときは、承知した（ack）うえでだけ確定できる
//
// ■ 印（flag）の種類
//   blocking=true  … 実働を出せない。人が値を入れるまで合計に入れず、確定できない
//   blocking=false … 実働は出せるが、人の目で見てほしい
//   origin: 'calc'（いまの値から計算で出る。直せば消える）／ 'ai'（AI読取のときの指摘。人が確認済みにするまで残る）

import { daysInMonth } from "./holidays.js";
import { parseClock, parseBreak, dayWork, aggregateMonth, formatClock } from "./office-time.js";

const pad = (n) => String(n).padStart(2, "0");
const isMonth = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ""));

export const DAY_KINDS = ["work", "off"];
export const NOTE_MAX = 200;

/** 月のすべての日付（YYYY-MM-DD） */
export function datesOfMonth(month) {
  return Array.from({ length: daysInMonth(month) }, (_, i) => `${month}-${pad(i + 1)}`);
}

/** DB の日別の行（snake_case）→ 評価用（camelCase） */
export function normalizeDayRow(r) {
  return {
    workDate: r.work_date,
    kind: r.kind ?? null,
    startMin: r.start_min ?? null,
    endMin: r.end_min ?? null,
    breakMin: r.break_min ?? null,
    sheetWorkedMin: r.sheet_worked_min ?? null,
    note: r.note ?? null,
    source: r.source ?? "manual",
    confidence: r.ai_confidence ?? null,
    aiFlags: Array.isArray(r.ai_flags) ? r.ai_flags : [],
    edited: r.edited === true,
    reviewedAt: r.reviewed_at ?? null,
  };
}

/** 1日の評価 */
export function evaluateDay(d) {
  const flags = [];
  let worked = null;
  let gross = null;
  if (d.kind !== "work" && d.kind !== "off") {
    flags.push({ code: "kind_missing", text: "勤務か休みかが未確認です", blocking: true, origin: "calc" });
  } else {
    const w = dayWork({ kind: d.kind, start: d.startMin, end: d.endMin, breakMin: d.breakMin });
    worked = w.worked;
    gross = w.gross;
    for (const f of w.flags) flags.push({ ...f, origin: "calc" });
    if (worked !== null && d.sheetWorkedMin !== null && d.sheetWorkedMin !== undefined && d.sheetWorkedMin !== worked) {
      flags.push({
        code: "worked_mismatch",
        text: `勤務表の実働 ${formatClock(d.sheetWorkedMin)} と、開始・終了・休憩からの計算 ${formatClock(worked)} が違います`,
        blocking: false, origin: "calc",
      });
    }
  }
  for (const f of d.aiFlags || []) flags.push({ code: f.code, text: f.text, blocking: false, origin: "ai" });
  const blocking = flags.some((f) => f.blocking);
  // 実働を出せない日は、まず値を入れてもらう。実働が出せる日で、印が残っていて未確認なら「確認待ち」
  const needsReview = !blocking && !d.reviewedAt && flags.length > 0;
  return { ...d, worked, gross, flags, blocking, needsReview };
}

/**
 * 月の評価。
 * @param {object[]} days normalizeDayRow の形
 * @param {{ month: string, rounding?: object|null, carryInMinutes?: number, sheetTotalMin?: number|null }} o
 *   rounding … { unit, mode, scope }（契約条件から。無ければ丸めない）
 */
export function evaluateSheet(days, { month, rounding = null, carryInMinutes = 0, sheetTotalMin = null } = {}) {
  const have = new Map((days || []).map((d) => [d.workDate, d]));
  const missingDates = datesOfMonth(month).filter((x) => !have.has(x));
  const evaluated = [...have.values()]
    .sort((a, b) => (a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0))
    .map(evaluateDay);

  // 計算に渡す：勤務か休みかが未確認の日は、時刻があっても「実働を出せない日」として扱う
  const agg = aggregateMonth(
    evaluated.map((d) => (d.kind === "work" || d.kind === "off"
      ? d
      : { ...d, kind: "work", startMin: null, endMin: null })),
    { month, unit: rounding?.unit ?? null, mode: rounding?.mode ?? "floor", scope: rounding?.scope ?? "day", carryInMinutes },
  );
  const outOfMonth = evaluated.filter((d) => String(d.workDate).slice(0, 7) !== month).map((d) => d.workDate);
  const perDay = new Map(agg.perDay.map((p) => [p.workDate, p]));
  for (const d of evaluated) {
    const p = perDay.get(d.workDate);
    d.counted = p?.counted ?? null;
    // aggregateMonth だけが出す印（月跨ぎの分割・対象月外）を足す
    for (const f of p?.flags || []) {
      if ((f.code === "month_split" || f.code === "out_of_month") && !d.flags.some((x) => x.code === f.code)) {
        d.flags.push({ ...f, origin: "calc" });
        if (f.blocking) { d.blocking = true; d.needsReview = false; }
        else if (!d.blocking && !d.reviewedAt) d.needsReview = true;
      }
    }
  }

  const unresolved = agg.unresolved;
  const reviewCount = evaluated.filter((d) => d.needsReview).length;
  const calcWorked = evaluated.reduce((s, d) => s + (d.worked ?? 0), 0);
  let totalCheck = { status: "none" };
  if (sheetTotalMin !== null && sheetTotalMin !== undefined) {
    if (unresolved.length || missingDates.length) totalCheck = { status: "incomplete", sheetMinutes: sheetTotalMin };
    else if (calcWorked === sheetTotalMin) totalCheck = { status: "match", sheetMinutes: sheetTotalMin, calcMinutes: calcWorked };
    else totalCheck = { status: "mismatch", sheetMinutes: sheetTotalMin, calcMinutes: calcWorked, diffMinutes: calcWorked - sheetTotalMin };
  }

  return {
    days: evaluated,
    missingDates,
    outOfMonth,
    summary: {
      workDays: agg.workDays,
      rawMinutes: agg.rawMinutes,
      totalMinutes: agg.totalMinutes,
      spillMinutes: agg.spillMinutes,
      carryInMinutes: agg.carryInMinutes,
      rounding: agg.rounding,
      unresolved,
      unresolvedCount: unresolved.length,
      reviewCount,
      totalCheck,
    },
  };
}

/**
 * 確定できるか。
 * @returns {{ ok: boolean, blockers: string[], acks: string[] }}
 *   blockers … 確定できない理由（人が直す）
 *   acks     … 承知していれば確定できる注意のコード（total_mismatch）
 */
export function canConfirm(status, evaluated) {
  const blockers = [];
  const acks = [];
  if (status !== "draft") blockers.push(status === "confirmed" ? "すでに確定しています" : "下書きの状態ではありません（差し戻し中です）");
  const s = evaluated.summary;
  if (evaluated.missingDates.length) blockers.push(`${evaluated.missingDates.length}日ぶんの行がありません`);
  if (s.unresolvedCount) blockers.push(`実働を出せない日が ${s.unresolvedCount} 日あります（休憩が不明・開始や終了が空・勤務か休みか未確認など）`);
  if (s.reviewCount) blockers.push(`要確認の日が ${s.reviewCount} 日、まだ確認済みになっていません`);
  if (s.totalCheck.status === "mismatch") acks.push("total_mismatch");
  return { ok: blockers.length === 0, blockers, acks };
}

export const ACK_LABEL = {
  total_mismatch: "勤務表の合計と、日ごとの計算の合計が違うことを承知しました",
};

/** 対象月の、値の入っていない行（人が手入力で始めるとき／AI が読み取らなかったとき） */
export function blankDays(month) {
  return datesOfMonth(month).map((workDate) => ({
    workDate, kind: null, startMin: null, endMin: null, breakMin: null, sheetWorkedMin: null,
    note: null, source: "manual", confidence: null, aiFlags: [], edited: false, reviewedAt: null,
  }));
}

/**
 * 人が編集した1日の入力を検査して、DB の列（snake_case）にする。
 * 入っていない項目は触らない。空文字・null は「空にする」。読めない入力は errors（黙って直さない）。
 *
 * @param {{ kind?, start?, end?, break?, note? }} b   start・end は "9:00"、break は "1:00"・"60分"・数値（分）
 * @returns {{ ok: boolean, errors: string[], patch: object }}
 */
export function parseDayInput(b = {}) {
  const errors = [];
  const patch = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const blank = (v) => v === null || v === undefined || String(v).trim() === "";

  if (has("kind")) {
    if (blank(b.kind)) patch.kind = null;
    else if (DAY_KINDS.includes(b.kind)) patch.kind = b.kind;
    else errors.push("勤務か休みかを選んでください");
  }
  if (has("start")) {
    if (blank(b.start)) patch.start_min = null;
    else {
      const p = parseClock(b.start, { allowOver24: false });
      if (p === null || typeof b.start === "number") errors.push(`開始「${String(b.start).slice(0, 12)}」を、時刻（例 9:00）で入れてください`);
      else patch.start_min = p;
    }
  }
  if (has("end")) {
    if (blank(b.end)) patch.end_min = null;
    else {
      const p = parseClock(b.end, { allowOver24: true });
      if (p === null || typeof b.end === "number") errors.push(`終了「${String(b.end).slice(0, 12)}」を、時刻（例 18:00。翌日は 26:00）で入れてください`);
      else patch.end_min = p;
    }
  }
  if (has("break")) {
    if (blank(b.break)) patch.break_min = null;
    else {
      const r = parseBreak(typeof b.break === "string" ? b.break : b.break);
      if (r.error) errors.push(r.error);
      else if (r.value !== null && r.value > 1440) errors.push("休憩は 24 時間以内にしてください");
      else patch.break_min = r.value;
    }
  }
  if (has("note")) {
    if (blank(b.note)) patch.note = null;
    else if (String(b.note).length > NOTE_MAX) errors.push(`備考は ${NOTE_MAX} 字までです`);
    else patch.note = String(b.note).trim();
  }
  // 休みにしたら、時刻・休憩は空にする（休みの日に時刻を残さない）
  if (patch.kind === "off") { patch.start_min = null; patch.end_min = null; patch.break_min = null; }
  return { ok: errors.length === 0, errors, patch };
}

/** 画面・API の項目名 → 評価用の項目名 */
const FIELD = { kind: "kind", start_min: "startMin", end_min: "endMin", break_min: "breakMin", note: "note" };

/**
 * 編集を当てる。値が変わった項目の数（edit_count に足す）と、当てたあとの行を返す。
 * 値を直した日は、確認したものとして reviewed にする（now を渡す）。
 * @returns {{ row: object, changed: string[], reviewed: boolean }}
 */
export function applyPatch(day, patch, now) {
  const row = { ...day };
  const changed = [];
  for (const [col, key] of Object.entries(FIELD)) {
    if (!(col in patch)) continue;
    if ((row[key] ?? null) !== (patch[col] ?? null)) { row[key] = patch[col] ?? null; changed.push(col); }
  }
  if (changed.length) { row.edited = true; row.reviewedAt = now; }
  return { row, changed, reviewed: changed.length > 0 };
}

/**
 * まとめて直す操作。人が押したときだけ使う（AI・サーバーが勝手には使わない）。
 * どれも、当てる日を返すだけ（DB へは API が書く）。
 *   mark_off_unread … 読み取れていない日（not_read）・行が空の日を「休み」にする
 *   mark_off_dates  … 指定した日を「休み」にする（土日祝を休みに、など）
 *   fill_break      … 勤務の日で、休憩が空の日に、指定の休憩（分）を入れる
 *   review_flagged  … 要確認の印が付いた日を、すべて確認済みにする
 * @returns {{ ok: boolean, error?: string, targets: { workDate: string, patch?: object, review?: boolean }[] }}
 */
export function bulkPatches(op, args, evaluatedDays) {
  if (!isMonth(args?.month)) return { ok: false, error: "対象月が正しくありません", targets: [] };
  const dates = new Set(datesOfMonth(args.month));
  const T = [];
  if (op === "mark_off_unread") {
    for (const d of evaluatedDays) {
      const unread = d.kind === null && d.startMin === null && d.endMin === null && d.breakMin === null;
      if (unread) T.push({ workDate: d.workDate, patch: { kind: "off", start_min: null, end_min: null, break_min: null } });
    }
    return { ok: true, targets: T };
  }
  if (op === "mark_off_dates") {
    const list = Array.isArray(args?.dates) ? args.dates : [];
    if (!list.length) return { ok: false, error: "対象の日を指定してください", targets: [] };
    for (const x of list) {
      if (!dates.has(x)) return { ok: false, error: `対象月にない日付です：${String(x).slice(0, 10)}`, targets: [] };
      T.push({ workDate: x, patch: { kind: "off", start_min: null, end_min: null, break_min: null } });
    }
    return { ok: true, targets: T };
  }
  if (op === "fill_break") {
    const r = typeof args?.minutes === "number" ? { value: args.minutes } : parseBreak(args?.minutes);
    if (r.error || r.value === null || !Number.isInteger(r.value) || r.value < 0 || r.value > 1440) {
      return { ok: false, error: r.error || "休憩（分）を指定してください", targets: [] };
    }
    for (const d of evaluatedDays) {
      if (d.kind === "work" && d.breakMin === null && d.startMin !== null && d.endMin !== null) {
        T.push({ workDate: d.workDate, patch: { break_min: r.value } });
      }
    }
    return { ok: true, targets: T };
  }
  if (op === "review_flagged") {
    for (const d of evaluatedDays) if (d.needsReview) T.push({ workDate: d.workDate, review: true });
    return { ok: true, targets: T };
  }
  return { ok: false, error: "知らない操作です", targets: [] };
}

// ---------------------------------------------------------------------------
// 提出状態・重複
// ---------------------------------------------------------------------------

export const SHEET_STATE = {
  none:      { label: "未提出",       tone: "bad" },
  submitted: { label: "提出済み・未読取", tone: "warn" },
  draft:     { label: "確認待ち",     tone: "warn" },
  returned:  { label: "差し戻し中",   tone: "bad" },
  confirmed: { label: "確定",         tone: "good" },
};

/**
 * 勤務表の提出状態。
 *   none      … 勤務表ファイルも、勤務表の行も無い
 *   submitted … ファイルはあるが、まだ読み取り・入力を始めていない
 *   draft     … 下書きがある（AI読取のあと・手入力中）。人の確認待ち
 *   returned  … 提出物に問題があり、再提出を依頼した
 *   confirmed … 確定
 * @param {{ submissions: object[], timesheet: object|null }} a
 */
export function sheetState({ submissions = [], timesheet = null } = {}) {
  if (timesheet?.status === "confirmed") return "confirmed";
  if (timesheet?.status === "returned") return "returned";
  if (timesheet?.status === "draft") return "draft";
  return submissions.length ? "submitted" : "none";
}

/**
 * 同じファイルの見つけ方。
 * 同じ中身（sha256）の行が、
 *   ・同じ人・月・契約に複数ある → 二重提出（二重に来た2つめ以降を duplicate に。最初の1件は原本）
 *   ・別の人・月・契約にもある   → 流用（別の月／人の勤務表を出し直した可能性。どちらにも印）
 * sha256 が空（未確認）の行は判定できない（unchecked）。
 *
 * @param {object[]} rows  gw_submissions の行（kind='timesheet'）。判定したい行と、同じ中身の他の行
 * @returns {Map<string, { state: 'unchecked'|'unique'|'original'|'duplicate'|'cross', sameKey: string[], cross: object[] }>}
 */
export function classifyFiles(rows) {
  const key = (r) => `${r.employee_id}|${r.target_month}|${r.site_contract_id}`;
  const order = (a, b) => (a.submitted_at < b.submitted_at ? -1 : a.submitted_at > b.submitted_at ? 1 : a.id < b.id ? -1 : 1);
  const byHash = new Map();
  for (const r of rows || []) {
    if (!r.sha256) continue;
    if (!byHash.has(r.sha256)) byHash.set(r.sha256, []);
    byHash.get(r.sha256).push(r);
  }
  const out = new Map();
  for (const r of rows || []) {
    if (!r.sha256) { out.set(r.id, { state: "unchecked", sameKey: [], cross: [] }); continue; }
    const group = byHash.get(r.sha256);
    const same = group.filter((x) => x.id !== r.id && key(x) === key(r));
    const cross = group.filter((x) => key(x) !== key(r));
    let state = "unique";
    if (cross.length) state = "cross";
    else if (same.length) {
      const first = [r, ...same].sort(order)[0];
      state = first.id === r.id ? "original" : "duplicate";
    }
    out.set(r.id, {
      state,
      sameKey: same.map((x) => x.id),
      cross: cross.map((x) => ({ id: x.id, employeeId: x.employee_id, targetMonth: x.target_month, siteContractId: x.site_contract_id })),
    });
  }
  return out;
}

export const FILE_STATE_LABEL = {
  unchecked: "未確認",
  unique: "",
  original: "同じファイルが再提出されています",
  duplicate: "同じファイルの再提出（2つめ以降）",
  cross: "同じファイルが、別の月・別の人の勤務表としても提出されています",
};

/** 対象の月・人・契約の、いちばん新しい勤務表ファイル */
export function latestSubmission(rows) {
  return [...(rows || [])].sort((a, b) => (a.submitted_at < b.submitted_at ? 1 : a.submitted_at > b.submitted_at ? -1 : a.id < b.id ? 1 : -1))[0] || null;
}

/** 勤務表の氏名と、登録の氏名が合うか（空白・全角空白を除いて、どちらかがもう一方を含めば合う）。氏名が無ければ null */
export function nameMatches(sheetName, registered) {
  const n = (s) => String(s ?? "").replace(/[\s　]+/g, "").toLowerCase();
  const a = n(sheetName);
  const b = n(registered);
  if (!a || !b) return null;
  return a === b || a.includes(b) || b.includes(a);
}

export { isMonth };
