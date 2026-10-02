// 労働条件通知書のテスト用の道具。偽の DB（一意制約つき）・偽の Storage・偽の認証を差し込んで、本物のハンドラ
// （api/onboarding/notice.js・api/onboarding/start.js）を動かす。API のテストと、ブラウザの通しのテストが同じものを使う。
//
// ■ 先に import すること（mock.module は、ハンドラを import する前に効かせる必要がある）
// ■ 偽の Storage は、署名付きURLを作った記録（storage.signed）と、置いたファイル（storage.objects）を持つ
import assert from "node:assert/strict";
import { mock } from "node:test";
import crypto from "node:crypto";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const atRoot = (p) => _join(ROOT, p);

// ---- 偽の DB（列の絞り込み・一意制約つき）と、偽の Storage ----------------------------------------
export const db = { rows: {}, missing: new Set() };
let seq = 0;
const UNIQUE = { gw_labor_notices: [["employee_id", "version"]] };

function table(name) {
  const f = [];
  let patch = null, mode = "select", inserted = null, sortBy = null, cols = null, lim = null;
  const err = () => (db.missing.has(name) ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const match = (r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "neq") return r[k] !== v;
    if (op === "in") return Array.isArray(v) && v.includes(r[k]);
    if (op === "is") return (r[k] ?? null) === v;
    return true;
  });
  const rows = () => (db.rows[name] || []).filter(match);
  const project = (r) => {
    if (!r) return null;
    const c = JSON.parse(JSON.stringify(r));
    if (!cols || cols === "*" || !cols.split(",").every((x) => /^\s*[a-z_0-9]+\s*$/.test(x))) return c;
    const out = {};
    for (const k of cols.split(",").map((x) => x.trim())) if (k in c) out[k] = c[k];
    return out;
  };
  const run = () => {
    const e = err();
    if (e) return { data: null, error: e };
    if (mode === "insert") return inserted.error ? { data: null, error: inserted.error } : { data: inserted.rows.map(project), error: null };
    if (mode === "update") {
      const hit = rows();
      for (const r of hit) Object.assign(r, patch);
      return { data: hit.map(project), error: null };
    }
    if (mode === "delete") { db.rows[name] = (db.rows[name] || []).filter((r) => !match(r)); return { data: null, error: null }; }
    let out = rows();
    if (sortBy) out = [...out].sort((a, b) => (a[sortBy.col] < b[sortBy.col] ? -1 : a[sortBy.col] > b[sortBy.col] ? 1 : 0) * (sortBy.asc ? 1 : -1));
    if (lim != null) out = out.slice(0, lim);
    return { data: out.map(project), error: null };
  };
  const q = {
    select(c) { cols = c || cols; return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order(col, o) { sortBy = { col, asc: o?.ascending !== false }; return q; },
    limit(n) { lim = n; return q; },
    maybeSingle: () => { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] || null : null, error: r.error }); },
    single: () => { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] || null : null, error: r.error }); },
    insert(row) {
      mode = "insert";
      const list = (db.rows[name] = db.rows[name] || []);
      const made = [];
      let error = null;
      for (const r of [].concat(row)) {
        const m = { id: r.id || `${name}-${++seq}`, ...r };
        for (const keys of UNIQUE[name] || []) {
          if (list.some((x) => keys.every((k) => x[k] === m[k]))) error = { code: "23505", message: "duplicate key value violates unique constraint" };
        }
        if (error) break;
        // DB の既定値
        if (name === "gw_labor_notices") { m.uploaded_at = m.uploaded_at || new Date(Date.now() + seq).toISOString(); m.published_at ??= null; m.confirmed_at ??= null; }
        list.push(m); made.push(m);
      }
      inserted = { rows: made, error };
      return q;
    },
    update(p) { mode = "update"; patch = p; return q; },
    delete() { mode = "delete"; return q; },
    then: (fn, rej) => Promise.resolve(run()).then(fn, rej),
  };
  return q;
}

// 偽の Storage。置いたもの（objects）と、署名付きURLを作った記録（signed）を持つ
export const storage = { objects: new Map(), signed: [], removed: [] };
const bucket = (b) => ({
  createSignedUploadUrl: async (path) => ({ data: { signedUrl: `https://storage.test/upload/${b}/${path}?token=UP${++seq}`, token: `UP${seq}` }, error: null }),
  createSignedUrl: async (path, ttl, opts) => {
    storage.signed.push({ bucket: b, path, ttl, opts });
    if (!storage.objects.has(path)) return { data: null, error: { message: "Object not found" } };
    return { data: { signedUrl: `https://storage.test/sign/${b}/${path}?token=SECRET${seq++}` }, error: null };
  },
  download: async (path) => {
    const o = storage.objects.get(path);
    return o ? { data: { arrayBuffer: async () => o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength) }, error: null } : { data: null, error: { message: "not found" } };
  },
  remove: async (paths) => { for (const p of paths) { storage.objects.delete(p); storage.removed.push(p); } return { data: [], error: null }; },
});
const client = () => ({ from: table, storage: { from: bucket } });

mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: client, userClient: client } });
let who, whoUser;
/** いま誰としてログインしているか（偽の認証が見る）。ブラウザのテストは、リクエストごとに切り替える */
export const setPersona = (ctx, user) => { who = ctx; whoUser = user; };
mock.module(atRoot("lib/auth.js"), { namedExports: {
  requireUser: async (req, res) => {
    if (!whoUser) { res.statusCode = 401; res.end(JSON.stringify({ error: "unauthorized" })); return null; }
    return whoUser;
  },
  getMemberships: async () => [],
} });
export const logged = [];
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
export const notices = [];
mock.module(atRoot("lib/notify.js"), { namedExports: {
  notify: async (rows) => { notices.push(...rows); return { created: rows.length }; },
  clearNotification: async () => {},
} });
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

export const { default: adminApi } = await import(atRoot("api/onboarding/notice.js"));
export const { default: start } = await import(atRoot("api/onboarding/start.js"));
export const { CONSENT_DOCS } = await import(atRoot("lib/consent-docs.js"));

export const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
// ログインのトークンは、aal1（パスワードだけ）。二段階認証は要らない
const jwt = `h.${Buffer.from(JSON.stringify({ aal: "aal1" })).toString("base64url")}.s`;
export const H = { authorization: `Bearer ${jwt}`, host: "gw.example.com" };
export const adm = async (body, { method = "POST", url } = {}) => {
  const r = res();
  await adminApi({ method, url: url || "/api/onboarding/notice", headers: H, body }, r);
  return r;
};
export const admGet = (q) => adm(undefined, { method: "GET", url: `/api/onboarding/notice?${q}` });
export const me = async (body, { method = "POST" } = {}) => {
  const r = res();
  await start({ method, url: "/api/onboarding/start", headers: H, body }, r);
  return r;
};
export const meGet = () => me(undefined, { method: "GET" });


export const ctxOf = (id, roles, extra = {}) => ({
  tenantId: "t1", isAdmin: false, isHr: roles.includes("hr") || roles.includes("owner"), isAdvisor: roles.includes("labor_advisor"),
  roles, employee: { id, display_name: `人${id}`, email: `${id}@example.com`, user_id: `u-${id}`, department: "開発", position: "エンジニア" }, ...extra,
});
export const OWNER = ctxOf("own1", ["owner"]);
export const HR = ctxOf("hr1", ["hr"]);
export const HIRE = ctxOf("e1", [], { employee: { id: "e1", display_name: "山田 太郎", email: "hire@example.com", user_id: "u-e1", department: "開発", position: "エンジニア", joined_on: null } });
export const HIRE2 = ctxOf("e2", [], { employee: { id: "e2", display_name: "佐藤 花子", email: "e2@example.com", user_id: "u-e2" } });
export const asAdmin = (ctx = OWNER) => setPersona(ctx, { id: ctx.employee.user_id, email: ctx.employee.email });
export const asHire = (ctx = HIRE) => setPersona(ctx, { id: ctx.employee.user_id, email: ctx.employee.email });

export const T1 = "t1";
export const pdf = (n = 1) => Buffer.from(`%PDF-1.7\n% 労働条件通知書 ${n}\n${"x".repeat(200 * n)}`);
export const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

export function setup() {
  setPersona(OWNER, { id: "u-own1", email: "owner@example.com" });
  logged.length = 0; notices.length = 0; db.missing = new Set();
  storage.objects.clear(); storage.signed.length = 0; storage.removed.length = 0;
  const emp = (id, name, extra = {}) => ({ id, tenant_id: "t1", display_name: name, email: `${id}@example.com`, user_id: `u-${id}`,
    department: "開発", position: "エンジニア", initial_role: "バックエンド", joined_on: null, status: "invited", ...extra });
  db.rows = {
    tenants: [{ id: "t1", name: "株式会社エイト" }, { id: "t2", name: "他社" }],
    gw_employees: [
      emp("own1", "経営者", { status: "active" }), emp("hr1", "人事 花", { status: "active" }),
      emp("e1", "山田 太郎"), emp("e2", "佐藤 花子"), emp("eL", "退職 者", { status: "left" }), emp("eN", "口座なし", { user_id: null }),
      { ...emp("ex", "他社の人"), tenant_id: "t2" },
    ],
    gw_role_grants: [{ tenant_id: "t1", employee_id: "own1", role: "owner" }, { tenant_id: "t1", employee_id: "hr1", role: "hr" }],
    gw_procedures: [
      { id: "p1", tenant_id: "t1", employee_id: "e1", kind: "onboarding", status: "in_progress", target_on: "2026-10-01", stage: null, created_at: daysAgo(10), updated_at: daysAgo(1) },
      { id: "p2", tenant_id: "t1", employee_id: "e2", kind: "onboarding", status: "in_progress", target_on: "2026-10-01", stage: null, created_at: daysAgo(10), updated_at: daysAgo(1) },
    ],
    gw_procedure_items: [
      { id: "i1", procedure_id: "p1", item_key: "doc_id", owner: "employee", required: true, status: "todo", title: "本人確認書類" },
      { id: "i2", procedure_id: "p1", item_key: "pc", owner: "hr", required: true, status: "todo", title: "PC の準備（社内）" },
    ],
    gw_doc_orders: [], gw_sign_requests: [], gw_onboard_profiles: [], gw_onboard_consents: [], gw_consent_docs: [],
    gw_orientation_items: [], gw_orientation_checks: [], gw_employee_careers: [],
    gw_onboarding_guides: [], gw_onboarding_guide_issues: [], gw_onboarding_invites: [], gw_mail_messages: [],
    gw_labor_notices: [], gw_sensitive_access_log: [],
  };
}
// 管理者のアップロード（置き場所を出す → ブラウザが PUT する → 登録）。公開までは、しない
export async function put(employeeId, bytes, filename = "労働条件通知書.pdf", ctx = OWNER) {
  asAdmin(ctx);
  const up = await adm({ action: "upload", employeeId, mimeType: "application/pdf", sizeBytes: bytes.length });
  assert.equal(up.statusCode, 200, JSON.stringify(up.body));
  storage.objects.set(up.body.path, bytes);            // ブラウザが、署名付きURLへ PUT した
  const at = await adm({ action: "attach", employeeId, path: up.body.path, filename });
  assert.equal(at.statusCode, 200, JSON.stringify(at.body));
  return { path: up.body.path, state: at.body, row: db.rows.gw_labor_notices.find((r) => r.storage_path === up.body.path) };
}
export const publish = (employeeId, id, ctx = OWNER) => { asAdmin(ctx); return adm({ action: "publish", employeeId, id }); };
export const confirmIt = (version, ctx = HIRE) => { asHire(ctx); return me({ action: "confirm_notice", version }); };
// 誓約書などの同意（これまでの決まり。STEP2 は、通知書の確認に加えて、これも済んでいること）
export const agreeAll = (employeeId) => {
  for (const d of CONSENT_DOCS) db.rows.gw_onboard_consents.push({ employee_id: employeeId, kind: d.key, version: d.version, agreed_at: daysAgo(1) });
};
export const snapshotSign = () => JSON.stringify(db.rows.gw_sign_requests);
export const everything = () => JSON.stringify({ rows: db.rows, logged, notices });   // どこにも URL・トークンが残っていないことを見る

