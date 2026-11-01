import assert from "node:assert/strict";
import { normalizeEvent } from "../lib/sales-proposal-intake.js";
import { shapeProposal } from "../lib/sales-proposals.js";
const now = new Date("2026-11-01T12:00:00Z");
const example = {
 event_id:"enger:proposal.updated:p1:abcd1234",event_type:"proposal.updated",occurred_at:now.toISOString(),
 proposal:{id:"p1",company:{name:"Example Corp"},precheck:{status:"ready",observed_at:now.toISOString(),valid_until:"2026-11-06T12:00:00Z"}}
};
let parsed=normalizeEvent(example,{now});
assert.equal(parsed.value.proposal.precheckStatus,"ready");
assert.equal(parsed.value.proposal.precheckProvided,true);
assert.equal(normalizeEvent({...example,proposal:{...example.proposal,precheck:{status:"ready",observed_at:now.toISOString(),valid_until:null}}},{now}).field,"proposal.precheck");
assert.equal(normalizeEvent({...example,proposal:{...example.proposal,precheck:{status:"maybe",observed_at:now.toISOString(),valid_until:null}}},{now}).field,"proposal.precheck");
const one = normalizeEvent({...example,proposal:{...example.proposal,precheck:{status:"verifying",observed_at:now.toISOString(),valid_until:null}}},{now});
assert.equal(one.value.proposal.precheckStatus,"verifying");
const base={id:"x",source_system:"enger",status:"proposal_wait",matched_at:now.toISOString(),created_at:now.toISOString(),updated_at:now.toISOString()};
assert.equal(shapeProposal({...base,precheck_status:"verifying"},{now:now.toISOString()}).statusLabel,"双方確認中");
assert.equal(shapeProposal({...base,precheck_status:"ready",precheck_valid_until:"2026-11-06T12:00:00Z"},{now:now.toISOString()}).statusLabel,"正式提案待ち");
assert.notEqual(shapeProposal({...base,precheck_status:"ready",precheck_valid_until:"2026-10-01T00:00:00Z"},{now:now.toISOString()}).statusLabel,"正式提案待ち");
assert.equal(shapeProposal({...base,precheck_status:null},{now:now.toISOString()}).statusLabel,"事前確認未取得");
assert.equal(shapeProposal({...base,status:"call_wait",sent_at:now.toISOString(),precheck_status:"verifying"},{now:now.toISOString()}).statusLabel,"電話待ち");
console.log("PASS Sales precheck: verified two sides only, no formal proposal count on one-sided response");
