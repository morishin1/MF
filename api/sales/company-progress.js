// GET /api/sales/company-progress?companyId=…
// Sales の企業詳細「オファー・進捗」タブ。この企業IDに紐づく提案（dx.enger → Sales の提案管理）と、
// 商談準備の紐づけの状態を、日時・担当・状態つきで返す。
//
// ■ 見える範囲は提案管理と同じ
//   営業担当は自分が担当の提案だけ、管理側（経営者・責任者・管理者）は全件（docs/sales-proposals.md §4）。
// ■ 企業ポータルからのオファーは Phase 3（未実装）
//   受け付けていないものを「0件」と見せない。portalOffers.available=false と理由を返す。
import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { canAccessEightEngerDirectory } from "../../lib/sales-enger-scope.js";
import { canManageProposals, STATUS_LABEL, CLOSE_REASON_LABEL } from "../../lib/sales-proposals.js";
import { admin } from "../../lib/supabase.js";
import { isUuid } from "../../lib/sales.js";
import { PORTAL_TABLES as T, LINK_STATUSES, isMissingTable } from "../../lib/sales-company-portal.js";
import { companyInScope } from "../../lib/sales-company-portal-db.js";

const COLS = "id,title,job_title,talent_initials,status,close_reason,matched_at,sent_at,meeting_at,closed_at,sales_owner_id,matching_owner_name,source_stage,updated_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res); if (!user) return;
  res.setHeader?.("Cache-Control", "private, no-store");
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx) || !canAccessEightEngerDirectory(ctx)) return json(res, 403, { error: "forbidden" });
  const companyId = new URL(req.url || "/", "http://localhost").searchParams.get("companyId");
  if (!isUuid(companyId)) return json(res, 400, { error: "invalid_company" });
  const db = admin();
  const scope = await companyInScope(db, ctx.tenantId, companyId);
  if (!scope.ok) return json(res, scope.status, { error: scope.error });
  const manager = canManageProposals(ctx);
  try {
    let q = db.from("gw_sales_proposals").select(COLS).eq("tenant_id", ctx.tenantId).eq("source_company_id", companyId);
    if (!manager) {
      if (!ctx.employee?.id) return json(res, 200, emptyResult(manager, "社員名簿に登録されていないため、担当の提案を確認できません。"));
      q = q.eq("sales_owner_id", ctx.employee.id);
    }
    const [props, links] = await Promise.all([
      q.order("updated_at", { ascending: false }).limit(100),
      db.schema("enger").from(T.links).select("status").eq("tenant_id", ctx.tenantId).eq("company_id", companyId).limit(500),
    ]);
    const proposalsReady = !props.error;
    if (props.error && !isMissingTable(props.error)) return json(res, 503, { error: "progress_unavailable", hint: "提案の進捗を取得できませんでした。" });
    const rows = props.data || [];
    const ownerIds = [...new Set(rows.map((r) => r.sales_owner_id).filter(Boolean))];
    let owners = new Map();
    if (ownerIds.length) {
      const e = await db.from("gw_employees").select("id,display_name").in("id", ownerIds);
      if (!e.error) owners = new Map((e.data || []).map((x) => [x.id, x.display_name]));
    }
    const byStatus = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const linkCount = {};
    for (const l of links.data || []) linkCount[l.status] = (linkCount[l.status] || 0) + 1;
    return json(res, 200, {
      scope: manager ? "all" : "own",
      proposalsReady,
      proposalsHint: proposalsReady ? null : "提案管理の DB（db/138）が未適用です。",
      proposals: rows.map((r) => ({
        id: r.id, title: r.title, jobTitle: r.job_title, talentInitials: r.talent_initials,
        status: r.status, statusLabel: STATUS_LABEL[r.status] || r.status,
        closeReasonLabel: r.close_reason ? CLOSE_REASON_LABEL[r.close_reason] || r.close_reason : null,
        matchedAt: r.matched_at, sentAt: r.sent_at, meetingAt: r.meeting_at, closedAt: r.closed_at, updatedAt: r.updated_at,
        salesOwner: r.sales_owner_id ? owners.get(r.sales_owner_id) || "（名簿にない担当）" : null,
        matchingOwner: r.matching_owner_name || null, engerStage: r.source_stage || null,
        url: `/sales/proposals.html?id=${encodeURIComponent(r.id)}`,
      })),
      byStatus,
      prep: { ready: !links.error, counts: Object.fromEntries(Object.keys(LINK_STATUSES).map((k) => [k, linkCount[k] || 0])), labels: LINK_STATUSES },
      portalOffers: { available: false, note: "企業ポータルからのオファー受付は Phase 3 で開始します（現在は受け付けていません）。受付後は同じオファーIDでここと ENGER DX に表示されます。" },
    });
  } catch {
    return json(res, 503, { error: "progress_unavailable", hint: "提案の進捗を取得できませんでした。" });
  }
}

function emptyResult(manager, hint) {
  return { scope: manager ? "all" : "own", proposalsReady: true, proposalsHint: hint, proposals: [], byStatus: {}, prep: { ready: false, counts: {}, labels: LINK_STATUSES },
    portalOffers: { available: false, note: "企業ポータルからのオファー受付は Phase 3 で開始します（現在は受け付けていません）。" } };
}
