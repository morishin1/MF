// GET   /api/hr/applicants/advance?applicantId=…
//         … admin-onboard.html（?applicantId=…）が、採用条件の事前入力を
//           サーバ側から取得する。給与・勤務条件はURLへ載せない（README Stage 8）
// POST  /api/hr/applicants/advance { applicantId }
//         … 本採用の手続きを始める（README Stage 8）。承諾済み（status=accepted）
//           の応募者だけ。二重に手続きが進まないよう advance_claimed_at で
//           一時的に確保する（事前入力の中身はGETで別途取得する）
// PATCH /api/hr/applicants/advance { applicantId, action }
//         "release"  … 手続きをやめる（クレームを外す。やり直せるように）
//         "complete" … 実際に社員（gw_employees、既存のapi/employees/onboard.js
//                       で作成済み）ができたら、応募者側を確定する
//                       （employee_id・status=done。クレームも外す）
//
// ■ ここでは社員を作らない
//   本採用の実処理（アカウント作成・契約・育成計画等）は、既存の
//   api/employees/onboard.js をそのまま使う（作り直さない。db/081の設計）。
//   このAPIは「承諾済み→admin-onboardへ安全につなぐ」ことだけをする
//
// ■ 権限
//   admin-onboard.html自体がKPLayout.init({roles:["admin","owner"]})で
//   社長・管理者だけに絞られているため、ここも同じ基準（canDecideHire）に揃える

import { json, readJson, methodNotAllowed } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canDecideHire } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { advancePrefill, isAdvanceClaimStale } from "../../../lib/hr.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canDecideHire(ctx)) return json(res, 403, { error: "forbidden", hint: "本採用へ進められるのは社長・管理者だけです" });

  const sb = userClient(req);

  if (req.method === "GET") return prefill(req, res, sb, ctx);
  if (req.method === "POST") return claim(req, res, sb, ctx, user);
  if (req.method === "PATCH") return act(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

async function findAdvancing(sb, ctx, applicantId) {
  const { data: a } = await sb.from("gw_hr_applicants").select("*")
    .eq("id", applicantId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!a) return { deny: { status: 404, body: { error: "not_found" } } };
  if (a.employee_id) return { deny: { status: 409, body: { error: "already_advanced", hint: "すでに本採用の手続きが完了しています" } } };
  if (a.status !== "accepted") {
    return { deny: { status: 409, body: { error: "invalid_state", hint: "承諾済みの応募者だけ、本採用へ進められます" } } };
  }
  return { applicant: a };
}

// admin-onboard.html?applicantId=… が読む、採用条件の事前入力だけ
// （給与・勤務条件そのものはここでサーバ側から返す。URLには載せない）
async function prefill(req, res, sb, ctx) {
  const applicantId = new URL(req.url, "http://localhost").searchParams.get("applicantId");
  if (!applicantId) return json(res, 400, { error: "invalid_query", required: ["applicantId"] });

  const found = await findAdvancing(sb, ctx, applicantId);
  if (found.deny) return json(res, found.deny.status, found.deny.body);

  return json(res, 200, { applicantId: found.applicant.id, prefill: advancePrefill(found.applicant) });
}

async function claim(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.applicantId) return json(res, 400, { error: "invalid_body", required: ["applicantId"] });

  const found = await findAdvancing(sb, ctx, body.applicantId);
  if (found.deny) return json(res, found.deny.status, found.deny.body);
  const a = found.applicant;

  // 自分（か誰か）がすでに処理中で、まだ有効なクレームなら、
  // 二重にロックし直さず、そのまま続きを渡す（同じ人のやり直しを邪魔しない）
  if (a.advance_claimed_at && !isAdvanceClaimStale(a.advance_claimed_at)) {
    return json(res, 200, { applicantId: a.id, resumed: true });
  }

  const now = new Date().toISOString();
  let q = sb.from("gw_hr_applicants").update({ advance_claimed_at: now })
    .eq("id", a.id).eq("tenant_id", ctx.tenantId);
  q = a.advance_claimed_at ? q.eq("advance_claimed_at", a.advance_claimed_at) : q.is("advance_claimed_at", null);
  const { data, error } = await q.select("id").maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 409, { error: "conflict", hint: "直前に手続きが始まりました。もう一度お試しください" });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_advance_claim",
    target: `hr_applicant:${a.id}`, detail: {},
  });
  return json(res, 200, { applicantId: a.id, resumed: false });
}

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.applicantId) return json(res, 400, { error: "invalid_body", required: ["applicantId"] });

  if (body.action === "release") return release(res, sb, ctx, user, body);
  if (body.action === "complete") return complete(res, sb, ctx, user, body);
  return json(res, 400, { error: "unknown_action" });
}

async function release(res, sb, ctx, user, body) {
  const { data, error } = await sb.from("gw_hr_applicants")
    .update({ advance_claimed_at: null })
    .eq("id", body.applicantId).eq("tenant_id", ctx.tenantId).eq("status", "accepted")
    .select("id").maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_advance_release",
    target: `hr_applicant:${body.applicantId}`, detail: {},
  });
  return json(res, 200, { ok: true });
}

async function complete(res, sb, ctx, user, body) {
  if (!body?.employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });

  const { data: a } = await sb.from("gw_hr_applicants").select("id, name, employee_id")
    .eq("id", body.applicantId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!a) return json(res, 404, { error: "not_found" });
  if (a.employee_id) return json(res, 409, { error: "already_advanced" });

  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_hr_applicants")
    .update({ employee_id: body.employeeId, status: "done", advance_claimed_at: null, updated_at: now })
    .eq("id", a.id).eq("tenant_id", ctx.tenantId).is("employee_id", null)
    .select("id").maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 409, { error: "already_advanced" });

  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: a.id, event_key: "advanced",
    label: "本採用（社員登録）完了", created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_advance_complete",
    target: `hr_applicant:${a.id}`, detail: { employeeId: body.employeeId },
  });
  return json(res, 200, { ok: true, status: "done" });
}
