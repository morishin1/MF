// GET    /api/expenses?scope=mine|pending|all&period=YYYY-MM
//          … 申請の一覧（明細つき）とワークフロー設定
// GET    /api/expenses?format=csv&status=approved&period=YYYY-MM
//          … 会計に取り込むための CSV（承認できる立場の人のみ）
// POST   /api/expenses  { title, period, paymentMethod, lines:[...] }
//          … 申請する。ヘッダと明細をまとめて作る
// DELETE /api/expenses?id=…  … 削除（管理部・経営者のみ）
//
// 明細を後から書き換える口は用意していない。承認の途中で金額が変わると
// 「何を承認したのか」が分からなくなるため、直すときは取り消して出し直す。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import {
  canReviewExpense, loadWorkflowSettings, normalizeLines, nextStatusFor, yen,
} from "../../lib/expenses.js";
import { approverEmployeeIds } from "../../lib/bookings.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";

const REPORT_FIELDS =
  "id, tenant_id, employee_id, title, period, payment_method, total_amount, status, " +
  "approved_by, approved_at, owner_approved_by, owner_approved_at, paid_on, decision_note, created_at";
const LINE_FIELDS =
  "id, report_id, spent_on, category, payee, description, amount, tax_rate, invoice_registered, receipt_path, receipt_name";
const WITH_ALL =
  `${REPORT_FIELDS}, applicant:gw_employees!gw_expense_reports_employee_id_fkey(id, display_name, department), ` +
  `lines:gw_expense_lines(${LINE_FIELDS})`;

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
  const sb = userClient(req);
  const canReview = canReviewExpense(ctx);

  let query = sb.from("gw_expense_reports").select(WITH_ALL).eq("tenant_id", ctx.tenantId);

  const scope = q.get("scope") || (canReview ? "all" : "mine");
  if (scope === "mine") {
    if (!ctx.employee) return json(res, 200, { reports: [], canReview: false });
    query = query.eq("employee_id", ctx.employee.id);
  } else if (scope === "pending") {
    query = query.in("status", ["pending", "pending_owner"]);
  }
  if (q.get("period")) query = query.eq("period", q.get("period"));
  if (q.get("status")) query = query.eq("status", q.get("status"));
  else if (q.get("format") === "csv") {
    // 会計へ渡すのは承認が通ったものだけ。申請中や却下を混ぜない
    query = query.in("status", ["approved", "paid"]);
  }

  const { data, error } = await query.order("created_at", { ascending: false }).limit(500);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  if (q.get("format") === "csv") {
    if (!canReview) return json(res, 403, { error: "forbidden" });
    return csv(res, data || []);
  }

  const settings = await loadWorkflowSettings(ctx.tenantId);
  return json(res, 200, {
    reports: data || [],
    canReview,
    isOwner: ctx.roles.includes("owner"),
    settings,
    me: ctx.employee ? { id: ctx.employee.id, name: ctx.employee.display_name } : null,
  });
}

// ---- 申請 -------------------------------------------------------------------
async function create(req, res, ctx) {
  if (!ctx.employee) {
    return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません。管理者に登録を依頼してください" });
  }

  const body = await readJson(req);
  const title = String(body?.title ?? "").trim().slice(0, 200);
  if (!title) return json(res, 400, { error: "invalid_body", required: ["title", "lines"] });

  const settings = await loadWorkflowSettings(ctx.tenantId);
  const parsed = normalizeLines(body?.lines, settings);
  if (parsed.error) return json(res, 400, parsed);

  const paymentMethod = body?.paymentMethod === "corporate_card" ? "corporate_card" : "personal";
  const period = /^\d{4}-\d{2}$/.test(body?.period || "") ? body.period : null;
  const total = parsed.lines.reduce((s, l) => s + l.amount, 0);

  const sb = userClient(req);
  const { data: report, error } = await sb
    .from("gw_expense_reports")
    .insert({
      tenant_id: ctx.tenantId,
      employee_id: ctx.employee.id,
      title, period,
      payment_method: paymentMethod,
      total_amount: total,
      status: "pending",
    })
    .select(REPORT_FIELDS)
    .single();
  if (error) {
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  const { error: le } = await sb
    .from("gw_expense_lines")
    .insert(parsed.lines.map((l) => ({ ...l, tenant_id: ctx.tenantId, report_id: report.id })));
  if (le) {
    // 明細の入らない申請は意味を成さないので、ヘッダごと消して無かったことにする
    await admin().from("gw_expense_reports").delete().eq("id", report.id);
    return json(res, le.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: le.message });
  }

  const name = ctx.employee.display_name;
  const approvers = await approverEmployeeIds(ctx.tenantId);
  await notify(approvers.filter((id) => id !== ctx.employee.id).map((employeeId) => ({
    tenantId: ctx.tenantId, employeeId,
    kind: "expense",
    title: "経費精算の申請",
    body: `${name}／${yen(total)}／${title}`,
    link: "admin-expenses.html",
    dedupeKey: `expense:${report.id}`,
  })));

  await notifySlack({
    text: `:receipt: 経費精算の申請　${name}　${yen(total)}`,
    lines: [title, period ? `対象月 ${period}` : null, `明細 ${parsed.lines.length} 件`],
    link: "admin-expenses.html",
  });

  return json(res, 200, {
    report: { ...report, lines: parsed.lines },
    // しきい値を超えていれば、承認が2段になることを申請時に伝える
    twoStage: nextStatusFor(total, settings) === "pending_owner",
  });
}

// ---- 削除 -------------------------------------------------------------------
async function remove(req, res, ctx) {
  if (!canReviewExpense(ctx)) return json(res, 403, { error: "forbidden" });
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const { error } = await userClient(req)
    .from("gw_expense_reports")
    .delete()
    .eq("id", id)
    .eq("tenant_id", ctx.tenantId);
  if (error) return json(res, error.code === "42501" ? 403 : 500, { error: "db_delete_failed", detail: error.message });
  return json(res, 200, { ok: true, id });
}

// ---- CSV --------------------------------------------------------------------
// 会計ソフトに読ませる前提。Excel で開いても文字化けしないよう BOM を付ける
function csv(res, reports) {
  const head = [
    "日付", "勘定科目", "金額", "税率", "インボイス", "支払先", "摘要",
    "申請者", "支払方法", "対象月", "状態", "精算ID",
  ];
  const rows = [head];

  for (const r of reports) {
    for (const l of r.lines || []) {
      rows.push([
        l.spent_on, l.category, String(l.amount), `${l.tax_rate}%`,
        l.invoice_registered ? "有" : "無",
        l.payee || "", l.description || "",
        r.applicant?.display_name || "",
        r.payment_method === "corporate_card" ? "法人カード" : "立替",
        r.period || "", r.status, r.id,
      ]);
    }
  }

  const body = "﻿" + rows.map((cols) => cols.map(cell).join(",")).join("\r\n");
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="expenses.csv"`);
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
