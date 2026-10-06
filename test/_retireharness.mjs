// 退職手続きの1画面（api/employees/retire-case.js）のテスト用の偽の DB・ログイン。
//   test/retirecaseapi.mjs（ハンドラを直に呼ぶ）と test/ui/retirecaseui.mjs（本物の画面につなぐ）が使う。
//   gw_retire_set_dates の実物の振る舞いは test/sql/123_retire_case.sql が実 PostgreSQL で確かめる。
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の DB ----------------------------------------------------------------------
export const db = { rows: {}, n: 0, absent: new Set(), failRead: new Set() };
export const logs = [];
export const current = { userId: null };

function table(name) {
  const f = []; let op = null, payload = null, sel = false, one = false, order = null, asc = true, lim = null;
  const match = (r) => f.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
  const all = () => (db.rows[name] = db.rows[name] || []);
  const run = () => {
    if (db.absent.has(name)) return { data: null, error: { code: "PGRST205", message: "Could not find the table in the schema cache" } };
    if (db.failRead.has(name)) return { data: null, error: { code: "500", message: "boom" } };
    const list = all();
    if (op === "insert") {
      const rows = [].concat(payload).map((r) => ({ id: `${name}-${++db.n}`, created_at: new Date(Date.now() + db.n).toISOString(), ...r }));
      for (const r of rows) list.push(r);
      return { data: one ? { ...rows[0] } : rows.map((r) => ({ ...r })), error: null };
    }
    if (op === "update") {
      const hit = list.filter(match); for (const r of hit) Object.assign(r, payload);
      return { data: one ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r })), error: null };
    }
    let rows = list.filter(match).map((r) => ({ ...r }));
    if (order) rows.sort((a, b) => String(a[order] ?? "").localeCompare(String(b[order] ?? "")) * (asc ? 1 : -1));
    if (lim) rows = rows.slice(0, lim);
    return { data: one ? (rows[0] || null) : rows, error: null };
  };
  const q = {
    select() { sel = true; return q; },
    eq(k, v) { f.push([k, v]); return q; }, in(k, v) { f.push([k, v]); return q; },
    neq() { return q; }, lt() { return q; }, limit(n) { lim = n; return q; },
    order(k, o = {}) { order = k; asc = o.ascending !== false; return q; },
    insert(v) { op = "insert"; payload = v; return q; },
    update(v) { op = "update"; payload = v; return q; },
    maybeSingle() { one = true; return Promise.resolve(run()); },
    single() { one = true; return Promise.resolve(run()); },
    then(fn, rej) { return Promise.resolve(run()).then(fn, rej); },
  };
  return q;
}
// db/123 の gw_retire_set_dates と同じ振る舞い（実物は test/sql/123_retire_case.sql が実 PostgreSQL で確かめる）
export const rpcCalls = [];
async function rpc(fn, a) {
  rpcCalls.push({ fn, a });
  if (fn !== "gw_retire_set_dates") return { data: null, error: { message: "nf" } };
  if (db.absent.has("gw_retire_events")) return { data: null, error: { code: "PGRST202", message: "Could not find the function public.gw_retire_set_dates" } };
  const e = db.rows.gw_employees.find((x) => x.id === a.p_employee && x.tenant_id === a.p_tenant);
  if (!e) return { data: null, error: { code: "P0002", message: "retire_not_found" } };
  const c = (db.rows.gw_retire_cases || []).find((x) => x.employee_id === a.p_employee);
  if (e.updated_at !== a.p_expect_emp || (c && c.updated_at !== a.p_expect_case) || (!c && a.p_expect_case)) return { data: null, error: { code: "P0001", message: "retire_conflict" } };
  if (a.p_last_work_on && a.p_left_on && a.p_last_work_on > a.p_left_on) return { data: null, error: { code: "22023", message: "retire_last_after_left" } };
  const now = new Date(Date.now() + ++db.n).toISOString();
  const from = { left: e.left_on, last: c?.last_work_on || null, owner: c?.owner_employee_id || null };
  e.left_on = a.p_left_on; e.updated_at = now;
  if (c) Object.assign(c, { last_work_on: a.p_last_work_on, owner_employee_id: a.p_owner, updated_at: now });
  else (db.rows.gw_retire_cases = db.rows.gw_retire_cases || []).push({ id: `c-${db.n}`, tenant_id: a.p_tenant, employee_id: a.p_employee, last_work_on: a.p_last_work_on, owner_employee_id: a.p_owner, updated_at: now });
  (db.rows.gw_retire_events = db.rows.gw_retire_events || []).push({ tenant_id: a.p_tenant, employee_id: a.p_employee, kind: "dates.update",
    detail: { leftOn: { from: from.left, to: a.p_left_on }, lastWorkOn: { from: from.last, to: a.p_last_work_on }, owner: { from: from.owner, to: a.p_owner } },
    actor_id: a.p_actor, actor_name: a.p_actor_name, created_at: now });
  return { data: { employeeUpdatedAt: now, caseUpdatedAt: now }, error: null };
}
// PDF を見る（署名付き URL）だけ。登録・アップロードは test/retireeapi.mjs が見る
export const signed = [];
const storage = { from: () => ({
  createSignedUrl: async (path, ttl) => { signed.push({ path, ttl }); return { data: { signedUrl: `https://storage.test/sign/hr/${encodeURIComponent(path)}` }, error: null }; },
}) };
mock.module(atRoot("lib/supabase.js"), { namedExports: {
  admin: () => ({ from: table, rpc, storage }),
  userClient: () => ({ from: table, rpc, auth: { getUser: async () => (current.userId ? { data: { user: { id: current.userId, email: "x@example.com" } }, error: null } : { data: null, error: { message: "no" } }) } }),
} });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logs.push(e); } } });
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });

export const { resetLeftCache } = await import(atRoot("lib/auth.js"));
export const RC = await import(atRoot("lib/retire-case.js"));
export const { default: api } = await import(atRoot("api/employees/retire-case.js"));
export const { default: retireApi } = await import(atRoot("api/employees/retire.js"));

export const ymdOffset = (d) => new Date(Date.now() + 9 * 3600000 + d * 86400000).toISOString().slice(0, 10);
export const TODAY = ymdOffset(0), YESTERDAY = ymdOffset(-1), TOMORROW = ymdOffset(1), NEXTWEEK = ymdOffset(7), LASTWEEK = ymdOffset(-7);
export const emp = (id, status, left_on = null, tenant = "t1") => ({ id: `e-${id}`, tenant_id: tenant, user_id: `u-${id}`, display_name: `名前${id}`, department: "開発",
  employment_type: "正社員", joined_on: "2025-04-01", status, left_on, updated_at: "2026-10-01T00:00:00.000001+00:00" });
export function setup() {
  resetLeftCache(); db.absent.clear(); db.failRead.clear(); logs.length = 0; rpcCalls.length = 0; signed.length = 0; db.n = 0; current.userId = null;
  db.rows = {
    gw_employees: [emp("hr", "active"), emp("member", "active"), emp("soon", "leaving", NEXTWEEK), emp("past", "leaving", LASTWEEK), emp("left", "left", LASTWEEK),
      emp("noday", "leaving", null), emp("other", "active", null, "t2")],
    gw_role_grants: [{ id: "g1", tenant_id: "t1", employee_id: "e-hr", role: "hr" }],
    gw_app_grants: [{ tenant_id: "t1", employee_id: "e-hr", app_key: "office" }, { tenant_id: "t1", employee_id: "e-hr", app_key: "hr" }],
    memberships: [{ tenant_id: "t1", user_id: "u-soon", role: "staff" }],
    profiles: [{ id: "u-soon", approval_status: "approved", suspended_at: null }, { id: "u-left", approval_status: "approved", suspended_at: null }],
    tc_profiles: [{ id: "u-soon", status: "active" }, { id: "u-left", status: "disabled" }],
    gw_retire_cases: [{ id: "c-soon", tenant_id: "t1", employee_id: "e-soon", reason_code: "personal", reason_note: "家庭の事情（社内メモ）", updated_at: "2026-10-02T00:00:00.000002+00:00" }],
    gw_retire_docs: [
      { id: "d-cert", tenant_id: "t1", employee_id: "e-soon", kind: "certificate", version: 1, state: "issued", published: true, published_at: "2026-10-03T00:00:00Z", issued_on: "2026-10-03", storage_path: "t1/retire/e-soon/certificate/x.pdf", note: "社内メモ" },
      { id: "d-wh", tenant_id: "t1", employee_id: "e-soon", kind: "withholding", version: 1, state: "issued", published: false, issued_on: "2026-10-03", storage_path: "p" },
    ],
    gw_assets: [
      { id: "a-pc", tenant_id: "t1", kind: "pc", name: "MacBook 01", identifier: "PC-001", assigned_to: "e-soon", assigned_on: "2025-04-01", status: "assigned" },
      { id: "a-key", tenant_id: "t1", kind: "key", name: "オフィスの鍵", identifier: null, assigned_to: "e-soon", assigned_on: "2025-04-01", status: "assigned" },
      { id: "a-mine", tenant_id: "t1", kind: "phone", name: "他の人の携帯", identifier: null, assigned_to: "e-member", status: "assigned" },
    ],
    gw_retire_asset_returns: [], gw_retire_accounts: [], gw_retire_events: [],
    gw_activity_log: [],
    gw_procedures: [{ id: "p-soon", tenant_id: "t1", employee_id: "e-soon", kind: "offboarding", target_on: NEXTWEEK }],
    gw_procedure_items: [
      { procedure_id: "p-soon", title: "退職届の提出", owner: "employee", status: "todo", due_on: NEXTWEEK, sort_order: 1 },
      { procedure_id: "p-soon", title: "社内の作業", owner: "hr", status: "todo", due_on: NEXTWEEK, sort_order: 2 },
    ],
  };
  // 対象者の貸与品は、全件を取ってから絞るのではなく、サーバーで絞る（ほかの人の 600 件を先に並べる）
  for (let i = 0; i < 600; i++) db.rows.gw_assets.unshift({ id: `a-x${i}`, tenant_id: "t1", kind: "other", name: `備品${i}`, assigned_to: "e-member", status: "assigned" });
}

