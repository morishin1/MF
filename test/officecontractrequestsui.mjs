// Office UI behavior with a minimal DOM and mocked APIs. No browser or live data.
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { REQUEST_STATUSES, CONTRACT_TYPES, STATUS_TRANSITIONS } from "../lib/sales-contract-requests.js";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const code = read("js/office-contract-requests.js"), html = read("office/contract-requests.html"), css = read("css/contract-requests.css"), home = read("office/index.html");
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sample = (id = 1, status = "requested") => ({ proposalId: uid(id), companyName: "テスト企業 " + id, title: "提案 " + id, talentInitials: "T.T.", sourceStage: "合格", accepted: true, acceptedEvidence: "ENGER", salesStatus: "meeting_done", archived: false, request: { id: uid(100 + id), proposalId: uid(id), contractType: "client_ses", status, requestedDueOn: "2026-11-01", plannedStartOn: null, note: "依頼メモ", assigneeId: uid(30), assigneeName: "Office担当", artifactReference: "社内共有／契約書／テスト企業", employeeId: null, docOrderId: null, siteContractId: null, version: 2, requestedAt: "2026-10-26T01:00:00Z", updatedAt: "2026-10-26T01:00:00Z", history: [] } });
const clone = (v) => JSON.parse(JSON.stringify(v));
const settle = () => new Promise((r) => setTimeout(r, 0));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function harness({ allowed = true, canLinkHrDocs = true, resultRows = [sample()], fail, detail, post } = {}) {
  const nodes = new Map(), named = new Map(), calls = [], focus = [];
  const decode = (s) => String(s || "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  let doc;
  class Node {
    constructor(id = "", attrs = {}) { this.id = id; this.attrs = attrs; this.handlers = {}; this.dataset = {}; this.value = ""; this.checked = false; this.disabled = false; this.hidden = false; this.open = false; this.isConnected = true; this._html = ""; this.textContent = ""; }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    setAttribute(k, v) { this.attrs[k] = v; }
    hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
    closest() { return this; }
    focus() { doc.activeElement = this; focus.push(this.id); }
    showModal() { this.open = true; }
    close() { this.open = false; for (const f of this.handlers.close || []) f({}); }
    reportValidity() { return true; }
    append(...kids) { this.kids = [...(this.kids || []), ...kids]; }
    querySelectorAll() { return [...new Set([...named.values(), ...nodes.values()].filter((n) => n.id.startsWith("ocq-") && !["ocq-close", "ocq-dialog"].includes(n.id)))]; }
    querySelector(selector) { return named.get(selector.match(/name="([^"]+)"/)?.[1]); }
    set innerHTML(value) {
      this._html = value;
      if (this.id !== "ocq-detail") return;
      named.clear();
      for (const m of value.matchAll(/<(input|select|textarea|form|fieldset|div|button)[^>]*>/g)) {
        const tag = m[0], attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])]));
        const id = attrs.id || "anonymous-" + m.index;
        const node = new Node(id, attrs); node.disabled = /\sdisabled(?:\s|>)/.test(tag); node.hidden = /\shidden(?:\s|>)/.test(tag);
        node.value = attrs.value || "";
        if (m[1] === "textarea") node.value = decode(value.slice(m.index + tag.length).split("</textarea>")[0]);
        if (m[1] === "select") {
          const content = value.slice(m.index + tag.length).split("</select>")[0];
          const opts = [...content.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
          node.value = decode((opts.find((o) => o[2].includes("selected")) || opts[0] || [])[1]);
        }
        if (attrs.id) nodes.set(id, node);
        if (attrs.name) named.set(attrs.name, node);
      }
    }
    get innerHTML() { return this._html; }
  }
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], new Node(match[1]));
  doc = { activeElement: new Node("opener"), getElementById: (id) => nodes.get(id), createElement: () => new Node() };
  const envelope = (rs) => ({ ready: true, canEditOffice: true, canLinkHrDocs, rows: clone(rs), members: [{ id: uid(30), name: "Office担当" }], truncated: false });
  const context = { window: {}, document: doc, URLSearchParams, location: { search: "" }, Date, console,
    FormData: class { get(k) { return named.get(k)?.value; } },
    OfficeLayout: { init: async () => allowed ? { me: {} } : null },
    API: { api: async (url, options) => {
      calls.push({ url, options });
      if (fail) throw Object.assign(new Error("failed"), fail);
      if (options?.method === "POST") {
        if (post) return post(options.body, envelope);
        const r = clone(resultRows.find((r) => r.proposalId === options.body.proposalId));
        Object.assign(r.request, options.body, { version: r.request.version + 1 });
        return { ok: true, ...envelope([r]) };
      }
      if (url.includes("?")) {
        const id = new URLSearchParams(url.split("?")[1]).get("proposalId");
        return detail ? detail(id, envelope) : envelope(resultRows.filter((r) => r.proposalId === id));
      }
      return envelope(resultRows);
    } } };
  vm.runInNewContext(code, context);
  await settle();
  const fire = async (id, type, extra = {}) => { const node = nodes.get(id); for (const fn of node.handlers[type] || []) fn({ target: node, preventDefault() {}, ...extra }); await settle(); };
  const button = (data) => Object.assign(new Node(), { dataset: data });
  const open = async (id = uid(1)) => fire("ocq-list", "click", { target: button({ open: id }) });
  const click = async (data) => fire("ocq-detail", "click", { target: button(data) });
  return { nodes, named, calls, focus, fire, open, click, button, context, envelope };
}
let checks = 0;
const check = (value, why) => { assert.ok(value, why); checks++; };
const h = await harness({ resultRows: [sample(1), sample(2, "review")] });
check(h.nodes.get("ocq-count").textContent === "すべて：2件", "list/card same set");
h.nodes.get("ocq-search").value = "企業 2"; await h.fire("ocq-search", "input");
check(h.nodes.get("ocq-count").textContent === "すべて：1件" && !h.nodes.get("ocq-list").innerHTML.includes("提案 1"), "search filters cards/list");
await h.open(); check(h.nodes.get("ocq-dialog").open && h.nodes.get("ocq-detail-title").textContent.includes("テスト企業"), "detail uses fresh GET");
check(h.nodes.get("ocq-detail").innerHTML.includes("既存の契約・書類") && h.nodes.get("ocq-detail").innerHTML.includes("送付・署名・契約締結"), "existing reference and drafting boundary clear");
h.named.get("reason").value = ""; await h.fire("ocq-form", "submit");
check(!h.calls.some((c) => c.options?.method === "POST"), "reason blocks writes");
h.named.get("reason").value = "内容を確認しました"; h.named.get("status").value = "in_progress"; await h.fire("ocq-form", "submit");
const saved = h.calls.find((c) => c.options?.method === "POST");
check(saved.options.body.expectedVersion === 2 && saved.options.body.status === "in_progress", "save optimistic version");
check(h.nodes.get("ocq-save-message").textContent.includes("送付・署名・契約締結の操作は行っていません"), "save not signing");
const no = await harness({ allowed: false }); check(no.calls.length === 0, "Office permission gate before API");
const sql = await harness({ fail: { code: "not_ready", hint: "SQL未設定" } });
sql.nodes.get("ocq-search").value = "x"; await sql.fire("ocq-search", "input");
check(sql.nodes.get("ocq-count").textContent === "未取得" && sql.nodes.get("ocq-cards").innerHTML === "", "SQL unavailable never fake zero after filter");
const xssrow = sample(); xssrow.companyName = '<img src=x onerror="alert(1)">'; xssrow.request.note = "<script>bad()</script>";
const xss = await harness({ resultRows: [xssrow] }); await xss.open();
check(!xss.nodes.get("ocq-list").innerHTML.includes("<img") && !xss.nodes.get("ocq-detail").innerHTML.includes("<script>"), "external text escaped");
check(xss.nodes.get("ocq-detail-title").textContent === xssrow.companyName, "title set as text");
const finish = await harness({ resultRows: [sample(1, "review")] }); await finish.open();
finish.named.get("status").value = "completed"; finish.named.get("reason").value = "契約書を確認しました"; await finish.fire("ocq-form", "submit");
check(!finish.calls.some((c) => c.options), "completion requires confirmation");
finish.nodes.get("ocq-completion-check").checked = true; await finish.fire("ocq-form", "submit");
check(finish.calls.filter((c) => c.options).length === 1, "explicit drafting completion posts once");
const held = deferred(); const repeat = await harness({ post: () => held.promise }); await repeat.open();
repeat.named.get("reason").value = "担当確認済み"; await repeat.fire("ocq-form", "submit"); await repeat.fire("ocq-form", "submit");
check(repeat.calls.filter((c) => c.options).length === 1 && repeat.nodes.get("ocq-close").disabled, "inflight repeated clicks and close blocked");
held.resolve({ ok: true, ...repeat.envelope([sample()]) }); await settle(); await settle();
const conflict = await harness({ post: async () => { throw { status: 409 }; } }); await conflict.open(); conflict.named.get("reason").value = "担当確認済み"; await conflict.fire("ocq-form", "submit"); await conflict.fire("ocq-form", "submit");
check(conflict.calls.filter((c) => c.options).length === 1 && conflict.nodes.get("ocq-save-message").textContent.includes("自動では再実行しません"), "conflict requires explicit refresh no retry");
const unconfirmed = await harness({ post: async () => { throw { status: 503, code: "outcome_unconfirmed", hint: "保存された可能性があるため再送せず、読み直してください" }; } }); await unconfirmed.open();
unconfirmed.named.get("reason").value = "内容を確認済み"; await unconfirmed.fire("ocq-form", "submit"); await unconfirmed.fire("ocq-form", "submit");
check(unconfirmed.calls.filter((c) => c.options).length === 1 && unconfirmed.nodes.get("ocq-save-message").textContent.includes("保存された可能性"), "unconfirmed action locks reposts and preserves uncertainty");
const beforeUnconfirmedRefresh = unconfirmed.calls.length; await unconfirmed.click({ reload: uid(1) });
check(unconfirmed.calls.length === beforeUnconfirmedRefresh + 1 && !unconfirmed.calls.at(-1).options, "unconfirmed refresh uses GET only");
const protectedRow = sample(); Object.assign(protectedRow.request, { docOrderId: null, hasDocOrder: true, employeeId: uid(40), siteContractId: uid(41) });
const protectedUi = await harness({ canLinkHrDocs: false, resultRows: [protectedRow] }); await protectedUi.open();
check(!protectedUi.named.has("docOrderId") && protectedUi.named.get("employeeId").disabled, "non-HR protected linkage not editable");
check(protectedUi.nodes.get("ocq-detail").innerHTML.includes("紐付けあり（詳細・変更にはHR権限が必要です）"), "hidden existing doc distinguished from absent");
protectedUi.named.get("reason").value = "進捗を確認済み"; await protectedUi.fire("ocq-form", "submit");
const protectedBody = protectedUi.calls.find((c) => c.options)?.options.body;
check(protectedBody && !Object.hasOwn(protectedBody, "docOrderId") && !Object.hasOwn(protectedBody, "employeeId") && protectedBody.siteContractId === uid(41), "ordinary update never clears hidden HR relation or employee");
const refreshFail = await harness({ post: async () => ({ ok: true, ready: false, refreshFailed: true, hint: "保存済み。再読込してください。" }) }); await refreshFail.open();
refreshFail.named.get("reason").value = "内容を確認済み"; await refreshFail.fire("ocq-form", "submit"); await refreshFail.fire("ocq-form", "submit");
check(refreshFail.calls.filter((c) => c.options).length === 1 && refreshFail.nodes.get("ocq-save-message").textContent.includes("保存済み"), "saved-refresh-failed locks writes and reports success uncertainty");
const negativeRow = sample(); negativeRow.sourceStage = "不合格";
const negative = await harness({ resultRows: [negativeRow] }); await negative.open();
check(negative.nodes.get("ocq-detail").innerHTML.includes("現在ステージが変わっています") && negative.nodes.get("ocq-detail").innerHTML.includes("不合格"), "historical acceptance does not hide current negative stage");
const canceled = await harness(); await canceled.open(); await canceled.click({ action: "cancel" });
check(!canceled.calls.some((c) => c.options), "cancel opening confirmation no write");
canceled.named.get("reason").value = "先方辞退のため"; await canceled.click({ confirm: "cancel" });
check(canceled.calls.find((c) => c.options)?.options.body.action === "cancel", "cancel requires explicit confirmation");
const late = deferred(); const newer = await harness({ resultRows: [sample(1), sample(2)], detail: (id, env) => id === uid(1) ? late.promise : env([sample(2)]) });
await newer.open(uid(1)); await newer.open(uid(2)); late.resolve(newer.envelope([sample(1)])); await settle();
check(newer.nodes.get("ocq-detail-title").textContent === "テスト企業 2", "stale detail never overwrites newer selection");
for (const { key, label } of REQUEST_STATUSES) check(code.includes(`${key}: "${label}"`), "status labels match backend " + key);
for (const { key } of CONTRACT_TYPES) check(code.includes(key + ":"), "type enum matches backend " + key);
check(code.includes('review: ["review", "in_progress", "completed"]') && STATUS_TRANSITIONS.review.join() === "review,in_progress,completed", "review transition matches backend");
check(!/\/api\/sign\/|API\.(?:sign|createSiteContract)|fetch\(/.test(code), "UI cannot send signature or create contract");
check(code.includes('artifactReference') && !/href="\$\{(?:esc\()?req\.artifactReference/.test(code), "artifact reference not made link");
check(html.includes('<dialog') && code.includes('addEventListener("cancel"') && code.includes('returnFocus.focus()'), "native dialog Escape and focus restore");
check(home.includes('id="office-contract-queue-entry" hidden') && home.includes('el("office-contract-queue-entry").hidden = !can.app'), "Office entry permission parity");
check(css.includes('@media(max-width:480px)') && css.includes('grid-template-columns:1fr'), "mobile style exists; visual browser not asserted");
console.log(`${checks} Office contract-request UI model/static checks passed (no browser / no live API)`);
