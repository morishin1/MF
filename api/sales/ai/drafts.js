// AI営業：営業文（作る・直す・承認を依頼する・承認する・差し戻す）と、送る直前の最終文面
//
// GET   /api/sales/ai/drafts?status=pending
//         … 承認待ちの一覧（会社名・分析の要点つき）。承認できる人かどうか（canApprove）も返す
// GET   /api/sales/ai/drafts?id=<uuid>&approachId=<uuid>
//         … 送る直前の最終文面（{{company}}・{{sender}}・{{url}} を差し込み、共通署名を付けたもの）。承認済みだけ
// POST  /api/sales/ai/drafts { companyId, service? }
//         … AI（Sonnet）で営業文を作る（下書き）。分析が無い・送信不可の会社には作らない
// PATCH /api/sales/ai/drafts { id, action: "edit", subject?, body }    … 直す（承認待ち・承認済みでも直せるが、下書きに戻る＝承認やり直し）
// PATCH /api/sales/ai/drafts { id, action: "request" }                 … 承認を依頼する
// PATCH /api/sales/ai/drafts { id, action: "withdraw" }                … 依頼を取り下げる（下書きに戻す）
// PATCH /api/sales/ai/drafts { id, action: "approve", note? }           … 承認（経営者・営業責任者だけ。作った人・直した人・依頼した人は不可）
// PATCH /api/sales/ai/drafts { id, action: "reject", note }             … 差し戻し（理由は必須）
//
// 外部へは何も送らない。承認した文面は、アタック画面（手動送信）で「AI文面（承認済み）」として使う。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell, canApproveAiSales } from "../../../lib/gw.js";
import { admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { isUuid, NG_LABEL } from "../../../lib/sales.js";
import { aiKey, stopLabel, worstCost, estimateTokens, FOCUS_SERVICES } from "../../../lib/sales-ai/config.js";
import { aiClient, callJson, errorOutcome } from "../../../lib/sales-ai/client.js";
import { reserve, settle } from "../../../lib/sales-ai/budget.js";
import {
  DRAFT_SCHEMA, DRAFT_SYSTEM, buildDraftPrompt, ensureUrl, draftWarnings, bodyHash, composeFinal,
  DRAFT_MODEL, DRAFT_MAX_TOKENS, DRAFT_PROMPT_VERSION,
} from "../../../lib/sales-ai/draft.js";
import { AI_SQL, loadSettings, shapeDraft, shapeAnalysis, namesOf, missingTable, usableDraft, finalText } from "../../../lib/sales-ai/store.js";

const SERVICES = FOCUS_SERVICES.map((s) => s.name);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });
  const db = admin();

  if (req.method === "GET") return get(req, res, db, ctx, user);
  if (req.method === "POST") return create(req, res, db, ctx, user);
  if (req.method === "PATCH") return act(req, res, db, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

const notReady = (res, error) => json(res, 503, { error: "not_ready", message: dbSetupHint(error || { code: "PGRST205" }, AI_SQL) });

async function get(req, res, db, ctx, user) {
  const sp = new URL(req.url || "/", "http://localhost").searchParams;

  if (sp.get("id")) {
    // 送る直前の最終文面
    if (!isUuid(sp.get("id")) || !isUuid(sp.get("approachId"))) return json(res, 400, { error: "invalid_query", required: ["id", "approachId"] });
    const { data: d, error } = await db.from("gw_sales_ai_drafts").select("*").eq("tenant_id", ctx.tenantId).eq("id", sp.get("id")).maybeSingle();
    if (error) return missingTable(error) ? notReady(res, error) : json(res, 500, { error: "db_query_failed", detail: error.message });
    if (!d) return json(res, 404, { error: "not_found" });
    const ok = usableDraft(d);
    if (!ok.ok) return json(res, 409, ok.body);
    const { data: a } = await db.from("gw_sales_approaches").select("id, company_id, tracking_token, sent_at")
      .eq("tenant_id", ctx.tenantId).eq("id", sp.get("approachId")).maybeSingle();
    if (!a || a.company_id !== d.company_id) return json(res, 404, { error: "approach_not_found" });
    const final = await finalText(db, ctx, req, d, a);
    return json(res, 200, { draft: shapeDraft(d), final });
  }

  const status = sp.get("status") || "pending";
  if (!["pending", "approved", "draft", "rejected"].includes(status)) return json(res, 400, { error: "bad_status" });
  const { data, error } = await db.from("gw_sales_ai_drafts").select("*").eq("tenant_id", ctx.tenantId).eq("status", status)
    .order("created_at", { ascending: false }).limit(200);
  if (error) return missingTable(error) ? json(res, 200, { ready: false, drafts: [], message: dbSetupHint(error, AI_SQL) }) : json(res, 500, { error: "db_query_failed", detail: error.message });
  const ids = [...new Set((data || []).map((d) => d.company_id))];
  const aids = [...new Set((data || []).map((d) => d.analysis_id).filter(Boolean))];
  const [{ data: companies }, { data: analyses }, names] = await Promise.all([
    ids.length ? db.from("gw_sales_companies").select("id, name, industry, region, site_url").eq("tenant_id", ctx.tenantId).in("id", ids) : Promise.resolve({ data: [] }),
    aids.length ? db.from("gw_sales_ai_analyses").select("*").eq("tenant_id", ctx.tenantId).in("id", aids) : Promise.resolve({ data: [] }),
    namesOf(db, ctx.tenantId, (data || []).flatMap((d) => [d.created_by, d.requested_by, d.decided_by, d.edited_by])),
  ]);
  const cmap = new Map((companies || []).map((c) => [c.id, c]));
  const amap = new Map((analyses || []).map((a) => [a.id, a]));
  const { settings } = await loadSettings(db, ctx.tenantId);
  return json(res, 200, {
    ready: true, canApprove: canApproveAiSales(ctx), meId: user.id,
    drafts: (data || []).map((d) => {
      const c = cmap.get(d.company_id);
      const a = shapeAnalysis(amap.get(d.analysis_id));
      return {
        ...shapeDraft(d, names), editedBy: d.edited_by, editedByName: names.get(d.edited_by) || null,
        company: c ? { id: c.id, name: c.name, industry: c.industry, region: c.region, siteUrl: c.site_url } : null,
        analysis: a ? { id: a.id, summary: a.summary, facts: a.facts, hypotheses: a.hypotheses, score: a.score,
          sendCheck: a.sendCheck, sendCheckLabel: a.sendCheckLabel, services: a.services } : null,
        warnings: draftWarnings(d.subject, d.body, settings?.banned_phrases),
        // 承認者が見る見本（差し込みは見本の値）
        preview: composeFinal(d, { company: c?.name || "", sender: "（送る担当者の名前）", url: "https://…/r/（専用URL）", service: d.service || "", signature: settings?.signature || "" }),
        selfInvolved: [d.created_by, d.requested_by, d.edited_by].includes(user.id),
      };
    }),
  });
}

async function create(req, res, db, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.companyId)) return json(res, 400, { error: "invalid_body", required: ["companyId"] });
  if (body.service && !SERVICES.includes(body.service)) return json(res, 400, { error: "bad_service", allowed: SERVICES });

  const st = await loadSettings(db, ctx.tenantId);
  if (st.error) return json(res, 500, { error: "db_query_failed", detail: st.error.message });
  if (st.notReady) return notReady(res);
  if (!st.settings.enabled) {
    const reason = st.settings.paused_reason ? `paused:${st.settings.paused_reason}` : "disabled";
    return json(res, 409, { error: "ai_stopped", reason, hint: stopLabel(reason) });
  }
  if (!aiKey()) return json(res, 503, { error: "ai_not_configured", hint: "AI営業の API キー（SALES_AI_ANTHROPIC_API_KEY）が未設定です。管理者に依頼してください" });

  const { data: c } = await db.from("gw_sales_companies").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.companyId).maybeSingle();
  if (!c) return json(res, 404, { error: "not_found" });
  if (c.ng_reason) return json(res, 403, { error: "ng_company", hint: `この企業は営業禁止です（${NG_LABEL[c.ng_reason] || c.ng_reason}）` });
  if (c.hidden_at) return json(res, 409, { error: "hidden_company", hint: "この企業は非表示です" });

  const { data: an } = await db.from("gw_sales_ai_analyses").select("*").eq("tenant_id", ctx.tenantId).eq("company_id", c.id)
    .eq("status", "ok").order("created_at", { ascending: false }).limit(1);
  const analysis = (an || [])[0];
  if (!analysis) return json(res, 409, { error: "analysis_required", hint: "先にこの企業を分析してください" });
  if (analysis.send_check === "blocked") return json(res, 409, { error: "ai_send_blocked", hint: "この企業は「送信不可」と判定されています。営業文は作りません" });
  const service = body.service || analysis.score_detail?.services?.[0]?.service || SERVICES[0];

  const model = DRAFT_MODEL();
  const prompt = buildDraftPrompt({ company: c, analysis, service });
  const estimate = worstCost(model, estimateTokens(DRAFT_SYSTEM + prompt), DRAFT_MAX_TOKENS);
  const r = await reserve(db, { tenantId: ctx.tenantId, estimate, purpose: "draft", model, companyId: c.id, employeeId: ctx.employee?.id || null });
  if (!r.id) return json(res, 409, { error: "ai_stopped", reason: r.reason, hint: stopLabel(r.reason) });

  let call;
  try {
    call = await callJson(aiClient(), { model, system: DRAFT_SYSTEM, user: prompt, schema: DRAFT_SCHEMA, maxTokens: DRAFT_MAX_TOKENS, effort: "medium" });
  } catch (e) {
    const o = errorOutcome(e);
    await settle(db, r.id, { model, outcome: o.outcome, error: o.error });
    return json(res, 502, { error: "ai_failed", hint: "AI が営業文を作れませんでした。時間をおいてやり直してください" });
  }
  await settle(db, r.id, { model, usage: call.usage, outcome: call.outcome, error: call.error, latencyMs: call.latencyMs });
  if (!call.ok) return json(res, 502, { error: "ai_failed", reason: call.outcome, hint: "AI が営業文を作れませんでした。時間をおいてやり直してください" });

  const subject = String(call.data.subject || "").trim().slice(0, 300) || null;
  const text = ensureUrl(String(call.data.body || "")).slice(0, 20000);
  // 前の下書き・差し戻しは「差し替え済み」にする（承認待ち・承認済みは、新しい版の依頼のときに差し替える）
  await db.from("gw_sales_ai_drafts").update({ status: "superseded" }).eq("tenant_id", ctx.tenantId).eq("company_id", c.id).in("status", ["draft", "rejected"]);
  const { data: prev } = await db.from("gw_sales_ai_drafts").select("version").eq("tenant_id", ctx.tenantId).eq("company_id", c.id)
    .order("version", { ascending: false }).limit(1);
  const { data: saved, error: e2 } = await db.from("gw_sales_ai_drafts").insert({
    tenant_id: ctx.tenantId, company_id: c.id, analysis_id: analysis.id, service, subject, body: text,
    rationale: String(call.data.rationale || "").slice(0, 2000) || null, version: ((prev || [])[0]?.version || 0) + 1,
    status: "draft", created_by: user.id, model, prompt_version: DRAFT_PROMPT_VERSION,
  }).select("*").single();
  if (e2) return json(res, 500, { error: "db_insert_failed", detail: e2.message });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.ai_draft_created", target: `sales_company:${c.id}`, detail: { draftId: saved.id, service } });
  return json(res, 200, { draft: shapeDraft(saved), warnings: draftWarnings(subject, text, st.settings.banned_phrases) });
}

async function act(req, res, db, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id", "action"] });
  const { data: d, error } = await db.from("gw_sales_ai_drafts").select("*").eq("tenant_id", ctx.tenantId).eq("id", body.id).maybeSingle();
  if (error) return missingTable(error) ? notReady(res, error) : json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!d) return json(res, 404, { error: "not_found" });
  const now = new Date().toISOString();
  const note = body.note ? String(body.note).trim().slice(0, 1000) : null;
  const done = async (patch, action, extra = {}) => {
    const { data: saved, error: e2 } = await db.from("gw_sales_ai_drafts").update(patch)
      .eq("tenant_id", ctx.tenantId).eq("id", d.id).eq("status", d.status).select("*").maybeSingle();
    if (e2) {
      if (String(e2.code) === "23505") return json(res, 409, { error: "active_exists", hint: "この会社には、ほかに承認待ち・承認済みの営業文があります" });
      if (String(e2.code) === "23514") return json(res, 403, { error: "self_approval", hint: "作った人・依頼した人は承認できません" });
      return json(res, 500, { error: "db_update_failed", detail: e2.message });
    }
    if (!saved) return json(res, 409, { error: "changed", hint: "ほかの人が先に操作しました。開き直してください" });
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `sales.ai_draft_${action}`, target: `sales_company:${d.company_id}`, detail: { draftId: d.id, note, ...extra } });
    return json(res, 200, { draft: shapeDraft(saved) });
  };

  if (body.action === "edit") {
    if (["used", "superseded"].includes(d.status)) return json(res, 409, { error: "locked", hint: "送信に使った・差し替えた営業文は直せません。新しく作ってください" });
    const text = String(body.body ?? d.body).trim();
    if (!text) return json(res, 400, { error: "body_required", hint: "本文が空です" });
    if (text.length > 20000) return json(res, 400, { error: "too_long" });
    const subject = body.subject !== undefined ? String(body.subject || "").trim().slice(0, 300) || null : d.subject;
    // 直したら承認はやり直し（下書きに戻す）
    return done({
      subject, body: text, status: "draft", edited_by: user.id, edited_at: now,
      requested_by: null, requested_at: null, decided_by: null, decided_at: null, decision_note: null, approved_body_hash: null,
    }, "edited", { from: d.status });
  }
  if (body.action === "request") {
    if (!["draft", "rejected"].includes(d.status)) return json(res, 409, { error: "bad_status", hint: "下書き・差し戻しの営業文だけ依頼できます" });
    // 同じ会社の、前の承認待ち・承認済みは差し替える（1社に有効な営業文は1つ）
    await db.from("gw_sales_ai_drafts").update({ status: "superseded" }).eq("tenant_id", ctx.tenantId)
      .eq("company_id", d.company_id).neq("id", d.id).in("status", ["pending", "approved"]);
    return done({ status: "pending", requested_by: user.id, requested_at: now, decided_by: null, decided_at: null, decision_note: null }, "requested");
  }
  if (body.action === "withdraw") {
    if (d.status !== "pending") return json(res, 409, { error: "bad_status" });
    if (d.requested_by !== user.id && !canApproveAiSales(ctx)) return json(res, 403, { error: "forbidden", hint: "依頼した人・承認できる人だけが取り下げられます" });
    return done({ status: "draft", requested_by: null, requested_at: null }, "withdrawn");
  }
  if (body.action === "approve" || body.action === "reject") {
    if (!canApproveAiSales(ctx)) return json(res, 403, { error: "approver_only", hint: "承認・差し戻しができるのは、経営者・営業責任者だけです" });
    if (d.status !== "pending") return json(res, 409, { error: "bad_status", hint: "承認待ちの営業文ではありません" });
    if (body.action === "reject") {
      if (!note) return json(res, 400, { error: "note_required", hint: "差し戻す理由を書いてください" });
      return done({ status: "rejected", decided_by: user.id, decided_at: now, decision_note: note }, "rejected");
    }
    // 自己承認の禁止：作った人・直した人・依頼した人は承認できない（DB の CHECK も作った人・依頼した人を止める）
    if ([d.created_by, d.requested_by, d.edited_by].includes(user.id)) {
      return json(res, 403, { error: "self_approval", hint: "自分が作った・直した・依頼した営業文は承認できません。別の承認者に依頼してください" });
    }
    return done({ status: "approved", decided_by: user.id, decided_at: now, decision_note: note, approved_body_hash: bodyHash(d.subject, d.body) }, "approved");
  }
  return json(res, 400, { error: "bad_action", allowed: ["edit", "request", "withdraw", "approve", "reject"] });
}
