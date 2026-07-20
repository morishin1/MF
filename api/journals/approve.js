// POST /api/journals/approve
// 仕訳ドラフトの承認（staff/admin のみ）。
// Phase3 で MFアダプタへの送信処理をここから呼び出す予定。
//
// 入力: { journalId }
// 出力: { journal }

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships } from "../../lib/auth.js";
import { admin } from "../../lib/supabase.js";
import { audit } from "../../lib/audit.js";
import { maybeSendToMf } from "../../lib/mf-adapter.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const { journalId } = await readJson(req);
  if (!journalId) return json(res, 400, { error: "invalid_body", required: ["journalId"] });

  const sb = admin();
  const { data: jrn, error: e1 } = await sb
    .from("journals").select("id, tenant_id, client_id, status").eq("id", journalId).single();
  if (e1 || !jrn) return json(res, 404, { error: "journal_not_found" });

  // 承認は staff/admin のみ
  const memberships = await getMemberships(user.id);
  const isStaff = memberships.some(m => m.tenant_id === jrn.tenant_id && (m.role === "admin" || m.role === "staff"));
  if (!isStaff) return json(res, 403, { error: "forbidden_not_staff" });

  if (jrn.status !== "draft") {
    return json(res, 409, { error: "invalid_status", current: jrn.status });
  }

  // 冪等キーを設定（既に同一キーがあれば送信時に弾かれる）
  const idempotencyKey = `kp_${jrn.client_id}_${jrn.id}`;

  const { data: updated, error: e2 } = await sb
    .from("journals")
    .update({
      status: "approved",
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      idempotency_key: idempotencyKey,
    })
    .eq("id", jrn.id)
    .select()
    .single();
  if (e2) return json(res, 500, { error: "update_failed", detail: e2.message });

  await audit({
    tenantId: jrn.tenant_id, clientId: jrn.client_id, actorId: user.id,
    action: "journal.approved", target: `journal:${jrn.id}`,
    detail: { idempotencyKey },
  });

  // 承認後、そのまま MF へ連動を試みる（Phase3）。
  // MF 未構成のうちは何もせず status='approved' のまま返す（安全に停止）。
  // TODO(Phase3): accounting_credentials から officeUuid / accessToken を復号取得して渡す。
  const mf = await maybeSendToMf(updated, { officeUuid: null, accessToken: null });

  if (mf.sent) {
    const { data: sentJrn, error: e3 } = await sb
      .from("journals")
      .update({ status: "sent", external_id: mf.external_id, sent_at: new Date().toISOString() })
      .eq("id", jrn.id)
      .select()
      .single();
    if (e3) return json(res, 500, { error: "mf_sent_but_update_failed", detail: e3.message });

    await audit({
      tenantId: jrn.tenant_id, clientId: jrn.client_id, actorId: user.id,
      action: "mf.send", target: `journal:${jrn.id}`,
      detail: { externalId: mf.external_id, idempotencyKey },
    });
    return json(res, 200, { journal: sentJrn, mf: { sent: true } });
  }

  // 未送信（MF未構成など）: 承認までで確定
  return json(res, 200, { journal: updated, mf: { sent: false, reason: mf.reason } });
}
