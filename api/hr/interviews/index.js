// POST  /api/hr/interviews { applicantId, kind, scheduledAt, interviewerId, meetingUrl }
//         … 面談を予定する。応募者の状態を「面談予定」へ進める
// PATCH /api/hr/interviews { id, action }
//         "conduct"  … 実施済みにする。応募者の状態を「評価入力待ち」へ
//         "evaluate" … 5項目評価・ランク・所感を保存。ランクから対応ステータスを機械的に進める
//                       （ただし社長推薦・見送りの最終確定はここでは行わない。README §5・§7）
//         "update"   … 日時・面談担当・URLだけを直す（状態は動かさない）
//
// ■ 同じ面談を二重登録しない
//   同じ種別（カジュアル／社長）の、まだ実施していない面談が既にあれば断る。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit } from "../../../lib/gw.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { notify } from "../../../lib/notify.js";
import {
  normalizeInterview, shapeInterview, nextStatusFromRank, interviewKindLabel, RANK_LABEL,
  decisionMakerEmployeeIds,
} from "../../../lib/hr.js";

const SQL = "db/081_hr_recruiting.sql・083_hr_interview_meeting_url.sql";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "POST") return create(req, res, sb, ctx, user);
  if (req.method === "PATCH") return act(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["POST", "PATCH"]);
}

async function create(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.applicantId) return json(res, 400, { error: "invalid_body", required: ["applicantId"] });
  const row = normalizeInterview(body);
  if (row.error) return json(res, 400, row);

  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, name, stage, status")
    .eq("id", body.applicantId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant) return json(res, 404, { error: "not_found" });

  const { data: open } = await sb.from("gw_hr_interviews").select("id")
    .eq("applicant_id", applicant.id).eq("kind", row.value.kind).is("conducted_at", null).limit(1);
  if (open?.length) {
    return json(res, 409, { error: "already_scheduled", hint: "すでに予定されている面談があります" });
  }

  const { data, error } = await sb.from("gw_hr_interviews")
    .insert({ ...row.value, tenant_id: ctx.tenantId, applicant_id: applicant.id, created_by: user.id })
    .select("*").single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  const now = new Date().toISOString();
  const newStage = row.value.kind === "ceo" ? "ceo_interview" : "casual_interview";
  await sb.from("gw_hr_applicants")
    .update({ status: "interview_scheduled", stage: newStage, updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", ctx.tenantId);

  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "interview_scheduled",
    label: `${interviewKindLabel(row.value.kind)}を予定`,
    detail: row.value.scheduled_at ? fmtDateTime(row.value.scheduled_at) : null, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.interview_schedule",
    target: `hr_interview:${data.id}`, detail: { applicantId: applicant.id, kind: row.value.kind },
  });

  // 社長面談が入ったら、判断できる人へ知らせる（通知は増やしすぎない。ここと判断待ちの2つだけ）
  if (row.value.kind === "ceo") {
    const targets = await decisionMakerEmployeeIds(admin(), ctx.tenantId);
    await notify(targets.map((employeeId) => ({
      tenantId: ctx.tenantId, employeeId, kind: "hr", title: "社長面談が入りました",
      body: [applicant.name, row.value.scheduled_at ? fmtDateTime(row.value.scheduled_at) : null].filter(Boolean).join("\n"),
      link: "hr-ceo-review.html", dedupeKey: `hr_ceo_meeting:${data.id}`,
    })));
  }

  return json(res, 200, { interview: shapeInterview(data) });
}

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const { data: iv } = await sb.from("gw_hr_interviews").select("*")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!iv) return json(res, 404, { error: "not_found" });

  if (body.action === "conduct") return conduct(res, sb, ctx, user, iv, body);
  if (body.action === "evaluate") return evaluate(res, sb, ctx, user, iv, body);
  if (body.action === "update") return updateInterview(res, sb, ctx, user, iv, body);
  return json(res, 400, { error: "unknown_action" });
}

async function conduct(res, sb, ctx, user, iv, body) {
  const now = new Date().toISOString();
  const conductedAt = body.conductedAt || now;

  const { data, error } = await sb.from("gw_hr_interviews")
    .update({ conducted_at: conductedAt }).eq("id", iv.id).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  // カジュアル面談は5項目評価待ちへ。社長面談は5項目評価をせず、
  // そのまま採用判断待ちへ（README Stage 4 §7）
  const nextStatus = iv.kind === "ceo" ? "ceo_decision_pending" : "eval_pending";
  await sb.from("gw_hr_applicants").update({ status: nextStatus, updated_at: now })
    .eq("id", iv.applicant_id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: iv.applicant_id, event_key: "interview_done",
    label: `${interviewKindLabel(iv.kind)}実施`, created_by: user.id,
  });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.interview_conduct", target: `hr_interview:${iv.id}` });

  // 社長面談が終わったら、判断できる人へ知らせる
  if (iv.kind === "ceo") {
    const { data: applicant } = await sb.from("gw_hr_applicants").select("name")
      .eq("id", iv.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
    const targets = await decisionMakerEmployeeIds(admin(), ctx.tenantId);
    await notify(targets.map((employeeId) => ({
      tenantId: ctx.tenantId, employeeId, kind: "hr", title: "採用判断をしてください",
      body: applicant?.name || null, link: "hr-ceo-review.html", dedupeKey: `hr_ceo_decision:${iv.id}`,
    })));
  }

  return json(res, 200, { interview: shapeInterview(data), status: nextStatus });
}

async function evaluate(res, sb, ctx, user, iv, body) {
  const row = normalizeInterview(body, { partial: true });
  if (row.error) return json(res, 400, row);
  if (!row.value.rank) return json(res, 400, { error: "invalid_body", detail: "ランクを選んでください" });

  const { data, error } = await sb.from("gw_hr_interviews")
    .update(row.value).eq("id", iv.id).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  const nextStatus = nextStatusFromRank(row.value.rank);
  const now = new Date().toISOString();
  const patch = { rank: row.value.rank, status: nextStatus, updated_at: now };
  if (row.value.next_due_on !== undefined) patch.decision_due_on = row.value.next_due_on;

  await sb.from("gw_hr_applicants").update(patch).eq("id", iv.applicant_id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert([
    { tenant_id: ctx.tenantId, applicant_id: iv.applicant_id, event_key: "evaluated",
      label: "評価入力", created_by: user.id },
    { tenant_id: ctx.tenantId, applicant_id: iv.applicant_id, event_key: `rank_${row.value.rank}`,
      label: `ランク${row.value.rank}`, detail: RANK_LABEL[row.value.rank], created_by: user.id },
  ]);
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.interview_evaluate",
    target: `hr_interview:${iv.id}`, detail: { rank: row.value.rank, nextStatus },
  });

  return json(res, 200, { interview: shapeInterview(data), status: nextStatus });
}

async function updateInterview(res, sb, ctx, user, iv, body) {
  const row = normalizeInterview(body, { partial: true });
  if (row.error) return json(res, 400, row);
  if (!Object.keys(row.value).length) return json(res, 400, { error: "invalid_body", detail: "更新する項目がありません" });

  const { data, error } = await sb.from("gw_hr_interviews")
    .update(row.value).eq("id", iv.id).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  return json(res, 200, { interview: shapeInterview(data) });
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
