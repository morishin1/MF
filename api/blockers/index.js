// GET  /api/blockers?scope=mine|all&status=open … 止まっている仕事
// POST /api/blockers {action:"raise"|"resolve"|"drop"|"escalate", …}
//
// ■ 日報の「困りごと」と何が違うか
//   困りごとはその日の記録で、翌日には流れる。
//   Blocker は「仕事が止まっていて、誰かが外さないと動かない状態」で、
//   外れるまで残る。何日止まっているかが数えられる。
//
// ■ 誰が外せるか
//   本人以外の社内の人なら誰でも外せる。管理職に限らない。
//   手が空いている人が外せるほうが早い。
//   ただし「外した」は記録に残す（誰が何をして外れたか）。
//
// ■ 自動でエスカレーションしない
//   何日か経ったら自動で上へ、にはしない。
//   上がってきた時点で誰も中身を知らない状態になるため。
//   上げるのは人が押す。長期化しているものは管理画面に出す。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate } from "../../lib/nippo.js";
import { shapeBlocker, blockerDays } from "../../lib/blockers.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, {
      error: "no_employee",
      hint: "社員名簿にあなたの行がありません。管理者に登録を依頼してください。",
    });
  }

  if (req.method === "GET") return read(req, res, user, ctx);
  if (req.method === "POST") return act(req, res, user, ctx);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function read(req, res, user, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const scope = q.get("scope") === "all" ? "all" : "mine";
  const status = q.get("status") || "open";
  const sb = admin();

  let query = sb.from("gw_blockers").select("*")
    .order("blocked_since", { ascending: true }).limit(200);
  if (scope === "mine") query = query.eq("user_id", user.id);
  if (status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return json(res, 500, { error: "db_read_failed", detail: error.message });

  // 名前を添える。誰のものかが分からないと、外しに行けない
  const ids = [...new Set((data || []).map((b) => b.user_id))];
  const names = new Map();
  if (ids.length) {
    const { data: emps } = await sb.from("gw_employees")
      .select("user_id, display_name").eq("tenant_id", ctx.tenantId).in("user_id", ids);
    for (const e of emps || []) names.set(e.user_id, e.display_name);
  }

  const today = jstDate();
  return json(res, 200, {
    blockers: (data || []).map((b) => shapeBlocker(b, today, names.get(b.user_id))),
    scope, status,
  });
}

async function act(req, res, user, ctx) {
  const body = await readJson(req);
  const sb = admin();

  // --- 上げる ---
  if (body.action === "raise") {
    const title = String(body.title ?? "").trim().slice(0, 200);
    if (!title) return json(res, 400, { error: "invalid_title", hint: "止まっている内容を書いてください" });

    // 同じ内容をもう一度上げない。日報のたびに増えると、何が止まっているか分からなくなる
    const { data: dup } = await sb.from("gw_blockers").select("id")
      .eq("user_id", user.id).eq("status", "open").eq("title", title).limit(1);
    if (dup?.length) return json(res, 200, { blocker: null, duplicate: true });

    const { data, error } = await sb.from("gw_blockers").insert({
      user_id: user.id,
      title,
      description: String(body.description ?? "").trim().slice(0, 2000) || null,
      action_item_id: body.actionItemId || null,
      from_nippo_id: body.nippoId || null,
      // 相談相手を書いて上げたなら、最初から「相談済み」にする
      escalation_level: body.escalate ? 1 : 0,
      blocked_since: body.since || jstDate(),
    }).select("*").single();
    if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "blocker.raise",
      target: `blocker:${data.id}`, detail: { title },
    });
    return json(res, 200, { blocker: shapeBlocker(data, jstDate(), ctx.employee.display_name) });
  }

  const { data: b } = await sb.from("gw_blockers").select("*").eq("id", body.id).maybeSingle();
  if (!b) return json(res, 404, { error: "not_found" });

  // --- 外す ---
  // 本人以外も外せる。手が空いている人が外せるほうが早い。
  // ただし誰が外したかは残す
  if (body.action === "resolve") {
    if (b.status !== "open") return json(res, 409, { error: "already_closed" });

    const { data, error } = await sb.from("gw_blockers").update({
      status: "resolved",
      resolution: String(body.resolution ?? "").trim().slice(0, 2000) || null,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", b.id).select("*").single();
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "blocker.resolve",
      target: `blocker:${b.id}`,
      detail: { title: b.title, days: blockerDays(b, jstDate()), mine: b.user_id === user.id },
    });
    return json(res, 200, { blocker: shapeBlocker(data, jstDate()) });
  }

  // --- 止まりではなくなった ---
  // 消さずに残す。別の進め方にした、という判断も記録のうち
  if (body.action === "drop") {
    if (b.user_id !== user.id) return json(res, 403, { error: "forbidden", hint: "取り下げは本人だけです" });
    const { data, error } = await sb.from("gw_blockers").update({
      status: "dropped",
      resolution: String(body.resolution ?? "").trim().slice(0, 2000) || null,
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", b.id).select("*").single();
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    return json(res, 200, { blocker: shapeBlocker(data, jstDate()) });
  }

  // --- 相談に上げる ---
  if (body.action === "escalate") {
    const next = Math.min(2, (b.escalation_level || 0) + 1);
    if (next === b.escalation_level) return json(res, 409, { error: "already_top" });

    const { data, error } = await sb.from("gw_blockers").update({
      escalation_level: next, updated_at: new Date().toISOString(),
    }).eq("id", b.id).select("*").single();
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "blocker.escalate",
      target: `blocker:${b.id}`, detail: { title: b.title, level: next },
    });
    return json(res, 200, { blocker: shapeBlocker(data, jstDate()) });
  }

  return json(res, 400, { error: "invalid_action", allowed: ["raise", "resolve", "drop", "escalate"] });
}
