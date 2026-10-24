// GET   /api/hr/applicants/detail?id=…  … 応募者1人ぶん（面談・タイムライン・合格通知つき）
// PATCH /api/hr/applicants/detail { id, ... } … 応募者本体を更新
// PATCH /api/hr/applicants/detail { id, action: "leadNextAction", nextAction, note? }
//       … 無限道場リードの面談後の次のアクション（体験案内・参加検討・申込…。lib/hr-lead-flow.js）
// PATCH /api/hr/applicants/detail { id, action: "moveStep", to, reason, dryRun?, acknowledgeWarnings? }
//       … 選考ステップを直接移動する（電話で面談・合格を確認した、など。lib/hr-step-move.js）。
//         メール・合格通知・契約・署名は作らない。送付済み・承諾済みの記録は消さない

import { checkRecruiter, notifyAssigned } from "../../../lib/hr-recruiter.js";
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
  STATUSES, STATUS_LABEL, STATUS_OPTIONS, statusChangeWarnings, withContactNext, applicantAlerts,
} from "../../../lib/hr.js";
import { contactStatusOf } from "../../../lib/hr-messages.js";
import { OFFER_TYPES_PUBLIC, offerTypeLabel, acceptFactsOf } from "../../../lib/hr-offer-types.js";
import { readOfferTypes } from "../../../lib/hr.js";
import { readContractStates } from "../../../lib/hr-contract-db.js";
import { OFFICIAL_TYPES, contractReady } from "../../../lib/hr-contract.js";
import { stepMoveOptions, stepMoveNotices, stepMoveLabel, normalizeMoveReason, REASON_MAX } from "../../../lib/hr-step-move.js";

const OFFER_TYPE_SQL = "db/129_hr_offer_type.sql";
// 採用区分を選べる状態（合格を決める・決めた直後。オファーを作ったあとは変えない）
const OFFER_TYPE_EDITABLE = ["ceo_decision_pending", "offer_draft_pending"];


import { selectWithLeadFields } from "../../../lib/hr-leads.js";
import {
  LEAD_NEXT_ACTIONS, LEAD_NEXT_ACTION_KEYS, leadNextActionPatch, leadNextActionLabel, isMugendojo,
} from "../../../lib/hr-lead-flow.js";

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

  const { data: a, error, leadReady } = await selectWithLeadFields((fields) => sb.from("gw_hr_applicants")
    .select(fields).eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle(), columns(salary));
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  if (!a) return json(res, 404, { error: "not_found" });
  const offerTypes = await readOfferTypes(sb, ctx.tenantId, [a.id]);
  a.offer_type = offerTypes.byId.get(a.id) ?? null;

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
  // db/136: 共通の面談資料。未適用の環境では採用HR全体を止めず、資料機能だけ not ready にする。
  let materialCatalog = [];
  let materialsReady = true;
  const materialsByInterview = new Map();
  try {
    const ab = admin();
    const [{ data: mats, error: me }, { data: links, error: le }] = await Promise.all([
      ab.from("gw_hr_materials").select("id,name,category,kind,url,filename,is_active,share_external,default_for_casual,sort_order")
        .eq("tenant_id", ctx.tenantId).eq("is_active", true).order("sort_order").order("created_at"),
      (interviews || []).length
        ? ab.from("gw_hr_interview_materials").select("interview_id,material_id,sort_order")
            .in("interview_id", (interviews || []).map((x) => x.id)).order("sort_order")
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (me) throw me;
    if (le) throw le;
    materialCatalog = (mats || []).map((m) => ({
      id: m.id, name: m.name, category: m.category, kind: m.kind,
      url: m.kind === "url" ? m.url : null, filename: m.filename || null,
      shareExternal: Boolean(m.share_external), defaultForCasual: Boolean(m.default_for_casual),
      sortOrder: m.sort_order,
    }));
    const byId = new Map(materialCatalog.map((m) => [m.id, m]));
    for (const link of links || []) {
      const m = byId.get(link.material_id);
      if (!m) continue;
      const list = materialsByInterview.get(link.interview_id) || [];
      list.push({ ...m, sortOrder: link.sort_order });
      materialsByInterview.set(link.interview_id, list);
    }
  } catch (e) {
    materialsReady = false;
  }

  const interviewerName = new Map((interviewers || []).map((e) => [e.id, e.display_name]));
  // 選考タイムラインの「誰が」。記録の created_by（ログインの ID）から社員名を引く。本人の操作（承諾など）は null
  // Office へ引き渡した人（gw_hr_offers.handoff_by。db/133）も同じ引き方で名前にする
  const actorIds = [...new Set([...(timeline || []).map((t) => t.created_by), ...(offers || []).map((o) => o.handoff_by)].filter(Boolean))];
  const { data: actors } = actorIds.length
    ? await sb.from("gw_employees").select("user_id, display_name").eq("tenant_id", ctx.tenantId).in("user_id", actorIds)
    : { data: [] };
  const actorName = new Map((actors || []).map((e) => [e.user_id, e.display_name]));
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
  // 正式契約（LegalSign）の段階（db/132。承諾した版の記録から。列が無い環境では null＝条件承諾済みのまま）
  const acceptedOffer = (offers || []).find((o) => o.accepted_at);
  // 承諾した版の正式契約の段階（db/132）・要否と Office への引き渡し（db/133）
  Object.assign(a, acceptFactsOf(acceptedOffer));
  // 社労士の正式PDFで進める版の、契約手続きの状態（db/139。表が無い環境では載せない＝これまでどおり）
  a.contract_state = (await readContractStates(sb, ctx.tenantId, [a], offers || [])).get(a.id) ?? null;
  // 契約手続き（db/139）が使えるか。オファーを作る前（区分を選んだあと）は列があるかを確かめる（画面のオファー入力の出し分け）
  let contractOn = (offers || []).some((o) => contractReady(o));
  if (!contractOn && !(offers || []).length && OFFICIAL_TYPES.includes(a.offer_type) && a.status === "offer_draft_pending") {
    const probe = await sb.from("gw_hr_offers").select("doc_route").eq("tenant_id", ctx.tenantId).limit(1);
    contractOn = !probe.error;
  }

  const shaped = withContactNext({
    ...shapeApplicant(
      a,
      nextInterview && { id: nextInterview.id, scheduledAt: nextInterview.scheduled_at, kind: nextInterview.kind },
      current && { sentAt: current.sent_at, viewedAt: current.viewed_at, expiresAt: current.expires_at },
    ),
    nextInterviewAt: nextInterview?.scheduled_at || null,
    recruiterName: recruiter?.display_name || null,
    // 本人への連絡状況（未連絡／連絡済み）。タイムラインの判断・連絡の記録から決める（lib/hr-messages.js）
    // 無限道場リードの decision（保留・対象外）は採用の選考結果ではないので、連絡状況は出さない
    contact: contactStatusOf(isMugendojo(a) ? null : a.decision, timeline),
  });
  // 上部のステップから直接移動できる先（lib/hr-step-move.js。無限道場リードは対象外）
  const moves = isMugendojo(a) ? null : stepMoveOptions(a, { offers: offers || [], interviews: interviews || [], canDecide: canDecideHire(ctx) });
  return json(res, 200, {
    // 警告（起きてはいけない状態。一覧と同じ lib/hr.js applicantAlerts）
    applicant: { ...shaped, alerts: applicantAlerts(shaped) },
    stepMoves: moves && {
      current: moves.current, locked: moves.locked,
      options: moves.options.map(({ key, label, state, reason }) => ({ key, label, state, reason })),
    },
    interviewers: interviewers || [],
    interviews: (interviews || []).map((i) => ({
      ...shapeInterview(i), interviewerName: interviewerName.get(i.interviewer_id) || null,
      materials: materialsByInterview.get(i.id) || [],
    })),
    materialCatalog,
    materialsReady,
    // 評価UI・面談予定フォームの元。画面側で項目を持たない（ここが正）
    evalItems: EVAL_ITEMS, evalScale: EVAL_SCALE, ranks: RANKS, rankLabel: RANK_LABEL,
    interviewKinds: INTERVIEW_KINDS,
    // 状態プルダウンの選択肢（lib/hr.js の STATUSES / STATUS_LABEL が正）
    statusOptions: STATUS_OPTIONS,
    // TimeRexの日程調整URL（環境変数未設定ならnull。README「TimeRex連携」指示書 §7）。
    // 無限道場リードは無限道場の予約枠（同じメールの採用応募者と取り違えないよう、予約枠を分けている）
    schedulingUrl: schedulingUrlFor(isMugendojo(a)
      ? process.env.TIMEREX_MUGENDOJO_CASUAL_URL : process.env.TIMEREX_CASUAL_INTERVIEW_URL, a.id),
    schedulingUrlEnv: isMugendojo(a) ? "TIMEREX_MUGENDOJO_CASUAL_URL" : "TIMEREX_CASUAL_INTERVIEW_URL",
    // 無限道場リードの次のアクションの選択肢（lib/hr-lead-flow.js が正。画面側に定義を持たない）
    leadNextActions: isMugendojo(a) ? LEAD_NEXT_ACTIONS.map(({ key, label }) => ({ key, label })) : [],
    leadReady,
    timeline: (timeline || []).map((t) => ({
      id: t.id, eventKey: t.event_key, label: t.label, detail: t.detail, occurredAt: t.occurred_at,
      actorName: t.created_by ? (actorName.get(t.created_by) || null) : null,
    })),
    // 合格後の採用区分の定義（lib/hr-offer-types.js が正。画面側に定義を持たない）。
    // offerTypeReady=false は db/129 が未適用（採用区分を選ぶ操作だけ止まる）
    offerTypes: OFFER_TYPES_PUBLIC, offerTypeReady: offerTypes.ready,
    // 契約手続き（社労士の正式PDF・db/139）：使える環境か・正式PDFで進める区分（画面のオファー入力・書類タブの出し分け）
    contract: { ready: contractOn, types: OFFICIAL_TYPES },
    // 通知書は候補者専用URLの平文を含まないので、そのまま返してよい（tokenは無い）
    offers: (offers || []).map((o) => ({ ...shapeOffer(o), handoffByName: o.handoff_by ? (actorName.get(o.handoff_by) || null) : null })),
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
  if (body.action === "leadNextAction") return setLeadNextAction(res, sb, ctx, user, body);
  if (body.action === "moveStep") return moveStep(res, sb, ctx, user, body);
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
  // 保留にするときは、保留理由・次に確認すること・再判断期限の3つが要る（NEXT ACTION を具体的にするため）
  if (row.value.decision === "hold") {
    const missing = [
      !row.value.hold_reason && "保留理由", !row.value.hold_next_step && "次に確認すること",
      !row.value.decision_due_on && "再判断期限",
    ].filter(Boolean);
    if (missing.length) return json(res, 400, { error: "invalid_body", detail: `保留にするには${missing.join("・")}を入力してください`, hint: `保留にするには${missing.join("・")}を入力してください` });
  }
  if (before.status === "ceo_decision_pending" && CEO_DECISION_FIELDS.some((k) => body[k] !== undefined)
      && !canDecideHire(ctx)) {
    return json(res, 403, { error: "forbidden", hint: "採用判断は社長・管理者だけができます" });
  }
  // 採用区分（db/129）。合格を決めるとき・決めた直後（オファー作成前）だけ選べる／変えられる
  let beforeOfferType = null;
  if ("offer_type" in row.value) {
    if (!OFFER_TYPE_EDITABLE.includes(before.status)) {
      return json(res, 409, { error: "invalid_state", hint: "オファーを作ったあとは、採用区分を変えられません" });
    }
    const { data: ot, error: oterr } = await sb.from("gw_hr_applicants").select("offer_type")
      .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (oterr) {
      return json(res, 503, { error: "not_ready", hint: `採用区分を使うには ${OFFER_TYPE_SQL} を Supabase に流してください` });
    }
    beforeOfferType = ot?.offer_type ?? null;
  }

  const { data, error } = await sb.from("gw_hr_applicants")
    .update({ ...splitWage(row.value).base, updated_at: new Date().toISOString() })
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).select(columns(salary)).maybeSingle();
  if (error) {
    const hint = "offer_type" in row.value ? dbSetupHint(error, OFFER_TYPE_SQL) : null;
    if (hint) return json(res, 503, { error: "not_ready", hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  }
  if (!data) return json(res, 404, { error: "not_found" });
  if ("offer_type" in row.value) data.offer_type = row.value.offer_type;
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
    // 社長推薦されたら（選考は社長面談へ・状態は社長面談設定待ち）、判断できる人（社長・管理者）へ知らせる。
    // 通知は増やしすぎない（同じ応募者は1件にまとめる）
    if (row.value.stage === "ceo_interview" && row.value.status === "ceo_interview_pending") {
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
      : row.value.decision === "hired" ? "合格" : row.value.decision === "hold" ? "保留にした" : "決定を取り消した";
    const detail = row.value.decision === "hold" ? (data.hold_next_step || null)
      : data.rank ? `ランク${data.rank}` : null;
    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: body.id,
      event_key: `decision_${row.value.decision || "cleared"}`, label, detail, created_by: user.id,
    });
  }

  // 採用区分を選んだ・変えたときは、選考の履歴に残す（「10/11 業務委託を選択」）
  if ("offer_type" in row.value && row.value.offer_type !== beforeOfferType) {
    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: body.id, event_key: "offer_type_selected",
      label: row.value.offer_type ? `採用区分：${offerTypeLabel(row.value.offer_type)}を選択` : "採用区分を外した",
      detail: beforeOfferType ? `変更前：${offerTypeLabel(beforeOfferType)}` : null, created_by: user.id,
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
    await notifyAssigned(notify, { tenantId: ctx.tenantId, recruiterId: row.value.recruiter_id, actorEmployeeId: ctx.employee?.id || null,
      applicants: [{ id: body.id, name: before.name }] });
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

// ---- 無限道場リード：面談後の次のアクション ------------------------------------------
// PATCH { id, action: "leadNextAction", nextAction, note? }
//   stage / status / decision を、選んだアクションの値にする（lib/hr-lead-flow.js の LEAD_NEXT_ACTIONS）。
//   採用の応募者には使えない（採用の判断は既存の評価・社長判断の流れで行う）。
//   選考タイムラインと監査ログに残す（誰が・何を選んだか）。メモは任意（500文字まで）
async function setLeadNextAction(res, sb, ctx, user, body) {
  if (!LEAD_NEXT_ACTION_KEYS.includes(body.nextAction)) {
    return json(res, 400, { error: "invalid_body", detail: `nextAction は ${LEAD_NEXT_ACTION_KEYS.join(" / ")} のいずれかです` });
  }
  const note = String(body.note ?? "").trim().slice(0, 500) || null;

  const { data: before, error: berr, leadReady } = await selectWithLeadFields((fields) => sb.from("gw_hr_applicants")
    .select(fields).eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle(), FIELDS);
  if (berr) return json(res, 500, { error: "db_query_failed", detail: berr.message });
  if (!before) return json(res, 404, { error: "not_found" });
  if (!leadReady) return json(res, 503, { error: "not_ready", hint: "管理者に db/118_hr_leads.sql の実行を依頼してください" });
  if (!isMugendojo(before)) {
    return json(res, 400, { error: "not_lead", hint: "次のアクションは無限道場リードだけで使えます" });
  }

  const patch = leadNextActionPatch(body.nextAction);
  // 保留の「次の確認事項」は既存の hold_next_step に入れる（NEXT ACTION にそのまま出る）
  if (body.nextAction === "hold") patch.hold_next_step = note;
  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_hr_applicants")
    .update({ ...patch, updated_at: now })
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).select("*").maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });

  const label = leadNextActionLabel(body.nextAction);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: body.id, event_key: `lead_next_${body.nextAction}`,
    label: `次のアクション：${label}`, detail: note, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.lead_next_action",
    target: `hr_applicant:${body.id}`,
    detail: { nextAction: body.nextAction, from: { stage: before.stage, status: before.status },
              to: { stage: data.stage, status: data.status } },
  });

  const { data: interviews } = await sb.from("gw_hr_interviews")
    .select("id, kind, scheduled_at, conducted_at, canceled_at")
    .eq("applicant_id", body.id).eq("tenant_id", ctx.tenantId);
  const next = pickNextInterview(data, interviews);
  return json(res, 200, {
    applicant: shapeApplicant(data, next && { id: next.id, scheduledAt: next.scheduled_at, kind: next.kind }),
  });
}

// ---- 選考ステップを直接移動する -------------------------------------------------------
// PATCH { id, action: "moveStep", to, reason, dryRun?, acknowledgeWarnings? }
//   dryRun=true … 変更せず、注意（warnings：確認が要る）と案内（notes）だけ返す。理由は要らない
//   本番 … 理由（必須・500文字まで）。注意があるのに acknowledgeWarnings が無ければ 409
//   変えるのは stage・status（内定へ進めるときだけ decision=hired も）。同時に別の人が動かしていたら 409（読み直し）
//   メール・合格通知・契約・署名・面談の取消・通知は行わない（lib/hr-step-move.js）
async function moveStep(res, sb, ctx, user, body) {
  const to = String(body.to || "");
  const { data: before, error: berr } = await selectWithLeadFields((fields) => sb.from("gw_hr_applicants")
    .select(fields).eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle(), FIELDS);
  if (berr) return json(res, 500, { error: "db_query_failed", detail: berr.message });
  if (!before) return json(res, 404, { error: "not_found" });
  if (isMugendojo(before)) return json(res, 400, { error: "not_recruit", hint: "無限道場リードは「次のアクション」で進めます" });

  const [{ data: offers, error: oerr }, { data: interviews, error: ierr }] = await Promise.all([
    sb.from("gw_hr_offers").select("*").eq("applicant_id", body.id).eq("tenant_id", ctx.tenantId),
    sb.from("gw_hr_interviews").select("id, kind, scheduled_at, conducted_at, canceled_at, timerex_event_id")
      .eq("applicant_id", body.id).eq("tenant_id", ctx.tenantId),
  ]);
  // 承諾・送付の記録を確かめられないときは動かさない（記録を守る側に倒す）
  if (oerr || ierr) return json(res, 500, { error: "db_query_failed", hint: "合格通知・面談の記録を読めませんでした。時間をおいてやり直してください" });

  const moves = stepMoveOptions(before, { offers: offers || [], interviews: interviews || [], canDecide: canDecideHire(ctx) });
  const opt = moves.options.find((o) => o.key === to);
  if (!opt) return json(res, 400, { error: "invalid_body", detail: "to が不正です" });
  if (opt.state === "current") return json(res, 400, { error: "no_change", hint: "いまのステップです" });
  if (opt.state === "blocked") return json(res, 409, { error: "step_blocked", hint: opt.reason });

  const { warnings, notes } = stepMoveNotices(before, opt, { offers: offers || [], interviews: interviews || [] });
  const labels = { from: stepMoveLabel(before.stage, before.status), to: stepMoveLabel(opt.target.stage, opt.target.status) };
  if (body.dryRun) return json(res, 200, { dryRun: true, warnings, notes, ...labels });

  const reason = normalizeMoveReason(body.reason);
  if (!reason) return json(res, 400, { error: "reason_required", hint: `移動の理由を入力してください（${REASON_MAX}文字まで）` });
  if (warnings.length && !body.acknowledgeWarnings) {
    return json(res, 409, { error: "step_move_warning", warnings, notes, ...labels, hint: warnings.join("\n") });
  }

  const decide = opt.target.decision && before.decision !== opt.target.decision;
  const now = new Date().toISOString();
  const patch = { stage: opt.target.stage, status: opt.target.status, updated_at: now, ...(decide ? { decision: opt.target.decision } : {}) };
  // 読んだときと同じ stage・status の行だけを書く（別の人が同時に動かしていたら、上書きせずに止める）
  const { data, error } = await sb.from("gw_hr_applicants").update(patch)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).eq("stage", before.stage).eq("status", before.status)
    .select(FIELDS).maybeSingle();
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 409, { error: "stale", hint: "ほかの操作で選考の状態が変わりました。画面を開き直してから、もう一度選んでください" });

  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: body.id, event_key: "step_moved",
    label: `ステップを移動：${opt.label}`,
    detail: `変更前：${labels.from} → 変更後：${labels.to}／理由：${reason}`, created_by: user.id,
  });
  // 合格を記録したときは、判断の記録も残す（本人への連絡状況＝未連絡 の判定に使う。lib/hr-messages.js）
  if (decide) {
    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: body.id, event_key: `decision_${opt.target.decision}`,
      label: "合格（ステップ移動で記録）", detail: `理由：${reason}`, created_by: user.id,
    });
  }
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_step_move",
    target: `hr_applicant:${body.id}`,
    detail: {
      from: { stage: before.stage, status: before.status, decision: before.decision ?? null },
      to: { stage: data.stage, status: data.status, decision: data.decision ?? null },
      reason, warnings: warnings.length, acknowledged: Boolean(body.acknowledgeWarnings),
    },
  });

  const next = pickNextInterview(data, interviews);
  return json(res, 200, {
    applicant: shapeApplicant(data, next && { id: next.id, scheduledAt: next.scheduled_at, kind: next.kind }),
    warnings, notes, ...labels,
  });
}
