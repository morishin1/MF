// POST /api/sales/proposals/intake … dx.enger でマッチングが確定した提案を /sales 提案管理に起票し、
//                                     企業へ提案を送ったら電話待ちへ進める（サーバー間だけ。db/138・db/140）
//
// ■ ブラウザからは呼ばせない
//   dx.enger のサーバーが HMAC-SHA256 で署名して送る（lib/sales-proposal-intake.js verifyGwSignature・用途 "proposal"）。
//   ブラウザには鍵が無いので直接は通らない。CORS のヘッダーも出さない。ログインの代わりに署名で守る。
//
// ■ 環境変数
//   ENGER_SALES_SECRET        署名の鍵（dx.enger 側の GW_SALES_SECRET と同じ値。32文字以上）。未設定なら 503（常に拒否）
//   SALES_PROPOSAL_TENANT_ID  起票するテナント。リクエストからは決めない（固定）。未設定なら 503
//   SALES_SLACK_WEBHOOK_URL   起票を知らせる Slack（営業のチャンネル）。無ければ SLACK_WEBHOOK_URL。どちらも無ければ Slack は送らない
//
// ■ 本文
//   1件 { event_id, event_type: "proposal.matched" | "proposal.sent" | "proposal.updated", occurred_at, proposal: {…} }
//       proposal.matched … マッチング確定（提案待ち・提案準備・Slack）／ proposal.sent … 企業へ提案を送った（電話待ち・30分）
//   まとめて { events: [ …50件まで ] }（dx.enger の再送の回で使う）
//   中身は docs/sales-proposals.md「連携API」
//
// ■ 返すもの
//   200 { ok, results: [{ event_id, result: "created"|"updated"|"replayed"|"skipped"|"error", proposal_id, warnings }] }
//       1件のときは results の1件目を上にも出す（result・proposal_id）
//   400 invalid_body（field。直さない限り同じなので、dx.enger は再送しない）
//   401 unauthorized・timestamp_out_of_range / 503 not_configured・not_ready（db/138 未実行）/ 500（再送してよい）
//
// ■ ログ：監査ログ・コンソールに、メール・氏名を出さない

import { readJson, methodNotAllowed, json, dbSetupHint } from "../../../lib/http.js";
import { admin } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { notify } from "../../../lib/notify.js";
import { verifyGwSignature, readEvents, intakeEvent, INTAKE_PURPOSE } from "../../../lib/sales-proposal-intake.js";
import { notifyProposalSlack } from "../../../lib/sales-proposal-slack.js";
import { notifySentShared } from "../../../lib/sales-proposal-handoff-slack.js";
import { settingsOf } from "../../../lib/sales-proposals.js";
import { SQL_FILE } from "../../../lib/sales-proposals-db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const secret = process.env.ENGER_SALES_SECRET || "";
  const tenantId = String(process.env.SALES_PROPOSAL_TENANT_ID || "").trim();
  // 設定が揃っていないときは受け付けない（どのテナントへ入れるかを推測しない）
  if (secret.length < 32 || !UUID_RE.test(tenantId)) return json(res, 503, { ok: false, error: "not_configured" });

  const body = await readJson(req);
  const auth = verifyGwSignature(req.headers, body, INTAKE_PURPOSE, { secret });
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });

  const read = readEvents(body);
  if (read.error) return json(res, 400, { ok: false, error: read.error, field: read.field });
  const bad = read.events.find((e) => e.error);
  if (bad) return json(res, 400, { ok: false, error: bad.error, field: bad.field });

  const sb = admin();
  // 社員名簿と設定は1回だけ読む（まとめて届いたとき）
  const [{ data: employees, error: eEmp }, { data: settingsRow, error: eSet }] = await Promise.all([
    sb.from("gw_employees").select("id, display_name, email, status").eq("tenant_id", tenantId).limit(2000),
    sb.from("gw_sales_proposal_settings").select("*").eq("tenant_id", tenantId).maybeSingle(),
  ]);
  if (eSet && dbSetupHint(eSet, SQL_FILE)) return json(res, 503, { ok: false, error: "not_ready" });
  if (eEmp) return json(res, 500, { ok: false, error: "db_failed" });

  const results = [];
  let failed = 0;
  for (const { value: v } of read.events) {
    const out = await intakeEvent(sb, tenantId, v, { employees: employees || [], settingsRow: settingsRow || null });
    if (out.error) {
      if (out.status === 503) return json(res, 503, { ok: false, error: "not_ready" });
      failed++;
      console.error("[sales-proposals/intake] failed:", out.error, v.eventId);
      results.push({ event_id: v.eventId, result: "error", proposal_id: null, warnings: [] });
      continue;
    }
    results.push({ event_id: v.eventId, result: out.result, proposal_id: out.proposalId, warnings: out.warnings });
    if (out.result === "created" || out.result === "updated") {
      await gwLog({
        tenantId, actorId: null, action: "sales.proposal_intake", target: out.proposalId ? `sales_proposal:${out.proposalId}` : `sales_proposal_source:${v.proposal.id}`,
        detail: { source: "enger", eventType: v.eventType, result: out.result, sourceProposalId: v.proposal.id, warnings: out.warnings },
      });
    }
    if (!out.suppressNotifications && out.notify?.employeeIds?.length) {
      await notify(out.notify.employeeIds.map((employeeId) => ({
        tenantId, employeeId, kind: "sales", title: out.notify.title, body: out.notify.body,
        link: out.notify.link, dedupeKey: out.notify.dedupeKey,
      })));
    }
    // 企業への初回提案送信は、従来のマッチング確定通知とは別にCS・クロージング全員へ共有。
    if (!out.suppressNotifications && v.eventType === "proposal.sent" && (out.result === "created" || out.result === "updated") && out.proposalId) {
      const shared = await notifySentShared(sb, { proposalId: out.proposalId, settingsRow, employees: employees || [] });
      if (shared.error) {
        console.error("[sales-proposals/intake] sent share:", shared.error, v.eventId);
        await sb.from("gw_sales_proposal_sync_log").update({ status: "warning",
          message: [...out.warnings, "sent_share_failed"].join(","),
          updated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId).eq("source_system", "enger").eq("event_id", v.eventId);
      }
    }
    // Slack：起票したときだけ・提案ごとに1回（送れなかったら連携の確認に「要確認」で残す。ベルには届いている）
    if (!out.suppressNotifications && out.slack) {
      const ownerName = (employees || []).find((e) => e.id === out.slack.proposal.sales_owner_id)?.display_name || null;
      const sent = await notifyProposalSlack(sb, { ...out.slack, ownerName, slackMembers: settingsOf(settingsRow).slackMembers });
      if (sent.error) {
        console.error("[sales-proposals/intake] slack:", sent.error, v.eventId);
        await sb.from("gw_sales_proposal_sync_log").update({ status: "warning", message: [...out.warnings, "slack_failed"].join(","), updated_at: new Date().toISOString() })
          .eq("tenant_id", tenantId).eq("source_system", "enger").eq("event_id", v.eventId);
      }
    }
  }
  // 1件でも失敗したら 500（dx.enger は失敗したぶんを再送する。成功したぶんは replayed になるだけ）
  const status = failed ? 500 : 200;
  return json(res, status, { ok: !failed, results, ...(results.length === 1 ? { result: results[0].result, proposal_id: results[0].proposal_id } : {}) });
}
