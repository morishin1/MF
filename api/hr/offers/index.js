// POST  /api/hr/offers { applicantId, respondBy, messageToCandidate, ... }
//         … 合格通知の下書きを作る（応募者の現在の採用条件をスナップショット）。
//           応募者の状態を「社内確認待ち」へ進める。status=offer_draft_pendingのときだけ
// PATCH /api/hr/offers { id, action }
//         "update"  … 社内確認待ちの間だけ、内容を直す（状態は動かさない）
//         "confirm" … 内容を確定し、応募者の状態を「本人送付待ち」へ進める
//                      （本人への実際の送付・専用URL発行はStage 6で行う）
//
// ■ 1 offer version = 1 token（README Stage 6 §5）
//   作成と同時にtokenを発行するが、ここではどこにも出さない・送らない。
//   NOT NULL制約（db/081）を満たすためのプレースホルダーで、実際に本人へ
//   使わせるtokenはStage 6の送付（再発行と同じ仕組み）で発行し直す

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { normalizeOffer, shapeOffer, sha256, newOfferToken } from "../../../lib/hr.js";

const SQL = "db/081_hr_recruiting.sql";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "POST") return create(req, res, sb, ctx, user);
  if (req.method === "PATCH") return act(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["POST", "PATCH"]);
}

async function create(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.applicantId) return json(res, 400, { error: "invalid_body", required: ["applicantId"] });

  const { data: applicant } = await sb.from("gw_hr_applicants").select("*")
    .eq("id", body.applicantId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant) return json(res, 404, { error: "not_found" });
  if (applicant.status !== "offer_draft_pending") {
    return json(res, 409, { error: "invalid_state", hint: "いまは合格通知を作成できる状態ではありません" });
  }

  const row = normalizeOffer(body, applicant);
  if (row.error) return json(res, 400, row);

  const { data: existing } = await sb.from("gw_hr_offers").select("version")
    .eq("applicant_id", applicant.id).order("version", { ascending: false }).limit(1);
  const version = (existing?.[0]?.version || 0) + 1;
  const token = newOfferToken();

  const { data, error } = await sb.from("gw_hr_offers")
    .insert({
      ...row.value, tenant_id: ctx.tenantId, applicant_id: applicant.id, version,
      token_hash: sha256(token), created_by: user.id,
    })
    .select("*").single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  const now = new Date().toISOString();
  await sb.from("gw_hr_applicants").update({ status: "offer_review_pending", updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_drafted",
    label: "合格通知を作成", detail: `第${version}版`, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_create",
    target: `hr_offer:${data.id}`, detail: { applicantId: applicant.id, version },
  });

  return json(res, 200, { offer: shapeOffer(data), status: "offer_review_pending" });
}

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const { data: offer } = await sb.from("gw_hr_offers").select("*")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!offer) return json(res, 404, { error: "not_found" });

  if (body.action === "update") return update(res, sb, ctx, user, offer, body);
  if (body.action === "confirm") return confirm(res, sb, ctx, user, offer);
  return json(res, 400, { error: "unknown_action" });
}

async function update(res, sb, ctx, user, offer, body) {
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, status")
    .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant || applicant.status !== "offer_review_pending") {
    return json(res, 409, { error: "invalid_state", hint: "社内確認待ちの間だけ、内容を直せます" });
  }

  const row = normalizeOffer(body, null, { partial: true });
  if (row.error) return json(res, 400, row);
  if (!Object.keys(row.value).length) return json(res, 400, { error: "invalid_body", detail: "更新する項目がありません" });

  const { data, error } = await sb.from("gw_hr_offers")
    .update(row.value).eq("id", offer.id).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  return json(res, 200, { offer: shapeOffer(data) });
}

async function confirm(res, sb, ctx, user, offer) {
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, name, status")
    .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant || applicant.status !== "offer_review_pending") {
    return json(res, 409, { error: "invalid_state", hint: "社内確認待ちの合格通知だけ確定できます" });
  }

  const now = new Date().toISOString();
  await sb.from("gw_hr_applicants").update({ status: "offer_send_pending", updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_confirmed",
    label: "合格通知の内容を確定", detail: `第${offer.version}版`, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_confirm",
    target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id },
  });

  return json(res, 200, { offer: shapeOffer(offer), status: "offer_send_pending" });
}
