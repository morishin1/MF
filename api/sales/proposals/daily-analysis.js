// GET /api/sales/proposals/daily-analysis?date=YYYY-MM-DD
// 指定日の提案送信と営業活動を、日本時間の境界で数える。
import { json, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { readSourceStates } from "../../../lib/sales-proposal-source-state.js";
import { buildDailyProposalAnalysis } from "../../../lib/sales-proposal-daily-analysis.js";
import { isDate, jstDate, nextDay } from "../../../lib/nippo.js";

const PAGE_SIZE = 1000;
const MAX_ROWS = 20000;
const PROPOSAL_FIELDS = "id,tenant_id,source_system,source_proposal_id,company_name,title,sent_at,status,close_reason,closed_at,archived_at";
const ACTIVITY_FIELDS = "id,tenant_id,proposal_id,kind,result,occurred_at,employee_id";
const LOST_STATUSES = ["lost", "closed_no_reply", "stopped"];

function validDay(value) {
  if (!isDate(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function readAll(makeQuery) {
  const rows = [];
  for (let offset = 0; offset <= MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await makeQuery().order("id", { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if ((data || []).length < PAGE_SIZE) return { data: rows, error: null };
    if (offset >= MAX_ROWS) return { data: null, error: { tooMany: true } };
  }
  return { data: null, error: { tooMany: true } };
}

async function readProposalsByIds(sb, tenantId, ids) {
  const rows = [];
  for (let i = 0; i < ids.length; i += 100) {
    const result = await readAll(() => sb.from("gw_sales_proposals").select(PROPOSAL_FIELDS)
      .eq("tenant_id", tenantId).in("id", ids.slice(i, i + 100)));
    if (result.error) return result;
    rows.push(...result.data);
  }
  return { data: rows, error: null };
}

async function readMeetingProposalIds(sb, tenantId, proposalIds) {
  const ids = new Set();
  for (let i = 0; i < proposalIds.length; i += 100) {
    const result = await readAll(() => sb.from("gw_sales_proposal_activities").select("proposal_id")
      .eq("tenant_id", tenantId).in("proposal_id", proposalIds.slice(i, i + 100))
      .eq("kind", "meeting").eq("result", "done"));
    if (result.error) return result;
    for (const row of result.data) ids.add(row.proposal_id);
  }
  return { data: ids, error: null };
}

function readFailure(res, error) {
  if (error?.sourceState) return json(res, 503, {
    error: "source_state_unavailable", hint: "ENGER連携状態を確認できないため、日別実績を表示できません。管理者に連携設定の確認を依頼してください。",
  });
  if (error?.tooMany) return json(res, 503, {
    error: "daily_data_limit", hint: "選択日の記録が取得上限を超えました。期間を分けて確認してください。",
  });
  const hint = dbSetupHint(error, "db/138_sales_proposals.sql");
  return json(res, hint ? 503 : 500, { error: "daily_data_unavailable", hint: hint || "選択日の営業記録を取得できませんでした。" });
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
  const date = query.get("date") || jstDate();
  if (!validDay(date)) return json(res, 400, { error: "invalid_date", hint: "集計日をカレンダーから選んでください。" });

  const start = new Date(`${date}T00:00:00+09:00`).toISOString();
  const end = new Date(`${nextDay(date)}T00:00:00+09:00`).toISOString();
  const sb = userClient(req);
  const [sentRead, closedRead, activitiesRead] = await Promise.all([
    readAll(() => sb.from("gw_sales_proposals").select(PROPOSAL_FIELDS).eq("tenant_id", ctx.tenantId)
      .is("archived_at", null).gte("sent_at", start).lt("sent_at", end)),
    readAll(() => sb.from("gw_sales_proposals").select(PROPOSAL_FIELDS).eq("tenant_id", ctx.tenantId)
      .is("archived_at", null).in("status", LOST_STATUSES).gte("closed_at", start).lt("closed_at", end)),
    readAll(() => sb.from("gw_sales_proposal_activities").select(ACTIVITY_FIELDS).eq("tenant_id", ctx.tenantId)
      .in("kind", ["call", "mail", "reply", "meeting"]).gte("occurred_at", start).lt("occurred_at", end)),
  ]);
  const firstError = [sentRead, closedRead, activitiesRead].find((result) => result.error)?.error;
  if (firstError) return readFailure(res, firstError);

  const activityProposalIds = [...new Set(activitiesRead.data.map((row) => row.proposal_id))];
  const [activityProposalsRead, meetingIdsRead] = await Promise.all([
    readProposalsByIds(sb, ctx.tenantId, activityProposalIds),
    readMeetingProposalIds(sb, ctx.tenantId, sentRead.data.map((row) => row.id)),
  ]);
  if (activityProposalsRead.error) return readFailure(res, activityProposalsRead.error);
  if (meetingIdsRead.error) return readFailure(res, meetingIdsRead.error);

  const proposals = [...new Map([
    ...sentRead.data, ...closedRead.data, ...activityProposalsRead.data,
  ].map((row) => [row.id, row])).values()];
  const source = await readSourceStates(sb, ctx.tenantId, proposals);
  if (source.error) return readFailure(res, { ...source.error, sourceState: true });
  const proposalIdBySourceId = new Map(proposals.map((p) => [p.source_proposal_id, p.id]));
  const deletedProposalIds = new Set([...source.states]
    .filter(([, state]) => state.deleted === true)
    .map(([sourceId]) => proposalIdBySourceId.get(sourceId)).filter(Boolean));
  const activeProposalIds = new Set(proposals.filter((p) => !p.archived_at && !deletedProposalIds.has(p.id)).map((p) => p.id));
  const summary = buildDailyProposalAnalysis({
    date,
    proposals: sentRead.data,
    closedProposals: closedRead.data,
    activities: activitiesRead.data,
    meetingProposalIds: meetingIdsRead.data,
    deletedProposalIds,
    activeProposalIds,
  });
  summary.sourceStateStatus = process.env.SALES_SOURCE_STATE_ENABLED === "1"
    ? (source.missingIds?.length ? "partial" : "available") : "not_enabled";
  return json(res, 200, summary);
}
