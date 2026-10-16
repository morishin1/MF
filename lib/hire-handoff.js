// 採用HR から Office へ「引き渡された」人を読む（handoff_at が入った版）。
//
// ■ 引き渡しは「HR が承諾内容を確認して押した」結果であって、本人の承諾だけでは起きない
//   本人が条件を承諾する → HR が承諾内容・条件・入社予定日を確認する → 正式契約が必要なら LegalSign まで HR で終える
//   → HR が［承諾内容を確認してOfficeへ引き渡す］を押す（api/hr/offers の handoff。handoff_at / handoff_by を一度だけ書く）
//   → Office の「HRから引き渡し」に載る。承諾しただけの人は載らない。育成枠は引き渡さない（LMS・育成開始＝HR）。
//   handoff_at / handoff_by は「誰が・いつ引き渡したか」の監査記録（db/133。一度入ったら変えられない）。
//
// ■ ここで読むもの
//   引き渡した版（gw_hr_offers。select("*")＝列の有無に左右されない）と、その応募者の最小限の項目。
//   Office に出すのは「本人確認に必要な連絡先（メール・電話）・承諾した事実・入社予定日・HR で終えた正式契約の状態・引き渡した人と日時」。
//   給与・承諾の IP・LegalSign の URL は返さない（条件通知書PDF・承諾済みPDFは、権限のある人が
//   api/hr/offers の file で開く。給与が入るので canSeeSalary の人だけ）。
//
// ■ 書類は再登録させない・二重管理しない
//   履歴書・職務経歴書・スキルシート・内定通知書・労働条件通知書・承諾済みPDF は HR が登録した原本を、Office は閲覧だけする
//   （api/hr/documents.js・api/hr/offers の閲覧専用の口。引き渡した人の分だけ。Office から登録・差し替え・削除はできない）。
import { formalRequiredOf, offerTypeLabel } from "./hr-offer-types.js";

/**
 * 引き渡した版（handoff_at が入っていて、承諾済みで、無効化・辞退でないもの）を新しい引き渡し順に読む。
 * 列が読めない・表が無いときは ready=false。条件はすべて tenant_id で絞る（service role で読むため）。
 * @param {object} sb  service role（認可のあと）
 * @param {{applicantIds?: string[]|null}} [opt]
 * @returns {Promise<{ready: boolean, offers: object[]}>}
 */
export async function readHandoffOffers(sb, tenantId, { applicantIds = null } = {}) {
  if (!tenantId) return { ready: false, offers: [] };
  const out = [];
  const chunks = applicantIds ? [] : [null];
  if (applicantIds) for (let i = 0; i < applicantIds.length; i += 100) chunks.push(applicantIds.slice(i, i + 100));
  for (const ids of chunks) {
    let q = sb.from("gw_hr_offers").select("*").eq("tenant_id", tenantId).not("handoff_at", "is", null)
      .is("revoked_at", null).is("declined_at", null).order("handoff_at", { ascending: false }).limit(300);
    if (ids) q = q.in("applicant_id", ids);
    const { data, error } = await q;
    if (error) return { ready: false, offers: [] };
    // 念のため（偽のクライアントでも・データが想定外でも）：引き渡しの印が実際にある版だけ。
    // 育成枠・区分なしは、Office へ引き渡さない（DB の CHECK でも handoff_at は入らない）ので、入っていても出さない
    out.push(...(data || []).filter((o) => o.handoff_at && o.accepted_at && o.offer_type && o.offer_type !== "training"));
  }
  return { ready: true, offers: out };
}

/**
 * 引き渡した人（handoff_by＝ログインの ID）の名前。名簿に無ければ名前は出さない（null）。
 * @returns {Promise<Map<string, string>>} user_id → 表示名
 */
export async function handoffActorNames(sb, tenantId, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  try {
    const { data } = await sb.from("gw_employees").select("user_id, display_name").eq("tenant_id", tenantId).in("user_id", ids);
    for (const e of data || []) out.set(e.user_id, e.display_name);
  } catch { /* 名前が引けなくても引き渡しの事実は出す */ }
  return out;
}

/**
 * 引き渡した版と応募者から、Office が見る「HRから引き渡された情報」。給与・連絡先・承諾の記録（IP など）・LegalSign の URL は含めない。
 * @param {object} offer gw_hr_offers の行（引き渡し済み）
 * @param {object} applicant gw_hr_applicants の行（id・name・email・phone・job_title・employment_type を使う）
 * @param {{byName?: string|null}} [opt] 引き渡した人の名前（handoffActorNames から）
 */
export function handoffFactsOf(offer, applicant, { byName = null } = {}) {
  const required = formalRequiredOf(offer) !== false;
  return {
    applicantId: applicant.id, offerId: offer.id, version: offer.version ?? null,
    name: applicant.name,
    email: applicant.email || null,
    phone: applicant.phone || null,
    jobTitle: offer.job_title || applicant.job_title || null,
    employmentType: offer.employment_type || applicant.employment_type || null,
    offerType: offer.offer_type, offerTypeLabel: offerTypeLabel(offer.offer_type),
    joinDate: offer.join_date || null,
    acceptedAt: offer.accepted_at,
    // 条件通知書（労働条件通知書）は、本人が内容を確認して同意したから承諾できる。確認した日時は閲覧の初回、無ければ承諾の日時
    noticeConfirmedAt: offer.viewed_at || offer.accepted_at,
    noticeTitle: offer.notice_title || null,
    noticePdf: Boolean(offer.notice_pdf_path),
    acceptedPdf: Boolean(offer.accepted_pdf_path),
    // 正式契約（LegalSign）は HR で終えている（必要な版は署名済みでないと引き渡せない。API と DB が止める）
    formalRequired: required,
    formalSignedAt: offer.formal_signed_at || null,
    // 誰が・いつ引き渡したか（監査記録。db/133）
    handoffAt: offer.handoff_at,
    handoffByName: byName,
  };
}
