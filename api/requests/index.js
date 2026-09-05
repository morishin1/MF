// GET    /api/requests?scope=mine|pending|all&kind=leave|ringi&year=YYYY
//          … 申請の一覧。有給の残日数も一緒に返す
// POST   /api/requests   … 申請する
// DELETE /api/requests?id=…  … 削除（管理部・経営者のみ）
//
// 承認の道すじは固定。有給は管理部の1段、稟議は管理部→代表の2段。
// 設定にしていないのは、迷いどころを増やさないため（詳細は db/019_requests.sql）。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";
import { canReviewExpense } from "../../lib/expenses.js";
import {
  KINDS, LEAVE_TYPES, LEAVE_LABEL, fiscalYear, leaveBalance, leaveLabel, yen,
} from "../../lib/requests.js";
import { approverEmployeeIds } from "../../lib/bookings.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";

const FIELDS =
  "id, tenant_id, employee_id, kind, title, body, leave_type, starts_on, ends_on, days, amount, " +
  "status, approved_at, owner_approved_at, decision_note, gcal_link, gcal_error, created_at";
const WITH_NAMES =
  `${FIELDS}, applicant:gw_employees!gw_requests_employee_id_fkey(id, display_name, department)`;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  if (req.method === "GET") return list(req, res, ctx);
  if (req.method === "POST") return create(req, res, ctx);
  if (req.method === "DELETE") return remove(req, res, ctx);
  return methodNotAllowed(res, ["GET", "POST", "DELETE"]);
}

// ---- 一覧 -------------------------------------------------------------------
async function list(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const canReview = canReviewExpense(ctx);
  const sb = userClient(req);

  let query = sb.from("gw_requests").select(WITH_NAMES).eq("tenant_id", ctx.tenantId);

  const scope = q.get("scope") || (canReview ? "all" : "mine");
  if (scope === "mine") {
    if (!ctx.employee) return json(res, 200, { requests: [], canReview: false });
    query = query.eq("employee_id", ctx.employee.id);
  } else if (scope === "pending") {
    query = query.in("status", ["pending", "pending_owner"]);
  }
  if (KINDS.includes(q.get("kind"))) query = query.eq("kind", q.get("kind"));

  const { data, error } = await query.order("created_at", { ascending: false }).limit(500);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  const year = Number(q.get("year")) || fiscalYear();
  return json(res, 200, {
    requests: data || [],
    canReview,
    isOwner: ctx.roles.includes("owner"),
    balance: ctx.employee ? await leaveBalance(ctx.employee.id, year) : null,
    me: ctx.employee ? { id: ctx.employee.id, name: ctx.employee.display_name } : null,
  });
}

// ---- 申請 -------------------------------------------------------------------
async function create(req, res, ctx) {
  if (!ctx.employee) {
    return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません。管理者に登録を依頼してください" });
  }

  const body = await readJson(req);
  const row = normalize(body);
  if (row.error) return json(res, 400, row);

  const sb = userClient(req);

  // 有給は、同じ日にすでに出している分と重ならないかを見る。
  // 二重申請は残日数の計算を狂わせるので、入口で止める
  if (row.value.kind === "leave") {
    const { data: clash } = await sb
      .from("gw_requests")
      .select("id, starts_on, ends_on")
      .eq("employee_id", ctx.employee.id)
      .eq("kind", "leave")
      .in("status", ["pending", "approved"])
      .lte("starts_on", row.value.ends_on)
      .gte("ends_on", row.value.starts_on)
      .limit(1);
    if (clash?.length) {
      return json(res, 409, { error: "overlaps", hint: "同じ日にすでに休暇の申請があります" });
    }
  }

  const { data: request, error } = await sb
    .from("gw_requests")
    .insert({ ...row.value, tenant_id: ctx.tenantId, employee_id: ctx.employee.id, status: "pending" })
    .select(FIELDS)
    .single();
  if (error) {
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  const name = ctx.employee.display_name;
  const label = request.kind === "leave" ? leaveLabel(request) : (request.amount ? yen(request.amount) : "金額なし");
  const heading = request.kind === "leave" ? "休暇の申請" : "稟議の申請";

  const approvers = await approverEmployeeIds(ctx.tenantId);
  await notify(approvers.filter((id) => id !== ctx.employee.id).map((employeeId) => ({
    tenantId: ctx.tenantId, employeeId,
    kind: "request",
    title: heading,
    body: `${name}／${label}／${request.title}`,
    link: "admin-requests.html",
    dedupeKey: `request:${request.id}`,
  })));

  await notifySlack({
    text: `${request.kind === "leave" ? ":palm_tree:" : ":page_facing_up:"} ${heading}　${name}`,
    lines: [request.title, label],
    link: "admin-requests.html",
  });

  return json(res, 200, {
    request,
    // 稟議は代表の承認まで進むことを、出した時点で伝える
    twoStage: request.kind === "ringi",
    balance: request.kind === "leave" ? await leaveBalance(ctx.employee.id) : null,
  });
}

// ---- 削除 -------------------------------------------------------------------
async function remove(req, res, ctx) {
  if (!canReviewExpense(ctx)) return json(res, 403, { error: "forbidden" });
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const { error } = await userClient(req)
    .from("gw_requests")
    .delete()
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId);
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
  return json(res, 200, { ok: true, id });
}

// ---- 入力の検証 -------------------------------------------------------------
function normalize(body) {
  const kind = body?.kind;
  if (!KINDS.includes(kind)) return { error: "invalid_kind", detail: KINDS.join(", ") };

  const title = String(body?.title ?? "").trim();
  if (!title) return { error: "invalid_body", hint: "件名を入力してください" };

  const v = { kind, title: title.slice(0, 200), body: body?.body ? String(body.body).slice(0, 2000) : null };

  if (kind === "ringi") {
    if (body?.amount !== undefined && body.amount !== null && body.amount !== "") {
      const n = Number(body.amount);
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000_000) {
        return { error: "invalid_amount", hint: "金額を確認してください" };
      }
      v.amount = n;
    }
    if (!v.body) return { error: "invalid_body", hint: "稟議の内容を書いてください" };
    return { value: v };
  }

  // 有給
  if (!LEAVE_TYPES.includes(body?.leaveType)) {
    return { error: "invalid_leave_type", detail: Object.keys(LEAVE_LABEL).join(", ") };
  }
  const d = /^\d{4}-\d{2}-\d{2}$/;
  if (!d.test(body?.startsOn || "") || !d.test(body?.endsOn || "")) {
    return { error: "invalid_date", hint: "日付を選んでください" };
  }
  if (body.endsOn < body.startsOn) {
    return { error: "invalid_date", hint: "終了日は開始日以降にしてください" };
  }

  const days = Number(body?.days);
  if (!(days > 0) || days > 365) return { error: "invalid_days", hint: "日数を確認してください" };
  // 半休は1日だけ、かつ 0.5 日でなければ数字と種別が食い違う
  const half = body.leaveType === "am" || body.leaveType === "pm";
  if (half && (body.startsOn !== body.endsOn || days !== 0.5)) {
    return { error: "invalid_days", hint: "半休は1日分（0.5日）で申請してください" };
  }

  v.leave_type = body.leaveType;
  v.starts_on = body.startsOn;
  v.ends_on = body.endsOn;
  v.days = days;
  return { value: v };
}
