import assert from "node:assert/strict";
import { test } from "node:test";
import { jstDay, progressMetrics, shapeEngerProgress, validDay } from "../lib/sales-enger-progress.js";

test("Dates use JST and invalid calendar dates are rejected", () => {
  assert.equal(jstDay("2026-10-31T15:02:00Z"), "2026-11-01");
  assert.equal(validDay("2026-02-30"), false);
  assert.equal(validDay("2024-02-29"), true);
});

test("Cohort transition keeps missing and out-of-order dates out of the conversion numerator", () => {
  const proposal = (id, dates) => ({
    id, kind: "proposal", milestones: { sentOn: "2026-11-01", ...dates },
  });
  const rows = [
    proposal("a", { meetingOn: "2026-11-05", offerOn: "2026-11-09", wonOn: "2026-11-14" }),
    proposal("b", { meetingOn: "2026-11-06", offerOn: "2026-11-05", wonOn: "2026-11-17" }),
    proposal("c", { meetingOn: "2026-11-14" }),
    proposal("d", { sentOn: "2026-10-31", meetingOn: "2026-11-01" }),
    { id: "o", kind: "offer", milestones: { offerOn: "2026-11-05" } },
  ];
  const [sent, meetings, offers, won] = progressMetrics(rows, "2026-11-01", "2026-11-10", "2026-11-12");
  assert.deepEqual(sent.ids, ["a", "b", "c"]);
  assert.deepEqual(meetings.ids, ["a", "b"]);
  assert.deepEqual(meetings.pendingIds, ["c"]);
  assert.equal(meetings.rate, 66.7);
  assert.deepEqual(offers.pendingIds, ["b"]);
  assert.equal(offers.rate, 50);
  assert.deepEqual(won.ids, []);
});

test("Deal owners and deadlines drive the queue while source activities preserve factual dates", () => {
  const base = {
    kind: "proposal", source: { id: "a", sales_owner_id: "former", sent_at: "2026-11-05T00:00:00Z" },
    people: new Map([["former", "Former owner"]]), meetingAt: "2026-11-06T15:00:00Z",
    task: { title: "Call", due_at: "2026-11-09T15:00:00Z" }, today: "2026-11-11",
  };
  const unlinked = shapeEngerProgress(base);
  assert.equal(unlinked.issue, "overdue");
  assert.equal(unlinked.milestones.meetingOn, "2026-11-07");
  assert.equal(unlinked.stalledDays, 4);
  const linked = shapeEngerProgress({ ...base, deal: { id: "d", stage: "proposal", owner_id: null } });
  assert.equal(linked.ownerId, null);
  assert.equal(linked.nextAction, null);
  assert.equal(linked.issue, "missing");
  const lost = shapeEngerProgress({ ...base, deal: { id: "d", stage: "lost", lost_reason: "単価" } });
  assert.equal(lost.issue, null);
  assert.equal(lost.lossReason, "単価");
});
