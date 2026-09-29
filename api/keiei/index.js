// GET /api/keiei?view=dashboard|expenses|payroll|revenue|cash|accounting|onboarding[&month=YYYY-MM]
//   経営（/keiei）が読む集計。経営者（owner）だけが使える。
//
// ■ 権限（3層を同じ条件にそろえる）
//   ヘッダーの「経営」・/keiei の画面の入口・この API は、すべて canKeiei（owner だけ）。
//   会計の管理者・人事・責任者・採用担当・経理・IT・営業・社労士・一般メンバーは 403。
//   DB 側は、給与を持つ表が gw_can_see_salary / gw_is_owner の RLS（db/099・db/100）。
//   この API は service_role で読むので、入口の canKeiei が唯一の関門になる。
//
// ■ 二段階認証
//   強制日（2026-10-01）を待たず、いつでも要る（lib/mfa.js requireMfaStrict）。
//   経営は、給与・人件費・利益・資金繰りという最重要の情報を扱うため
//
// ■ 元データを再入力させない
//   経費・契約・請求進捗・営業が持つ確定済みの値を、その場で数える（lib/keiei.js）。
//   集計の写しは保存しない。取れないものは「データ未連携」で返し、0 とは返さない
//
// ■ 1本の関数にまとめる（view で切り替え）
//   api/ は 1 ファイル = 1 関数。増やしすぎないため、既存の api/career/index.js と同じ作り

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canKeiei } from "../../lib/gw.js";
import { requireMfaStrict } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstMonth, isMonth } from "../../lib/closing.js";
import { STAGE_KEYS } from "../../lib/billing-progress.js";
import {
  STATUS, MISSING_LABEL, lastMonths, summarizeExpenses, summarizePayroll, summarizeHeadcount,
  summarizeBilling, summarizeRenewals, summarizeSales, buildDashboard,
  EXPENSE_CONFIRMED, EXPENSE_PENDING,
} from "../../lib/keiei.js";

const VIEWS = ["dashboard", "expenses", "payroll", "revenue", "cash", "accounting", "onboarding"];

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 経営者だけ。二段階認証の案内より先に断る（権限のない人に、登録を促さない）
  if (!canKeiei(ctx)) return json(res, 403, { error: "forbidden", hint: "経営は、経営者だけが使えます" });
  if (!(await requireMfaStrict(req, res, ctx, user))) return;

  const q = new URL(req.url, "http://localhost").searchParams;
  const view = q.get("view") || "dashboard";
  if (!VIEWS.includes(view)) return json(res, 400, { error: "invalid_view", views: VIEWS });
  const month = isMonth(q.get("month")) ? q.get("month") : jstMonth();

  try {
    const sb = admin();
    if (view === "dashboard") return json(res, 200, await dashboard(sb, ctx, month));
    if (view === "expenses") return json(res, 200, { month, expense: await expenseOf(sb, ctx, month) });
    if (view === "payroll") return await payroll(res, sb, ctx, user, month);
    if (view === "revenue") return json(res, 200, await revenue(sb, ctx, month));
    if (view === "cash") return json(res, 200, await cash(sb, ctx, month));
    if (view === "accounting") return json(res, 200, await accounting(sb, ctx));
    return json(res, 200, await onboarding(sb, ctx));
  } catch (e) {
    console.error("[keiei]", e?.message || e);
    return json(res, 500, { error: "keiei_failed", detail: String(e?.message || e) });
  }
}

/** 無くても困らない材料。表が未作成・列が無いなどで失敗したら null（その項目だけ「データ未連携」になる） */
const soft = async (q) => {
  try { const { data, error } = await q; return error ? null : data; } catch { return null; }
};
const count = async (q) => {
  try { const { count: n, error } = await q; return error ? null : (n ?? 0); } catch { return null; }
};

const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

// ---- 各元データの読み出し ------------------------------------------------------

async function expenseOf(sb, ctx, month) {
  const months = lastMonths(month, 12);
  const since = new Date(Date.parse(`${months[0]}-01T00:00:00Z`) - 60 * 86400000).toISOString();
  const [reports, payable] = await Promise.all([
    soft(sb.from("gw_expense_reports")
      .select("id, status, payment_method, total_amount, gw_expense_lines(spent_on, category, amount)")
      .eq("tenant_id", ctx.tenantId).in("status", [...EXPENSE_CONFIRMED, ...EXPENSE_PENDING])
      .gte("created_at", since).limit(5000)),
    // 支払待ちは、古い承認済みも漏らさないよう、期間で絞らない
    soft(sb.from("gw_expense_reports").select("id, status, payment_method, total_amount")
      .eq("tenant_id", ctx.tenantId).eq("status", "approved").eq("payment_method", "personal").limit(5000)),
  ]);
  if (reports === null) return null;
  return summarizeExpenses(reports, { month, payableReports: payable || [] });
}

async function employeesOf(sb, ctx) {
  // 075（BP）未適用でも、名簿の一覧は出す（区分の列だけ諦める）
  const full = await soft(sb.from("gw_employees").select("id, display_name, status, employee_kind")
    .eq("tenant_id", ctx.tenantId).limit(2000));
  if (full) return full;
  return soft(sb.from("gw_employees").select("id, display_name, status").eq("tenant_id", ctx.tenantId).limit(2000));
}

async function payrollOf(sb, ctx) {
  const [employees, contracts] = await Promise.all([
    employeesOf(sb, ctx),
    soft(sb.from("gw_contracts").select("employee_id, wage_type, wage_amount, created_at")
      .eq("tenant_id", ctx.tenantId).eq("status", "active").order("created_at", { ascending: false }).limit(3000)),
  ]);
  if (!employees || !contracts) return null;
  return summarizePayroll({ employees, contracts });
}

async function billingOf(sb, ctx, month) {
  const rows = await soft(sb.from("gw_billing_progress").select(["id", ...STAGE_KEYS].join(", "))
    .eq("tenant_id", ctx.tenantId).eq("billing_month", month).limit(3000));
  return rows ? summarizeBilling(rows) : null;
}

async function renewalsOf(sb, ctx) {
  const rows = await soft(sb.from("gw_site_contracts").select("id, period_from, period_to, renewal_status, engagement_kind")
    .eq("tenant_id", ctx.tenantId).limit(3000));
  return rows ? { ...summarizeRenewals(rows, { today: todayJst() }), rows } : null;
}

async function salesOf(sb, ctx) {
  const [won, negotiating] = await Promise.all([
    count(sb.from("gw_sales_companies").select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId).eq("status", "won")),
    count(sb.from("gw_sales_companies").select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId).in("status", ["meeting", "proposal"])),
  ]);
  return won === null ? null : summarizeSales({ won, negotiating: negotiating ?? 0 });
}

// ---- 画面ごと ------------------------------------------------------------------

async function dashboard(sb, ctx, month) {
  const [expense, payroll, employees, billing, renewals, sales] = await Promise.all([
    expenseOf(sb, ctx, month), payrollOf(sb, ctx), employeesOf(sb, ctx),
    billingOf(sb, ctx, month), renewalsOf(sb, ctx), salesOf(sb, ctx),
  ]);
  return {
    ...buildDashboard({
      month, expense, payroll, headcount: employees ? summarizeHeadcount(employees) : null,
      billing, renewals, sales,
    }),
    missingLabel: MISSING_LABEL,
  };
}

async function payroll(res, sb, ctx, user, month) {
  const p = await payrollOf(sb, ctx);
  // 全員の給与を返すので、誰がいつ開いたかを残す（金額そのものは残さない）
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "keiei.view", target: "payroll", detail: { month } });
  if (!p) return json(res, 200, { month, payroll: null, missingLabel: MISSING_LABEL, reason: "契約または名簿のデータを読めませんでした" });
  return json(res, 200, { month, payroll: p });
}

async function revenue(sb, ctx, month) {
  const [billing, renewals, sales] = await Promise.all([billingOf(sb, ctx, month), renewalsOf(sb, ctx), salesOf(sb, ctx)]);
  const near = renewals ? renewals.rows
    .filter((c) => c.period_to && c.renewal_status !== "renewed"
      && Date.parse(`${c.period_to}T00:00:00Z`) >= Date.parse(`${todayJst()}T00:00:00Z`)
      && Date.parse(`${c.period_to}T00:00:00Z`) <= Date.parse(`${todayJst()}T00:00:00Z`) + 45 * 86400000)
    .map((c) => ({ id: c.id, periodTo: c.period_to, kind: c.engagement_kind, renewalStatus: c.renewal_status }))
    .sort((a, b) => String(a.periodTo).localeCompare(String(b.periodTo))) : null;
  return {
    month, missingLabel: MISSING_LABEL,
    money: [
      { key: "revenue", label: "売上（請求額）", status: STATUS.MISSING },
      { key: "purchase", label: "仕入（BP支払額）", status: STATUS.MISSING },
      { key: "gross", label: "粗利・粗利率", status: STATUS.MISSING },
      { key: "won_amount", label: "受注金額", status: STATUS.MISSING },
    ],
    reason: "売上・仕入の金額を持つデータがまだありません。Office で確定する請求・仕入・支払が元データになります（会計の実績は、その照合に使います）。",
    billing, renewals: renewals ? { days: renewals.days, count: renewals.count, active: renewals.active, upcoming: near } : null, sales,
  };
}

async function cash(sb, ctx, month) {
  const expense = await expenseOf(sb, ctx, month);
  return {
    month, missingLabel: MISSING_LABEL,
    payable: expense ? { status: STATUS.EXACT, ...expense.payable, note: "立替経費のうち、承認済みでまだ支払っていないもの" } : null,
    items: [
      { key: "receivable", label: "入金予定", status: STATUS.MISSING },
      { key: "unpaid", label: "未入金", status: STATUS.MISSING },
      { key: "received", label: "入金済", status: STATUS.MISSING },
      { key: "payable_bp", label: "支払予定（BP・外注）", status: STATUS.MISSING },
      { key: "payable_salary", label: "支払予定（給与・カード引落）", status: STATUS.MISSING },
      { key: "overdue", label: "支払期日超過", status: STATUS.MISSING },
      { key: "cash", label: "キャッシュ残高", status: STATUS.MISSING },
    ],
    reason: "請求・入金・BP支払の元データがまだありません（Office で確定するデータが元になります）。",
  };
}

async function accounting(sb, ctx) {
  const rows = await soft(sb.from("journals").select("status, txn_date").eq("tenant_id", ctx.tenantId).limit(10000));
  const by = { draft: 0, approved: 0, sent: 0, rejected: 0, error: 0 };
  let latest = null;
  for (const r of rows || []) {
    if (r.status in by) by[r.status] += 1;
    if (r.status === "approved" && r.txn_date && (!latest || r.txn_date > latest)) latest = r.txn_date;
  }
  return {
    status: rows ? STATUS.PROVISIONAL : STATUS.MISSING,
    journals: rows ? { total: rows.length, ...by, latestApprovedOn: latest } : null,
    missingLabel: MISSING_LABEL,
    note: "このアプリで承認した仕訳だけです（書類のアップロード分）。期首残高・他システムの取引は含みません。MFの会計実績との照合は、これから連携します。",
    links: { accounting: "/admin.html", documents: "/app.html" },
  };
}

async function onboarding() {
  // 入社準備の6ステップは、既存の判定への写像として作る（次の段階）。いまは枠だけ
  return { status: STATUS.MISSING, missingLabel: "準備中", reason: "入社準備は、既存の入社手続きの判定を6ステップに並べ替える形で追加します。" };
}
