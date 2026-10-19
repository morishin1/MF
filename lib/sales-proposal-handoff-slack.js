// /sales の提案送信・CS→クロージング引継ぎを Slack に共有する。
// Slack が落ちても DB の提案・引継ぎは取り消さない。送信済み印で重複を抑える。
// 自由入力の理由や顧客連絡先は Slack に出さない（Sales内の履歴で確認）。
import { notifySlack } from "./slack.js";
import { salesSlackWebhook } from "./sales-proposal-slack.js";
import { SLACK_MEMBER_RE, settingsOf } from "./sales-proposals.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const label = (id, members, employees) => {
  const slackId = members?.[id];
  if (slackId && SLACK_MEMBER_RE.test(slackId)) return '<@' + slackId + '>';
  const name = employees?.find((e) => e.id === id)?.display_name;
  return name ? esc(name) : "未設定の社員";
};
const listTeam = (ids, slackMembers, employees) =>
  ids?.length ? ids.map((id) => label(id, slackMembers, employees)).join("・") : "担当者未設定（フォローの設定で登録）";

export function sentShareMessage({ proposal, settingsRow, employees = [] }) {
  const s = settingsOf(settingsRow);
  return {
    text: ":outbox_tray: 企業へ提案済み｜CSフォロー開始",
    lines: [
      esc(proposal.company_name) + "　" + esc(proposal.title),
      "提案担当：" + esc(proposal.matching_owner_name || "未設定"),
      "CS担当候補：" + listTeam(s.csMembers, s.slackMembers, employees),
      "クロージング共有：" + listTeam(s.closingMembers, s.slackMembers, employees),
      "CSは連絡がつくまで追いかけ、相手の意向を記録してください。",
      "詳細条件や専門的な商談は、理由・判断・次の行動を残してクロージングへ引き継いでください。",
    ],
    link: "sales/proposals.html?id=" + proposal.id,
  };
}

/** 企業提案の「初回送信」でSlackへ共有する。既存のマッチング通知とは別に1回。 */
export async function notifySentShared(sb, { proposalId, settingsRow, employees = [] }) {
  if (!salesSlackWebhook()) return { sent: false, skipped: "not_configured" };
  const { data: p, error: e0 } = await sb.from("gw_sales_proposals").select("*").eq("id", proposalId).maybeSingle();
  if (e0 || !p) return { sent: false, error: e0?.code || "missing_proposal" };
  if (!p.sent_at) return { sent: false, skipped: "not_sent" };
  const stamp = new Date().toISOString();
  const { data: claimed, error: e1 } = await sb.from("gw_sales_proposals").update({ sent_shared_at: stamp })
    .eq("id", proposalId).is("sent_shared_at", null).select("id").maybeSingle();
  if (e1) return { sent: false, error: e1.code || "claim_failed" };
  if (!claimed) return { sent: false, skipped: "already_sent" };
  const res = await notifySlack({ ...sentShareMessage({ proposal: p, settingsRow, employees }), webhook: salesSlackWebhook() });
  if (!res.sent) {
    await sb.from("gw_sales_proposals").update({ sent_shared_at: null }).eq("id", proposalId).eq("sent_shared_at", stamp);
    return { sent: false, error: res.error || "slack_failed" };
  }
  return { sent: true };
}

export function handoffShareMessage({ proposal, handoff, employees = [], settingsRow }) {
  const s = settingsOf(settingsRow);
  const owner = label(handoff.to_owner_id, s.slackMembers, employees);
  const from = handoff.from_stage === "proposal" ? "提案担当" : "CS";
  const to = handoff.to_stage === "cs" ? "CS" : "クロージング";
  const decisionLabels = { advance: "進行", needs_detail: "詳細確認・条件調整", hold: "保留", other: "その他" };
  return {
    text: ":left_right_arrow: バトンタッチ｜" + from + " → " + to + "　" + owner,
    lines: [
      esc(proposal.company_name) + "　" + esc(proposal.title),
      "担当：" + label(handoff.from_owner_id, s.slackMembers, employees) + " → " + owner,
      "判断：" + (decisionLabels[handoff.decision] || "その他"),
      "引継ぎ理由と次の行動はSalesの履歴に記録されています。担当者は期限と詳細を確認してください。",
      "CS共有：" + listTeam(s.csMembers, s.slackMembers, employees),
      "クロージング共有：" + listTeam(s.closingMembers, s.slackMembers, employees),
    ],
    link: "sales/proposals.html?id=" + proposal.id,
  };
}

/** バトンタッチ1件につき1回通知。失敗時は印を戻し、管理者が再共有できる。 */
export async function notifyHandoffShared(sb, { handoffId, tenantId, settingsRow, employees = [] }) {
  if (!salesSlackWebhook()) return { sent: false, skipped: "not_configured" };
  const { data: handoff, error: e0 } = await sb.from("gw_sales_proposal_handoffs")
    .select("*").eq("id", handoffId).eq("tenant_id", tenantId).maybeSingle();
  if (e0 || !handoff) return { sent: false, error: e0?.code || "missing_handoff" };
  const { data: proposal, error: e1 } = await sb.from("gw_sales_proposals")
    .select("*").eq("id", handoff.proposal_id).eq("tenant_id", tenantId).maybeSingle();
  if (e1 || !proposal) return { sent: false, error: e1?.code || "missing_proposal" };
  const stamp = new Date().toISOString();
  const { data: claim, error: e2 } = await sb.from("gw_sales_proposal_handoffs")
    .update({ slack_sent_at: stamp }).eq("id", handoffId).is("slack_sent_at", null).select("id").maybeSingle();
  if (e2) return { sent: false, error: e2.code || "claim_failed" };
  if (!claim) return { sent: false, skipped: "already_sent" };
  const sent = await notifySlack({ ...handoffShareMessage({ proposal, handoff, employees, settingsRow }), webhook: salesSlackWebhook() });
  if (!sent.sent) {
    await sb.from("gw_sales_proposal_handoffs").update({ slack_sent_at: null }).eq("id", handoffId).eq("slack_sent_at", stamp);
    return { sent: false, error: sent.error || "slack_failed" };
  }
  return { sent: true };
}
