import { requireUser } from "../../../lib/auth.js";
import { gwContext } from "../../../lib/gw.js";
import { admin } from "../../../lib/supabase.js";
import { json, methodNotAllowed, readJson } from "../../../lib/http.js";
import { canManageProposals, STATUS_LABEL } from "../../../lib/sales-proposals.js";
import { salesStage } from "../../../lib/sales-proposal-progress.js";
import { boundedText, reviewAccess, UUID } from "../../../lib/enger-sales-review.js";
import { readEngerCoordinationSource } from "../../../lib/enger-proposal-coordination.js";

const TABLE = "gw_enger_proposal_coordination";
const FIELDS = "source_revision,decision,next_step,sales_confirmed_by,sales_confirmed_at,enger_confirmed_by,enger_confirmed_at,revision";
const fail = (res, status, error, hint) => json(res, status, { error, hint });
const conflict = (res) => fail(res, 409, "coordination_changed", "提案の情報が更新されました。最新の内容を読み直してから操作してください。");

export async function runProposalCoordination(req, res, { sb, ctx, user, roles, body = {} }) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const id = req.method === "GET" ? params.get("id") : body.id;
  const sourceId = req.method === "GET" ? params.get("sourceId") : body.sourceId;
  if (Boolean(id) === Boolean(sourceId) || !UUID.test(id || sourceId || "")) return fail(res, 400, "invalid_proposal", "対象の提案を開き直してください。");
  if (!roles.sales && !roles.enger) return fail(res, 403, "forbidden", "SalesまたはENGERの社内担当者でログインしてください。");
  const p = await sb.from("gw_sales_proposals")
    .select("id,source_proposal_id,sales_owner_id,sent_at,status,close_reason")
    .eq("tenant_id", ctx.tenantId).eq("source_system", "enger").is("archived_at", null)
    .eq(id ? "id" : "source_proposal_id", id || sourceId).maybeSingle();
  if (p.error) throw p.error;
  const proposal = p.data;
  if (!proposal || !UUID.test(proposal.source_proposal_id || "")) {
    return fail(res, 404, "not_found", "Salesに連携済みの提案を開いてください。");
  }
  const scope = builder => builder.eq("tenant_id", ctx.tenantId).eq("proposal_id", proposal.id);
  const showSalesProgress = sourceId && req.method === "GET";
  const needsSavedStage = showSalesProgress &&
    (proposal.status === "won" || (proposal.status === "considering" && proposal.close_reason !== "sales_hold"));
  const [source, current, progress] = await Promise.all([
    readEngerCoordinationSource(sb, proposal.source_proposal_id),
    scope(sb.from(TABLE).select(FIELDS)).maybeSingle(),
    needsSavedStage ? scope(sb.from("gw_sales_proposal_activities").select("detail"))
      .not("detail->salesProgress", "is", null)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle() : null,
  ]);
  if (current.error) throw current.error;
  if (!source) return fail(res, 404, "source_missing", "ENGER側の提案を確認してください。");
  const note = current.data;
  const canSave = roles.sales && (canManageProposals(ctx)
    || Boolean(ctx.employee?.id && proposal.sales_owner_id === ctx.employee.id));
  const canConfirm = roles.enger && Boolean(note) && note.sales_confirmed_by !== user.id;
  if (req.method === "GET") {
    return json(res, 200, {
      id: proposal.id, source, canSave, canConfirm, canOpenSales: roles.sales,
      salesStatus: STATUS_LABEL[proposal.status] || proposal.status, salesSentAt: proposal.sent_at,
      salesProgress: showSalesProgress && !progress?.error
        ? { stage: salesStage(proposal, progress?.data?.detail?.salesProgress), status: proposal.status } : undefined,
      record: note ? {
        decision: note.decision, nextStep: note.next_step, revision: note.revision,
        salesConfirmedAt: note.sales_confirmed_at, engerConfirmedAt: note.enger_confirmed_at,
        sourceChanged: note.source_revision !== source.revision,
      } : null,
    });
  }

  if (!Number.isSafeInteger(body.revision) || body.revision < 0) return fail(res, 400, "invalid_revision", "画面を読み直してください。");
  if (body.revision !== (note?.revision || 0) || body.sourceRevision !== source.revision) return conflict(res);
  const now = new Date().toISOString();
  let values;
  if (body.action === "save") {
    if (!canSave) return fail(res, 403, "sales_owner_only", "Salesの担当者または管理者が保存できます。");
    const decision = boundedText(body.decision, 1500);
    const next_step = boundedText(body.nextStep, 1000);
    if (!decision || !next_step) return fail(res, 400, "invalid_note", "確認したことと、次の対応・担当・期限を入力してください。");
    if (note?.decision === decision && note.next_step === next_step && note.source_revision === source.revision) {
      return json(res, 200, { revision: note.revision });
    }
    values = {
      decision, next_step, source_revision: source.revision, sales_confirmed_by: user.id, sales_confirmed_at: now,
      enger_confirmed_by: null, enger_confirmed_at: null,
    };
  } else if (body.action === "confirm") {
    if (!canConfirm) return fail(res, 403, "enger_only", "ENGERの担当者が自分のアカウントで確認してください。");
    if (note.source_revision !== source.revision) return conflict(res);
    if (note.enger_confirmed_at) return json(res, 200, { revision: note.revision });
    values = { enger_confirmed_at: now, enger_confirmed_by: user.id };
  } else {
    return fail(res, 400, "invalid_action", "画面から操作を選んでください。");
  }
  const query = note
    ? scope(sb.from(TABLE).update({ ...values, revision: note.revision + 1 })).eq("revision", note.revision)
    : sb.from(TABLE).insert({ tenant_id: ctx.tenantId, proposal_id: proposal.id, ...values });
  const written = await query.select("revision").maybeSingle();
  if (written.error?.code === "23505" || (!written.error && !written.data)) return conflict(res);
  if (written.error) throw written.error;
  return json(res, 200, { revision: written.data.revision });
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST"]);
  res.setHeader("Cache-Control", "no-store");
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const sb = admin();
    const ctx = await gwContext(user.id);
    const roles = await reviewAccess(sb, ctx, user);
    const body = req.method === "POST" ? await readJson(req) : {};
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(res, 400, "invalid_body", "画面を読み直してください。");
    return await runProposalCoordination(req, res, { sb, ctx, user, roles, body });
  } catch (error) {
    console.error("[enger-proposal-coordination]", error?.code || "request_failed");
    return fail(res, 503, "unavailable", "ENGERの情報か共有記録を読み込めません。最新表示してから再度お試しください。");
  }
}
