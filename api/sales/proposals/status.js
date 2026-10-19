// POST /api/sales/proposals/status … dx.enger の提案詳細に「Sales のフォロー状況」を出すための読み取り（サーバー間だけ）
//
// ■ 何を返すか（提案を二重に持たない。dx.enger はここを読んで表示するだけ）
//   状態（電話待ち・回答待ち・面談調整・成約・見送り…）・理由コード・営業担当・最後の電話・最後のメール・返信・
//   面談の日時・次の行動と期限・期限超過・再提案依頼。窓口の連絡先や記録のメモは返さない。
//
// ■ 守り方：起票（intake.js）と同じ鍵 ENGER_SALES_SECRET の HMAC 署名。用途は "proposal-status"（起票の署名は通らない）
//   テナントは SALES_PROPOSAL_TENANT_ID で固定。dx.enger から来た提案（source_system = enger）だけを返す。
//
// 本文 { source_proposal_ids: ["…", …100件まで] }
// 返り値 200 { ok, items: [...], missing: ["まだ Sales に無い提案ID"] }

import { readJson, methodNotAllowed, json, dbSetupHint } from "../../../lib/http.js";
import { admin } from "../../../lib/supabase.js";
import { verifyGwSignature, readStatusQuery, statusItem, STATUS_PURPOSE } from "../../../lib/sales-proposal-intake.js";
import { PROPOSAL_FIELDS, TASK_FIELDS, shapeProposal } from "../../../lib/sales-proposals.js";
import { SQL_FILE, inChunks } from "../../../lib/sales-proposals-db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const secret = process.env.ENGER_SALES_SECRET || "";
  const tenantId = String(process.env.SALES_PROPOSAL_TENANT_ID || "").trim();
  if (secret.length < 32 || !UUID_RE.test(tenantId)) return json(res, 503, { ok: false, error: "not_configured" });

  const body = await readJson(req);
  const auth = verifyGwSignature(req.headers, body, STATUS_PURPOSE, { secret });
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
  const q = readStatusQuery(body);
  if (q.error) return json(res, 400, { ok: false, error: q.error, field: q.field });

  const sb = admin();
  const { data: rows, error } = await sb.from("gw_sales_proposals").select(PROPOSAL_FIELDS)
    .eq("tenant_id", tenantId).eq("source_system", "enger").in("source_proposal_id", q.ids);
  if (error) {
    if (dbSetupHint(error, SQL_FILE)) return json(res, 503, { ok: false, error: "not_ready" });
    return json(res, 500, { ok: false, error: "db_failed" });
  }
  const ids = (rows || []).map((r) => r.id);
  const [acts, tks, emps] = await Promise.all([
    inChunks(ids, (c) => sb.from("gw_sales_proposal_activities").select("proposal_id, kind, result, outcome, evidence, occurred_at").in("proposal_id", c)),
    inChunks(ids, (c) => sb.from("gw_sales_proposal_tasks").select(TASK_FIELDS).in("proposal_id", c)),
    sb.from("gw_employees").select("id, display_name").eq("tenant_id", tenantId).limit(2000),
  ]);
  if (acts.error || tks.error) return json(res, 500, { ok: false, error: "db_failed" });
  const names = new Map((emps.data || []).map((e) => [e.id, e.display_name]));
  const nameOf = (id) => (id ? names.get(id) || null : null);
  const now = new Date().toISOString();
  const base = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const items = (rows || []).map((p) => statusItem(shapeProposal(p, { activities: acts.data, tasks: tks.data, nameOf, now }), { nameOf, base }));
  const have = new Set(items.map((i) => i.source_proposal_id));
  return json(res, 200, { ok: true, items, missing: q.ids.filter((id) => !have.has(id)) });
}
