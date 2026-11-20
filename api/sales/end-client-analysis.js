// GET /api/sales/end-client-analysis?days=30|90|365
// ENGER + Sales の確認済み登録件数を読み取り専用で横断表示する。
// 「提案可」「稼働中」は記録の状態であり、本人確認済み供給/実売上ではない。
// サービスロールはEightのテナント認可後のみ使用し、企業名・個人情報・単価を返さない。
import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { canAccessEightEngerDirectory } from "../../lib/sales-enger-scope.js";
import { canManageProposals } from "../../lib/sales-proposals.js";
import {
  END_CLIENT_PERIODS, SUPPLY_ROLE_TITLES, periodStartJst,
  summarizeEngagements, summarizeEngerProposals, summarizeEndClientCoverage,
} from "../../lib/sales-end-client-analysis.js";

const PAGE = 1000;
const MAX_ROWS = 20000;

async function exactCount(query) {
  const { count, error } = await query;
  if (error) throw error;
  if (!Number.isSafeInteger(count)) throw new Error("count_unavailable");
  return count;
}

async function readAll(makeQuery) {
  const rows = [];
  for (let offset = 0; offset <= MAX_ROWS; offset += PAGE) {
    const size = Math.min(PAGE, MAX_ROWS - offset + 1);
    const { data, error } = await makeQuery().order("id", { ascending: true })
      .range(offset, offset + size - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (rows.length > MAX_ROWS) throw new Error("data_limit");
    if ((data || []).length < size) return rows;
  }
  throw new Error("data_limit");
}

const availableCandidate = (q) => q.is("deleted_at", null)
  .or("is_closed.is.null,is_closed.eq.false");
const availableJob = (q) => q.is("deleted_at", null)
  .or("is_closed.is.null,is_closed.eq.false");

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  res.setHeader?.("Cache-Control", "private, no-store");
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx) || !canAccessEightEngerDirectory(ctx)) {
    return json(res, 403, { error: "forbidden" });
  }

  const params = new URL(req.url || "/", "http://localhost").searchParams;
  const rawDays = params.get("days") || "90";
  if (!/^(30|90|365)$/.test(rawDays)) {
    return json(res, 400, { error: "invalid_period", hint: "30・90・365日から選んでください。" });
  }
  const days = Number(rawDays);
  if (!END_CLIENT_PERIODS.includes(days)) return json(res, 400, { error: "invalid_period" });

  const asOf = new Date();
  const sinceIso = periodStartJst(days, asOf);
  const source30Iso = periodStartJst(30, asOf);
  const management = canManageProposals(ctx);
  try {
    const db = admin();
    const ec = (table) => db.schema("enger").from(table);
    const sales = (table) => db.from(table);
    const inTenant = (q) => q.eq("tenant_id", ctx.tenantId);
    const countEc = (table, filter = (q) => q) =>
      exactCount(filter(ec(table).select("id", { count: "exact", head: true })));
    const countSales = (table, filter = (q) => q) =>
      exactCount(filter(inTenant(sales(table).select("id", { count: "exact", head: true }))));

    // 同じ会社・人材が異なるテーブルに載るため、異種の件数は絶対に加算しない。
    const countQueries = {
      companiesRegistered: countEc("companies", (q) => q.is("deleted_at", null)),
      salesTargetCompanies: countSales("gw_sales_companies"),
      salesApproachesTotal: countSales("gw_sales_approaches"),
      salesSentInPeriod: countSales("gw_sales_approaches", (q) => q.gte("sent_at", sinceIso)),
      salesClickedInPeriod: countSales("gw_sales_approaches", (q) => q.gte("first_click_at", sinceIso)),
      salesProposalsSentInPeriod: countSales("gw_sales_proposals", (q) => q.gte("sent_at", sinceIso).is("archived_at", null)),
      salesMeetingSessionsInPeriod: countSales("gw_sales_live_meeting_sessions", (q) => q.gte("started_at", sinceIso)),
      engerCandidateRecords: countEc("candidates"),
      engerCandidatesAvailable: countEc("candidates", availableCandidate),
      engerCandidatesImmediate: countEc("candidates", (q) => availableCandidate(q).eq("status", "即アサイン可能")),
      engerCandidatesProposable: countEc("candidates", (q) => availableCandidate(q).eq("status", "提案可")),
      engerCandidateSheets: countEc("candidates", (q) => q.is("deleted_at", null)
        .not("skill_sheet_url", "is", null).neq("skill_sheet_url", "")),
      engerCandidateSourceMail30: countEc("candidates", (q) => q.is("deleted_at", null)
        .gte("source_mail_at", source30Iso)),
      engerJobsRegistered: countEc("jobs"),
      engerJobsUnclosed: countEc("jobs", availableJob),
      portalMembers: countEc("dx2_company_portal_members", (q) => q.eq("tenant_id", ctx.tenantId).is("disabled_at", null)),
      portalOffers: countEc("dx2_company_portal_offers", (q) => q.eq("tenant_id", ctx.tenantId)),
      portalPartnerSubmissions: countEc("dx2_company_partner_submissions", (q) => q.eq("tenant_id", ctx.tenantId)),
      ...(management ? {
        salesDealRecords: countSales("gw_sales_deals"),
        salesWonDealRecords: countSales("gw_sales_deals", (q) => q.eq("stage", "won")),
        salesSuccessFeeRecords: countSales("gw_sales_success_fees"),
      } : {}),
    };
    const rolePromises = SUPPLY_ROLE_TITLES.map((title) =>
      countEc("candidates", (q) => availableCandidate(q).eq("title", title)));

    const [counts, roles, endCompanies, proposalRows, engagementRows] = await Promise.all([
      Promise.all(Object.entries(countQueries).map(async ([key, promise]) => [key, await promise]))
        .then((pairs) => Object.fromEntries(pairs)),
      Promise.all(rolePromises),
      readAll(() => ec("companies").select("id,industry,employee_band").is("deleted_at", null)
        .eq("is_end_client", true)),
      readAll(() => ec("proposals").select("id,stage,lost_reason,lost_reason_category,lost_detail_reason")
        .is("deleted_at", null)),
      management ? readAll(() => ec("engagements").select("id,status,company,proposal_id,end_date"))
        : Promise.resolve(null),
    ]);

    return json(res, 200, {
      version: 1,
      days,
      periodSince: sinceIso.slice(0, 10),
      asOfJst: new Date(asOf.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10),
      scope: management ? "manager" : "sales",
      sources: ["Sales (public)", "ENGER (enger)"],
      inventory: {
        registeredCompanies: counts.companiesRegistered,
        endClients: summarizeEndClientCoverage(endCompanies),
        registeredCandidates: counts.engerCandidateRecords,
        candidatesAvailable: counts.engerCandidatesAvailable,
        immediate: counts.engerCandidatesImmediate,
        proposable: counts.engerCandidatesProposable,
        candidateSheets: counts.engerCandidateSheets,
        candidateSourceMail30: counts.engerCandidateSourceMail30,
        registeredJobs: counts.engerJobsRegistered,
        jobsNotClosed: counts.engerJobsUnclosed,
        proposalHistory: summarizeEngerProposals(proposalRows),
        roles: SUPPLY_ROLE_TITLES.map((title, i) => ({ title, count: roles[i] })),
      },
      activity: {
        salesTargets: counts.salesTargetCompanies,
        approachesTotal: counts.salesApproachesTotal,
        approachesSent: counts.salesSentInPeriod,
        approachClicks: counts.salesClickedInPeriod,
        proposalsSent: counts.salesProposalsSentInPeriod,
        meetingScreenSessions: counts.salesMeetingSessionsInPeriod,
        portalActiveMembers: counts.portalMembers,
        portalOffers: counts.portalOffers,
        portalSubmissions: counts.portalPartnerSubmissions,
      },
      contracts: management ? {
        ...summarizeEngagements(engagementRows),
        salesDealRecords: counts.salesDealRecords,
        salesWonDealRecords: counts.salesWonDealRecords,
        salesSuccessFeeRecords: counts.salesSuccessFeeRecords,
      } : null,
      notes: [
        "人材の稼働・提案可は保存されたステータスであり、最新の紹介承諾・所属確認ではありません。",
        "ENGER稼働契約記録は月次の請求・入金・実稼働を証明せず、Sales受注台帳と単純に比較できません。",
        "Salesの商談画面セッションは商談実施件数ではありません。",
        "見送り理由は過去の入力内容から便宜的に分類しています。",
        "業種と企業規模が未入力の企業は、業界別分析の対象にできません。",
      ],
    });
  } catch (error) {
    // テナント外の情報や生のデータベースエラーはクライアントに返さない。
    const limited = error?.message === "data_limit";
    return json(res, 503, {
      error: limited ? "analysis_data_limit" : "analysis_unavailable",
      hint: limited
        ? "履歴が集計上限を超えたため、不正確な部分集計を表示しません。集計方式の更新が必要です。"
        : "Sales・ENGERの記録を完全に集計できませんでした。データ連携と権限を確認してください。",
    });
  }
}
