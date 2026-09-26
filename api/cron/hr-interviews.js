// GET /api/cron/hr-interviews
// 1時間おきにまわす。面談が終わって一定時間たっても評価が未入力なら、
// 面談担当（いなければ採用担当）へ「面談結果を入力してください」を通知する。
//
// ■ 新しい通知基盤は作らない（README §10・§11）
//   既存の gw_notifications（kind: 'hr'）だけを使う。gw_tasks は増やさない
//   （/hr の中に既にNEXT ACTIONという「やること」の置き場があるため）。
//
// ■ 二重送信しない
//   dedupe_key を面談IDにしておき、ignoreDuplicates で流す。
//   一度送った面談は、評価が入るまで何度cronが回っても増えない
//   （読んだ／読んでいないに関わらず、再通知で未読へ戻さない）。
//
// 認証: CRON_SECRET があれば Authorization: Bearer <secret> を要求する。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { interviewKindLabel } from "../../lib/hr.js";

const EVAL_GRACE_MS = 2 * 3600 * 1000; // 実施から2時間たっても未評価なら知らせる
const MAX_INTERVIEWS = 300;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const sb = admin();
  const before = new Date(Date.now() - EVAL_GRACE_MS).toISOString();

  const { data: rows, error } = await sb.from("gw_hr_interviews")
    .select("id, tenant_id, applicant_id, kind, conducted_at, interviewer_id")
    .not("conducted_at", "is", null)
    .is("rank", null)
    .lt("conducted_at", before)
    .limit(MAX_INTERVIEWS);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  const list = rows || [];
  if (!list.length) return json(res, 200, { ok: true, checked: 0, notified: 0 });

  const applicantIds = [...new Set(list.map((i) => i.applicant_id))];
  const { data: applicants } = await sb.from("gw_hr_applicants")
    .select("id, name, recruiter_id").in("id", applicantIds);
  const applicantOf = new Map((applicants || []).map((a) => [a.id, a]));

  const notifyRows = [];
  for (const i of list) {
    const a = applicantOf.get(i.applicant_id);
    if (!a) continue;
    const target = i.interviewer_id || a.recruiter_id;
    if (!target) continue;
    notifyRows.push({
      tenantId: i.tenant_id, employeeId: target, kind: "hr",
      title: "面談結果が未入力です",
      body: `${a.name}\n${interviewKindLabel(i.kind)}`,
      link: `/hr/applicants.html?id=${i.applicant_id}`,
      dedupeKey: `hr_interview_eval:${i.id}`,
    });
  }

  const { created } = await notify(notifyRows, { replace: false });
  return json(res, 200, { ok: true, checked: list.length, notified: created });
}
