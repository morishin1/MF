// Office 人事・労務：HRからの引き継ぎ（早期引き渡し〔db/143〕を受けた人の条件手続き〜入社準備）
//
// GET  /api/hr/office-intakes                         … キュー（候補者・採用区分・希望条件・採用担当・Office 担当・状態・次にやること・期限）
// GET  /api/hr/office-intakes?summary=1               … Office ホームのカード用（状態ごとの件数だけ）
// GET  /api/hr/office-intakes?intake=…                … 詳細（面談結果・希望条件・社長判断・採用条件の版・契約手続き・履歴。閲覧専用の項目を含む）
// GET  /api/hr/office-intakes?intake=…&offerId=…&file=offer|notice|accepted|preview|previewOffer … 条件の PDF（給与が入るものは給与を見られる人だけ）
// GET  /api/hr/office-intakes?intake=…&docId=…        … 社労士の正式PDF（給与を見られる人だけ・SHA-256 を確かめる）
// GET  /api/hr/office-intakes?intake=…&offerId=…&draft=request … 社労士への依頼文の下書き（送らない・記録しない）
// POST /api/hr/office-intakes { intake, action, … }
//   receive      { assigneeId? }       … 受領して着手（一度だけ。担当が無ければ自分）
//   assign       { assigneeId }        … Office 担当を変える
//   createOffer  { offerType, respondBy, …条件 } … 会社の採用条件（版）を作る。給与・報酬を入れられるのは経営者（canDecideSalary）だけ
//   updateOffer  { offerId, … }        … 確定の前だけ直す（給与は経営者だけ）
//   confirmOffer { offerId }           … 採用条件を確定（給与・報酬を決めるのは経営者だけ）
//   issueLink / markSent { offerId }   … 本人専用URLを発行（手で送る）／送付済みにする。メールは送らない
//   contract     { offerId, step, … }  … 社労士への依頼・正式PDF の受領・照合・承認・差し戻し・条件を直す・LegalSign の登録・締結の記録（db/139）
//   formal       { offerId, step }     … 正式PDFの流れでない版の LegalSign（setLegalSign・sendFormal〔手で送った記録だけ〕・markFormalSigned）
//   formalHandoff{ offerId }           … 本人の同意と締結を確かめて、社員登録へ進める準備（既存の handoff_at。db/133）
//   withdraw     { kind, reason }      … 辞退・不成立（理由つき。履歴は残す。HR では「終了」）
//   complete                            … 入社完了（社員登録のあとだけ）
//   returnToHr   { reason }            … 誤って引き渡したときの差し戻し（社長・管理者だけ・採用条件の版を作る前だけ。行は消さない）
//
// ■ 権限と、service role を使う順番（api/hr/applicants/advance.js と同じ考え方。HR の経路と同等以上に先に確かめる）
//   ① 認可       … Office の人事・労務（canOfficeHr）。採用担当だけ・Office の権限が無い人は 403（何も読まない）
//   ② 二段階認証 … 個人情報を扱うので requireMfa（入退社と同じ）
//   ③ 機能フラグ … HR_OFFICE_INTAKE が ON のときだけ（OFF なら GET は { enabled:false }、書き込みは 409）
//   ④ テナント   … 引き渡し・応募者・版・正式PDF のどれも ctx.tenantId で絞る。別の会社の ID は 404
//   ⑤ 引き渡し   … 差し戻していない引き渡しがある応募者だけ。版・正式PDF はその応募者のものだけ（別の応募者の ID は 404）
//   ⑥ 状態       … 受領の前は手続きできない。辞退・不成立・完了のあとは変えない
//   ⑦ 給与       … 給与・報酬・条件PDF は canSeeSalary の人だけに返す。会社の給与を決める（入れる・確定する）のは canDecideSalary（経営者）
//   そのあと service role で、HR と同じ関数（lib/hr-offer-ops.js・lib/hr-contract-ops.js）を呼ぶ（データは二重に作らない）
//
// ■ 状態は事実から決める（lib/hr-office-intake.js officeStatusOf。HR の一覧・詳細も同じ関数）。
//   操作のあとに、決めた値を office_status へ写す（一覧の絞り込みのため）。手動で状態を選ぶ操作は無い
// ■ 通知・Slack・メールは送らない（PR C）。本人へもメールは送らない（URL を発行して手で送る）
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import {
  gwContext, canOfficeHr, canSeeSalary, canDecideSalary, canAdvanceHire, isOwner,
} from "../../lib/gw.js";
import { guardSalaryOutput, dropSalaryInput } from "../../lib/salary.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { requireMfa } from "../../lib/mfa.js";
import { shapeOffer } from "../../lib/hr.js";
import { OFFER_TYPES_PUBLIC, OFFER_TYPE_KEYS, offerTypeLabel, defaultRespondBy } from "../../lib/hr-offer-types.js";
import {
  intakeEnabled, INTAKE_SQL, OFFICE_STATUSES, officeStatusLabel, officeStatusOf, readOfficeFacts, currentOfferOf,
  HEARING_FIELDS, fieldLabel, UNRESOLVED_LABEL, isMissingTable,
} from "../../lib/hr-office-intake.js";
import { createOffer, actOffer, offerFile } from "../../lib/hr-offer-ops.js";
import { contractCard, contractRequestDraft, contractOfficialFile, contractAct } from "../../lib/hr-contract-ops.js";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TERMINAL = ["withdrawn", "completed"];
const CONTRACT_STEPS = ["markRequested", "uploadUrl", "attach", "approve", "return", "reopen", "legalsign", "signed"];
const FORMAL_STEPS = ["setLegalSign", "sendFormal", "markFormalSigned"];
const WITHDRAW_KINDS = { declined: "辞退", not_concluded: "不成立" };
const INTAKE_FIELDS = "id, tenant_id, applicant_id, ceo_decision_id, hearing_id, hearing_snapshot, unresolved_items, exception_reason, "
  + "exception_approved_by, exception_approved_at, handed_by, handed_at, office_assignee_id, office_status, received_by, received_at, "
  + "offer_id, closed_reason, closed_by, closed_at, returned_by, returned_at, return_reason, created_at";

const DISABLED = { error: "intake_disabled", hint: "HRからの引き継ぎ（新しい流れ）はまだ使えません（HR_OFFICE_INTAKE が OFF）" };
const notReady = (res, e) => json(res, 503, { error: "not_ready", hint: `HRからの引き継ぎを使うには ${INTAKE_SQL} を Supabase に流してください`, detail: e?.message });
const failed = (res, e) => (isMissingTable(e) ? notReady(res, e) : json(res, 500, { error: "db_failed", detail: e?.message || String(e) }));

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // ① 認可。通らなければ service role は作らない（何も読まない・書かない）
  if (!canOfficeHr(ctx)) return json(res, 403, { error: "forbidden", hint: "HRからの引き継ぎは、Office の人事・労務の担当だけが扱えます" });
  // ② 個人情報（履歴書・面談の結果・連絡先）を扱う
  if (!(await requireMfa(req, res, ctx, user))) return;
  // ⑦ 給与は見られる人にだけ返す（出口で外す）
  const salary = guardSalaryOutput(res, canSeeSalary(ctx));
  // ③ 機能フラグ（既定 OFF）。OFF のときは画面にも出さない
  if (!intakeEnabled()) {
    if (req.method === "GET") return json(res, 200, { enabled: false });
    return json(res, 409, DISABLED);
  }
  const sb = admin();
  try {
    if (req.method === "GET") {
      const q = new URL(req.url || "/", "http://localhost").searchParams;
      if (!q.get("intake")) return await list(res, sb, ctx, salary, q.get("summary") === "1");
      const intake = await loadIntake(sb, ctx, q.get("intake"));
      if (intake?.error) return failed(res, intake.error);
      if (!intake) return json(res, 404, { error: "not_found" });
      if (q.get("file")) {
        const offer = await ownOffer(sb, ctx, intake, q.get("offerId"));
        if (!offer) return json(res, 404, { error: "not_found" });
        return offerFile(res, sb, ctx, user, offer.id, q.get("file"), salary);
      }
      if (q.get("docId")) {
        const doc = await ownDoc(sb, ctx, intake, q.get("docId"));
        if (!doc) return json(res, 404, { error: "not_found" });
        return contractOfficialFile(res, sb, ctx, user, doc.id, salary);
      }
      if (q.get("draft") === "request") {
        const offer = await ownOffer(sb, ctx, intake, q.get("offerId"));
        if (!offer) return json(res, 404, { error: "not_found" });
        return contractRequestDraft(res, sb, ctx, offer.id, q.get("kind"), salary);
      }
      return await detail(res, sb, ctx, user, salary, intake);
    }
    if (req.method === "POST") return await act(req, res, sb, ctx, user, salary);
  } catch (e) {
    console.error("[hr/office-intakes]", e?.message || e);
    return failed(res, e);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読む ----------------------------------------------------------------------------

/** ④⑤ 自分の会社の、差し戻していない引き渡し（無ければ null） */
async function loadIntake(sb, ctx, id) {
  if (!ID_RE.test(String(id || ""))) return null;
  const { data, error } = await sb.from("gw_hr_office_intakes").select(INTAKE_FIELDS).eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) return { error };
  if (!data || data.returned_at) return null;
  return data;
}
/** ⑤ その引き渡しの応募者の版だけ（別の応募者・別の会社の版は null） */
async function ownOffer(sb, ctx, intake, offerId) {
  if (!ID_RE.test(String(offerId || ""))) return null;
  const { data } = await sb.from("gw_hr_offers").select("*").eq("id", offerId).eq("tenant_id", ctx.tenantId).maybeSingle();
  return data && data.applicant_id === intake.applicant_id ? data : null;
}
async function ownDoc(sb, ctx, intake, docId) {
  if (!ID_RE.test(String(docId || ""))) return null;
  const { data } = await sb.from("gw_hr_offer_official_docs").select("id, applicant_id, offer_id").eq("id", docId).eq("tenant_id", ctx.tenantId).maybeSingle();
  return data && data.applicant_id === intake.applicant_id ? data : null;
}
async function namesOf(sb, ctx, { userIds = [], employeeIds = [] }) {
  const byUser = new Map(), byEmp = new Map();
  const u = [...new Set(userIds.filter(Boolean))], e = [...new Set(employeeIds.filter(Boolean))];
  if (u.length) {
    const { data } = await sb.from("gw_employees").select("id, user_id, display_name").eq("tenant_id", ctx.tenantId).in("user_id", u);
    for (const r of data || []) byUser.set(r.user_id, r.display_name);
  }
  if (e.length) {
    const { data } = await sb.from("gw_employees").select("id, display_name").eq("tenant_id", ctx.tenantId).in("id", e);
    for (const r of data || []) byEmp.set(r.id, r.display_name);
  }
  return { byUser, byEmp };
}

/** 一覧の1行（給与の値は出さない。希望額は「候補者希望あり／未確定」だけ） */
function itemOf(intake, applicant, st, names) {
  const h = intake.hearing_snapshot || {};
  const unresolved = Array.isArray(intake.unresolved_items) ? intake.unresolved_items : [];
  return {
    id: intake.id, applicantId: intake.applicant_id, name: applicant?.name || "（不明）",
    offerType: h.offer_type || null, offerTypeLabel: h.offer_type_label || offerTypeLabel(h.offer_type) || null,
    desired: {
      jobTitle: h.job_title ?? null, joinDate: h.desired_join_date ?? null, workLocation: h.work_location ?? null,
      remote: h.remote_policy ?? null, weeklyDays: h.weekly_days ?? null, weeklyHours: h.weekly_hours ?? null,
      contractPeriod: h.contract_period ?? null,
      pay: h.desired_pay === "unresolved" ? "unresolved" : h.desired_pay === "entered" ? "entered" : null,
    },
    unresolved, unresolvedLabels: unresolved.map(fieldLabel),
    recruiterName: names.byEmp.get(applicant?.recruiter_id) || null,
    assigneeId: intake.office_assignee_id || null, assigneeName: names.byEmp.get(intake.office_assignee_id) || null,
    handedAt: intake.handed_at, handedByName: names.byUser.get(intake.handed_by) || null, receivedAt: intake.received_at || null,
    status: st ? { key: st.key, label: st.label } : { key: intake.office_status, label: officeStatusLabel(intake.office_status) },
    step: st?.step || null, next: st?.next || null, deadline: st?.deadline || null,
  };
}

async function list(res, sb, ctx, salary, summaryOnly) {
  const { data: intakes, error } = await sb.from("gw_hr_office_intakes").select(INTAKE_FIELDS)
    .eq("tenant_id", ctx.tenantId).order("handed_at", { ascending: false }).limit(300);
  if (error) return failed(res, error);
  const active = (intakes || []).filter((i) => !i.returned_at);
  const facts = await readOfficeFacts(sb, ctx.tenantId, active);
  if (facts.error) return failed(res, facts.error);
  const states = new Map(active.map((i) => [i.id, officeStatusOf({ intake: i, ...(facts.byApplicant.get(i.applicant_id) || {}) })]));
  const counts = Object.fromEntries(OFFICE_STATUSES.map((s) => [s.key, 0]));
  for (const st of states.values()) if (st) counts[st.key] = (counts[st.key] || 0) + 1;
  const open = active.filter((i) => !TERMINAL.includes(states.get(i.id)?.key)).length;
  if (summaryOnly) return json(res, 200, { enabled: true, ready: true, open, counts, statuses: OFFICE_STATUSES });
  const ids = active.map((i) => i.applicant_id);
  const apps = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from("gw_hr_applicants").select("id, name, recruiter_id").eq("tenant_id", ctx.tenantId).in("id", ids.slice(i, i + 100));
    apps.push(...(data || []));
  }
  const byId = new Map(apps.map((a) => [a.id, a]));
  const names = await namesOf(sb, ctx, {
    userIds: active.map((i) => i.handed_by), employeeIds: [...active.map((i) => i.office_assignee_id), ...apps.map((a) => a.recruiter_id)],
  });
  const items = active.map((i) => itemOf(i, byId.get(i.applicant_id), states.get(i.id), names));
  return json(res, 200, {
    enabled: true, ready: true, open, counts, statuses: OFFICE_STATUSES, items, salaryVisible: salary,
    me: { employeeId: ctx.employee?.id || null },
  });
}

/** 詳細：引き渡しの中身・面談の結果・社長判断・希望条件・採用条件の版・契約手続き・履歴。書類は api/hr/documents.js（閲覧専用）で読む */
async function detail(res, sb, ctx, user, salary, intake) {
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, name, email, phone, status, employee_id, recruiter_id, job_title")
    .eq("id", intake.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant) return json(res, 404, { error: "not_found" });
  const facts = await readOfficeFacts(sb, ctx.tenantId, [intake]);
  if (facts.error) return failed(res, facts.error);
  const f = facts.byApplicant.get(intake.applicant_id) || { offers: [], docs: [], requests: [] };
  const st = officeStatusOf({ intake, ...f });
  const [{ data: decision }, { data: interviews }, { data: events }, { data: emps }] = await Promise.all([
    sb.from("gw_hr_ceo_decisions").select("id, decision, decided_by, decided_at, note").eq("id", intake.ceo_decision_id).eq("tenant_id", ctx.tenantId).maybeSingle(),
    sb.from("gw_hr_interviews").select("id, kind, scheduled_at, conducted_at, interviewer_id, rank, recommend_reason, notes, scores")
      .eq("tenant_id", ctx.tenantId).eq("applicant_id", applicant.id).order("created_at", { ascending: true }),
    sb.from("gw_hr_office_intake_events").select("id, kind, actor_id, message, fields, created_at")
      .eq("tenant_id", ctx.tenantId).eq("intake_id", intake.id).order("created_at", { ascending: true }),
    sb.from("gw_employees").select("id, display_name, status").eq("tenant_id", ctx.tenantId),
  ]);
  const names = await namesOf(sb, ctx, {
    userIds: [intake.handed_by, intake.received_by, intake.closed_by, intake.exception_approved_by, decision?.decided_by, ...(events || []).map((e) => e.actor_id)],
    employeeIds: [intake.office_assignee_id, applicant.recruiter_id, ...(interviews || []).map((i) => i.interviewer_id)],
  });
  // 希望条件（候補者の希望。会社の正式な提示条件とは別）。給与の値は見られる人だけ
  const h = intake.hearing_snapshot || {};
  let pay = { entered: h.desired_pay === "entered", unresolved: h.desired_pay === "unresolved" };
  if (salary) {
    const { data: p } = await sb.from("gw_hr_hearing_pay").select("desired_wage_type, desired_amount, desired_note, approved_wage_type, approved_amount, approved_at")
      .eq("hearing_id", intake.hearing_id).maybeSingle();
    if (p) pay = { ...pay, desiredWageType: p.desired_wage_type, desiredAmount: p.desired_amount, desiredNote: p.desired_note,
      approvedWageType: p.approved_wage_type, approvedAmount: p.approved_amount, approvedAt: p.approved_at };
  }
  const hearing = HEARING_FIELDS.filter((x) => x.kind !== "pay").map((x) => ({
    key: x.key, label: x.label, value: x.key === "offer_type" ? (h.offer_type_label || offerTypeLabel(h.offer_type) || null) : (h[x.key] ?? null),
    unresolved: (intake.unresolved_items || []).includes(x.key),
  }));
  // 採用条件の版（会社の正式な提示条件）。給与は出口で外れる（canSeeSalary でない人）
  const offers = [...(f.offers || [])].sort((a, b) => b.version - a.version).map((o) => ({
    ...shapeOffer(o), offerTypeLabel: offerTypeLabel(o.offer_type), handoffAt: o.handoff_at || null,
    formalSignedAt: o.formal_signed_at || null, declinedAt: o.declined_at || null, revokedAt: o.revoked_at || null,
  }));
  const current = currentOfferOf(f.offers);
  let contract = null;
  if (current) {
    const r = await contractCard(sb, ctx, applicant.id, salary);
    if (r.status === 200 && r.body?.applicable) contract = r.body;
  }
  const terminal = TERMINAL.includes(st?.key);
  const received = Boolean(intake.received_at);
  return json(res, 200, {
    enabled: true, ready: true,
    intake: {
      ...itemOf(intake, applicant, st, names),
      exceptionReason: intake.exception_reason || null,
      exceptionApprovedByName: names.byUser.get(intake.exception_approved_by) || null,
      receivedByName: names.byUser.get(intake.received_by) || null,
      closedAt: intake.closed_at || null, closedReason: intake.closed_reason || null, closedByName: names.byUser.get(intake.closed_by) || null,
      offerId: intake.offer_id || null,
    },
    applicant: { id: applicant.id, name: applicant.name, email: applicant.email || null, phone: applicant.phone || null,
      status: applicant.status, registered: Boolean(applicant.employee_id) },
    decision: decision ? { decidedAt: decision.decided_at, decidedByName: names.byUser.get(decision.decided_by) || null, note: decision.note || null } : null,
    interviews: (interviews || []).map((i) => ({
      id: i.id, kind: i.kind, kindLabel: i.kind === "ceo" ? "社長面談" : "カジュアル面談", scheduledAt: i.scheduled_at, conductedAt: i.conducted_at,
      interviewerName: names.byEmp.get(i.interviewer_id) || null, rank: i.rank || null, recommendReason: i.recommend_reason || null,
      notes: i.notes || null, scores: i.scores || {},
    })),
    hearing, pay, unresolvedLabel: UNRESOLVED_LABEL,
    offers, currentOfferId: current?.id || null, contract,
    events: (events || []).map((e) => ({ id: e.id, kind: e.kind, at: e.created_at, actorName: names.byUser.get(e.actor_id) || null,
      message: e.message || null, fields: e.fields || [] })),
    assignees: (emps || []).filter((e) => ["active", "invited"].includes(e.status)).map((e) => ({ id: e.id, name: e.display_name })),
    offerTypes: OFFER_TYPES_PUBLIC.filter((t) => t.key !== "training"),
    defaults: { respondBy: defaultRespondBy() },
    salaryVisible: salary,
    can: {
      receive: !received && !terminal,
      assign: !terminal,
      createOffer: received && !terminal && !current && applicant.status === "offer_draft_pending",
      decideSalary: canDecideSalary(ctx), seeSalary: salary,
      approve: salary, signed: canAdvanceHire(ctx), formalHandoff: canAdvanceHire(ctx),
      withdraw: !terminal && !applicant.employee_id,
      complete: !terminal && Boolean(applicant.employee_id),
      returnToHr: !terminal && !(f.offers || []).length && canReturn(ctx),
      register: canAdvanceHire(ctx),
    },
  });
}

const canReturn = (ctx) => Boolean(ctx?.isAdmin) || isOwner(ctx);

// ---- 書く ----------------------------------------------------------------------------

async function act(req, res, sb, ctx, user, salary) {
  const body = await readJson(req);
  const intake = await loadIntake(sb, ctx, body?.intake);
  if (intake?.error) return failed(res, intake.error);
  if (!intake) return json(res, 404, { error: "not_found" });
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, name, status, employee_id")
    .eq("id", intake.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant) return json(res, 404, { error: "not_found" });
  // ⑥ 終わった引き渡しは変えない（履歴として見るだけ）
  const facts = await readOfficeFacts(sb, ctx.tenantId, [intake]);
  if (facts.error) return failed(res, facts.error);
  const f = facts.byApplicant.get(intake.applicant_id) || { offers: [], docs: [], requests: [] };
  const st = officeStatusOf({ intake, ...f });
  if (TERMINAL.includes(intake.office_status) || intake.closed_at) {
    return json(res, 409, { error: "closed", hint: `${officeStatusLabel(intake.office_status)}として記録済みです（履歴は見られます）` });
  }
  const c = { req, res, sb, ctx, user, salary, body, intake, applicant, facts: f, st };
  switch (body?.action) {
    case "receive": return receive(c);
    case "assign": return assign(c);
    case "withdraw": return withdraw(c);
    case "complete": return complete(c);
    case "returnToHr": return returnToHr(c);
    default: break;
  }
  // ここから下は採用条件・契約の手続き。受領の前はできない
  if (!intake.received_at) return json(res, 409, { error: "not_received", hint: "先に［受領して着手］を押してください" });
  switch (body?.action) {
    case "createOffer": return offerCreate(c);
    case "updateOffer": return offerUpdate(c);
    case "confirmOffer": return offerStep(c, "confirm", { owner: true });
    case "issueLink": return offerStep(c, "issueLink");
    case "markSent": return offerStep(c, "markSent");
    case "formal": return formal(c);
    case "formalHandoff": return offerStep(c, "handoff");
    case "contract": return contract(c);
    default: return json(res, 400, { error: "unknown_action" });
  }
}

async function event(c, kind, { message = null, fields = [] } = {}) {
  await c.sb.from("gw_hr_office_intake_events").insert({
    tenant_id: c.ctx.tenantId, intake_id: c.intake.id, applicant_id: c.applicant.id, kind,
    actor_id: c.user.id, actor_employee_id: c.ctx.employee?.id || null, message: message ? String(message).slice(0, 1000) : null, fields,
  });
}
const audit = (c, action, detail = {}) => gwLog({
  tenantId: c.ctx.tenantId, actorId: c.user.id, action, target: `hr_applicant:${c.applicant.id}`, detail: { intakeId: c.intake.id, ...detail },
});
const timeline = (c, event_key, label, detail = null) => c.sb.from("gw_hr_timeline").insert({
  tenant_id: c.ctx.tenantId, applicant_id: c.applicant.id, event_key, label, detail, created_by: c.user.id,
});

/**
 * 操作のあと：事実から決めた状態を office_status へ写す（変わったときだけ。辞退・完了は明示の操作だけが書く）。
 * 版を最初に作ったときは、引き渡しと版を結ぶ（offer_id。一度だけ）
 */
async function sync(c) {
  try {
    const intake = await loadIntake(c.sb, c.ctx, c.intake.id);
    if (!intake || intake.error || TERMINAL.includes(intake.office_status)) return;
    const facts = await readOfficeFacts(c.sb, c.ctx.tenantId, [intake]);
    if (facts.error) return;
    const f = facts.byApplicant.get(intake.applicant_id) || {};
    const st = officeStatusOf({ intake, ...f });
    const patch = {};
    if (st && !TERMINAL.includes(st.key) && st.key !== intake.office_status) patch.office_status = st.key;
    if (!intake.offer_id && (f.offers || []).length) {
      patch.offer_id = [...f.offers].sort((a, b) => a.version - b.version)[0].id;
    }
    if (!Object.keys(patch).length) return;
    const { error } = await c.sb.from("gw_hr_office_intakes").update(patch).eq("id", intake.id).eq("tenant_id", c.ctx.tenantId).is("returned_at", null);
    if (error) { console.error("[hr/office-intakes] sync", error.message); return; }
    if (patch.office_status) {
      await c.sb.from("gw_hr_office_intake_events").insert({
        tenant_id: c.ctx.tenantId, intake_id: intake.id, applicant_id: intake.applicant_id, kind: "status_changed",
        actor_id: c.user.id, actor_employee_id: c.ctx.employee?.id || null,
        message: `${officeStatusLabel(intake.office_status)} → ${st.label}`, fields: [intake.office_status, st.key],
      });
    }
  } catch (e) { console.error("[hr/office-intakes] sync", e?.message || e); }
}

async function employeeOf(c, id) {
  if (!ID_RE.test(String(id || ""))) return null;
  const { data } = await c.sb.from("gw_employees").select("id, status, display_name").eq("id", id).eq("tenant_id", c.ctx.tenantId).maybeSingle();
  return data && ["active", "invited"].includes(data.status) ? data : null;
}

async function receive(c) {
  if (c.intake.received_at) return json(c.res, 409, { error: "already_received", hint: "すでに受領済みです" });
  let assignee = c.intake.office_assignee_id || c.ctx.employee?.id || null;
  if (c.body.assigneeId) {
    const e = await employeeOf(c, c.body.assigneeId);
    if (!e) return json(c.res, 400, { error: "invalid_body", hint: "Office 担当は同じ会社の在籍者から選んでください" });
    assignee = e.id;
  }
  const now = new Date().toISOString();
  const { data, error } = await c.sb.from("gw_hr_office_intakes")
    .update({ received_at: now, received_by: c.user.id, office_assignee_id: assignee, office_status: "organizing" })
    .eq("id", c.intake.id).eq("tenant_id", c.ctx.tenantId).is("received_at", null).is("returned_at", null).select("id").maybeSingle();
  if (error) return error.code === "55000" ? json(c.res, 409, { error: "locked", hint: error.message }) : failed(c.res, error);
  if (!data) return json(c.res, 409, { error: "already_received", hint: "直前にほかの人が受領しました。開き直してください" });
  await event(c, "received");
  if (assignee !== c.intake.office_assignee_id) await event(c, "assignee_changed");
  await timeline(c, "office_received", "Office が受領・着手（条件手続き）");
  await audit(c, "hr.office_intake_receive", { assigneeId: assignee });
  return json(c.res, 200, { ok: true, status: "organizing" });
}

async function assign(c) {
  const e = await employeeOf(c, c.body.assigneeId);
  if (!e) return json(c.res, 400, { error: "invalid_body", hint: "Office 担当は同じ会社の在籍者から選んでください" });
  if (e.id === c.intake.office_assignee_id) return json(c.res, 200, { ok: true, unchanged: true });
  const { error } = await c.sb.from("gw_hr_office_intakes").update({ office_assignee_id: e.id })
    .eq("id", c.intake.id).eq("tenant_id", c.ctx.tenantId).is("returned_at", null);
  if (error) return failed(c.res, error);
  await event(c, "assignee_changed");
  await audit(c, "hr.office_intake_assign", { assigneeId: e.id });
  return json(c.res, 200, { ok: true, assigneeId: e.id, assigneeName: e.display_name });
}

/** 辞退・不成立（理由が要る）。本人へ案内していない・承諾していない版は無効にする（本人のURLを閉じる）。履歴は残す */
async function withdraw(c) {
  const kind = WITHDRAW_KINDS[c.body.kind] ? c.body.kind : null;
  if (!kind) return json(c.res, 400, { error: "invalid_body", hint: "「辞退」か「不成立」を選んでください" });
  const reason = String(c.body.reason ?? "").trim().slice(0, 900);
  if (!reason) return json(c.res, 400, { error: "invalid_body", hint: "辞退・不成立の理由を入力してください" });
  if (c.applicant.employee_id) return json(c.res, 409, { error: "already_advanced", hint: "社員登録が済んだ方です。退社の手続きで進めてください" });
  const now = new Date().toISOString();
  const closedReason = `${WITHDRAW_KINDS[kind]}：${reason}`;
  const { data, error } = await c.sb.from("gw_hr_office_intakes")
    .update({ office_status: "withdrawn", closed_at: now, closed_by: c.user.id, closed_reason: closedReason })
    .eq("id", c.intake.id).eq("tenant_id", c.ctx.tenantId).is("closed_at", null).is("returned_at", null).select("id").maybeSingle();
  if (error) return error.code === "55000" ? json(c.res, 409, { error: "locked", hint: error.message }) : failed(c.res, error);
  if (!data) return json(c.res, 409, { error: "closed", hint: "直前に状態が変わりました。開き直してください" });
  // まだ承諾していない版は無効にする（本人のURLが開けなくなる）。承諾した版・締結の記録は変えない
  const open = (c.facts.offers || []).filter((o) => !o.revoked_at && !o.accepted_at).map((o) => o.id);
  if (open.length) await c.sb.from("gw_hr_offers").update({ revoked_at: now }).in("id", open).eq("tenant_id", c.ctx.tenantId).is("revoked_at", null);
  // HR では「終了」に出す（状態は辞退。選考段階・判断・履歴はそのまま）
  if (!["declined", "passed", "position_closed", "done"].includes(c.applicant.status)) {
    await c.sb.from("gw_hr_applicants").update({ status: "declined", updated_at: now }).eq("id", c.applicant.id).eq("tenant_id", c.ctx.tenantId).is("employee_id", null);
  }
  await event(c, "closed", { message: closedReason });
  await timeline(c, "office_withdrawn", `Office で${WITHDRAW_KINDS[kind]}として記録`, closedReason);
  await audit(c, "hr.office_intake_withdraw", { kind, revokedOffers: open.length });
  return json(c.res, 200, { ok: true, status: "withdrawn" });
}

/** 入社完了（社員登録のあとだけ。入社書類・アカウント・端末・オリエンテーションは入退社の手続きで進める） */
async function complete(c) {
  if (!c.applicant.employee_id) return json(c.res, 409, { error: "not_registered", hint: "社員登録（入社手続き）が済んでから、入社完了にします" });
  const { data, error } = await c.sb.from("gw_hr_office_intakes").update({ office_status: "completed" })
    .eq("id", c.intake.id).eq("tenant_id", c.ctx.tenantId).is("closed_at", null).is("returned_at", null).select("id").maybeSingle();
  if (error) return error.code === "55000" || error.code === "23514" ? json(c.res, 409, { error: "locked", hint: error.message }) : failed(c.res, error);
  if (!data) return json(c.res, 409, { error: "closed", hint: "直前に状態が変わりました。開き直してください" });
  await event(c, "status_changed", { message: `${officeStatusLabel(c.intake.office_status)} → 完了`, fields: [c.intake.office_status, "completed"] });
  await timeline(c, "office_completed", "入社完了（Office）");
  await audit(c, "hr.office_intake_complete");
  return json(c.res, 200, { ok: true, status: "completed" });
}

/**
 * 差し戻し（誤って引き渡した）。社長・管理者だけ・理由が要る・採用条件の版を作る前だけ。
 * 引き渡しの行は消さない（returned_* を記録）。ヒアリングは確認前の写しを新しく作り、HR で確かめ直して引き渡し直せる
 */
async function returnToHr(c) {
  if (!canReturn(c.ctx)) return json(c.res, 403, { error: "forbidden", hint: "差し戻しは社長・管理者が行います（理由を記録します）" });
  const reason = String(c.body.reason ?? "").trim().slice(0, 1000);
  if (!reason) return json(c.res, 400, { error: "invalid_body", hint: "差し戻す理由を入力してください" });
  if ((c.facts.offers || []).length) {
    return json(c.res, 409, { error: "has_offer", hint: "採用条件の版を作ったあとは差し戻せません（辞退・不成立として記録してください）" });
  }
  if (c.applicant.employee_id) return json(c.res, 409, { error: "already_advanced", hint: "社員登録が済んだ方は差し戻せません" });
  const now = new Date().toISOString();
  const { data, error } = await c.sb.from("gw_hr_office_intakes")
    .update({ returned_at: now, returned_by: c.user.id, return_reason: reason })
    .eq("id", c.intake.id).eq("tenant_id", c.ctx.tenantId).is("returned_at", null).is("offer_id", null).select("id").maybeSingle();
  if (error) {
    if (["55000", "23514"].includes(error.code)) return json(c.res, 409, { error: "locked", hint: error.message });
    return failed(c.res, error);
  }
  if (!data) return json(c.res, 409, { error: "conflict", hint: "直前に状態が変わりました。開き直してください" });
  await event(c, "returned", { message: reason });
  // ヒアリングの写し（確認前・例外の承認なし）。HR が確かめ直して、もう一度引き渡す
  const copied = await copyHearing(c);
  await timeline(c, "office_returned", "Office から HR へ差し戻し（引き渡しの取り消し）", reason);
  await audit(c, "hr.office_intake_return", { hearingCopied: copied });
  return json(c.res, 200, { ok: true, returned: true, hearingCopied: copied });
}
async function copyHearing(c) {
  try {
    const { data: h } = await c.sb.from("gw_hr_hearings").select("*").eq("id", c.intake.hearing_id).eq("tenant_id", c.ctx.tenantId).maybeSingle();
    if (!h) return false;
    const keep = ["offer_type", "job_title", "duties", "desired_join_date", "work_location", "remote_policy", "weekly_days", "weekly_hours",
      "contract_period", "allowances_note", "other_note", "unresolved"];
    const now = new Date().toISOString();
    const row = { tenant_id: c.ctx.tenantId, applicant_id: c.applicant.id, recorded_by: h.recorded_by, recorded_at: now, updated_by: c.user.id, updated_at: now };
    for (const k of keep) row[k] = h[k] ?? null;
    row.unresolved = h.unresolved || [];
    const { data: made, error } = await c.sb.from("gw_hr_hearings").insert(row).select("id").single();
    if (error || !made) return false;
    const { data: p } = await c.sb.from("gw_hr_hearing_pay").select("desired_wage_type, desired_amount, desired_note").eq("hearing_id", h.id).maybeSingle();
    if (p) await c.sb.from("gw_hr_hearing_pay").insert({ hearing_id: made.id, tenant_id: c.ctx.tenantId, applicant_id: c.applicant.id, ...p, updated_by: c.user.id, updated_at: now });
    return true;
  } catch { return false; }
}

// ---- 採用条件の版・契約の手続き（HR と同じ関数を service role で呼ぶ） -------------------------------------

/** 会社の採用条件（版）を作る。採用区分は会社が決める（育成枠は不可）。給与・報酬を入れられるのは経営者だけ */
async function offerCreate(c) {
  const type = OFFER_TYPE_KEYS.includes(c.body.offerType) ? c.body.offerType : (c.intake.hearing_snapshot?.offer_type || null);
  if (!type || type === "training") return json(c.res, 400, { error: "invalid_body", hint: "採用区分を選んでください（育成枠は Office へ引き渡しません）" });
  if (currentOfferOf(c.facts.offers)) return json(c.res, 409, { error: "invalid_state", hint: "採用条件の版はすでにあります。いまの版を直すか、確定してください" });
  const input = { ...(canDecideSalary(c.ctx) ? c.body : dropSalaryInput(c.body)), applicantId: c.applicant.id };
  delete input.intake; delete input.action; delete input.offerType;
  const done = await createOffer(c.res, c.sb, c.ctx, c.user, c.salary, input, { via: "office", offerType: type });
  await sync(c);
  if (c.res.statusCode === 200) await audit(c, "hr.office_intake_offer_create", { offerType: type, salary: canDecideSalary(c.ctx) });
  return done;
}

async function offerUpdate(c) {
  const offer = await ownOffer(c.sb, c.ctx, c.intake, c.body.offerId);
  if (!offer) return json(c.res, 404, { error: "not_found" });
  const input = { ...(canDecideSalary(c.ctx) ? c.body : dropSalaryInput(c.body)), id: offer.id, action: "update" };
  delete input.intake; delete input.offerId;
  const done = await actOffer(c.req, c.res, c.sb, c.ctx, c.user, c.salary, input, { via: "office" });
  await sync(c);
  return done;
}

/** 版の操作（確定・URL の発行・送付済み・引き渡し〔社員登録へ進める準備〕）。確定は経営者だけ（給与・報酬を決めるため） */
async function offerStep(c, action, { owner = false } = {}) {
  if (owner && !canDecideSalary(c.ctx)) {
    return json(c.res, 403, { error: "forbidden", hint: "採用条件（給与・報酬）を確定できるのは経営者だけです。人事は条件の作成・書類の手続きまで行えます" });
  }
  const offer = await ownOffer(c.sb, c.ctx, c.intake, c.body.offerId);
  if (!offer) return json(c.res, 404, { error: "not_found" });
  const done = await actOffer(c.req, c.res, c.sb, c.ctx, c.user, c.salary, { id: offer.id, action }, { via: "office" });
  await sync(c);
  return done;
}

/** 正式PDFの流れでない版の LegalSign（URL の登録・手で案内した記録・締結の記録）。メールは送らない */
async function formal(c) {
  const step = FORMAL_STEPS.includes(c.body.step) ? c.body.step : null;
  if (!step) return json(c.res, 400, { error: "unknown_action" });
  const offer = await ownOffer(c.sb, c.ctx, c.intake, c.body.offerId);
  if (!offer) return json(c.res, 404, { error: "not_found" });
  if (step === "markFormalSigned" && !canAdvanceHire(c.ctx)) return json(c.res, 403, { error: "forbidden", hint: "締結の記録は、社長・管理者・人事が行います" });
  const input = { id: offer.id, action: step, url: c.body.url, channel: "manual", preview: Boolean(c.body.preview) };
  const done = await actOffer(c.req, c.res, c.sb, c.ctx, c.user, c.salary, input, { via: "office" });
  await sync(c);
  return done;
}

/** 契約手続き（db/139）。社労士への依頼・正式PDF の受領・照合・承認（給与を見られる人）・LegalSign の登録・締結（canAdvanceHire） */
async function contract(c) {
  const step = CONTRACT_STEPS.includes(c.body.step) ? c.body.step : null;
  if (!step) return json(c.res, 400, { error: "unknown_action" });
  const offer = await ownOffer(c.sb, c.ctx, c.intake, c.body.offerId);
  if (!offer) return json(c.res, 404, { error: "not_found" });
  const input = { ...c.body, offerId: offer.id, action: step };
  delete input.intake; delete input.step;
  const done = await contractAct(c.req, c.res, c.sb, c.ctx, c.user, c.salary, input);
  await sync(c);
  return done;
}
