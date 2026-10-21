// POST /api/hr/applicants/bulk { ids: [...], action, status?, recruiterId? }
//   action: "delete" | "setStatus" | "setRecruiter"
//
// ■ 大事な状態は一括で飛び越えさせない・契約の履歴は消させない（lib/hr-state-guard.js。機能フラグに関係なく）
//   setStatus：承諾済み・完了・合格通知の段階へは入れない。社員登録済み・承諾済み・Office へ引き渡し済みの人は動かさない。
//              社長判断待ちの出入りは社長・管理者だけ。社長合格の人は「辞退」「募集終了」へだけ。
//              1人でも当てはまれば、何も変えずに 409（だれが・なぜ を返す）
//   delete   ：オファーの版（handoff_at を含む）・社労士への依頼・正式PDF・社長判断・ヒアリング・早期引き渡しのある人が
//              1人でも入っていれば、何も消さずに 409。DB でも db/143 の gw_hr_applicants_guard が止める
//   （以前は、どの status へも・どの応募者でも変えられ、削除でオファー等も一緒に消えていた）
//
// 応募者一覧の複数選択操作（採用HR応募者一覧・ドロワーUI改善指示書 §1）。
//
// ■ 削除は選考終了とは別の操作（同指示書 §2）
//   辞退・見送りは既存のstage/status（合格通知フロー・採用判断）で扱う。
//   ここでの delete は「登録ミス等で応募者レコードそのものを削除する」操作で、
//   gw_hr_interviews/gw_hr_timeline も on delete cascade で一緒に消える（契約の履歴がある人は上のとおり消さない）
//   （面談"キャンセル"は別途 /api/hr/interviews の action=cancel。物理削除しない）。
//
// ■ ページ内選択だけを対象にする
//   idsは呼び出し側（画面）が明示的に選んだものだけ。ここでは絞り込み条件を
//   受け取らない＝「意図せず全DBを対象にしない」（同指示書 §1）。

import { checkRecruiter, notifyAssigned } from "../../../lib/hr-recruiter.js";
import { notify } from "../../../lib/notify.js";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit, canDecideHire } from "../../../lib/gw.js";
import { userClient, admin } from "../../../lib/supabase.js";
import { statusChangeBlock, contractHistoryOf, historyBlockedBody } from "../../../lib/hr-state-guard.js";
import { activeIntakeIds } from "../../../lib/hr-office-intake.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { STATUSES } from "../../../lib/hr.js";

const SQL = "db/081_hr_recruiting.sql";
const MAX_IDS = 200;

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const body = await readJson(req);
  const ids = Array.isArray(body?.ids)
    ? [...new Set(body.ids.filter((id) => typeof id === "string" && id))] : [];
  if (!ids.length) return json(res, 400, { error: "invalid_body", required: ["ids"] });
  if (ids.length > MAX_IDS) {
    return json(res, 400, { error: "invalid_body", detail: `一度に選べるのは${MAX_IDS}件までです` });
  }

  const sb = userClient(req);
  // 自テナント内に実在する行だけに絞る（他テナントのidが混ざっていても弾く）
  const { data: rows, error: selErr } = await sb.from("gw_hr_applicants").select("id, name, status, decision, employee_id")
    .in("id", ids).eq("tenant_id", ctx.tenantId);
  if (selErr) {
    const hint = dbSetupHint(selErr, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: selErr.message });
  }
  if (!(rows || []).length) return json(res, 404, { error: "not_found" });

  if (body.action === "delete") return doDelete(res, sb, ctx, user, rows);
  if (body.action === "setStatus") return doSetStatus(res, sb, ctx, user, rows, body.status);
  if (body.action === "setRecruiter") return doSetRecruiter(res, sb, ctx, user, rows, body.recruiterId);
  return json(res, 400, { error: "unknown_action" });
}

async function doDelete(res, sb, ctx, user, rows) {
  const ids = rows.map((r) => r.id);
  let history;
  try {
    history = await contractHistoryOf(admin(), ctx.tenantId, ids);
  } catch (e) {
    return json(res, 500, { error: "db_query_failed", detail: e?.message || String(e) });
  }
  if (history.size) return json(res, 409, historyBlockedBody(rows, history));
  const { error } = await sb.from("gw_hr_applicants").delete().in("id", ids).eq("tenant_id", ctx.tenantId);
  if (error) {
    // DB の安全装置（db/143）が止めたとき（読んだあとに履歴ができた等）
    if (error.code === "23503") return json(res, 409, { error: "has_contract_history", hint: error.message });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
  }
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_delete",
    target: `hr_applicant:${ids.join(",")}`, detail: { count: ids.length, names: rows.map((r) => r.name) },
  });
  return json(res, 200, { deleted: ids.length });
}

async function doSetStatus(res, sb, ctx, user, rows, status) {
  if (!STATUSES.includes(status)) return json(res, 400, { error: "invalid_body", detail: "status が不正です" });
  const ids = rows.map((r) => r.id);
  let moved;
  try {
    moved = await activeIntakeIds(admin(), ctx.tenantId, ids);
  } catch (e) {
    return json(res, 500, { error: "db_query_failed", detail: e?.message || String(e) });
  }
  const canDecide = canDecideHire(ctx);
  const blocked = [];
  for (const r of rows) {
    const b = statusChangeBlock({ before: r, to: status, canDecide, movedToOffice: moved.has(r.id), bulk: true });
    if (b) blocked.push({ id: r.id, name: r.name, status: b.status, error: b.error, hint: b.hint });
  }
  if (blocked.length) {
    const code = blocked.every((b) => b.status === 403) ? 403 : 409;
    return json(res, code, {
      error: code === 403 ? "forbidden" : "protected_state", blocked,
      hint: `変えられない応募者がいるため、何も変えていません（${blocked.map((b) => `${b.name}：${b.hint}`).join("／")}）`,
    });
  }
  const { error } = await sb.from("gw_hr_applicants")
    .update({ status, updated_at: new Date().toISOString() }).in("id", ids).eq("tenant_id", ctx.tenantId);
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_bulk_status",
    target: `hr_applicant:${ids.join(",")}`, detail: { count: ids.length, status },
  });
  return json(res, 200, { updated: ids.length });
}

async function doSetRecruiter(res, sb, ctx, user, rows, recruiterId) {
  const rc = await checkRecruiter(sb, ctx.tenantId, recruiterId);
  if (!rc.ok) return json(res, 400, rc);
  const value = rc.value;
  const ids = rows.map((r) => r.id);
  const { error } = await sb.from("gw_hr_applicants")
    .update({ recruiter_id: value, updated_at: new Date().toISOString() }).in("id", ids).eq("tenant_id", ctx.tenantId);
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: error.message });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.applicant_bulk_recruiter",
    target: `hr_applicant:${ids.join(",")}`, detail: { count: ids.length, recruiterId: value },
  });
  await notifyAssigned(notify, { tenantId: ctx.tenantId, recruiterId: value, actorEmployeeId: ctx.employee?.id || null, applicants: rows });
  return json(res, 200, { updated: ids.length });
}
