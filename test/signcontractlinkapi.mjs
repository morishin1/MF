// 契約と締結済み書面の明示的な関連（099_sign_contract_link.sql）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//   1. gw_contracts → gw_doc_orders.contract_id → gw_sign_requests.contract_id が
//      1本のチェーンとしてそのまま引き継がれる（api/sign/orders.js の create→approve）
//   2. api/sign/index.js の直接送信ルート（send）でも、1名あてなら contractId を保存できる
//   3. 他人（他の社員）の contractId は、どちらのルートからも渡せない（tenant/employee検証）
//   4. contractId を複数名あてに渡すと断る（1つの契約は1名にしか紐づかない）
//   5. contract_id=null の古いデータは、lib/career.js の既存fallbackで今までどおり表示できる
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の DB ----------------------------------------------------------------
const db = { rows: {} };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const copy = (r) => (r ? { ...r } : null);

function matcher(f) {
  return (r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "neq") return r[k] !== v;
    if (op === "in") return v.includes(r[k]);
    if (op === "gte") return String(r[k] ?? "") >= String(v);
    return true;
  });
}
function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter(matcher(f));
    if (order) {
      const [col, asc] = order;
      out = [...out].sort((a, b) => ((a[col] ?? 0) < (b[col] ?? 0) ? (asc ? -1 : 1) : (asc ? 1 : -1)));
    }
    return out;
  };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    order(col, opts) { if (!order) order = [col, opts?.ascending !== false]; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn, rej) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn, rej),
    insert(row) {
      const made = [].concat(row).map((r) => ({ id: r.id || uuid(), created_at: new Date().toISOString(), ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn, rej) => Promise.resolve({ data: made.map(copy), error: null }).then(fn, rej),
      };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        select: () => r2,
        maybeSingle: () => apply(),
        single: () => apply(),
        then: (fn, rej) => apply().then(fn, rej),
      };
      function apply() {
        const hit = (db.rows[name] || []).filter(matcher(g));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve({ data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
  };
  return q;
}

// ---- 偽の Storage（非公開バケット） ---------------------------------------------
const store = new Map();
function storage(bucket) {
  const key = (p) => `${bucket}/${p}`;
  return {
    upload: async (path, bytes, opts) => {
      if (store.has(key(path)) && !opts?.upsert) return { error: { message: "already exists" } };
      store.set(key(path), Buffer.from(bytes));
      return { data: { path }, error: null };
    },
    download: async (path) => {
      const b = store.get(key(path));
      if (!b) return { data: null, error: { message: "not found" } };
      return { data: { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }, error: null };
    },
    remove: async (paths) => { for (const p of paths) store.delete(key(p)); return { error: null }; },
    createSignedUrl: async (path, ttl) => ({ data: { signedUrl: `https://sb.example/sign/${bucket}/${path}?ttl=${ttl}` }, error: null }),
    createSignedUploadUrl: async (path) => ({ data: { signedUrl: `https://sb.example/upload/${bucket}/${path}`, token: "tok" }, error: null }),
    getPublicUrl: () => { throw new Error("公開URLを作ってはいけない"); },
  };
}

mock.module(atRoot("lib/supabase.js"), {
  namedExports: {
    admin: () => ({ from: table, storage: { from: storage } }),
    userClient: () => ({ from: table, storage: { from: storage } }),
  },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canManageHr: (c) => Boolean(c.isAdmin || c.isHr),
    canOfficeHr: (c) => Boolean(c.isAdmin || c.isHr),
  },
});
const logged = [];
let notifyFails = false;
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async () => { if (notifyFails) throw new Error("通知の表が読めない"); return { created: 0 }; }, clearNotification: async () => {} },
});
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async () => {} } });
mock.module(atRoot("lib/onboard-advance.js"), { namedExports: { advanceFor: async () => null } });

const { default: ordersApi } = await import(atRoot("api/sign/orders.js"));
const { default: signApi } = await import(atRoot("api/sign/index.js"));
const { contractStatus } = await import(atRoot("lib/career.js"));

const ADMIN = { userId: "u-admin", tenantId: "t1", isAdmin: true, isHr: false, roles: [], employee: { id: "e-admin", display_name: "管理 花子" } };
let who = ADMIN;

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => {
  const r = res();
  await h({ headers: { authorization: "Bearer x", "x-forwarded-for": "203.0.113.9", "user-agent": "TestUA/1.0" }, ...req }, r);
  return r;
};
const ordersAct = (body) => call(ordersApi, { method: "POST", url: "/api/sign/orders", body });
const signSend = (body) => call(signApi, { method: "POST", url: "/api/sign", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = ADMIN;
  notifyFails = false;
  logged.length = 0;
  store.clear();
  db.rows = {
    gw_doc_orders: [], gw_sign_requests: [], gw_sign_events: [], gw_role_grants: [],
    gw_onboard_profiles: [], gw_hr_applicants: [],
    gw_contracts: [
      { id: "c-a", tenant_id: "t1", employee_id: "emp-a", status: "active", created_at: "2026-04-01" },
      { id: "c-b", tenant_id: "t1", employee_id: "emp-b", status: "active", created_at: "2026-04-01" },
    ],
    gw_employees: [
      { id: "emp-a", tenant_id: "t1", display_name: "今福 太郎", user_id: "u-emp-a", joined_on: "2026-04-01", employment_type: "正社員" },
      { id: "emp-b", tenant_id: "t1", display_name: "山田 花子", user_id: "u-emp-b", joined_on: "2026-04-01", employment_type: "正社員" },
    ],
    tenants: [{ id: "t1", name: "株式会社エイト" }],
  };
}

console.log("\n=== A契約 → A作成依頼 → A署名依頼 → 締結。全部同じ契約IDでつながる ===\n");

await ok("gw_contracts.id === gw_doc_orders.contract_id === gw_sign_requests.contract_id", async () => {
  setup();
  const created = await ordersAct({
    action: "create", employeeId: "emp-a", docKind: "employment", contractId: "c-a", force: true,
  });
  assert.equal(created.statusCode, 200, JSON.stringify(created.body));
  assert.equal(created.body.order.contractId, "c-a");
  assert.equal(db.rows.gw_doc_orders[0].contract_id, "c-a");

  const orderId = created.body.order.id;
  const approved = await ordersAct({ action: "approve", id: orderId, force: true });
  assert.equal(approved.statusCode, 200, JSON.stringify(approved.body));

  const order = db.rows.gw_doc_orders.find((o) => o.id === orderId);
  const signReq = db.rows.gw_sign_requests.find((s) => s.id === approved.body.signRequestId);
  assert.ok(signReq, "gw_sign_requests に行ができていない");
  assert.equal(order.contract_id, "c-a");
  assert.equal(signReq.contract_id, "c-a");
  assert.equal(signReq.contract_id, order.contract_id);
  assert.equal(order.contract_id, "c-a");
  assert.equal("c-a", db.rows.gw_contracts.find((c) => c.id === "c-a").id);
});

console.log("\n=== B契約の書面をA契約へ誤って紐付けられないこと ===\n");

await ok("作成依頼：他人（別社員）の契約IDは断る（employeeId=emp-a に contractId=c-b）", async () => {
  setup();
  const r = await ordersAct({
    action: "create", employeeId: "emp-a", docKind: "employment", contractId: "c-b", force: true,
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "contract_not_found");
  assert.equal(db.rows.gw_doc_orders.length, 0, "作成依頼が作られてしまった");
});

await ok("直接送信（api/sign）：他人の契約IDは断る", async () => {
  setup();
  const r = await signSend({
    title: "雇用契約書", body: "本文です。{{氏名}}", employeeIds: ["emp-a"], contractId: "c-b", force: true,
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "contract_not_found");
  assert.equal(db.rows.gw_sign_requests.length, 0);
});

await ok("直接送信：contractId は複数名あてには渡せない", async () => {
  setup();
  const r = await signSend({
    title: "雇用契約書", body: "本文です。", employeeIds: ["emp-a", "emp-b"], contractId: "c-a", force: true,
  });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "contract_id_requires_single_employee");
  assert.equal(db.rows.gw_sign_requests.length, 0);
});

await ok("直接送信：1名あてなら、本人の契約IDが署名依頼にそのまま入る", async () => {
  setup();
  const r = await signSend({
    title: "雇用契約書", body: "本文です。", employeeIds: ["emp-a"], contractId: "c-a", force: true,
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent.length, 1, JSON.stringify(r.body));
  assert.equal(db.rows.gw_sign_requests[0].contract_id, "c-a");
  assert.equal(db.rows.gw_sign_requests[0].employee_id, "emp-a");
});

console.log("\n=== 非契約書類（誓約書・備品貸与・研修）は contract_id=null のままでよい ===\n");

await ok("pledge（誓約書）は contractId を渡さなくても作成できる", async () => {
  setup();
  const r = await ordersAct({ action: "create", employeeId: "emp-a", docKind: "pledge", force: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.contractId, null);
  assert.equal(db.rows.gw_doc_orders[0].contract_id, null);
});

console.log("\n=== contract_id=null の旧データは既存fallbackで表示できること（lib/career.js） ===\n");

await ok("旧データ（contract_id無し）は、現在のactive契約に対する署名として扱われる", () => {
  const contract = { id: "c-a" };
  const legacySign = { status: "signed", doc_kind: "employment" }; // 099より前のデータ。contract_id列が無い
  const status = contractStatus({ contract, signs: [legacySign] });
  assert.equal(status.key, "signed", "旧データが締結済みとして拾えない");
});

await ok("他契約向け（contract_id が別のcontract）は、この契約の締結には数えない", () => {
  const contract = { id: "c-a" };
  const otherSign = { status: "signed", doc_kind: "employment", contract_id: "c-old" };
  const status = contractStatus({ contract, signs: [otherSign] });
  assert.notEqual(status.key, "signed", "他契約の署名を、この契約の締結として誤認した");
});


console.log("\n=== 二重送信を防ぐ・お知らせに失敗しても依頼は追える ===\n");
const TPL = { id: "tpl-1", tenant_id: "t1", name: "雇用契約書", body: "本文です。{{氏名}}", doc_kind: "employment", version: 1, due_days: 7 };
await ok("雛形で送る：同じ雛形・同じ人に、直前に送っていれば送らない（二度押し・やり直し）", async () => {
  setup(); db.rows.gw_sign_templates = [TPL];
  const a = await signSend({ templateId: "tpl-1", employeeIds: ["emp-a"], force: true });
  assert.equal(a.statusCode, 200); assert.equal(a.body.sent.length, 1);
  const b = await signSend({ templateId: "tpl-1", employeeIds: ["emp-a", "emp-b"], force: true });
  assert.equal(b.body.sent.length, 1, "別の人には送る"); assert.equal(b.body.sent[0].employeeId, "emp-b");
  assert.equal(b.body.failed.length, 1); assert.equal(b.body.failed[0].duplicate, true);
  assert.equal(db.rows.gw_sign_requests.filter((r) => r.employee_id === "emp-a").length, 1);
});
await ok("雛形で送る：お知らせに失敗しても、依頼は送れたことにして追える（notified=false）", async () => {
  setup(); db.rows.gw_sign_templates = [TPL]; notifyFails = true;
  const r = await signSend({ templateId: "tpl-1", employeeIds: ["emp-a"], force: true });
  assert.equal(r.statusCode, 200); assert.equal(r.body.sent.length, 1); assert.equal(r.body.sent[0].notified, false);
  assert.equal(r.body.failed.length, 0); assert.equal(db.rows.gw_sign_requests.length, 1);
});
await ok("作成済みPDF・作成依頼から送る：お知らせに失敗しても、依頼は登録済み（notified=false）", async () => {
  setup(); notifyFails = true;
  const created = await ordersAct({ action: "create", employeeId: "emp-a", docKind: "employment", force: true });
  const approved = await ordersAct({ action: "approve", id: created.body.order.id, force: true });
  assert.equal(approved.statusCode, 200, JSON.stringify(approved.body)); assert.equal(approved.body.notified, false);
  assert.equal(db.rows.gw_doc_orders[0].status, "sent");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
