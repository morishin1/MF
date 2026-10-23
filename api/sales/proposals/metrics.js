// /sales ホームの読み取り専用集計。追加DB/書き込み権限は不要。
// 期間は「起票日基準コホート」。後日の電話/引継ぎ/成約まで追跡する。
import { json, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { canManageProposals } from "../../../lib/sales-proposals.js";
import { loadPeople, inChunks } from "../../../lib/sales-proposals-db.js";
import { periodStartJst } from "../../../lib/sales.js";
import { computeSalesDashboardMetrics } from "../../../lib/sales-dashboard-metrics.js";

const LIMIT = 5000;
const ACT_LIMIT = 2000;
const FIELDS = "id,created_at,matched_at,sent_at,status,handoff_stage,cs_owner_id,closing_owner_id,sales_owner_id,matching_owner_name,close_reason,meeting_at,archived_at";
const ACT_FIELDS = "proposal_id,kind,result,outcome,occurred_at,employee_id";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !canSell(ctx)) return json(res, 403, { error: "forbidden" });
  const requested = Number(new URL(req.url, "http://localhost").searchParams.get("days"));
  const days = [1, 7, 30, 90, 365].includes(requested) ? requested : 30;
  const { date: since } = periodStartJst(days);
  const sb = userClient(req);

  const { data, error } = await sb.from("gw_sales_proposals").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).is("archived_at", null)
    .order("created_at", { ascending: false }).limit(LIMIT + 1);
  if (error) {
    const message = dbSetupHint(error, "db/138_sales_proposals.sql");
    return json(res, message ? 503 : 500, message
      ? { error: "not_ready", message } : { error: "db_failed", detail: error.message });
  }
  const truncated = (data || []).length > LIMIT;
  const rows = (data || []).slice(0, LIMIT);
  // 管理権限のないメンバーの集計は自分が現担当/CS/クロージング担当の案件だけ。
  const manager = canManageProposals(ctx);
  const me = ctx.employee?.id || null;
  const scoped = manager ? rows : rows.filter((p) => me && [p.sales_owner_id, p.cs_owner_id, p.closing_owner_id].includes(me));
  const cohort = scoped.filter((p) => {
    const basis = p.matched_at || p.created_at || p.sent_at;
    return basis && new Date(basis).getTime() >= new Date(since + "T00:00:00+09:00").getTime();
  });
  const ids = cohort.map((p) => p.id);
  let activityTruncated = false;
  const [acts, people] = await Promise.all([
    inChunks(ids, async (part) => {
      const result = await sb.from("gw_sales_proposal_activities").select(ACT_FIELDS)
        .eq("tenant_id", ctx.tenantId).in("proposal_id", part)
        .in("kind", ["sent", "call", "reply", "meeting"]).order("occurred_at", { ascending: true })
        .limit(ACT_LIMIT + 1);
      if ((result.data || []).length > ACT_LIMIT) {
        activityTruncated = true;
        return { ...result, data: result.data.slice(0, ACT_LIMIT) };
      }
      return result;
    }),
    loadPeople(ctx.tenantId),
  ]);
  if (acts.error) return json(res, 500, { error: "db_failed", detail: acts.error.message });
  // 1チャンクの活動が上限を超えると電話率等が不正確になるので警告を返す。
  const result = computeSalesDashboardMetrics(scoped, acts.data || [], { since, days, nameOf: people.nameOf });
  return json(res, 200, {
    ...result, manager, truncated, activityTruncated,
    notice: truncated ? "保存済みの提案が5,000件を超えています。最新5,000件だけの参考集計です。" : null,
  });
}
