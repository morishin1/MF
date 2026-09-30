// 経営（/keiei）の集計。既存のデータを集めて数える純粋関数だけを置く（DB には触れない）。
//
// ■ 原則
//   ・元データを再入力させない。各機能（経費・契約・請求進捗・営業）が持つ確定済みの値を数える
//   ・**正確に出せるものだけ**を数値で出す。取れないものは「データ未連携」と出し、0円とは出さない
//     （0円と出すと、「売上がなかった」と読まれる。取れていないだけなのに）
//   ・推測で埋めない。契約ベースの人件費のように、条件つきで出せるものは「暫定」と明示し、
//     何を含み何を含まないかを一緒に返す
//
// ■ 状態（status）
//   exact       … 元データから、そのまま正確に数えられる
//   provisional … 数えられるが、含まれないものがある（注記つき）
//   missing     … 元データが無い。数値は返さない（画面は「データ未連携」と出す）
import { prevMonth } from "./closing.js";
import { doneCount, STAGES } from "./billing-progress.js";
import { viewOf as compView, currentAt as compCurrentAt, todayJst as compToday } from "./compensation.js";

export const STATUS = { EXACT: "exact", PROVISIONAL: "provisional", MISSING: "missing" };
export const MISSING_LABEL = "データ未連携";

/** 'YYYY-MM' を、n か月ぶん（今月を含む）古い順に */
export function lastMonths(month, n = 12) {
  const out = [month];
  while (out.length < n) out.unshift(prevMonth(out[0]));
  return out;
}

const yen = (n) => Math.round(Number(n) || 0);
const monthOf = (date) => String(date || "").slice(0, 7);

// ---- 経費 -----------------------------------------------------------------

/** 経費として確定した（承認済み・支払済み）状態 */
export const EXPENSE_CONFIRMED = ["approved", "paid"];
/** まだ確定していない（承認待ち）状態。見込みとして分けて出す */
export const EXPENSE_PENDING = ["pending", "pending_owner"];

/**
 * 経費の集計。金額は、明細の発生日（spent_on）の月で数える
 * （申請の対象月 period は空のことがあり、申請者が変えられるため使わない）。
 * @param {Array<{id:string,status:string,payment_method?:string,total_amount?:number,
 *   gw_expense_lines?:Array<{spent_on:string,category:string,amount:number}>}>} reports
 * @param {{month:string}} opts 今月（'YYYY-MM'）
 */
export function summarizeExpenses(reports, { month, payableReports = null }) {
  const months = lastMonths(month, 12);
  const prev = prevMonth(month);
  const series = new Map(months.map((m) => [m, { month: m, confirmed: 0, pending: 0 }]));
  const byCategory = new Map();
  const byMethod = { personal: 0, corporate_card: 0 };
  let pendingCount = 0;
  const pendingIds = new Set();
  let payableAmount = 0;
  let payableCount = 0;

  for (const r of reports || []) {
    const confirmed = EXPENSE_CONFIRMED.includes(r.status);
    const pending = EXPENSE_PENDING.includes(r.status);
    if (!confirmed && !pending) continue;   // 却下・取消は数えない

    for (const l of r.gw_expense_lines || []) {
      const m = monthOf(l.spent_on);
      const row = series.get(m);
      if (!row) continue;
      const a = yen(l.amount);
      if (confirmed) row.confirmed += a; else row.pending += a;
      if (m === month) {
        if (confirmed) {
          byCategory.set(l.category || "未分類", (byCategory.get(l.category || "未分類") || 0) + a);
          if (r.payment_method in byMethod) byMethod[r.payment_method] += a;
        } else if (!pendingIds.has(r.id)) {
          pendingIds.add(r.id);
          pendingCount += 1;
        }
      }
    }
    // 立替経費の「支払待ち」＝承認済みで、まだ支払っていない立替（法人カードは支払処理が無い）
    if (!payableReports && r.status === "approved" && r.payment_method === "personal") {
      payableAmount += yen(r.total_amount);
      payableCount += 1;
    }
  }
  // 古い承認済み・未払いも漏らさないよう、期間で絞らずに別に数えたものを渡せる
  for (const r of payableReports || []) {
    if (r.status === "approved" && r.payment_method === "personal") {
      payableAmount += yen(r.total_amount);
      payableCount += 1;
    }
  }

  const cur = series.get(month)?.confirmed || 0;
  const before = series.get(prev)?.confirmed || 0;
  return {
    status: STATUS.EXACT,
    month, prevMonth: prev,
    confirmed: {
      thisMonth: cur, prevMonth: before, diff: cur - before,
      diffPct: before ? Math.round(((cur - before) / before) * 1000) / 10 : null,
    },
    pending: { thisMonth: series.get(month)?.pending || 0, count: pendingCount },
    byCategory: [...byCategory].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
    byMethod,
    payable: { amount: payableAmount, count: payableCount },
    monthly: [...series.values()],
    note: "確定＝承認済み＋支払済み。承認待ちは見込みとして分けています。金額は領収書の額（税込と解釈。税抜への換算はしていません）。",
  };
}

// ---- 人件費（暫定） ---------------------------------------------------------

const HOURLY_LIKE = ["時給", "日給"];

/**
 * いま在籍している状態。退職手続き中（leaving）は、退職するまで在籍・給与の対象。
 * 入社準備中（invited）は、まだ入社していないので含めない（別枠で数える）
 */
const CURRENT = ["active", "leaving"];

/**
 * 人件費の暫定集計。
 *
 * ■ 何を「いまの給与」とするか（docs/keiei-pay-management.md）
 *   給与管理（gw_compensations）に、いま適用中の記録がある人は、その記録（基本給＋手当＋通勤手当）。
 *   記録が無い人は、これまでどおり、有効な契約の賃金（基本給だけ）。
 *   同じ人に2つの金額があっても、足し合わせない（記録がある人は記録だけ）。どちらを見たかは source に出す。
 *   compensations が null（表が無い／読めない）なら、契約だけで数える。
 *
 * 月給はそのまま、年俸は 12 で割る。時給・日給は実稼働が確定していないので入れない
 * （入れると推測になる）。社会保険料・賞与・残業割増・役員報酬・実際の支給額は
 * このアプリに無いので含まない。実績は会計（給与）側にある。
 *
 * @param {{employees:Array<{id,display_name,employee_kind?,status}>,
 *   contracts:Array<{employee_id,wage_type,wage_amount}>,
 *   compensations?:Array<object>|null, today?:string}} src
 */
export function summarizePayroll({ employees, contracts, compensations = null, today = compToday() }) {
  const active = (employees || []).filter((e) => CURRENT.includes(e.status) && e.employee_kind !== "bp");
  const contractOf = new Map();
  for (const c of contracts || []) if (!contractOf.has(c.employee_id)) contractOf.set(c.employee_id, c);

  // 給与管理の、いま適用中の記録（人ごと）。表が読めていないときは、使わない
  const currentOf = new Map();
  if (Array.isArray(compensations)) {
    const by = new Map();
    for (const r of compensations) {
      if (!by.has(r.employee_id)) by.set(r.employee_id, []);
      by.get(r.employee_id).push(compView(r));
    }
    for (const [id, recs] of by) { const cur = compCurrentAt(recs, today); if (cur) currentOf.set(id, cur); }
  }

  let total = 0;
  let counted = 0;
  let fromPay = 0;
  const rows = active.map((e) => {
    const cur = currentOf.get(e.id);
    if (cur) {
      const base = { id: e.id, name: e.display_name, wageType: cur.wageType, wageAmount: cur.baseAmount, source: "pay" };
      const m = cur.monthly;
      if (m.total == null) return { ...base, monthly: null, included: false, reason: `${cur.wageType}は実稼働が未確定のため含めていません` };
      total += m.total; counted += 1; fromPay += 1;
      return { ...base, monthly: yen(m.total), included: true, reason: null };
    }
    const c = contractOf.get(e.id);
    const base = { id: e.id, name: e.display_name, wageType: c?.wage_type || null, wageAmount: c?.wage_amount ?? null, source: "contract" };
    if (!c) return { ...base, monthly: null, included: false, reason: "有効な契約が未登録" };
    const amount = Number(c.wage_amount);
    if (!Number.isFinite(amount) || amount <= 0) return { ...base, monthly: null, included: false, reason: "賃金が未入力" };
    if (c.wage_type === "月給") { total += amount; counted += 1; return { ...base, monthly: yen(amount), included: true, reason: null }; }
    if (c.wage_type === "年俸") { total += amount / 12; counted += 1; return { ...base, monthly: yen(amount / 12), included: true, reason: null }; }
    if (HOURLY_LIKE.includes(c.wage_type)) return { ...base, monthly: null, included: false, reason: `${c.wage_type}は実稼働が未確定のため含めていません` };
    return { ...base, monthly: null, included: false, reason: "賃金の種類が月給・年俸ではありません" };
  });

  const excluded = rows.filter((r) => !r.included);
  const fromContract = counted - fromPay;
  return {
    status: STATUS.PROVISIONAL,
    monthlyTotal: yen(total),
    counted,
    countedFromPay: fromPay,
    countedFromContract: fromContract,
    employeeCount: active.length,
    excludedCount: excluded.length,
    rows: rows.sort((a, b) => Number(b.included) - Number(a.included) || (b.monthly || 0) - (a.monthly || 0)),
    note: fromPay
      ? "給与管理に記録がある人は、その記録（基本給＋手当＋通勤手当）で、記録がない人は契約の基本給で数えた暫定値です（月給・年俸のみ）。"
        + "社会保険料・賞与・残業割増・役員報酬・実際の支給額は含みません。"
      : "契約に登録された基本給ベースの暫定値です（月給・年俸のみ）。社会保険料・賞与・残業割増・手当・役員報酬・実際の支給額は含みません。",
  };
}

// ---- 稼働・請求・契約・営業（金額を伴わない件数） -----------------------------

/** 在籍者の内訳（プロパー／BP） */
export function summarizeHeadcount(employees) {
  const active = (employees || []).filter((e) => CURRENT.includes(e.status));
  const bp = active.filter((e) => e.employee_kind === "bp").length;
  return {
    status: STATUS.EXACT, total: active.length, proper: active.length - bp, bp,
    invited: (employees || []).filter((e) => e.status === "invited").length,
  };
}

/** 月次請求進捗（5段階）。金額は持たない。行は 1契約×1か月 */
export function summarizeBilling(rows) {
  const list = rows || [];
  const byStage = STAGES.map((s) => ({ key: s.key, label: s.label, done: list.filter((r) => r[s.key]).length }));
  return {
    status: STATUS.EXACT, total: list.length,
    complete: list.filter((r) => doneCount(r) === STAGES.length).length,
    notStarted: list.filter((r) => doneCount(r) === 0).length,
    byStage,
  };
}

/** 契約更新の期限が近い現場契約（today から days 日以内に終わるもの） */
export function summarizeRenewals(contracts, { today, days = 45 }) {
  const t = Date.parse(`${today}T00:00:00Z`);
  const limit = t + days * 86400000;
  const near = (contracts || []).filter((c) => {
    if (!c.period_to || c.renewal_status === "renewed") return false;
    const end = Date.parse(`${c.period_to}T00:00:00Z`);
    return end >= t && end <= limit;
  });
  return {
    status: STATUS.EXACT, days, count: near.length,
    active: (contracts || []).filter((c) => !c.period_to || Date.parse(`${c.period_to}T00:00:00Z`) >= t).length,
  };
}

/** 営業の成約・商談の件数（金額の列は無い。件数だけ） */
export function summarizeSales({ won = 0, negotiating = 0 } = {}) {
  return { status: STATUS.EXACT, won: Number(won) || 0, negotiating: Number(negotiating) || 0 };
}

// ---- ダッシュボード -----------------------------------------------------------

const missing = (key, group, label, reason, view) => ({ key, group, label, status: STATUS.MISSING, reason, view });

/**
 * ダッシュボードのカード。数値は、正確に出せるものだけ。
 * 不足は status:"missing"（value を持たない）。画面は「データ未連携」と出し、0円とは出さない。
 */
export function buildDashboard({ month, expense, payroll, headcount, billing, renewals, sales }) {
  const cards = [];
  const put = (c) => cards.push(c);

  put(missing("revenue", "money", "今月売上", "請求データが未連携です（Office で確定する請求が元データになります）", "revenue"));
  put(missing("gross", "money", "今月粗利・粗利率", "売上と仕入が未連携のため出せません", "revenue"));
  if (expense) {
    put({
      key: "expense", group: "money", label: "今月経費（確定）", status: expense.status, unit: "yen",
      value: expense.confirmed.thisMonth,
      sub: expense.confirmed.diffPct == null ? "前月は経費なし"
        : `前月比 ${expense.confirmed.diff >= 0 ? "+" : ""}${expense.confirmed.diffPct}%`,
      note: expense.pending.count ? `承認待ち ${expense.pending.count}件（${expense.pending.thisMonth.toLocaleString("ja-JP")}円）は含みません` : null,
      view: "expenses",
    });
  } else put(missing("expense", "money", "今月経費（確定）", "経費のデータを読めませんでした", "expenses"));
  if (payroll) {
    put({
      key: "payroll", group: "money", label: "今月人件費", status: payroll.status, unit: "yen",
      value: payroll.monthlyTotal,
      sub: `${payroll.countedFromPay ? "給与管理＋契約" : "契約"}ベース（暫定）・${payroll.counted}/${payroll.employeeCount}人分`,
      note: payroll.note, view: "payroll",
    });
  } else put(missing("payroll", "money", "今月人件費", "契約のデータを読めませんでした", "payroll"));
  put(missing("profit", "money", "営業利益（概算）", "売上・仕入が未連携のため出せません", "revenue"));
  put(missing("receivable", "money", "入金予定・未入金", "請求と入金のデータが未連携です", "cash"));
  if (expense) {
    put({
      key: "payable", group: "money", label: "支払予定（立替経費）", status: STATUS.EXACT, unit: "yen",
      value: expense.payable.amount, sub: `${expense.payable.count}件（承認済み・未払い）`,
      note: "BP・外注・給与の支払予定は未連携です", view: "cash",
    });
  }
  put(missing("payable_bp", "money", "支払予定（BP・外注）", "BP支払のデータが未連携です", "cash"));
  put(missing("cash", "money", "キャッシュ残高", "会計・銀行の残高が未連携です", "cash"));

  if (billing) {
    put({ key: "billing", group: "ops", label: "請求進捗（今月）", status: STATUS.EXACT, unit: "text",
          value: `${billing.complete}/${billing.total}`, sub: "5段階すべて完了 / 対象契約",
          note: "金額ではなく進み具合です", view: "revenue" });
  }
  if (renewals) {
    put({ key: "renewals", group: "ops", label: `契約更新（${renewals.days}日以内）`, status: STATUS.EXACT, unit: "count", suffix: "件",
          value: renewals.count, sub: `稼働中 ${renewals.active}件`, view: "revenue" });
  }
  if (headcount) {
    put({ key: "headcount", group: "ops", label: "在籍", status: STATUS.EXACT, unit: "count", suffix: "人",
          value: headcount.total, sub: `プロパー ${headcount.proper}・BP ${headcount.bp}${headcount.invited ? `／入社準備中 ${headcount.invited}` : ""}`,
          view: "onboarding" });
  }
  if (sales) {
    put({ key: "sales", group: "ops", label: "成約（累計）", status: STATUS.EXACT, unit: "count", suffix: "件",
          value: sales.won, sub: `商談中 ${sales.negotiating}`, note: "営業の成約は件数のみです（金額の列がありません）", view: "revenue" });
  }
  return { month, cards };
}
