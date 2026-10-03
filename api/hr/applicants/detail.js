// GET   /api/hr/applicants/detail?id=…  … 応募者1人ぶん（面談・タイムライン・合格通知つき）
// PATCH /api/hr/applicants/detail { id, ... } … 応募者本体を更新

import { checkRecruiter } from "../../../lib/hr-recruiter.js";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit, canDecideHire, canSeeSalary } from "../../../lib/gw.js";
import { guardSalaryOutput, dropSalaryInput, withoutColumns } from "../../../lib/salary.js";
import { paySplit, splitWage, attachPay, savePay, payFailed } from "../../../lib/hr-pay.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { notify } from "../../../lib/notify.js";
import {
  normalizeApplicant, shapeApplicant, shapeOffer, shapeInterview, activeOffer, STAGE_LABEL, RANK_LABEL,
  RANKS, EVAL_ITEMS, EVAL_SCALE, INTERVIEW_KINDS, decisionMakerEmployeeIds, schedulingUrlFor, pickNextInterview,
  STATUSES, STATUS_LABEL, STATUS_OPTIONS, statusChangeWarnings,
} from "../../../lib/hr.js";
import { contactStatusOf } from "../../../lib/hr-messages.js";

const SQL = "db/081_hr_recruiting.sql";
// 給与を専用の表（gw_hr_pay）へ分けている設定（HR_PAY_SPLIT=1）では、元の列は読まない
const columns = (salary) => (salary && !paySplit() ? FIELDS : withoutColumns(FIELDS));
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
  // 給与は、見られる人（lib/gw.js canSeeSalary）にだけ返す。採用担当・責任者には返さない
  const salary = guardSalaryOutput(res, canSeeSalary(ctx));

  if (req.method === "GET") return one(req, res, sb, ctx, salary);
  if (req.method === "PATCH") return update(req, res, sb, ctx, user, salary);
  return methodNotAllowed(res, ["GET", "PATCH"]);
}

async function one(req, res, sb, ctx, salary) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const { data: a, error } = await sb.from("gw_hr_applicants").select(columns(salary))
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
  // 給与を見られる人にだけ、給与を足す（分けていない設定なら何もしない）
  if (salary) {
    await attachPay(ctx.tenantId, a, "applicant");
    await attachPay(ctx.tenantId, offers || [], "offer");
  }

  // NEXT ACTION が指す面談（いまの選考段階の種類で、実施前・キャンセルでない、直近のもの）。
  // NEXT ACTIONの「本日 14:00 カジュアル面談」と「面談を実施済みにする」の対象（nextInterviewId）
  const nextInterview = pickNextInterview(a, interviews);
  // いま有効な合格通知（NEXT ACTIONの「送付：.../閲覧：...」に使う。README Stage 6）
  const current = activeOffer(offers);

  return json(res, 200, {
    applicant: {
      ...shapeApplicant(
        a,
        nextInterview && { id: nextInterview.id, scheduledAt: nextInterview.scheduled_at, kind: nextInterview.kind },
        current && { sentAt: current.sent_at, viewedAt: current.viewed_at, expiresAt: current.expires_at },
      ),
      recruiterName: recruiter?.display_name || null,
      // 本人への連絡状況（未連絡／連絡済み）。タイムラインの判断・連絡の記録から決める（lib/hr-messages.js）
      contact: contactStatusOf(a.decision, timeline),
    },
    interviewers: interviewers || [],
    interviews: (interviews || []).map((i) => ({
      ...shapeInterview(i), interviewerName: interviewerName.get(i.interviewer_id) || null,
    })),
    // 評価UI・面談予定フォームの元。画面側で項目を持たない（ここが正）
    evalItems: EVAL_ITEMS, evalScale: EVAL_SCALE, ranks: RANKS, rankLabel: RANK_LABEL,
    interviewKinds: INTERVIEW_KINDS,
    // 状態プルダウンの選択肢（lib/hr.js の STATUSES / STATUS_LABEL が正）
    statusOptions: STATUS_OPTIONS,
    // TimeRexの日程調整URL（環境変数未設定ならnull。README「TimeRex連携」指示書 §7）
    schedulingUrl: schedulingUrlFor(process.env.TIMEREX_CASUAL_INTERVIEW_URL, a.id),
    timeline: (timeline || []).map((t) => ({
      id: t.id, eventKey: t.event_key, label: t.label, detail: t.detail, occurredAt: t.occurred_at,
    })),
    // 通知書は候補者専用URLの平文を含まないので、そのまま返してよい（tokenは無い）
    offers: (offers || []).map((o) => shapeOffer(o)),
    // 給与の欄を出してよいか（画面の出し分け用。値そのものは、見られない人には返らない）
    salaryVisible: salary,
  });
}

// 採用判断（社長面談のあとの内定・保留・見送り）そのものは、社長・管理者だけ
// （README Stage 4 §16）。Dランクの早期見送り（recruiter/hrでも可）とは別扱いにする。
// 両方とも decision 列を書くので、区別は「社長判断待ちから動かすかどうか」で見る
const CEO_DECISION_FIELDS = ["decision", "decisionNote", "holdReason", "holdNextStep"];

async function update(req, res, sb, ctx, user, salary) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });
  if (body.action === "setStatus") return setStatus(res, sb, ctx, user, body);
  // 給与を見られない人は、給与の欄を書き換えられない（見えていない値を上書きしてしまわないため）
  const row = normalizeApplicant(salary ? body : dropSalaryInput(body), { partial: true });
  if (row.error) return json(res, 400, row);
  if (!Object.keys(row.value).length) return json(res, 400, { error: "invalid_body", detail: "更新する項目がありません" });
  if ("recruiter_id" in row.value) {
    const rc = await checkRecruiter(sb, ctx.tenantId, row.value.recruiter_id);
    if (!rc.ok) return json(res, 400, rc);
  }

  const { data: before } = await sb.from("gw_hr_applicants").select("stage, status, decision, name, recruiter_id")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!before) return json(res, 404, { error: "not_found" });
  if (before.status === "ceo_decision_pending" && CEO_DECISION_FIELDS.some((k) => body[k] !== undefined)
      && !canDecideHire(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "採用判断は社長・管理者だけができます" });
  }

  const { data, error } = await sb.from("gw_hr_applicants")
    .update({ ...splitWage(row.value).base, updated_at: new Date().toISOString() })
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).select(columns(salary)).maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });
  // 給与は、分けている設定なら専用の表へ（見られない人の入力は、ここまで来ない）
  try {
    await savePay(ctx.tenantId, { applicantId: body.id, wage: splitWage(row.value).wage });
    if (salary) await attachPay(ctx.tenantId, data, "applicant");
  } catch (e) {
    return payFailed(res, e);
  }

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

  // 担当が変わったときは、選考の履歴に残す（誰の担当だったかを後から追えるように）
  if ("recruiter_id" in row.value && row.value.recruiter_id !== before.recruiter_id) {
    const { data: who } = row.value.recruiter_id
      ? await sb.from("gw_employees").select("display_name").eq("id", row.value.recruiter_id).maybeSingle()
      : { data: null };
    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: body.id, event_key: "recruiter_changed",
      label: "担当を変更", detail: who?.display_name || "未定", created_by: user.id,
    });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_update",
    target: `hr_applicant:${body.id}`, detail: { name: before.name, fields: Object.keys(row.value) },
  });

  return json(res, 200, { applicant: shapeApplicant(data) });
}

// ---- 状態（status）の手動変更 -------------------------------------------------------
// PATCH { id, action: "setStatus", status, dryRun?, acknowledgeWarnings? }
//   dryRun=true        … 変更せず、注意（warnings）だけ返す。画面の確認ダイアログに出す
//   注意があるのに acknowledgeWarnings が無ければ 409（画面で確認してから送り直す）
// 変えるのは status だけ。選考段階（stage）・面談（日時・取消・Meet URL）は変えない
// （TimeRex 連携の面談は TimeRex が正）。必ず選考タイムラインと監査ログに残す（誰が・何から何へ）。
async function setStatus(res, sb, ctx, user, body) {
  const to = body.status;
  if (!STATUSES.includes(to)) return json(res, 400, { error: "invalid_body", detail: "status が不正です" });

  const { data: before } = await sb.from("gw_hr_applicants").select(FIELDS)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!before) return json(res, 404, { error: "not_found" });
  if (before.status === to) return json(res, 400, { error: "no_change", hint: "いまと同じ状態です" });
  // 社長判断待ちから動かすのは採用判断と同じ重さ。社長・管理者だけ
  if ((before.status === "ceo_decision_pending" || to === "ceo_decision_pending") && !canDecideHire(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "社長判断待ちの状態を変えられるのは社長・管理者だけです" });
  }

  const { data: interviews } = await sb.from("gw_hr_interviews")
    .select("id, kind, scheduled_at, conducted_at, canceled_at, timerex_event_id")
    .eq("applicant_id", body.id).eq("tenant_id", ctx.tenantId);
  const warnings = statusChangeWarnings(before, interviews, to);
  const labels = { from: STATUS_LABEL[before.status] || before.status, to: STATUS_LABEL[to] };
  if (body.dryRun) return json(res, 200, { dryRun: true, warnings, ...labels });
  if (warnings.length && !body.acknowledgeWarnings) {
    return json(res, 409, { error: "status_change_warning", warnings, ...labels, hint: warnings.join("\n") });
  }

  const { data, error } = await sb.from("gw_hr_applicants")
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).select(FIELDS).maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });

  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: body.id, event_key: "status_manual",
    label: "状態を手動変更", detail: `${labels.from} → ${labels.to}`, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_status_manual",
    target: `hr_applicant:${body.id}`,
    detail: { from: before.status, to, warnings: warnings.length, acknowledged: Boolean(body.acknowledgeWarnings) },
  });

  const next = pickNextInterview(data, interviews);
  return json(res, 200, {
    applicant: shapeApplicant(data, next && { id: next.id, scheduledAt: next.scheduled_at, kind: next.kind }),
    warnings,
  });
}
