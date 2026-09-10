// GET /api/badges … サイドメニューに出す「対応が要る件数」
//
// ■ 何を数えるか
//   「自分が動かないと進まないもの」だけを数える。
//   ただ存在しているだけのもの（未完了タスク・過去の日報）は数えない。
//   いつも数字が付いているバッジは、そこにある時点で意味を失う。
//
// ■ 1回で全部返す
//   画面ごとに件数を取りに行くと、どの画面を開いてもAPIが増える。
//   サイドメニューはどの画面にもあるので、まとめて1回で返す。
//
// ■ 数えるだけ。中身は返さない
//   件数だけなら head:true で行を読まずに済む。
//   中身が要るときは、それぞれの画面が自分で取りにいく。

import { json, methodNotAllowed } from "./../lib/http.js";
import { requireUser } from "./../lib/auth.js";
import { gwContext, canManageHr } from "./../lib/gw.js";
import { admin } from "./../lib/supabase.js";
import { canReviewExpense } from "./../lib/expenses.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !ctx.employee) return json(res, 200, { badges: {} });

  const sb = admin();
  const me = ctx.employee.id;
  const hr = canManageHr(ctx);
  const expenseReviewer = canReviewExpense(ctx);

  // 表がまだ無い環境でも、メニューは出したい。
  // 1つ数えられなくても、ほかの数字まで落とさない
  const count = async (fn) => {
    try {
      const { count: n } = await fn();
      return n || 0;
    } catch (e) {
      console.error("[badges] 数えられませんでした:", e?.message || e);
      return 0;
    }
  };
  const H = { count: "exact", head: true };

  const [messages, contracts, esign, expenses, requests, timefix, proposals, devices] = await Promise.all([
    unreadMessages(sb, me),

    // 自分あてで、まだ署名していない契約書
    count(() => sb.from("gw_sign_requests")
      .select("id", H)
      .eq("tenant_id", ctx.tenantId).eq("employee_id", me).eq("status", "sent")),

    // 管理側：出したまま署名が返ってきていないもの
    hr ? count(() => sb.from("gw_sign_requests")
      .select("id", H)
      .eq("tenant_id", ctx.tenantId).eq("status", "sent")) : 0,

    // 経費精算。承認する人にだけ出す（代表の承認待ちも数える）
    expenseReviewer ? count(() => sb.from("gw_expense_reports")
      .select("id", H)
      .eq("tenant_id", ctx.tenantId).in("status", ["pending", "pending_owner"])) : 0,

    // 休暇・稟議。承認待ち（稟議は代表の承認待ちも含む）
    hr ? count(() => sb.from("gw_requests")
      .select("id", H)
      .eq("tenant_id", ctx.tenantId).in("status", ["pending", "pending_owner"])) : 0,

    // 打刻の修正申請
    hr ? count(() => sb.from("gw_time_fixes")
      .select("id", H)
      .eq("tenant_id", ctx.tenantId).eq("status", "pending")) : 0,

    // AIが出したまま、まだ採否を決めていないもの
    count(() => sb.from("gw_action_items")
      .select("id", H)
      .eq("user_id", user.id).eq("status", "proposed")),

    // 端末は「見慣れない端末から入られた」だけ数える。
    // 深夜・休日まで数えると、忙しい月はずっと数字が付いたままになる
    hr ? count(() => sb.from("gw_device_alerts")
      .select("id", H)
      .eq("tenant_id", ctx.tenantId).eq("status", "open").eq("rule", "unknown_device")) : 0,
  ]);

  // 0 は返さない。0を返すと、画面側で「0」と出す事故が起きる
  const badges = {};
  const put = (key, n) => { if (n > 0) badges[key] = n; };

  put("messages", messages);
  put("contracts", contracts);
  put("tasks", proposals);
  if (hr) {
    put("esign", esign);
    put("requests", requests);
    put("timecard", timefix);
    put("devices", devices);
  }
  if (expenseReviewer) put("expenses", expenses);

  return json(res, 200, { badges });
}

/**
 * 未読のメッセージ件数。
 *
 * 「自分が入っているやりとりで、自分が最後に読んだあとに、
 *   自分以外が書いたもの」を数える。
 *
 * スレッドごとに last_read_at が違うので、1本のSQLでは書けない。
 * 参加しているスレッドを引いてから、そのいちばん古い既読時刻より
 * 新しいメッセージだけをまとめて取り、こちらで数える。
 * （api/messages/index.js の一覧と同じ数え方）
 */
async function unreadMessages(sb, employeeId) {
  try {
    const { data: mine } = await sb.from("gw_thread_members")
      .select("thread_id, last_read_at")
      .eq("employee_id", employeeId).limit(100);
    if (!mine?.length) return 0;

    const readAt = new Map(mine.map((r) => [r.thread_id, r.last_read_at]));
    // 一度も読んでいないスレッドは、既読時刻が無い。
    // その場合は「未読あり」とは数えない（開いていないだけのことがある）
    const since = mine.map((r) => r.last_read_at).filter(Boolean).sort()[0];
    if (!since) return 0;

    const { data: msgs } = await sb.from("gw_messages")
      .select("thread_id, sender_id, created_at")
      .in("thread_id", [...readAt.keys()])
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);

    let n = 0;
    for (const m of msgs || []) {
      const read = readAt.get(m.thread_id);
      if (m.sender_id !== employeeId && read && m.created_at > read) n++;
    }
    return n;
  } catch (e) {
    console.error("[badges] 未読を数えられませんでした:", e?.message || e);
    return 0;
  }
}
