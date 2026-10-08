// Office 定例業務マスター・Office 業務予定（db/125）。純粋な関数（表は読まない）。
//
// ■ 流れ
//   定例業務マスター（gw_office_recurring_tasks）→ 予定日を計算（occurrences）→ 予定（gw_office_calendar_events）を
//   今日から先 HORIZON_DAYS 日ぶん、無いものだけ作る（planGeneration。同じマスター・同じ日は一意の索引でも止める）
//   → Office ホームのカレンダー・今週の予定・今日やること → 完了／今回なし → 期限を過ぎて未完了なら「期限超過」
//
// ■ 繰り返し（recurrence_type と recurrence_rule）
//   none     … { date: "YYYY-MM-DD" }（1回だけ。無ければ開始日）
//   weekly   … { dows: [1..7] }（1=月〜7=日）
//   monthly  … { day: 1..31 }（その月に無い日＝31日など は月末）／{ type: "month_end" }／{ type: "month_end_biz", n: 0.. }（月末のn営業日前。0=最終営業日）
//   yearly   … { month: 1..12, day: 1..31 }／{ month, type: "month_end" }
//   shift    … どれにも付けられる。予定日が土日祝のとき "prev"＝前の営業日／"next"＝次の営業日／無し＝そのまま
//
// ■ 期限（due_rule）。予定日とは別に持てる
//   { type: "same" }（予定日＝期限）／{ type: "offset", days: n }（予定日のn日後）／
//   { type: "day", day: d }（予定日の月のd日。予定日より前なら翌月のd日）／{ type: "month_end" }（予定日の月末）
//
// ■ カテゴリと権限（Office の既存の権限。lib/gw.js と同じ判定）
//   人事・労務 … 人事・労務（officeHr）が見る・直す
//   経理・営業事務 … 経理・事務（officeFinance）。営業事務は月末月初（officeApp＝access.office）でも
//   全体・EC・NW・その他 … Office の業務のどれかがあれば見る。直すのは月末月初（経営者・責任者・経理）か管理者
//   完了・今回なし … 直せる人と、その予定の担当者本人
//
// ■ Excel 年間予定表の取り込み（classifyExcel）
//   セルをそのまま入れない。月をまたいで同じ文言が何回出るかで、定例（毎月）・毎年・単発に分け、
//   変換一覧を返す。登録するかは人が一覧で決める（単発は初めは「除外」）

import { HOLIDAYS } from "./holidays.js";

export const HORIZON_DAYS = 90;          // cron が先に作っておく日数
export const VIEW_HORIZON_DAYS = 400;    // カレンダーで先の月を開いたときに作ってよい範囲（今日から）

export const CATEGORIES = [
  { key: "all",         label: "全体",       col: "C" },
  { key: "sales_admin", label: "営業事務",   col: "M" },
  { key: "hr",          label: "人事",       col: "N" },
  { key: "labor",       label: "労務・総務", col: "O" },
  { key: "ecnw",        label: "EC・NW",     col: "P" },
  { key: "finance",     label: "経理",       col: "Q" },
  { key: "other",       label: "その他",     col: "G" },
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const categoryLabel = (k) => CATEGORIES.find((c) => c.key === k)?.label || "その他";
export const PRIORITIES = [{ key: "high", label: "高" }, { key: "normal", label: "中" }, { key: "low", label: "低" }];
export const STATUSES = [{ key: "pending", label: "未完了" }, { key: "done", label: "完了" }, { key: "skipped", label: "今回なし" }];
export const RECURRENCE_TYPES = ["none", "weekly", "monthly", "yearly"];
export const TITLE_MAX = 200;

// ---- 権限 -----------------------------------------------------------------------
/** ctx（lib/gw.js の gwContext）から、Office の権限だけを取り出す。判定は lib/gw.js の関数を渡して使う */
export function permsOf(ctx, gw) {
  return {
    hr: Boolean(gw.canOfficeHr(ctx)),
    fin: Boolean(gw.canOfficeFinance(ctx)),
    app: Boolean(gw.canAccessOffice(ctx)),
    admin: Boolean(ctx?.isAdmin),
  };
}
export const canUseRecurring = (p) => Boolean(p.hr || p.fin || p.app || p.admin);
export function canViewCategory(p, cat) {
  if (p.admin) return true;
  if (cat === "hr" || cat === "labor") return p.hr;
  if (cat === "finance") return p.fin;
  if (cat === "sales_admin") return p.fin || p.app;
  return p.hr || p.fin || p.app;
}
export function canEditCategory(p, cat) {
  if (p.admin) return true;
  if (cat === "hr" || cat === "labor") return p.hr;
  if (cat === "finance") return p.fin;
  if (cat === "sales_admin") return p.fin || p.app;
  return p.app;
}
export const editableCategories = (p) => CATEGORY_KEYS.filter((c) => canEditCategory(p, c));

// ---- 日付 -----------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, "0");
export const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
export const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const dowOf = (date) => { const w = new Date(`${date}T00:00:00Z`).getUTCDay(); return w === 0 ? 7 : w; };   // 1=月〜7=日
export const isBizDay = (date) => dowOf(date) <= 5 && !HOLIDAYS.has(date);
export function shiftBiz(date, dir) {
  if (!dir || isBizDay(date)) return date;
  let d = date;
  for (let i = 0; i < 15 && !isBizDay(d); i++) d = addDays(d, dir === "next" ? 1 : -1);
  return d;
}
function monthEndBiz(y, m, n) {
  let d = ymd(y, m, lastDay(y, m));
  d = shiftBiz(d, "prev");
  for (let i = 0; i < (n || 0); i++) d = shiftBiz(addDays(d, -1), "prev");
  return d;
}

/** その月の予定日（ルールの日。shift 前）。無ければ null */
function monthlyDate(rule, y, m) {
  if (rule.type === "month_end") return ymd(y, m, lastDay(y, m));
  if (rule.type === "month_end_biz") return monthEndBiz(y, m, Number(rule.n) || 0);
  const day = Number(rule.day);
  if (!(day >= 1 && day <= 31)) return null;
  return ymd(y, m, Math.min(day, lastDay(y, m)));
}

/**
 * マスターの予定日（from〜to の範囲。どちらも含む）。開始日・終了日の外は出さない
 * @returns {string[]}
 */
export function occurrences(master, from, to) {
  const rule = master.recurrence_rule || {};
  const start = master.start_on || from;
  const lo = from > start ? from : start;
  const hi = master.end_on && master.end_on < to ? master.end_on : to;
  if (!isDate(lo) || !isDate(hi) || lo > hi) return [];
  const out = new Set();
  const push = (d) => { if (!d) return; const s = shiftBiz(d, rule.shift); if (s >= lo && s <= hi) out.add(s); };
  const type = master.recurrence_type;
  if (type === "none") {
    push(isDate(rule.date) ? rule.date : start);
  } else if (type === "weekly") {
    const dows = (Array.isArray(rule.dows) ? rule.dows : []).map(Number).filter((n) => n >= 1 && n <= 7);
    for (let d = lo; d <= hi; d = addDays(d, 1)) if (dows.includes(dowOf(d))) push(d);
    // shift で範囲の外から入ってくる日（前後の週）も拾う
    for (let i = 1; i <= 7; i++) { const a = addDays(lo, -i), b = addDays(hi, i); if (dows.includes(dowOf(a))) push(a); if (dows.includes(dowOf(b))) push(b); }
  } else if (type === "monthly" || type === "yearly") {
    // 範囲の前後1か月まで見る（shift で月をまたぐことがあるため）
    let y = Number(lo.slice(0, 4)), m = Number(lo.slice(5, 7)) - 1;
    if (m < 1) { m = 12; y--; }
    const endY = Number(hi.slice(0, 4)), endM = Number(hi.slice(5, 7)) + 1;
    for (let guard = 0; guard < 600 && (y < endY || (y === endY && m <= endM)); guard++) {
      if (type === "monthly") push(monthlyDate(rule, y, m));
      else if (Number(rule.month) === m) push(monthlyDate(rule, y, m));
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  return [...out].sort();
}

/** 予定日から期限を出す */
export function dueOf(master, eventDate) {
  const r = master.due_rule || { type: "same" };
  const y = Number(eventDate.slice(0, 4)), m = Number(eventDate.slice(5, 7));
  if (r.type === "offset") return addDays(eventDate, Math.max(0, Math.min(365, Number(r.days) || 0)));
  if (r.type === "month_end") return ymd(y, m, lastDay(y, m));
  if (r.type === "day") {
    const d = Number(r.day);
    if (!(d >= 1 && d <= 31)) return eventDate;
    let due = ymd(y, m, Math.min(d, lastDay(y, m)));
    if (due < eventDate) { const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1; due = ymd(ny, nm, Math.min(d, lastDay(ny, nm))); }
    return due;
  }
  return eventDate;
}

/** 次の予定日（今日以降。無ければ null） */
export function nextOccurrence(master, today) {
  if (!master.is_active) return null;
  return occurrences(master, today, addDays(today, 400))[0] || null;
}

/**
 * 作る予定（まだ無いものだけ）
 * @param {object[]} masters 有効なマスター
 * @param {Set<string>} have すでにある「マスターID|日付」（完了・今回なしも含む＝作り直さない）
 * @param {{from:string, to:string}} range
 */
export function planGeneration(masters, have, { from, to }) {
  const rows = [];
  for (const t of masters) {
    if (!t.is_active) continue;
    for (const d of occurrences(t, from, to)) {
      const key = `${t.id}|${d}`;
      if (have.has(key)) continue;
      have.add(key);
      rows.push({
        tenant_id: t.tenant_id, recurring_task_id: t.id, title: t.title, description: t.description || null,
        category: t.category, event_date: d, due_on: dueOf(t, d), assignee_employee_id: t.assignee_employee_id || null,
        department: t.department || null, priority: t.priority || "normal", note: t.note || null, url: t.url || null,
        status: "pending", source: "recurring",
      });
    }
  }
  return rows;
}

// ---- 表示のことば ----------------------------------------------------------------------
const DOW_JA = ["", "月", "火", "水", "木", "金", "土", "日"];
const SHIFT_JA = { prev: "（土日祝は前の営業日）", next: "（土日祝は次の営業日）" };
export function describeRule(type, rule = {}) {
  const sh = SHIFT_JA[rule.shift] || "";
  const dayText = (r) => (r.type === "month_end" ? "末日" : r.type === "month_end_biz" ? (Number(r.n) ? `最終営業日の${r.n}営業日前` : "最終営業日") : `${r.day}日`);
  if (type === "none") return `1回だけ${rule.date ? `（${rule.date}）` : ""}`;
  if (type === "weekly") return `毎週 ${(rule.dows || []).map((n) => DOW_JA[n] || "").join("・")}${sh}`;
  if (type === "monthly") return `毎月 ${dayText(rule)}${sh}`;
  if (type === "yearly") return `毎年 ${rule.month}月${dayText(rule)}${sh}`;
  return "—";
}
export function describeDue(due = {}) {
  if (!due || due.type === "same" || !due.type) return "予定日と同じ";
  if (due.type === "offset") return `予定日の${due.days}日後`;
  if (due.type === "day") return `${due.day}日（予定日より前なら翌月）`;
  if (due.type === "month_end") return "その月の末日";
  return "—";
}

// ---- 入力の確かめ ----------------------------------------------------------------------
const clean = (v, max) => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; };
/** マスターの入力。問題があれば {problems}、良ければ {value}（表の列の形） */
export function validateMaster(b) {
  const problems = [];
  const title = clean(b?.title, TITLE_MAX);
  if (!title) problems.push("業務名を入れてください");
  const category = CATEGORY_KEYS.includes(b?.category) ? b.category : null;
  if (!category) problems.push("カテゴリを選んでください");
  const type = RECURRENCE_TYPES.includes(b?.recurrenceType) ? b.recurrenceType : null;
  if (!type) problems.push("繰り返しを選んでください");
  const r = b?.recurrenceRule && typeof b.recurrenceRule === "object" ? b.recurrenceRule : {};
  const rule = {};
  if (["prev", "next"].includes(r.shift)) rule.shift = r.shift;
  if (type === "none") {
    if (!isDate(r.date)) problems.push("日付を入れてください"); else rule.date = r.date;
  } else if (type === "weekly") {
    const dows = [...new Set((Array.isArray(r.dows) ? r.dows : []).map(Number).filter((n) => n >= 1 && n <= 7))].sort();
    if (!dows.length) problems.push("曜日を選んでください"); else rule.dows = dows;
  } else if (type === "monthly" || type === "yearly") {
    if (type === "yearly") {
      const mo = Number(r.month);
      if (!(mo >= 1 && mo <= 12)) problems.push("月を選んでください"); else rule.month = mo;
    }
    if (r.type === "month_end") rule.type = "month_end";
    else if (r.type === "month_end_biz" && type === "monthly") { rule.type = "month_end_biz"; rule.n = Math.max(0, Math.min(10, Number(r.n) || 0)); }
    else {
      const d = Number(r.day);
      if (!(d >= 1 && d <= 31)) problems.push("日（1〜31）を入れてください"); else rule.day = d;
    }
  }
  const dr = b?.dueRule && typeof b.dueRule === "object" ? b.dueRule : { type: "same" };
  let due = { type: "same" };
  if (dr.type === "offset") { const n = Number(dr.days); if (!(n >= 0 && n <= 365)) problems.push("期限の日数は0〜365で入れてください"); else due = { type: "offset", days: n }; }
  else if (dr.type === "day") { const d = Number(dr.day); if (!(d >= 1 && d <= 31)) problems.push("期限の日（1〜31）を入れてください"); else due = { type: "day", day: d }; }
  else if (dr.type === "month_end") due = { type: "month_end" };
  const startOn = isDate(b?.startOn) ? b.startOn : null;
  const endOn = b?.endOn ? (isDate(b.endOn) ? b.endOn : (problems.push("終了日の形が正しくありません"), null)) : null;
  if (startOn && endOn && endOn < startOn) problems.push("終了日は開始日より後にしてください");
  const priority = ["high", "normal", "low"].includes(b?.priority) ? b.priority : "normal";
  const url = clean(b?.url, 1000);
  if (url && !/^https?:\/\//i.test(url)) problems.push("関連URLは http(s):// で始めてください");
  if (problems.length) return { problems };
  return {
    value: {
      title, description: clean(b?.description, 4000), category, priority,
      department: clean(b?.department, 100), note: clean(b?.note, 2000), url,
      assignee_employee_id: b?.assigneeEmployeeId ? String(b.assigneeEmployeeId) : null,
      recurrence_type: type, recurrence_rule: rule, due_rule: due,
      ...(startOn ? { start_on: startOn } : {}), end_on: endOn,
    },
  };
}

// ---- Excel 年間予定表の分類 ----------------------------------------------------------------
// 1年に1回だけ出てきても「毎年」と分かる業務（ことばで判断。違えば人が一覧で直す）
const YEARLY_WORDS = [
  "年末調整", "健康診断", "算定基礎", "労働保険", "年度更新", "確定申告", "決算", "棚卸", "賞与", "住民税決定", "特別徴収",
  "償却資産", "法定調書", "36協定", "３６協定", "年次", "定期健康", "ストレスチェック", "派遣事業", "事業報告", "源泉徴収票",
  "給与支払報告", "労働者派遣事業", "収支決算", "年賀", "年末", "年始", "夏季休暇", "冬季休暇", "社員旅行", "忘年会", "新年会",
];
const COL_CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.col, c.key]));
export const EXCEL_COLUMNS = CATEGORIES.map((c) => ({ col: c.col, category: c.key, label: c.label }));

const normText = (s) => String(s || "").replace(/\r/g, "").replace(/^[\s・･\-－*＊●○◎]+/, "").replace(/\s+$/g, "").trim();
// 比べるキー（空白と、末尾のかっこ書きを除く）。全体がかっこ書きの文言（例：（・健康診断の回収期限））は、かっこごと残す
//（除くと空になり、別の文言どうしが同じキーになってしまうため）
const keyOf = (s) => {
  const t = normText(s).replace(/[\s　]+/g, "");
  const k = t.replace(/[（(][^）)]*[）)]$/, "");
  return (k || t).toLowerCase();
};

/** シートの名前・見出しから月（1〜12）を出す。年は見出しが当てにならないので、期（periodStart）から決める */
export function sheetMonth(name, header) {
  const a = String(name || "").match(/^(\d{4})(\d{2})月$/);
  if (a) return { month: Number(a[2]), dated: true };
  const b = String(name || "").match(/^(\d{1,2})月$/);
  if (b) return { month: Number(b[1]), dated: false };
  const c = String(header || "").match(/(\d{1,2})月度/);
  if (c) return { month: Number(c[1]), dated: false };
  return null;
}

/** 期の開始（YYYY-MM）から、その月の年を出す（例：2025-09 始まりなら 9〜12月は2025、1〜8月は2026） */
export function yearInPeriod(periodStart, month) {
  const y = Number(periodStart.slice(0, 4)), s = Number(periodStart.slice(5, 7));
  return month >= s ? y : y + 1;
}

const mode = (arr) => { const c = new Map(); for (const v of arr) c.set(v, (c.get(v) || 0) + 1); return [...c].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]; };

/**
 * Excel のセル（{sheet, header, row, day, col, text}）から、変換一覧を作る
 *   ・同じ月が2つのシートにあるときは、名前に年が入っているシート（例：202510月）を使う。もう一方は「使わないシート」
 *   ・文言は1行ずつ（セルの中の改行で分ける）
 *   ・4か月以上に出る → 毎月（最も多い日。日がずれていれば土日祝は前の営業日）
 *   ・毎年のことば → 毎年（出てきた月・日）
 *   ・それ以外 → 単発（初めは「除外」。必要なものだけ人が「登録」にする）
 * @returns {{rows:object[], sheets:{name:string, month:number|null, used:boolean, reason?:string}[], periodStart:string}}
 */
export function classifyExcel(cells, { periodStart = "2025-09" } = {}) {
  // シートの選び方
  const sheetInfo = new Map();
  for (const c of cells) if (!sheetInfo.has(c.sheet)) sheetInfo.set(c.sheet, { name: c.sheet, ...(sheetMonth(c.sheet, c.header) || { month: null, dated: false }) });
  const byMonth = new Map();
  for (const s of sheetInfo.values()) {
    if (!s.month) continue;
    const cur = byMonth.get(s.month);
    if (!cur || (s.dated && !cur.dated)) byMonth.set(s.month, s);
  }
  const sheets = [...sheetInfo.values()].map((s) => ({
    name: s.name, month: s.month || null,
    used: Boolean(s.month && byMonth.get(s.month) === s),
    reason: !s.month ? "月が分からないシート" : byMonth.get(s.month) !== s ? `${s.month}月は「${byMonth.get(s.month).name}」を使います` : undefined,
  }));
  const usedSheets = new Set(sheets.filter((s) => s.used).map((s) => s.name));

  // 1行ずつにする
  const groups = new Map();   // col|key → { col, text, hits:[{month, day, date}] }
  for (const c of cells) {
    if (!usedSheets.has(c.sheet) || !COL_CATEGORY[c.col]) continue;
    const day = Number(c.day);
    if (!(day >= 1 && day <= 31)) continue;
    const month = sheetInfo.get(c.sheet).month;
    const year = yearInPeriod(periodStart, month);
    if (day > lastDay(year, month)) continue;
    for (const line of String(c.text || "").split(/\n+/)) {
      const text = normText(line);
      if (!text || text.length < 2) continue;
      const k = `${c.col}|${keyOf(text)}`;
      if (!groups.has(k)) groups.set(k, { col: c.col, text, hits: [] });
      groups.get(k).hits.push({ month, day, date: ymd(year, month, day), sheet: c.sheet, row: c.row });
    }
  }

  const rows = [];
  for (const [k, g] of groups) {
    const months = [...new Set(g.hits.map((h) => h.month))];
    const firstPerMonth = months.map((m) => Math.min(...g.hits.filter((h) => h.month === m).map((h) => h.day)));
    const category = COL_CATEGORY[g.col];
    const yearlyWord = YEARLY_WORDS.find((w) => g.text.includes(w));
    const base = {
      key: `xl:${k}`.slice(0, 200), col: g.col, category, categoryLabel: categoryLabel(category), text: g.text,
      title: g.text.slice(0, TITLE_MAX),
      origin: g.hits.slice(0, 30).map((h) => ({ date: h.date, sheet: h.sheet, row: h.row })),
      months: months.length,
    };
    if (months.length >= 4) {
      const day = mode(firstPerMonth);
      const varies = new Set(firstPerMonth).size > 1;
      rows.push({ ...base, kind: "recurring", recurrenceType: "monthly",
        recurrenceRule: { day, ...(varies ? { shift: "prev" } : {}) }, dueRule: { type: "same" },
        include: true, reason: `${months.length}か月に出てくる（多いのは${day}日${varies ? "。日がずれるので、土日祝は前の営業日" : ""}）` });
    } else if (yearlyWord) {
      const h = g.hits[0];
      rows.push({ ...base, kind: "recurring", recurrenceType: "yearly",
        recurrenceRule: { month: h.month, day: h.day }, dueRule: { type: "same" },
        include: true, reason: `「${yearlyWord}」は毎年の業務（${h.month}月${h.day}日に出てくる）` });
    } else {
      for (const h of g.hits.filter((x, i, a) => a.findIndex((y) => y.date === x.date) === i)) {
        rows.push({ ...base, key: `xl:${k}|${h.date}`.slice(0, 200), kind: "single", recurrenceType: "none",
          recurrenceRule: { date: h.date }, dueRule: { type: "same" }, origin: [{ date: h.date, sheet: h.sheet, row: h.row }],
          include: false, reason: months.length > 1 ? `${months.length}か月だけに出てくる（定例か確かめてください）` : "1回だけ出てくる（単発。初めは除外）" });
      }
    }
  }
  rows.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "recurring" ? -1 : 1)
    || CATEGORY_KEYS.indexOf(a.category) - CATEGORY_KEYS.indexOf(b.category)
    || String(a.origin[0]?.date).localeCompare(String(b.origin[0]?.date)));
  return { rows, sheets, periodStart };
}
