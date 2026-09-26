// ログイン中の外部メンバー本人が見る範囲（api/guests/my.js）と、
// 管理者が招待時に選ぶ候補（api/guests/options.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. api/guests/my.js は gwContext を使わない。RLSで絞られた結果を
//      そのまま返すだけ（ここでは「絞られたふりをした行」をそのまま返して、
//      正しい形に整えているかを見る。実際に絞るのはDBのRLS。db/078）
//   2. ゲストでないアカウント・無効化されたゲストは弾く
//   3. アップロード型の資料（file_path のみ）は、このMVPでは開けない印が付く
//   4. options は、プロジェクト（gw_tasks.category の重複無し一覧）・
//      グループチャットだけ（1対1は除く）・公開資料・タスクを返す
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };

function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "neq") return r[k] !== v;
    return true;
  }));
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]), error: null }),
    then: (fn) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn),
  };
  return q;
}
const copy = (r) => (r ? { ...r } : null);

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
let gwContextCalls = 0;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => { gwContextCalls++; return { tenantId: "t1", isAdmin: true, isHr: true }; },
    canManageHr: () => true,
  },
});

const { default: my } = await import(atRoot("api/guests/my.js"));
const { default: options } = await import(atRoot("api/guests/options.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const callMy = async () => { const r = res(); await my({ method: "GET", url: "/api/guests/my", headers: { authorization: "Bearer x" } }, r); return r; };
const callOptions = async () => { const r = res(); await options({ method: "GET", url: "/api/guests/options", headers: { authorization: "Bearer x" } }, r); return r; };

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== 外部メンバー本人の画面（api/guests/my.js） ===\n");

await ok("gwContext を使わない（employeeが無くても、RLSに任せて開ける）", async () => {
  db.rows = { gw_guests: [{ id: "g1", display_name: "社外 太郎", company_name: "サンプル社", disabled_at: null }],
              gw_tasks: [], gw_threads: [], gw_library: [] };
  const before = gwContextCalls;
  const r = await callMy();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(gwContextCalls, before, "gwContext は呼ばれない");
});

await ok("自分の名前・会社名と、見える範囲（RLSで絞られた前提）がそのまま返る", async () => {
  db.rows = {
    gw_guests: [{ id: "g1", display_name: "社外 太郎", company_name: "サンプル社", disabled_at: null }],
    gw_tasks: [{ id: "t1", title: "見積を出す", status: "todo", due_on: "2026-10-01", category: "ENGER" }],
    gw_threads: [{ id: "th1", title: "ENGERの相談" }],
    gw_library: [{ id: "d1", title: "規程集", description: "", link_url: "https://example.com/rules", file_path: null }],
  };
  const r = await callMy();
  assert.equal(r.body.me.displayName, "社外 太郎");
  assert.equal(r.body.tasks.length, 1);
  assert.equal(r.body.threads[0].title, "ENGERの相談");
  assert.equal(r.body.documents[0].url, "https://example.com/rules");
});

await ok("ゲストでなければ弾く", async () => {
  db.rows = { gw_guests: [], gw_tasks: [], gw_threads: [], gw_library: [] };
  const r = await callMy();
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "not_a_guest");
});

await ok("無効化されていれば弾く", async () => {
  db.rows = { gw_guests: [{ id: "g1", display_name: "社外 太郎", disabled_at: new Date().toISOString() }],
              gw_tasks: [], gw_threads: [], gw_library: [] };
  const r = await callMy();
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "disabled");
});

await ok("アップロード型の資料は、このMVPでは開けない印が付く", async () => {
  db.rows = {
    gw_guests: [{ id: "g1", display_name: "社外 太郎", disabled_at: null }],
    gw_tasks: [], gw_threads: [],
    gw_library: [{ id: "d1", title: "様式", description: "", link_url: null, file_path: "t1/library/x.pdf" }],
  };
  const r = await callMy();
  assert.equal(r.body.documents[0].url, null);
  assert.equal(r.body.documents[0].fileOnly, true);
});

console.log("\n=== 招待の候補（api/guests/options.js） ===\n");

await ok("プロジェクトは category の重複無し一覧", async () => {
  db.rows = {
    gw_tasks: [
      { id: "t1", tenant_id: "t1", title: "A", category: "ENGER", status: "todo", is_template: false },
      { id: "t2", tenant_id: "t1", title: "B", category: "ENGER", status: "todo", is_template: false },
      { id: "t3", tenant_id: "t1", title: "C", category: "新規開拓", status: "todo", is_template: false },
    ],
    gw_threads: [], gw_library: [],
  };
  const r = await callOptions();
  assert.deepEqual(r.body.projects.map((p) => p.key).sort(), ["ENGER", "新規開拓"]);
  assert.equal(r.body.tasks.length, 3);
});

await ok("チャットはグループだけ（1対1は除く）", async () => {
  db.rows = {
    gw_tasks: [],
    gw_threads: [
      { id: "th1", tenant_id: "t1", title: "プロジェクトA共有", kind: "group" },
      { id: "th2", tenant_id: "t1", title: null, kind: "dm" },
    ],
    gw_library: [],
  };
  const r = await callOptions();
  assert.equal(r.body.threads.length, 1);
  assert.equal(r.body.threads[0].label, "プロジェクトA共有");
});

// 「一般メンバーは候補を見られない」は、同じ canManageHr(ctx) ゲートを使う
// api/guests/index.js 側（test/guestapi.mjs）で確認済み

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
