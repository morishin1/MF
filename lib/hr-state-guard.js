// 採用HR：大事な状態を飛び越えさせない・契約の履歴を消させない（機能フラグに関係なく、いつも効く）
//
//   ・社長の合格（decision = hired）……社長・管理者（canDecideHire）だけ。応募者の状態に関係なく
//   ・本人の条件承諾（accepted）……本人の承諾（api/hr/offers/public.js）でだけ。手動・一括では付けない
//   ・社員登録の完了（done・employee_id）……社員登録（api/hr/applicants/advance.js）でだけ
//   ・Office への早期引き渡し（db/143）……引き渡したら HR からは状態を変えない
//   ・合格通知の段階（offer_*）……社長の合格のあとでだけ（一括では入れない）
//   ・契約の履歴（オファーの版・handoff_at・社労士への依頼・正式PDF・社長判断・ヒアリング・早期引き渡し）がある応募者は削除しない
//
// DB 側でも db/143 の gw_hr_applicants_guard が、画面から直接（authenticated）の書き込みを同じ考え方で止める。
import { isMissingTable } from "./hr-office-intake.js";

export const OFFER_FLOW_STATUSES = [
  "offer_draft_pending", "offer_review_pending", "offer_send_pending", "offer_sent", "offer_viewed",
  "offer_resend_pending", "offer_response_pending",
];
const PROTECTED_TARGETS = ["accepted", "done"];
// 社長合格の人を一括で動かせる先（選考を終える方向だけ）
const HIRED_BULK_TARGETS = ["declined", "position_closed"];

/**
 * 状態（status）を変えてよいか。だめなら { status, error, hint } を返す（null なら変えてよい）。
 * @param {object} p
 * @param {{status:string, decision?:string|null, employee_id?:string|null}} p.before いまの行
 * @param {string} p.to 変更先の status
 * @param {string|null} [p.decision] 同じ操作で書く decision（無ければ before のまま）
 * @param {boolean} p.canDecide canDecideHire(ctx)
 * @param {boolean} [p.movedToOffice] Office へ引き渡し済み（db/143）
 * @param {boolean} [p.bulk] 一括操作（api/hr/applicants/bulk.js）
 */
export function statusChangeBlock({ before, to, decision, canDecide, movedToOffice = false, bulk = false }) {
  const b = before || {};
  if (to === b.status) return null;
  if (PROTECTED_TARGETS.includes(to)) {
    return { status: 409, error: "protected_state",
      hint: to === "accepted"
        ? "「承諾済み」は本人の承諾でだけ記録します（手動・一括では変えられません）"
        : "「完了」は社員登録の手続きでだけ記録します（手動・一括では変えられません）" };
  }
  if (b.status === "done" || b.employee_id) {
    return { status: 409, error: "protected_state", hint: "社員登録が済んだ応募者の状態は変えられません" };
  }
  if (movedToOffice) {
    return { status: 409, error: "moved_to_office", hint: "Office へ引き渡し済みです。このあとの状態は Office の手続きで変わります" };
  }
  if ((b.status === "ceo_decision_pending" || to === "ceo_decision_pending") && !canDecide) {
    return { status: 403, error: "forbidden", hint: "社長判断待ちの状態を変えられるのは社長・管理者だけです" };
  }
  if (bulk) {
    if (b.status === "accepted") {
      return { status: 409, error: "protected_state", hint: "条件承諾済みの応募者は一括では変えられません（1人ずつ確認してください）" };
    }
    if (OFFER_FLOW_STATUSES.includes(to)) {
      return { status: 409, error: "protected_state", hint: "合格通知の段階へは一括では変えられません（社長の合格判断から進めます）" };
    }
    if (b.decision === "hired" && !HIRED_BULK_TARGETS.includes(to)) {
      return { status: 409, error: "protected_state", hint: "社長合格の応募者は、一括では「辞退」「募集終了」にだけ変えられます" };
    }
    return null;
  }
  const effDecision = decision === undefined ? b.decision : decision;
  if (OFFER_FLOW_STATUSES.includes(to) && !OFFER_FLOW_STATUSES.includes(b.status) && b.status !== "accepted" && effDecision !== "hired") {
    return { status: 409, error: "needs_ceo_pass", hint: "合格通知の段階へは、社長の合格判断のあとでだけ進めます" };
  }
  return null;
}

/**
 * 応募者を削除すると消えてしまう契約の履歴（applicant_id → 理由の一覧）。service role で読む（RLS で隠れて見落とさない）。
 * 表が無い環境（db/139・143 未適用）は、その表を飛ばす。それ以外の失敗は投げる（分からないときは消させない）
 */
export async function contractHistoryOf(ab, tenantId, ids) {
  const out = new Map();
  const add = (id, reason) => {
    const list = out.get(id) || [];
    if (!list.includes(reason)) list.push(reason);
    out.set(id, list);
  };
  const uniq = [...new Set(ids)];
  if (!uniq.length) return out;
  const reads = [
    ["gw_hr_offers", "applicant_id, handoff_at", (r) => { add(r.applicant_id, "オファー・条件の版"); if (r.handoff_at) add(r.applicant_id, "Office への引き渡し"); }],
    ["gw_hr_attorney_requests", "applicant_id", (r) => add(r.applicant_id, "社労士への依頼")],
    ["gw_hr_offer_official_docs", "applicant_id", (r) => add(r.applicant_id, "正式PDF")],
    ["gw_hr_ceo_decisions", "applicant_id", (r) => add(r.applicant_id, "社長判断の記録")],
    ["gw_hr_hearings", "applicant_id", (r) => add(r.applicant_id, "条件ヒアリング")],
    ["gw_hr_office_intakes", "applicant_id", (r) => add(r.applicant_id, "Office への早期引き渡し")],
  ];
  for (const [table, cols, fn] of reads) {
    for (let i = 0; i < uniq.length; i += 100) {
      const { data, error } = await ab.from(table).select(cols).eq("tenant_id", tenantId).in("applicant_id", uniq.slice(i, i + 100));
      if (error) {
        if (isMissingTable(error)) break;
        throw error;
      }
      for (const r of data || []) fn(r);
    }
  }
  return out;
}

/** 削除を断る応答の本文（だれの・何の履歴があるか） */
export function historyBlockedBody(rows, history) {
  const blocked = rows.filter((r) => history.has(r.id)).map((r) => ({ id: r.id, name: r.name, reasons: history.get(r.id) }));
  return {
    error: "has_contract_history", blocked,
    hint: `契約の履歴がある応募者は削除できません（${blocked.map((b) => `${b.name}：${b.reasons.join("・")}`).join("／")}）。`
      + "選考を終えるときは、状態を「辞退」「見送り」「募集終了」にしてください（履歴は残ります）",
  };
}
