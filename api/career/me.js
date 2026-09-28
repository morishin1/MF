// GET  /api/career/me                          … 自分の契約・キャリア（現在の契約・現在地・次のLevel・
//                                                次にやること・1年/3年・できるようになったこと・前回評価・確認依頼）
// GET  /api/career/me?summary=1                … ホームの NEXT ACTION 用。いま必要なもの1つだけ
//                                                （契約内容の確認 → 入社情報 → 必要書類 → キャリアプランの確認）
// POST /api/career/me {action:"addGoal", criterionId} … 次のLevelの基準を、自分のタスクに加える
// POST /api/career/me {action:"confirmPlan"}    … 届いたキャリアプランを「内容を確認しました」
//
// ■ 本人に見せるもの・見せないもの（§32）… lib/career-member.js
// ■ 現在給与は契約（gw_contracts の active）から読む。キャリア側には持たない。
// ■ キャリアプランの確認は法的な電子署名ではない。契約書の署名は contracts.html（gw_sign_requests）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { notify } from "../../lib/notify.js";
import { confirmPending } from "../../lib/career.js";
import { memberCareerView, careerOf, pendingContractSigns } from "../../lib/career-member.js";
import { memberAskOf } from "../../lib/journey.js";
import { journeyForEmployee } from "../../lib/journey-load.js";
import { computeStage } from "../../lib/onboard-stage.js";
import { gatherFacts } from "../../lib/onboard-advance.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません" });
  try {
    if (req.method === "GET") return await read(req, res, ctx, user);
    if (req.method === "POST") return await act(req, res, ctx, user);
  } catch (e) {
    const hint = dbSetupHint(e, "db/092_career.sql");
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[career/me]", e?.message || e);
    return json(res, 500, { error: "career_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

const soft = async (q) => { try { const { data, error } = await q; return error ? null : data; } catch { return null; } };

async function read(req, res, ctx, user) {
  const sb = admin();
  const q = new URL(req.url || "/", "http://localhost").searchParams;
  if (q.get("summary")) {
    // ホームに出すかどうかだけ。中身は career.html で読む
    const [careers, signs] = await Promise.all([
      soft(sb.from("gw_employee_careers").select("id, confirm_requested_at, employee_confirmed_at")
        .eq("tenant_id", ctx.tenantId).eq("employee_id", ctx.employee.id).eq("is_active", true)),
      pendingContractSigns(sb, ctx.tenantId, ctx.employee.id),
    ]);
    const c = careers?.[0] || null;
    const pending = confirmPending(c);
    // 入社手続きの途中なら、入社情報・書類のどちらが残っているか（lib/onboard-stage.js と同じ判定）
    let stage = null;
    let facts = null;
    try {
      const procs = await soft(sb.from("gw_procedures").select("id, tenant_id, employee_id, kind, status, target_on, stage")
        .eq("tenant_id", ctx.tenantId).eq("employee_id", ctx.employee.id).eq("kind", "onboarding")
        .order("created_at", { ascending: false }).limit(1));
      const proc = procs?.[0];
      if (proc && proc.status !== "cancelled" && proc.status !== "done") {
        facts = await gatherFacts(sb, ctx.tenantId, proc);
        stage = computeStage(facts).key;
      }
    } catch { stage = null; }
    const ask = memberAskOf({ signPending: signs.length, confirmPending: pending, stage, facts });
    // 入社〜キャリアの共通ステータスバー。管理者の画面と同じ計算（lib/journey-load.js）
    const { journey } = await journeyForEmployee(sb, ctx.tenantId, ctx.employee);
    return json(res, 200, {
      confirmPending: pending, signPending: signs.length,
      show: Boolean(ask), ask,
      link: ask?.href || "career.html#confirm",
      journey: publicJourney(journey),
    });
  }
  const [view, j] = await Promise.all([
    memberCareerView(sb, { tenantId: ctx.tenantId, employee: ctx.employee, userId: user.id }),
    journeyForEmployee(sb, ctx.tenantId, ctx.employee),
  ]);
  return json(res, 200, { ...view, journey: publicJourney(j.journey) });
}

async function act(req, res, ctx, user) {
  const body = await readJson(req);
  if (body?.action === "confirmPlan") return confirmPlan(res, ctx, user);
  if (body?.action !== "addGoal") return json(res, 400, { error: "invalid_action" });
  const sb = admin();
  const { c, next, criteria } = await careerOf(sb, ctx.tenantId, ctx.employee.id);
  if (!c || !next) return json(res, 409, { error: "no_next_level" });
  // 自分の次のLevelの基準だけ。他人の基準・他のLevelの基準は選べない
  const crit = (criteria || []).find((x) => x.id === body.criterionId);
  if (!crit) return json(res, 404, { error: "not_found" });

  const title = `［キャリア］${crit.title}`;
  const open = await soft(sb.from("gw_tasks").select("id, status").eq("tenant_id", ctx.tenantId)
    .eq("assignee_id", ctx.employee.id).eq("title", title));
  if ((open || []).some((t) => !["done", "cancelled"].includes(t.status))) {
    return json(res, 200, { ok: true, already: true });
  }
  const { data, error } = await sb.from("gw_tasks").insert({
    tenant_id: ctx.tenantId, title,
    body: `Level ${next.level_no}「${next.level_name}」に向けて（${crit.category}）`,
    assignee_id: ctx.employee.id, category: "career", priority: "normal", status: "todo",
    created_by: user.id,
  }).select("id").single();
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });
  return json(res, 200, { ok: true, taskId: data.id });
}

/**
 * 本人が「内容を確認しました」。自分の active キャリアだけ。
 * 依頼が来ていないとき・もう確認したときは何も変えない（確認の日時を上書きしない）
 */
async function confirmPlan(res, ctx, user) {
  const sb = admin();
  const careers = await soft(sb.from("gw_employee_careers").select("*").eq("tenant_id", ctx.tenantId)
    .eq("employee_id", ctx.employee.id).eq("is_active", true));
  const c = careers?.[0] || null;
  if (!c) return json(res, 404, { error: "no_career" });
  if (!confirmPending(c)) {
    return c.confirm_requested_at
      ? json(res, 200, { ok: true, already: true, confirmedAt: c.employee_confirmed_at })
      : json(res, 409, { error: "not_requested", hint: "確認の依頼はまだ届いていません" });
  }
  const at = new Date().toISOString();
  const { error } = await sb.from("gw_employee_careers").update({ employee_confirmed_at: at, updated_at: at })
    .eq("id", c.id).eq("tenant_id", ctx.tenantId);
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "career.confirm.employee",
    target: `employee:${ctx.employee.id}`, detail: { requestedAt: c.confirm_requested_at } });
  // 依頼した人へ。中身は通知に入れない
  if (c.confirm_requested_by) {
    const reqEmp = await soft(sb.from("gw_employees").select("id").eq("tenant_id", ctx.tenantId)
      .eq("user_id", c.confirm_requested_by).maybeSingle());
    if (reqEmp?.id) {
      await notify([{
        tenantId: ctx.tenantId, employeeId: reqEmp.id, kind: "general",
        title: `${ctx.employee.display_name || "社員"}さんがキャリアプランを確認しました`,
        link: `admin-career.html?employeeId=${encodeURIComponent(ctx.employee.id)}`,
        dedupeKey: `career-confirmed:${c.id}:${c.confirm_requested_at}`,
      }]);
    }
  }
  return json(res, 200, { ok: true, confirmedAt: at });
}

/**
 * 本人に返すステータスバーの形。状態・6段階・誰の対応か・本人向けの言い方だけ。
 * 管理画面の行き先（cta.href の admin-*.html）や担当者名は返さない
 */
function publicJourney(j) {
  if (!j) return null;
  return {
    state: j.state, step: j.step, total: j.total,
    phases: j.phases, phase: j.phase, who: j.who,
    whoText: j.whoText?.member || null, member: j.member,
    inProgress: j.state !== "active",
  };
}

