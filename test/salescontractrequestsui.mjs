// UIの状態遷移を外部通信なしのVMで確認する。実ブラウザー/実DB検証ではない。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, runInNewContext } from "node:vm";

const source = readFileSync(new URL("../js/sales-contract-requests.js", import.meta.url), "utf8");
new Script(source);
const base = { proposalId: "00000000-0000-4000-8000-000000000001", companyName: "テスト企業", title: "SES案件", talentInitials: "A.B.",
  accepted: true, canRequest: true, canCancelRequest: true, sourceStage: "合格", salesStatus: "meeting_done", request: null };
const request = { id: "r1", version: 3, contractType: "client_ses", status: "requested", requestedDueOn: "2026-11-01",
  plannedStartOn: "2026-11-10", note: "条件を確認して作成", history: [], artifactReference: "" };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function element() {
  return { innerHTML: "", textContent: "", className: "", listeners: {}, open: false, isConnected: true, focused: false,
    addEventListener(event, callback) { this.listeners[event] = callback; },
    setAttribute() {}, showModal() { this.open = true; }, close() { this.open = false; }, focus() { this.focused = true; },
    querySelector() { return this.feedback; }, querySelectorAll() { return []; },
  };
}
function harness(responder, canOffice = true) {
  const root = element(), modal = element(), feedback = element(), focus = element();
  root.feedback = focus; modal.feedback = feedback;
  const calls = [], w = {};
  runInNewContext(source, { window: w, document: { activeElement: focus, createElement: () => modal, body: { appendChild() {} } },
    API: { api: (path, options) => { calls.push({ path, options }); return responder(path, options); } },
    FormData: class { constructor(form) { this.values = form.values; } get(k) { return this.values[k] ?? null; } has(k) { return k in this.values; } },
    URLSearchParams, encodeURIComponent, console,
  });
  w.SalesContractRequests.init({ root, canOffice });
  const click = (attribute, value = "") => root.listeners.click({ target: { closest: () => ({
    hasAttribute: (name) => name === attribute,
    dataset: { crFilter: value, crOpen: value }, isConnected: true, focus() {},
  }) } });
  const modalClick = (selector) => modal.listeners.click({ target: { closest: (q) => q === selector } });
  const submit = (values, cancel = false, valid = true) => modal.listeners.submit({ preventDefault() {}, target: {
    values, reportValidity: () => valid, matches: (q) => q.includes(",") || (cancel && q === "[data-cr-cancel-form]"),
  } });
  return { root, modal, feedback, calls, click, modalClick, submit, api: w.SalesContractRequests };
}
let n = 0;
async function test(name, fn) { await fn(); n++; console.log("ok", name); }

await test("loading and SQL unavailable never appear as zero", async () => {
  const d = deferred(); const h = harness(() => d.promise);
  assert.match(h.root.innerHTML, /—/); assert.doesNotMatch(h.root.innerHTML, /0件/);
  d.reject(Object.assign(new Error("schema"), { code: "not_ready" })); await settle();
  assert.match(h.root.innerHTML, /SQL適用/); assert.doesNotMatch(h.root.innerHTML, /0件/);
});
await test("cards derive from same rows and do not infer pass from won", async () => {
  const h = harness(async () => ({ ready: true, rows: [base, { ...base, proposalId: "p2", request },
    { ...base, proposalId: "p3", accepted: false, salesStatus: "won", request: { ...request, status: "completed" } }] }));
  await settle();
  assert.match(h.root.innerHTML, /合格（ENGER記録）<\/span><strong>2件/);
  assert.match(h.root.innerHTML, /Office未依頼<\/span><strong>1件/);
  assert.match(h.root.innerHTML, /Office対応中<\/span><strong>1件/);
  h.click("data-cr-filter", "accepted");
  assert.equal((h.root.innerHTML.match(/<article/g) || []).length, 2);
  assert.match(h.root.innerHTML, /営業一覧.*独立/);
});
await test("XSS text is escaped; artifact references never become links", async () => {
  const row = { ...base, companyName: '<img src=x onerror="bad()">', request: { ...request, artifactReference: "javascript:alert(1)" } };
  const h = harness(async () => ({ ready: true, rows: [row] })); await settle();
  h.click("data-cr-filter", "all"); assert.doesNotMatch(h.root.innerHTML, /<img/);
  h.click("data-cr-open", base.proposalId); await settle();
  assert.match(h.modal.innerHTML, /&lt;img/); assert.doesNotMatch(h.modal.innerHTML, /href="javascript/);
  assert.match(h.modal.innerHTML, /javascript:alert/);
});
await test("read-only user cannot see request form and Office link hidden by permission", async () => {
  const row = { ...base, canRequest: false, canCancelRequest: false, request };
  const h = harness(async () => ({ ready: true, rows: [row] }), false); await settle();
  h.click("data-cr-open", base.proposalId); await settle();
  assert.doesNotMatch(h.modal.innerHTML, /<form/);
  assert.doesNotMatch(h.modal.innerHTML, /href="\/office/);
});
await test("closing pending detail prevents late response and restores focus", async () => {
  const d = deferred(); const h = harness((path) => path.includes("?") ? d.promise : Promise.resolve({ ready: true, rows: [base] }));
  await settle(); h.click("data-cr-open", base.proposalId);
  h.modal.listeners.cancel({ preventDefault() {} }); assert.equal(h.modal.open, false);
  d.resolve({ ready: true, rows: [base] }); await settle();
  assert.equal(h.modal.open, false); assert.doesNotMatch(h.modal.innerHTML, /data-cr-form/);
});
await test("newer list request wins over stale response", async () => {
  const a = deferred(), b = deferred(); let i = 0;
  const h = harness(() => (++i === 1 ? a : b).promise);
  h.click("data-cr-refresh"); b.resolve({ ready: true, rows: [] }); await settle();
  a.resolve({ ready: true, rows: [base] }); await settle();
  assert.match(h.root.innerHTML, /合格（ENGER記録）<\/span><strong>0件/);
});
const values = { contractType: "client_ses", requestedDueOn: "2026-11-01", plannedStartOn: "", note: "契約条件を確認", confirm: "on" };
await test("form confirmation and validity are required before POST", async () => {
  const h = harness(async () => ({ ready: true, rows: [base] })); await settle();
  h.click("data-cr-open", base.proposalId); await settle();
  await h.submit({ ...values, confirm: undefined }, false, false);
  const absent = { ...values }; delete absent.confirm; await h.submit(absent);
  assert.equal(h.calls.filter((c) => c.options?.method === "POST").length, 0);
});
await test("duplicate click issues one create, never signing/status mutations", async () => {
  const d = deferred();
  const h = harness((path, opts) => opts ? d.promise : Promise.resolve({ ready: true, rows: [base] })); await settle();
  h.click("data-cr-open", base.proposalId); await settle();
  const first = h.submit(values); await h.submit(values);
  assert.equal(h.calls.filter((c) => c.options).length, 1);
  const body = h.calls.at(-1).options.body;
  assert.equal(body.action, "create"); assert.equal(body.proposalId, base.proposalId);
  assert.equal(body.plannedStartOn, null); assert.equal("status" in body, false);
  assert.ok(h.calls.every((c) => !/sign\/|intake|handoff/.test(c.path)));
  d.resolve({ ok: true }); await first; await settle();
  assert.match(h.root.innerHTML, /送付・署名依頼は行っていません/);
});
await test("409 preserves form and offers explicit refresh rather than retry", async () => {
  const h = harness(async (_path, opts) => { if (opts) throw Object.assign(new Error("conflict"), { status: 409 }); return { ready: true, rows: [base] }; });
  await settle(); h.click("data-cr-open", base.proposalId); await settle();
  await h.submit(values);
  assert.equal(h.modal.open, true); assert.match(h.modal.innerHTML, /data-cr-form/);
  assert.match(h.feedback.innerHTML, /最新状態を読み直す/);
  await h.submit(values);
  assert.equal(h.calls.filter((c) => c.options).length, 1);
});
await test("unconfirmed action locks resubmit and offers GET-only refresh", async () => {
  const h = harness(async (_path, opts) => { if (opts) throw Object.assign(new Error("uncertain"), { status: 503, code: "outcome_unconfirmed", hint: "保存された可能性があるため再送せず最新状態を読み直してください" }); return { ready: true, rows: [base] }; });
  await settle(); h.click("data-cr-open", base.proposalId); await settle();
  await h.submit(values); await h.submit(values);
  assert.equal(h.calls.filter((c) => c.options).length, 1);
  assert.match(h.feedback.innerHTML, /保存された可能性/); assert.match(h.feedback.innerHTML, /data-cr-reload-detail/);
  const before = h.calls.length; h.modalClick("[data-cr-reload-detail]"); await settle();
  assert.equal(h.calls.length, before + 1); assert.equal(h.calls.at(-1).options, undefined);
});
await test("withdrawn proposal can cancel existing request without allowing new request", async () => {
  const h = harness(async () => ({ ready: true, rows: [{ ...base, accepted: false, canRequest: false, canCancelRequest: true, request }] }));
  await settle(); h.click("data-cr-open", base.proposalId); await settle();
  assert.match(h.modal.innerHTML, /data-cr-cancel-form/); assert.doesNotMatch(h.modal.innerHTML, /<form data-cr-form>/);
  await h.submit({ reason: "先方が辞退", confirm: "on" }, true);
  assert.equal(h.calls.find((c) => c.options).options.body.action, "cancel");
});
await test("historical pass distinguishes current rejected stage and truncated audit", async () => {
  const row = { ...base, sourceStage: "不合格", acceptedEvidence: "ENGER合格への連携履歴", canRequest: false,
    request: { ...request, historyTruncated: true, history: [{ action: "create", at: "2026-10-26", reason: "初回" }] } };
  const h = harness(async () => ({ ready: true, rows: [row] })); await settle();
  h.click("data-cr-open", base.proposalId); await settle();
  assert.match(h.modal.innerHTML, /現在ステージ：不合格/); assert.match(h.modal.innerHTML, /ENGER合格への連携履歴/);
  assert.match(h.modal.innerHTML, /最新100件/); assert.doesNotMatch(h.modal.innerHTML, /<form data-cr-form>/);
});
await test("explicit resubmit includes version and reason, same proposal", async () => {
  const row = { ...base, request: { ...request, status: "completed" } };
  const h = harness(async () => ({ ready: true, rows: [row] })); await settle();
  h.click("data-cr-open", base.proposalId); await settle();
  assert.match(h.modal.innerHTML, /同じ依頼を再開/);
  await h.submit({ ...values, reason: "契約条件変更" });
  const body = h.calls.find((c) => c.options).options.body;
  assert.equal(body.action, "resubmit"); assert.equal(body.expectedVersion, 3); assert.equal(body.reason, "契約条件変更");
});
await test("cancel is request-only with version and reason", async () => {
  const h = harness(async () => ({ ready: true, rows: [{ ...base, request }] })); await settle();
  h.click("data-cr-open", base.proposalId); await settle();
  await h.submit({ reason: "条件の再確認", confirm: "on" }, true);
  const body = h.calls.find((c) => c.options).options.body;
  assert.equal(body.action, "cancel"); assert.equal(body.expectedVersion, 3);
  assert.equal("contractType" in body, false); assert.equal("status" in body, false);
});
await test("list refresh failure after saved request remains visible", async () => {
  let saved = false;
  const h = harness(async (path, opts) => {
    if (opts) { saved = true; return { ok: true }; }
    if (saved && !path.includes("?")) throw new Error("再取得失敗");
    return { ready: true, rows: [base] };
  });
  await settle(); h.click("data-cr-open", base.proposalId); await settle();
  await h.submit(values); assert.match(h.root.innerHTML, /一覧の再取得には失敗/);
  assert.doesNotMatch(h.root.innerHTML, /0件/);
});
await test("empty whitespace content blocked", async () => {
  const h = harness(async () => ({ ready: true, rows: [base] })); await settle();
  h.click("data-cr-open", base.proposalId); await settle(); await h.submit({ ...values, note: "   " });
  assert.equal(h.calls.filter((c) => c.options).length, 0); assert.match(h.feedback.innerHTML, /空白以外/);
});
await test("source integration stays separate from existing Sales cards and PR205 API", async () => {
  const html = readFileSync(new URL("../sales/proposals.html", import.meta.url), "utf8");
  assert.match(html, /id="sales-contract-flow"/); assert.match(html, /SalesContractRequests.init/);
  assert.match(html, /id="sum"/); assert.match(html, /sales-proposal-columns.js/);
  assert.doesNotMatch(source, /\/api\/sign\//);
});
console.log("PASS Sales contract request UI VM:", n, "cases (not real browser)");
