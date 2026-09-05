// GET  /api/nippo/admin?date=YYYY-MM-DD&days=14 … その日の全員の日報と、提出率の推移
// POST /api/nippo/admin {action:…}                … 確認・個別メッセージ・AI返信のON/OFF・週次評価
//
// 8grp.co.jp/8/zimu/dr/ にあった管理画面を、このグループウェアへ移したもの。
//
// 誰が使えるか: 管理者・経営者・人事。
// tc_* の RLS は anon にも開いているので、絞っているのはこの API の入口だけ。
// 境界としては弱いが、元から社内向けの簡易運用で、
// タイムカードが同じ設定に依存しているため RLS 側は変えられない。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate, weekStart, isDate } from "../../lib/nippo.js";
import { analyzeNippo } from "../../lib/ai.js";

const canSee = (ctx) => ctx.isAdmin || ctx.roles.includes("owner") || canManageHr(ctx);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSee(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "POST") return act(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読み取り ---------------------------------------------------------------
async function read(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const date = isDate(q.get("date")) ? q.get("date") : jstDate();
  const days = Math.min(Math.max(Number(q.get("days")) || 14, 7), 60);
  const sb = admin();

  const { data: roster } = await sb
    .from("gw_employees")
    .select("id, user_id, display_name, department, employment_type, status")
    .eq("tenant_id", ctx.tenantId)
    .in("status", ["active", "leaving"])
    .order("display_name")
    .limit(300);
  const staff = (roster || []).filter((e) => e.user_id);

  const from = new Date(`${date}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  const fromStr = from.toISOString().slice(0, 10);

  const [dayRows, spanRows, setting] = await Promise.all([
    sb.from("tc_nippo").select("*").eq("work_date", date).limit(300),
    sb.from("tc_nippo").select("user_id, work_date")
      .gte("work_date", fromStr).lte("work_date", date).limit(20000),
    sb.from("tc_settings").select("value").eq("key", "nippo_ai_auto_reply").maybeSingle(),
  ]);

  const nippos = dayRows.data || [];
  const ids = nippos.map((n) => n.id);
  let replies = [];
  if (ids.length) {
    const { data } = await sb.from("tc_nippo_replies").select("*")
      .in("nippo_id", ids).in("kind", ["ai", "admin"])
      .order("created_at", { ascending: true });
    replies = data || [];   // 管理画面では下書きも見せる
  }

  // 提出率の推移。土日は分母から外す（出社日でない日を「未提出」と数えない）
  const submitted = new Set((spanRows.data || []).map((r) => `${r.user_id}|${r.work_date}`));
  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const ds = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    trend.push({
      date: ds,
      submitted: staff.filter((e) => submitted.has(`${e.user_id}|${ds}`)).length,
      total: staff.length,
    });
  }

  const submittedToday = new Set(nippos.map((n) => n.user_id));

  return json(res, 200, {
    date,
    days,
    nippos: nippos.sort((a, b) => (a.user_name || "").localeCompare(b.user_name || "", "ja")),
    replies,
    trend,
    aiAutoReply: setting.data?.value !== false,
    members: staff.map((e) => ({
      userId: e.user_id, name: e.display_name, department: e.department,
      employmentType: e.employment_type, submitted: submittedToday.has(e.user_id),
    })),
    notSubmitted: staff.filter((e) => !submittedToday.has(e.user_id)).map((e) => e.display_name),
    weekStart: weekStart(date),
  });
}

// ---- 操作 -------------------------------------------------------------------
async function act(req, res, ctx, user) {
  const body = await readJson(req);
  const sb = admin();

  switch (body?.action) {
    case "confirm": {
      if (!body.nippoId) return json(res, 400, { error: "invalid_body", required: ["nippoId"] });
      const confirmed = body.confirmed !== false;
      const { data, error } = await sb.from("tc_nippo")
        .update({ confirmed, confirmed_at: confirmed ? new Date().toISOString() : null })
        .eq("id", body.nippoId).select("id, user_name, work_date").maybeSingle();
      if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
      if (!data) return json(res, 404, { error: "nippo_not_found" });
      return json(res, 200, { ok: true, confirmed });
    }

    case "ai_draft": {
      // 1人ぶんの日報を AI に読ませ、気づいた点と返信の下書きを返す。
      // ここでは保存も送信もしない。送るかどうかは人が決める
      if (!body?.nippoId) return json(res, 400, { error: "invalid_body", required: ["nippoId"] });

      const { data: today } = await sb.from("tc_nippo").select("*").eq("id", body.nippoId).maybeSingle();
      if (!today) return json(res, 404, { error: "nippo_not_found" });

      // 同じ人の直近ぶんと、これまで送った返信。
      // 今日1日だけ見ても「先週から止まったまま」に気づけないため
      const [{ data: recent }, { data: past }] = await Promise.all([
        sb.from("tc_nippo").select("*").eq("user_id", today.user_id)
          .lt("work_date", today.work_date).order("work_date", { ascending: false }).limit(5),
        sb.from("tc_nippo_replies").select("body, nippo_id, kind, draft_only")
          .eq("kind", "admin").eq("draft_only", false)
          .order("created_at", { ascending: false }).limit(30),
      ]);

      const mineIds = new Set([today.id, ...(recent || []).map((r) => r.id)]);
      const pastReplies = (past || []).filter((r) => mineIds.has(r.nippo_id)).map((r) => r.body);

      try {
        const result = await analyzeNippo({ today, recent: recent || [], pastReplies });
        await gwLog({
          tenantId: ctx.tenantId, actorId: user.id, action: "nippo.ai_draft",
          target: `nippo:${body.nippoId}`, detail: { name: today.user_name, needsHuman: !!result.needs_human },
        });
        return json(res, 200, { draft: result });
      } catch (e) {
        return json(res, 502, {
          error: "ai_failed",
          hint: /ANTHROPIC_API_KEY/.test(e.message || "")
            ? "AIの鍵（ANTHROPIC_API_KEY）が未設定です"
            : "AIが応答しませんでした。少し待ってからもう一度お試しください",
          detail: e.message,
        });
      }
    }

    case "reply": {
      // 本人へのメッセージ。下書きのまま置いておけるようにしてある
      // （書いたその場で送らずに、翌朝read直してから送りたいことがあるため）
      const text = String(body?.body ?? "").trim();
      if (!body?.nippoId || !text) {
        return json(res, 400, { error: "invalid_body", required: ["nippoId", "body"] });
      }
      const draftOnly = body.draftOnly === true;
      const { data, error } = await sb.from("tc_nippo_replies").insert({
        nippo_id: body.nippoId,
        kind: "admin",
        body: text.slice(0, 4000),
        draft_only: draftOnly,
        sent_at: draftOnly ? null : new Date().toISOString(),
        status: "sent",
      }).select("*").single();
      if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

      if (!draftOnly) {
        await gwLog({
          tenantId: ctx.tenantId, actorId: user.id, action: "nippo.reply",
          target: `nippo:${body.nippoId}`, detail: {},
        });
      }
      return json(res, 200, { reply: data });
    }

    case "send_draft": {
      if (!body?.replyId) return json(res, 400, { error: "invalid_body", required: ["replyId"] });
      const { data, error } = await sb.from("tc_nippo_replies")
        .update({ draft_only: false, sent_at: new Date().toISOString() })
        .eq("id", body.replyId).eq("kind", "admin").select("*").maybeSingle();
      if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
      if (!data) return json(res, 404, { error: "reply_not_found" });
      return json(res, 200, { reply: data });
    }

    case "delete_reply": {
      // 送る前の下書きだけ消せる。本人が読んだかもしれない文章は消させない
      if (!body?.replyId) return json(res, 400, { error: "invalid_body", required: ["replyId"] });
      const { data, error } = await sb.from("tc_nippo_replies")
        .delete().eq("id", body.replyId).eq("kind", "admin").eq("draft_only", true)
        .select("id").maybeSingle();
      if (error) return json(res, 500, { error: "db_delete_failed", detail: error.message });
      if (!data) return json(res, 409, { error: "not_a_draft", hint: "送信済みのメッセージは消せません" });
      return json(res, 200, { ok: true });
    }

    case "ai_toggle": {
      const enabled = body.enabled !== false;
      const { error } = await sb.from("tc_settings")
        .upsert({ key: "nippo_ai_auto_reply", value: enabled, updated_at: new Date().toISOString() },
                { onConflict: "key" });
      if (error) return json(res, 500, { error: "db_upsert_failed", detail: error.message });
      await gwLog({
        tenantId: ctx.tenantId, actorId: user.id,
        action: enabled ? "nippo.ai_on" : "nippo.ai_off", target: "tc_settings", detail: {},
      });
      return json(res, 200, { aiAutoReply: enabled });
    }

    case "weekly_eval": {
      // レーダー評価と総評。submit を付けたときだけ本人の画面に出る
      const ws = isDate(body?.weekStart) ? body.weekStart : weekStart(jstDate());
      if (!body?.userId) return json(res, 400, { error: "invalid_body", required: ["userId"] });

      const scores = normalizeScores(body?.scores);
      if (scores === false) return json(res, 400, { error: "invalid_scores", hint: "各項目は1〜5です" });

      const { data: emp } = await sb.from("gw_employees")
        .select("display_name").eq("user_id", body.userId).eq("tenant_id", ctx.tenantId).maybeSingle();
      if (!emp) return json(res, 404, { error: "employee_not_found" });

      const patch = {
        user_id: body.userId,
        user_name: emp.display_name,
        week_start: ws,
        eval_scores: scores,
        eval_comment: String(body?.comment ?? "").trim().slice(0, 4000) || null,
        updated_at: new Date().toISOString(),
      };
      if (body.submit) patch.submitted_at = new Date().toISOString();

      const { data, error } = await sb.from("tc_weekly_review")
        .upsert(patch, { onConflict: "user_id,week_start" }).select("*").single();
      if (error) return json(res, 500, { error: "db_upsert_failed", detail: error.message });

      if (body.submit) {
        await gwLog({
          tenantId: ctx.tenantId, actorId: user.id, action: "nippo.weekly_eval",
          target: `employee:${emp.display_name}`, detail: { week_start: ws },
        });
      }
      return json(res, 200, { weekly: data });
    }

    case "weekly_get": {
      if (!body?.userId) return json(res, 400, { error: "invalid_body", required: ["userId"] });
      const ws = isDate(body?.weekStart) ? body.weekStart : weekStart(jstDate());
      const { data } = await sb.from("tc_weekly_review").select("*")
        .eq("user_id", body.userId).eq("week_start", ws).maybeSingle();
      return json(res, 200, { weekly: data || null });
    }

    default:
      return json(res, 400, { error: "unknown_action" });
  }
}

const EVAL_KEYS = ["achieve", "speed", "accuracy", "priority", "solve", "share"];

/**
 * レーダー評価を検算する。
 * 「点を付けていない」と「点がおかしい」は区別する。
 * 総評だけ書いて点は後で、という使い方を弾かないため。
 * @returns {object|null|false} 点 / 未入力 / 不正
 */
function normalizeScores(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") return false;
  const out = {};
  for (const k of EVAL_KEYS) {
    if (v[k] === undefined || v[k] === null || v[k] === "") continue;
    const n = Number(v[k]);
    if (!Number.isInteger(n) || n < 1 || n > 5) return false;
    out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}
