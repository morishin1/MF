// HRの内定通知書（PDF方式）。応募者の確定済み採用判断からのみ生成する。
// 回答期限・同意記録は文書とは別に送信時点で確定するため、PDFに未確定日付を印字しない。
import { renderContractPdf } from "./pdf-jp.js";
import { date as jstDate } from "./jst.js";

const dateJa = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : null;
};

export function offerNoticeText(applicant, { company, issuerName, contactEmail } = {}) {
  const name = String(applicant?.name || "").trim();
  const tenantName = String(company || "").trim();
  if (!name || !tenantName) throw new Error("offer_notice_identity_required");
  // 有効な採用区分だけを文書に記載する。未設定・不明な区分を「正社員」と誤表示しない。
  const typeLabel = ({ executive_employee: "正社員", part_time: "パート・アルバイト" })[applicant?.offer_type];
  if (!typeLabel) throw new Error("offer_notice_type_required");
  const lines = [
    `${name} 様`,
    "",
    "このたびは、弊社の選考にお時間をいただき、誠にありがとうございました。",
    "選考の結果、下記のとおり内定とし、ご案内いたします。",
    "",
    "■ 内定内容",
    `採用区分：${typeLabel}`,
  ];
  if (applicant.job_title) lines.push(`職種：${applicant.job_title}`);
  const joinDate = dateJa(applicant.join_date);
  if (joinDate) lines.push(`入社予定日：${joinDate}`);
  lines.push(
    "",
    "■ 今後のお手続き",
    "本書は採用の決定をお知らせする通知書です。詳細な労働条件は、別途ご案内する労働条件通知書などでご確認ください。",
    "本書の発行のみをもって、労働条件への同意・雇用契約の締結が完了したものとは扱いません。",
    "内定の承諾または辞退は、ご案内メールに記載する本人専用URLからご回答ください。",
    "回答期限は、ご案内メールに記載します。",
    "",
    "■ 発行元・お問い合わせ",
    `会社名：${tenantName}`,
  );
  if (issuerName) lines.push(`担当者：${issuerName}`);
  if (contactEmail) lines.push(`メール：${contactEmail}`);
  lines.push("ご不明な点がございましたら、採用担当者までご連絡ください。");
  return lines.join("\n");
}

export async function generateOfferNoticePdf(applicant, { company, issuerName, contactEmail, flowId, version = 1 } = {}) {
  if (!flowId) throw new Error("offer_notice_flow_required");
  const body = offerNoticeText(applicant, { company, issuerName, contactEmail });
  const bytes = await renderContractPdf({
    title: "内定通知書", body, docId: flowId, company,
    issuedOn: jstDate(new Date()), employeeName: `${applicant.name} 様`, version,
  });
  return { bytes: Buffer.from(bytes), filename: `内定通知書_第${version}版.pdf` };
}
