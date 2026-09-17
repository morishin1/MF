// GET /api/onboarding/status[?employeeId=…]
//
//   入社手続きの「共通で見えるもの」だけを返す。
//   本人・管理者・社労士が、同じ画面・同じ進み具合を見るための入口。
//
// ■ ここは進捗の骨組みだけ。中身は今までどおり別のAPIから
//
//   本人の入力・書類提出・同意        … api/onboarding/me.js（変えていない）
//   管理者の社内準備・マイナンバー等  … api/hr/index.js（変えていない）
//   社労士の労働条件確認・承認発行    … api/sign/orders.js（変えていない）
//
//   3つの画面を1つに統合するとは、書き込みの仕組みを作り直すことではない。
//   「同じ進み具合を、同じ場所で見られる」ことが目的。
//
// ■ 安全境界はRLS
//
//   admin()（service_role）は使わない。userClient(req) で、
//   ログインしているアカウントそのままの権限で読む。
//   本人の届出（住所・口座など）は gw_onboard_profiles の RLS が
//   「本人・人事・管理者だけ」に絞っているので、社労士には返らない。
//   書類は gw_procedure_files の RLS が「本人・人事・共有された項目の社労士」
//   だけを通す。ここでの if は「開けるかどうか」の入口だけで、
//   何が見えるかの境界ではない（lib/gw.js と同じ考え方）。

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient } from "../../lib/supabase.js";
import { resolveViewer, roleLabel } from "../../lib/onboard-viewer.js";
import { findProcedure } from "../../lib/onboard-kit.js";
import { computeSteps } from "../../lib/onboard-steps.js";
import { orientationState } from "../../lib/orientation.js";
import { consentState } from "../../lib/consent-docs.js";
import { missingFields } from "../../lib/onboard-form.js";
import { statusOf } from "../../lib/esign.js";
import { mynumberLabel } from "../../lib/mynumber.js";
import { logSensitive } from "../../lib/sensitive-log.js";

const SQL = "db/070_onboarding_stage.sql";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const q = new URL(req.url, "http://localhost").searchParams;
  const viewer = resolveViewer(ctx, q.get("employeeId"));
  if (!viewer.ok) {
    return json(res, viewer.reason === "no_employee" ? 403 : 403, {
      error: viewer.reason,
      hint: viewer.reason === "no_employee"
        ? "社員名簿にあなたの行がありません。管理者に登録を依頼してください。"
        : "他の方の入社手続きを開ける権限がありません。",
    });
  }
  const { role, employeeId } = viewer;

  const sb = userClient(req);
  // 読めない行は例外にせず、null／空で返ってくる想定（RLSが境界）。
  // ここでは「表そのものがまだ無い」だけを別に扱う
  const soft = async (fn) => {
    try {
      const r = await fn();
      return r?.error ? { data: null, error: r.error } : { data: r?.data ?? null, error: null };
    } catch (e) {
      return { data: null, error: e };
    }
  };

  const emp = await soft(() => sb.from("gw_employees")
    .select("id, display_name, email, department, position, employment_type, status, joined_on, manager_id")
    .eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!emp.data) {
    const hint = dbSetupHint(emp.error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 404, { error: "not_found", hint: "この方の情報を開けません。" });
  }

  const proc = await findProcedure(sb, employeeId, "onboarding");
  if (proc.error) {
    const hint = dbSetupHint(proc.error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_read_failed", detail: proc.error.message });
  }

  const [profileR, consentsR, signR, oriItemsR, oriChecksR, contractR, itemsR] = await Promise.all([
    soft(() => sb.from("gw_onboard_profiles").select("status").eq("employee_id", employeeId).maybeSingle()),
    soft(() => sb.from("gw_onboard_consents").select("kind, version, agreed_at")
      .eq("employee_id", employeeId)),
    soft(() => sb.from("gw_sign_requests")
      .select("id, title, doc_kind, status, due_on, signed_at, sent_at")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId).neq("status", "cancelled")
      .order("sent_at", { ascending: false }).limit(50)),
    soft(() => sb.from("gw_orientation_items")
      .select("id, title, kind, required, sort_order")
      .eq("tenant_id", ctx.tenantId).eq("active", true).limit(200)),
    soft(() => sb.from("gw_orientation_checks").select("item_id, confirmed_at")
      .eq("employee_id", employeeId)),
    soft(() => sb.from("gw_contracts").select("*")
      .eq("employee_id", employeeId).eq("status", "active")
      .order("created_at", { ascending: false }).limit(1)),
    proc.row
      ? soft(() => sb.from("gw_procedure_items")
          .select("id, item_key, title, category, owner, required, status, share_with_advisor")
          .eq("procedure_id", proc.row.id).order("sort_order").limit(200))
      : Promise.resolve({ data: [] }),
  ]);

  const [{ data: docs }] = await Promise.all([
    soft(() => sb.from("gw_consent_docs").select("*")
      .eq("tenant_id", ctx.tenantId).eq("status", "active").order("doc_key")),
  ]);

  const contracts = (signR.data || []).map((r) => ({
    id: r.id, title: r.title, kind: r.doc_kind, status: r.status, view: statusOf(r),
    dueOn: r.due_on, signedAt: r.signed_at, sentAt: r.sent_at,
  }));
  const orientation = orientationState(oriItemsR.data || [], oriChecksR.data || []);
  const consents = consentState(docs || [], consentsR.data || []);
  const items = itemsR.data || [];
  const pf = profileR.data || null;
  const c = (contractR.data || [])[0] || null;

  const documents = items
    .filter((i) => i.category === "document" && i.owner === "employee")
    .map((i) => ({
      key: i.item_key, title: i.title, required: i.required !== false, status: i.status,
    }));
  // 会社側準備（STEP5）。書類ではない・人事が持つ項目だけ。
  // 社労士セッションでは RLS が share_with_advisor の項目しか返さないので、
  // 既定のチェックリストでは自然に空になる（会社確認は社労士には見せない）
  const internalItems = items
    .filter((i) => i.owner === "hr" && i.category !== "document")
    .map((i) => ({ title: i.title, required: i.required !== false, status: i.status }));

  const steps = computeSteps({
    contracts, consents, orientation,
    profileStatus: pf?.status || null,
    missing: pf ? missingFields(pf) : [],
    documents: documents.map((d) => ({ ...d, collect: true })),
    internalItems: role === "advisor" ? undefined : internalItems,
    stage: proc.row?.stage || null,
    procedureStatus: proc.row?.status || null,
  });

  // 本人以外が開いたら、閲覧を残す（自分のぶんは残さない＝logSensitive側で判定）
  await logSensitive({
    tenantId: ctx.tenantId, actor: { id: user.id, name: ctx.employee.display_name },
    subjectId: employeeId, selfId: ctx.employee.id,
    kind: "profile", action: "view", target: `onboarding:${employeeId}`,
  });

  return json(res, 200, {
    role, roleLabel: roleLabel(role), employeeId,
    known: {
      name: emp.data.display_name,
      email: role === "self" || role === "admin" ? emp.data.email : null,
      department: emp.data.department, position: emp.data.position,
      employmentType: emp.data.employment_type,
      joinedOn: emp.data.joined_on,
      targetOn: proc.row?.target_on || null,
      // 給与は「本人のこと」として本人には出すが、社労士へは gw_contracts の
      // RLS がそもそも通さない（gw_is_internal_staff に labor_advisor は入らない）
      wage: c?.wage_amount
        ? `${c.wage_type || ""} ${Number(c.wage_amount).toLocaleString("ja-JP")}円`
        : null,
      contractPeriod: c?.fixed_term
        ? `有期（${c.period_from} 〜 ${c.period_to || "—"}）`
        : c ? "無期" : null,
      probation: c?.probation_months ? `${c.probation_months}か月` : null,
      weeklyHours: c?.weekly_hours ?? null,
    },
    procedureId: proc.row?.id || null,
    status: proc.row?.status || null,
    stage: proc.row?.stage || null,
    mynumber: mynumberLabel(proc.row?.mynumber_status),
    steps,
  });
}
