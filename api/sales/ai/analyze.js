// AI営業：企業分析（docs/ai-sales-agent-phase0.md・db/131）
//
// GET   /api/sales/ai/analyze?companyId=<uuid>
//         … 1社の最新の分析・営業文・送信可否（アタック画面・分析画面）。AI の表が無ければ { ready:false }
// GET   /api/sales/ai/analyze?list=1
//         … 分析済みの会社（会社ごとに最新の1件。新しい順・最大300社）
// POST  /api/sales/ai/analyze { companyIds: [<uuid>, …] }（1回 5社まで）
//         … サイトを読んで AI で分析する。NG・非表示・直近30日アタック済み等は AI を呼ばずに外す
// PATCH /api/sales/ai/analyze { id, action: "send_check", decision: "ok_manual" | "blocked", note? }
//         … 送ってよいかを人が確かめる。要確認 → 確認済み は Sales を使える人（担当者）。
//           送信不可 → 確認済み（AI の誤判定を直す）は承認できる人だけ。送信不可にするのは誰でも
// PATCH /api/sales/ai/analyze { id, action: "check", result: "correct" | "wrong" | "unknown", note? }
//         … 分析の当たり外れを残す（PC営業の20〜50社で品質を見るため）
//
// 書き込みはすべて admin()（service_role）で、tenant_id で絞る。db/131 の RLS は「読むだけ」。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell, canApproveAiSales, canManageAiSales } from "../../../lib/gw.js";
import { admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { isUuid } from "../../../lib/sales.js";
import { aiKey, LIMITS, stopLabel } from "../../../lib/sales-ai/config.js";
import { aiClient } from "../../../lib/sales-ai/client.js";
import { analyzeCompany, SKIP_LABEL } from "../../../lib/sales-ai/analyze.js";
import {
  AI_SQL, loadSettings, shapeSettings, shapeAnalysis, shapeDraft, namesOf, latestAnalyses, missingTable,
} from "../../../lib/sales-ai/store.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });
  const db = admin();

  if (req.method === "GET") return get(req, res, db, ctx, user);
  if (req.method === "POST") return run(req, res, db, ctx, user);
  if (req.method === "PATCH") return patch(req, res, db, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

const perms = (ctx) => ({ canApprove: canApproveAiSales(ctx), canManage: canManageAiSales(ctx) });

async function get(req, res, db, ctx, user) {
  const sp = new URL(req.url || "/", "http://localhost").searchParams;
  const st = await loadSettings(db, ctx.tenantId);
  if (st.error) return json(res, 500, { error: "db_query_failed", detail: st.error.message });
  if (st.notReady) return json(res, 200, { ready: false, message: dbSetupHint({ code: "PGRST205" }, AI_SQL), ...perms(ctx) });
  const settings = shapeSettings(st.settings);
  const common = { ready: true, configured: Boolean(aiKey()), enabled: settings.enabled, stopLabel: settings.stopLabel, ...perms(ctx) };

  if (sp.get("list")) {
    const { data, error } = await db.from("gw_sales_ai_analyses").select("*").eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false }).limit(2000);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
    const latest = new Map();
    for (const a of data || []) if (!latest.has(a.company_id)) latest.set(a.company_id, a);
    const rows = [...latest.values()].slice(0, 300);
    const ids = rows.map((a) => a.company_id);
    const [{ data: companies }, { data: drafts }] = await Promise.all([
      ids.length ? db.from("gw_sales_companies").select("id, name, industry, region, status, site_url, ng_reason")
        .eq("tenant_id", ctx.tenantId).in("id", ids) : Promise.resolve({ data: [] }),
      ids.length ? db.from("gw_sales_ai_drafts").select("id, company_id, status, created_at")
        .eq("tenant_id", ctx.tenantId).in("company_id", ids).order("created_at", { ascending: false }) : Promise.resolve({ data: [] }),
    ]);
    const cmap = new Map((companies || []).map((c) => [c.id, c]));
    const dmap = new Map();
    for (const d of drafts || []) if (!dmap.has(d.company_id) && d.status !== "superseded") dmap.set(d.company_id, d);
    return json(res, 200, {
      ...common, settings,
      analyses: rows.filter((a) => cmap.has(a.company_id)).map((a) => {
        const c = cmap.get(a.company_id);
        const d = dmap.get(a.company_id);
        return { ...shapeAnalysis(a), facts: undefined, hypotheses: undefined, uncertainties: undefined, pages: undefined,
          company: { id: c.id, name: c.name, industry: c.industry, region: c.region, status: c.status, siteUrl: c.site_url, ng: Boolean(c.ng_reason) },
          draft: d ? { id: d.id, status: d.status } : null };
      }),
    });
  }

  const companyId = sp.get("companyId");
  if (!isUuid(companyId)) return json(res, 400, { error: "invalid_query", required: ["companyId"] });
  const { data: c } = await db.from("gw_sales_companies").select("id").eq("tenant_id", ctx.tenantId).eq("id", companyId).maybeSingle();
  if (!c) return json(res, 404, { error: "not_found" });
  let latest;
  try { latest = (await latestAnalyses(db, ctx.tenantId, [companyId])).get(companyId) || null; } catch (e) {
    return json(res, 500, { error: "db_query_failed", detail: e.message });
  }
  const { data: drafts } = await db.from("gw_sales_ai_drafts").select("*").eq("tenant_id", ctx.tenantId)
    .eq("company_id", companyId).order("created_at", { ascending: false }).limit(10);
  const names = await namesOf(db, ctx.tenantId, (drafts || []).flatMap((d) => [d.created_by, d.requested_by, d.decided_by]));
  return json(res, 200, {
    ...common, analysis: shapeAnalysis(latest), drafts: (drafts || []).map((d) => shapeDraft(d, names)), meId: user.id,
  });
}

async function run(req, res, db, ctx, user) {
  const body = await readJson(req);
  const ids = [...new Set((Array.isArray(body.companyIds) ? body.companyIds : []).filter(isUuid))];
  if (!ids.length) return json(res, 400, { error: "invalid_body", required: ["companyIds"] });
  if (ids.length > LIMITS.batch) return json(res, 400, { error: "too_many", hint: `1回に分析できるのは${LIMITS.batch}社までです`, max: LIMITS.batch });

  const st = await loadSettings(db, ctx.tenantId);
  if (st.error) return json(res, 500, { error: "db_query_failed", detail: st.error.message });
  if (st.notReady) return json(res, 503, { error: "not_ready", message: dbSetupHint({ code: "PGRST205" }, AI_SQL) });
  if (!st.settings.enabled) {
    const reason = st.settings.paused_reason ? `paused:${st.settings.paused_reason}` : "disabled";
    return json(res, 409, { error: "ai_stopped", reason, hint: stopLabel(reason) });
  }
  if (!aiKey()) return json(res, 503, { error: "ai_not_configured", hint: "AI営業の API キー（SALES_AI_ANTHROPIC_API_KEY）が未設定です。管理者に依頼してください" });

  const { data: companies, error } = await db.from("gw_sales_companies").select("*").eq("tenant_id", ctx.tenantId).in("id", ids);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  const found = new Map((companies || []).map((c) => [c.id, c]));

  const client = aiClient();
  const results = await Promise.all(ids.map(async (id) => {
    const company = found.get(id);
    if (!company) return { companyId: id, result: "skipped", reason: "not_found" };
    try {
      return await analyzeCompany({ db, client, tenantId: ctx.tenantId, employeeId: ctx.employee?.id || null, userId: user.id, company, settings: st.settings });
    } catch (e) {
      return { companyId: id, result: "failed", reason: missingTable(e.detail) ? "not_ready" : (e.code || "error") };
    }
  }));

  // 予約で断られた理由（paused:… / monthly_cap など）か、確定のときに DB が自動停止した理由
  const settledStop = results.find((r) => r.stopped)?.stopped;
  const stoppedBy = results.find((r) => r.result === "stopped")?.reason || (settledStop ? `paused:${settledStop}` : null);
  const count = (k) => results.filter((r) => r.result === k).length;
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "sales.ai_analyze", target: `sales_ai:${ids.length}`,
    detail: { ok: count("ok"), skipped: count("skipped"), failed: count("failed"), stopped: count("stopped"), stoppedBy },
  });
  return json(res, 200, {
    results: results.map((r) => ({
      companyId: r.companyId, companyName: found.get(r.companyId)?.name || null, result: r.result, reason: r.reason || null,
      reasonLabel: r.result === "stopped" ? stopLabel(r.reason) : SKIP_LABEL[r.reason] || null,
      analysis: shapeAnalysis(r.analysis),
    })),
    stopped: stoppedBy ? { reason: stoppedBy, hint: stopLabel(stoppedBy) } : null,
  });
}

async function patch(req, res, db, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id", "action"] });
  const { data: a, error } = await db.from("gw_sales_ai_analyses").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
  if (error) {
    if (missingTable(error)) return json(res, 503, { error: "not_ready", message: dbSetupHint(error, AI_SQL) });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  if (!a) return json(res, 404, { error: "not_found" });
  const note = body.note ? String(body.note).trim().slice(0, 1000) : null;
  const now = new Date().toISOString();

  if (body.action === "send_check") {
    if (!["ok_manual", "blocked"].includes(body.decision)) return json(res, 400, { error: "bad_decision", allowed: ["ok_manual", "blocked"] });
    if (!a.send_check) return json(res, 409, { error: "no_send_check", hint: "この分析には送信可否の判定がありません" });
    if (body.decision === "ok_manual" && a.send_check === "blocked" && !canApproveAiSales(ctx)) {
      return json(res, 403, { error: "approver_only", hint: "「送信不可」を確認済みに変えられるのは、経営者・営業責任者だけです" });
    }
    if (body.decision === "ok_manual" && a.send_check === "blocked" && !note) {
      return json(res, 400, { error: "note_required", hint: "「送信不可」を覆す理由を書いてください" });
    }
    const reasons = [...(a.send_check_reasons || []), {
      key: body.decision === "ok_manual" ? "confirmed" : "marked_blocked",
      label: body.decision === "ok_manual" ? "担当者が受付目的・禁止の記載を確認" : "担当者が送信不可と判断",
      note: note || undefined, by: ctx.employee?.display_name || null, at: now,
    }];
    const { data: saved, error: e2 } = await db.from("gw_sales_ai_analyses").update({
      send_check: body.decision, send_check_reasons: reasons, send_check_by: user.id, send_check_at: now,
      effective: body.decision === "blocked" ? false : a.effective,
    }).eq("tenant_id", ctx.tenantId).eq("id", a.id).select("*").single();
    if (e2) return json(res, 500, { error: "db_update_failed", detail: e2.message });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.ai_send_check", target: `sales_company:${a.company_id}`,
      detail: { analysisId: a.id, from: a.send_check, to: body.decision, note } });
    return json(res, 200, { analysis: shapeAnalysis(saved) });
  }

  if (body.action === "check") {
    if (!["correct", "wrong", "unknown"].includes(body.result)) return json(res, 400, { error: "bad_result", allowed: ["correct", "wrong", "unknown"] });
    const { data: saved, error: e2 } = await db.from("gw_sales_ai_analyses").update({
      check_result: body.result, check_note: note, checked_by: user.id, checked_at: now,
    }).eq("tenant_id", ctx.tenantId).eq("id", a.id).select("*").single();
    if (e2) return json(res, 500, { error: "db_update_failed", detail: e2.message });
    return json(res, 200, { analysis: shapeAnalysis(saved) });
  }
  return json(res, 400, { error: "bad_action", allowed: ["send_check", "check"] });
}
