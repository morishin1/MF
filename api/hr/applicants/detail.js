// GET   /api/hr/applicants/detail?id=…  … 応募者1人ぶん（面談・タイムライン・合格通知つき）
// PATCH /api/hr/applicants/detail { id, ... } … 応募者本体を更新

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit, canDecideHire } from "../../../lib/gw.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { notify } from "../../../lib/notify.js";
import {
  normalizeApplicant, shapeApplicant, shapeOffer, shapeInterview, activeOffer, STAGE_LABEL, RANK_LABEL,
  RANKS, EVAL_ITEMS, EVAL_SCALE, INTERVIEW_KINDS, decisionMakerEmployeeIds,
} from "../../../lib/hr.js";

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

  const [{ data: interviews }, { data: timeline }, { data: offers }, { data: recruiter }, { data: interviewers }] = await Promise.all([
    sb.from("gw_hr_interviews").select("*").eq("applicant_id", id).order("created_at", { ascending: false }),
    sb.from("gw_hr_timeline").select("*").eq("applicant_id", id).order("occurred_at", { ascending: true }),
    sb.from("gw_hr_offers").select("*").eq("applicant_id", id).order("version", { ascending: false }),
    a.recruiter_id
      ? sb.from("gw_employees").select("display_name").eq("id", a.recruiter_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("gw_employees").select("id, display_name").eq("tenant_id", ctx.tenantId)
      .in("status", ["active", "invited"]).order("display_name").limit(300),
  ]);
  const interviewerName = new Map((interviewers || []).map((e) => [e.id, e.display_name]));

  // 直近の、まだ実施していない面談（NEXT ACTIONの「本日14:00 カジュアル面談」に使う）
  const nextInterview = (interviews || [])
    .filter((i) => !i.conducted_at && i.scheduled_at)
    .sort((x, y) => String(x.scheduled_at).localeCompare(String(y.scheduled_at)))[0] || null;
  // いま有効な合格通知（NEXT ACTIONの「送付：.../閲覧：...」に使う。README Stage 6）
  const current = activeOffer(offers);

  return json(res, 200, {
    applicant: {
      ...shapeApplicant(
        a,
        nextInterview && { scheduledAt: nextInterview.scheduled_at, kind: nextInterview.kind },
        current && { sentAt: current.sent_at, viewedAt: current.viewed_at, expiresAt: current.expires_at },
      ),
      recruiterName: recruiter?.display_name || null,
    },
    interviewers: interviewers || [],
    interviews: (interviews || []).map((i) => ({
      ...shapeInterview(i), interviewerName: interviewerName.get(i.interviewer_id) || null,
    })),
    // 評価UI・面談予定フォームの元。画面側で項目を持たない（ここが正）
    evalItems: EVAL_ITEMS, evalScale: EVAL_SCALE, ranks: RANKS, rankLabel: RANK_LABEL,
    interviewKinds: INTERVIEW_KINDS,
    timeline: (timeline || []).map((t) => ({
      id: t.id, eventKey: t.event_key, label: t.label, detail: t.detail, occurredAt: t.occurred_at,
    })),
    // 通知書は候補者専用URLの平文を含まないので、そのまま返してよい（tokenは無い）
    offers: (offers || []).map(shapeOffer),
  });
}

// 採用判断（社長面談のあとの内定・保留・見送り）そのものは、社長・管理者だけ
// （README Stage 4 §16）。Dランクの早期見送り（recruiter/hrでも可）とは別扱いにする。
// 両方とも decision 列を書くので、区別は「社長判断待ちから動かすかどうか」で見る
const CEO_DECISION_FIELDS = ["decision", "decisionNote", "holdReason", "holdNextStep"];

async function update(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const row = normalizeApplicant(body, { partial: true });
  if (row.error) return json(res, 400, row);
  if (!Object.keys(row.value).length) return json(res, 400, { error: "invalid_body", detail: "更新する項目がありません" });

  const { data: before } = await sb.from("gw_hr_applicants").select("stage, status, decision, name")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!before) return json(res, 404, { error: "not_found" });
  if (before.status === "ceo_decision_pending" && CEO_DECISION_FIELDS.some((k) => body[k] !== undefined)
      && !canDecideHire(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "採用判断は社長・管理者だけができます" });
  }

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
    // 社長推薦されたら、判断できる人（社長・管理者）へ知らせる。通知は増やしすぎない
    if (row.value.stage === "ceo_recommend") {
      const ab = admin();
      const targets = await decisionMakerEmployeeIds(ab, ctx.tenantId);
      await notify(targets.map((employeeId) => ({
        tenantId: ctx.tenantId, employeeId, kind: "hr", title: "社長推薦された候補者がいます",
        body: [data.name, data.recommend_note].filter(Boolean).join("\n"),
        link: "/hr/ceo-review.html", dedupeKey: `hr_recommend:${body.id}`,
      })));
    }
  }
  // 最終決定（社長推薦・見送り・保留）が動いたときも、値を直しただけとは分けて残す。
  // 「ランクだけで自動的に確定しない」の記録がここに残る
  if ("decision" in row.value && row.value.decision !== before.decision) {
    const label = row.value.decision === "rejected" ? "見送りを確定"
      : row.value.decision === "hired" ? "内定" : row.value.decision === "hold" ? "保留にした" : "決定を取り消した";
    const detail = row.value.decision === "hold" ? (data.hold_next_step || null)
      : data.rank ? `ランク${data.rank}` : null;
    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: body.id,
      event_key: `decision_${row.value.decision || "cleared"}`, label, detail, created_by: user.id,
    });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_update",
    target: `hr_applicant:${body.id}`, detail: { name: before.name, fields: Object.keys(row.value) },
  });

  return json(res, 200, { applicant: shapeApplicant(data) });
}
