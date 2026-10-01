// GET /api/ai/inquiry?id=...   問い合わせの中身（やりとり込み）
// POST /api/ai/inquiry         返信を送る（本人、または管理サイド＝canManageAiInquiries）
// PATCH /api/ai/inquiry        状態変更・担当者アサイン（管理サイドのみ。canManageAiInquiries）

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageAiInquiries } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const SQL = "db/113_ai_assistant.sql";
const STATUSES = ["new", "in_progress", "waiting_user", "resolved", "closed"];

async function loadInquiry(sb, ctx, id) {
  const { data: inquiry } = await sb.from("gw_ai_inquiries")
    .select("id, tenant_id, employee_id, ai_thread_id, category, subject, status, assigned_employee_id, created_at, updated_at")
    .eq("id", id).maybeSingle();
  if (!inquiry || inquiry.tenant_id !== ctx.tenantId) return null;
  const isOwner = inquiry.employee_id === ctx.employee.id;
  if (!isOwner && !canManageAiInquiries(ctx)) return null;
  return { inquiry, isOwner };
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });

  const sb = admin();

  if (req.method === "GET") {
    const id = new URL(req.url, "http://x").searchParams.get("id");
    if (!id) return json(res, 400, { error: "id_required" });
    try {
      const found = await loadInquiry(sb, ctx, id);
      if (!found) return json(res, 404, { error: "not_found" });

      const { data: messages, error } = await sb.from("gw_ai_inquiry_messages")
        .select("id, sender_type, sender_employee_id, content, created_at")
        .eq("inquiry_id", id).order("created_at", { ascending: true });
      if (error) throw error;

      return json(res, 200, { inquiry: found.inquiry, messages: messages || [] });
    } catch (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 200, { notReady: true, message: hint });
      return json(res, 500, { error: "db_error", detail: error.message });
    }
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const content = String(body.content || "").trim();
    if (!body.id || !content) return json(res, 400, { error: "invalid_body" });
    try {
      const found = await loadInquiry(sb, ctx, body.id);
      if (!found) return json(res, 404, { error: "not_found" });

      const senderType = found.isOwner ? "employee" : "admin";
      const { data: message, error } = await sb.from("gw_ai_inquiry_messages").insert({
        tenant_id: ctx.tenantId, inquiry_id: body.id,
        sender_type: senderType, sender_employee_id: ctx.employee.id, content,
      }).select("id, sender_type, sender_employee_id, content, created_at").single();
      if (error) throw error;

      const next = senderType === "admin" && ["new", "waiting_user"].includes(found.inquiry.status) ? "in_progress"
        : senderType === "employee" && found.inquiry.status === "waiting_user" ? "in_progress"
        : found.inquiry.status;
      await sb.from("gw_ai_inquiries").update({ status: next, updated_at: new Date().toISOString() }).eq("id", body.id);

      return json(res, 200, { message });
    } catch (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 200, { notReady: true, message: hint });
      return json(res, 500, { error: "db_error", detail: error.message });
    }
  }

  if (req.method === "PATCH") {
    if (!canManageAiInquiries(ctx)) return json(res, 403, { error: "forbidden" });
    const body = await readJson(req);
    if (!body.id) return json(res, 400, { error: "id_required" });
    const patch = {};
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return json(res, 400, { error: "invalid_status" });
      patch.status = body.status;
    }
    if (body.assignedEmployeeId !== undefined) patch.assigned_employee_id = body.assignedEmployeeId || null;
    if (!Object.keys(patch).length) return json(res, 400, { error: "nothing_to_update" });
    patch.updated_at = new Date().toISOString();

    try {
      const found = await loadInquiry(sb, ctx, body.id);
      if (!found) return json(res, 404, { error: "not_found" });

      const { error } = await sb.from("gw_ai_inquiries").update(patch).eq("id", body.id);
      if (error) throw error;

      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id, action: "ai.inquiry.update",
        target: body.id, detail: patch,
      });

      return json(res, 200, { ok: true });
    } catch (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 200, { notReady: true, message: hint });
      return json(res, 500, { error: "db_error", detail: error.message });
    }
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}
