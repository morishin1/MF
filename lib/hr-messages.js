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

export const DECISION_MESSAGE_KINDS = ["hired", "hold", "rejected"];
export const DECISION_MESSAGE_LABEL = { hired: "内定のご連絡", hold: "選考状況のご連絡", rejected: "選考結果のご連絡" };

/** "2026-10-20" → "10月20日" */
const mmdd = (ymd) => {
  const m = String(ymd || "").match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${Number(m[1])}月${Number(m[2])}日` : null;
};

/**
 * @param {"hired"|"hold"|"rejected"} kind
 * @param {{name:string, tenantName?:string|null, senderName?:string|null, jobTitle?:string|null, dueOn?:string|null}} p
 * @returns {{subject:string, body:string}|null}
 */
export function decisionMessage(kind, p) {
  if (!DECISION_MESSAGE_KINDS.includes(kind)) return null;
  const company = p.tenantName || "弊社";
  const sign = [company, `採用担当${p.senderName ? `　${p.senderName}` : ""}`].join("\n");
  const job = p.jobTitle ? `（${p.jobTitle}）` : "";
  const head = `${p.name} 様\n\nこのたびは${company}の採用選考${job}にお時間をいただき、誠にありがとうございました。`;

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
