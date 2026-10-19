// 採用HR：契約手続き（db/139）の状態を、応募者の一覧・詳細でまとめて読む。読むだけ（書かない）。
// 表・列が無い環境（db/139 未適用）では、何も載せない（これまでどおりの言い方）。

import { activeOffer } from "./hr.js";
import { usesOfficial, contractStateOf, OFFICIAL_TYPES } from "./hr-contract.js";

// 契約手続きの言い方になりうる応募者の状態（内定のあと）
const STATUSES = ["offer_review_pending", "offer_send_pending", "offer_resend_pending", "offer_sent", "offer_viewed",
  "offer_response_pending", "accepted"];

/** 1つの版の受領記録・依頼の記録（表が無ければ null） */
export async function readContractTrail(sb, tenantId, offerIds) {
  if (!offerIds.length) return { docs: [], requests: [] };
  const [d, r] = await Promise.all([
    sb.from("gw_hr_offer_official_docs").select("id, offer_id, status, file_sha256, reviewed_at, revision")
      .eq("tenant_id", tenantId).in("offer_id", offerIds),
    sb.from("gw_hr_attorney_requests").select("id, offer_id, requested_at").eq("tenant_id", tenantId).in("offer_id", offerIds),
  ]);
  if (d.error || r.error) return null;
  return { docs: d.data || [], requests: r.data || [] };
}

/**
 * 応募者ごとの契約手続きの状態（applicant_id → state）。正式PDFの流れの人だけ入る。
 * @param {object[]} applicants gw_hr_applicants の行（status・offer_type）
 * @param {object[]|null} [offersIn] すでに読んだ gw_hr_offers の行（select("*")）。無ければここで読む
 */
export async function readContractStates(sb, tenantId, applicants, offersIn = null) {
  const out = new Map();
  const ids = (applicants || []).filter((a) => STATUSES.includes(a.status) && OFFICIAL_TYPES.includes(a.offer_type)).map((a) => a.id);
  if (!ids.length) return out;
  let offers = offersIn;
  if (!offers) {
    offers = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data, error } = await sb.from("gw_hr_offers").select("*").eq("tenant_id", tenantId).in("applicant_id", ids.slice(i, i + 100));
      if (error) return out;
      offers.push(...(data || []));
    }
  }
  const byApplicant = new Map();
  for (const o of offers) {
    if (!ids.includes(o.applicant_id)) continue;
    const list = byApplicant.get(o.applicant_id) || [];
    list.push(o);
    byApplicant.set(o.applicant_id, list);
  }
  const current = new Map();
  for (const [aid, list] of byApplicant) {
    const o = activeOffer(list);
    if (o && usesOfficial(o)) current.set(aid, o);
  }
  if (!current.size) return out;
  const trail = await readContractTrail(sb, tenantId, [...current.values()].map((o) => o.id));
  if (!trail) return out;
  const status = new Map((applicants || []).map((a) => [a.id, a.status]));
  for (const [aid, o] of current) {
    out.set(aid, contractStateOf({
      offer: o, status: status.get(aid),
      docs: trail.docs.filter((d) => d.offer_id === o.id), requests: trail.requests.filter((r) => r.offer_id === o.id),
    }));
  }
  return out;
}
