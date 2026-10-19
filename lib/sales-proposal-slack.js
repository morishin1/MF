// /sales 提案管理：起票を Slack で営業担当に即時に知らせる（db/140・docs/sales-proposals.md）。
//
// ■ いつ
//   dx.enger からの連携で提案を起票したとき（マッチング確定＝提案待ち、または提案送信が先に届いた＝電話待ち）。
//   提案ごとに1回だけ。gw_sales_proposals.slack_notified_at を「空のときだけ入れる」更新で先に取った1件だけが送る
//   （同じイベントの再送・同時に届いた2件・送り直しで、Slack に2回流さない）。送れなかったら印を戻す。
//
// ■ どこへ
//   SALES_SLACK_WEBHOOK_URL（営業のチャンネル）。無ければ SLACK_WEBHOOK_URL（全社の通知チャンネル）。どちらも無ければ送らない。
//   営業担当の Slack のメンバーID（提案管理の「フォローの設定」）があればメンション（<@U…>）して、本人に通知を届ける。
//   無ければ名前だけ。担当が決まっていなければ「担当未割当」と出す（アプリ内のベル・管理側への通知が本体）。
//
// ■ 載せないもの
//   人材の氏名（イニシャルだけ）・先方の窓口のメール・電話番号・提案メールの本文。

import { notifySlack } from "./slack.js";
import { dateTime as jst } from "./jst.js";
import { SLACK_MEMBER_RE } from "./sales-proposals.js";

/** 送り先（営業用のチャンネル → 全社の通知チャンネル）。無ければ null */
export function salesSlackWebhook() {
  const own = String(process.env.SALES_SLACK_WEBHOOK_URL || "").trim();
  if (own) return own;
  const all = String(process.env.SLACK_WEBHOOK_URL || "").trim();
  return all || null;
}

// Slack の mrkdwn で意味を持つ文字（社名に & や < が入っても崩さない・メンションを作らせない）
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 通知の中身（純粋。テストで中身を確かめる）
 * @param {{kind:"matched"|"sent", proposal:object, ownerName?:string|null, ownerSlackId?:string|null, due?:string|null}} o
 * @returns {{text:string, lines:(string|null)[], link:string}}
 */
export function slackMessageOf({ kind, proposal, ownerName = null, ownerSlackId = null, due = null }) {
  const who = ownerSlackId && SLACK_MEMBER_RE.test(ownerSlackId) ? `<@${ownerSlackId}>`
    : ownerName ? `${esc(ownerName)} さん` : "担当未割当（管理者が割り当ててください）";
  const head = kind === "matched"
    ? `:handshake: マッチング確定・提案待ち　${who}`
    : `:telephone_receiver: 提案送信・電話待ち　${who}`;
  const what = [esc(proposal.company_name), esc(proposal.title)].filter(Boolean).join("　");
  return {
    text: head,
    lines: [
      what,
      proposal.matching_owner_name ? `マッチング担当：${esc(proposal.matching_owner_name)}` : null,
      due ? `${kind === "matched" ? "提案準備" : "初回電話"}の期限：${jst(due)}` : null,
      kind === "matched" ? "内容を確認して企業へ提案してください（提案を送ると、30分以内の電話のタスクに進みます）" : "提案から30分以内に電話して、結果を記録してください",
    ],
    link: `sales/proposals.html?id=${proposal.id}`,
  };
}

/**
 * 提案ごとに1回だけ Slack へ送る。
 * @returns {Promise<{sent:boolean, skipped?:string, error?:string}>}
 */
export async function notifyProposalSlack(sb, { kind, proposal, due = null, ownerName = null, slackMembers = {} }) {
  const webhook = salesSlackWebhook();
  if (!webhook) return { sent: false, skipped: "not_configured" };
  const stamp = new Date().toISOString();
  // 先に印を取る（空のときだけ）。取れなければ、もう誰かが送った（または送っている）
  const { data: claimed, error } = await sb.from("gw_sales_proposals").update({ slack_notified_at: stamp })
    .eq("id", proposal.id).is("slack_notified_at", null).select("id").maybeSingle();
  if (error) return { sent: false, error: String(error.code || "claim_failed") };
  if (!claimed) return { sent: false, skipped: "already" };

  const ownerSlackId = proposal.sales_owner_id ? slackMembers?.[proposal.sales_owner_id] || null : null;
  const r = await notifySlack({ ...slackMessageOf({ kind, proposal, ownerName, ownerSlackId, due }), webhook });
  if (!r.sent) {
    // 送れなかった：印を戻す（次の連携で送り直せるように）。自分が入れた印のときだけ
    await sb.from("gw_sales_proposals").update({ slack_notified_at: null }).eq("id", proposal.id).eq("slack_notified_at", stamp);
    return { sent: false, error: r.error || "send_failed" };
  }
  return { sent: true };
}
