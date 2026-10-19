// POST /api/sales/proposals/intake … dx.enger で「送った」提案を、/sales 提案管理に起票する（サーバー間だけ）
//
// ■ ブラウザからは呼ばせない
//   dx.enger のサーバーが HMAC-SHA256 で署名して送る（lib/sales-proposal-intake.js verifyGwSignature・用途 "proposal"）。
//   ブラウザには鍵が無いので直接は通らない。CORS のヘッダーも出さない。ログインの代わりに署名で守る。
//
// ■ 環境変数
//   ENGER_SALES_SECRET        署名の鍵（dx.enger 側の GW_SALES_SECRET と同じ値。32文字以上）。未設定なら 503（常に拒否）
//   SALES_PROPOSAL_TENANT_ID  起票するテナント。リクエストからは決めない（固定）。未設定なら 503
//
// ■ 本文
//   1件 { event_id, event_type: "proposal.sent" | "proposal.updated", occurred_at, proposal: {…} }
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
        tenantId, actorId: null, action: "sales.proposal_intake", target: `sales_proposal:${out.proposalId}`,
        detail: { source: "enger", eventType: v.eventType, result: out.result, sourceProposalId: v.proposal.id, warnings: out.warnings },
      });
    }
    if (out.notify?.employeeIds?.length) {
      await notify(out.notify.employeeIds.map((employeeId) => ({
        tenantId, employeeId, kind: "sales", title: out.notify.title, body: out.notify.body,
        link: out.notify.link, dedupeKey: out.notify.dedupeKey,
      })));
    }
  }
  // 1件でも失敗したら 500（dx.enger は失敗したぶんを再送する。成功したぶんは replayed になるだけ）
  const status = failed ? 500 : 200;
  return json(res, status, { ok: !failed, results, ...(results.length === 1 ? { result: results[0].result, proposal_id: results[0].proposal_id } : {}) });
}
