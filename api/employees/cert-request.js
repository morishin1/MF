// 退職証明書の本人申請（db/127・lib/retire-cert-request.js）
//
// 本人（退職手続き中。マイページ）。退職した人は、退職者ポータル（api/retiree/index.js）から同じことをする
// GET  /api/employees/cert-request                          … 選べる項目・誓約の文面・自分の申請（最新）
// POST /api/employees/cert-request {action:"request", items, ndaAgreed:true}
//        … 記載してほしい項目を選び、誓約にチェックして申請（申請中は1件だけ）
//
// 管理側（入退社の画面・チェックリストの「退職証明書の交付」）
// POST /api/employees/cert-request {action:"approve", employeeId, requestId, sealId?}
//        … 承認して発行：選んだ項目だけを印字した証明書を発行・押印し、本人に公開。
//          申請を「発行済み」にし、チェックリストの「退職証明書の交付」を完了（日時・対応者）にする
// POST /api/employees/cert-request {action:"return", employeeId, requestId, note?}
//        … 差し戻し（本人はもう一度申請できる）
//
// ■ 権限
//   本人の申請：本人だけ（社員 ID はサーバーがログイン中の人から引く）。退職手続き中・退職の人だけ。
//   承認して発行：経営者・管理者だけ（canManageSeals。発行・押印と同じ）。人事は内容の確認と差し戻しまで（canManageHr）。
//   管理側の操作は二段階認証（強制日以降）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr, canManageSeals } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { viewDoc } from "../../lib/retire-store.js";
import { issueCertificate } from "../../lib/retire-cert-issue.js";
import { REQ_FIELDS, viewRequest } from "../../lib/retire-cert-request.js";
import { CERT_SQL, CERT_EMP_FIELDS, selfState, createRequest, printable, completeChecklist } from "../../lib/retire-cert-request-db.js";

const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  const sb = admin();
  try {
    if (req.method === "GET") return await selfRead(res, sb, ctx);
    const body = await readJson(req);
    const action = String(body?.action || "");
    if (action === "request") return await selfRequest(req, res, sb, ctx, user, body);
    if (action === "approve" || action === "return") {
      if (!(await requireMfa(req, res, ctx, user))) return;
      if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });
      return action === "approve" ? await approve(res, sb, ctx, user, body) : await giveBack(res, sb, ctx, user, body);
    }
    return json(res, 400, { error: "invalid_action", detail: "request, approve, return" });
  } catch (e) {
    const hint = dbSetupHint(e, CERT_SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[employees/cert-request]", e?.message || e);
    return json(res, 500, { error: "cert_request_failed" });
  }
}

/** ログイン中の本人の社員（名簿から引き直す。在籍状態はここで確かめる） */
async function me(sb, ctx) {
  if (!ctx.employee?.id) return null;
  return must(sb.from("gw_employees").select("id, tenant_id, display_name, status").eq("id", ctx.employee.id).eq("tenant_id", ctx.tenantId).maybeSingle());
}

async function selfRead(res, sb, ctx) {
  const emp = await me(sb, ctx);
  if (!emp) return json(res, 404, { error: "not_found" });
  res.setHeader?.("Cache-Control", "no-store");
  return json(res, 200, { canRequest: ["leaving", "left"].includes(emp.status), ...(await selfState(sb, ctx.tenantId, emp.id)) });
}

async function selfRequest(req, res, sb, ctx, user, body) {
  const emp = await me(sb, ctx);
  if (!emp) return json(res, 404, { error: "not_found" });
  const r = await createRequest(sb, { tenantId: ctx.tenantId, employee: emp, user, req, body });
  return json(res, r.status, r.body);
}

async function loadPair(sb, ctx, body) {
  const emp = body?.employeeId ? await must(sb.from("gw_employees").select(CERT_EMP_FIELDS)
    .eq("id", String(body.employeeId)).eq("tenant_id", ctx.tenantId).maybeSingle()) : null;
  if (!emp) return {};
  const reqRow = body?.requestId ? await must(sb.from("gw_retire_cert_requests").select(REQ_FIELDS)
    .eq("id", String(body.requestId)).eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).maybeSingle()) : null;
  return { emp, reqRow };
}

async function approve(res, sb, ctx, user, body) {
  if (!canManageSeals(ctx)) {
    return json(res, 403, { error: "seal_forbidden", hint: "承認して発行（押印）は、経営者・管理者だけができます。内容を確認したら、経営者・管理者に依頼してください" });
  }
  const { emp, reqRow } = await loadPair(sb, ctx, body);
  if (!emp || !reqRow) return json(res, 404, { error: "not_found" });
  if (reqRow.status !== "requested") return json(res, 409, { error: "not_requested", hint: "この申請は、すでに対応済みです" });

  // 労働基準法22条：本人が選んだ項目だけを印字する。値が無い項目があれば発行しない（「（未登録）」を印字しない）
  const p = await printable(sb, ctx, emp, reqRow.items);
  if (p.missing.length) {
    return json(res, 400, { error: "missing_values", missing: p.missing, hint: `証明書に記載する値がありません：${p.missing.join("、")}。名簿・契約・退職理由を入れてから発行してください` });
  }
  const done = await issueCertificate(sb, ctx, user, emp, {
    text: p.text, includeReason: reqRow.items.includes("cause"), sealId: body.sealId,
  });
  if (done.status) return json(res, done.status, done.body);
  const { row, live, seal } = done;
  const now = new Date().toISOString();

  // 本人に公開（ダウンロードできるようにする）
  await must(sb.from("gw_retire_docs").update({ published: true, published_at: now, published_by: user.id, updated_at: now })
    .eq("id", row.id).eq("tenant_id", ctx.tenantId).select("id").maybeSingle());
  // 申請を発行済みに（同時に2人が押しても、1回だけ）
  const decidedByName = ctx.employee?.display_name || null;
  const upd = await must(sb.from("gw_retire_cert_requests").update({
    status: "issued", decided_by: user.id, decided_by_name: decidedByName, decided_at: now, doc_id: row.id, updated_at: now,
  }).eq("id", reqRow.id).eq("tenant_id", ctx.tenantId).eq("status", "requested").select(REQ_FIELDS));
  const checked = await completeChecklist(sb, ctx, emp, user, now);

  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: live?.state === "issued" ? "retire.reissue" : "retire.issue", target: `employee:${emp.id}`,
    detail: { docId: row.id, kind: "certificate", version: row.version, issuedNo: row.issued_no, includeReason: reqRow.items.includes("cause"), sealId: seal.id, supersedes: live?.id || null, requestId: reqRow.id } });
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "retire.cert_approve", target: `employee:${emp.id}`,
    detail: { requestId: reqRow.id, docId: row.id, items: reqRow.items, checklist: checked } });
  return json(res, 200, { ok: true, request: viewRequest((upd || [])[0] || reqRow, { admin: true }), document: viewDoc({ ...row, published: true, published_at: now }), checklist: checked });
}

async function giveBack(res, sb, ctx, user, body) {
  const { emp, reqRow } = await loadPair(sb, ctx, body);
  if (!emp || !reqRow) return json(res, 404, { error: "not_found" });
  if (reqRow.status !== "requested") return json(res, 409, { error: "not_requested", hint: "この申請は、すでに対応済みです" });
  const now = new Date().toISOString();
  const note = String(body?.note || "").trim().slice(0, 500) || null;
  await must(sb.from("gw_retire_cert_requests").update({
    status: "cancelled", decided_by: user.id, decided_by_name: ctx.employee?.display_name || null, decided_at: now, decision_note: note, updated_at: now,
  }).eq("id", reqRow.id).eq("tenant_id", ctx.tenantId).eq("status", "requested").select("id"));
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "retire.cert_return", target: `employee:${emp.id}`, detail: { requestId: reqRow.id } });
  return json(res, 200, { ok: true });
}
