// 採用HR → Office の早期引き渡し：書き込みと詳細の表示（db/143。読む・書くのは service role。権限・状態は先に確かめる）
//
//   recordCeoDecision … 社長判断の確定記録（社長・管理者だけ。PATCH /api/hr/applicants/detail の decision から）
//   saveHearing       … 条件ヒアリングの記録（採用HR）。給与は見られる人だけ、社内承認済みの額は経営者だけ
//   confirmHearing    … 人事担当の内容確認（不足があれば断る）
//   approveException  … 未確定のまま引き渡す例外の承認（社長・管理者だけ。理由が要る）
//   officeHandoff     … ［Officeへ引き渡す］（一度だけ。二重・同時押しは DB の一意索引で止め、409）
//   intakeView        … 詳細ドロワーに出す内容（給与の値は見られる人だけ）
//
// 通知・Slack・メールは送らない（PR C）。応募者へは何も送らない。
// 既存の handoff_at・accepted_at・formal_signed_at・employee_id・status には触らない。
import { admin } from "./supabase.js";
import { gwLog } from "./gw-audit.js";
// 名前空間で読む（テストが lib/gw.js を一部だけ差し替えても読み込みで落ちない）。判定は本物の lib/gw.js
import * as gw from "./gw.js";
const canDecideHire = (ctx) => Boolean(gw.canDecideHire?.(ctx));
const canDecideSalary = (ctx) => Boolean(gw.canDecideSalary?.(ctx));
import {
  intakeEnabled, INTAKE_SQL, INTAKE_PUBLIC, readIntakeFacts, normalizeHearing, normalizeHearingPay, hearingMissing,
  intakeStateOf, hearingSnapshot, fieldLabel, officeStatusLabel, isMissingTable, UNRESOLVED_LABEL,
} from "./hr-office-intake.js";

const DISABLED = { status: 409, body: { error: "intake_disabled", hint: "早期引き渡し（新フロー）はまだ使えません（HR_OFFICE_INTAKE が OFF）" } };
const notReady = (e) => ({ status: 503, body: { error: "not_ready", hint: `早期引き渡しを使うには ${INTAKE_SQL} を Supabase に流してください`, detail: e?.message } });
const fail = (e) => (isMissingTable(e) ? notReady(e) : { status: 500, body: { error: "db_failed", detail: e?.message || String(e) } });
const CLOSED = ["declined", "passed", "position_closed", "done"];

const DECISION_MAP = { hired: "pass", hold: "hold", rejected: "reject" };

/**
 * 社長判断の確定記録（db/143 gw_hr_ceo_decisions）。フラグ OFF のときは記録しない（旧フローのまま）。
 * canDecideHire の確かめは呼び出し側（detail.js）でも行うが、ここでも行う（DB の trigger も同じ条件で止める）
 * @returns {Promise<{status:number, body:object}|null>} null なら記録した（または記録しない設定）
 */
export async function recordCeoDecision({ ctx, user, applicantId, decision, note }) {
  if (!intakeEnabled()) return null;
  const d = DECISION_MAP[decision];
  if (!d) return null;
  if (!canDecideHire(ctx)) return { status: 403, body: { error: "forbidden", hint: "採用判断は社長・管理者だけができます" } };
  const { error } = await admin().from("gw_hr_ceo_decisions").insert({
    tenant_id: ctx.tenantId, applicant_id: applicantId, decision: d, decided_by: user.id,
    decided_by_employee_id: ctx.employee?.id || null, note: note ? String(note).slice(0, 1000) : null,
  });
  if (error) {
    if (error.code === "42501") return { status: 403, body: { error: "forbidden", hint: "採用判断は社長・管理者だけができます" } };
    return fail(error);
  }
  return null;
}

/** 1人ぶんの新フローの事実（応募者・判断・ヒアリング・引き渡し）。tenant が違えば applicant は null */
async function load(ab, tenantId, applicantId) {
  const { data: applicant, error } = await ab.from("gw_hr_applicants").select("*")
    .eq("id", applicantId).eq("tenant_id", tenantId).maybeSingle();
  if (error) return { error };
  if (!applicant) return { applicant: null };
  const facts = await readIntakeFacts(ab, tenantId, [applicantId]);
  if (facts.error || !facts.ready) return { error: facts.error || { code: "PGRST205", message: "db/143 not applied" } };
  return { applicant, state: facts.byId.get(applicantId) || null, raw: facts.raw.get(applicantId) || null };
}

const notFound = { status: 404, body: { error: "not_found" } };
const notNewFlow = {
  status: 409,
  body: { error: "not_new_flow", hint: "この応募者は旧フロー（HRで契約手続き）です。社長の合格判断（新しい記録）があり、オファーの版が無い応募者だけが対象です" },
};
const moved = { status: 409, body: { error: "already_handed_off", hint: "すでに Office へ引き渡し済みです（引き渡しは一度だけ）" } };

function editable(applicant, state) {
  if (!state) return notNewFlow;
  if (state.phase === "handed_off" || state.phase === "withdrawn") return moved;
  if (applicant.lead_category === "mugendojo") return { status: 409, body: { error: "not_recruit", hint: "無限道場リードは Office へ引き渡しません" } };
  if (applicant.employee_id || CLOSED.includes(applicant.status)) {
    return { status: 409, body: { error: "invalid_state", hint: "終了・辞退・社員登録済みの応募者です" } };
  }
  return null;
}

/** 条件ヒアリングを記録する（記録中のものを上書き。確認は外れる。未確定の項目が変われば例外の承認も外れる） */
export async function saveHearing({ ctx, user, body, salary }) {
  if (!intakeEnabled()) return DISABLED;
  const ab = admin();
  const l = await load(ab, ctx.tenantId, body.id);
  if (l.error) return fail(l.error);
  if (!l.applicant) return notFound;
  const bad = editable(l.applicant, l.state);
  if (bad) return bad;
  const n = normalizeHearing(body.hearing, body.unresolved);
  if (n.error) return { status: 400, body: n };
  // 給与：見られない人は入力できない（見えていない値を上書きしない）。「未確定」にはできる
  let pay = null;
  if (body.pay !== undefined && body.pay !== null) {
    if (!salary) return { status: 403, body: { error: "forbidden", hint: "希望報酬・給与は、給与を見られる人が入力します（「未確定／Officeで確認」にはできます）" } };
    const p = normalizeHearingPay(body.pay, { unresolved: n.unresolved, canApprove: canDecideSalary(ctx) });
    if (p.error) return { status: p.status || 400, body: { error: p.error, detail: p.detail, hint: p.detail } };
    pay = p;
  }
  const now = new Date().toISOString();
  const prev = l.raw?.hearing || null;
  const sameUnresolved = prev && JSON.stringify([...(prev.unresolved || [])].sort()) === JSON.stringify([...n.unresolved].sort());
  const row = {
    ...n.value, unresolved: n.unresolved, updated_by: user.id, updated_at: now, confirmed_by: null, confirmed_at: null,
    ...(sameUnresolved ? {} : { exception_reason: null, exception_approved_by: null, exception_approved_at: null }),
  };
  let hearingId = prev?.id || null;
  if (prev) {
    const { error } = await ab.from("gw_hr_hearings").update(row).eq("id", prev.id).eq("tenant_id", ctx.tenantId);
    if (error) return fail(error);
  } else {
    const { data, error } = await ab.from("gw_hr_hearings")
      .insert({ ...row, tenant_id: ctx.tenantId, applicant_id: body.id, recorded_by: user.id, recorded_at: now })
      .select("id").single();
    if (error) {
      // 同時に2人が最初の記録をした：先の記録に上書きする
      if (error.code !== "23505") return fail(error);
      const again = await load(ab, ctx.tenantId, body.id);
      hearingId = again.raw?.hearing?.id || null;
      if (!hearingId) return fail(error);
      const u = await ab.from("gw_hr_hearings").update(row).eq("id", hearingId).eq("tenant_id", ctx.tenantId);
      if (u.error) return fail(u.error);
    } else {
      hearingId = data.id;
      await ab.from("gw_hr_timeline").insert({
        tenant_id: ctx.tenantId, applicant_id: body.id, event_key: "hearing_recorded", label: "条件ヒアリングを記録", created_by: user.id,
      });
    }
  }
  if (pay) {
    const payRow = {
      hearing_id: hearingId, tenant_id: ctx.tenantId, applicant_id: body.id, ...pay.value, updated_by: user.id, updated_at: now,
      ...(pay.approve ? { approved_by: user.id, approved_at: now } : {}),
    };
    const { error } = await ab.from("gw_hr_hearing_pay").upsert(payRow, { onConflict: "hearing_id" });
    if (error) return fail(error);
  }
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.hearing_save", target: `hr_applicant:${body.id}`,
    // 値は残さない（給与・個人の希望）。どの項目を「未確定」にしたかだけ
    detail: { fields: Object.keys(n.value).filter((k) => n.value[k] !== null), unresolved: n.unresolved, pay: Boolean(pay) },
  });
  return { status: 200, body: { officeIntake: await intakeView({ ctx, salary, applicantId: body.id }) } };
}

/** 人事担当がヒアリングの内容を確認する。不足があれば「条件ヒアリング不足」として断る */
export async function confirmHearing({ ctx, user, body, salary }) {
  if (!intakeEnabled()) return DISABLED;
  const ab = admin();
  const l = await load(ab, ctx.tenantId, body.id);
  if (l.error) return fail(l.error);
  if (!l.applicant) return notFound;
  const bad = editable(l.applicant, l.state);
  if (bad) return bad;
  const h = l.raw?.hearing;
  if (!h) return { status: 409, body: { error: "hearing_missing", hint: "条件ヒアリングがまだ記録されていません" } };
  const missing = hearingMissing(h, l.raw.payEntered);
  if (missing.length) {
    return { status: 409, body: { error: "hearing_incomplete", missing,
      hint: `条件ヒアリング不足：${missing.map(fieldLabel).join("・")}（値を入れるか「${UNRESOLVED_LABEL}」にしてください）` } };
  }
  const { error } = await ab.from("gw_hr_hearings").update({ confirmed_by: user.id, confirmed_at: new Date().toISOString() })
    .eq("id", h.id).eq("tenant_id", ctx.tenantId);
  if (error) return fail(error);
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.hearing_confirm", target: `hr_applicant:${body.id}`, detail: { hearingId: h.id } });
  return { status: 200, body: { officeIntake: await intakeView({ ctx, salary, applicantId: body.id }) } };
}

/** 未確定の項目を残して引き渡す例外の承認（社長・管理者だけ。理由が要る） */
export async function approveException({ ctx, user, body, salary }) {
  if (!intakeEnabled()) return DISABLED;
  if (!canDecideHire(ctx)) return { status: 403, body: { error: "forbidden", hint: "未確定のまま引き渡す例外を承認できるのは社長・管理者だけです" } };
  const reason = String(body.reason ?? "").trim().slice(0, 1000);
  if (!reason) return { status: 400, body: { error: "invalid_body", hint: "例外の理由を入力してください" } };
  const ab = admin();
  const l = await load(ab, ctx.tenantId, body.id);
  if (l.error) return fail(l.error);
  if (!l.applicant) return notFound;
  const bad = editable(l.applicant, l.state);
  if (bad) return bad;
  const h = l.raw?.hearing;
  if (!h || !(h.unresolved || []).length) {
    return { status: 409, body: { error: "nothing_to_approve", hint: "未確定の項目がありません（例外の承認は要りません）" } };
  }
  const { error } = await ab.from("gw_hr_hearings")
    .update({ exception_reason: reason, exception_approved_by: user.id, exception_approved_at: new Date().toISOString() })
    .eq("id", h.id).eq("tenant_id", ctx.tenantId);
  if (error) return error.code === "42501" ? { status: 403, body: { error: "forbidden", hint: error.message } } : fail(error);
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.hearing_exception", target: `hr_applicant:${body.id}`,
    detail: { hearingId: h.id, unresolved: h.unresolved } });
  return { status: 200, body: { officeIntake: await intakeView({ ctx, salary, applicantId: body.id }) } };
}

/**
 * ［Officeへ引き渡す］。一度だけ。同じ操作の送り直し（clientRequestId が同じ）は、最初の結果を返す。
 * 承諾・正式契約・社員登録ではない（applicant.status・offers は変えない）。通知は送らない（PR C）
 */
export async function officeHandoff({ ctx, user, body, salary }) {
  if (!intakeEnabled()) return DISABLED;
  if (body.confirm !== true) return { status: 400, body: { error: "invalid_body", hint: "確認画面で内容を確かめてから引き渡してください（confirm: true）" } };
  const reqId = body.clientRequestId ? String(body.clientRequestId).slice(0, 100) : null;
  if (reqId && reqId.length < 8) return { status: 400, body: { error: "invalid_body", hint: "clientRequestId は8文字以上です" } };
  const ab = admin();
  const l = await load(ab, ctx.tenantId, body.id);
  if (l.error) return fail(l.error);
  if (!l.applicant) return notFound;
  if (l.state?.phase === "handed_off" || l.state?.phase === "withdrawn") {
    const same = reqId && l.raw?.intake?.client_request_id === reqId;
    if (same) return { status: 200, body: { duplicate: true, officeIntake: await intakeView({ ctx, salary, applicantId: body.id }) } };
    return moved;
  }
  const bad = editable(l.applicant, l.state);
  if (bad) return bad;
  const s = l.state;
  const h = l.raw?.hearing;
  if (s.phase !== "ready") {
    if (!h) return { status: 409, body: { error: "hearing_missing", hint: "条件ヒアリングがまだ記録されていません" } };
    if (s.offerType === "training") return { status: 409, body: { error: "training", hint: "育成枠は Office へ引き渡しません" } };
    if (s.missing.length) {
      return { status: 409, body: { error: "hearing_incomplete", missing: s.missing, hint: `条件ヒアリング不足：${s.missing.map(fieldLabel).join("・")}` } };
    }
    if (!s.confirmed) return { status: 409, body: { error: "hearing_unconfirmed", hint: "ヒアリングの内容確認がまだです" } };
    return { status: 409, body: { error: "exception_required", unresolved: s.unresolved,
      hint: `未確定の項目（${s.unresolved.map(fieldLabel).join("・")}）を残して引き渡すには、管理者の承認と理由が要ります` } };
  }
  if (l.applicant.decision !== "hired") {
    return { status: 409, body: { error: "not_passed", hint: "応募者の採用判断が「合格」ではありません" } };
  }
  let assignee = null;
  if (body.officeAssigneeId) {
    const { data: emp } = await ab.from("gw_employees").select("id, status").eq("id", body.officeAssigneeId).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!emp || !["active", "invited"].includes(emp.status)) return { status: 400, body: { error: "invalid_body", hint: "Office 担当は同じ会社の在籍者から選んでください" } };
    assignee = emp.id;
  }
  const { data: made, error } = await ab.from("gw_hr_office_intakes").insert({
    tenant_id: ctx.tenantId, applicant_id: body.id, ceo_decision_id: s.decisionId, hearing_id: h.id,
    hearing_snapshot: hearingSnapshot(h, l.raw.payEntered), unresolved_items: h.unresolved || [],
    exception_reason: h.exception_reason ?? null, exception_approved_by: h.exception_approved_by ?? null,
    exception_approved_at: h.exception_approved_at ?? null,
    handed_by: user.id, handed_by_employee_id: ctx.employee?.id || null, office_assignee_id: assignee, client_request_id: reqId,
  }).select("id, handed_at").single();
  if (error) {
    // 二重の引き渡し（同時押し・API の直呼び）：DB の一意索引が止めた
    if (error.code === "23505") {
      const again = await load(ab, ctx.tenantId, body.id);
      if (reqId && again.raw?.intake?.client_request_id === reqId) {
        return { status: 200, body: { duplicate: true, officeIntake: await intakeView({ ctx, salary, applicantId: body.id }) } };
      }
      return moved;
    }
    if (error.code === "23514") return { status: 409, body: { error: "invalid_state", hint: error.message } };
    return fail(error);
  }
  await ab.from("gw_hr_office_intake_events").insert({
    tenant_id: ctx.tenantId, intake_id: made.id, applicant_id: body.id, kind: "handed_off",
    actor_id: user.id, actor_employee_id: ctx.employee?.id || null, fields: h.unresolved || [],
  });
  await ab.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: body.id, event_key: "office_intake",
    label: "Officeへ引き渡し（条件手続き）", detail: (h.unresolved || []).length ? `未確定：${h.unresolved.map(fieldLabel).join("・")}` : null,
    created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.office_intake_handoff", target: `hr_applicant:${body.id}`,
    detail: { intakeId: made.id, unresolved: h.unresolved || [], exception: Boolean(h.exception_approved_at), officeAssigneeId: assignee },
  });
  return { status: 200, body: { officeIntake: await intakeView({ ctx, salary, applicantId: body.id }) } };
}

/**
 * 詳細ドロワーの「条件ヒアリング・Office への引き渡し」に出す内容。フラグ OFF なら { enabled:false } だけ。
 * 旧フローの人は { enabled:true, newFlow:false }（画面はこれまでどおり）
 */
export async function intakeView({ ctx, salary, applicantId }) {
  if (!intakeEnabled()) return { enabled: false };
  const ab = admin();
  const l = await load(ab, ctx.tenantId, applicantId);
  if (l.error) return { enabled: true, ready: false, hint: `早期引き渡しを使うには ${INTAKE_SQL} を Supabase に流してください` };
  if (!l.applicant || !l.state) return { enabled: true, ready: true, newFlow: false, ...INTAKE_PUBLIC };
  const s = l.state;
  // 固定済み（引き渡し後）は、引き渡しの根拠のヒアリングを読む
  let h = l.raw.hearing;
  let intake = null;
  let events = [];
  if (l.raw.intake) {
    const { data } = await ab.from("gw_hr_office_intakes").select("*").eq("id", l.raw.intake.id).eq("tenant_id", ctx.tenantId).maybeSingle();
    intake = data || null;
    if (intake) {
      const r = await ab.from("gw_hr_hearings").select("*").eq("id", intake.hearing_id).eq("tenant_id", ctx.tenantId).maybeSingle();
      h = r.data || null;
      const ev = await ab.from("gw_hr_office_intake_events").select("id, kind, actor_id, message, fields, created_at")
        .eq("intake_id", intake.id).eq("tenant_id", ctx.tenantId).order("created_at", { ascending: true });
      events = ev.data || [];
    }
  }
  let pay = null;
  if (h) {
    const { data: p } = await ab.from("gw_hr_hearing_pay").select("*").eq("hearing_id", h.id).maybeSingle();
    pay = salary
      ? { entered: p?.desired_amount != null, desired_wage_type: p?.desired_wage_type ?? null, desired_amount: p?.desired_amount ?? null,
          desired_note: p?.desired_note ?? null, approved_wage_type: p?.approved_wage_type ?? null, approved_amount: p?.approved_amount ?? null,
          approved_at: p?.approved_at ?? null }
      : { entered: p?.desired_amount != null };
  }
  const userIds = [...new Set([s.decidedBy, h?.confirmed_by, h?.exception_approved_by, h?.recorded_by, intake?.handed_by,
    intake?.received_by, ...events.map((e) => e.actor_id)].filter(Boolean))];
  const { data: people } = userIds.length
    ? await ab.from("gw_employees").select("user_id, display_name").eq("tenant_id", ctx.tenantId).in("user_id", userIds)
    : { data: [] };
  const nameOf = new Map((people || []).map((e) => [e.user_id, e.display_name]));
  let assigneeName = null;
  if (intake?.office_assignee_id) {
    const { data: e } = await ab.from("gw_employees").select("display_name").eq("id", intake.office_assignee_id).eq("tenant_id", ctx.tenantId).maybeSingle();
    assigneeName = e?.display_name || null;
  }
  const values = {};
  for (const f of INTAKE_PUBLIC.fields) if (f.kind !== "pay") values[f.key] = h?.[f.key] ?? null;
  return {
    enabled: true, ready: true, newFlow: true, ...INTAKE_PUBLIC,
    phase: s.phase, missing: s.missing || [], unresolved: h?.unresolved || s.unresolved || [],
    decision: { decidedAt: s.decidedAt || l.raw.decision?.decided_at || null, decidedByName: nameOf.get(s.decidedBy || l.raw.decision?.decided_by) || null },
    hearing: h ? {
      id: h.id, values, unresolved: h.unresolved || [], locked: Boolean(h.locked_at),
      recordedAt: h.recorded_at, recordedByName: nameOf.get(h.recorded_by) || null, updatedAt: h.updated_at,
      confirmedAt: h.confirmed_at, confirmedByName: nameOf.get(h.confirmed_by) || null,
      exception: h.exception_approved_at ? { reason: h.exception_reason, approvedAt: h.exception_approved_at,
        approvedByName: nameOf.get(h.exception_approved_by) || null } : null,
    } : null,
    pay,
    intake: intake ? {
      id: intake.id, handedAt: intake.handed_at, handedByName: nameOf.get(intake.handed_by) || null,
      // 事実から決めた Office の状態（lib/hr-office-intake.js officeStatusOf。Office の画面と同じ）
      officeStatus: s.officeStatus || intake.office_status, officeStatusLabel: s.officeStatusLabel || officeStatusLabel(intake.office_status),
      closedAt: intake.closed_at || null, closedReason: intake.closed_reason || null,
      officeAssigneeId: intake.office_assignee_id, officeAssigneeName: assigneeName,
      receivedAt: intake.received_at, unresolved: intake.unresolved_items || [],
      exceptionReason: intake.exception_reason || null,
    } : null,
    events: events.map((e) => ({ id: e.id, kind: e.kind, at: e.created_at, actorName: nameOf.get(e.actor_id) || null, fields: e.fields || [] })),
    can: {
      editHearing: !["handed_off", "withdrawn"].includes(s.phase),
      editPay: Boolean(salary), approvePay: canDecideSalary(ctx),
      approveException: canDecideHire(ctx), handoff: s.phase === "ready",
    },
  };
}

export { intakeStateOf };
