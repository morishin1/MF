// 外部メンバー招待（gw_guests / gw_guest_invites / gw_guest_grants）を、
// 偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 招待すると、ゲストの行と最初の招待（トークンのハッシュ）ができる。
//      平文のトークンは、その応答にだけ入る
//   2. 一般メンバーは、外部メンバーの一覧にも招待にも触れない
//   3. 再発行すると、古い未使用の招待は無効になり、新しい行ができる。
//      無効化されていたら、再発行で解除される
//   4. 無効化すると、以後は使えなくなる。未使用の招待も一緒に無効化される
//   5. 権限（許可）は丸ごと入れ替えられる
//   6. 監査ログ（gwLog）が、招待・再発行・無効化・権限変更のたびに呼ばれる
//   7. 078が未適用でも、一覧は落ちずに「まだ」と伝える
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {} };
const logged = [];

function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
      if (op === "is") return v === null ? r[k] == null : r[k] === v;
      return true;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? 1 : -1));
    return out;
  };
  const e = () => err(name);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order(col) { order = col; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: e() ? null : copy(rows()[0]), error: e() }),
    single: () => Promise.resolve({ data: e() ? null : copy(rows()[0]), error: e() }),
    then: (fn) => Promise.resolve({ data: e() ? null : rows().map(copy), error: e() }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: r.created_at || new Date().toISOString(), ...r }));
      if (!e()) (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = { select: () => r2,
                   single: () => Promise.resolve({ data: e() ? null : copy(made[0]), error: e() }),
                   maybeSingle: () => Promise.resolve({ data: e() ? null : copy(made[0]), error: e() }),
                   then: (fn) => Promise.resolve({ data: e() ? null : made.map(copy), error: e() }).then(fn) };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        is: (k, v) => { g.push(["is", k, v]); return r2; },
        select: () => r2,
        single: () => apply(),
        maybeSingle: () => apply(),
        then: (fn) => apply({ asList: true }).then(fn),
      };
      function apply(opts) {
        const hit = (db.rows[name] || []).filter((x) => g.every(([op, k, v]) => {
          if (op === "eq") return x[k] === v;
          if (op === "is") return v === null ? x[k] == null : x[k] === v;
          return true;
        }));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve(opts?.asList
          ? { data: hit.map(copy), error: null }
          : { data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
    delete() {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        then: (fn) => {
          const hit = new Set((db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v)).map((x) => x.id));
          db.rows[name] = (db.rows[name] || []).filter((x) => !hit.has(x.id));
          return Promise.resolve({ data: [], error: null }).then(fn);
        },
      };
      return r2;
    },
  };
  return q;
}
const copy = (r) => (r ? { ...r } : null);
const err = (name) => (db.missing === name ? { code: "PGRST205", message: "Could not find the table" } : null);

const authUsers = new Map(); // uid -> { last_sign_in_at }
const adminAuth = {
  admin: {
    getUserById: async (uid) => ({ data: { user: authUsers.get(uid) ? { id: uid, ...authUsers.get(uid) } : null }, error: null }),
  },
};

mock.module(atRoot("lib/supabase.js"), {
  namedExports: {
    admin: () => ({ from: table, auth: adminAuth }),
    userClient: () => ({ from: table, auth: adminAuth }),
  },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
const MEMBER = { tenantId: "t1", isAdmin: false, isHr: false, employee: { id: "emp-1", display_name: "山田 太郎" } };
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: true, employee: { id: "emp-hr", display_name: "事務 花子" } };
let who = ADMIN;
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => who, canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr) },
});
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});

const { default: guests } = await import(atRoot("api/guests/index.js"));
const { default: detail } = await import(atRoot("api/guests/detail.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const getList = () => call(guests, { method: "GET", url: "/api/guests" });
const invite = (body) => call(guests, { method: "POST", url: "/api/guests", body });
const getDetail = (id) => call(detail, { method: "GET", url: `/api/guests/detail?id=${id}` });
const act = (body) => call(detail, { method: "POST", url: "/api/guests/detail", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = ADMIN;
  db.missing = null;
  db.rows = { gw_guests: [], gw_guest_invites: [], gw_guest_grants: [] };
  authUsers.clear();
  logged.length = 0;
}

const body = (over = {}) => ({ displayName: "社外 太郎", companyName: "サンプル社", email: "taro@example.com", ...over });

console.log("\n=== 外部メンバー招待（gw_guests） ===\n");

console.log("— 招待する —");

await ok("招待すると、ゲストと招待の行ができる。平文はその応答にだけ入る", async () => {
  setup();
  const r = await invite(body({ grants: [{ resourceType: "project", resourceKey: "ENGER", resourceLabel: "ENGER" }] }));
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.token, "平文トークンが返る");
  assert.equal(db.rows.gw_guests.length, 1);
  assert.equal(db.rows.gw_guest_invites.length, 1);
  assert.notEqual(db.rows.gw_guest_invites[0].token_hash, r.body.token, "DBに平文は無い");
  assert.equal(db.rows.gw_guest_grants.length, 1);
});

await ok("監査ログに guest.invite が残る", async () => {
  setup();
  await invite(body());
  assert.ok(logged.some((l) => l.action === "guest.invite" && l.actorId === "u-1"));
});

await ok("氏名が無ければ拒否する", async () => {
  setup();
  const r = await invite(body({ displayName: "" }));
  assert.equal(r.statusCode, 400);
  assert.equal(db.rows.gw_guests.length, 0);
});

await ok("一般メンバーは招待できない", async () => {
  setup();
  who = MEMBER;
  const r = await invite(body());
  assert.equal(r.statusCode, 403);
});

await ok("一般メンバーは一覧も見えない", async () => {
  setup();
  who = MEMBER;
  const r = await getList();
  assert.equal(r.statusCode, 403);
});

await ok("表がまだ無くても、一覧は落ちない", async () => {
  setup();
  db.missing = "gw_guests";
  const r = await getList();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notReady, true);
});

console.log("— 一覧・状態 —");

await ok("一覧に状態・招待日時・有効期限が出る", async () => {
  setup();
  await invite(body());
  const r = await getList();
  assert.equal(r.body.guests.length, 1);
  assert.equal(r.body.guests[0].status, "invited");
  assert.ok(r.body.guests[0].invitedAt);
  assert.ok(r.body.guests[0].expiresAt);
});

await ok("登録済みなら、最終ログインが出る", async () => {
  setup();
  await invite(body());
  const g = db.rows.gw_guests[0];
  g.user_id = "auth-u-9";
  authUsers.set("auth-u-9", { last_sign_in_at: "2026-09-20T00:00:00Z" });
  const r = await getList();
  assert.equal(r.body.guests[0].status, "active");
  assert.equal(r.body.guests[0].lastLoginAt, "2026-09-20T00:00:00Z");
});

console.log("— 再発行 —");

await ok("再発行すると、旧トークンは無効になり、新しいトークンが返る", async () => {
  setup();
  const r1 = await invite(body());
  const gid = r1.body.guest.id;
  const r2 = await act({ id: gid, action: "reissue" });
  assert.equal(r2.statusCode, 200);
  assert.notEqual(r2.body.token, r1.body.token);
  const invites = db.rows.gw_guest_invites.filter((x) => x.guest_id === gid);
  assert.equal(invites.length, 2);
  assert.ok(invites.some((x) => x.revoked_at), "古い招待に無効化の印が付く");
  assert.ok(invites.some((x) => !x.revoked_at), "新しい招待は生きている");
});

await ok("無効化されていたゲストを再発行すると、無効化が解除される", async () => {
  setup();
  const r1 = await invite(body());
  const gid = r1.body.guest.id;
  await act({ id: gid, action: "disable" });
  assert.ok(db.rows.gw_guests.find((g) => g.id === gid).disabled_at);
  await act({ id: gid, action: "reissue" });
  assert.equal(db.rows.gw_guests.find((g) => g.id === gid).disabled_at, null);
});

await ok("監査ログに guest.reissue が残る", async () => {
  setup();
  const r1 = await invite(body());
  logged.length = 0;
  await act({ id: r1.body.guest.id, action: "reissue" });
  assert.ok(logged.some((l) => l.action === "guest.reissue"));
});

console.log("— 無効化 —");

await ok("無効化すると disabled_at が付き、未使用の招待も無効になる", async () => {
  setup();
  const r1 = await invite(body());
  const gid = r1.body.guest.id;
  await act({ id: gid, action: "disable" });
  const g = db.rows.gw_guests.find((x) => x.id === gid);
  assert.ok(g.disabled_at);
  const inv = db.rows.gw_guest_invites.find((x) => x.guest_id === gid);
  assert.ok(inv.revoked_at);
});

await ok("監査ログに guest.disable が残る", async () => {
  setup();
  const r1 = await invite(body());
  logged.length = 0;
  await act({ id: r1.body.guest.id, action: "disable" });
  assert.ok(logged.some((l) => l.action === "guest.disable"));
});

console.log("— 権限（許可）の編集 —");

await ok("権限は丸ごと入れ替わる", async () => {
  setup();
  const r1 = await invite(body({ grants: [{ resourceType: "project", resourceKey: "A" }] }));
  const gid = r1.body.guest.id;
  await act({
    id: gid, action: "updateGrants",
    grants: [{ resourceType: "task", resourceKey: "t1", resourceLabel: "見積を出す" }],
  });
  const gs = db.rows.gw_guest_grants.filter((x) => x.guest_id === gid);
  assert.equal(gs.length, 1);
  assert.equal(gs[0].resource_type, "task");
});

await ok("空にもできる（すべて外す）", async () => {
  setup();
  const r1 = await invite(body({ grants: [{ resourceType: "project", resourceKey: "A" }] }));
  const gid = r1.body.guest.id;
  await act({ id: gid, action: "updateGrants", grants: [] });
  assert.equal(db.rows.gw_guest_grants.filter((x) => x.guest_id === gid).length, 0);
});

await ok("監査ログに guest.grant_change が残る", async () => {
  setup();
  const r1 = await invite(body());
  logged.length = 0;
  await act({ id: r1.body.guest.id, action: "updateGrants", grants: [] });
  assert.ok(logged.some((l) => l.action === "guest.grant_change"));
});

console.log("— 詳細（右ドロワー用） —");

await ok("詳細に、状態・招待履歴・権限が出る", async () => {
  setup();
  const r1 = await invite(body({ grants: [{ resourceType: "document", resourceKey: "d1", resourceLabel: "規程集" }] }));
  const r = await getDetail(r1.body.guest.id);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.status, "invited");
  assert.equal(r.body.invites.length, 1);
  assert.equal(r.body.grants.length, 1);
  assert.equal(r.body.grants[0].typeLabel, "資料");
});

await ok("無い相手は404", async () => {
  setup();
  const r = await getDetail("nope");
  assert.equal(r.statusCode, 404);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
