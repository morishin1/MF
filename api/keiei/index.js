// GET /api/keiei?view=hub|security|payroll|onboarding[&month=YYYY-MM]   … 画面（/keiei）が呼ぶもの
// GET /api/keiei?view=dashboard|expenses|revenue|cash|accounting         … 旧ダッシュボード用。画面（/keiei）は呼ばない
//   旧 view は後方互換のために残している。物理削除は、呼び出しが 0 件と確かめてから別に行う（docs/keiei-hub.md §6）
//   経営（/keiei）が読む集計。経営者（owner）だけが使える。
//
// ■ 権限（3層を同じ条件にそろえる）
//   ヘッダーの「経営」・/keiei の画面の入口・この API は、すべて canKeiei（owner だけ）。
//   会計の管理者・人事・責任者・採用担当・経理・IT・営業・社労士・一般メンバーは 403。
//   DB 側は、給与を持つ表が gw_can_see_salary / gw_is_owner の RLS（db/099・db/100）。
//   この API は service_role で読むので、入口の canKeiei が唯一の関門になる。
//
// ■ 二段階認証は要らない
//   二段階認証は任意のセキュリティ設定（2026-10-01 の方針変更。docs/mfa-optional.md）。
//   経営の入口は、経営者（owner）のロールだけで通す。未登録をエラー・警告にもしない
//
// ■ 元データを再入力させない
//   経費・契約・請求進捗・営業が持つ確定済みの値を、その場で数える（lib/keiei.js）。
//   集計の写しは保存しない。取れないものは「データ未連携」で返し、0 とは返さない
//
// ■ 1本の関数にまとめる（view で切り替え）
//   api/ は 1 ファイル = 1 関数。増やしすぎないため、既存の api/career/index.js と同じ作り

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireKeiei } from "../../lib/keiei-gate.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstMonth, isMonth } from "../../lib/closing.js";
import { STAGE_KEYS } from "../../lib/billing-progress.js";
import { gatherFactsBulk } from "../../lib/onboard-advance.js";
import { daysToStart } from "../../lib/onboard-stage.js";
import { journeyLinks } from "../../lib/journey-load.js";
import { SIX_STEPS, mapSix, summarizeSix } from "../../lib/onboard-six.js";
import { guideFact } from "../../lib/onboard-guide.js";
import { readAll, readIn, chunks } from "../../lib/pg-read.js";
import { buildHub, buildSecurity } from "../../lib/keiei-hub.js";
import { readHubFacts, readSecurity, onboardingFact } from "../../lib/keiei-hub-read.js";
import {
  STATUS, MISSING_LABEL, lastMonths, summarizeExpenses, summarizePayroll, summarizeHeadcount,
  summarizeBilling, summarizeRenewals, summarizeSales, buildDashboard,
  EXPENSE_CONFIRMED, EXPENSE_PENDING,
} from "../../lib/keiei.js";

const VIEWS = ["hub", "security", "dashboard", "expenses", "payroll", "revenue", "cash", "accounting", "onboarding"];

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  // 経営者だけ（lib/keiei-gate.js）。権限のない人は 403
  const gate = await requireKeiei(req, res);
  if (!gate) return;
  const { user, ctx } = gate;

  const q = new URL(req.url, "http://localhost").searchParams;
  const view = q.get("view") || "dashboard";
  if (!VIEWS.includes(view)) return json(res, 400, { error: "invalid_view", views: VIEWS });
  const month = isMonth(q.get("month")) ? q.get("month") : jstMonth();

  try {
    const sb = admin();
    if (view === "hub") return json(res, 200, await hub(sb, ctx));
    if (view === "security") return json(res, 200, await security(sb, ctx));
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

const count = async (q) => {
  try { const { count: n, error } = await q; return error ? null : (n ?? 0); } catch { return null; }
};

const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

// ---- 各元データの読み出し ------------------------------------------------------

async function expenseOf(sb, ctx, month) {
  const months = lastMonths(month, 12);
  const since = new Date(Date.parse(`${months[0]}-01T00:00:00Z`) - 60 * 86400000).toISOString();
  const [reports, payable] = await Promise.all([
    readAll(() => sb.from("gw_expense_reports")
      .select("id, status, payment_method, total_amount, gw_expense_lines(spent_on, category, amount)")
      .eq("tenant_id", ctx.tenantId).in("status", [...EXPENSE_CONFIRMED, ...EXPENSE_PENDING])
      .gte("created_at", since).order("id")),
    // 支払待ちは、古い承認済みも漏らさないよう、期間で絞らない
    readAll(() => sb.from("gw_expense_reports").select("id, status, payment_method, total_amount")
      .eq("tenant_id", ctx.tenantId).eq("status", "approved").eq("payment_method", "personal").order("id")),
  ]);
  // どちらかが読めなければ、一部だけの合計を「正確」と言わない（支払待ちを 0円 と出さない）
  if (reports === null || payable === null) return null;
  return summarizeExpenses(reports, { month, payableReports: payable });
}

async function employeesOf(sb, ctx) {
  // 075（BP）未適用でも、名簿の一覧は出す（区分の列だけ諦める）
  const full = await readAll(() => sb.from("gw_employees").select("id, display_name, status, employee_kind")
    .eq("tenant_id", ctx.tenantId).order("id"));
  if (full) return full;
  return readAll(() => sb.from("gw_employees").select("id, display_name, status").eq("tenant_id", ctx.tenantId).order("id"));
}

/**
 * 給与管理（gw_compensations, db/105）の記録。
 * 表が無いなら { rows: null }（契約だけで数える）。表があるのに読めなければ { error: true }
 * （読めた一部だけ、あるいは契約だけに黙って切り替えて、違う合計を出さない）
 */
async function compensationsOf(sb, ctx) {
  let probe;
  try { probe = await sb.from("gw_compensations").select("id").eq("tenant_id", ctx.tenantId).limit(1); } catch { return { error: true }; }
  if (probe?.error) return dbSetupHint(probe.error, "db/105_compensation.sql") ? { rows: null } : { error: true };
  const rows = await readAll(() => sb.from("gw_compensations")
    .select("id, employee_id, effective_from, revision, kind, source, wage_type, base_amount, allowances, commute_amount")
    .eq("tenant_id", ctx.tenantId).order("id"));
  return rows ? { rows } : { error: true };
}

async function payrollOf(sb, ctx, preloaded) {
  const [employees, contracts, comp] = await Promise.all([
    preloaded === undefined ? employeesOf(sb, ctx) : preloaded,
    readAll(() => sb.from("gw_contracts").select("employee_id, wage_type, wage_amount, created_at")
      .eq("tenant_id", ctx.tenantId).eq("status", "active").order("created_at", { ascending: false }).order("id")),
    compensationsOf(sb, ctx),
  ]);
  if (!employees || !contracts || comp.error) return null;
  return { ...summarizePayroll({ employees, contracts, compensations: comp.rows }), payLinked: comp.rows !== null };
}

async function billingOf(sb, ctx, month) {
  const rows = await readAll(() => sb.from("gw_billing_progress").select(["id", ...STAGE_KEYS].join(", "))
    .eq("tenant_id", ctx.tenantId).eq("billing_month", month).order("id"));
  return rows ? summarizeBilling(rows) : null;
}

async function renewalsOf(sb, ctx) {
  const rows = await readAll(() => sb.from("gw_site_contracts").select("id, period_from, period_to, renewal_status, engagement_kind")
    .eq("tenant_id", ctx.tenantId).order("id"));
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

/**
 * 経営ホーム（4ブロック）。集計と優先度づけは lib/keiei-hub.js、元データの読み出しは lib/keiei-hub-read.js。
 * 入社準備の判定は、下の onboarding()（既存の段階の写像）をそのまま使う。
 * 読めなかった元データは、0 にせず unreadable に並べる。給与の金額は、この画面のどこにも出さない
 */
async function hub(sb, ctx) {
  const today = todayJst();
  let ob = null;
  try { ob = onboardingFact(await onboarding(sb, ctx)); } catch { ob = null; }
  const facts = await readHubFacts(sb, ctx, { today, onboarding: ob });
  return { ...buildHub({ today, facts }), missingLabel: MISSING_LABEL };
}

/** 経営設定・セキュリティ: 経営者の一覧・二段階認証・変更の履歴 */
async function security(sb, ctx) {
  const { people, owners, events } = await readSecurity(sb, ctx);
  if (!owners) return { status: STATUS.MISSING, missingLabel: MISSING_LABEL, reason: "経営者の一覧を読めませんでした" };
  return { status: STATUS.EXACT, ...buildSecurity({ owners, events, people, today: todayJst() }),
    historyReadable: events !== null };
}

async function dashboard(sb, ctx, month) {
  // 名簿は1回だけ読む（在籍数と人件費で使い回す）
  const employeesP = employeesOf(sb, ctx);
  const [expense, payroll, employees, billing, renewals, sales] = await Promise.all([
    expenseOf(sb, ctx, month), employeesP.then((e) => payrollOf(sb, ctx, e)), employeesP,
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
  if (!p) return json(res, 200, { month, payroll: null, missingLabel: MISSING_LABEL, reason: "契約・名簿・給与管理のデータを読めませんでした" });
  // 給与管理の記録を含めて返すときは、給与管理の監査ログにも残す。残せなければ、給与は返さない
  if (p.payLinked) {
    const { error } = await sb.from("gw_pay_audit").insert({ tenant_id: ctx.tenantId, actor_id: user.id,
      actor_name: ctx.employee?.display_name || user.email || null, action: "view_list", detail: { via: "payroll", month } });
    if (error) {
      console.error("[keiei] 給与の監査ログを残せませんでした:", error.message);
      return json(res, 503, { error: "audit_unavailable", hint: "監査ログを残せないため、給与は表示しません。しばらくしてからもう一度お試しください（続く場合は管理者へ）" });
    }
  }
  const { payLinked, ...out } = p;
  return json(res, 200, { month, payroll: out });
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
  // 1000 件を超えても、切り捨てない（読み切れなければ「データ未連携」）
  const rows = await readAll(() => sb.from("journals").select("id, status, txn_date").eq("tenant_id", ctx.tenantId).order("id"));
  const by = { draft: 0, approved: 0, sent: 0, rejected: 0, error: 0 };
  let latest = null;
  for (const r of rows || []) {
    if (r.status in by) by[r.status] += 1;
    // 承認した仕訳は、MF へ送ると sent になる。承認済み＝approved と sent の合計
    if ((r.status === "approved" || r.status === "sent") && r.txn_date && (!latest || r.txn_date > latest)) latest = r.txn_date;
  }
  return {
    status: rows ? STATUS.PROVISIONAL : STATUS.MISSING,
    journals: rows ? { total: rows.length, ...by, approvedTotal: by.approved + by.sent, latestApprovedOn: latest } : null,
    missingLabel: MISSING_LABEL,
    note: "このアプリで承認した仕訳だけです（書類のアップロード分）。期首残高・他システムの取引は含みません。MFの会計実績との照合は、これから連携します。",
    links: { accounting: "/admin.html", documents: "/app.html" },
  };
}

// ---- 入社準備（6ステップ）--------------------------------------------------------
//
// 判定は既存の 1 か所（lib/onboard-stage.js の段階 ＋ lib/career.js のキャリア状態）。
// ここは事実をまとめて読み、lib/onboard-six.js で6ステップに並べるだけ。
// 給与・手当の金額と給与入りの書面は、この画面に出さない（状態だけ）。

/** 完了してから、この日数を過ぎた人は一覧から外す（数だけ返す）。次の一手が残っていれば外さない */
const ONBOARD_KEEP_DAYS = 30;
const CAREER_COLS = "employee_id, track_id, current_level_id, one_year_target_note, three_year_target_note, "
  + "next_review_on, agreed_at, updated_at";

/** 6ステップの「押す先」。実際の作業は既存の画面で行う（作り直さない）。案内だけは、経営の詳細画面 */
function hrefOf(stepKey, stage, links) {
  if (stepKey === "guide") return links.detail;
  if (stepKey === "contract") return stage === "signing" ? links.signs : links.order;
  if (stepKey === "info" || stepKey === "docs" || stepKey === "company") return links.hr;
  return null;
}

async function onboarding(sb, ctx) {
  const today = todayJst();
  const unreadable = (what) => ({ status: STATUS.MISSING, missingLabel: MISSING_LABEL, steps: SIX_STEPS,
    reason: `${what}を読めませんでした（表が未適用か、件数が多すぎて読み切れませんでした）` });

  const procs = await readAll(() => sb.from("gw_procedures")
    .select("id, tenant_id, employee_id, kind, status, target_on, stage, stage_at, updated_at, created_at")
    .eq("tenant_id", ctx.tenantId).eq("kind", "onboarding").order("created_at", { ascending: false }).order("id"));
  if (procs === null) {
    return { status: STATUS.MISSING, missingLabel: MISSING_LABEL, steps: SIX_STEPS,
      reason: "入社手続きの表が読めません（db/070 が未適用の可能性があります）" };
  }

  // 1人につき、いちばん新しい手続き（取り消しは除く）
  const latest = new Map();
  for (const p of procs) {
    if (p.status === "cancelled" || latest.has(p.employee_id)) continue;
    latest.set(p.employee_id, p);
  }
  const empIds = [...latest.keys()];
  if (!empIds.length) {
    return { status: STATUS.EXACT, steps: SIX_STEPS, summary: summarizeSix([]), rows: [], hiddenComplete: 0,
      links: { start: "/admin-onboard.html", hr: "/admin-hr.html" } };
  }

  // 条件（in）は 100 件ずつに分ける（URL が長すぎて断られないように）
  const [emps, careers, guides] = await Promise.all([
    readIn((part) => sb.from("gw_employees").select("id, display_name, department, position, employment_type, status, joined_on")
      .eq("tenant_id", ctx.tenantId).in("id", part).order("id"), empIds),
    // 095 の列が無い環境でも、基本の列で読む（本人確認の列だけ諦める）
    readIn((part) => sb.from("gw_employee_careers").select(`${CAREER_COLS}, confirm_requested_at, employee_confirmed_at`)
      .eq("tenant_id", ctx.tenantId).eq("is_active", true).in("employee_id", part).order("id"), empIds)
      .then((r) => r ?? readIn((part) => sb.from("gw_employee_careers").select(CAREER_COLS)
        .eq("tenant_id", ctx.tenantId).eq("is_active", true).in("employee_id", part).order("id"), empIds)),
    // 入社案内（db/104）。表が無ければ null → ① だけ「データ未連携」
    readIn((part) => sb.from("gw_onboarding_guides")
      .select("employee_id, version, confirmed_version, confirmed_at").eq("tenant_id", ctx.tenantId).in("employee_id", part).order("id"), empIds),
  ]);
  // 名簿が読めないまま「入社準備中の人はいません」と出さない
  if (emps === null) return unreadable("社員名簿");
  const empBy = new Map(emps.map((e) => [e.id, e]));
  const careerBy = new Map((careers || []).map((c) => [c.employee_id, c]));
  const guideBy = new Map((guides || []).map((g) => [g.employee_id, g]));

  const procList = empIds.map((id) => latest.get(id)).filter((p) => empBy.has(p.employee_id) && empBy.get(p.employee_id).status !== "left");
  // チェックリストが読めないまま「全部済んでいる」（残り0件）にしない
  const items = procList.length
    ? await readIn((part) => sb.from("gw_procedure_items")
      .select("id, procedure_id, item_key, owner, required, status").in("procedure_id", part).order("id"), procList.map((p) => p.id))
    : [];
  if (items === null) return unreadable("入社手続きのチェックリスト");
  const itemsBy = new Map();
  for (const i of items) {
    if (!itemsBy.has(i.procedure_id)) itemsBy.set(i.procedure_id, []);
    itemsBy.get(i.procedure_id).push(i);
  }
  // 事実の一括読み出し（署名・届出・同意・オリエンテーション）も 100 人ずつ
  let factsBy = new Map();
  try {
    for (const part of chunks(procList)) {
      for (const [k, v] of await gatherFactsBulk(sb, ctx.tenantId, part, itemsBy)) factsBy.set(k, v);
    }
  } catch { factsBy = new Map(); }

  const cutoff = Date.parse(`${today}T00:00:00Z`) - ONBOARD_KEEP_DAYS * 86400000;
  let hiddenComplete = 0;
  const rows = [];
  for (const p of procList) {
    const e = empBy.get(p.employee_id);
    const six = mapSix({
      facts: factsBy.get(p.id) || null, career: careerBy.get(e.id) || null, careerLinked: careers !== null,
      guide: guideFact(guideBy.get(e.id) || null), guideLinked: guides !== null,
    });
    // 完了して30日を過ぎても、次の一手（キャリア）が会社側に残っていれば外さない
    if (six.complete && !six.after?.actor) {
      const at = Date.parse(p.stage_at || p.updated_at || p.created_at || "");
      if (Number.isFinite(at) && at < cutoff) { hiddenComplete += 1; continue; }
    }
    // journeyLinks は GW の画面（相対）を返す。/keiei からは絶対パスで開く
    const links = Object.fromEntries(Object.entries(journeyLinks(e.id, p.id)).map(([k, v]) => [k, `/${v}`]));
    links.career = `/admin-career.html?employeeId=${encodeURIComponent(e.id)}`;
    links.detail = `#onboarding/${encodeURIComponent(e.id)}`;
    for (const st of six.steps) st.href = ["current", "na"].includes(st.state) && st.key === "guide" ? links.detail
      : st.state === "current" ? hrefOf(st.key, six.stage, links) : null;
    if (six.after && six.after.actor) six.after.href = links.career;
    const joinOn = p.target_on || e.joined_on || null;
    rows.push({
      employeeId: e.id, procedureId: p.id, name: e.display_name, department: e.department || null,
      position: e.position || null, employmentType: e.employment_type || null,
      joinOn, daysToStart: daysToStart(joinOn, today), six,
      links: { hr: links.hr, onboarding: links.onboarding, detail: links.detail },
    });
  }
  // まだ終わっていない人を先に。同じなら入社日が近い順
  rows.sort((x, y) => (Number(x.six.complete) - Number(y.six.complete))
    || String(x.joinOn || "9999").localeCompare(String(y.joinOn || "9999"))
    || String(x.name || "").localeCompare(String(y.name || ""), "ja"));

  return {
    status: STATUS.EXACT, steps: SIX_STEPS, today,
    summary: summarizeSix(rows), rows, hiddenComplete,
    links: { start: "/admin-onboard.html", hr: "/admin-hr.html" },
  };
}
