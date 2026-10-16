// 採用条件書類（内定通知書・労働条件通知書・承諾済みPDF）の「いまどこまで進んだか」。純関数（DB・日時に触らない）。
//
// ■ なぜ別の表を持たないのか
//   この3つは、オファー（gw_hr_offers の1行＝1つの版）の列から分かる。
//     内定通知書（オファー）  … 行そのもの（作成 → 送付 sent_at → 本人が確認 viewed_at → 承諾 accepted_at）
//     労働条件通知書          … notice_pdf_path（送るときに作る条件通知書PDF。db/132）
//     承諾済みPDF             … 承諾したあとの、条件通知書＋電子承諾記録（accepted_at・accepted_pdf_path）
//   応募書類（履歴書など）の表 gw_hr_documents に同じものを写すと、ファイルも状態も二重管理になる。
//   「HRで登録 → Officeで引き継いで閲覧」（HR → Office 切替ルール §6）のために、ここは読むだけ。
//
// ■ 状態（書類ごとに表示する）
//   未登録 → 登録済み → 送付済み → 本人確認済み → 承諾済み（辞退・無効は別に出す）
//
// ■ 呼び方
//   内定通知書は、採用区分ごとの名前（正社員＝内定通知／パート＝採用通知／業務委託＝業務委託オファー …）に「書」を付けて言う。
//   労働条件通知書は、区分ごとの書類名（lib/hr-offer-types.js noticeTitle）。区分の無い従来の合格通知には、条件通知書は無い。
import { offerTypeOf } from "./hr-offer-types.js";

export const COND_STATE_LABEL = {
  none: "未登録", registered: "登録済み", sent: "送付済み", confirmed: "本人確認済み", accepted: "承諾済み",
  declined: "辞退", revoked: "無効",
};
/** 進み具合の並び（辞退・無効は含めない） */
export const COND_STATE_FLOW = ["none", "registered", "sent", "confirmed", "accepted"];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

/** 内定通知書の名前（「内定通知」→「内定通知書」。「業務委託オファー」などは、そのまま） */
export function offerDocLabel(offerType) {
  const name = offerTypeOf(offerType)?.offerName;
  if (!name) return "合格通知";            // 区分の無い従来の合格通知は、これまでの言い方のまま
  return /通知$/.test(name) ? `${name}書` : name;
}

/**
 * 対象にする版。承諾した版（無効化していない）→ いま有効な最新の版 → 最新の版（無効化・辞退したものだけが残っているとき）。無ければ null
 * @param {object[]} offers gw_hr_offers の行（新しい順でなくてもよい）
 */
export function conditionOfferOf(offers) {
  const list = [...(offers || [])].sort((a, b) => (b.version || 0) - (a.version || 0));
  return list.find((o) => o.accepted_at && !o.revoked_at)
    || list.find((o) => !o.revoked_at && !o.declined_at)
    || list[0] || null;
}

/** 版の進み具合（辞退・無効を含む）。作っただけ＝registered */
export function offerProgressOf(o) {
  if (!o) return "none";
  if (o.accepted_at) return "accepted";
  if (o.declined_at) return "declined";
  if (o.revoked_at) return "revoked";
  if (o.viewed_at) return "confirmed";
  if (o.sent_at) return "sent";
  return "registered";
}

const stateRow = (key, label, state, at, extra = {}) => ({
  key, label, state, stateLabel: COND_STATE_LABEL[state], at: at || null, file: null, note: null, applicable: true, ...extra,
});

/**
 * 応募者の採用条件書類（3行）。
 * @param {object[]} offers 応募者の gw_hr_offers の行（select("*")）
 * @returns {{ offerId: string|null, version: number|null, offerType: string|null, docsReady: boolean, progress: string,
 *             rows: {key:"offer"|"notice"|"accepted", label:string, state:string, stateLabel:string, at:string|null,
 *                    file:"offer"|"notice"|"accepted"|null, note:string|null, applicable:boolean}[] }}
 */
export function conditionDocsOf(offers) {
  const o = conditionOfferOf(offers);
  if (!o) {
    return {
      offerId: null, version: null, offerType: null, offerPdfReady: false, docsReady: false, progress: "none",
      rows: [
        stateRow("offer", "内定通知書", "none", null, { note: "合格が決まったら、ここから作ります" }),
        stateRow("notice", "労働条件通知書", "none", null),
        stateRow("accepted", "承諾済みPDF", "none", null),
      ],
    };
  }
  const progress = offerProgressOf(o);
  const typed = Boolean(offerTypeOf(o.offer_type));
  const docsReady = has(o, "notice_pdf_path");
  const at = { registered: o.created_at, sent: o.sent_at, confirmed: o.viewed_at, accepted: o.accepted_at, declined: o.declined_at, revoked: o.revoked_at };

  // オファー通知書（内定通知書・採用通知書等）。db/137 で条件通知書とは別PDFにする。
  const offerPdfReady = has(o, "offer_pdf_path");
  let offerRow;
  if (!typed) {
    offerRow = stateRow("offer", offerDocLabel(o.offer_type), progress, at[progress]);
  } else if (!offerPdfReady) {
    offerRow = stateRow("offer", offerDocLabel(o.offer_type), progress, at[progress], { note: "db/137 を流すと、通知PDFを条件通知書と分けて保管できます" });
  } else if (!o.offer_pdf_path) {
    offerRow = stateRow("offer", offerDocLabel(o.offer_type), "none", null, { note: "送るときに作ります" });
  } else {
    const st = progress === "registered" ? "registered" : progress;
    offerRow = stateRow("offer", o.offer_title || offerDocLabel(o.offer_type), st, at[st] || o.created_at, { file: "offer" });
  }

  // 労働条件通知書（条件通知書PDF）。区分の無い従来の合格通知には無い。送るときに作る
  const noticeTitle = o.notice_title || offerTypeOf(o.offer_type)?.noticeTitle || null;
  let noticeRow;
  if (!typed) {
    noticeRow = stateRow("notice", "労働条件通知書", "none", null, { applicable: false });
  } else if (!docsReady) {
    noticeRow = stateRow("notice", noticeTitle || "労働条件通知書", "none", null, { note: "db/132 を流すと、PDF を保管できます" });
  } else if (!o.notice_pdf_path) {
    noticeRow = stateRow("notice", noticeTitle || "労働条件通知書", "none", null, { note: "送るときに作ります" });
  } else {
    // PDF がある＝作った。そのあとは版の進み具合（送付・確認・承諾）に合わせる
    const st = progress === "registered" ? "registered" : progress;
    noticeRow = stateRow("notice", noticeTitle || "労働条件通知書", st, at[st] || o.created_at, { file: "notice" });
  }

  // 承諾済みPDF（条件通知書＋電子承諾記録）。承諾したあと、PDF の元（条件通知書PDF）があるときだけ
  let acceptedRow;
  if (!typed) {
    acceptedRow = stateRow("accepted", "承諾済みPDF", "none", null, { applicable: false });
  } else if (o.accepted_at && o.notice_pdf_path) {
    acceptedRow = stateRow("accepted", "承諾済みPDF", "accepted", o.accepted_at, { file: "accepted" });
  } else if (o.accepted_at) {
    acceptedRow = stateRow("accepted", "承諾済みPDF", "none", null, { note: "条件通知書PDFが無いため作れません" });
  } else {
    acceptedRow = stateRow("accepted", "承諾済みPDF", "none", null, { note: "本人が承諾すると作ります" });
  }

  return {
    offerId: o.id, version: o.version ?? null, offerType: o.offer_type ?? null, offerPdfReady, docsReady, progress,
    rows: [offerRow, noticeRow, acceptedRow],
  };
}
