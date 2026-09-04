// GET   /api/messages/thread?threadId=…  … スレッドの本文と参加者
// POST  /api/messages/thread             … 投稿 { threadId, body, fileId? }
// PATCH /api/messages/thread             … 既読にする { threadId }
//
// 参照と投稿は RLS が可否を決める（参加者だけ・自分名義だけ）。
// 既読の更新と last_message_at の更新は、自分の参加行を書き換えて他のスレッドに
// 入り込めないよう RLS では許可せず、ここで対象を絞って service_role で書く。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { notify, clearNotification } from "../../lib/notify.js";

const MAX_BODY = 4000;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });

  const sb = userClient(req);

  if (req.method === "GET") {
    const threadId = new URL(req.url, "http://localhost").searchParams.get("threadId");
    if (!threadId) return json(res, 400, { error: "invalid_query", required: ["threadId"] });

    // 参加していなければ RLS で 0 件になる。その場合は 404 と同じ扱いにする
    const { data: thread, error } = await sb
      .from("gw_threads")
      .select("id, kind, title, last_message_at")
      .eq("id", threadId)
      .maybeSingle();
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
    if (!thread) return json(res, 404, { error: "thread_not_found" });

    const [membersRes, messagesRes] = await Promise.all([
      sb.from("gw_thread_members")
        .select("employee_id, employee:gw_employees(id, display_name, department)")
        .eq("thread_id", threadId),
      sb.from("gw_messages")
        .select("id, thread_id, sender_id, body, created_at")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true })
        .limit(300),
    ]);
    if (messagesRes.error) {
      return json(res, 500, { error: "db_query_failed", detail: messagesRes.error.message });
    }

    // 添付。メッセージに結び付いたものだけを返す
    const { data: files } = await sb
      .from("gw_message_files")
      .select("id, message_id, filename, mime_type, size_bytes")
      .eq("thread_id", threadId)
      .not("message_id", "is", null);
    const byMessage = new Map();
    for (const f of files || []) {
      if (!byMessage.has(f.message_id)) byMessage.set(f.message_id, []);
      byMessage.get(f.message_id).push(f);
    }

    const members = (membersRes.data || []).map((m) => m.employee || { id: m.employee_id });
    const others = members.filter((m) => m.id !== ctx.employee.id);
    return json(res, 200, {
      thread: {
        ...thread,
        members,
        displayName: thread.kind === "group"
          ? (thread.title || "グループ")
          : (others[0]?.display_name || "（退職者）"),
      },
      messages: (messagesRes.data || []).map((m) => ({ ...m, files: byMessage.get(m.id) || [] })),
      me: ctx.employee,
    });
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    const text = String(body?.body ?? "").trim();
    const fileId = body?.fileId || null;
    // 添付だけを送ることもできる。本文が空でも fileId があれば通す
    if (!body?.threadId || (!text && !fileId)) {
      return json(res, 400, { error: "invalid_body", required: ["threadId", "body または fileId"] });
    }
    if (text.length > MAX_BODY) {
      return json(res, 400, { error: "body_too_long", detail: `${MAX_BODY}文字までです` });
    }

    const { data, error } = await sb
      .from("gw_messages")
      .insert({
        tenant_id: ctx.tenantId,
        thread_id: body.threadId,
        sender_id: ctx.employee.id,
        body: text,
      })
      .select("id, thread_id, sender_id, body, created_at")
      .single();
    // 参加していないスレッドへの投稿は RLS が弾く
    if (error) {
      return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
    }

    const sbAdmin = admin();

    // 預けてあった添付をこのメッセージに結び付ける。
    // 同じスレッドの、まだどのメッセージにも付いていないものだけを対象にする
    let attached = null;
    if (fileId) {
      const { data: f } = await sbAdmin
        .from("gw_message_files")
        .update({ message_id: data.id })
        .eq("id", fileId)
        .eq("thread_id", body.threadId)
        .eq("tenant_id", ctx.tenantId)
        .is("message_id", null)
        .select("id, filename, mime_type")
        .maybeSingle();
      attached = f || null;
    }

    // 一覧の並び順に使う。失敗しても投稿自体は成立しているので止めない
    await sbAdmin
      .from("gw_threads")
      .update({ last_message_at: data.created_at })
      .eq("id", body.threadId);
    // 自分が書いたものは自分にとって既読
    await markRead(sbAdmin, body.threadId, ctx.employee.id, data.created_at);

    // 同じスレッドの他の参加者に通知する。連投しても1件にまとまる
    await notifyThread(sbAdmin, ctx, body.threadId, text || `ファイル：${attached?.filename || "添付"}`);

    return json(res, 200, { message: { ...data, files: attached ? [attached] : [] } });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    if (!body?.threadId) return json(res, 400, { error: "invalid_body", required: ["threadId"] });

    // 参加していることを確かめてから既読にする
    const { data: thread } = await sb
      .from("gw_threads").select("id").eq("id", body.threadId).maybeSingle();
    if (!thread) return json(res, 404, { error: "thread_not_found" });

    await markRead(admin(), body.threadId, ctx.employee.id, new Date().toISOString());
    await clearNotification(ctx.employee.id, `message:${body.threadId}`);
    return json(res, 200, { ok: true });
  }

  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

// スレッドの参加者（自分以外）へ新着を知らせる。
// 本文はそのスレッドを読める人にしか届かないので、先頭だけ載せる。
async function notifyThread(sbAdmin, ctx, threadId, text) {
  const [{ data: members }, { data: thread }] = await Promise.all([
    sbAdmin.from("gw_thread_members").select("employee_id").eq("thread_id", threadId),
    sbAdmin.from("gw_threads").select("kind, title").eq("id", threadId).maybeSingle(),
  ]);

  const others = (members || [])
    .map((m) => m.employee_id)
    .filter((id) => id && id !== ctx.employee.id);
  if (!others.length) return;

  const where = thread?.kind === "group" ? `（${thread.title || "グループ"}）` : "";
  const snippet = text.replace(/\s+/g, " ").slice(0, 60);

  await notify(others.map((employeeId) => ({
    tenantId: ctx.tenantId,
    employeeId,
    kind: "message",
    title: `${ctx.employee.display_name} さんからメッセージ${where}`,
    body: snippet,
    link: `messages.html?t=${threadId}`,
    dedupeKey: `message:${threadId}`,
  })));
}

function markRead(sbAdmin, threadId, employeeId, at) {
  return sbAdmin
    .from("gw_thread_members")
    .update({ last_read_at: at })
    .eq("thread_id", threadId)
    .eq("employee_id", employeeId);
}
