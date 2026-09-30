// 経営ハブ（/keiei ホーム）が読む元データ。読み取りだけ（書き込み・更新は一切しない）。
//
// ■ 守ること
//   ・元データを変えない。集計の写しも保存しない（毎回数える）
//   ・読めなかったもの（表が無い・失敗・読み切れない）は null を返す。0 や空にしない
//     （呼ぶ側 lib/keiei-hub.js が「読めなかった」として画面に出す。「問題なし」と読ませない）
//   ・給与・手当・単価の列は、どの表からも読まない（採用の応募者は id・段階・状態・期限だけ）
//   ・1000件を超えても切り捨てない（lib/pg-read.js）

import { readAll } from "./pg-read.js";
import { summarizeHeadcount } from "./keiei.js";
import { STAGE_KEYS } from "./billing-progress.js";
import { prevMonth } from "./closing.js";
import { enrolledOf } from "./mfa.js";
import { BILLING_LOOKBACK, OWNER_EVENTS } from "./keiei-hub.js";
import { INACTIVE } from "./owner-guard.js";

const H = { count: "exact", head: true };

/** 件数だけ。読めなければ null（0 にしない） */
async function countOf(q) {
  try { const { count, error } = await q; return error ? null : (count ?? 0); } catch { return null; }
}
const sum = (rows) => rows.reduce((s, r) => s + (Number(r.total_amount) || 0), 0);
const safe = async (fn) => { try { return await fn(); } catch { return null; } };

/** 社員名簿。075（BP区分）が未適用でも、区分の列だけ諦めて読む */
export async function peopleOf(sb, ctx) {
  const full = await readAll(() => sb.from("gw_employees").select("id, user_id, display_name, status, employee_kind")
    .eq("tenant_id", ctx.tenantId).order("id"));
  if (full) return full;
  return readAll(() => sb.from("gw_employees").select("id, user_id, display_name, status")
    .eq("tenant_id", ctx.tenantId).order("id"));
}

/** 経営者（owner）の一覧と、二段階認証の登録状況。people は peopleOf の結果 */
export async function ownersOf(sb, ctx, people) {
  if (!people) return null;
  const grants = await readAll(() => sb.from("gw_role_grants").select("id, employee_id")
    .eq("tenant_id", ctx.tenantId).eq("role", "owner").order("id"));
  if (!grants) return null;
  const ids = new Set(grants.map((g) => g.employee_id));
  const list = people.filter((p) => ids.has(p.id));
  return Promise.all(list.map(async (p) => {
    const active = !INACTIVE.includes(p.status);
    const canLogin = Boolean(p.user_id);
    let mfa = "unknown";
    if (canLogin) {
      // 自分以外の経営者の認証は、管理用の API でしか見えない。読めなければ「不明」（登録済みとも未登録とも言わない）
      const r = await safe(() => sb.auth.admin.mfa.listFactors({ userId: p.user_id }));
      if (r && !r.error && Array.isArray(r.data?.factors)) mfa = enrolledOf({ factors: r.data.factors }) ? "enrolled" : "none";
    }
    return { employeeId: p.id, name: p.display_name, status: p.status, active, canLogin, mfa };
  }));
}

/**
 * ホームの事実をまとめて読む。
 * @param {{today:string, onboarding:object|null, people?:Array|null}} opts
 *   onboarding … api/keiei の入社準備の結果を onboardingFact() に通したもの（既存の判定をそのまま使う）
 */
export async function readHubFacts(sb, ctx, { today, onboarding }) {
  const month = today.slice(0, 7);
  const prev = prevMonth(month);
  const t = ctx.tenantId;
  const billingMonths = [month];
  while (billingMonths.length < BILLING_LOOKBACK) billingMonths.push(prevMonth(billingMonths[billingMonths.length - 1]));

  const [people, pending, payable, requests, applicants, blockersAll, renewals, closing, billing, journals] = await Promise.all([
    peopleOf(sb, ctx),
    // 承認待ちは、期間で絞らない（古いものも漏らさない）
    readAll(() => sb.from("gw_expense_reports").select("id, status, total_amount")
      .eq("tenant_id", t).in("status", ["pending", "pending_owner"]).order("id")),
    readAll(() => sb.from("gw_expense_reports").select("id, status, payment_method, total_amount")
      .eq("tenant_id", t).eq("status", "approved").eq("payment_method", "personal").order("id")),
    countOf(sb.from("gw_requests").select("id", H).eq("tenant_id", t).eq("status", "pending_owner")),
    // 応募者は、給与の列を選ばない
    readAll(() => sb.from("gw_hr_applicants").select("id, stage, status, decision_due_on").eq("tenant_id", t).order("id")),
    // gw_blockers には tenant_id が無い。止まっているものを読み、この会社の社員のものだけに絞る
    readAll(() => sb.from("gw_blockers").select("id, user_id, escalation_level, blocked_since").eq("status", "open").order("id")),
    readAll(() => sb.from("gw_site_contracts").select("id, period_to, renewal_status").eq("tenant_id", t).order("id")),
    readAll(() => sb.from("gw_month_closings").select("id, month, status").eq("tenant_id", t).eq("month", prev).order("id")),
    readAll(() => sb.from("gw_billing_progress").select(["id", "billing_month", ...STAGE_KEYS].join(", "))
      .eq("tenant_id", t).in("billing_month", billingMonths).order("id")),
    countOf(sb.from("journals").select("id", H).eq("tenant_id", t).eq("status", "draft")),
  ]);

  const owners = await ownersOf(sb, ctx, people);
  const userIds = people ? new Set(people.map((p) => p.user_id).filter(Boolean)) : null;
  const headcount = people ? summarizeHeadcount(people) : null;
  return {
    people: headcount ? { total: headcount.total, proper: headcount.proper, bp: headcount.bp } : null,
    expenses: pending && payable ? {
      ownerWaiting: (() => { const w = pending.filter((r) => r.status === "pending_owner"); return { count: w.length, amount: sum(w) }; })(),
      pending: { count: pending.length, amount: sum(pending) },
      payable: { count: payable.length, amount: sum(payable) },
    } : null,
    requests,
    applicants,
    onboarding,
    blockers: blockersAll && userIds ? blockersAll.filter((b) => userIds.has(b.user_id)) : null,
    renewals,
    closing: closing ? { closed: closing.some((c) => c.status === "closed") } : null,
    billing,
    journals,
    owners,
  };
}

/** api/keiei の入社準備の結果（既存の判定）から、ホームが使う分だけを取り出す。読めていなければ null */
export function onboardingFact(d) {
  if (!d || d.status === "missing" || !d.summary || !Array.isArray(d.rows)) return null;
  return {
    inProgress: d.summary.inProgress,
    company: d.summary.company,
    rows: d.rows.map((r) => ({
      name: r.name, joinOn: r.joinOn, daysToStart: r.daysToStart,
      complete: Boolean(r.six?.complete),
    })),
  };
}

/** 経営設定・セキュリティ: 経営者の一覧・二段階認証・変更の履歴（新しいものから20件） */
export async function readSecurity(sb, ctx) {
  const people = await peopleOf(sb, ctx);
  const owners = await ownersOf(sb, ctx, people);
  let events = null;
  try {
    const { data, error } = await sb.from("gw_activity_log").select("id, ts, actor_id, action, target, detail")
      .eq("tenant_id", ctx.tenantId).in("action", OWNER_EVENTS).order("ts", { ascending: false }).limit(20);
    events = error ? null : (data || []);
  } catch { events = null; }
  return { people, owners, events };
}
