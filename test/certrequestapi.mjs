// 退職証明書の本人申請（db/127・api/employees/cert-request.js・api/retiree/index.js・api/employees/retire-case.js）。
//
// ■ 何を守るか
//   [本人] 退職手続き中はマイページ（/api/employees/cert-request）、退職者は退職者ポータル（/api/retiree）から申請できる。
//          在籍中の人は申請できない。項目は1つ以上・決まったものだけ。誓約にチェックしないと申請できない。
//          誓約の文面・版・同意日時・接続元・ブラウザが残る。申請中は1件だけ。本人には接続元・ブラウザを返さない。
//   [管理側] 入退社の画面（retire-case）に申請（選んだ項目・誓約の日時・印字される本文）が出る。
//          承認して発行は経営者・管理者だけ（人事は 403）。選んだ項目だけを印字して発行・押印し、本人に公開する。
//          申請は発行済み（対応者・日時）、チェックリストの「退職証明書の交付」は完了（日時・対応者）になる。
//          値の無い項目があれば発行しない。差し戻すと、本人はもう一度申請できる。
import assert from "node:assert/strict";
import { db, logs, current, setup, api, stored, TODAY, LASTWEEK } from "./_retireharness.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { default: certApi } = await import(join(ROOT, "api/employees/cert-request.js"));
const { default: portal } = await import(join(ROOT, "api/retiree/index.js"));
const L = await import(join(ROOT, "lib/retire-cert-request.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
async function call(handler, { method = "GET", url, body, headers = {} }) {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  await handler({ method, url, headers: { authorization: "Bearer x", host: "gw.example.com", "x-forwarded-for": "203.0.113.9, 10.0.0.1", "user-agent": "TestBrowser/1.0", ...headers }, body }, r);
  return r;
}
const as = (who) => { current.userId = `u-${who}`; };
const self = (body) => call(certApi, { method: body ? "POST" : "GET", url: "/api/employees/cert-request", body });
const adm = (body) => call(certApi, { method: "POST", url: "/api/employees/cert-request", body });
const caseOf = (id) => call(api, { url: `/api/employees/retire-case?employeeId=${id}` });

function more() {
  setup();
  db.rows.gw_employees.push({ id: "e-own", tenant_id: "t1", user_id: "u-own", display_name: "経営 太郎", department: "経営", employment_type: "正社員", joined_on: "2020-04-01", status: "active", left_on: null });
  db.rows.gw_role_grants.push({ id: "g-own", tenant_id: "t1", employee_id: "e-own", role: "owner" });
  const soon = db.rows.gw_employees.find((e) => e.id === "e-soon");
  Object.assign(soon, { position: "主任", initial_role: "Webエンジニア" });
  db.rows.gw_retire_cert_requests = [];
  db.rows.tenants = [{ id: "t1", name: "株式会社テスト" }];
  db.rows.gw_retire_company = [{ tenant_id: "t1", representative: "代表 一郎", address: "東京都千代田区1-1" }];
  db.rows.gw_seals = [{ id: "s1", tenant_id: "t1", name: "証明書印", seal_type: "certificate", image_path: "seals/s1.png", image_mime: "image/png", image_sha256: null, is_active: true, sort_order: 1 }];
  db.rows.gw_contracts = [{ id: "k1", tenant_id: "t1", employee_id: "e-soon", wage_type: "月給", wage_amount: 300000, created_at: "2025-04-01T00:00:00Z" }];
  db.rows.gw_procedure_items.push({ id: "it-cert", procedure_id: "p-soon", item_key: "off_hr_cert", title: "退職証明書の交付", owner: "hr", status: "todo", sort_order: 3 });
}

console.log("\n=== 本人の申請 ===\n");

await ok("退職手続き中の本人：選べる項目（5つ）・誓約の文面を受け取る。まだ申請は無い", async () => {
  more(); as("soon");
  const r = await self();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.canRequest, true);
  assert.deepEqual(r.body.options.items.map((i) => i.key), ["period", "job", "position", "wage", "cause"]);
  assert.equal(r.body.options.ndaText, L.NDA_TEXT);
  assert.equal(r.body.request, null);
});

await ok("誓約にチェックしないと申請できない（400 nda_required）・項目が無いと 400・知らない項目は 400", async () => {
  more(); as("soon");
  assert.equal((await self({ action: "request", items: ["period"] })).body.error, "nda_required");
  assert.equal((await self({ action: "request", items: [], ndaAgreed: true })).body.error, "no_items");
  assert.equal((await self({ action: "request", items: ["salary_note"], ndaAgreed: true })).body.error, "invalid_item");
  assert.equal(db.rows.gw_retire_cert_requests.length, 0);
});

await ok("申請：選んだ項目（並びは証明書の順）・誓約の文面・版・日時・接続元・ブラウザが残る。本人には接続元を返さない", async () => {
  more(); as("soon");
  const r = await self({ action: "request", items: ["cause", "period", "period"], ndaAgreed: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.rows.gw_retire_cert_requests[0];
  assert.deepEqual(row.items, ["period", "cause"]);
  assert.equal(row.status, "requested");
  assert.equal(row.nda_text, L.NDA_TEXT); assert.equal(row.nda_version, L.NDA_VERSION); assert.ok(row.nda_agreed_at);
  assert.equal(row.nda_ip, "203.0.113.9"); assert.equal(row.nda_user_agent, "TestBrowser/1.0");
  assert.equal(row.employee_id, "e-soon"); assert.equal(row.requested_by, "u-soon");
  assert.ok(!JSON.stringify(r.body).includes("203.0.113.9"), "本人の応答に接続元を返さない");
  assert.ok(logs.some((l) => l.action === "retire.cert_request" && !JSON.stringify(l.detail).includes("203.0.113")), "記録に接続元を残さない");
  const again = await self();
  assert.equal(again.body.request.status, "requested");
  assert.deepEqual(again.body.request.items.map((i) => i.key), ["period", "cause"]);
});

await ok("在籍中の人は申請できない（409 not_leaving）", async () => {
  more(); as("member");
  const r = await self({ action: "request", items: ["period"], ndaAgreed: true });
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, "not_leaving");
});

await ok("退職者は退職者ポータルから申請できる（社員 ID はログイン中の本人）", async () => {
  more(); as("left");
  const g = await call(portal, { url: "/api/retiree" });
  assert.equal(g.statusCode, 200); assert.equal(g.body.certRequest.request, null);
  assert.equal(g.body.certRequest.options.items.length, 5);
  const r = await call(portal, { method: "POST", url: "/api/retiree", body: { action: "cert_request", items: ["wage"], ndaAgreed: true, employeeId: "e-soon" } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_retire_cert_requests[0].employee_id, "e-left", "渡された employeeId は使わない");
  const g2 = await call(portal, { url: "/api/retiree" });
  assert.equal(g2.body.certRequest.request.status, "requested");
});

await ok("表が無い（db/127 未適用）：ポータルは開き、申請の欄は null。マイページの申請は 503", async () => {
  more(); db.absent.add("gw_retire_cert_requests");
  as("left");
  const g = await call(portal, { url: "/api/retiree" });
  assert.equal(g.statusCode, 200); assert.equal(g.body.certRequest, null);
  as("soon");
  assert.equal((await self({ action: "request", items: ["period"], ndaAgreed: true })).statusCode, 503);
});

console.log("\n=== 管理側：入退社の画面に出る・承認して発行 ===\n");

await ok("入退社の画面（retire-case）に、申請・選んだ項目・誓約の日時と証跡・印字される本文が出る", async () => {
  more(); as("soon");
  await self({ action: "request", items: ["period", "job", "position", "wage", "cause"], ndaAgreed: true });
  as("hr");
  const r = await caseOf("e-soon");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const c = r.body.certRequest;
  assert.equal(c.status, "requested");
  assert.deepEqual(c.items.map((i) => i.key), ["period", "job", "position", "wage", "cause"]);
  assert.ok(c.nda.agreedAt && c.nda.text === L.NDA_TEXT && c.nda.ip === "203.0.113.9");
  assert.ok(c.preview.includes("使用期間：2025年4月1日から") && c.preview.includes("業務の種類：Webエンジニア") && c.preview.includes("その事業における地位：主任")
    && c.preview.includes("賃金：月給 300,000円") && c.preview.includes("退職の事由：自己都合"), c.preview);
  assert.deepEqual(c.missing, []);
  assert.equal(r.body.canIssueCert, false, "人事は発行できない（押印は経営者・管理者）");
  assert.equal(r.body.ready.cert, true);
});

await ok("人事は承認して発行できない（403 seal_forbidden）。何も発行しない", async () => {
  more(); as("soon");
  await self({ action: "request", items: ["period"], ndaAgreed: true });
  const reqId = db.rows.gw_retire_cert_requests[0].id;
  as("hr");
  const r = await adm({ action: "approve", employeeId: "e-soon", requestId: reqId });
  assert.equal(r.statusCode, 403); assert.equal(r.body.error, "seal_forbidden");
  assert.equal(db.rows.gw_retire_cert_requests[0].status, "requested");
});

await ok("経営者が承認して発行：選んだ項目だけを印字・押印して発行し、本人に公開。申請は発行済み、チェックリストは完了", async () => {
  more(); as("soon");
  await self({ action: "request", items: ["period", "cause"], ndaAgreed: true });
  const reqId = db.rows.gw_retire_cert_requests[0].id;
  as("own");
  const before = db.rows.gw_retire_docs.length;
  const r = await adm({ action: "approve", employeeId: "e-soon", requestId: reqId });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const docs = db.rows.gw_retire_docs.filter((d) => d.employee_id === "e-soon" && d.kind === "certificate");
  const issued = docs.find((d) => d.state === "issued");
  assert.equal(db.rows.gw_retire_docs.length, before + 1, "新しい版を足す");
  assert.ok(issued && issued.published === true && issued.published_by === "u-own", "本人に公開");
  assert.ok(/^RET-\d{4}-\d{4}$/.test(issued.issued_no));
  assert.ok(issued.body_snapshot.includes("使用期間：") && issued.body_snapshot.includes("退職の事由：自己都合"), issued.body_snapshot);
  assert.ok(!issued.body_snapshot.includes("賃金") && !issued.body_snapshot.includes("業務の種類") && !issued.body_snapshot.includes("地位"), "選ばなかった項目は印字しない（労働基準法22条）");
  assert.equal(issued.include_reason, true);
  assert.ok(stored.has(issued.storage_path), "PDF を保存");
  assert.ok(docs.some((d) => d.id === "d-cert" && d.state === "superseded"), "前の版は置き換え済み");
  const q = db.rows.gw_retire_cert_requests[0];
  assert.equal(q.status, "issued"); assert.equal(q.decided_by, "u-own"); assert.equal(q.decided_by_name, "経営 太郎"); assert.ok(q.decided_at); assert.equal(q.doc_id, issued.id);
  const item = db.rows.gw_procedure_items.find((i) => i.item_key === "off_hr_cert");
  assert.equal(item.status, "done"); assert.equal(item.completed_by, "u-own"); assert.ok(item.completed_at);
  assert.equal(r.body.checklist, 1);
  assert.ok(logs.some((l) => l.action === "retire.cert_approve") && logs.some((l) => l.action === "retire.reissue"));
  // もう一度押しても、2回は発行しない
  const twice = await adm({ action: "approve", employeeId: "e-soon", requestId: reqId });
  assert.equal(twice.statusCode, 409);
  // 発行のあと、本人はもう一度（別の項目で）申請できる
  as("soon");
  assert.equal((await self({ action: "request", items: ["wage"], ndaAgreed: true })).statusCode, 200);
});

await ok("値の無い項目があれば発行しない（400 missing_values。「（未登録）」を印字しない）", async () => {
  more();
  db.rows.gw_employees.find((e) => e.id === "e-soon").position = null;
  as("soon");
  await self({ action: "request", items: ["position"], ndaAgreed: true });
  as("own");
  const r = await adm({ action: "approve", employeeId: "e-soon", requestId: db.rows.gw_retire_cert_requests[0].id });
  assert.equal(r.statusCode, 400); assert.equal(r.body.error, "missing_values");
  assert.ok(r.body.hint.includes("役職"));
  assert.equal(db.rows.gw_retire_cert_requests[0].status, "requested");
});

console.log("\n=== 承認して発行：途中で失敗したら、チェックリストだけ完了にはしない ===\n");
async function approveWith(prepare) {
  more(); as("soon");
  await self({ action: "request", items: ["period"], ndaAgreed: true });
  const reqId = db.rows.gw_retire_cert_requests[0].id;
  prepare();
  as("own");
  const r = await adm({ action: "approve", employeeId: "e-soon", requestId: reqId });
  const item = db.rows.gw_procedure_items.find((i) => i.item_key === "off_hr_cert");
  return { r, req: db.rows.gw_retire_cert_requests[0], item };
}
await ok("PDF の保存（Storage）に失敗：申請は申請中・チェックリストは未完了", async () => {
  const { r, req, item } = await approveWith(() => { db.failUpload = true; });
  assert.ok(r.statusCode >= 500, String(r.statusCode));
  assert.equal(req.status, "requested"); assert.equal(item.status, "todo"); assert.ok(!item.completed_at);
});
await ok("本人への公開に失敗：申請は申請中・チェックリストは未完了", async () => {
  const { r, req, item } = await approveWith(() => {
    db.rows.gw_retire_docs = db.rows.gw_retire_docs.filter((d) => d.kind !== "certificate");   // 前の版の置き換え（更新）が無い形
    db.failUpdate.add("gw_retire_docs");
  });
  assert.ok(r.statusCode >= 500, String(r.statusCode));
  assert.equal(req.status, "requested"); assert.equal(item.status, "todo");
});
await ok("申請の更新（発行済み）に失敗：チェックリストは未完了", async () => {
  const { r, req, item } = await approveWith(() => { db.failUpdate.add("gw_retire_cert_requests"); });
  assert.ok(r.statusCode >= 500, String(r.statusCode));
  assert.equal(req.status, "requested"); assert.equal(item.status, "todo");
});
await ok("申請中でなくなった申請（差し戻し済み）を承認しようとしても：409・発行しない・チェックリストは変えない", async () => {
  more(); as("soon");
  await self({ action: "request", items: ["period"], ndaAgreed: true });
  const q = db.rows.gw_retire_cert_requests[0];
  Object.assign(q, { status: "cancelled", decided_at: new Date().toISOString() });
  const docs = db.rows.gw_retire_docs.length;
  as("own");
  const r = await adm({ action: "approve", employeeId: "e-soon", requestId: q.id });
  assert.equal(r.statusCode, 409);
  assert.equal(db.rows.gw_retire_docs.length, docs, "PDF を作らない");
  assert.equal(db.rows.gw_procedure_items.find((i) => i.item_key === "off_hr_cert").status, "todo");
});
await ok("順番：PDF 保存 → 本人に公開 → 申請を発行済み → チェックリスト完了（記録の時刻も）", async () => {
  const { r, req, item } = await approveWith(() => {});
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const doc = db.rows.gw_retire_docs.find((d) => d.id === req.doc_id);
  assert.ok(doc && stored.has(doc.storage_path) && doc.published === true, "保存・公開");
  assert.equal(req.status, "issued"); assert.equal(item.status, "done");
  assert.ok(doc.published_at <= req.decided_at && req.decided_at <= item.completed_at, "公開 → 申請 → チェックリストの順");
});

await ok("人事は差し戻せる → 本人はもう一度申請できる", async () => {
  more(); as("soon");
  await self({ action: "request", items: ["period"], ndaAgreed: true });
  as("hr");
  const r = await adm({ action: "return", employeeId: "e-soon", requestId: db.rows.gw_retire_cert_requests[0].id, note: "項目の確認" });
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows.gw_retire_cert_requests[0].status, "cancelled");
  as("soon");
  assert.equal((await self({ action: "request", items: ["period", "job"], ndaAgreed: true })).statusCode, 200);
});

await ok("一般メンバーは承認・差し戻しできない（403）。ほかの人の申請 ID では 404", async () => {
  more(); as("soon");
  await self({ action: "request", items: ["period"], ndaAgreed: true });
  const id = db.rows.gw_retire_cert_requests[0].id;
  as("member");
  assert.equal((await adm({ action: "return", employeeId: "e-soon", requestId: id })).statusCode, 403);
  as("own");
  assert.equal((await adm({ action: "approve", employeeId: "e-past", requestId: id })).statusCode, 404);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
