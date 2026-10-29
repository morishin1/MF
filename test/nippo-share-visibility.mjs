// Synthetic share-persistence tests. No real auth, AI, database, mail or browser.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { createMemDb } from "./_memdb.mjs";

let summaries = 0, summaryHook = null, summaryOk = true;
mock.module(new URL("../lib/nippo-share.js", import.meta.url).href, { namedExports: {
  summarizeForShare: async () => {
    summaries++;
    if (summaryHook) await summaryHook();
    return summaryOk ? { ok: true, model: "synthetic-model", result: {
      did: "共有する作業", result: "共有する成果", learn: "共有する学び", tomorrow: "共有する予定",
    } } : { ok: false };
  },
} });
const { buildShare, ensureShare } = await import("../api/nippo/evaluate.js");
const ctx = { tenantId: "synthetic-tenant" };
const nippo = { id: "synthetic-report", user_id: "synthetic-author", user_name: "合成本人", work_date: "2026-10-28" };
const existing = (over = {}) => ({ id: "synthetic-share", tenant_id: ctx.tenantId,
  nippo_id: nippo.id, user_id: nippo.user_id, work_date: nippo.work_date,
  visible: true, did: "以前の共有内容", ...over });

function fixture(shares = []) {
  summaries = 0; summaryHook = null; summaryOk = true;
  const db = createMemDb({ schema: { gw_nippo_shares: { unique: [["nippo_id"]] } } });
  db.rows.gw_nippo_shares = structuredClone(shares);
  const base = db.admin(), writes = [];
  const state = { readError: null, readThrows: false, writeError: null, beforeWrite: null };
  const sb = { from(table) {
    assert.equal(table, "gw_nippo_shares", "persistence must not search unshared originals or other sources");
    const q = base.from(table); let op = "select";
    for (const method of ["insert", "update", "upsert", "delete"]) {
      const original = q[method];
      q[method] = (...args) => { op = method; writes.push({ op, payload: structuredClone(args[0]) }); return original(...args); };
    }
    const then = q.then;
    q.then = (resolve, reject) => Promise.resolve().then(() => {
      if (op === "select" && state.readThrows) throw new Error("synthetic read failure");
      if (op === "select" && state.readError) return { data: null, error: state.readError };
      if (op !== "select" && state.beforeWrite) state.beforeWrite();
      if (op !== "select" && state.writeError) return { data: null, error: state.writeError };
      return new Promise((ok, no) => then(ok, no));
    }).then(resolve, reject);
    return q;
  } };
  return { db, sb, state, writes };
}

let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); console.log("ok", name); pass++; }
  catch (e) { console.error("NG", name, e); fail++; } }

await test("visibility read errors never create or overwrite a share", async () => {
  for (const reader of [buildShare, ensureShare]) for (const rows of [[], [existing({ visible: false })]]) {
    const h = fixture(rows); h.state.readError = { code: "42501" };
    assert.equal(await reader(h.sb, ctx, nippo), false);
    assert.equal(summaries, 0); assert.deepEqual(h.writes, []);
    assert.deepEqual(h.db.rows.gw_nippo_shares, rows);
  }
});
await test("thrown read errors fail closed without AI or writes", async () => {
  for (const reader of [buildShare, ensureShare]) {
    const h = fixture([existing({ visible: false })]); h.state.readThrows = true;
    assert.equal(await reader(h.sb, ctx, nippo), false);
    assert.equal(summaries, 0); assert.deepEqual(h.writes, []);
  }
});
await test("intentional hidden shares stay untouched, including forced rebuild", async () => {
  const row = existing({ visible: false }), h = fixture([row]);
  assert.equal(await buildShare(h.sb, ctx, nippo), true);
  assert.equal(await ensureShare(h.sb, ctx, nippo), true);
  assert.equal(summaries, 0); assert.deepEqual(h.writes, []);
  assert.deepEqual(h.db.rows.gw_nippo_shares, [row]);
});
await test("existing identity and boolean visibility must match before work", async () => {
  for (const change of [{ tenant_id: "other" }, { user_id: "other" }, { work_date: "2026-10-27" }, { visible: null }]) {
    for (const reader of [buildShare, ensureShare]) {
      const row = existing(change), h = fixture([row]);
      assert.equal(await reader(h.sb, ctx, nippo), false);
      assert.equal(summaries, 0); assert.deepEqual(h.writes, []);
      assert.deepEqual(h.db.rows.gw_nippo_shares, [row]);
    }
  }
});
await test("visible existing share updates only summary, never identity or visibility", async () => {
  const h = fixture([existing()]);
  assert.equal(await buildShare(h.sb, ctx, nippo), true);
  assert.equal(summaries, 1); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].op, "update");
  assert.deepEqual(Object.keys(h.writes[0].payload).sort(), ["did", "learn", "model", "result", "tomorrow", "updated_at"]);
  assert.equal(h.db.rows.gw_nippo_shares[0].visible, true);
  assert.equal(h.db.rows.gw_nippo_shares[0].did, "共有する作業");
});
await test("hide during AI generation is not overwritten or treated as a successful refresh", async () => {
  const h = fixture([existing()]);
  summaryHook = () => { h.db.rows.gw_nippo_shares[0].visible = false; };
  assert.equal(await buildShare(h.sb, ctx, nippo), false);
  assert.equal(h.db.rows.gw_nippo_shares[0].visible, false);
  assert.equal(h.db.rows.gw_nippo_shares[0].did, "以前の共有内容");
  assert.ok(h.writes.every(w => w.op === "update" && !Object.hasOwn(w.payload, "visible")));
});
await test("write predicate rechecks ID, tenant, report, author, date and visibility", async () => {
  for (const change of [{ id: "other" }, { tenant_id: "other" }, { nippo_id: "other" },
    { user_id: "other" }, { work_date: "2026-10-27" }, { visible: false }]) {
    const h = fixture([existing()]);
    h.state.beforeWrite = () => Object.assign(h.db.rows.gw_nippo_shares[0], change);
    assert.equal(await buildShare(h.sb, ctx, nippo), false);
    assert.equal(h.db.rows.gw_nippo_shares[0].did, "以前の共有内容");
    assert.equal(h.writes.length, 1); assert.equal(h.writes[0].op, "update");
  }
});
await test("concurrent hidden creator wins; insert conflict never becomes upsert", async () => {
  const h = fixture(), hidden = existing({ visible: false });
  summaryHook = () => h.db.rows.gw_nippo_shares.push(structuredClone(hidden));
  assert.equal(await buildShare(h.sb, ctx, nippo), false);
  assert.deepEqual(h.db.rows.gw_nippo_shares, [hidden]);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].op, "insert");
});
await test("deleted existing share is not recreated by a delayed summary", async () => {
  const h = fixture([existing()]); summaryHook = () => { h.db.rows.gw_nippo_shares = []; };
  assert.equal(await buildShare(h.sb, ctx, nippo), false);
  assert.deepEqual(h.db.rows.gw_nippo_shares, []);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].op, "update");
});
await test("existing authorized missing-share path inserts only after complete summary", async () => {
  const h = fixture(); summaryHook = () => assert.deepEqual(h.db.rows.gw_nippo_shares, []);
  assert.equal(await ensureShare(h.sb, ctx, nippo), true);
  assert.equal(summaries, 1); assert.equal(h.writes.length, 1); assert.equal(h.writes[0].op, "insert");
  const row = h.db.rows.gw_nippo_shares[0];
  assert.equal(row.visible, true); assert.equal(row.did, "共有する作業");
  assert.equal(row.tenant_id, ctx.tenantId); assert.equal(row.nippo_id, nippo.id);
  assert.equal(row.user_id, nippo.user_id); assert.equal(row.work_date, nippo.work_date);
});
await test("AI failure creates no placeholder; write failure does not claim success", async () => {
  const h = fixture(); summaryOk = false;
  assert.equal(await buildShare(h.sb, ctx, nippo), false); assert.deepEqual(h.writes, []);
  assert.deepEqual(h.db.rows.gw_nippo_shares, []);
  const j = fixture([existing()]); j.state.writeError = { code: "42501" };
  assert.equal(await buildShare(j.sb, ctx, nippo), false);
  assert.equal(j.db.rows.gw_nippo_shares[0].did, "以前の共有内容");
});

mock.reset();
console.log(`${pass} passed, ${fail} failed`); if (fail) process.exit(1);
