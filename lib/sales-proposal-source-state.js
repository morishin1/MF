// Explicit ENGER proposal state only. Never infer a customer reply from a stage.
export const SOURCE_STATE_EVENT = "proposal.source_state";
export const SOURCE_STATE_TABLE = "gw_sales_proposal_source_state";
export const SOURCE_STATE_SQL = "db/149_sales_proposal_source_state.sql";
export const COMPANY_RESPONSE_LABELS = { proceed: "話を進める", pass: "見送り", unanswered: "未回答" };
const MAX_VERSION = 9223372036854775807n;
export function normalizeSourceState(e, { now = new Date() } = {}) {
  const s = e.source_state;
  const version = s?.version;
  if (!s || typeof s !== "object" || Array.isArray(s)
    || typeof version !== "string" || !/^[1-9][0-9]{0,18}$/.test(version)
    || BigInt(version) > MAX_VERSION) return { error: "invalid_body", field: "source_state.version" };
  if (typeof s.deleted !== "boolean") return { error: "invalid_body", field: "source_state.deleted" };
  if (s.company_response !== null && !Object.hasOwn(COMPANY_RESPONSE_LABELS, s.company_response)) {
    return { error: "invalid_body", field: "source_state.company_response" };
  }
  if (Object.hasOwn(s, "candidate_response") && s.candidate_response !== null && !Object.hasOwn(COMPANY_RESPONSE_LABELS, s.candidate_response)) {
    return { error: "invalid_body", field: "source_state.candidate_response" };
  }
  if (s.source !== "enger.proposals.job_action_type") return { error: "invalid_body", field: "source_state.source" };
  const date = new Date(e.occurred_at);
  if (typeof e.occurred_at !== "string" || !Number.isFinite(date.getTime()) || date.getTime() > now.getTime() + 600000) {
    return { error: "invalid_body", field: "occurred_at" };
  }
  return { value: { version, deleted: s.deleted, companyResponse: s.company_response,
    candidateResponse: Object.hasOwn(s, "candidate_response") ? s.candidate_response : null,
    candidateResponseProvided: Object.hasOwn(s, "candidate_response"),
    observedAt: date.toISOString() } };
}

// Read through the caller's RLS, scoped to this tenant and these proposal IDs.
// Only explicit activation enables reads; absent/invalid flags preserve legacy operation.
export async function readSourceStates(sb, tenantId, proposals) {
  const ids = [...new Set(proposals.filter(p => p.source_system === "enger" && p.source_proposal_id).map(p => p.source_proposal_id))];
  const states = new Map();
  if (process.env.SALES_SOURCE_STATE_ENABLED !== "1") return { states, available: false };
  for (let i = 0; i < ids.length; i += 100) {
    let { data, error } = await sb.from(SOURCE_STATE_TABLE)
      .select("source_proposal_id,source_version,deleted,company_response,candidate_response,observed_at")
      .eq("tenant_id", tenantId).in("source_proposal_id", ids.slice(i, i + 100));
    // 段階的デプロイ: 追加SQLの適用前でも既存の企業回答の表示は壊さない。
    if (error && /candidate_response/i.test(String(error.message || ""))) {
      ({ data, error } = await sb.from(SOURCE_STATE_TABLE)
        .select("source_proposal_id,source_version,deleted,company_response,observed_at")
        .eq("tenant_id", tenantId).in("source_proposal_id", ids.slice(i, i + 100)));
    }
    if (error) {
      return { states, error: { ...error, sourceState: true }, available: false };
    }
    for (const state of data || []) states.set(state.source_proposal_id, state);
  }
  return { states, available: true, missingIds: ids.filter(id => !states.has(id)) };
}
export function sourceStateFor(proposal, states) {
  return proposal.source_system === "enger" ? states.get(proposal.source_proposal_id) || null : null;
}
export function shapeSourceState(state, { expected = false } = {}) {
  return state ? {
    sourceDeleted: state.deleted === true, sourceStatePending: false,
    companyResponse: state.company_response,
    candidateResponse: state.candidate_response ?? null,
    candidateResponseLabel: COMPANY_RESPONSE_LABELS[state.candidate_response] || null,
    companyResponseLabel: COMPANY_RESPONSE_LABELS[state.company_response] || null,
    companyResponseSource: "ENGER企業回答",
    sourceStateObservedAt: state.observed_at,
  } : { sourceDeleted: null, sourceStatePending: expected, companyResponse: null, companyResponseLabel: null,
    candidateResponse: null, candidateResponseLabel: null, sourceStateObservedAt: null };
}
