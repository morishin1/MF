// AI営業：商材の一次分類で候補を探す（lib/sales-ai/classify.js・db/131 gw_sales_ai_classifications）
//
// GET  /api/sales/ai/classify?service=8EC・8RENT&limit=50
//        … 対象の社数・分類済み・未分類（pending：未分類の会社の id。画面がこれを 20社ずつ POST する）と、
//          選んだ商材が合いそうな順の候補（分析済みかどうかつき）
//          対象 = 詳しい分析と同じ（NG・非表示・対象外・商談以降・直近30日アタック済み・サイトなし を除く）
// POST /api/sales/ai/classify { companyIds: [<uuid>, …] }（1回 20社まで）
//        … 登録情報＋トップページ1枚で分類する。企業マスタ（提案サービス欄など）は書き換えない
//
// 書き込みは admin()（service_role）で tenant_id を絞る。db/131 の RLS は「読むだけ」。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { isUuid } from "../../../lib/sales.js";
import { aiKey, stopLabel } from "../../../lib/sales-ai/config.js";
import { aiClient } from "../../../lib/sales-ai/client.js";
import { skipReason } from "../../../lib/sales-ai/analyze.js";
import {
  CLASSIFY_BATCH, classifyCompanies, rankCandidates, isFocusService, serviceFieldIssue,
} from "../../../lib/sales-ai/classify.js";
import { AI_SQL, loadSettings, missingTable } from "../../../lib/sales-ai/store.js";

const COMPANY_COLS = "id, name, industry, region, size, site_url, service, status, ng_reason, hidden_at, last_sent_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });
  const db = admin();
  if (req.method === "GET") return get(req, res, db, ctx);
  if (req.method === "POST") return run(req, res, db, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function get(req, res, db, ctx) {
  const sp = new URL(req.url || "/", "http://localhost").searchParams;
  const service = sp.get("service") || "8EC・8RENT";
  if (!isFocusService(service)) return json(res, 400, { error: "bad_service" });
  const limit = Math.min(Math.max(Math.floor(Number(sp.get("limit"))) || 50, 1), 200);

  const st = await loadSettings(db, ctx.tenantId);
  if (st.error) return json(res, 500, { error: "db_query_failed", detail: st.error.message });
  if (st.notReady) return json(res, 200, { ready: false, message: dbSetupHint({ code: "PGRST205" }, AI_SQL) });

  const [{ data: companies, error }, { data: cls, error: e2 }, { data: analyses }] = await Promise.all([
    db.from("gw_sales_companies").select(COMPANY_COLS).eq("tenant_id", ctx.tenantId).limit(10000),
    db.from("gw_sales_ai_classifications").select("*").eq("tenant_id", ctx.tenantId).limit(10000),
    db.from("gw_sales_ai_analyses").select("company_id, status, score, send_check, created_at").eq("tenant_id", ctx.tenantId)
      .order("created_at", { ascending: false }).limit(10000),
  ]);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (e2) {
    if (missingTable(e2)) return json(res, 200, { ready: false, message: dbSetupHint(e2, AI_SQL) });
    return json(res, 500, { error: "db_query_failed", detail: e2.message });
  }
  const eligible = (companies || []).filter((c) => !skipReason(c));
  const byCompany = new Map((cls || []).map((r) => [r.company_id, r]));
  const lastAnalysis = new Map();
  for (const a of analyses || []) if (!lastAnalysis.has(a.company_id)) lastAnalysis.set(a.company_id, a);

  const classified = eligible.filter((c) => byCompany.has(c.id));
  const pending = eligible.filter((c) => !byCompany.has(c.id)).map((c) => c.id);
  const rows = classified.map((c) => ({ ...byCompany.get(c.id), name: c.name, company: c }));
  const ranked = rankCandidates(rows, service).filter((r) => Number(r.fits?.[service] || 0) > 0).slice(0, limit);

  return json(res, 200, {
    ready: true, enabled: Boolean(st.settings.enabled), configured: Boolean(aiKey()), service, batch: CLASSIFY_BATCH,
    counts: {
      companies: (companies || []).length, eligible: eligible.length, classified: classified.length, pending: pending.length,
      // 提案サービス欄に電話番号などが入っている会社（直さない。数だけ出す）
      invalidServiceField: (companies || []).filter((c) => serviceFieldIssue(c.service)).length,
      // 選んだ商材が 7点以上の会社
      strong: rows.filter((r) => Number(r.fits?.[service] || 0) >= 7).length,
    },
    pending: pending.slice(0, 2000),
    candidates: ranked.map((r) => {
      const a = lastAnalysis.get(r.company_id);
      return {
        companyId: r.company_id, fit: Number(r.fits?.[service] || 0), fits: r.fits, bestService: r.best_service,
        confidence: r.confidence, reason: r.reason, source: r.source, siteStatus: r.site_status,
        serviceFieldInvalid: Boolean(r.service_field_invalid), classifiedAt: r.classified_at,
        company: { id: r.company.id, name: r.company.name, industry: r.company.industry, region: r.company.region,
          siteUrl: r.company.site_url, status: r.company.status },
        analysis: a ? { status: a.status, score: a.score, sendCheck: a.send_check, createdAt: a.created_at } : null,
      };
    }),
  });
}

async function run(req, res, db, ctx, user) {
  const body = await readJson(req);
  const ids = [...new Set((Array.isArray(body.companyIds) ? body.companyIds : []).filter(isUuid))];
  if (!ids.length) return json(res, 400, { error: "invalid_body", required: ["companyIds"] });
  if (ids.length > CLASSIFY_BATCH) return json(res, 400, { error: "too_many", hint: `1回に分類できるのは${CLASSIFY_BATCH}社までです`, max: CLASSIFY_BATCH });

  const st = await loadSettings(db, ctx.tenantId);
  if (st.error) return json(res, 500, { error: "db_query_failed", detail: st.error.message });
  if (st.notReady) return json(res, 503, { error: "not_ready", message: dbSetupHint({ code: "PGRST205" }, AI_SQL) });
  if (!st.settings.enabled) {
    const reason = st.settings.paused_reason ? `paused:${st.settings.paused_reason}` : "disabled";
    return json(res, 409, { error: "ai_stopped", reason, hint: stopLabel(reason) });
  }
  if (!aiKey()) return json(res, 503, { error: "ai_not_configured", hint: "AI営業の API キー（SALES_AI_ANTHROPIC_API_KEY）が未設定です。管理者に依頼してください" });

  const { data: companies, error } = await db.from("gw_sales_companies").select(COMPANY_COLS).eq("tenant_id", ctx.tenantId).in("id", ids);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  const found = new Set((companies || []).map((c) => c.id));

  let out;
  try {
    out = await classifyCompanies({ db, client: aiClient(), tenantId: ctx.tenantId, employeeId: ctx.employee?.id || null, userId: user.id, companies: companies || [] });
  } catch (e) {
    if (missingTable(e.detail)) return json(res, 503, { error: "not_ready", message: dbSetupHint(e.detail, AI_SQL) });
    return json(res, 500, { error: e.code || "classify_failed", detail: e.message });
  }
  const results = [...out.results, ...ids.filter((id) => !found.has(id)).map((id) => ({ companyId: id, result: "skipped", reason: "not_found" }))];
  const count = (k) => results.filter((r) => r.result === k).length;
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.ai_classify", target: `sales_ai:${ids.length}`,
    detail: { ok: count("ok"), skipped: count("skipped"), failed: count("failed"), stoppedBy: out.stopped || null } });
  return json(res, 200, {
    classified: count("ok"), skipped: count("skipped"), failed: count("failed"),
    results: results.map((r) => ({ companyId: r.companyId, result: r.result, reason: r.reason || null, best: r.best || null })),
    stopped: out.stopped ? { reason: out.stopped, hint: stopLabel(out.stopped) } : null,
  });
}
