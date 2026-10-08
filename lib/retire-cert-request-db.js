// 退職証明書の本人申請（db/127）の読み書き。本人の申請（退職手続き中はマイページ、退職者は退職者ポータル）と、
// 管理側の承認して発行・差し戻し（api/employees/cert-request.js）・入退社の画面への表示（api/employees/retire-case.js）が使う。

import { REQ_FIELDS, validateRequest, NDA_TEXT, NDA_VERSION, clientIp, userAgent, itemValues, requestBody, viewRequest, CERT_ITEMS } from "./retire-cert-request.js";
import { reasonLabel } from "./retire.js";
import { gwLog } from "./gw-audit.js";

const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
export const CERT_SQL = "db/127_retire_cert_requests.sql";
export const CERT_EMP_FIELDS = "id, tenant_id, user_id, display_name, department, position, initial_role, employment_type, joined_on, left_on, status";

/** 本人に見せる選択肢と、いまの申請（最新の1件） */
export async function selfState(sb, tenantId, employeeId) {
  const rows = await must(sb.from("gw_retire_cert_requests").select(REQ_FIELDS)
    .eq("tenant_id", tenantId).eq("employee_id", employeeId).order("requested_at", { ascending: false }).limit(1));
  return {
    options: { items: CERT_ITEMS.map((i) => ({ key: i.key, label: i.label })), ndaText: NDA_TEXT, ndaVersion: NDA_VERSION },
    request: viewRequest((rows || [])[0] || null),
  };
}

/**
 * 本人の申請。申請中が既にあれば 409。誓約の文面・版・日時・接続元・ブラウザを残す
 * @returns {{status:number, body:object}}
 */
export async function createRequest(sb, { tenantId, employee, user, req, body }) {
  if (!["leaving", "left"].includes(employee.status)) {
    return { status: 409, body: { error: "not_leaving", hint: "退職手続き中・退職の方だけ、退職証明書を申請できます" } };
  }
  const v = validateRequest(body);
  if (v.error) return { status: 400, body: v };
  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_retire_cert_requests").insert({
    tenant_id: tenantId, employee_id: employee.id, items: v.items, status: "requested",
    nda_text: NDA_TEXT, nda_version: NDA_VERSION, nda_agreed_at: now, nda_ip: clientIp(req), nda_user_agent: userAgent(req),
    requested_by: user.id, requested_at: now, created_at: now, updated_at: now,
  }).select(REQ_FIELDS).single();
  if (error) {
    if (error.code === "23505") return { status: 409, body: { error: "already_requested", hint: "申請中の退職証明書があります。発行までお待ちください" } };
    throw error;
  }
  // 記録：選んだ項目の鍵だけ（接続元・ブラウザは残さない）
  await gwLog({ tenantId, actorId: user.id, action: "retire.cert_request", target: `employee:${employee.id}`, detail: { requestId: data.id, items: v.items } });
  return { status: 200, body: { ok: true, request: viewRequest(data) } };
}

/** 管理側：その人の申請（最新）と、発行したら印字される本文（選んだ項目だけ） */
export async function adminState(sb, ctx, emp, { canSeeWage }) {
  const rows = await must(sb.from("gw_retire_cert_requests").select(REQ_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).order("requested_at", { ascending: false }).limit(1));
  const r = (rows || [])[0];
  if (!r) return null;
  const view = viewRequest(r, { admin: true });
  if (r.status === "requested") {
    const p = await printable(sb, ctx, emp, r.items);
    view.preview = canSeeWage ? p.text : p.text.replace(/^賃金：.*$/m, "賃金：（給与を見られる人だけに表示）");
    view.missing = p.missing;
  }
  return view;
}

/** 選んだ項目の本文（社員の情報・いまの契約の賃金・退職理由から） */
export async function printable(sb, ctx, emp, items) {
  const [contract, caseRow] = await Promise.all([
    items.includes("wage")
      ? sb.from("gw_contracts").select("wage_type, wage_amount").eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle().then((q) => (q.error ? null : q.data))
      : null,
    items.includes("cause")
      ? sb.from("gw_retire_cases").select("reason_code").eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).maybeSingle().then((q) => (q.error ? null : q.data))
      : null,
  ]);
  const values = itemValues({ employee: emp, contract, reasonLabel: reasonLabel(caseRow?.reason_code) });
  return requestBody({ items, name: emp.display_name, values });
}

/** 入退社のチェックリストの「退職証明書の交付」を完了にする（無ければ何もしない） */
export async function completeChecklist(sb, ctx, emp, user, now) {
  const procs = await must(sb.from("gw_procedures").select("id").eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id)
    .eq("kind", "offboarding").neq("status", "cancelled").limit(5));
  const ids = (procs || []).map((p) => p.id);
  if (!ids.length) return 0;
  const done = await must(sb.from("gw_procedure_items").update({ status: "done", completed_at: now, completed_by: user.id, updated_at: now })
    .in("procedure_id", ids).eq("item_key", "off_hr_cert").neq("status", "done").select("id"));
  return (done || []).length;
}
