// GET  /api/nippo/admin?date=YYYY-MM-DD&days=14 … その日の全員の日報と、提出率の推移
// POST /api/nippo/admin {action:…}                … 確認・個別メッセージ・AI返信のON/OFF
//
// 週次・月次の評価は /api/nippo/weekly と /api/nippo/monthly が持つ。
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
import { shape as shapeEval } from "./evaluate.js";
import { isConfigured as aiConfigured } from "../../lib/nippo-eval.js";
import { ACTIONS as CRITERIA, rubric } from "../../lib/scoring.js";
import { findFollowUps, rankings, recentWorkdays } from "../../lib/follow.js";
import { kpiRate } from "../../lib/actions.js";
import { shapeBlocker } from "../../lib/blockers.js";

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

  // 要フォローとランキングの材料。直近14営業日ぶんまで見る。
  // 「前の期間との比較（成長）」を出すため、その前の同じ長さぶんも取る
  const spanDays = recentWorkdays(date, 14);
  const spanFrom = spanDays[spanDays.length - 1];
  const prevDays = recentWorkdays(spanFrom, 15).slice(1);   // 直前の14営業日
  const prevFrom = prevDays[prevDays.length - 1];

  const [dayRows, spanRows, setting, detailRows, kpiRows, prevRows,
         blockerRows, itemRows, spanEvals] = await Promise.all([
    sb.from("tc_nippo").select("*").eq("work_date", date).limit(300),
    sb.from("tc_nippo").select("user_id, work_date")
      .gte("work_date", fromStr).lte("work_date", date).limit(20000),
    sb.from("tc_settings").select("value").eq("key", "nippo_ai_auto_reply").maybeSingle(),
    sb.from("tc_nippo")
      .select("user_id, work_date, work_items, tomorrow_plan, consult_note, morning_note")
      .gte("work_date", spanFrom).lte("work_date", date).limit(5000),
    sb.from("gw_daily_kpis").select("user_id, work_date, target, actual")
      .gte("work_date", spanFrom).lte("work_date", date).limit(5000),
    sb.from("tc_nippo").select("user_id, work_items")
      .gte("work_date", prevFrom).lt("work_date", spanFrom).limit(5000),
    // 止まっている仕事。管理職の仕事はこれを外すこと（要件定義 §24）
    sb.from("gw_blockers").select("*").eq("status", "open")
      .order("blocked_since").limit(300),
    // 期限を過ぎたまま開いている「次にやること」
    sb.from("gw_action_items").select("user_id, status, due_date")
      .lte("due_date", date).gte("due_date", spanFrom).limit(5000),
    // 顧客価値の並びに使う。日報から「顧客・チームのためにしたこと」の欄を
    // 外したので、文章を読んでいるAIが付けた点から数える
    sb.from("gw_nippo_ai_evals").select("user_id, work_date, scores")
      .eq("status", "completed")
      .gte("work_date", spanFrom).lte("work_date", date).limit(5000),
  ]);

  const nippos = dayRows.data || [];
  const ids = nippos.map((n) => n.id);

  // その日の日報のAI評価（1件につき最新のものだけ）
  let evals = [];
  if (ids.length) {
    const { data } = await sb.from("gw_nippo_ai_evals").select("*")
      .in("nippo_id", ids).order("created_at", { ascending: false });
    const seen = new Set();
    for (const e of data || []) {
      if (seen.has(e.nippo_id)) continue;
      seen.add(e.nippo_id);
      evals.push(shapeEval(e));
    }
  }
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
    evals,
    aiEval: { configured: aiConfigured(), criteria: CRITERIA, rubric: rubric() },

    // 管理者が全員の日報を読まなくて済むように、見るべき人だけ出す。
    // 条件は「相談あり・3日連続KPI未達・日報未提出2日」の3つだけ
    followUps: findFollowUps({
      date, staff,
      nippos: detailRows.data || [],
      kpis: kpiRows.data || [],
      blockers: blockerRows.data || [],
      items: itemRows.data || [],
    }),

    // 止まっている仕事の一覧。長いものから先に出す（§21 §24）
    blockers: (blockerRows.data || [])
      .map((b) => shapeBlocker(b, date, staff.find((e) => e.user_id === b.user_id)?.display_name))
      .sort((a, b) => b.days - a.days),

    // 直近14営業日の並び。単純な点数順ではなく、
    // 成果 / 行動 / 改善 / 成長 / 顧客価値 で見る。
    // 残業時間・日報の文字数・AIとの会話量は数えない
    rankings: rankings({
      staff,
      nippos: detailRows.data || [],
      kpis: kpiRows.data || [],
      prevNippos: prevRows.data || [],
      evals: spanEvals.data || [],
    }),

    // その日のKPI達成状況（§12 最上部の「KPI達成」）
    kpiToday: (() => {
      const today = (kpiRows.data || []).filter((k) => k.work_date === date);
      const per = new Map();
      for (const k of today) {
        if (!(Number(k.target) > 0)) continue;
        per.set(k.user_id, [...(per.get(k.user_id) || []), k]);
      }
      let hit = 0;
      for (const rows of per.values()) if (kpiRate(rows)?.rate === 100) hit++;
      return { achieved: hit, of: per.size };
    })(),
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

    // 週次評価は /api/nippo/weekly へ移した（成果40/行動30/成長20/チーム10 ＝ 100点）。
    // 旧6項目×5点の口をここに残しておくと、同じ eval_scores に別の形が
    // 混ざって、どちらの基準の点か分からなくなる。

    default:
      return json(res, 400, { error: "unknown_action" });
  }
}


