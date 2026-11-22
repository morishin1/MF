import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { json, methodNotAllowed } from "../../lib/http.js";
import { jstDate } from "../../lib/timecard.js";
import { STATUS_LABEL } from "../../lib/sales-proposals.js";
import {
  boundedText, officeCheck, reviewAccess, reviewDay, reviewQueue, FIRST_REVIEW_DAY, REVIEW_REASONS, UUID,
} from "../../lib/enger-office-review.js";

const DAILY = "gw_enger_daily_reviews";
const CHECKS = "gw_enger_office_checks";
const MEETING_FIELDS = "note,next_step,agenda,office_confirmed_by,office_confirmed_at,enger_confirmed_by,enger_confirmed_at,revision";

const issue = (row) => ({
  id: row.id, sourceId: row.source_id, title: row.title, company: row.company_name,
  reason: REVIEW_REASONS[row.reason] || null, fact: row.fact,
});

const sameAgenda = (left, right) => left.length === right.length && left.every((row, index) =>
  row.id === right[index].id && row.reason === right[index].reason && row.fact === right[index].fact);

async function currentAgenda(sb, tenantId, day, today) {
  const result = await reviewQueue(sb, tenantId, day, today).eq("outcome", "discuss");
  if (result.error) throw result.error;
  return result.data.length >= 500 ? null : result.data.map(issue);
}

async function meeting(sb, tenantId, day) {
  const r = await sb.from(DAILY).select(MEETING_FIELDS).eq("tenant_id", tenantId).eq("review_day", day).maybeSingle();
  if (r.error) throw r.error;
  return r.data;
}

function safeMeeting(row) {
  if (!row) return null;
  const { office_confirmed_by, enger_confirmed_by, ...visible } = row;
  return visible;
}

const validRevision = (n) => Number.isSafeInteger(n) && n >= 0 && n < 2147483647;
const conflicted = (res) => json(res, 409, { error: "changed", hint: "別の更新がありました。再表示してから確認してください。" });

async function writeRow(res, sb, table, filter, revision, values) {
  const q = revision ? filter(sb.from(table).update({ ...values, revision: revision + 1 })).eq("revision", revision)
    : sb.from(table).insert({ ...values, revision: 1 });
  const result = await q.select("revision").maybeSingle();
  if (result.error?.code === "23505" || !result.error && !result.data) return conflicted(res);
  if (result.error) throw result.error;
  return json(res, 200, { revision: result.data.revision });
}

export async function runOfficeDailyReview(req, res, { sb, tenantId, user, roles, today }) {
  const body = req.body ?? {};
  const day = reviewDay(req.method === "GET" ? new URL(req.url, "http://localhost").searchParams.get("day") ?? today : body.day, today);
  if (!day) return json(res, 400, { error: "invalid_day" });

  if (req.method === "GET") {
    const [queue, record] = await Promise.all([
      reviewQueue(sb, tenantId, day, today),
      meeting(sb, tenantId, day),
    ]);
    if (queue.error) throw queue.error;
    return json(res, 200, {
      day, today, firstDay: FIRST_REVIEW_DAY, roles, reasons: REVIEW_REASONS, truncated: queue.data.length >= 500,
      rows: queue.data.map(row => ({
        ...issue(row), sentAt: row.sent_at, status: STATUS_LABEL[row.status] || row.status,
        outcome: row.outcome, reasonCode: row.reason, revision: row.revision || 0,
        checkedOn: row.checked_on, job: row.job_title, initials: row.talent_initials,
        companyResponse: row.job_action_type, candidateResponse: row.cand_action_type,
      })),
      meeting: safeMeeting(record),
      canConfirm: {
        office: roles.office && Boolean(record) && record.enger_confirmed_by !== user.id,
        enger: roles.enger && Boolean(record) && record.office_confirmed_by !== user.id,
      },
    });
  }

  if (!validRevision(body.revision)) return json(res, 400, { error: "invalid_revision" });
  if (body.action === "check") {
    if (!roles.office) return json(res, 403, { error: "office_only", hint: "Office担当が提案を確認できます。" });
    if (day !== today) return json(res, 400, { error: "check_today_only" });
    const check = officeCheck(body);
    if (!check || !UUID.test(body.id || "")) return json(res, 400, {
      error: "invalid_check", hint: "打ち合わせで確認する場合は、理由と確認した事実を入力してください。",
    });
    const row = await reviewQueue(sb, tenantId, day, today).eq("id", body.id).maybeSingle();
    if (row.error) throw row.error;
    if (!row.data) return json(res, 404, { error: "not_found" });
    return writeRow(res, sb, CHECKS, q => q.eq("tenant_id", tenantId).eq("proposal_id", body.id), body.revision, {
      tenant_id: tenantId, proposal_id: body.id, ...check, checked_by: user.id,
      checked_on: today, checked_at: new Date().toISOString(),
    });
  }

  if (!["save_meeting", "confirm_meeting"].includes(body.action)) return json(res, 400, { error: "invalid_action" });
  const record = await meeting(sb, tenantId, day);
  if ((record?.revision ?? 0) !== body.revision) return conflicted(res);
  const filter = q => q.eq("tenant_id", tenantId).eq("review_day", day);
  const stamp = { updated_at: new Date().toISOString(), updated_by: user.id };
  if (body.action === "save_meeting") {
    if (day !== today) return json(res, 400, { error: "record_today_only" });
    if (record?.office_confirmed_at && record.enger_confirmed_at) {
      return json(res, 409, { error: "meeting_complete", hint: "確認済みの記録です。追加の対応は次の打ち合わせで共有してください。" });
    }
    const note = boundedText(body.note, 1500);
    const next_step = boundedText(body.nextStep ?? "", 1000);
    if (!note || next_step === null) return json(res, 400, { error: "invalid_note", hint: "打ち合わせの確認結果を入力してください。" });
    const agenda = await currentAgenda(sb, tenantId, day, today);
    if (!agenda) return json(res, 409, { error: "agenda_too_large", hint: "確認事項が多すぎるため、Officeで確認済みの項目を整理してください。" });
    if (record?.note === note && record.next_step === next_step && sameAgenda(record.agenda, agenda)) {
      return json(res, 200, { revision: record.revision });
    }
    return writeRow(res, sb, DAILY, filter, body.revision, {
      tenant_id: tenantId, review_day: day, note, next_step, agenda, ...stamp,
      office_confirmed_by: null, office_confirmed_at: null, enger_confirmed_by: null, enger_confirmed_at: null,
    });
  }

  const side = body.side;
  if (!["office", "enger"].includes(side) || !roles[side]) {
    return json(res, 403, { error: "wrong_role", hint: "所属側の確認ボタンを使ってください。" });
  }
  if (!record) return json(res, 400, { error: "missing_meeting" });
  const other = side === "office" ? "enger" : "office";
  if (record[`${side}_confirmed_at`]) return json(res, 200, { revision: record.revision });
  if (record[`${other}_confirmed_by`] === user.id) {
    return json(res, 409, { error: "both_sides", hint: "もう一方の担当者が自分のアカウントで確認してください。" });
  }
  if (day === today) {
    const agenda = await currentAgenda(sb, tenantId, day, today);
    if (!agenda || !sameAgenda(record.agenda, agenda)) {
      return json(res, 409, { error: "agenda_changed", hint: "Officeの確認事項が更新されました。打ち合わせ記録を更新してから確認してください。" });
    }
  }
  return writeRow(res, sb, DAILY, filter, body.revision, {
    ...stamp, [`${side}_confirmed_at`]: stamp.updated_at, [`${side}_confirmed_by`]: user.id,
  });
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST"]);
  res.setHeader("Cache-Control", "no-store");
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const sb = admin();
    const ctx = await gwContext(user.id);
    const roles = await reviewAccess(sb, ctx, user);
    if (!roles.office && !roles.enger) return json(res, 403, { error: "forbidden", hint: "OfficeまたはENGERの社内担当者でログインしてください。" });
    return await runOfficeDailyReview(req, res, { sb, tenantId: ctx.tenantId, user, roles, today: jstDate() });
  } catch (error) {
    console.error("[enger-office-daily-review]", error?.code || "request_failed");
    return json(res, 500, { error: "unavailable", hint: "確認の記録を読み書きできませんでした。時間をおいて再表示してください。" });
  }
}
