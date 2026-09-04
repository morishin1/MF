// GET  /api/messages          … 自分が参加しているスレッド一覧（最新の1件と未読数つき）
// POST /api/messages          … スレッドを作る
//        { kind: 'dm'|'group', memberIds: [employeeId...], title? }
//        'dm' で相手との既存スレッドがあれば、それを返す（重複を作らない）
//
// スレッドの作成と参加者の追加は RLS では許可していない。
// 自分の参加行を書き換えて他人のスレッドへ入り込めてしまうため、
// ここを唯一の口にして service_role で書く。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません" });
  }

  if (req.method === "GET") return listThreads(req, res, ctx);
  if (req.method === "POST") return createThread(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function listThreads(req, res, ctx) {
  const sb = userClient(req);

  // 参加しているスレッドは RLS が絞ってくれる
  const { data: threads, error } = await sb
    .from("gw_threads")
    .select("id, kind, title, last_message_at, created_at")
    .eq("tenant_id", ctx.tenantId)
    .order("last_message_at", { ascending: false })
    .limit(100);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!threads?.length) return json(res, 200, { threads: [], me: ctx.employee });

  const ids = threads.map((t) => t.id);

  const [membersRes, myRowsRes, lastRes] = await Promise.all([
    sb.from("gw_thread_members")
      .select("thread_id, employee_id, employee:gw_employees(id, display_name, department)")
      .in("thread_id", ids),
    sb.from("gw_thread_members")
      .select("thread_id, last_read_at")
      .eq("employee_id", ctx.employee.id)
      .in("thread_id", ids),
    sb.from("gw_messages")
      .select("id, thread_id, sender_id, body, created_at")
      .in("thread_id", ids)
      .order("created_at", { ascending: false })
      .limit(400),
  ]);

  const membersBy = new Map();
  for (const m of membersRes.data || []) {
    if (!membersBy.has(m.thread_id)) membersBy.set(m.thread_id, []);
    membersBy.get(m.thread_id).push(m.employee || { id: m.employee_id });
  }

  const readAt = new Map((myRowsRes.data || []).map((r) => [r.thread_id, r.last_read_at]));

  // 直近400件から、スレッドごとの最新1件と未読数を求める。
  // 件数が増えたらページングに切り替える前提の暫定実装。
  const latest = new Map();
  const unread = new Map();
  for (const m of lastRes.data || []) {
    if (!latest.has(m.thread_id)) latest.set(m.thread_id, m);
    const since = readAt.get(m.thread_id);
    if (m.sender_id !== ctx.employee.id && since && m.created_at > since) {
      unread.set(m.thread_id, (unread.get(m.thread_id) || 0) + 1);
    }
  }

  return json(res, 200, {
    me: ctx.employee,
    threads: threads.map((t) => {
      const members = membersBy.get(t.id) || [];
      const others = members.filter((m) => m.id !== ctx.employee.id);
      return {
        ...t,
        members,
        // 1対1は相手の名前をスレッド名として使う
        displayName: t.kind === "group"
          ? (t.title || "グループ")
          : (others[0]?.display_name || "（退職者）"),
        lastMessage: latest.get(t.id) || null,
        unread: unread.get(t.id) || 0,
      };
    }),
  });
}

async function createThread(req, res, ctx, user) {
  const body = await readJson(req);
  const kind = body?.kind === "group" ? "group" : "dm";
  const memberIds = [...new Set((body?.memberIds || []).filter(Boolean))]
    .filter((id) => id !== ctx.employee.id);

  if (!memberIds.length) return json(res, 400, { error: "invalid_body", detail: "相手を1人以上選んでください" });
  if (kind === "dm" && memberIds.length !== 1) {
    return json(res, 400, { error: "invalid_body", detail: "1対1の相手は1人だけです" });
  }

  const sb = admin();

  // 相手が本当に同じテナントの社員か確かめる。ここを飛ばすと他社の社員IDを
  // 渡してスレッドに引き込めてしまう
  const { data: valid, error: ve } = await sb
    .from("gw_employees")
    .select("id")
    .eq("tenant_id", ctx.tenantId)
    .in("id", memberIds);
  if (ve) return json(res, 500, { error: "db_query_failed", detail: ve.message });
  if ((valid || []).length !== memberIds.length) {
    return json(res, 400, { error: "invalid_member", detail: "社員名簿にない相手が含まれています" });
  }

  // 1対1は作り直さない。既にあるスレッドを返す
  if (kind === "dm") {
    const existing = await findDmThread(sb, ctx.tenantId, ctx.employee.id, memberIds[0]);
    if (existing) return json(res, 200, { threadId: existing, existed: true });
  }

  const { data: thread, error } = await sb
    .from("gw_threads")
    .insert({
      tenant_id: ctx.tenantId,
      kind,
      title: kind === "group" ? (String(body.title || "").trim() || null) : null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  const rows = [ctx.employee.id, ...memberIds].map((employee_id) => ({
    tenant_id: ctx.tenantId, thread_id: thread.id, employee_id,
  }));
  const { error: me } = await sb.from("gw_thread_members").insert(rows);
  if (me) {
    // 参加者が入らないと誰にも見えないスレッドが残るので、作り直せるよう消す
    await sb.from("gw_threads").delete().eq("id", thread.id);
    return json(res, 500, { error: "db_insert_failed", detail: me.message });
  }

  return json(res, 200, { threadId: thread.id, existed: false });
}

// 2人だけが参加している dm スレッドを探す
async function findDmThread(sb, tenantId, meId, otherId) {
  const { data: mine } = await sb
    .from("gw_thread_members")
    .select("thread_id, gw_threads!inner(id, kind, tenant_id)")
    .eq("employee_id", meId)
    .eq("gw_threads.tenant_id", tenantId)
    .eq("gw_threads.kind", "dm");
  const candidates = (mine || []).map((r) => r.thread_id);
  if (!candidates.length) return null;

  const { data: theirs } = await sb
    .from("gw_thread_members")
    .select("thread_id")
    .eq("employee_id", otherId)
    .in("thread_id", candidates);
  const shared = (theirs || []).map((r) => r.thread_id);
  if (!shared.length) return null;

  // 3人以上のスレッドは除く
  const { data: counts } = await sb
    .from("gw_thread_members")
    .select("thread_id")
    .in("thread_id", shared);
  const n = new Map();
  for (const r of counts || []) n.set(r.thread_id, (n.get(r.thread_id) || 0) + 1);
  return shared.find((id) => n.get(id) === 2) || null;
}
