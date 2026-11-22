import assert from "node:assert/strict";

export function adminWithProgress(mem) {
  const client = mem.admin();
  client.rpc = async (name, input) => {
    assert.equal(name, "gw_record_sales_proposal_progress");
    const proposal = mem.rows.gw_sales_proposals.find(p => p.tenant_id === input.p_tenant && p.id === input.p_proposal && !p.archived_at);
    if (proposal?.updated_at !== input.p_expected_at) return { error: { code: "40001" } };
    // Keep sequential transactions distinct even when Node runs them in one millisecond.
    const previous = mem.rows.gw_sales_proposal_activities.findLast(
      row => row.tenant_id === input.p_tenant && row.proposal_id === input.p_proposal && row.detail?.salesProgress,
    );
    const time = new Date(Math.max(Date.now(), previous ? Date.parse(previous.created_at) + 1 : 0)).toISOString();
    const activity = { ...input.p_activity, tenant_id: input.p_tenant, proposal_id: input.p_proposal, created_at: time };
    mem.rows.gw_sales_proposal_activities.push(activity);
    Object.assign(proposal, input.p_patch, { updated_at: time });
    for (const cancel of input.p_cancel) {
      const task = mem.rows.gw_sales_proposal_tasks.find(t => t.proposal_id === proposal.id && t.id === cancel.id);
      Object.assign(task, { status: "canceled", cancel_reason: cancel.reason });
    }
    for (const created of input.p_create) {
      await client.from("gw_sales_proposal_tasks").insert({ ...created, tenant_id: input.p_tenant, proposal_id: input.p_proposal });
    }
    return { error: null };
  };
  return client;
}
