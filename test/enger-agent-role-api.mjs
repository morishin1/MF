// ENGER営業エージェントの役割（api/enger/agent-users.js ・ lib/enger-agent-role.js）を、
// 偽の保存先に対して実際に呼んで確かめる（文字列一致ではなく、権限が開く・閉じることを見る）。
//
// ■ 何を守るか（開発指示書 AC-07 / AC-09 / AC-10 / AC-11）
//   1. 既存の正社員に役割を付けても Auth を作らない（1人1ログイン）。雇用区分・部署は変わらない
//   2. 付けた直後は閲覧不可。契約・NDA・担当企業がそろって初めて can_view=true
//   3. 業務委託でも役割を付けなければ一覧に出ず、開けない（雇用区分から推測しない）
//   4. 担当企業は同じテナント・連絡注意なし・非表示なしだけ
//   5. ENGER社内メンバー（app_users admin/agent）や社内所属の人に外部エージェントを足さない
//   6. 停止・退職では閲覧OFF→担当企業削除→所属 inactive。役割の無い人には何もしない
//   7. 名簿にいる人と同じメールで新規作成しようとすると拒否（重複ログインを作らない）
//   8. 人事・管理者以外は拒否
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const at = (p) => join(ROOT, p);

const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222";
const uid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`;
const eid = (n) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cid = (n) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;

let db, authUsers, logged, ctx, seq;
function reset() {
  seq = 0; logged = []; authUsers = [];
  ctx = { tenantId: T1, isAdmin: true, isHr: true, roles: ["owner"], apps: [] };
  db = {
    gw_employees: [
      { id: eid(1), tenant_id: T1, user_id: uid(1), display_name: "正社員A", email: "a@example.com", department: "開発", employment_type: "正社員", status: "active", left_on: null, created_at: "3" },
      { id: eid(2), tenant_id: T1, user_id: uid(2), display_name: "委託B", email: "b@example.com", department: "営業", employment_type: "業務委託", status: "active", left_on: null, created_at: "2" },
      { id: eid(3), tenant_id: T1, user_id: uid(3), display_name: "委託C（開発のみ）", email: "c@example.com", department: "開発", employment_type: "業務委託", status: "active", left_on: null, created_at: "1" },
      { id: eid(4), tenant_id: T1, user_id: uid(4), display_name: "社内ENGER", email: "internal@example.com", department: "営業", employment_type: "正社員", status: "active", left_on: null, created_at: "0" },
      { id: eid(9), tenant_id: T2, user_id: uid(9), display_name: "他社", email: "x@example.com", department: "営業", employment_type: "業務委託", status: "active", left_on: null, created_at: "0" },
    ],
    "enger.organization_memberships": [],
    "enger.member_product_access": [],
    "enger.member_data_scope": [],
    "enger.app_users": [{ id: "app-4", email: "internal@example.com", role: "agent", status: "active" }],
    "enger.dx2_sales_company_directory_for_tenant": [
      { id: cid(1), tenant_id: T1, name: "株式会社いち", needs_contact_review: false, directory_hidden_at: null },
      { id: cid(2), tenant_id: T1, name: "株式会社に", needs_contact_review: false, directory_hidden_at: null },
      { id: cid(3), tenant_id: T1, name: "連絡注意", needs_contact_review: true, directory_hidden_at: null },
      { id: cid(4), tenant_id: T1, name: "非表示", needs_contact_review: false, directory_hidden_at: "2026-01-01" },
      { id: cid(5), tenant_id: T2, name: "他テナント", needs_contact_review: false, directory_hidden_at: null },
    ],
  };
}

function table(name) {
  const f = [];
  let lim = Infinity, op = "select", payload = null, opts = {}, wantRows = false;
  const match = (r) => f.every(([kind, k, v]) => {
    if (kind === "eq") return r[k] === v;
    if (kind === "in") return v.includes(r[k]);
    if (kind === "is") return (r[k] ?? null) === v;
    if (kind === "notnull") return r[k] != null;
    if (kind === "ilike") {
      const re = new RegExp("^" + String(v).replace(/\\([%_\\])/g, "\u0000$1").replace(/[.*+?^${}()|[\]]/g, "\\$&")
        .replace(/%/g, ".*").replace(/_/g, ".").replace(/\u0000(.)/g, (_, c) => "\\" + c) + "$", "i");
      return re.test(String(r[k] ?? ""));
    }
    return true;
  });
  const list = () => (db[name] = db[name] || []);
  const run = () => {
    if (op === "insert") {
      const made = [].concat(payload).map((r) => ({ id: `${name}-${++seq}`, status: "active", ...r }));
      for (const r of made) {
        if (name === "enger.organization_memberships" && list().some((x) => x.user_id === r.user_id))
          return { data: null, error: { code: "23505", message: "duplicate user_id" } };
        if (name === "enger.member_data_scope" && list().some((x) => x.membership_id === r.membership_id && x.scope_type === r.scope_type && x.scope_id === r.scope_id))
          return { data: null, error: { code: "23505", message: "duplicate scope" } };
      }
      list().push(...made);
      return { data: made, error: null };
    }
    if (op === "upsert") {
      const keys = (opts.onConflict || "id").split(",");
      for (const r of [].concat(payload)) {
        const i = list().findIndex((x) => keys.every((k) => x[k] === r[k]));
        if (i >= 0) { if (!opts.ignoreDuplicates) Object.assign(list()[i], r); } else list().push({ id: `${name}-${++seq}`, ...r });
      }
      return { data: null, error: null };
    }
    if (op === "update") {
      const hit = list().filter(match); hit.forEach((r) => Object.assign(r, payload));
      return { data: hit, error: null };
    }
    if (op === "delete") { db[name] = list().filter((r) => !match(r)); return { data: null, error: null }; }
    return { data: list().filter(match).slice(0, lim).map((r) => ({ ...r })), error: null };
  };
  const q = {
    select() { wantRows = true; return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    not(k, o, v) { if (o === "is" && v === null) f.push(["notnull", k]); return q; },
    ilike(k, v) { f.push(["ilike", k, v]); return q; },
    order() { return q; },
    limit(n) { lim = n; return q; },
    insert(p) { op = "insert"; payload = p; return q; },
    update(p) { op = "update"; payload = p; return q; },
    upsert(p, o = {}) { op = "upsert"; payload = p; opts = o; return q; },
    delete() { op = "delete"; return q; },
    maybeSingle: () => { const r = run(); return Promise.resolve(r.error ? r : { data: r.data?.[0] ?? null, error: null }); },
    single: () => { const r = run(); return Promise.resolve(r.error ? r : r.data?.length ? { data: r.data[0], error: null } : { data: null, error: { message: "no rows" } }); },
    then: (fn, rej) => Promise.resolve(run()).then(fn, rej),
  };
  return q;
}
const client = () => ({
  from: (n) => table(n),
  schema: (s) => ({ from: (n) => table(`${s}.${n}`) }),
  auth: { admin: {
    createUser: async ({ email }) => {
      if (authUsers.some((u) => u.email === email)) return { data: null, error: { message: "exists" } };
      const u = { id: uid(100 + authUsers.length), email }; authUsers.push(u);
      return { data: { user: u }, error: null };
    },
    deleteUser: async () => ({ error: null }),
    updateUserById: async () => { throw new Error("must not change Auth from agent API"); },
  } },
});
mock.module(at("lib/supabase.js"), { namedExports: { admin: client, userClient: client } });
mock.module(at("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "admin-user" }), getMemberships: async () => [] } });
mock.module(at("lib/gw.js"), { namedExports: { gwContext: async () => ctx, canManageHr: (c) => Boolean(c.isAdmin || c.isHr) } });
mock.module(at("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(at("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
mock.module(at("lib/accounts.js"), { namedExports: { randomPassword: () => "OneTime-Pass-123" } });

const { default: api } = await import(at("api/enger/agent-users.js"));
const role = await import(at("lib/enger-agent-role.js"));

const call = async (method, body, url = "/api/enger/agent-users") => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  await api({ method, url, headers: { authorization: "Bearer x" }, on() {},
    body: body === undefined ? undefined : body,
    [Symbol.asyncIterator]: async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } }, r);
  return r;
};
const access = (userId) => {
  const m = db["enger.organization_memberships"].find((x) => x.user_id === userId);
  return m && db["enger.member_product_access"].find((x) => x.membership_id === m.id && x.product === "partner_sales");
};
const scopes = (userId) => {
  const m = db["enger.organization_memberships"].find((x) => x.user_id === userId);
  return m ? db["enger.member_data_scope"].filter((x) => x.membership_id === m.id).map((x) => x.scope_id) : [];
};
const grant = (n) => call("PATCH", { action: "grant_role", employeeId: eid(n), confirm: true });
const activate = (n, ids, extra = {}) => call("PATCH", { employeeId: eid(n), enabled: true, companyIds: ids, contractConfirmed: true, ndaConfirmed: true, ...extra });

test("正社員Aに役割を付与：Authを作らず、雇用区分・部署を変えず、停止中で付く", async () => {
  reset();
  const r = await grant(1);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(authUsers.length, 0, "Auth を新しく作らない");
  const emp = db.gw_employees.find((x) => x.id === eid(1));
  assert.equal(emp.employment_type, "正社員"); assert.equal(emp.department, "開発");
  const m = db["enger.organization_memberships"].find((x) => x.user_id === uid(1));
  assert.equal(m.membership_type, "external"); assert.equal(m.status, "inactive");
  assert.equal(access(uid(1)).can_view, false, "付与直後は閲覧不可");
  assert.ok(logged.some((e) => e.action === "enger.agent_role_grant" && e.detail.authCreated === false));
  const list = await call("GET");
  const a = list.body.agents.find((x) => x.employeeId === eid(1));
  assert.equal(a.roleAssigned, true); assert.equal(a.enabled, false);
  // 付け直しても状態は変わらない（冪等）
  assert.equal((await grant(1)).statusCode, 200);
  assert.equal(db["enger.organization_memberships"].filter((x) => x.user_id === uid(1)).length, 1);
});

test("業務委託Bは契約・NDA・担当企業がそろうまで開けない。そろえば担当企業だけ", async () => {
  reset();
  assert.equal((await activate(2, [cid(1)])).statusCode, 409, "役割が無ければ開けない");
  await grant(2);
  assert.equal((await activate(2, [cid(1)], { ndaConfirmed: false })).statusCode, 400);
  assert.equal((await activate(2, [])).statusCode, 400);
  assert.equal(access(uid(2)).can_view, false);
  const ok = await activate(2, [cid(1), cid(2)]);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(access(uid(2)).can_view, true);
  assert.deepEqual(scopes(uid(2)).sort(), [cid(1), cid(2)].sort());
  assert.equal(db["enger.organization_memberships"].find((x) => x.user_id === uid(2)).status, "active");
});

test("業務委託Cは役割を付けなければ一覧に出ず、開けない（雇用区分から推測しない）", async () => {
  reset();
  await grant(2);
  const list = await call("GET");
  assert.ok(!list.body.agents.some((x) => x.employeeId === eid(3)));
  assert.equal((await activate(3, [cid(1)])).statusCode, 409);
  assert.equal(access(uid(3)), undefined);
});

test("担当企業：連絡注意・非表示・別テナント・存在しない企業は拒否し、権限は開かない", async () => {
  reset(); await grant(2);
  for (const bad of [cid(3), cid(4), cid(5), cid(99)]) {
    const r = await activate(2, [cid(1), bad]);
    assert.equal(r.statusCode, 409, bad);
    assert.equal(r.body.error, "company_not_assignable");
    assert.equal(access(uid(2)).can_view, false);
    assert.deepEqual(scopes(uid(2)), []);
  }
  // 企業検索も同じテナント・安全な企業だけ
  const s = await call("GET", undefined, "/api/enger/agent-users?companyQuery=" + encodeURIComponent("株式会社"));
  assert.deepEqual(s.body.companies.map((c) => c.id).sort(), [cid(1), cid(2)].sort());
});

test("ENGER社内メンバー・社内所属・別テナントの名簿には外部エージェントを付けない", async () => {
  reset();
  const internal = await grant(4);
  assert.equal(internal.statusCode, 409); assert.equal(internal.body.error, "enger_internal_user");
  db["enger.organization_memberships"].push({ id: "m-int", user_id: uid(1), membership_type: "internal", role: "member", status: "active", organization_id: null, partner_organization_id: null });
  const conflict = await grant(1);
  assert.equal(conflict.statusCode, 409); assert.equal(conflict.body.error, "membership_conflict");
  assert.equal(db["enger.organization_memberships"].find((x) => x.id === "m-int").membership_type, "internal", "社内所属を変換しない");
  assert.equal(db["enger.member_product_access"].length, 0);
  assert.equal((await grant(9)).statusCode, 404, "別テナントの名簿は触れない");
});

test("停止：閲覧OFF→担当企業削除→所属inactive。退職者・企業がNGになった後でも停止できる", async () => {
  reset(); await grant(2); await activate(2, [cid(1)]);
  db.gw_employees.find((x) => x.id === eid(2)).status = "left";
  db["enger.dx2_sales_company_directory_for_tenant"].find((x) => x.id === cid(1)).needs_contact_review = true;
  const r = await call("PATCH", { employeeId: eid(2), enabled: false, companyIds: [] });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(access(uid(2)).can_view, false);
  assert.deepEqual(scopes(uid(2)), []);
  assert.equal(db["enger.organization_memberships"].find((x) => x.user_id === uid(2)).status, "inactive");
  // 退職者は再度開けない
  assert.equal((await activate(2, [cid(2)])).statusCode, 409);
});

test("revokeAgentAccess（退職処理から呼ぶ）：エージェントだけ閉じ、社内所属には触れない", async () => {
  reset(); await grant(2); await activate(2, [cid(1)]);
  const sb = client();
  assert.deepEqual(await role.revokeAgentAccess(sb, uid(2)), { revoked: true });
  assert.equal(access(uid(2)).can_view, false);
  assert.deepEqual(scopes(uid(2)), []);
  db["enger.organization_memberships"].push({ id: "m-int", user_id: uid(1), membership_type: "internal", role: "admin", status: "active", organization_id: null, partner_organization_id: null });
  assert.deepEqual(await role.revokeAgentAccess(sb, uid(1)), { revoked: false });
  assert.equal(db["enger.organization_memberships"].find((x) => x.id === "m-int").status, "active");
  assert.deepEqual(await role.revokeAgentAccess(sb, uid(3)), { revoked: false }, "役割の無い人は何もしない");
});

test("新規作成：名簿にいるメールは拒否（重複ログインを作らない）。新しい人は停止中の役割つきで1回だけPWを返す", async () => {
  reset();
  const dup = await call("POST", { name: "A", email: "A@example.com", employmentType: "業務委託", confirm: true });
  assert.equal(dup.statusCode, 409); assert.equal(dup.body.error, "already_registered");
  assert.equal(authUsers.length, 0);
  const internal = await call("POST", { name: "I", email: "internal@example.com", employmentType: "業務委託", confirm: true });
  // 名簿に同じメールがいるので先に already_registered で止まる
  assert.equal(internal.statusCode, 409);
  const legacy = await call("POST", { name: "N", email: "n@example.com", employmentType: "業務委託", department: "ENGERエージェント", confirm: true });
  assert.equal(legacy.statusCode, 400, "部署名で役割を表さない");
  const r = await call("POST", { name: "新人D", email: "d@example.com", employmentType: "正社員", department: "営業", confirm: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.initialPassword, "OneTime-Pass-123");
  assert.equal(r.body.loginUrl, undefined, "使えないENGERログインURLを案内しない");
  const emp = db.gw_employees.find((x) => x.email === "d@example.com");
  assert.equal(emp.employment_type, "正社員"); assert.equal(emp.department, "営業");
  assert.equal(access(emp.user_id).can_view, false);
  assert.ok(!JSON.stringify(logged).includes("OneTime-Pass-123"), "監査ログにPWを残さない");
});

test("旧方式（部署名だけ）の人は一覧に『役割の付与待ち』で出るが、権限は開いていない", async () => {
  reset();
  db.gw_employees.find((x) => x.id === eid(3)).department = "ENGERエージェント";
  const list = await call("GET");
  const c = list.body.agents.find((x) => x.employeeId === eid(3));
  assert.equal(c.legacyOnly, true); assert.equal(c.roleAssigned, false); assert.equal(c.enabled, false);
});

test("パスワード再発行はこのAPIでは行わず、名簿共通のログイン管理へ案内する", async () => {
  reset(); await grant(2);
  const r = await call("PATCH", { action: "reset_password", employeeId: eid(2), confirm: true });
  assert.equal(r.statusCode, 410); assert.equal(r.body.error, "use_member_account");
});

test("人事・管理者以外は一覧・付与・有効化を拒否", async () => {
  reset();
  ctx = { tenantId: T1, isAdmin: false, isHr: false, roles: ["sales"], apps: ["sales"] };
  assert.equal((await call("GET")).statusCode, 403);
  assert.equal((await grant(2)).statusCode, 403);
  assert.equal(db["enger.organization_memberships"].length, 0);
});
