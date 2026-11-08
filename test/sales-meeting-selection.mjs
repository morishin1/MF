import test from "node:test";
import assert from "node:assert/strict";
import {parseMeetingSelection,matchMeetingSelection} from "../lib/sales-meeting-selection.js";
const T="dddddddd-0000-4000-8000-000000000001";
const J="eeeeeeee-0000-4000-8000-000000000001";
test("selection filters only listed candidate IDs",()=>{
 const selected=parseMeetingSelection("talent:"+T+",job:"+J);
 assert.equal(selected.keys.size,2);
 assert.equal(matchMeetingSelection({item_type:"talent",candidate_id:T},selected),true);
 assert.equal(matchMeetingSelection({item_type:"job",job_id:J},selected),true);
 assert.equal(matchMeetingSelection({item_type:"job",job_id:T},selected),false);
});
test("omitted selection retains legacy published shortlist but empty selection is rejected",()=>{
 assert.equal(parseMeetingSelection(null),null);
 assert.equal(matchMeetingSelection({item_type:"job",job_id:J},null),true);
 assert.equal(parseMeetingSelection("").error,"invalid_selection");
});
test("invalid, repeated and excessive selections are rejected",()=>{
 assert.equal(parseMeetingSelection("talent:not-uuid").error,"invalid_selection");
 assert.equal(parseMeetingSelection("talent:"+T+",talent:"+T).error,"duplicate_selection");
 assert.equal(parseMeetingSelection(new Array(11).fill("job:"+J).join(",")).error,"selection_limit");
 assert.equal(parseMeetingSelection("company:"+T).error,"invalid_selection");
});
