// AI営業：管理（費用・停止・再開・設定）
//
// GET   /api/sales/ai/admin
//         … 設定・今月／今日の費用（確定・予約中）・用途別・失敗・承認待ちの件数。Sales を使える人は見られる
// PATCH /api/sales/ai/admin { action: "start" }                    … 開始（経営者・管理者だけ）
// PATCH /api/sales/ai/admin { action: "pause", note? }             … 停止（経営者・管理者だけ）
// PATCH /api/sales/ai/admin { action: "settings", monthlyTargetUsd?, monthlyCapUsd?, dailyCapUsd?, dailyCompanyLimit?,
//                             effectiveThreshold?, signature?, bannedPhrases? }   … 設定（経営者・管理者だけ）
//
// 費用は AI のトークン代だけ（台帳 gw_sales_ai_usage）。Vercel・Supabase の費用は各社の管理画面で別に見る。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell, canApproveAiSales, canManageAiSales } from "../../../lib/gw.js";
import { admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { aiKey, MAX_MONTHLY_CAP, MODELS } from "../../../lib/sales-ai/config.js";
import { AI_SQL, loadSettings, shapeSettings, missingTable } from "../../../lib/sales-ai/store.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });
  const db = admin();
  if (req.method === "GET") return get(res, db, ctx);
  if (req.method === "PATCH") return patch(req, res, db, ctx, user);
  return methodNotAllowed(res, ["GET", "PATCH"]);
}

/** 日本時間の今月1日・今日の 0 時（UTC の ISO） */
export function jstStarts(now = new Date()) {
  const j = new Date(now.getTime() + 9 * 3600000);
  const y = j.getUTCFullYear(), m = j.getUTCMonth(), d = j.getUTCDate();
  return {
    month: new Date(Date.UTC(y, m, 1) - 9 * 3600000).toISOString(),
    today: new Date(Date.UTC(y, m, d) - 9 * 3600000).toISOString(),
  };
}

const r4 = (n) => Number(Number(n || 0).toFixed(4));

/** 台帳の行から集計（確定は実費、予約中は予約額） */
export function summarize(rows, starts) {
  const blank = () => ({ committedUsd: 0, reservedUsd: 0, calls: 0, failures: 0, byPurpose: {} });
  const month = blank(), today = blank();
  for (const u of rows) {
    if (u.status === "released") continue;
    for (const [bucket, since] of [[month, starts.month], [today, starts.today]]) {
      if (u.created_at < since) continue;
      if (u.status === "committed") bucket.committedUsd += Number(u.cost_usd || 0);
      else bucket.reservedUsd += Number(u.reserved_usd || 0);
      bucket.calls++;
      if (u.status === "committed" && u.outcome !== "ok") bucket.failures++;
      const p = (bucket.byPurpose[u.purpose] ||= { calls: 0, usd: 0, inputTokens: 0, outputTokens: 0 });
      p.calls++;
      p.usd += Number(u.status === "committed" ? u.cost_usd : u.reserved_usd) || 0;
      p.inputTokens += u.input_tokens || 0;
      p.outputTokens += u.output_tokens || 0;
    }
  }
  for (const b of [month, today]) {
    b.committedUsd = r4(b.committedUsd); b.reservedUsd = r4(b.reservedUsd);
    for (const p of Object.values(b.byPurpose)) p.usd = r4(p.usd);
  }
  return { month, today };
}

async function get(res, db, ctx) {
  const st = await loadSettings(db, ctx.tenantId);
  if (st.error) return json(res, 500, { error: "db_query_failed", detail: st.error.message });
  const base = { configured: Boolean(aiKey()), models: { ...MODELS }, canManage: canManageAiSales(ctx), canApprove: canApproveAiSales(ctx),
    costNote: "ここに出す費用は AI のトークン代だけです。Vercel・Supabase の費用は、それぞれの管理画面で確認してください" };
  if (st.notReady) return json(res, 200, { ready: false, ...base, message: dbSetupHint({ code: "PGRST205" }, AI_SQL) });

  const starts = jstStarts();
  const [{ data: rows, error }, { data: errors }, { data: pending }] = await Promise.all([
    db.from("gw_sales_ai_usage").select("purpose, model, status, reserved_usd, cost_usd, input_tokens, output_tokens, outcome, created_at")
      .eq("tenant_id", ctx.tenantId).gte("created_at", starts.month).limit(20000),
    db.from("gw_sales_ai_usage").select("purpose, model, outcome, error_code, created_at")
      .eq("tenant_id", ctx.tenantId).eq("status", "committed").neq("outcome", "ok").order("created_at", { ascending: false }).limit(10),
    db.from("gw_sales_ai_drafts").select("id").eq("tenant_id", ctx.tenantId).eq("status", "pending").limit(500),
  ]);
  if (error) return missingTable(error) ? json(res, 200, { ready: false, ...base, message: dbSetupHint(error, AI_SQL) }) : json(res, 500, { error: "db_query_failed", detail: error.message });
  return json(res, 200, {
    ready: true, ...base, settings: shapeSettings(st.settings), usage: summarize(rows || [], starts),
    recentErrors: (errors || []).map((e) => ({ purpose: e.purpose, model: e.model, outcome: e.outcome, error: e.error_code, at: e.created_at })),
    pendingCount: (pending || []).length,
  });
}

const num = (v, min, max) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

async function patch(req, res, db, ctx, user) {
  if (!canManageAiSales(ctx)) return json(res, 403, { error: "manager_only", hint: "AI営業の開始・停止・設定は、経営者・管理者だけが変更できます" });
  const body = await readJson(req);
  const st = await loadSettings(db, ctx.tenantId);
  if (st.error) return json(res, 500, { error: "db_query_failed", detail: st.error.message });
  if (st.notReady) return json(res, 503, { error: "not_ready", message: dbSetupHint({ code: "PGRST205" }, AI_SQL) });
  const now = new Date().toISOString();
  let patchRow;

  if (body.action === "start") {
    if (!aiKey()) return json(res, 409, { error: "ai_not_configured", hint: "先に Vercel の環境変数 SALES_AI_ANTHROPIC_API_KEY を設定してください" });
    patchRow = { enabled: true, paused_reason: null, paused_at: null };
  } else if (body.action === "pause") {
    patchRow = { enabled: false, paused_reason: "manual", paused_at: now };
  } else if (body.action === "settings") {
    const cap = num(body.monthlyCapUsd, 0, MAX_MONTHLY_CAP);
    const capNow = cap ?? Number(st.settings.monthly_cap_usd);
    const fields = {
      monthly_cap_usd: cap,
      monthly_target_usd: num(body.monthlyTargetUsd, 0, capNow),
      daily_cap_usd: num(body.dailyCapUsd, 0, capNow),
      daily_company_limit: num(body.dailyCompanyLimit, 0, 2000),
      effective_threshold: num(body.effectiveThreshold, 0, 100),
    };
    const bad = Object.entries(fields).filter(([, v]) => v === null).map(([k]) => k);
    if (bad.length) return json(res, 400, { error: "bad_value", fields: bad, hint: `値が正しくありません（月の上限は ${MAX_MONTHLY_CAP} ドルまで。目標・日の上限は月の上限以下）` });
    patchRow = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (patchRow.daily_company_limit !== undefined) patchRow.daily_company_limit = Math.floor(patchRow.daily_company_limit);
    if (patchRow.effective_threshold !== undefined) patchRow.effective_threshold = Math.floor(patchRow.effective_threshold);
    if (body.signature !== undefined) {
      const sig = String(body.signature || "").trim();
      if (sig.length > 1000) return json(res, 400, { error: "bad_value", fields: ["signature"], hint: "署名は1,000字までです" });
      patchRow.signature = sig || null;
    }
    if (body.bannedPhrases !== undefined) {
      if (!Array.isArray(body.bannedPhrases)) return json(res, 400, { error: "bad_value", fields: ["bannedPhrases"] });
      patchRow.banned_phrases = [...new Set(body.bannedPhrases.map((s) => String(s || "").trim().slice(0, 50)).filter(Boolean))].slice(0, 50);
    }
    if (!Object.keys(patchRow).length) return json(res, 400, { error: "nothing_to_update" });
  } else {
    return json(res, 400, { error: "bad_action", allowed: ["start", "pause", "settings"] });
  }

  patchRow.updated_by = user.id;
  patchRow.updated_at = now;
  const { data: saved, error } = await db.from("gw_sales_ai_settings")
    .upsert({ tenant_id: ctx.tenantId, ...patchRow }, { onConflict: "tenant_id" }).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `sales.ai_${body.action}`, target: "sales_ai:settings",
    detail: { ...patchRow, updated_by: undefined, updated_at: undefined, note: body.note ? String(body.note).slice(0, 300) : undefined } });
  return json(res, 200, { settings: shapeSettings({ ...st.settings, ...saved }) });
}
