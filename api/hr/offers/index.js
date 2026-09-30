// POST  /api/hr/offers { applicantId, respondBy, messageToCandidate, ... }
//         … 合格通知の下書きを作る（応募者の現在の採用条件をスナップショット）。
//           応募者の状態を「社内確認待ち」へ進める。status=offer_draft_pendingのときだけ
// PATCH /api/hr/offers { id, action }
//         "update"     … 社内確認待ちの間だけ、内容を直す（状態は動かさない）
//         "confirm"    … 内容を確定し、応募者の状態を「本人送付待ち」へ進める
//         "issueLink"  … 本人専用URLのtokenを発行する（平文は一度だけ返す。Stage 6）
//         "markSent"   … 実際に本人へ送ったことを明示的に記録する（Stage 6 §12）
//
// ■ 1 offer version = 1 公開token（README Stage 6 §5・§20）
//   Stage 5作成時にNOT NULL制約対応のプレースホルダーtokenを発行しているが、
//   候補者には一切公開していない。issueLinkで初めて「本人へ渡してよいtoken」を
//   発行する：まだ一度も送っていない行（sent_atが空）ならその行のtokenを
//   差し替えるだけ、すでに送付済みの行なら新しい版を足して古い行を無効化する
//   （db/081のコメントどおり、送付済みの内容は上書きしない）。
//
// ■ メール送信基盤は無い（docs/labor-notice-delivery.md）
//   issueLinkはURLを発行するだけ。sent_atは「送付済みにする」をHRが明示的に
//   押した時点（markSent）でしか立てない（README Stage 6 §12）

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canRecruit, canSeeSalary } from "../../../lib/gw.js";
import { guardSalaryOutput, dropSalaryInput } from "../../../lib/salary.js";
import { paySplit, splitWage, attachPay, savePay, copyPayToOffer, payFailed, WAGE_COLUMNS } from "../../../lib/hr-pay.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import {
  normalizeOffer, shapeOffer, sha256, newOfferToken, offerExpiresAt,
} from "../../../lib/hr.js";

const SQL = "db/081_hr_recruiting.sql・086_hr_offer_public_link.sql";

// gw_hr_offers・gw_hr_applicants どちらも同じ列名を持つ、合格通知のスナップショット項目
// （lib/hr.jsのsnapshotOfferFieldsと同じ考え方。再発行で、そのまま次の版へ引き継ぐ）
const OFFER_SNAPSHOT_COLUMNS = [
  "job_title", "employment_type", "contract_type", "contract_end_date", "join_date",
  "probation_months", "wage_type", "wage_amount", "weekly_hours", "work_location",
  "message_to_candidate", "respond_by",
];

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canRecruit(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);
  // 給与は、見られる人（lib/gw.js canSeeSalary）にだけ返す・書かせる。
  // 採用担当・責任者は、給与が見えないまま合格通知を作れる（応募者の条件は、サーバ側でそのまま引き継ぐ）
  const salary = guardSalaryOutput(res, canSeeSalary(ctx));

  if (req.method === "POST") return create(req, res, sb, ctx, user, salary);
  if (req.method === "PATCH") return act(req, res, sb, ctx, user, salary);
  return methodNotAllowed(res, ["POST", "PATCH"]);
}

async function create(req, res, sb, ctx, user, salary) {
  const body = await readJson(req);
  if (!body?.applicantId) return json(res, 400, { error: "invalid_body", required: ["applicantId"] });

  const { data: applicant } = await sb.from("gw_hr_applicants").select("*")
    .eq("id", body.applicantId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant) return json(res, 404, { error: "not_found" });
  if (applicant.status !== "offer_draft_pending") {
    return json(res, 409, { error: "invalid_state", hint: "いまは合格通知を作成できる状態ではありません" });
  }
  // 給与が見えない人の操作でも、応募者の条件は、サーバの中でそのまま引き継ぐ（応答には載らない）
  await attachPay(ctx.tenantId, applicant, "applicant");

  // 給与を見られない人は、給与の欄を書き換えられない。応募者に入っている条件は、そのまま引き継ぐ
  const row = normalizeOffer(salary ? body : dropSalaryInput(body), applicant);
  if (row.error) return json(res, 400, row);

  const { data: existing } = await sb.from("gw_hr_offers").select("version")
    .eq("applicant_id", applicant.id).order("version", { ascending: false }).limit(1);
  const version = (existing?.[0]?.version || 0) + 1;
  const token = newOfferToken();

  // 給与は、分けている設定なら専用の表へ（元の行には入れない）
  const { base, wage } = splitWage(row.value);
  const { data, error } = await sb.from("gw_hr_offers")
    .insert({
      ...base, tenant_id: ctx.tenantId, applicant_id: applicant.id, version,
      token_hash: sha256(token), created_by: user.id,
    })
    .select("*").single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, error.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: error.message });
  }

  try {
    await savePay(ctx.tenantId, { applicantId: applicant.id, offerId: data.id, wage });
  } catch (e) {
    // 給与の無い合格通知の版を残さない
    return payFailed(res, e, () => sb.from("gw_hr_offers").delete().eq("id", data.id));
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

  return json(res, 200, { offer: await shape(ctx, data, salary), status: "offer_review_pending" });
}

async function act(req, res, sb, ctx, user, salary) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const { data: offer } = await sb.from("gw_hr_offers").select("*")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!offer) return json(res, 404, { error: "not_found" });

  if (body.action === "update") return update(res, sb, ctx, user, offer, salary ? body : dropSalaryInput(body), salary);
  if (body.action === "confirm") return confirm(res, sb, ctx, user, offer, salary);
  if (body.action === "issueLink") return issueLink(res, sb, ctx, user, offer, salary);
  if (body.action === "markSent") return markSent(res, sb, ctx, user, offer, salary);
  return json(res, 400, { error: "unknown_action" });
}

async function update(res, sb, ctx, user, offer, body, salary) {
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, status")
    .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant || applicant.status !== "offer_review_pending") {
    return json(res, 409, { error: "invalid_state", hint: "社内確認待ちの間だけ、内容を直せます" });
  }

  const row = normalizeOffer(body, null, { partial: true });
  if (row.error) return json(res, 400, row);
  if (!Object.keys(row.value).length) return json(res, 400, { error: "invalid_body", detail: "更新する項目がありません" });

  // 給与は、分けている設定なら専用の表へ。元の行に残る項目がなければ、行そのものは触らない
  const { base, wage } = splitWage(row.value);
  let data = offer;
  if (Object.keys(base).length) {
    const r = await sb.from("gw_hr_offers").update(base).eq("id", offer.id).select("*").single();
    if (r.error) return json(res, 500, { error: "db_update_failed", detail: r.error.message });
    data = r.data;
  }
  try {
    await savePay(ctx.tenantId, { applicantId: offer.applicant_id, offerId: offer.id, wage });
  } catch (e) {
    return payFailed(res, e);
  }

  return json(res, 200, { offer: await shape(ctx, data, salary) });
}

async function confirm(res, sb, ctx, user, offer, salary) {
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

  return json(res, 200, { offer: await shape(ctx, offer, salary), status: "offer_send_pending" });
}

// 応答用の形にする。給与を見られる人にだけ、給与（分けている設定では専用の表から）を足す
async function shape(ctx, offer, salary) {
  if (salary) await attachPay(ctx.tenantId, offer, "offer");
  return shapeOffer(offer);
}

const LINKABLE_STATUSES = [
  "offer_send_pending", "offer_sent", "offer_viewed", "offer_response_pending", "offer_resend_pending",
];

// 本人専用URLのtokenを発行する。平文は、ここでしか返さない
async function issueLink(res, sb, ctx, user, offer, salary) {
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, status")
    .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant || !LINKABLE_STATUSES.includes(applicant.status)) {
    return json(res, 409, { error: "invalid_state", hint: "いまはURLを発行できる状態ではありません" });
  }
  if (offer.revoked_at) return json(res, 409, { error: "invalid_state", hint: "この合格通知はすでに無効です" });

  const token = newOfferToken();
  const now = new Date().toISOString();

  // まだ一度も本人へ送っていなければ、その行のtokenを差し替えるだけでよい。
  // 送付済みの行を差し替えるときは、新しい版を足して古い行を無効化する
  // （db/081の設計どおり。送付済みの内容は上書きしない＝旧URLは必ず失効する）
  if (!offer.sent_at) {
    const { data, error } = await sb.from("gw_hr_offers")
      .update({ token_hash: sha256(token), expires_at: offerExpiresAt(offer.respond_by) })
      .eq("id", offer.id).select("*").single();
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

    await sb.from("gw_hr_timeline").insert({
      tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_link_issued",
      label: "候補者URLを発行", detail: `第${offer.version}版`, created_by: user.id,
    });
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_issue",
      target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id, version: offer.version },
    });
    return json(res, 200, { offer: await shape(ctx, data, salary), token });
  }

  const nextVersion = offer.version + 1;
  // 給与を分けている設定では、元の行には給与を入れない（新しい版へは、専用の表から引き継ぐ）
  const snapshot = Object.fromEntries(OFFER_SNAPSHOT_COLUMNS
    .filter((k) => !(paySplit() && WAGE_COLUMNS.includes(k))).map((k) => [k, offer[k]]));
  const { data: made, error } = await sb.from("gw_hr_offers")
    .insert({
      ...snapshot, tenant_id: ctx.tenantId, applicant_id: applicant.id, version: nextVersion,
      token_hash: sha256(token), expires_at: offerExpiresAt(offer.respond_by), created_by: user.id,
    })
    .select("*").single();
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  try {
    await copyPayToOffer(ctx.tenantId, { applicantId: applicant.id, fromOfferId: offer.id, toOfferId: made.id });
  } catch (e) {
    // 給与を引き継げなかった新しい版は残さない（前の版は、有効のまま）
    return payFailed(res, e, () => sb.from("gw_hr_offers").delete().eq("id", made.id));
  }
  await sb.from("gw_hr_offers").update({ revoked_at: now }).eq("id", offer.id);
  await sb.from("gw_hr_applicants").update({ status: "offer_resend_pending", updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_link_reissued",
    label: "URLを再発行", detail: `第${nextVersion}版（第${offer.version}版は失効）`, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_reissue",
    target: `hr_offer:${made.id}`, detail: { applicantId: applicant.id, revokedOfferId: offer.id, version: nextVersion },
  });

  return json(res, 200, { offer: await shape(ctx, made, salary), token, status: "offer_resend_pending" });
}

// 実際に本人へ送ったことを、HRが明示的に記録する（URLを発行しただけではsent_atにしない）
async function markSent(res, sb, ctx, user, offer, salary) {
  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, name, status")
    .eq("id", offer.applicant_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!applicant || !["offer_send_pending", "offer_resend_pending"].includes(applicant.status)) {
    return json(res, 409, { error: "invalid_state", hint: "いまは送付済みにできる状態ではありません" });
  }
  if (offer.revoked_at) return json(res, 409, { error: "invalid_state", hint: "この合格通知はすでに無効です" });

  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_hr_offers")
    .update({ sent_at: offer.sent_at || now }).eq("id", offer.id).select("*").single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  await sb.from("gw_hr_applicants").update({ status: "offer_sent", updated_at: now })
    .eq("id", applicant.id).eq("tenant_id", ctx.tenantId);
  await sb.from("gw_hr_timeline").insert({
    tenant_id: ctx.tenantId, applicant_id: applicant.id, event_key: "offer_sent",
    label: "本人へ送付", detail: `第${offer.version}版`, created_by: user.id,
  });
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "hr.offer_sent",
    target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id },
  });

  return json(res, 200, { offer: await shape(ctx, data, salary), status: "offer_sent" });
}
