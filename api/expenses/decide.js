// POST /api/expenses/decide  { id, action, note? }
//   action = approve … 承認する。金額がしきい値以上なら代表の承認待ちへ送る
//            reject  … 却下する
//            cancel  … 取り下げる（本人、または管理部・経営者）
//            pay     … 支払済みにする（承認済みのものだけ）
//
// なぜ API なのか:
//   RLS では列単位の制限が書けない。本人に UPDATE を許すと、自分の申請を
//   approved に書き換えられてしまう。そこで DB 側では本人の書き込みを塞ぎ、
//   ここで「取り下げだけ」に絞って service_role で書く。
//
// 2段目（代表）の承認は owner 権限を持つ人だけが押せる。
// 管理部が1段目と2段目を続けて押せてしまうと、金額のしきい値を置いた意味が無くなる。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { canReviewExpense, loadWorkflowSettings, nextStatusFor, yen, STATUS_LABEL } from "../../lib/expenses.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import { gwLog } from "../../lib/gw-audit.js";

const ACTIONS = ["approve", "reject", "cancel", "pay"];

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const body = await readJson(req);
  if (!body?.id || !ACTIONS.includes(body.action)) {
    return json(res, 400, { error: "invalid_body", required: ["id", `action(${ACTIONS.join("|")})`] });
  }

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  // 認可の判定に使うので、RLS を通さずに素の行を読む
  const sb = admin();
  const { data: report, error } = await sb
    .from("gw_expense_reports")
    .select("id, tenant_id, employee_id, title, total_amount, status, payment_method, " +
            "applicant:gw_employees!gw_expense_reports_employee_id_fkey(id, display_name)")
    .eq("id", body.id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!report) return json(res, 404, { error: "report_not_found" });

  const isReviewer = canReviewExpense(ctx);
  const isOwner = ctx.roles.includes("owner");
  const isMine = !!ctx.employee && report.employee_id === ctx.employee.id;

  if (body.action === "cancel") {
    if (!isMine && !isReviewer) return json(res, 403, { error: "forbidden" });
  } else if (!isReviewer) {
    return json(res, 403, { error: "forbidden" });
  }

  const settings = await loadWorkflowSettings(ctx.tenantId);
  const now = new Date().toISOString();
  const note = body.note ? String(body.note).slice(0, 500) : null;
  const patch = { updated_at: now, decision_note: note };

  switch (body.action) {
    case "approve": {
      if (report.status === "pending") {
        patch.status = nextStatusFor(report.total_amount, settings);
        patch.approved_by = ctx.employee?.id || null;
        patch.approved_at = now;
        // 1段で終わる場合は、2段目の欄は空のままにする
      } else if (report.status === "pending_owner") {
        if (!isOwner) {
          return json(res, 403, {
            error: "owner_required",
            hint: `${yen(settings.expense_owner_threshold)}以上のため、代表の承認が必要です`,
          });
        }
        patch.status = "approved";
        patch.owner_approved_by = ctx.employee?.id || null;
        patch.owner_approved_at = now;
      } else {
        return json(res, 409, { error: "not_pending", hint: `すでに「${STATUS_LABEL[report.status]}」です` });
      }
      break;
    }
    case "reject": {
      if (report.status !== "pending" && report.status !== "pending_owner") {
        return json(res, 409, { error: "not_pending", hint: `すでに「${STATUS_LABEL[report.status]}」です` });
      }
      patch.status = "rejected";
      break;
    }
    case "cancel": {
      if (report.status === "paid") {
        return json(res, 409, { error: "already_paid", hint: "支払済みのものは取り消せません" });
      }
      if (report.status === "rejected" || report.status === "cancelled") {
        return json(res, 409, { error: "already_closed" });
      }
      // 承認後の取り下げは、本人だけでは通さない（経理の処理が進んでいる可能性がある）
      if (report.status === "approved" && !isReviewer) {
        return json(res, 409, { error: "already_approved", hint: "承認後の取り消しは管理部へご連絡ください" });
      }
      patch.status = "cancelled";
      break;
    }
    case "pay": {
      if (report.status !== "approved") {
        return json(res, 409, { error: "not_approved", hint: "承認済みのものだけ支払記録を付けられます" });
      }
      patch.status = "paid";
      patch.paid_on = body.paidOn || now.slice(0, 10);
      patch.paid_by = ctx.employee?.id || null;
      break;
    }
  }

  const { data: saved, error: ue } = await sb
    .from("gw_expense_reports")
    .update(patch)
    .eq("id", report.id)
    .select("id, status, approved_at, owner_approved_at, paid_on, decision_note")
    .single();
  if (ue) return json(res, 500, { error: "db_update_failed", detail: ue.message });

  await announce({ ctx, report, saved, action: body.action, note, isMine, settings });

  await gwLog({
    tenantId: ctx.tenantId, actorId: ctx.employee?.id || null,
    action: `expense.${body.action}`, target: report.id,
    detail: { amount: report.total_amount, status: saved.status, title: report.title },
  });

  return json(res, 200, { report: saved });
}

// 申請者への通知と、次の承認者への引き継ぎ
async function announce({ ctx, report, saved, action, note, isMine, settings }) {
  const amount = yen(report.total_amount);

  // 2段目に回った場合は、代表にだけ知らせる。申請者には状況が変わっていないので出さない
  if (saved.status === "pending_owner") {
    const { data: owners } = await admin()
      .from("gw_role_grants")
      .select("employee_id")
      .eq("tenant_id", ctx.tenantId)
      .eq("role", "owner");
    await notify((owners || []).map((o) => ({
      tenantId: ctx.tenantId, employeeId: o.employee_id,
      kind: "expense",
      title: "経費精算の承認依頼（代表）",
      body: `${report.applicant?.display_name || ""}／${amount}／${report.title}`,
      link: "admin-expenses.html",
      dedupeKey: `expense:${report.id}`,
    })));
    await notifySlack({
      text: `:memo: 経費精算が代表承認待ちになりました　${amount}`,
      lines: [report.title, `${yen(settings.expense_owner_threshold)}以上のため2段目の承認が必要です`],
      link: "admin-expenses.html",
    });
    return;
  }

  // 本人が自分で取り下げたときまで本人に知らせる必要はない
  if (action === "cancel" && isMine) return;

  const label = {
    approved: "承認されました", rejected: "却下されました",
    cancelled: "取り消されました", paid: "支払処理が完了しました",
  }[saved.status];
  if (!label || !report.employee_id) return;

  await notify([{
    tenantId: ctx.tenantId, employeeId: report.employee_id,
    kind: "expense",
    title: `経費精算が${label}`,
    body: `${amount}／${report.title}${note ? `\n${note}` : ""}`,
    link: "expenses.html",
    dedupeKey: `expense:${report.id}`,
  }]);

  if (saved.status === "approved") {
    await notifySlack({
      text: `:white_check_mark: 経費精算を承認　${report.applicant?.display_name || ""}　${amount}`,
      lines: [report.title],
      link: "admin-expenses.html",
    });
  }
}
