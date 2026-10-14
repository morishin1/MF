// GET /api/cron/hr-daily
// 毎朝1回（日本時間 8:40）。採用担当が「今日やること」を見落とさないよう、次の行動が要るものだけ知らせる
// （HRフロー仕様 §16。一斉に大量には送らない）。
//
//   今日が面談日           … 面談担当（いなければ採用担当）へ。面談1件につき1回
//   判断期限が近い・超過     … 採用担当へ。期限が今日・明日・過ぎている応募者。応募者1人につき1日1回
//   回答期限切れ           … 採用担当へ。オファー（版）1件につき1回
//   Office 引き渡し待ち     … 採用担当へ。NEXT ACTION が「Office へ引き渡す」のまま。応募者1人につき1回
//
// ■ 新しい通知基盤は作らない
//   既存の gw_notifications（kind: 'hr'）と dedupe_key だけ（api/cron/hr-interviews.js と同じ）。
//   ignoreDuplicates で流すので、同じ用件は cron が何度回っても増えない（既読を未読に戻さない）。
//
// 認証: CRON_SECRET があれば Authorization: Bearer <secret> を要求する。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { interviewKindLabel, CLOSED_STATUSES, readFormalStates, shapeApplicant } from "../../lib/hr.js";
import { ymd as jstYmd, time as jstTime } from "../../lib/jst.js";

const MAX_ROWS = 1000;
const DAY_MS = 86400000;
// 回答待ちのまま期限が来るオファーの状態（lib/hr.js nextActionOf の AWAITING_RESPONSE と同じ）
const AWAITING = ["offer_send_pending", "offer_resend_pending", "offer_sent", "offer_viewed", "offer_response_pending"];

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.authorization || "") !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });

  const sb = admin();
  const now = new Date();
  const today = jstYmd(now);
  const tomorrow = jstYmd(new Date(now.getTime() + DAY_MS));
  const rows = [];

  // 選考中の採用の応募者（無限道場などのリードは除く）
  const { data: applicants, error } = await sb.from("gw_hr_applicants").select("*").limit(MAX_ROWS);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  const recruit = (applicants || []).filter((a) => !a.lead_category || a.lead_category === "recruitment");
  const byId = new Map(recruit.map((a) => [a.id, a]));
  const link = (a) => `/hr/applicants.html?id=${a.id}`;

  // 1) 今日が面談日（実施前・キャンセルでない。日本時間の今日）
  const from = new Date(`${today}T00:00:00+09:00`).toISOString();
  const to = new Date(`${today}T23:59:59+09:00`).toISOString();
  const { data: ivs } = await sb.from("gw_hr_interviews")
    .select("id, tenant_id, applicant_id, kind, scheduled_at, interviewer_id, conducted_at, canceled_at")
    .gte("scheduled_at", from).lte("scheduled_at", to).limit(MAX_ROWS);
  for (const i of ivs || []) {
    const a = byId.get(i.applicant_id);
    if (!a || i.conducted_at || i.canceled_at) continue;
    const target = i.interviewer_id || a.recruiter_id;
    if (!target) continue;
    rows.push({
      tenantId: i.tenant_id, employeeId: target, kind: "hr", title: "今日は面談日です",
      body: `${a.name}\n${jstTime(i.scheduled_at)} ${interviewKindLabel(i.kind)}`,
      link: link(a), dedupeKey: `hr_interview_today:${i.id}:${today}`,
    });
  }

  // 2) 判断期限が近い（今日・明日）・過ぎている
  for (const a of recruit) {
    if (!a.decision_due_on || !a.recruiter_id || CLOSED_STATUSES.includes(a.status)) continue;
    const over = a.decision_due_on < today;
    if (!over && ![today, tomorrow].includes(a.decision_due_on)) continue;
    rows.push({
      tenantId: a.tenant_id, employeeId: a.recruiter_id, kind: "hr",
      title: over ? "対応期限を過ぎています" : a.decision_due_on === today ? "今日が対応期限です" : "明日が対応期限です",
      body: `${a.name}（期限 ${a.decision_due_on}）`,
      link: link(a), dedupeKey: `hr_due:${a.id}:${today}`,
    });
  }

  // 3) 回答期限切れ（回答待ちのまま、いま有効な版の期限が過ぎた）
  const waiting = recruit.filter((a) => AWAITING.includes(a.status) && a.recruiter_id);
  if (waiting.length) {
    const { data: offers } = await sb.from("gw_hr_offers")
      .select("id, applicant_id, expires_at, revoked_at, accepted_at, declined_at")
      .in("applicant_id", waiting.map((a) => a.id)).is("revoked_at", null).limit(MAX_ROWS);
    for (const o of offers || []) {
      if (o.accepted_at || o.declined_at || !o.expires_at || new Date(o.expires_at) >= now) continue;
      const a = byId.get(o.applicant_id);
      if (!a) continue;
      rows.push({
        tenantId: a.tenant_id, employeeId: a.recruiter_id, kind: "hr", title: "オファーの回答期限が切れました",
        body: `${a.name}\nURLを再発行するか、本人へ確認してください`,
        link: link(a), dedupeKey: `hr_offer_expired:${o.id}`,
      });
    }
  }

  // 4) Office への引き渡し待ち（条件を承諾し、引き渡せる状態のまま。育成枠は LMS へ進むので除く）
  const accepted = recruit.filter((a) => a.status === "accepted" && a.offer_type && a.offer_type !== "training" && a.recruiter_id);
  const byTenant = new Map();
  for (const a of accepted) byTenant.set(a.tenant_id, [...(byTenant.get(a.tenant_id) || []), a]);
  for (const [tenantId, list] of byTenant) {
    const facts = await readFormalStates(sb, tenantId, list.map((a) => a.id));
    if (!facts.ready) continue;
    for (const a of list) {
      const f = facts.byId.get(a.id);
      // 画面の NEXT ACTION が「Office へ引き渡す」になっているものだけ（正式契約待ちなどは除く。lib/hr.js nextActionOf と同じ判定）
      if (!f || shapeApplicant({ ...a, ...f }).nextActionKey !== "handoff") continue;
      rows.push({
        tenantId, employeeId: a.recruiter_id, kind: "hr", title: "Office への引き渡しを待っています",
        body: `${a.name}\n条件の承諾が済んでいます。内容を確認して Office へ引き渡してください`,
        link: link(a), dedupeKey: `hr_handoff_wait:${a.id}`,
      });
    }
  }

  const { created } = await notify(rows, { replace: false });
  return json(res, 200, { ok: true, candidates: rows.length, notified: created });
}
