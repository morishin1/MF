import assert from "node:assert/strict";
import { createMemDb } from "./_memdb.mjs";
import { runProposalCoordination } from "../api/sales/proposals/coordination.js";
import { mergeEngerContacts } from "../lib/enger-proposal-coordination.js";

const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenant = uid(1), id = uid(2), sourceId = uid(3), owner = uid(4);
const sales = { sales: true, enger: false }, enger = { sales: false, enger: true };
const actor = { id: uid(5) }, teammate = { id: uid(6) };
const ctx = { tenantId: tenant, employee: { id: owner }, roles: [] };
const at = "2026-11-22T01:00:00Z";
const mem = createMemDb({
  schema: {
    gw_enger_proposal_coordination: {
      unique: [["tenant_id", "proposal_id"]],
      defaults: () => ({ revision: 1, enger_confirmed_by: null, enger_confirmed_at: null }),
    },
  },
});
mem.rows.gw_sales_proposals = [{
  id, tenant_id: tenant, source_proposal_id: sourceId, source_system: "enger",
  sales_owner_id: owner, sent_at: at, archived_at: null, status: "reply_wait",
}];
mem.rows.proposals = [{
  id: sourceId, deleted_at: null, stage: "提案中", company: "提案先",
  proposer: "提案担当", job_action_type: "話を進める", cand_action_type: "未回答",
  dx2_job_reply_due: "2026-11-24", dx2_cand_reply_due: "2026-11-25", dx2_decision_due: "2026-11-27",
}];
mem.rows.activity_logs = [{
  id: uid(10), target_id: sourceId, target_type: "proposal", action: "コンタクト: 人材側へメール",
  detail: "稼働日を確認", created_at: at, operator: "提案担当",
}, {
  id: uid(11), target_id: sourceId, target_type: "proposal", action: "完全削除前の写し",
  detail: "非公開情報", created_at: at, operator: "事務担当",
}];
mem.rows.proposal_memos = [{
  id: uid(12), proposal_id: sourceId, category: "連絡記録",
  body: "[人材側へメール / 2026-11-22 09:30] 稼働日を確認", created_at: at, created_by_name: "提案担当",
}, {
  id: uid(13), proposal_id: sourceId, category: "社内メモ",
  body: "社内メモは転送しない", created_at: at, created_by_name: "提案担当",
}];
mem.rows.share_links = [{
  id: uid(14), proposal_id: sourceId, kind: "job", response: "進める", responded_at: at,
  response_note: "個別メモは表示対象外",
}];
const sb = mem.admin();
sb.schema = () => ({ from(table) {
  const q = sb.from(table);
  q.like = (col, value) => q.ilike(col, value);
  return q;
} });
async function request(method, roles, user, body = {}, context = ctx, query = "?id=" + id) {
  const res = { setHeader() {}, end(raw) { this.payload = JSON.parse(raw); } };
  await runProposalCoordination({ method, url: "/api/sales/proposals/coordination" + query }, res,
    { sb, ctx: context, user, roles, body });
  return { code: res.statusCode, data: res.payload };
}

const first = await request("GET", sales, actor);
assert.equal(first.code, 200);
assert.equal(first.data.source.companyDue, "2026-11-24");
assert.equal(first.data.source.contacts.length, 1);
assert.equal(first.data.source.contacts[0].at, "2026-11-22T09:30:00+09:00");
assert.equal(first.data.source.contacts[0].text, "稼働日を確認");
assert.equal(first.data.source.line.candidate.response, "進める");
assert.equal(JSON.stringify(first.data).includes("非公開情報"), false);
assert.equal(JSON.stringify(first.data).includes("社内メモは転送しない"), false);
assert.equal(JSON.stringify(first.data).includes("個別メモは表示対象外"), false);
assert.equal(mergeEngerContacts([], []).length, 0);
assert.equal((await request("GET", sales, actor, {}, { ...ctx, tenantId: uid(90) })).code, 404);
assert.equal((await request("GET", { sales: false, enger: false }, actor)).code, 403);
const save = { id, action: "save", decision: "開始日の回答を待つ", nextStep: "Salesが25日までに企業へ回答",
  revision: 0, sourceRevision: first.data.source.revision };
assert.equal((await request("POST", enger, teammate, save)).code, 403);
assert.equal((await request("POST", sales, actor, save, { ...ctx, employee: { id: uid(90) } })).code, 403);
assert.equal((await request("POST", sales, actor, save)).code, 200);
const shared = await request("GET", enger, teammate, {}, ctx, "?sourceId=" + sourceId);
assert.equal(shared.data.record.decision, save.decision);
assert.equal(shared.data.canSave, false);
assert.equal(shared.data.canConfirm, true);
assert.equal(shared.data.record.engerConfirmedAt, null);
const confirm = { sourceId, action: "confirm", revision: 1, sourceRevision: shared.data.source.revision };
assert.equal((await request("POST", { sales: true, enger: true }, actor, confirm)).code, 403);
mem.rows.proposals[0].dx2_cand_reply_due = "2026-11-26";
assert.equal((await request("POST", enger, teammate, confirm)).code, 409);
const changed = await request("GET", sales, actor);
assert.equal(changed.data.record.sourceChanged, true);
assert.equal((await request("POST", sales, actor, { ...save, revision: 1, sourceRevision: changed.data.source.revision })).code, 200);
assert.equal((await request("POST", enger, teammate, { ...confirm, revision: 2, sourceRevision: changed.data.source.revision })).code, 200);
assert.ok((await request("GET", sales, actor)).data.record.engerConfirmedAt);
assert.equal(JSON.stringify((await request("GET", sales, actor)).data).includes(actor.id), false);
const readSharedProgress = async () => (await request("GET", enger, teammate, {}, ctx, "?sourceId=" + sourceId)).data;
mem.rows.gw_sales_proposals[0].status = "meeting_adjust";
assert.deepEqual((await readSharedProgress()).salesProgress, { stage: "meeting", status: "meeting_adjust" });
mem.rows.gw_sales_proposals[0].status = "considering";
mem.rows.gw_sales_proposal_activities = [{
  id: uid(25), tenant_id: tenant, proposal_id: id, created_at: at,
  "detail->salesProgress": {}, detail: { salesProgress: { stage: "conditions", revenue: 999999 } },
}];
const conditions = await readSharedProgress();
assert.deepEqual(conditions.salesProgress, { stage: "conditions", status: "considering" });
assert.equal(JSON.stringify(conditions).includes("999999"), false);
mem.rows.gw_sales_proposals[0].close_reason = "sales_hold";
assert.equal((await readSharedProgress()).salesProgress.stage, "hold");
mem.rows.gw_sales_proposals[0].close_reason = null;
mem.rows.gw_sales_proposals[0].status = "won";
mem.rows.gw_sales_proposal_activities.push({
  id: uid(26), tenant_id: tenant, proposal_id: id, created_at: "2026-11-23T01:00:00Z",
  "detail->salesProgress": {}, detail: { salesProgress: { stage: "active" } },
});
assert.deepEqual((await readSharedProgress()).salesProgress, { stage: "active", status: "won" });
mem.rows.gw_sales_proposals[0].status = "lost";
assert.equal((await readSharedProgress()).salesProgress.stage, "lost");
mem.rows.gw_sales_proposals[0].sent_at = null;
mem.rows.gw_sales_proposals[0].status = "proposal_wait";
assert.equal((await request("GET", sales, actor)).data.salesSentAt, null);
assert.deepEqual((await readSharedProgress()).salesProgress, { stage: "proposal", status: "proposal_wait" });
console.log("Proposal coordination PASS: ENGER facts, limited contact history, separate actors and re-confirmation.");
