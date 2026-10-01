// POST  /api/hr/interviews { applicantId, kind, scheduledAt, interviewerId, meetingUrl, method }
//         … 面談を予定する。応募者の状態を「面談予定」へ進める
// PATCH /api/hr/interviews { id, action }
//         "conduct"  … 実施済みにする。応募者の状態を「評価入力待ち」へ
//         "evaluate" … 5項目評価・ランク・所感を保存。ランクから対応ステータスを機械的に進める
//                       （ただし社長推薦・見送りの最終確定はここでは行わない。README §5・§7）
//         "update"   … 面談情報（日時・面談担当・面談方法・面談URL・録画URL）を直す（状態は動かさない）。
//                       日時を変えたら選考タイムラインに残す。監査ログには「どの項目を変えたか」だけを残す。
//                       TimeRex同期済みの面談は、日時・面談URLを変えられない（下の「TimeRexとの両立」）
//         "memo"     … その面談に紐づくメモを保存する（db/109。応募者全体のメモとは別）。
//                       実施前・実施後・キャンセル済み、どの面談にも書ける
//         "cancel"   … 面談をキャンセルする。物理削除はせずcanceled_atを立てるだけ。
//
// ■ TimeRex 連携の面談（timerex_event_id がある）は、HR 側で日時・Meet URL・キャンセルを直接変えない
//   TimeRex を正とする。日程変更・取消は TimeRex の導線（面談タブの［日程変更］［取消］）から行い、
//   Webhook で反映する（lib/hr-timerex.js）。ここでは 409 timerex_managed で止める。
//   評価・実施済み・面談担当・録画URL・メモは、TimeRex 連携の面談でも HR で入力できる。
//                       応募者は日程調整のやり直し（カジュアル面談ならstatus=scheduling、
//                       社長面談ならstatus=ceo_interview_pending）へ戻す
//                       （採用HR応募者一覧・ドロワーUI改善指示書 §3）
//
// ■ 同じ面談を二重登録しない
//   同じ種別（カジュアル／社長）の、まだ実施していない・キャンセルしていない面談が
//   既にあれば断る。
//
// ■ TimeRexとの両立（db/089・lib/hr-timerex.js）
//   TimeRex由来の面談（timerex_event_id あり）は、日時・面談URLをTimeRex側が正とする。
//   Webhook（予約確定の再送・日程変更）が届くたびに lib/hr-timerex.js が scheduled_at・
//   meeting_url を無条件に上書きし、このアプリからTimeRexへは何も送らない（APIを持たない）。
//   アプリで日時だけを変えると、候補者のカレンダー・Google Meet・TimeRexとずれたうえ、
//   次のWebhookで黙って元に戻る。だからこの2つは409で断り、TimeRex側での変更を案内する。
//   面談担当・面談方法・録画URL・メモはアプリ側だけの情報で、Webhookも触らないので編集できる。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit } from "../../../lib/gw.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { notify } from "../../../lib/notify.js";
import { dateTime as jstDateTime } from "../../../lib/jst.js";
import {
  normalizeInterview, shapeInterview, nextStatusFromRank, interviewKindLabel, RANK_LABEL,
  decisionMakerEmployeeIds, interviewKindForStage, isTimerexInterview, TIMEREX_MANAGED_COLUMNS,
  INTERVIEW_MEMO_MAX,
} from "../../../lib/hr.js";

const SQL = "db/081_hr_recruiting.sql・083_hr_interview_meeting_url.sql・109_hr_interview_edit.sql";
const SQL_EDIT = "db/109_hr_interview_edit.sql";
// 面談の予定そのもの（キャンセル済みの面談では直させない）
const SCHEDULE_COLUMNS = ["scheduled_at", "interviewer_id", "meeting_url", "method"];

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
  // 面談担当は、同じ会社の社員だけ（編集と同じ規則。未定＝空は通す）
  const bad = await checkInterviewer(sb, ctx.tenantId, row.value.interviewer_id);
  if (bad) return json(res, 400, bad);

  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, name, stage, status")
    .eq("id", body.applicantId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant) return json(res, 404, { error: "not_found" });

  const { data: open } = await sb.from("gw_hr_interviews").select("id")
    .eq("applicant_id", applicant.id).eq("kind", row.value.kind)
    .is("conducted_at", null).is("canceled_at", null).limit(1);
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
      link: "/hr/ceo-review.html", dedupeKey: `hr_ceo_meeting:${data.id}`,
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
  if (body.action === "memo") return saveMemo(res, sb, ctx, user, iv, body);
  if (body.action === "cancel") return cancelInterview(res, sb, ctx, user, iv);
  return json(res, 400, { error: "unknown_action" });
}

async function conduct(res, sb, ctx, user, iv, body) {
  if (iv.canceled_at) return json(res, 409, { error: "interview_canceled", hint: "キャンセル済みの面談は実施済みにできません" });
  if (iv.conducted_at) return json(res, 409, { error: "already_conducted", hint: "この面談はすでに実施済みです" });
  // いまの選考段階と違う種類の面談（社長面談の段階で残っている古いカジュアル面談など）を実施済みにすると、
  // 応募者の状態が「評価入力待ち」へ戻ってしまう。段階に合う面談だけを実施済みにする
  const { data: at } = await sb.from("gw_hr_applicants").select("stage")
    .eq("id", iv.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  const stageKind = interviewKindForStage(at?.stage);
  if (stageKind && iv.kind !== stageKind) {
    return json(res, 409, {
      error: "interview_kind_mismatch",
      hint: `いまの選考段階は${interviewKindLabel(stageKind)}です。この${interviewKindLabel(iv.kind)}は実施済みにできません（不要ならキャンセルしてください）`,
    });
  }
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
      body: applicant?.name || null, link: "/hr/ceo-review.html", dedupeKey: `hr_ceo_decision:${iv.id}`,
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

const TIMEREX_MANAGED = {
  error: "timerex_managed",
  hint: "TimeRex連携済みの面談です。日程変更・取消はTimeRexから行ってください（HRへは自動で反映されます）",
};

async function updateInterview(res, sb, ctx, user, iv, body) {
  // 受け付ける項目は main と同じ（lib/hr.js normalizeInterview が読むもの。評価の所感などもここで入力できる）
  const row = normalizeInterview(body, { partial: true });
  if (row.error) return json(res, 400, row);
  const cols = Object.keys(row.value);
  if (!cols.length) return json(res, 400, { error: "invalid_body", detail: "更新する項目がありません" });

  // 値が変わらないものは「変更」として扱わない（画面は全項目を送ってくるため。
  // 109未適用の環境でも、面談方法を触らない保存はこれまでどおり通る）
  const norm = (v) => (v && typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));
  const same = (c) => norm(iv[c]) === norm(row.value[c])
    || (c === "scheduled_at" && iv[c] && row.value[c] && Date.parse(iv[c]) === Date.parse(row.value[c]));
  if (iv.canceled_at && cols.some((c) => SCHEDULE_COLUMNS.includes(c) && !same(c))) {
    return json(res, 409, { error: "already_canceled", hint: "キャンセル済みの面談は編集できません" });
  }
  // TimeRex 連携の面談は、日時・面談URLを TimeRex が正とする（変えようとしたら 409。
  // 同じ値のまま送られてきたもの＝画面の読み取り専用欄は、変更ではないので通す）
  if (isTimerexInterview(iv)) {
    const locked = TIMEREX_MANAGED_COLUMNS.filter((c) => c in row.value && !same(c));
    if (locked.length) return json(res, 409, { ...TIMEREX_MANAGED, fields: locked });
  }
  const changed = cols.filter((c) => !same(c));
  if (!changed.length) return json(res, 200, { interview: shapeInterview(iv), changed: [] });
  const patch = Object.fromEntries(changed.map((c) => [c, row.value[c]]));

  // 面談担当は、同じ会社の社員だけ（別の会社の人を指定させない。作成と同じ規則）
  const bad = await checkInterviewer(sb, ctx.tenantId, patch.interviewer_id);
  if (bad) return json(res, 400, bad);

  const { data, error } = await sb.from("gw_hr_interviews")
    .update(patch).eq("id", iv.id).eq("tenant_id", ctx.tenantId).select("*").single();
  if (error) {
    const hint = dbSetupHint(error, SQL_EDIT);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_update_failed", detail: error.message });
  }

  // 日時の変更は選考の経過なので、タイムラインにも残す（録画URL等の付け替えは残さない）
  if (changed.includes("scheduled_at")) {
    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: iv.applicant_id, event_key: "interview_rescheduled",
      label: `${interviewKindLabel(iv.kind)}の日時を変更`,
      detail: patch.scheduled_at ? fmtDateTime(patch.scheduled_at) : "日時未定", created_by: user.id,
    });
  }
  // 監査ログには「どの項目を変えたか」と日時の前後だけ。URL等の値そのものは残さない
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.interview_update", target: `hr_interview:${iv.id}`,
    detail: {
      applicantId: iv.applicant_id, fields: changed, timerex: isTimerexInterview(iv),
      ...(changed.includes("scheduled_at") ? { scheduledFrom: iv.scheduled_at || null, scheduledTo: patch.scheduled_at } : {}),
    },
  });

  return json(res, 200, { interview: shapeInterview(data), changed });
}

// 面談メモ（db/109）。その面談に紐づくメモで、応募者全体のメモ（gw_hr_applicants.note）とは別。
// 空で保存すると消える。TimeRex同期済みの面談でも書ける（Webhookはmemoを触らない）
async function saveMemo(res, sb, ctx, user, iv, body) {
  if (body.memo !== null && body.memo !== undefined && typeof body.memo !== "string") {
    return json(res, 400, { error: "invalid_body", detail: "メモは文字列で送ってください" });
  }
  if (body.memo === undefined) return json(res, 400, { error: "invalid_body", required: ["memo"] });
  const text = String(body.memo ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length > INTERVIEW_MEMO_MAX) {
    return json(res, 400, { error: "invalid_body", detail: `メモは${INTERVIEW_MEMO_MAX}文字以内にしてください` });
  }
  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_hr_interviews")
    .update({ memo: text || null, memo_updated_at: now, memo_updated_by: user.id })
    .eq("id", iv.id).eq("tenant_id", ctx.tenantId).select("*").single();
  if (error) {
    const hint = dbSetupHint(error, SQL_EDIT);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_update_failed", detail: error.message });
  }
  // メモの中身は監査ログに残さない（面談の所感は機微になりうる）。文字数だけ
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.interview_memo", target: `hr_interview:${iv.id}`,
    detail: { applicantId: iv.applicant_id, length: text.length, cleared: !text },
  });
  return json(res, 200, { interview: shapeInterview(data) });
}

// 面談をキャンセルする。物理削除しない（履歴・監査ログは残す。README「応募者一覧・
// ドロワーUI改善」指示書 §3・§6）。カジュアル面談ならstatus=schedulingへ、
// 社長面談ならstatus=ceo_interview_pendingへ戻し、それぞれのNEXT ACTIONで
// 「日程を設定し直す」ことだけを促す（採用判断そのものは動かさない）
async function cancelInterview(res, sb, ctx, user, iv) {
  if (iv.timerex_event_id) return json(res, 409, TIMEREX_MANAGED);
  if (iv.conducted_at) return json(res, 409, { error: "already_conducted", hint: "実施済みの面談はキャンセルできません" });
  if (iv.canceled_at) return json(res, 409, { error: "already_canceled", hint: "すでにキャンセルされています" });

  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_hr_interviews")
    .update({ canceled_at: now }).eq("id", iv.id).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  const nextStatus = iv.kind === "ceo" ? "ceo_interview_pending" : "scheduling";
  await sb.from("gw_hr_applicants").update({ status: nextStatus, updated_at: now })
    .eq("id", iv.applicant_id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: iv.applicant_id, event_key: "interview_canceled",
    label: `${interviewKindLabel(iv.kind)}をキャンセル`, created_by: user.id,
  });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "hr.interview_cancel", target: `hr_interview:${iv.id}` });

  return json(res, 200, { interview: shapeInterview(data), status: nextStatus });
}

/**
 * 面談担当の確認（作成・編集の両方で使う）。空（未定）は通す。
 * 値があれば同じテナントの社員か確かめ、違えば返すエラー本文、問題なければnull。
 * 在籍状態までは見ない（過去の面談の担当が退職していても、他の項目の編集を止めないため）
 */
async function checkInterviewer(sb, tenantId, interviewerId) {
  if (!interviewerId) return null;
  const { data: emp } = await sb.from("gw_employees").select("id")
    .eq("id", interviewerId).eq("tenant_id", tenantId).maybeSingle();
  return emp ? null : { error: "invalid_interviewer", hint: "面談担当は、この会社の社員から選んでください" };
}

// 通知・タイムラインの日時は日本時間（サーバは UTC）
const fmtDateTime = (iso) => jstDateTime(iso);
