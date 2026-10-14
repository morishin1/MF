// AI営業：DB の読み書きの共通部分（設定・分析・営業文の形）。
// 書き込みは API の admin()（service_role）だけ（db/131 は RLS で読むだけ）。だから必ず tenant_id で絞る。

import { DEFAULT_SETTINGS, stopLabel, MODELS } from "./config.js";
import { SEND_CHECK_LABEL } from "./rules.js";
import { bodyHash, composeFinal } from "./draft.js";
import { trackingUrl } from "../sales.js";

export const AI_SQL = "db/131_sales_ai.sql";

const missingTable = (error) => {
  const code = String(error?.code || ""), msg = String(error?.message || "");
  return code === "PGRST205" || code === "42P01" || /schema cache|does not exist/i.test(msg);
};
export { missingTable };

/** 設定（行が無ければ既定値＝止まっている）。表が無ければ notReady */
export async function loadSettings(db, tenantId) {
  const { data, error } = await db.from("gw_sales_ai_settings").select("*").eq("tenant_id", tenantId).maybeSingle();
  if (error) return missingTable(error) ? { notReady: true, settings: { ...DEFAULT_SETTINGS } } : { error };
  return { settings: { ...DEFAULT_SETTINGS, ...(data || {}) }, exists: Boolean(data) };
}

export function shapeSettings(s) {
  return {
    enabled: Boolean(s.enabled), pausedReason: s.paused_reason || null, pausedAt: s.paused_at || null,
    stopLabel: s.enabled ? null : stopLabel(s.paused_reason ? `paused:${s.paused_reason}` : "disabled"),
    monthlyTargetUsd: Number(s.monthly_target_usd), monthlyCapUsd: Number(s.monthly_cap_usd), dailyCapUsd: Number(s.daily_cap_usd),
    dailyCompanyLimit: s.daily_company_limit, hourlyCallLimit: s.hourly_call_limit,
    focusServices: s.focus_services || [], scoreProfiles: s.score_profiles || {}, effectiveThreshold: s.effective_threshold,
    signature: s.signature || "", bannedPhrases: s.banned_phrases || [],
  };
}

export function shapeAnalysis(a) {
  if (!a) return null;
  return {
    id: a.id, companyId: a.company_id, status: a.status, summary: a.summary || "",
    facts: a.facts || [], hypotheses: a.hypotheses || [], uncertainties: a.uncertainties || [],
    score: a.score, services: a.score_detail?.services || a.services || [],
    bestService: (a.score_detail?.services || a.services || [])[0]?.service || null,
    formUrl: a.form_url || null, formPurpose: a.form_purpose || null,
    sendCheck: a.send_check || null, sendCheckLabel: SEND_CHECK_LABEL[a.send_check] || null,
    sendCheckReasons: a.send_check_reasons || [], sendCheckAt: a.send_check_at || null,
    effective: Boolean(a.effective), effectiveReasons: a.effective_reasons || [],
    pages: a.pages || [], skipReason: a.skip_reason || null,
    checkResult: a.check_result || null, checkNote: a.check_note || null,
    model: a.model, createdAt: a.created_at,
  };
}

export const DRAFT_STATUS_LABEL = {
  draft: "下書き", pending: "承認待ち", approved: "承認済み", rejected: "差し戻し", used: "送信に使用済み", superseded: "差し替え済み",
};

export function shapeDraft(d, names = new Map()) {
  if (!d) return null;
  return {
    id: d.id, companyId: d.company_id, analysisId: d.analysis_id, service: d.service || null,
    subject: d.subject || "", body: d.body, rationale: d.rationale || "", version: d.version,
    status: d.status, statusLabel: DRAFT_STATUS_LABEL[d.status] || d.status,
    createdBy: d.created_by, createdByName: names.get(d.created_by) || null,
    requestedBy: d.requested_by, requestedByName: names.get(d.requested_by) || null, requestedAt: d.requested_at,
    decidedBy: d.decided_by, decidedByName: names.get(d.decided_by) || null, decidedAt: d.decided_at,
    decisionNote: d.decision_note || null, approachId: d.approach_id || null,
    createdAt: d.created_at, updatedAt: d.updated_at,
  };
}

/** auth の user_id → 社員名 */
export async function namesOf(db, tenantId, userIds) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const { data } = await db.from("gw_employees").select("user_id, display_name").eq("tenant_id", tenantId).in("user_id", ids);
  return new Map((data || []).map((e) => [e.user_id, e.display_name]));
}

/** 会社ごとの最新の分析（AI を呼んだもの・呼ばずに理由だけ残したもの、どちらも） */
export async function latestAnalyses(db, tenantId, companyIds) {
  const out = new Map();
  if (!companyIds.length) return out;
  const { data, error } = await db.from("gw_sales_ai_analyses").select("*").eq("tenant_id", tenantId)
    .in("company_id", companyIds).order("created_at", { ascending: false }).limit(Math.min(companyIds.length * 5, 2000));
  if (error) throw Object.assign(new Error(error.message), { code: missingTable(error) ? "not_ready" : "db", detail: error });
  for (const a of data || []) if (!out.has(a.company_id)) out.set(a.company_id, a);
  return out;
}

/**
 * アタック（送信）の前に確かめる：AI の分析で「送信不可」「要確認（未確認）」になっていないか。
 * AI の表がまだ無い（db/131 を当てる前）ときは、これまでどおり止めない。
 * @returns {Promise<null | {status:number, body:object}>}
 */
export async function aiSendGuard(db, tenantId, companyId, channel = "form") {
  const { data, error } = await db.from("gw_sales_ai_analyses").select("id, status, send_check, send_check_reasons")
    .eq("tenant_id", tenantId).eq("company_id", companyId).not("send_check", "is", null)
    .order("created_at", { ascending: false }).limit(1);
  if (error) {
    if (missingTable(error)) return null;
    // 読めないときは止める（送ってはいけない先に送らないほうを優先する）
    return { status: 503, body: { error: "ai_check_unavailable", hint: "AI営業の送信可否を確認できませんでした。時間をおいてやり直してください" } };
  }
  const a = (data || [])[0];
  if (!a) return null;
  const reasons = (a.send_check_reasons || []).map((r) => r.label).filter(Boolean);
  if (a.send_check === "blocked") {
    return { status: 409, body: { error: "ai_send_blocked", analysisId: a.id, reasons,
      hint: `AI営業の確認で「送信不可」になっています（${reasons.join("・") || "理由は分析を確認"}）` } };
  }
  if (a.send_check === "manual_review" && channel === "form") {
    return { status: 409, body: { error: "ai_send_check_required", analysisId: a.id, reasons,
      hint: "問い合わせフォームの受付目的と、営業・自動送信の禁止の記載が無いことを確認してから送ってください" } };
  }
  return null;
}

export const modelsInfo = () => ({ ...MODELS });

/** 送信に使える営業文か（承認済み・承認したときから書き換わっていない） */
export function usableDraft(d) {
  if (d.status !== "approved") return { ok: false, body: { error: "ai_draft_not_approved", hint: "この営業文は承認済みではありません（承認後に変更された・差し替えられた可能性があります）" } };
  if (d.approved_body_hash !== bodyHash(d.subject, d.body)) return { ok: false, body: { error: "ai_draft_changed", hint: "承認したあとに営業文が変わっています。承認をやり直してください" } };
  return { ok: true };
}

/** 最終文面：送る人の名前・この会社への専用URL・共通署名 */
export async function finalText(db, ctx, req, d, approach) {
  const [{ data: c }, { settings }] = await Promise.all([
    db.from("gw_sales_companies").select("id, name").eq("tenant_id", ctx.tenantId).eq("id", d.company_id).maybeSingle(),
    loadSettings(db, ctx.tenantId),
  ]);
  return composeFinal(d, {
    company: c?.name || "", sender: ctx.employee?.display_name || "", url: trackingUrl(req, approach.tracking_token),
    service: d.service || "", signature: settings?.signature || "",
  });
}
