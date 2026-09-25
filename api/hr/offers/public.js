// GET /api/hr/offers/public?token=…
//   … 候補者本人が、確定した合格通知（そのtokenに紐づくoffer versionだけ）を見る。
//     ログイン不要。gwContext() は使わない（README Stage 6 §16）
//
// ■ 本人には、送った時点のスナップショットだけを返す
//   gw_hr_applicants の最新値ではなく gw_hr_offers を見る。ランク・5項目評価・
//   社内メモ・推薦理由・CEO REVIEWコメント・employee_id・tenant内部IDは
//   絶対に含めない（README Stage 6 §17・§21）。理由を問わず「開けません」で
//   統一する（billing-submission/publicと同じ考え方。在職/期限切れ/無効化を
//   外の人に区別させない）
//
// ■ 初回閲覧の記録
//   viewed_atが空なら、この時点でviewed_atを立てる。sent_atが（HRの押し忘れで）
//   まだ空でも、実際に開けた＝届いた証拠なのでここで一緒に埋める

import { json, dbSetupHint } from "../../../lib/http.js";
import { admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { sha256, TOKEN_RE, shapePublicOffer } from "../../../lib/hr.js";

const SQL = "db/081_hr_recruiting.sql";
const CANT_OPEN = { error: "invalid_token", hint: "このURLは開けません。採用担当までお問い合わせください。" };
const EXPIRED = { error: "expired", hint: "このご案内の回答期限を過ぎています。恐れ入りますが、採用担当までお問い合わせください。" };

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });

  const token = new URL(req.url, "http://localhost").searchParams.get("token") || "";
  if (!TOKEN_RE.test(token)) return json(res, 404, CANT_OPEN);

  const sb = admin();
  const { data: offer, error } = await sb.from("gw_hr_offers").select("*")
    .eq("token_hash", sha256(token)).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed" });
  }
  if (!offer || offer.revoked_at) return json(res, 404, CANT_OPEN);
  if (new Date(offer.expires_at).getTime() < Date.now()) return json(res, 410, EXPIRED);

  const { data: applicant } = await sb.from("gw_hr_applicants").select("id, tenant_id, name")
    .eq("id", offer.applicant_id).maybeSingle();
  if (!applicant) return json(res, 404, CANT_OPEN);

  const { data: tenant } = await sb.from("tenants").select("name").eq("id", applicant.tenant_id).maybeSingle();

  if (!offer.viewed_at) {
    const now = new Date().toISOString();
    await sb.from("gw_hr_offers").update({ viewed_at: now, sent_at: offer.sent_at || now }).eq("id", offer.id);
    await sb.from("gw_hr_applicants").update({ status: "offer_viewed", updated_at: now })
      .eq("id", applicant.id).eq("tenant_id", applicant.tenant_id);
    await sb.from("gw_hr_timeline").insert({
      tenant_id: applicant.tenant_id, applicant_id: applicant.id, event_key: "offer_viewed",
      label: "本人が合格通知を確認", detail: `第${offer.version}版`, created_by: null,
    });
    await gwLog({
      tenantId: applicant.tenant_id, actorId: null, action: "hr.offer_viewed",
      target: `hr_offer:${offer.id}`, detail: { applicantId: applicant.id },
    });
  }

  return json(res, 200, shapePublicOffer(offer, applicant, tenant));
}
