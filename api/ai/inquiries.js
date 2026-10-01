// GET /api/ai/inquiries … 問い合わせの一覧。
//   管理サイド（canManageAiInquiries＝owner/admin・人事・責任者・経理）… テナント内
//   すべて（共通受信箱。要件 §12）。canManageHr だけに絞らない（PCの紛失はIT・総務、
//   経費精算は経理の話題で、人事の話題とは限らないため）
//   それ以外 … 自分が出した分だけ
// POST /api/ai/inquiries … 管理部へ問い合わせる。
//   threadId あり … そのAI相談を要約して引き継ぐ（要件 §11）
//   threadId なし … AIを経由しない直接の問い合わせ（要件 §13 の「小さく残す」導線）

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageAiInquiries } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { CATEGORY_CODES } from "../../lib/ai-knowledge.js";
import { buildEscalationSummary } from "../../lib/ai-escalate.js";
import { gwLog } from "../../lib/gw-audit.js";

const SQL = "db/110_ai_assistant.sql";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });

  const sb = admin();

  if (req.method === "GET") {
    try {
      let q = sb.from("gw_ai_inquiries")
        .select("id, employee_id, ai_thread_id, category, subject, status, assigned_employee_id, created_at, updated_at")
        .eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(200);
      if (!canManageAiInquiries(ctx)) q = q.eq("employee_id", ctx.employee.id);
      const { data: inquiries, error } = await q;
      if (error) throw error;

      const empIds = [...new Set((inquiries || []).flatMap((i) => [i.employee_id, i.assigned_employee_id].filter(Boolean)))];
      let names = new Map();
      if (empIds.length) {
        const { data: emps } = await sb.from("gw_employees").select("id, display_name").in("id", empIds);
        for (const e of emps || []) names.set(e.id, e.display_name);
      }

      return json(res, 200, {
        inquiries: (inquiries || []).map((i) => ({
          ...i,
          employeeName: names.get(i.employee_id) || null,
          assignedName: i.assigned_employee_id ? (names.get(i.assigned_employee_id) || null) : null,
        })),
      });
    } catch (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 200, { notReady: true, message: hint, inquiries: [] });
      return json(res, 500, { error: "db_error", detail: error.message });
    }
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    try {
      let subject, summary, category, aiThreadId = null;

      if (body.threadId) {
        const { data: thread } = await sb.from("gw_ai_threads")
          .select("id, tenant_id, employee_id, title, category").eq("id", body.threadId).maybeSingle();
        if (!thread || thread.tenant_id !== ctx.tenantId || thread.employee_id !== ctx.employee.id) {
          return json(res, 404, { error: "not_found" });
        }

        // この相談はもう問い合わせ済み（二度押し）なら、作り直さずそれを返す
        const { data: existingRows, error: existingErr } = await sb.from("gw_ai_inquiries")
          .select("id, category, subject, status, created_at").eq("ai_thread_id", thread.id).limit(1);
        if (existingErr) throw existingErr;
        if (existingRows && existingRows.length) {
          return json(res, 200, { inquiry: existingRows[0] });
        }

        const { data: messages } = await sb.from("gw_ai_messages")
          .select("id, role, content, created_at").eq("thread_id", thread.id).order("created_at", { ascending: true });
        const lastAssistant = [...(messages || [])].reverse().find((m) => m.role === "assistant");
        let sources = [];
        if (lastAssistant) {
          const { data } = await sb.from("gw_ai_sources").select("title").eq("message_id", lastAssistant.id);
          sources = data || [];
        }
        ({ subject, summary, category } = buildEscalationSummary(thread, messages || [], sources));
        aiThreadId = thread.id;
      } else {
        const note = String(body.note || "").trim();
        if (!note) return json(res, 400, { error: "note_required" });
        subject = note.slice(0, 80);
        summary = note;
        category = CATEGORY_CODES.includes(body.category) ? body.category : null;
      }

      const { data: inquiry, error } = await sb.from("gw_ai_inquiries").insert({
        tenant_id: ctx.tenantId, employee_id: ctx.employee.id, ai_thread_id: aiThreadId,
        category, subject, summary, status: "new",
      }).select("id, category, subject, status, created_at").single();
      if (error) throw error;

      await sb.from("gw_ai_inquiry_messages").insert({
        tenant_id: ctx.tenantId, inquiry_id: inquiry.id,
        sender_type: "system", content: summary,
      });

      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id, action: "ai.inquiry.create",
        target: inquiry.id, detail: { subject, category, byAi: Boolean(aiThreadId) },
      });

      return json(res, 200, { inquiry });
    } catch (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 200, { notReady: true, message: hint });
      return json(res, 500, { error: "db_error", detail: error.message });
    }
  }

  return methodNotAllowed(res, ["GET", "POST"]);
}
