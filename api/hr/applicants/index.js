// GET  /api/hr/applicants          … 応募者一覧（ダッシュボード・応募者一覧・CEO REVIEWで共通利用）
// POST /api/hr/applicants { name, jobTitle, source, ... } … 応募者を追加
//
// ダッシュボード・採用ファネル・通知の元ネタは、すべてこの一覧から
// 画面側で組み立てる（別に集計テーブルは作らない。README「State Management」の方針と同じ）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { normalizeApplicant, shapeApplicant } from "../../../lib/hr.js";

const SQL = "db/081_hr_recruiting.sql";
const FIELDS = "id, tenant_id, name, email, phone, profile_url, source, job_title, "
  + "stage, status, rank, recruiter_id, decision, decision_due_on, "
  + "recommend_note, decision_note, hold_reason, hold_next_step, "
  + "employment_type, contract_type, contract_end_date, join_date, probation_months, "
  + "wage_type, wage_amount, weekly_hours, work_location, employee_id, advance_claimed_at, note, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST") return create(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function list(req, res, sb, ctx) {
  const { data, error } = await sb.from("gw_hr_applicants").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(1000);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { applicants: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const ids = (data || []).map((a) => a.id);
  const recruiterIds = [...new Set((data || []).map((a) => a.recruiter_id).filter(Boolean))];
  const [{ data: recruiters }, { data: interviewCounts }] = await Promise.all([
    recruiterIds.length
      ? sb.from("gw_employees").select("id, display_name").in("id", recruiterIds)
      : Promise.resolve({ data: [] }),
    ids.length
      ? sb.from("gw_hr_interviews").select("applicant_id").in("applicant_id", ids).limit(5000)
      : Promise.resolve({ data: [] }),
  ]);
  const recruiterName = new Map((recruiters || []).map((e) => [e.id, e.display_name]));
  const interviewCount = new Map();
  for (const i of interviewCounts || []) {
    interviewCount.set(i.applicant_id, (interviewCount.get(i.applicant_id) || 0) + 1);
  }

  return json(res, 200, {
    applicants: (data || []).map((a) => ({
      ...shapeApplicant(a),
      recruiterName: recruiterName.get(a.recruiter_id) || null,
      interviewCount: interviewCount.get(a.id) || 0,
    })),
  });
}

async function create(req, res, sb, ctx, user) {
  const body = await readJson(req);
  const row = normalizeApplicant(body);
  if (row.error) return json(res, 400, row);

  const { data, error } = await sb.from("gw_hr_applicants")
    .insert({ ...row.value, tenant_id: ctx.tenantId, created_by: user.id })
    .select(FIELDS).single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: data.id, event_key: "applied", label: "応募", created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_create",
    target: `hr_applicant:${data.id}`, detail: { name: data.name, jobTitle: data.job_title },
  });

  return json(res, 200, { applicant: shapeApplicant(data) });
}
