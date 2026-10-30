// GET /api/sales/dashboard-analysis?period=today|yesterday|this_week|last_week|this_month|last_month|last_7|last_30
// GET /api/sales/dashboard-analysis?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD
// Dashboard analysis for /sales/. Every event-date filter uses a JST half-open range.
import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";
import { readSourceStates, sourceStateFor } from "../../lib/sales-proposal-source-state.js";
import { DEFAULT_PERIOD, resolvePeriod } from "../../lib/sales-period.js";
import { buildSalesDashboardAnalysis, previousSalesPeriod } from "../../lib/sales-dashboard-analysis.js";
import { canManageProposals } from "../../lib/sales-proposals.js";

const SQL = "db/138_sales_proposals.sql・db/140_sales_proposal_matching.sql・db/141_sales_cs_closing_handoff.sql・db/142_sales_team_proposals_bulk.sql";
const PAGE_SIZE = 1000;
const MAX_ROWS = 20000;
const PROPOSAL_FIELDS = "id,tenant_id,source_system,source_proposal_id,source_company_id,company_id,company_name,sales_owner_id,proposal_owner_id,cs_owner_id,closing_owner_id,matched_at,sent_at,status,close_reason,closed_at,archived_at";
const ACTIVITY_FIELDS = "id,tenant_id,proposal_id,kind,result,occurred_at,employee_id";

async function readAll(makeQuery) {
  const rows = [];
  for (let offset = 0; offset <= MAX_ROWS; offset += PAGE_SIZE) {
    // Read one extra row at the boundary so exactly MAX_ROWS is valid and
    // larger result sets are reported as unavailable instead of truncated.
    const pageSize = Math.min(PAGE_SIZE, MAX_ROWS - offset + 1);
    const { data, error } = await makeQuery().order("id", { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (rows.length > MAX_ROWS) return { data: null, error: { tooMany: true } };
    if ((data || []).length < pageSize) return { data: rows, error: null };
  }
  return { data: null, error: { tooMany: true } };
}

const scoped = (sb, tenantId, table, fields) => sb.from(table).select(fields).eq("tenant_id", tenantId);

async function readProposalsByIds(sb, tenantId, ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += 100) {
    const result = await readAll(() => scoped(sb, tenantId, "gw_sales_proposals", PROPOSAL_FIELDS)
      .in("id", ids.slice(i, i + 100)));
    if (result.error) return result;
    rows.push(...result.data);
    if (rows.length > MAX_ROWS) return { data: null, error: { tooMany: true } };
  }
  return { data: rows, error: null };
}

async function readMeetingHistory(sb, tenantId, proposalIds) {
  const rows = [];
  for (let i = 0; i < proposalIds.length; i += 100) {
    const result = await readAll(() => scoped(sb, tenantId, "gw_sales_proposal_activities", ACTIVITY_FIELDS)
      .in("proposal_id", proposalIds.slice(i, i + 100)).in("kind", ["meeting", "sent"]));
    if (result.error) return result;
    rows.push(...result.data);
    if (rows.length > MAX_ROWS) return { data: null, error: { tooMany: true } };
  }
  return { data: rows, error: null };
}

function readFailure(res, error) {
  if (error?.sourceState) return json(res, 503, {
    error: "source_state_unavailable",
    hint: "ENGERの同期状態を確認できないため、正確な集計を表示できません。管理者に連携設定を確認してください。",
  });
  if (error?.tooMany) return json(res, 503, {
    error: "dashboard_data_limit", hint: "対象期間の記録が取得上限を超えました。期間を短くして確認してください。",
  });
  const hint = dbSetupHint(error, SQL);
  return json(res, hint ? 503 : 500, {
    error: "dashboard_data_unavailable",
    hint: hint || "Sales・ENGERの記録を取得できませんでした。時間をおいて再度お試しください。",
  });
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  res.setHeader?.("Cache-Control", "private, no-store");

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const query = new URL(req.url, "http://localhost").searchParams;
  const key = query.get("period") || DEFAULT_PERIOD;
  const period = resolvePeriod(key, { from: query.get("from"), to: query.get("to") });
  if (period.error) return json(res, 400, { error: period.error, hint: period.hint });
  const previous = previousSalesPeriod(period);
  const range = { sinceIso: previous.sinceIso, untilIso: period.untilIso };
  const sb = userClient(req);

  const [matchedRead, sentRead, closedRead, meetingsRead, employeesRead] = await Promise.all([
    readAll(() => scoped(sb, ctx.tenantId, "gw_sales_proposals", PROPOSAL_FIELDS)
      .is("archived_at", null).gte("matched_at", range.sinceIso).lt("matched_at", range.untilIso)),
    readAll(() => scoped(sb, ctx.tenantId, "gw_sales_proposals", PROPOSAL_FIELDS)
      .is("archived_at", null).gte("sent_at", range.sinceIso).lt("sent_at", range.untilIso)),
    readAll(() => scoped(sb, ctx.tenantId, "gw_sales_proposals", PROPOSAL_FIELDS)
      .is("archived_at", null).in("status", ["lost", "closed_no_reply", "stopped"])
      .gte("closed_at", range.sinceIso).lt("closed_at", range.untilIso)),
    readAll(() => scoped(sb, ctx.tenantId, "gw_sales_proposal_activities", ACTIVITY_FIELDS)
      .eq("kind", "meeting").eq("result", "done").gte("occurred_at", range.sinceIso).lt("occurred_at", range.untilIso)),
    readAll(() => scoped(sb, ctx.tenantId, "gw_employees", "id,display_name")),
  ]);
  const firstError = [matchedRead, sentRead, closedRead, meetingsRead, employeesRead]
    .find((result) => result?.error)?.error;
  if (firstError) return readFailure(res, firstError);

  const eventProposalRows = [...new Map([
    ...matchedRead.data, ...sentRead.data, ...closedRead.data,
  ].map((row) => [row.id, row])).values()];
  if (eventProposalRows.length > MAX_ROWS) return readFailure(res, { tooMany: true });
  const meetingProposalIds = [...new Set(meetingsRead.data.map((event) => event.proposal_id).filter(Boolean))];
  const cohortProposalIds = [...new Set(eventProposalRows.filter((row) => row.sent_at).map((row) => row.id))];
  const [meetingProposalsRead, meetingHistoryRead] = await Promise.all([
    readProposalsByIds(sb, ctx.tenantId, meetingProposalIds),
    readMeetingHistory(sb, ctx.tenantId, cohortProposalIds),
  ]);
  if (meetingProposalsRead.error) return readFailure(res, meetingProposalsRead.error);
  if (meetingHistoryRead.error) return readFailure(res, meetingHistoryRead.error);

  const proposals = [...new Map([
    ...eventProposalRows, ...meetingProposalsRead.data,
  ].map((row) => [row.id, row])).values()];
  if (proposals.length > MAX_ROWS) return readFailure(res, { tooMany: true });
  const source = await readSourceStates(sb, ctx.tenantId, proposals);
  if (source.error) return readFailure(res, source.error);
  const deletedProposalIds = new Set(proposals
    .filter((proposal) => sourceStateFor(proposal, source.states)?.deleted === true)
    .map((proposal) => proposal.id));
  const analysis = buildSalesDashboardAnalysis({
    period, previous, proposals, meetingEvents: meetingsRead.data,
    meetingHistory: meetingHistoryRead.data, employees: employeesRead.data || [], deletedProposalIds,
  });

  return json(res, 200, {
    ...analysis,
    dataStatus: {
      scope: canManageProposals(ctx) ? "team" : "assigned",
      sourceState: !source.available ? "not_enabled" : source.missingIds?.length ? "partial" : "ready",
      uncheckedEngerCount: source.missingIds?.length || 0,
      note: [
        !canManageProposals(ctx) ? "権限により、閲覧できる担当分を表示しています。" : null,
        !source.available
          ? "ENGERの削除・企業回答の同期は未確認です。表示値はSalesに保存された記録に基づきます。"
          : source.missingIds?.length
            ? `ENGER ${source.missingIds.length}件の同期状態が未確認です。表示値はSalesに保存された記録に基づきます。`
            : null,
      ].filter(Boolean).join(" ") || null,
    },
  });
}
