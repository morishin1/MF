// GET   /api/hr/applicants/detail?id=…  … 応募者1人ぶん（面談・タイムライン・合格通知つき）
// PATCH /api/hr/applicants/detail { id, ... } … 応募者本体を更新

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { normalizeApplicant, shapeApplicant, offerStatus, STAGE_LABEL } from "../../../lib/hr.js";

const SQL = "db/081_hr_recruiting.sql";
const FIELDS = "id, tenant_id, name, email, phone, profile_url, source, job_title, "
  + "stage, status, rank, recruiter_id, decision, decision_due_on, "
  + "employment_type, contract_type, contract_end_date, join_date, probation_months, "
  + "wage_type, wage_amount, weekly_hours, work_location, employee_id, note, created_at, updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return one(req, res, sb, ctx);
  if (req.method === "PATCH") return update(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "PATCH"]);
}

async function one(req, res, sb, ctx) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const { data: a, error } = await sb.from("gw_hr_applicants").select(FIELDS)
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  if (!a) return json(res, 404, { error: "not_found" });

  const [{ data: interviews }, { data: timeline }, { data: offers }, { data: recruiter }] = await Promise.all([
    sb.from("gw_hr_interviews").select("*").eq("applicant_id", id).order("created_at", { ascending: false }),
    sb.from("gw_hr_timeline").select("*").eq("applicant_id", id).order("occurred_at", { ascending: true }),
    sb.from("gw_hr_offers").select("*").eq("applicant_id", id).order("version", { ascending: false }),
    a.recruiter_id
      ? sb.from("gw_employees").select("display_name").eq("id", a.recruiter_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return json(res, 200, {
    applicant: { ...shapeApplicant(a), recruiterName: recruiter?.display_name || null },
    interviews: (interviews || []).map((i) => ({
      id: i.id, kind: i.kind, scheduledAt: i.scheduled_at, conductedAt: i.conducted_at,
      interviewerId: i.interviewer_id, recordingUrl: i.recording_url, scores: i.scores,
      rank: i.rank, recommendReason: i.recommend_reason, notes: i.notes,
      nextDueOn: i.next_due_on, createdAt: i.created_at,
    })),
    timeline: (timeline || []).map((t) => ({
      id: t.id, eventKey: t.event_key, label: t.label, detail: t.detail, occurredAt: t.occurred_at,
    })),
    // 通知書は候補者専用URLの平文を含まないので、そのまま返してよい（tokenは無い）
    offers: (offers || []).map((o) => ({
      id: o.id, version: o.version, status: offerStatus(o),
      jobTitle: o.job_title, employmentType: o.employment_type, contractType: o.contract_type,
      contractEndDate: o.contract_end_date, joinDate: o.join_date, probationMonths: o.probation_months,
      wageType: o.wage_type, wageAmount: o.wage_amount, weeklyHours: o.weekly_hours,
      workLocation: o.work_location, messageToCandidate: o.message_to_candidate, respondBy: o.respond_by,
      sentAt: o.sent_at, viewedAt: o.viewed_at, acceptedAt: o.accepted_at,
      declinedAt: o.declined_at, declineReason: o.decline_reason, expiresAt: o.expires_at,
    })),
  });
}

async function update(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const row = normalizeApplicant(body, { partial: true });
  if (row.error) return json(res, 400, row);
  if (!Object.keys(row.value).length) return json(res, 400, { error: "invalid_body", detail: "更新する項目がありません" });

  const { data: before } = await sb.from("gw_hr_applicants").select("stage, status, name")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!before) return json(res, 404, { error: "not_found" });

  const { data, error } = await sb.from("gw_hr_applicants")
    .update({ ...row.value, updated_at: new Date().toISOString() })
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).select(FIELDS).maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });

  // ステージが動いたときだけ、選考タイムラインに足す（値を直しただけでは足さない）
  if (row.value.stage && row.value.stage !== before.stage) {
    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: body.id,
      event_key: `stage_${row.value.stage}`, label: STAGE_LABEL[row.value.stage] || row.value.stage,
      detail: data.rank ? `ランク${data.rank}` : null, created_by: user.id,
    });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_update",
    target: `hr_applicant:${body.id}`, detail: { name: before.name, fields: Object.keys(row.value) },
  });

  return json(res, 200, { applicant: shapeApplicant(data) });
}
