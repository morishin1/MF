// 1人ぶんの「採用決定 → 契約 → 入社 → キャリア → 育成」を、既存の表から集めて計算する。
//
// 管理者の社員ドロワー（api/career?employeeId=…）・本人画面のプレビュー（api/career?preview=…）・
// 本人のホーム/入社手続き/キャリア（api/career/me?journey=1）は、すべてこの1つを呼ぶ。
// だから同じ人について、管理者と本人で進み具合が食い違わない。
// （一覧 api/career?journey=1 は大人数をまとめて読むが、判定は同じ journeyOf。一致はテストで守る）

import { journeyOf } from "./journey.js";
import { flowOf, CONTRACT_DOC_KINDS, OPEN_ORDER_STATUSES } from "./career.js";
import { computeStage } from "./onboard-stage.js";
import { gatherFacts } from "./onboard-advance.js";

const soft = async (q) => { try { const { data, error } = await q; return error ? null : data; } catch { return null; } };
const jstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

/** 管理画面の行き先（本人の画面では使わない） */
export function journeyLinks(employeeId, procId) {
  const id = encodeURIComponent(employeeId);
  return {
    order: `admin-esign.html?tab=order&employeeId=${id}`,
    signs: "admin-esign.html?tab=list",
    hr: procId ? `admin-hr.html?id=${encodeURIComponent(procId)}` : "admin-hr.html",
    growth: `admin-growth.html?employeeId=${id}`,
    onboarding: `onboarding.html?employeeId=${id}`,
  };
}

/** その社員の入社手続き（あれば）。段階は lib/onboard-stage.js で計算する */
export async function onboardingOf(sb, tenantId, employeeId) {
  const procs = await soft(sb.from("gw_procedures")
    .select("id, tenant_id, employee_id, kind, status, target_on, stage, stage_at, updated_at, created_at")
    .eq("tenant_id", tenantId).eq("employee_id", employeeId).eq("kind", "onboarding")
    .order("created_at", { ascending: false }).limit(1));
  const proc = procs?.[0];
  if (!proc || proc.status === "cancelled") return null;
  let facts = null;
  try { facts = await gatherFacts(sb, tenantId, proc); } catch { facts = null; }
  const stage = facts ? computeStage(facts) : { key: proc.stage || "conditions", blockers: [] };
  return { proc, facts, stage };
}

/**
 * @param {object} sb        service_role のクライアント
 * @param {string} tenantId
 * @param {{id:string}} employee  gw_employees の行
 * @returns {Promise<{journey:object, onboarding:object|null, careerFlow:object, career:object|null}>}
 */
export async function journeyForEmployee(sb, tenantId, employee, today = jstToday()) {
  const [careers, reviews, orders, signs, plans, onb] = await Promise.all([
    soft(sb.from("gw_employee_careers").select("*").eq("tenant_id", tenantId)
      .eq("employee_id", employee.id).eq("is_active", true)),
    soft(sb.from("gw_career_reviews").select("id, career_id, status, created_at").eq("tenant_id", tenantId)
      .eq("employee_id", employee.id).eq("status", "draft").limit(20)),
    soft(sb.from("gw_doc_orders").select("id, doc_kind, status, requested_at, created_at")
      .eq("tenant_id", tenantId).eq("employee_id", employee.id).limit(50)),
    soft(sb.from("gw_sign_requests").select("id, doc_kind, status, sent_at")
      .eq("tenant_id", tenantId).eq("employee_id", employee.id).order("sent_at", { ascending: false }).limit(50)),
    soft(sb.from("gw_growth_plans").select("id, status, start_date, end_date")
      .eq("tenant_id", tenantId).eq("employee_id", employee.id).order("start_date", { ascending: false }).limit(1)),
    onboardingOf(sb, tenantId, employee.id),
  ]);
  const career = careers?.[0] || null;
  const draft = (reviews || []).find((r) => !career || r.career_id === career.id) || null;
  const isContract = (r) => !r.doc_kind || CONTRACT_DOC_KINDS.includes(r.doc_kind);
  const careerFlow = flowOf({
    career, draft,
    orders: (orders || []).filter((o) => isContract(o) && OPEN_ORDER_STATUSES.includes(o.status)),
    signs: (signs || []).filter((x) => isContract(x) && x.status === "sent"),
    today,
  });
  const g = plans?.[0] || null;
  const journey = journeyOf({
    employee, procedure: onb?.proc || null, stage: onb?.stage || null, facts: onb?.facts || null,
    career, careerFlow, growth: g ? { status: g.status, end_date: g.end_date } : null,
    links: journeyLinks(employee.id, onb?.proc?.id), today,
  });
  return { journey, onboarding: onb, careerFlow, career };
}
