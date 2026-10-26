// Salesの合格記録 → Officeの「書類作成依頼」。成約・契約締結・署名とは独立。
export const SQL_FILE = "db/proposal_sales_office_contract_requests.sql";
export const ACCEPTED_STAGES = ["合格", "面談合格"];
export const CONTRACT_TYPES = [
  { key: "client_ses", label: "顧客向けSES契約" }, { key: "bp_order", label: "BP向け注文書" },
  { key: "employment", label: "本人向け雇用契約" }, { key: "contractor", label: "本人向け業務委託契約" },
  { key: "needs_confirmation", label: "契約種別は要確認" },
];
export const REQUEST_STATUSES = [
  { key: "requested", label: "未着手" }, { key: "in_progress", label: "作成中" },
  { key: "review", label: "確認待ち" }, { key: "completed", label: "作成完了" },
  { key: "cancelled", label: "取消" },
];
export const STATUS_LABEL = Object.fromEntries(REQUEST_STATUSES.map((s) => [s.key, s.label]));
export const STATUS_TRANSITIONS = { requested: ["requested", "in_progress"], in_progress: ["in_progress", "review"],
  review: ["review", "in_progress", "completed"], completed: [], cancelled: [] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const validDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
const invalid = (field, hint = "入力内容を確認してください") => ({ error: "invalid_body", field, hint });

/** 保存済みのENGER事実のみ。稼働/成約から合格を推定しない。DB guardも同じ境界を守る。 */
export function acceptanceEvidence(proposal, activities = []) {
  if (proposal?.source_system !== "enger") return null;
  if (ACCEPTED_STAGES.includes(proposal.source_stage)) return "ENGER現在ステージ：" + proposal.source_stage;
  const a = activities.find((a) => a.kind === "sync" && a.source_event && !a.created_by && !a.employee_id
    && ACCEPTED_STAGES.includes(a.detail?.to));
  return a ? "ENGER合格への連携履歴" : null;
}

function normalize(body, office) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("body");
  const actions = office ? ["update", "reopen", "cancel"] : ["create", "resubmit", "cancel"];
  if (!actions.includes(body.action)) return invalid("action");
  if (!UUID.test(String(body.proposalId || ""))) return invalid("proposalId");
  if (body.action !== "create" && (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1)) return invalid("expectedVersion", "最新の状態を読み直してください");
  const fields = office
    ? ["status", "assigneeId", "contractType", "requestedDueOn", "plannedStartOn", "artifactReference", "employeeId", "docOrderId", "siteContractId", "reason"]
    : ["contractType", "requestedDueOn", "plannedStartOn", "note", "reason"];
  if (Object.keys(body).some((k) => !["action", "proposalId", "expectedVersion", ...fields].includes(k))) return invalid("fields");
  const payload = {};
  for (const k of fields) if (has(body, k)) payload[k] = body[k];
  if (body.action !== "create") {
    if (typeof body.reason !== "string" || body.reason.trim().length < 3 || body.reason.length > 1000) return invalid("reason", "変更・取消・再開の理由を3文字以上で記入してください");
    payload.reason = body.reason.trim();
  }
  for (const k of ["note", "artifactReference"]) if (has(payload, k)) {
    if (payload[k] != null && (typeof payload[k] !== "string" || payload[k].length > 2000)) return invalid(k);
    payload[k] = payload[k]?.trim() || null;
  }
  for (const k of ["assigneeId", "employeeId", "docOrderId", "siteContractId"]) if (has(payload, k)) {
    if (payload[k] !== null && !UUID.test(String(payload[k]))) return invalid(k);
  }
  if (has(payload, "contractType") && !CONTRACT_TYPES.some((t) => t.key === payload.contractType)) return invalid("contractType");
  if (has(payload, "status") && !["requested", "in_progress", "review", "completed"].includes(payload.status)) return invalid("status");
  for (const k of ["requestedDueOn", "plannedStartOn"]) if (has(payload, k)) {
    if (!(k === "plannedStartOn" && payload[k] === null) && !validDate(payload[k])) return invalid(k, "実在する日付（YYYY-MM-DD）を指定してください");
  }
  if (!office && ["create", "resubmit"].includes(body.action)) {
    if (!has(payload, "contractType")) return invalid("contractType");
    if (!validDate(payload.requestedDueOn)) return invalid("requestedDueOn");
  }
  return { value: { proposalId: body.proposalId, action: body.action, expectedVersion: body.expectedVersion ?? null, payload } };
}
export const normalizeSalesRequest = (body) => normalize(body, false);
export const normalizeOfficeUpdate = (body) => normalize(body, true);

/** SQL RPCは最小限の列だけを返す。生の契約/人事書類の内容は含めない。 */
export function shapeRequestEnvelope(data, office = false) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.rows)) {
    throw Object.assign(new Error("Unexpected contract request read response"), { code: "invalid_response" });
  }
  const rows = data.rows;
  return {
    ready: true, canEditOffice: office, canLinkHrDocs: office && Boolean(data?.canLinkHrDocs), truncated: Boolean(data?.truncated),
    members: office && Array.isArray(data?.members) ? data.members : [],
    rows: rows.map((p) => ({ ...p, request: p.request ? { ...p.request,
      statusLabel: STATUS_LABEL[p.request.status] || p.request.status,
      history: Array.isArray(p.request.history) ? p.request.history : [],
    } : null })),
  };
}
