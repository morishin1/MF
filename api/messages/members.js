// POST /api/messages/members … グループの参加者を出し入れする
//   { threadId, action: "add",    employeeIds: [...] }  追加する
//   { threadId, action: "remove", employeeId }          外す
//   { threadId, action: "leave" }                       自分が抜ける
//   { threadId, action: "rename", title }               グループ名を変える
//   { threadId, action: "owner",  employeeId }          持ち主を渡す
//
// ■ 誰が動かせるか
//   作った人（owner）と、人事・経営者だけ。
//   誰でも出し入れできると、業務連絡の宛先が知らないうちに変わる。
//
// ■ 1対1は動かせない
//   2人のやりとりに3人目を入れると、それは別のやりとりになる。
//   増やしたいならグループを作り直す。
//
// ■ 外した記録は残す
//   外された人は過去のやりとりも読めなくなる（RLS が参加者だけに絞っている）。
//   業務連絡なのでそれでよいが、「誰がいつ外したか」は残す必要がある。
//
// ■ 最後の1人は抜けられない
//   誰もいないグループが残り、誰も開けないまま履歴だけが残る。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { notify } from "../../lib/notify.js";

const ACTIONS = ["add", "remove", "leave", "rename", "owner"];
const MAX_MEMBERS = 50;

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });

  const body = await readJson(req);
  if (!body?.threadId || !ACTIONS.includes(body.action)) {
    return json(res, 400, { error: "invalid_body", required: ["threadId", `action(${ACTIONS.join("|")})`] });
  }

  const sb = admin();
  const { data: thread } = await sb.from("gw_threads")
    .select("id, tenant_id, kind, title")
    .eq("id", body.threadId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!thread) return json(res, 404, { error: "thread_not_found" });

  const { data: rows } = await sb.from("gw_thread_members")
    .select("id, employee_id, role")
    .eq("thread_id", thread.id);
  const members = rows || [];
  const mine = members.find((m) => m.employee_id === ctx.employee.id);

  // 参加していない人は、人事であっても中身に触らない。
  // 覗くためではなく、動かせなくなったグループを直すための権限
  if (!mine && !canManageHr(ctx)) return json(res, 403, { error: "not_a_member" });

  if (thread.kind !== "group") {
    return json(res, 400, {
      error: "dm_not_editable",
      hint: "1対1のやりとりは参加者を変えられません。3人以上ならグループを作ってください",
    });
  }

  const isOwner = mine?.role === "owner";
  const canManage = isOwner || canManageHr(ctx);

  // 自分が抜けるのは、持ち主でなくてもできる
  if (body.action !== "leave" && !canManage) {
    return json(res, 403, {
      error: "forbidden",
      hint: "参加者を変えられるのは、グループを作った人と管理部だけです",
    });
  }

  if (body.action === "rename") return rename(res, sb, ctx, thread, body);
  if (body.action === "owner") return handOver(res, sb, ctx, thread, members, body);
  if (body.action === "add") return add(res, sb, ctx, thread, members, body);
  if (body.action === "remove") return remove(res, sb, ctx, thread, members, body);
  return leave(res, sb, ctx, thread, members, mine);
}

// ---- 名前を変える -------------------------------------------------------------
async function rename(res, sb, ctx, thread, body) {
  const title = String(body?.title ?? "").trim().slice(0, 100);
  if (!title) return json(res, 400, { error: "no_title", hint: "グループ名を入れてください" });

  const { error } = await sb.from("gw_threads").update({ title }).eq("id", thread.id);
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: ctx.employee.id, action: "message.rename",
    target: thread.id, detail: { from: thread.title, to: title },
  });
  return json(res, 200, { ok: true, title });
}

// ---- 持ち主を渡す -------------------------------------------------------------
//
// 「持ち主だから外せない」で行き止まりにならないように、必ず渡せる道を用意する。
// 渡すと、渡した人は member に戻る（持ち主は常に1人）
async function handOver(res, sb, ctx, thread, members, body) {
  const target = members.find((m) => m.employee_id === body.employeeId);
  if (!target) return json(res, 404, { error: "not_a_member", hint: "その人はこのグループにいません" });
  if (target.role === "owner") return json(res, 200, { ok: true });

  const now = new Date().toISOString();
  const up = await sb.from("gw_thread_members")
    .update({ role: "member" }).eq("thread_id", thread.id).eq("role", "owner");
  if (up.error) return json(res, 500, { error: "db_update_failed", detail: up.error.message });

  const { error } = await sb.from("gw_thread_members")
    .update({ role: "owner" }).eq("id", target.id);
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  const { data: who } = await sb.from("gw_employees")
    .select("display_name").eq("id", target.employee_id).maybeSingle();
  await notify([{
    tenantId: ctx.tenantId, employeeId: target.employee_id, kind: "message",
    title: `「${thread.title || "グループ"}」の持ち主になりました`,
    body: `${ctx.employee.display_name}さんから引き継ぎました。参加者の出し入れができます`,
    link: `messages.html?t=${thread.id}`,
    dedupeKey: `thread-owner:${thread.id}:${target.employee_id}:${now.slice(0, 10)}`,
  }]);
  await gwLog({
    tenantId: ctx.tenantId, actorId: ctx.employee.id, action: "message.owner_change",
    target: thread.id, detail: { to: who?.display_name || target.employee_id },
  });
  return json(res, 200, { ok: true });
}

// ---- 追加 --------------------------------------------------------------------
async function add(res, sb, ctx, thread, members, body) {
  const ids = [...new Set((Array.isArray(body.employeeIds) ? body.employeeIds : [body.employeeId])
    .filter(Boolean))].slice(0, MAX_MEMBERS);
  if (!ids.length) return json(res, 400, { error: "invalid_body", required: ["employeeIds"] });

  // 自社の名簿にいる人だけ。id は画面から来るので、ここで確かめる
  const { data: people } = await sb.from("gw_employees")
    .select("id, display_name")
    .eq("tenant_id", ctx.tenantId).neq("status", "left").in("id", ids);
  const ok = people || [];
  if (!ok.length) return json(res, 400, { error: "unknown_employee", hint: "その相手は名簿にありません" });

  const already = new Set(members.map((m) => m.employee_id));
  const fresh = ok.filter((p) => !already.has(p.id));
  if (!fresh.length) return json(res, 200, { ok: true, added: 0 });

  if (members.length + fresh.length > MAX_MEMBERS) {
    return json(res, 400, { error: "too_many", hint: `1つのグループは${MAX_MEMBERS}人までです` });
  }

  const { error } = await sb.from("gw_thread_members").insert(fresh.map((p) => ({
    tenant_id: ctx.tenantId,
    thread_id: thread.id,
    employee_id: p.id,
    role: "member",
    // 入る前のやりとりも読めるが、未読としては数えない。
    // 入った瞬間に何十件も未読が付くと、そのグループを開く気がなくなる
    last_read_at: new Date().toISOString(),
  })));
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  await notify(fresh.map((p) => ({
    tenantId: ctx.tenantId, employeeId: p.id, kind: "message",
    title: `「${thread.title || "グループ"}」に追加されました`,
    body: `${ctx.employee.display_name}さんが追加しました`,
    link: `messages.html?t=${thread.id}`,
    dedupeKey: `thread-join:${thread.id}:${p.id}`,
  })));
  await gwLog({
    tenantId: ctx.tenantId, actorId: ctx.employee.id, action: "message.member_add",
    target: thread.id, detail: { names: fresh.map((p) => p.display_name) },
  });
  return json(res, 200, { ok: true, added: fresh.length });
}

// ---- 外す --------------------------------------------------------------------
async function remove(res, sb, ctx, thread, members, body) {
  const target = members.find((m) => m.employee_id === body.employeeId);
  if (!target) return json(res, 404, { error: "not_a_member" });

  // 持ち主を外すには、先に別の人を持ち主にする。
  // 外した結果、誰も動かせないグループが残るのを防ぐ
  if (target.role === "owner" && members.filter((m) => m.role === "owner").length === 1) {
    return json(res, 409, {
      error: "last_owner",
      hint: "このグループの持ち主です。先に別の人を持ち主にしてください",
    });
  }

  const { error } = await sb.from("gw_thread_members").delete().eq("id", target.id);
  if (error) return json(res, 500, { error: "db_delete_failed", detail: error.message });

  const { data: who } = await sb.from("gw_employees")
    .select("display_name").eq("id", target.employee_id).maybeSingle();
  await gwLog({
    tenantId: ctx.tenantId, actorId: ctx.employee.id, action: "message.member_remove",
    target: thread.id, detail: { name: who?.display_name || target.employee_id },
  });
  return json(res, 200, { ok: true });
}

// ---- 自分が抜ける -------------------------------------------------------------
async function leave(res, sb, ctx, thread, members, mine) {
  if (!mine) return json(res, 404, { error: "not_a_member" });

  // 誰もいないグループが残り、誰も開けないまま履歴だけが残る
  if (members.length <= 1) {
    return json(res, 409, {
      error: "last_member",
      hint: "最後の1人は抜けられません。使わなくなったグループは管理部にご連絡ください",
    });
  }
  if (mine.role === "owner" && members.filter((m) => m.role === "owner").length === 1) {
    return json(res, 409, {
      error: "last_owner",
      hint: "このグループの持ち主です。先に別の人を持ち主にしてください",
    });
  }

  const { error } = await sb.from("gw_thread_members").delete().eq("id", mine.id);
  if (error) return json(res, 500, { error: "db_delete_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: ctx.employee.id, action: "message.leave",
    target: thread.id, detail: { title: thread.title },
  });
  return json(res, 200, { ok: true });
}
