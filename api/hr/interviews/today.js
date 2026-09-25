// GET /api/hr/interviews/today … 今日予定されている面談（HRダッシュボードの「今日の面談」）
//
// 時刻・氏名・応募職種・面談担当・現在ステータスだけを返す。押すと応募者詳細へ

import { json, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { interviewKindLabel, STATUS_LABEL } from "../../../lib/hr.js";

const SQL = "db/081_hr_recruiting.sql";
const APPLICANT_FIELDS = "id, name, job_title, status";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  const jstToday = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const from = `${jstToday}T00:00:00+09:00`;
  const to = `${jstToday}T23:59:59+09:00`;

  const { data: interviews, error } = await sb.from("gw_hr_interviews")
    .select("id, applicant_id, kind, scheduled_at, interviewer_id, conducted_at")
    .eq("tenant_id", ctx.tenantId)
    .gte("scheduled_at", from).lte("scheduled_at", to)
    .order("scheduled_at", { ascending: true }).limit(200);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { interviews: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const applicantIds = [...new Set((interviews || []).map((i) => i.applicant_id))];
  const interviewerIds = [...new Set((interviews || []).map((i) => i.interviewer_id).filter(Boolean))];
  const [{ data: applicants }, { data: interviewers }] = await Promise.all([
    applicantIds.length
      ? sb.from("gw_hr_applicants").select(APPLICANT_FIELDS).in("id", applicantIds)
      : Promise.resolve({ data: [] }),
    interviewerIds.length
      ? sb.from("gw_employees").select("id, display_name").in("id", interviewerIds)
      : Promise.resolve({ data: [] }),
  ]);
  const applicantOf = new Map((applicants || []).map((a) => [a.id, a]));
  const interviewerName = new Map((interviewers || []).map((e) => [e.id, e.display_name]));

  return json(res, 200, {
    interviews: (interviews || []).map((i) => {
      const a = applicantOf.get(i.applicant_id);
      return {
        id: i.id, applicantId: i.applicant_id, kind: i.kind, kindLabel: interviewKindLabel(i.kind),
        scheduledAt: i.scheduled_at, done: Boolean(i.conducted_at),
        interviewerId: i.interviewer_id, interviewerName: interviewerName.get(i.interviewer_id) || null,
        name: a?.name || "（削除済み）", jobTitle: a?.job_title || "",
        status: a?.status || "", statusLabel: a ? (STATUS_LABEL[a.status] || a.status) : "",
      };
    }),
  });
}
