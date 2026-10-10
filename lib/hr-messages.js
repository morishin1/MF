// 採用判断のあと、本人へ伝える文面（内定・保留・見送り）。api/hr/applicants/message.js から使う。
//
// ■ 文面はここ1か所（画面に持たない）
//   採用HRの詳細と CEO REVIEW の両方から、同じ文面を使う。画面では送る前に直せる。
//
// ■ 内定の連絡は「結果のお知らせ」まで
//   雇用条件は書かない（条件は合格通知〔gw_hr_offers〕の本人専用URLで渡す。README Stage 6）。
//   ここで条件を書くと、合格通知の版管理の外で条件を伝えてしまう。
//
// ■ 見送りの理由は書かない
//   社内の評価・ランク・所感は本人に見せない（README Stage 6 §17 と同じ考え方）。

import { offerTypeOf } from "./hr-offer-types.js";

export const DECISION_MESSAGE_KINDS = ["hired", "hold", "rejected"];
export const DECISION_MESSAGE_LABEL = { hired: "内定のご連絡", hold: "選考状況のご連絡", rejected: "選考結果のご連絡" };

/** "2026-10-20" → "10月20日" */
const mmdd = (ymd) => {
  const m = String(ymd || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[1])}月${Number(m[2])}日` : null;
};

/**
 * @param {"hired"|"hold"|"rejected"} kind
 * @param {{name:string, tenantName?:string|null, senderName?:string|null, jobTitle?:string|null, dueOn?:string|null,
 *   offerType?:string|null}} p  offerType … 合格後の採用区分。あれば本人への言い方をその区分にする（内定通知・業務委託オファー…）
 * @returns {{subject:string, body:string}|null}
 */
export function decisionMessage(kind, p) {
  if (!DECISION_MESSAGE_KINDS.includes(kind)) return null;
  const company = p.tenantName || "弊社";
  const sign = [company, `採用担当${p.senderName ? `　${p.senderName}` : ""}`].join("\n");
  const job = p.jobTitle ? `（${p.jobTitle}）` : "";
  const head = `${p.name} 様\n\nこのたびは${company}の採用選考${job}にお時間をいただき、誠にありがとうございました。`;

  // 採用区分つき（正社員・育成・業務委託・パート・スポット）：「内定」「合格通知」とは言わず、区分の言い方で伝える
  const t = kind === "hired" ? offerTypeOf(p.offerType) : null;
  if (t) {
    return {
      subject: `【${company}】選考結果のご連絡（${t.offerName}のご案内）`,
      body: `${head}

慎重に検討いたしました結果、ぜひ${p.name}様と一緒にお仕事をさせていただきたく、
${t.hiredPhrase}

${t.hiredDetail}は、追って「${t.offerName}」として別途お送りいたします。
内容をご確認のうえ、ご回答いただけますと幸いです。

ご不明点がございましたら、このメールにご返信ください。
今後ともどうぞよろしくお願いいたします。

${sign}`,
    };
  }
  if (kind === "hired") {
    return {
      subject: `【${company}】選考結果のご連絡（内定）`,
      body: `${head}

慎重に検討いたしました結果、ぜひ${p.name}様と一緒に働きたいと考え、
内定とさせていただくことになりました。

雇用条件などの詳細は、追って「合格通知」として別途お送りいたします。
内容をご確認のうえ、ご回答いただけますと幸いです。

ご不明点がございましたら、このメールにご返信ください。
今後ともどうぞよろしくお願いいたします。

${sign}`,
    };
  }
  if (kind === "hold") {
    const due = mmdd(p.dueOn);
    return {
      subject: `【${company}】選考状況のご連絡`,
      body: `${head}

現在、社内で最終的な検討を進めております。
${due ? `${due}までに` : "あらためて"}選考結果をご連絡いたしますので、今しばらくお待ちいただけますと幸いです。

ご不明点がございましたら、このメールにご返信ください。

${sign}`,
    };
  }
  return {
    subject: `【${company}】選考結果のご連絡`,
    body: `${head}

慎重に検討を重ねました結果、誠に残念ではございますが、
今回はご期待に沿えない結果となりました。

ご応募いただきましたことに、あらためて心より御礼申し上げます。
${p.name}様の今後のご活躍をお祈りしております。

${sign}`,
  };
}

// ---- 本人への連絡状況（未連絡／連絡済み） ---------------------------------------------
//
// ■ DB の列は増やさない。選考タイムライン（gw_hr_timeline）から決める
//   判断：decision_hired / decision_hold / decision_rejected（api/hr/applicants/detail.js が残す）
//   連絡：message_hired / message_hold / message_rejected（api/hr/applicants/message.js が残す）
//   内定は、合格通知を本人へ送った（offer_sent）ことも連絡として数える（条件の連絡そのもののため）。
//
// ■ 「いまの判断」より後の連絡だけを数える
//   保留 → 連絡 → 内定 と判断が変わったら、保留の連絡では内定を伝えたことにならない（未連絡に戻る）。
//   判断の記録がタイムラインに無い（古いデータ）ときは、同じ種類の連絡があれば連絡済みとする。

/** 連絡状況を決めるのに読むタイムラインの event_key（一覧の問い合わせはこれだけを引く） */
export const CONTACT_EVENT_KEYS = [
  ...DECISION_MESSAGE_KINDS.map((k) => `decision_${k}`),
  ...DECISION_MESSAGE_KINDS.map((k) => `message_${k}`),
  "offer_sent",
];

/**
 * @param {string|null} decision いまの判断（gw_hr_applicants.decision）
 * @param {{event_key?:string, eventKey?:string, occurred_at?:string, occurredAt?:string}[]} events その応募者のタイムライン
 * @returns {{state:"none"|"pending"|"done", decision:string|null, at:string|null, via:string|null}}
 *   none＝まだ判断していない（出さない）／pending＝判断済み・本人へ未連絡／done＝連絡済み
 */
export function contactStatusOf(decision, events) {
  if (!DECISION_MESSAGE_KINDS.includes(decision)) return { state: "none", decision: null, at: null, via: null };
  const list = (events || []).map((e) => ({ key: e.event_key ?? e.eventKey, at: e.occurred_at ?? e.occurredAt ?? "" }));
  const decidedAt = list.filter((e) => e.key === `decision_${decision}`).map((e) => e.at).sort().pop() || "";
  const contacted = list
    .filter((e) => (e.key === `message_${decision}` || (decision === "hired" && e.key === "offer_sent")) && e.at >= decidedAt)
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  return contacted
    ? { state: "done", decision, at: contacted.at || null, via: contacted.key === "offer_sent" ? "offer" : "message" }
    : { state: "pending", decision, at: null, via: null };
}
