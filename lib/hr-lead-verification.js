import { createHash } from "node:crypto";
import { isLeftEmployee } from "./left-gate.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = "[TEST] 無限道場 配信確認（対応不要）";
const failure = (error, status = 503) => ({ ok: false, error, status });

/** A single explicitly approved run. Never infer recipients or enable Preview. */
export function verificationConfig(env = process.env) {
  const runId = env.MUGENDOJO_VERIFY_RUN_ID || "";
  const ownerUserId = env.MUGENDOJO_VERIFY_OWNER_USER_ID || "";
  const tenantId = env.HR_LEAD_TENANT_ID || "";
  const recipient = env.MUGENDOJO_VERIFY_RECIPIENT || "";
  if (env.VERCEL_ENV !== "production" || !UUID.test(runId) || !UUID.test(ownerUserId)
      || !UUID.test(tenantId) || recipient !== recipient.trim().toLowerCase()
      || recipient.length > 200 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(recipient)
      || (env.MUGENDOJO_LEAD_SECRET || "").length < 32) return null;
  return { runId, ownerUserId, tenantId, recipient };
}

export function notificationIdFor(runId) {
  const h = createHash("sha256").update(`mugendojo-verification-notification:${runId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function matches(row, cfg) {
  return row?.id === cfg.runId && row.tenant_id === cfg.tenantId
    && row.email === cfg.recipient && row.name === NAME && row.lead_category === "mugendojo"
    && row.attribution?.verification_run_id === cfg.runId
    && row.attribution?.verification_owner_user_id === cfg.ownerUserId;
}

async function evidence(sb, cfg, employeeId, result) {
  const id = notificationIdFor(cfg.runId);
  const { data, error } = await sb.from("gw_notifications").select("id, tenant_id, employee_id, dedupe_key")
    .eq("id", id).maybeSingle();
  if (error || !data || data.tenant_id !== cfg.tenantId || data.employee_id !== employeeId
      || data.dedupe_key !== `hr_lead_verification:${cfg.runId}`) {
    return { ...failure("notification_unconfirmed", 409), applicantId: cfg.runId, notificationIds: [] };
  }
  return { ok: true, verification: true, runId: cfg.runId, applicantId: cfg.runId, notificationIds: [id], result };
}

/** Insert-only; replay observes evidence but never updates applicants or notifications. */
export async function verifyOneLead(sb, cfg, body) {
  if (!cfg) return failure("verification_disabled");
  if (!body || body.verification !== true || body.runId !== cfg.runId
      || body.ownerUserId !== cfg.ownerUserId || body.recipient !== cfg.recipient
      || Object.keys(body).sort().join(",") !== "ownerUserId,recipient,runId,verification") {
    return failure("verification_mismatch", 400);
  }
  try {
    const { data: employee, error: eerr } = await sb.from("gw_employees")
      .select("id, status, left_on").eq("tenant_id", cfg.tenantId).eq("user_id", cfg.ownerUserId).maybeSingle();
    if (eerr) return failure("owner_unconfirmed");
    if (!employee || !["active", "leaving"].includes(employee.status) || isLeftEmployee(employee)) return failure("forbidden", 403);
    const { data: grant, error: gerr } = await sb.from("gw_role_grants").select("employee_id")
      .eq("tenant_id", cfg.tenantId).eq("employee_id", employee.id).eq("role", "owner").maybeSingle();
    if (gerr) return failure("owner_unconfirmed");
    if (!grant) return failure("forbidden", 403);

    const { data: existing, error: rerr } = await sb.from("gw_hr_applicants").select("*").eq("id", cfg.runId).maybeSingle();
    if (rerr) return failure("applicant_unconfirmed");
    if (existing) return matches(existing, cfg) ? await evidence(sb, cfg, employee.id, "replayed") : failure("applicant_conflict", 409);
    // Never touch or merge a real applicant, even if the approved mailbox was previously used.
    const literal = cfg.recipient.replace(/[\\%_]/g, (s) => `\\${s}`);
    const { data: sameEmail, error: serr } = await sb.from("gw_hr_applicants").select("id")
      .eq("tenant_id", cfg.tenantId).ilike("email", literal).limit(1);
    if (serr) return failure("applicant_unconfirmed");
    if (sameEmail?.length) return failure("recipient_already_used", 409);
    const { error: insertError } = await sb.from("gw_hr_applicants").insert({
      id: cfg.runId, tenant_id: cfg.tenantId, name: NAME, email: cfg.recipient,
      source: "無限道場 配信確認 TEST", job_title: "無限道場 配信確認 TEST（対応不要）",
      lead_category: "mugendojo", stage: "applied", status: "scheduling", recruiter_id: null,
      attribution: { verification_run_id: cfg.runId, verification_owner_user_id: cfg.ownerUserId,
        submission_ids: [cfg.runId], synthetic: true },
      lead_profile: { challenge_text: "合成テスト。実際の申込みではありません。連絡・面談対応は不要です。" },
    });
    if (insertError) {
      if (insertError.code !== "23505") return failure("applicant_write_unconfirmed");
      // Race loser may only observe the winner; never enter normal intake/update.
      const { data: winner, error } = await sb.from("gw_hr_applicants").select("*").eq("id", cfg.runId).maybeSingle();
      if (error) return failure("applicant_unconfirmed");
      return matches(winner, cfg) ? await evidence(sb, cfg, employee.id, "replayed") : failure("applicant_conflict", 409);
    }
    const { error: nerr } = await sb.from("gw_notifications").insert({
      id: notificationIdFor(cfg.runId), tenant_id: cfg.tenantId, employee_id: employee.id,
      kind: "hr", title: NAME, body: "合成テスト1件の受信確認。実際の申込みではありません。",
      link: `/hr/applicants.html?category=mugendojo&id=${cfg.runId}`,
      dedupe_key: `hr_lead_verification:${cfg.runId}`,
    });
    if (nerr) return { ...failure("notification_write_unconfirmed"), applicantId: cfg.runId, notificationIds: [] };
    return await evidence(sb, cfg, employee.id, "created");
  } catch {
    // Do not return/log database, credential or transport exception text.
    return failure("verification_unconfirmed");
  }
}
