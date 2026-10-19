// dx.enger 連携の記録（db/138 gw_sales_proposal_sync_log）。管理側だけ
//
// GET   /api/sales/proposals/sync?all=1 … 連携エラー・要確認（未解決。all=1 で直近200件すべて）
// PATCH /api/sales/proposals/sync { id } … 確認済みにする（記録は消さない）
//
// ■ 何が出るか（message）
//   owner_unmatched … 営業担当（dx.enger の CL担当）を社員名簿から決められなかった → 提案管理で担当を割り当てる
//   slack_failed    … 起票の Slack 通知を送れなかった（ベルには届いている）
//   closed_before_sent … 終わった提案に「企業へ送った」が届いた（状態は変えない）
//   db_failed など  … 受け付けに失敗した（dx.enger が再送する。続くときは管理者へ）

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { canManageProposals, isUuid } from "../../../lib/sales-proposals.js";
import { SQL_FILE } from "../../../lib/sales-proposals-db.js";

export const SYNC_MESSAGE_LABEL = {
  owner_unmatched: "営業担当を決められませんでした（担当を割り当ててください）",
  not_sent_yet: "まだ送っていない提案の更新でした（起票していません）",
  concurrent: "同じ提案が同時に届きました（1件にまとめました）",
  slack_failed: "Slack に送れませんでした（ベルの通知は届いています。SALES_SLACK_WEBHOOK_URL を確かめてください）",
  closed_before_sent: "終わった提案（見送り・連絡停止など）に、企業へ提案を送った連携が届きました（状態は変えていません）",
};

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });
  if (!canManageProposals(ctx)) return json(res, 403, { error: "forbidden", hint: "連携エラーは管理者が確認します" });
  const sb = userClient(req);

  if (req.method === "GET") {
    const all = new URL(req.url, "http://localhost").searchParams.get("all") === "1";
    let q = sb.from("gw_sales_proposal_sync_log")
      .select("id, event_id, event_type, source_proposal_id, proposal_id, status, message, attempts, received_at, updated_at, resolved_at")
      .eq("tenant_id", ctx.tenantId);
    if (!all) q = q.neq("status", "ok").is("resolved_at", null);
    const { data, error } = await q.order("received_at", { ascending: false }).limit(200);
    if (error) {
      const hint = dbSetupHint(error, SQL_FILE);
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, 500, { error: "db_failed", detail: error.message });
    }
    return json(res, 200, {
      items: (data || []).map((r) => ({
        id: r.id, eventId: r.event_id, eventType: r.event_type, sourceProposalId: r.source_proposal_id, proposalId: r.proposal_id,
        status: r.status, message: r.message, messageLabel: (r.message || "").split(",").map((m) => SYNC_MESSAGE_LABEL[m] || m).join(" / "),
        attempts: r.attempts, receivedAt: r.received_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at,
      })),
    });
  }
  if (req.method !== "PATCH") return methodNotAllowed(res, ["GET", "PATCH"]);
  const body = await readJson(req);
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id"] });
  const { data, error } = await sb.from("gw_sales_proposal_sync_log").update({ resolved_at: new Date().toISOString(), resolved_by: user.id })
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).is("resolved_at", null).select("id");
  if (error) return json(res, 500, { error: "db_failed", detail: error.message });
  if (!data?.length) return json(res, 404, { error: "not_found" });
  return json(res, 200, { ok: true });
}
