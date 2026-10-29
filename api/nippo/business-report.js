// GET /api/nippo/business-report?period=day|week
// 全社の営業・ENGERマッチング実績。日報本文を読まず、Sales権限の管理側だけに返す。
import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin, userClient } from "../../lib/supabase.js";
import { readSourceStates } from "../../lib/sales-proposal-source-state.js";
import { buildBusinessReport } from "../../lib/nippo-business-report.js";
import { canViewBusinessReport } from "../../lib/nippo-business-report-access.js";
import { isDate, jstDate } from "../../lib/nippo.js";

const PAGE_SIZE = 1000;
const MAX_ROWS = 50000;
const PROPOSAL_FIELDS = "id,tenant_id,source_system,source_proposal_id,source_code,source_url,source_company_id,source_stage,"
  + "company_id,company_name,title,job_title,matching_owner_name,matching_owner_email,proposal_owner_id,sales_owner_id,"
  + "matched_at,sent_at,status,close_reason,closed_at,contact_stop,meeting_at,archived_at,created_at,updated_at";
const ACTIVITY_FIELDS = "id,tenant_id,proposal_id,kind,result,outcome,occurred_at,employee_id";
const TASK_FIELDS = "id,tenant_id,proposal_id,kind,assignee_id,due_at,status,source_event";
const EMPLOYEE_FIELDS = "id,tenant_id,display_name,email,status";

async function readAll(sb, table, fields, tenantId) {
  const rows = [];
  for (let offset = 0; offset <= MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await sb.from(table).select(fields).eq("tenant_id", tenantId)
      .order("id", { ascending: true }).range(offset, offset + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if ((data || []).length < PAGE_SIZE) return { data: rows, error: null };
    if (offset >= MAX_ROWS) return { data: null, error: { tooMany: true } };
  }
  return { data: null, error: { tooMany: true } };
}

async function readSyncState(sb, tenantId) {
  const [latest, unresolved] = await Promise.all([
    sb.from("gw_sales_proposal_sync_log").select("received_at")
      .eq("tenant_id", tenantId).order("received_at", { ascending: false }).limit(1),
    sb.from("gw_sales_proposal_sync_log").select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).neq("status", "ok").is("resolved_at", null),
  ]);
  if (latest.error || unresolved.error) return { available: false, error: true };
  return {
    available: true,
    latestReceivedAt: latest.data?.[0]?.received_at || null,
    unresolvedCount: unresolved.count ?? null,
  };
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  res.setHeader?.("Cache-Control", "private, no-store");

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canViewBusinessReport(ctx)) return json(res, 403, { error: "forbidden" });

  const query = new URL(req.url, "http://localhost").searchParams;
  // UIのタブを出し分けるためだけの確認。権限のない利用者には403、Salesデータは読まない。
  if (query.get("access") === "1") return json(res, 200, { available: true });
  const period = query.get("period") === "week" ? "week" : "day";
  const date = isDate(query.get("date")) ? query.get("date") : jstDate();
  const now = new Date().toISOString();
  const sb = admin();

  const [proposalsRead, activitiesRead, tasksRead, employeesRead, sync] = await Promise.all([
    readAll(sb, "gw_sales_proposals", PROPOSAL_FIELDS, ctx.tenantId),
    readAll(sb, "gw_sales_proposal_activities", ACTIVITY_FIELDS, ctx.tenantId),
    readAll(sb, "gw_sales_proposal_tasks", TASK_FIELDS, ctx.tenantId),
    readAll(sb, "gw_employees", EMPLOYEE_FIELDS, ctx.tenantId),
    readSyncState(sb, ctx.tenantId),
  ]);

  const employees = employeesRead.data;
  const employeesById = new Map((employees || []).map((e) => [e.id, e]));
  const proposals = proposalsRead.data?.map((p) => ({
    ...p,
    proposal_owner_name: employeesById.get(p.proposal_owner_id)?.display_name || null,
    sales_owner_name: employeesById.get(p.sales_owner_id)?.display_name || null,
  })) || null;

  let deletedProposalIds = null;
  let sourceStateStatus = process.env.SALES_SOURCE_STATE_ENABLED === "1" ? "unavailable" : "not_enabled";
  if (proposals && process.env.SALES_SOURCE_STATE_ENABLED === "1") {
    const source = await readSourceStates(userClient(req), ctx.tenantId, proposals);
    if (source.error) {
      sourceStateStatus = "unavailable";
      console.error("[nippo/business-report] ENGER source state could not be read");
    } else if (source.available) {
      sourceStateStatus = source.missingIds?.length ? "partial" : "available";
      const proposalIdBySourceId = new Map(proposals.map((p) => [p.source_proposal_id, p.id]));
      deletedProposalIds = new Set([...source.states]
        .filter(([, state]) => state.deleted === true)
        .map(([sourceProposalId]) => proposalIdBySourceId.get(sourceProposalId))
        .filter(Boolean));
    }
  }

  const report = buildBusinessReport({
    period,
    date,
    now,
    proposals,
    activities: activitiesRead.data,
    tasks: tasksRead.data,
    employees,
    sync,
    deletedProposalIds,
    sourceStateStatus,
  });
  report.coverage = {
    sales: proposalsRead.error ? "unavailable" : "available",
    activities: activitiesRead.error ? "unavailable" : "available",
    tasks: tasksRead.error ? "unavailable" : "available",
    employees: employeesRead.error ? "unavailable" : "available",
    sync: sync.available ? "available" : "unavailable",
    notice: [proposalsRead, activitiesRead, tasksRead, employeesRead]
      .some((result) => result.error?.tooMany)
      ? "対象データが取得上限を超えたため、一部の指標を未取得として表示しています。"
      : null,
  };
  if (proposalsRead.error) console.error("[nippo/business-report] Sales proposal data unavailable");
  if (activitiesRead.error) console.error("[nippo/business-report] Sales activity data unavailable");
  if (tasksRead.error) console.error("[nippo/business-report] Sales task data unavailable");
  if (employeesRead.error) console.error("[nippo/business-report] employee directory unavailable");
  return json(res, 200, report);
}
