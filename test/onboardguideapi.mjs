// 入社案内・案内URL・案内メール（api/keiei/onboarding.js）と、本人側（api/onboarding/start.js・guide.js）。
//
// ■ 何を守るテストか
//
//   経営者側（/api/keiei/onboarding）
//   1. 経営者だけ（二段階認証は要らない）。人事・管理者・責任者などは 403（案内も履歴も見えない）
//   2. 案内: 下書き保存（許した項目だけ・金額は断る）→ 発行（確定版・版が上がる・変化が無ければ断る）
//   3. 案内URL: 発行済みの案内だけ。トークンはDBに平文で残らない。新しいURLで前のURLは失効。応答にだけURLが出る
//   4. メール: 未設定なら実送信も履歴も作らない（URLをコピーして渡す）。プレビューは何も作らない。
//      送信・再送・テスト送信は履歴に1通ずつ残り、本文にパスワードを書かない。失敗も履歴に残る
//   本人側
//   5. 案内URLは、ログイン前に案内を読むだけ。失効・期限切れ・不正は開けない。案内は許した項目だけ
//   6. 本人の画面は、自分の分だけ・金額を返さない・社内準備の内訳を返さない。確認は本人だけができ、版が変われば確認し直し
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {}, missing: new Set() };
const logged = [];
let seq = 0;

function table(name) {
  const f = [];
  let patch = null, mode = "select", inserted = null, sortBy = null;
  const err = () => (db.missing.has(name) ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const match = (r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "neq") return r[k] !== v;
    if (op === "in") return Array.isArray(v) && v.includes(r[k]);
    if (op === "is") return (r[k] ?? null) === v;
    return true;
  });
  const rows = () => (db.rows[name] || []).filter(match);
  const copy = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);
  const run = () => {
    const e = err();
    if (e) return { data: null, error: e };
    if (mode === "insert") return { data: inserted.map(copy), error: null };
    if (mode === "update") {
      const hit = rows();
      for (const r of hit) Object.assign(r, patch);
      return { data: hit.map(copy), error: null };
    }
    if (mode === "delete") { db.rows[name] = (db.rows[name] || []).filter((r) => !match(r)); return { data: null, error: null }; }
    const out = rows().map(copy);
    if (sortBy) out.sort((a, b) => (a[sortBy.col] < b[sortBy.col] ? -1 : a[sortBy.col] > b[sortBy.col] ? 1 : 0) * (sortBy.asc ? 1 : -1));
    return { data: out, error: null };
  };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order(col, o) { sortBy = { col, asc: o?.ascending !== false }; return q; },
    limit() { return q; },
    maybeSingle: () => { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] || null : null, error: r.error }); },
    single: () => { const r = run(); return Promise.resolve({ data: r.data ? r.data[0] || null : null, error: r.error }); },
    insert(row) {
      mode = "insert";
      const list = (db.rows[name] = db.rows[name] || []);
      const uniq = { gw_onboarding_invites: "token_hash", gw_onboarding_guides: "employee_id" }[name];
      inserted = [];
      for (const r of [].concat(row)) {
        // 作った順が、時刻の順になるようにする（同じミリ秒でも並びが崩れない）
        const made = { id: r.id || `${name}-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...r };
        if (uniq && list.some((x) => x[uniq] === made[uniq])) { inserted = null; db.__dup = true; break; }
        if (name === "gw_onboarding_guide_issues" && list.some((x) => x.guide_id === made.guide_id && x.version === made.version)) { inserted = null; db.__dup = true; break; }
        list.push(made); inserted.push(made);
      }
      if (!inserted) { const p = Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } }); Object.assign(q, { then: p.then.bind(p) }); q.single = () => p; q.select = () => q; }
      else if (err()) { inserted = []; }
      return q;
    },
    update(p) { mode = "update"; patch = p; return q; },
    delete() { mode = "delete"; return q; },
    then: (fn, rej) => Promise.resolve(run()).then(fn, rej),
  };
  return q;
}
const client = () => ({ from: table });
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: client, userClient: client } });
let who, whoUser;
mock.module(atRoot("lib/auth.js"), { namedExports: {
  requireUser: async (req, res) => {
    if (!whoUser) { res.statusCode = 401; res.end(JSON.stringify({ error: "unauthorized" })); return null; }
    return whoUser;
  },
  getMemberships: async () => [],
} });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), { namedExports: { ...REAL_GW, gwContext: async () => who } });

const { default: keieiOnb } = await import(atRoot("api/keiei/onboarding.js"));
const { default: start } = await import(atRoot("api/onboarding/start.js"));
const { default: publicGuide } = await import(atRoot("api/onboarding/guide.js"));
const { CONSENT_DOCS } = await import(atRoot("lib/consent-docs.js"));

const jwt = (aal) => `h.${Buffer.from(JSON.stringify({ aal })).toString("base64url")}.s`;
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const HOST = { host: "gw.example.com" };
const owner = async (body, { aal = "aal2", method = "POST", url } = {}) => {
  const r = res();
  await keieiOnb({ method, url: url || "/api/keiei/onboarding", headers: { authorization: `Bearer ${jwt(aal)}`, ...HOST }, body }, r);
  return r;
};
const ownerGet = (q, opts) => owner(undefined, { method: "GET", url: `/api/keiei/onboarding?${q}`, ...opts });
const hire = async (body, { method = "POST", q = "" } = {}) => {
  const r = res();
  await start({ method, url: `/api/onboarding/start${q}`, headers: { authorization: `Bearer ${jwt("aal1")}`, ...HOST }, body }, r);
  return r;
};
const openPublic = async (t) => {
  const r = res();
  await publicGuide({ method: "GET", url: `/api/onboarding/guide?t=${encodeURIComponent(t)}`, headers: {} }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const ctxOf = (id, roles, extra = {}) => ({
  tenantId: "t1", isAdmin: false, isHr: roles.includes("hr") || roles.includes("owner"), isAdvisor: false,
  roles, employee: { id, display_name: `人${id}`, email: `${id}@example.com`, user_id: `u-${id}`, department: "開発", position: "エンジニア" }, ...extra,
});
const OWNER = ctxOf("own1", ["owner"]);
const HIRE = ctxOf("e1", [], { employee: { id: "e1", display_name: "山田 太郎", email: "hire@example.com", user_id: "u-e1", department: "開発", position: "エンジニア", joined_on: null } });
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

// メール設定（環境変数）。実送信の代わりに、fetch を差し替える
const MAIL_ENV = { MAIL_PROVIDER: "resend", HR_ONBOARDING_FROM: "エイト 人事 <hr@example.com>", RESEND_API_KEY: "re_test", MAIL_SEND_ENABLED: "1" };
const ENV_KEYS = [...Object.keys(MAIL_ENV), "MAIL_REPLY_TO", "PUBLIC_BASE_URL"];
const realFetch = globalThis.fetch;
let fetchCalls = [];
const setMail = (on, { fail: failIt = false } = {}) => {
  for (const k of ENV_KEYS) delete process.env[k];
  if (on) Object.assign(process.env, MAIL_ENV);
  fetchCalls = [];
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init });
    return failIt ? { ok: false, status: 500, json: async () => ({ message: "boom" }) } : { ok: true, json: async () => ({ id: `re-${fetchCalls.length}` }) };
  };
};

function setup() {
  who = OWNER; whoUser = { id: "u-own1", email: "owner@example.com", factors: [{ status: "verified", factor_type: "totp" }] };
  logged.length = 0; db.missing = new Set(); db.__dup = false; setMail(false);
  const emp = (id, name, extra = {}) => ({ id, tenant_id: "t1", display_name: name, email: `${id}@example.com`, user_id: `u-${id}`,
    department: "開発", position: "エンジニア", initial_role: "バックエンド", joined_on: null, status: "invited", ...extra });
  db.rows = {
    tenants: [{ id: "t1", name: "株式会社エイト" }, { id: "t2", name: "他社" }],
    gw_employees: [
      emp("own1", "経営者", { status: "active", email: "owner@example.com" }),
      emp("e1", "山田 太郎", { email: "hire@example.com" }),
      emp("e2", "佐藤 花子"), emp("eL", "退職 者", { status: "left" }),
      { ...emp("ex", "他社の人"), tenant_id: "t2" },
    ],
    gw_role_grants: [{ tenant_id: "t1", employee_id: "own1", role: "owner" }],
    gw_procedures: [{ id: "p1", tenant_id: "t1", employee_id: "e1", kind: "onboarding", status: "in_progress", target_on: "2026-10-01",
      stage: null, created_at: daysAgo(10), updated_at: daysAgo(1) }],
    gw_procedure_items: [
      { id: "i1", procedure_id: "p1", item_key: "doc_id", owner: "employee", required: true, status: "todo", title: "本人確認書類" },
      { id: "i2", procedure_id: "p1", item_key: "pc", owner: "hr", required: true, status: "todo", title: "PC の準備（社内）" },
    ],
    gw_doc_orders: [], gw_sign_requests: [], gw_onboard_profiles: [], gw_onboard_consents: [], gw_consent_docs: [],
    gw_orientation_items: [], gw_orientation_checks: [], gw_employee_careers: [],
    gw_onboarding_guides: [], gw_onboarding_guide_issues: [], gw_onboarding_invites: [], gw_mail_messages: [],
  };
}
const F = { meeting_time: "9:45", start_time: "10:00", location: "原宿オフィス", schedule: "会社説明\nPC受取", belongings: "印鑑", contact: "03-0000-0000", staff: "人事 山田", message: "ようこそ" };
const save = (fields, employeeId = "e1") => owner({ action: "save_guide", employeeId, fields });
const issue = (employeeId = "e1") => owner({ action: "issue_guide", employeeId });
const invite = (extra = {}) => owner({ action: "create_invite", employeeId: "e1", ...extra });
const tokenOf = (url) => new URL(url).searchParams.get("t");

console.log("\n=== 経営者だけ（二段階認証は要らない） ===\n");

await ok("人事・管理者・責任者・採用担当・経理・営業・一般は、読めない・書けない（403）", async () => {
  setup();
  const others = [ctxOf("h", ["hr"]), ctxOf("a", [], { isAdmin: true }), ctxOf("m", ["manager"]), ctxOf("r", ["recruiter"]),
    ctxOf("f", ["finance"]), ctxOf("s", ["sales"]), ctxOf("x", [])];
  for (const c of others) {
    who = c;
    assert.equal((await ownerGet("employeeId=e1")).statusCode, 403, `GET ${c.roles}`);
    const r = await save(F);
    assert.equal(r.statusCode, 403, `POST ${c.roles}`);
    assert.deepEqual(db.rows.gw_onboarding_guides, []);
  }
});

await ok("経営者なら、二段階認証（aal2）が済んでいなくても（aal1）、開けて・書ける。mfa_required は返らない", async () => {
  setup();
  const g = await ownerGet("employeeId=e1", { aal: "aal1" });
  assert.equal(g.statusCode, 200); assert.notEqual(g.body.error, "mfa_required");
  const r = await owner({ action: "save_guide", employeeId: "e1", fields: F }, { aal: "aal1" });
  assert.equal(r.statusCode, 200);
  assert.notEqual(r.body.error, "mfa_required");
});

await ok("知らない action・employeeId なし・他社・退職者・存在しない人", async () => {
  setup();
  assert.equal((await owner({ action: "nope", employeeId: "e1" })).statusCode, 400);
  assert.equal((await owner({ action: "save_guide" })).statusCode, 400);
  assert.equal((await save(F, "ex")).statusCode, 404, "他社の人は開けない");
  assert.equal((await save(F, "nobody")).statusCode, 404);
  assert.equal((await save(F, "eL")).statusCode, 409, "退職者");
  assert.equal((await ownerGet("")).statusCode, 400);
  assert.equal((await ownerGet("employeeId=ex")).statusCode, 404);
});

console.log("\n=== 案内の作成・発行 ===\n");

await ok("下書き保存: 許した項目だけ。知らない項目・版・確認日時は書き換えられない", async () => {
  setup();
  const r = await save({ ...F, version: 9, confirmed_version: 9, employee_id: "e2", tenant_id: "t2", wage_amount: 1 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const g = db.rows.gw_onboarding_guides[0];
  assert.equal(g.employee_id, "e1");
  assert.equal(g.tenant_id, "t1");
  assert.equal(g.location, "原宿オフィス");
  assert.ok(!("version" in g) || g.version === undefined || g.version === 0, "版は書き換えられない");
  assert.ok(g.confirmed_version == null);
  assert.equal(r.body.guide.draft.location, "原宿オフィス");
  assert.equal(r.body.guide.autofill.name, "山田 太郎");
  assert.equal(r.body.guide.autofill.joinOn, "2026-10-01", "入社日は入社手続きから");
  assert.equal(logged.at(-1).action, "onboarding.guide_save");
});

await ok("金額を書いた項目は、保存を断る（400 money_in_guide）。何も保存されない", async () => {
  setup();
  const r = await save({ location: "原宿", message: "月給30万円です" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "money_in_guide");
  assert.equal(r.body.field, "message");
  assert.deepEqual(db.rows.gw_onboarding_guides, []);
});

await ok("発行: 確定版を残し、版が1に。名簿・手続きの値が入る。給与・メールは入らない", async () => {
  setup(); await save(F);
  const r = await issue();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.guide.version, 1);
  const s = db.rows.gw_onboarding_guide_issues[0];
  assert.equal(s.version, 1);
  assert.equal(s.snapshot.name, "山田 太郎");
  assert.equal(s.snapshot.joinOn, "2026-10-01");
  assert.equal(s.snapshot.location, "原宿オフィス");
  const text = JSON.stringify(s.snapshot);
  assert.ok(!/hire@example|wage|user_id|email/.test(text), text);
  assert.equal(r.body.six.steps.find((x) => x.key === "guide").state, "current", "本人の確認待ち");
  assert.equal(r.body.guide.dirty, false);
  assert.equal(logged.at(-1).action, "onboarding.guide_issue");
});

await ok("下書きが無くても発行できる（空の案内）。変化が無ければ、もう一度は発行できない（409）", async () => {
  setup();
  assert.equal((await issue()).statusCode, 200);
  const again = await issue();
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.error, "no_changes");
  assert.equal(db.rows.gw_onboarding_guide_issues.length, 1);
});

await ok("下書きを直すと dirty。発行し直すと版が2になり、本人は確認し直し（前の版の確認は数えない）", async () => {
  setup(); await save(F); await issue();
  db.rows.gw_onboarding_guides[0].confirmed_version = 1;
  db.rows.gw_onboarding_guides[0].confirmed_at = daysAgo(1);
  const d = await save({ location: "渋谷オフィス" });
  assert.equal(d.body.guide.dirty, true, "発行したものと、下書きが違う");
  assert.equal(d.body.guide.issued.view.location, "原宿オフィス", "本人が見ているのは、発行済みの版のまま");
  const r = await issue();
  assert.equal(r.body.guide.version, 2);
  assert.equal(r.body.guide.issued.view.location, "渋谷オフィス");
  assert.equal(r.body.six.steps.find((x) => x.key === "guide").state, "current", "版が上がったので、確認し直し");
  assert.equal(db.rows.gw_onboarding_guide_issues.length, 2, "前の版も残る");
});

await ok("案内の表（db/104）が無ければ 503。画面は「作られていません」と出せる", async () => {
  setup(); db.missing = new Set(["gw_onboarding_guides"]);
  const r = await save(F);
  assert.equal(r.statusCode, 503);
  assert.match(r.body.message, /db\/104/);
  const d = await ownerGet("employeeId=e1");
  assert.equal(d.statusCode, 200);
  assert.equal(d.body.guide.linked, false);
  assert.equal(d.body.six.steps.find((x) => x.key === "guide").state, "unlinked");
});

console.log("\n=== 案内URL ===\n");

await ok("発行前は、URLを作れない（409）", async () => {
  setup(); await save(F);
  const r = await invite();
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "guide_not_issued");
  assert.deepEqual(db.rows.gw_onboarding_invites, []);
});

await ok("URLを作る: 応答にだけURLが出る。DB にはハッシュだけで、トークンは平文で残らない", async () => {
  setup(); await save(F); await issue();
  const r = await invite();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.match(r.body.invite.url, /^https:\/\/gw\.example\.com\/onboarding\/\?t=[A-Za-z0-9_-]{32,}$/);
  const token = tokenOf(r.body.invite.url);
  const rows = db.rows.gw_onboarding_invites;
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].token_hash, token);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(db.rows).includes(token), "トークンが DB のどこかに平文で残っている");
  assert.ok(!JSON.stringify(logged).includes(token), "トークンが操作ログに残っている");
  // 一覧・詳細には、URLもトークンも出ない
  const d = await ownerGet("employeeId=e1");
  assert.ok(!JSON.stringify(d.body).includes(token));
  assert.equal(d.body.invites.length, 1);
  assert.equal(d.body.invites[0].status, "active");
  assert.ok(!("url" in d.body.invites[0]) && !("token" in d.body.invites[0]) && !("tokenHash" in d.body.invites[0]));
});

await ok("有効期限は既定7日。1〜30日に収まる", async () => {
  setup(); await save(F); await issue();
  const a = await invite();
  const days = (Date.parse(a.body.invite.expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, String(days));
  const b = await invite({ days: 500 });
  assert.ok((Date.parse(b.body.invite.expiresAt) - Date.now()) / 86400000 < 30.1);
});

await ok("新しいURLを作ると、前のURLは失効する。失効したURLは、本人が開けない", async () => {
  setup(); await save(F); await issue();
  const t1 = tokenOf((await invite()).body.invite.url);
  assert.equal((await openPublic(t1)).statusCode, 200);
  const t2 = tokenOf((await invite()).body.invite.url);
  assert.equal((await openPublic(t1)).statusCode, 404, "前のURLは開けない");
  assert.equal((await openPublic(t2)).statusCode, 200);
  assert.equal(db.rows.gw_onboarding_invites.filter((i) => !i.revoked_at).length, 1);
});

await ok("入社が取り消された（退職済み）方: 案内は作れない・URLは開けない。ただし、出したURLの失効はできる", async () => {
  setup(); await save(F); await issue();
  const t = tokenOf((await invite()).body.invite.url);
  db.rows.gw_employees.find((e) => e.id === "e1").status = "left";
  assert.equal((await save(F)).statusCode, 409);
  assert.equal((await invite()).statusCode, 409);
  assert.equal((await openPublic(t)).statusCode, 404, "期限内でも、開けない");
  const id = db.rows.gw_onboarding_invites[0].id;
  const r = await owner({ action: "revoke_invite", employeeId: "e1", inviteId: id });
  assert.equal(r.statusCode, 200, "失効はできる");
  assert.equal(db.rows.gw_onboarding_invites[0].revoked_at != null, true);
});

await ok("URLを失効させる（revoke_invite）。ほかの人のURLは失効させない", async () => {
  setup(); await save(F); await issue();
  const t = tokenOf((await invite()).body.invite.url);
  const id = db.rows.gw_onboarding_invites[0].id;
  assert.equal((await owner({ action: "revoke_invite", employeeId: "e2", inviteId: id })).statusCode, 404, "別の人の画面からは失効できない");
  assert.equal((await openPublic(t)).statusCode, 200);
  const r = await owner({ action: "revoke_invite", employeeId: "e1", inviteId: id });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.invites[0].status, "revoked");
  assert.equal((await openPublic(t)).statusCode, 404);
  assert.equal((await owner({ action: "revoke_invite", employeeId: "e1", inviteId: id })).statusCode, 404, "失効済みをもう一度は失効できない");
});

console.log("\n=== メール（提供元に依存しない・未設定なら送らない）===\n");

await ok("未設定: プレビューは出る。何も作らない。送信・テスト送信は 409 mail_not_configured（履歴も作らない）", async () => {
  setup(); await save(F); await issue(); setMail(false);
  const p = await owner({ action: "preview_mail", employeeId: "e1" });
  assert.equal(p.statusCode, 200);
  assert.equal(p.body.preview.configured, false);
  assert.match(p.body.preview.reason, /MAIL_PROVIDER/);
  assert.equal(p.body.preview.to, "hire@example.com");
  assert.match(p.body.preview.body, /送信時に、この人だけの期限つきURL/);
  assert.equal(p.body.preview.guideView.location, "原宿オフィス");
  assert.deepEqual(db.rows.gw_onboarding_invites, [], "プレビューでURLを作らない");
  for (const action of ["send_mail", "test_mail"]) {
    const r = await owner({ action, employeeId: "e1" });
    assert.equal(r.statusCode, 409, action);
    assert.equal(r.body.error, "mail_not_configured");
    assert.match(r.body.hint, /案内URL/);
  }
  assert.equal(fetchCalls.length, 0, "実送信していない");
  assert.deepEqual(db.rows.gw_mail_messages, []);
  assert.deepEqual(db.rows.gw_onboarding_invites, [], "未設定では、URLも作らない");
  const d = await ownerGet("employeeId=e1");
  assert.equal(d.body.mail.config.configured, false);
  assert.equal(d.body.mail.canTest, false);
  assert.ok(!JSON.stringify(d.body.mail.config).includes("re_test"));
});

await ok("未設定でも、URLの発行（コピー用）はできる", async () => {
  setup(); await save(F); await issue(); setMail(false);
  const r = await invite();
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.invite.url);
  assert.equal(fetchCalls.length, 0);
});

await ok("MAIL_SEND_ENABLED が無ければ、設定がそろっていても送らない", async () => {
  setup(); await save(F); await issue(); setMail(true); delete process.env.MAIL_SEND_ENABLED;
  const r = await owner({ action: "send_mail", employeeId: "e1" });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.hint, /MAIL_SEND_ENABLED/);
  assert.equal(fetchCalls.length, 0);
});

await ok("発行前は送れない（409）。名簿にメールが無い・形式が違う人へも送らない", async () => {
  setup(); await save(F); setMail(true);
  assert.equal((await owner({ action: "send_mail", employeeId: "e1" })).body.error, "guide_not_issued");
  await issue();
  db.rows.gw_employees.find((e) => e.id === "e1").email = "not-an-address";
  const r = await owner({ action: "send_mail", employeeId: "e1" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "no_recipient");
  assert.equal(fetchCalls.length, 0);
});

await ok("送信: 本人あて・送信元は環境変数・URL入りの本文。履歴に確定版が残る。パスワードは書かない", async () => {
  setup(); await save(F); await issue(); setMail(true);
  const r = await owner({ action: "send_mail", employeeId: "e1" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.result.status, "sent");
  assert.equal(fetchCalls.length, 1);
  const sent = JSON.parse(fetchCalls[0].init.body);
  assert.equal(sent.from, "エイト 人事 <hr@example.com>", "送信元は環境変数のとおり");
  assert.deepEqual(sent.to, ["hire@example.com"]);
  assert.equal(sent.subject, "【株式会社エイト】ご入社にあたってのご案内");
  assert.match(sent.text, /10月1日のご入社に向けて/);
  const url = sent.text.match(/https:\/\/gw\.example\.com\/onboarding\/\?t=[A-Za-z0-9_-]+/)[0];
  assert.equal((await openPublic(tokenOf(url))).statusCode, 200, "メールのURLで案内が開く");
  assert.ok(!/パスワードは[^、]*[:：]|password\s*[:=]/i.test(sent.text));
  assert.match(sent.text, /ID・パスワード）は、このメールには書いていません/);
  assert.ok(!/[0-9][0-9,]*円|給与|手当/.test(sent.text));
  const m = db.rows.gw_mail_messages[0];
  assert.equal(m.status, "sent");
  assert.equal(m.kind, "send");
  assert.equal(m.to_email, "hire@example.com");
  assert.equal(m.provider, "resend");
  assert.equal(m.sent_by, "u-own1");
  assert.equal(m.guide_version, 1);
  const token = url.match(/t=([A-Za-z0-9_-]+)/)[1];
  assert.equal(m.body_text, sent.text.split(token).join("〈トークンは保存しません〉"), "履歴の本文は、送った文面のまま。ただしトークンだけは保存しない");
  assert.ok(!JSON.stringify(db.rows).includes(token), "トークンが DB のどこかに平文で残っている（メール履歴を含む）");
  assert.ok(!JSON.stringify(logged).includes(token), "トークンが操作ログに残っている");
  assert.ok(m.invite_id && db.rows.gw_onboarding_invites.some((i) => i.id === m.invite_id), "どのURLだったかは invite_id で分かる");
  assert.equal(r.body.mail.history[0].label, "送信");
  assert.ok(!("body" in r.body.mail.history[0]) && !("body_text" in r.body.mail.history[0]), "一覧に本文は出ない");
  assert.equal(logged.at(-1).action, "onboarding.mail_send");
});

await ok("再送: 新しいURL・1通ずつ履歴。前のURLは失効。2通目は「再送」", async () => {
  setup(); await save(F); await issue(); setMail(true);
  await owner({ action: "send_mail", employeeId: "e1" });
  const first = fetchCalls[0].init.body.match(/t=([A-Za-z0-9_-]+)/)[1];
  const r = await owner({ action: "send_mail", employeeId: "e1" });
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows.gw_mail_messages.length, 2);
  assert.deepEqual(r.body.mail.history.map((h) => h.label), ["再送", "送信"], "新しい順");
  assert.equal((await openPublic(first)).statusCode, 404, "前のメールのURLは失効している");
  assert.equal(db.rows.gw_onboarding_invites.filter((i) => !i.revoked_at).length, 1);
});

await ok("再送に失敗しても、すでに届いているURLは失効させない（成功したあとで、前のURLを失効させる）", async () => {
  setup(); await save(F); await issue(); setMail(true);
  await owner({ action: "send_mail", employeeId: "e1" });
  const delivered = fetchCalls[0].init.body.match(/t=([A-Za-z0-9_-]+)/)[1];
  assert.equal((await openPublic(delivered)).statusCode, 200);
  setMail(true, { fail: true });
  const r = await owner({ action: "send_mail", employeeId: "e1" });
  assert.equal(r.statusCode, 502);
  assert.equal((await openPublic(delivered)).statusCode, 200, "届いているURLは、生きている");
  setMail(true);
  const ok2 = await owner({ action: "send_mail", employeeId: "e1" });
  assert.equal(ok2.statusCode, 200);
  assert.equal((await openPublic(delivered)).statusCode, 404, "新しいメールが送れたので、前のURLは失効");
});

await ok("送信に失敗: 502。履歴に failed と理由が残る。URLは有効のまま（届いている可能性があるため）", async () => {
  setup(); await save(F); await issue(); setMail(true, { fail: true });
  const r = await owner({ action: "send_mail", employeeId: "e1" });
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.error, "mail_failed");
  assert.match(r.body.hint, /500/);
  assert.match(r.body.hint, /案内URLをコピー/);
  const m = db.rows.gw_mail_messages[0];
  assert.equal(m.status, "failed");
  assert.match(m.error, /boom/);
  assert.ok(!JSON.stringify(m).includes("re_test"), "鍵が履歴に残っている");
  assert.equal(db.rows.gw_onboarding_invites.filter((i) => !i.revoked_at).length, 1);
});

await ok("テスト送信: 宛先は経営者自身。件名に【テスト】。本人に渡したURLは失効させない。履歴は kind=test", async () => {
  setup(); await save(F); await issue(); setMail(true);
  const t = tokenOf((await invite()).body.invite.url);
  const r = await owner({ action: "test_mail", employeeId: "e1" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const sent = JSON.parse(fetchCalls.at(-1).init.body);
  assert.deepEqual(sent.to, ["owner@example.com"], "本人ではなく、経営者あて");
  assert.match(sent.subject, /^【テスト】/);
  assert.match(sent.text, /テスト送信/);
  assert.equal((await openPublic(t)).statusCode, 200, "本人に渡したURLは、生きている");
  const m = db.rows.gw_mail_messages.at(-1);
  assert.equal(m.kind, "test");
  assert.equal(m.to_email, "owner@example.com");
  const ttoken = sent.text.match(/t=([A-Za-z0-9_-]+)/)[1];
  assert.ok(!JSON.stringify(db.rows.gw_mail_messages).includes(ttoken), "テスト送信の履歴にも、トークンは残らない");
  assert.equal(r.body.mail.history[0].label, "テスト");
  // テストは「送信」の回数に数えない（次の本送信は「送信」）
  const s = await owner({ action: "send_mail", employeeId: "e1" });
  assert.deepEqual(s.body.mail.history.map((h) => h.label), ["送信", "テスト"]);
});

await ok("履歴の本文（確定版）は、経営者が個別に開ける。別の人の履歴は開けない", async () => {
  setup(); await save(F); await issue(); setMail(true);
  await owner({ action: "send_mail", employeeId: "e1" });
  const id = db.rows.gw_mail_messages[0].id;
  const r = await ownerGet(`employeeId=e1&mailId=${id}`);
  assert.equal(r.statusCode, 200);
  assert.match(r.body.mail.body, /入社準備を始める/);
  assert.match(r.body.mail.body, /onboarding\/\?t=〈トークンは保存しません〉/, "本文を開いても、トークンは出ない");
  assert.equal((await ownerGet(`employeeId=e2&mailId=${id}`)).statusCode, 404);
});

console.log("\n=== 案内URL（本人・ログイン前）===\n");

await ok("開ける: 案内の許した項目だけ。ID・メール・金額・トークンは返らない。開いた記録が残る", async () => {
  setup();
  db.rows.gw_employees.find((e) => e.id === "e1").wage_amount = 999999;
  await save(F); await issue();
  const t = tokenOf((await invite()).body.invite.url);
  const r = await openPublic(t);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.body.companyName, "株式会社エイト");
  assert.equal(r.body.guide.name, "山田 太郎");
  assert.equal(r.body.guide.location, "原宿オフィス");
  assert.equal(r.body.version, 1);
  const text = JSON.stringify(r.body);
  for (const leaked of ["e1", "hire@example", "999999", "wage", "user_id", "own1", t]) assert.ok(!text.includes(leaked), `${leaked} が返っている`);
  const inv = db.rows.gw_onboarding_invites[0];
  assert.ok(inv.first_opened_at);
  assert.equal(inv.open_count, 1);
  await openPublic(t);
  assert.equal(db.rows.gw_onboarding_invites[0].open_count, 2);
  assert.equal(db.rows.gw_onboarding_invites[0].first_opened_at, inv.first_opened_at, "初回の時刻は変わらない");
});

await ok("不正・存在しない・失効・案内なしは、理由を問わず「開けません」（404）。期限切れだけ 410", async () => {
  setup(); await save(F); await issue();
  const t = tokenOf((await invite()).body.invite.url);
  for (const bad of ["", "short", "x".repeat(40), "../../etc/passwd", "a b c"]) {
    const r = await openPublic(bad);
    assert.equal(r.statusCode, 404, bad);
    assert.equal(r.body.error, "invalid_token");
  }
  db.rows.gw_onboarding_invites[0].expires_at = daysAgo(1);
  const e = await openPublic(t);
  assert.equal(e.statusCode, 410);
  assert.equal(e.body.error, "expired");
  db.rows.gw_onboarding_invites[0].expires_at = new Date(Date.now() + 86400000).toISOString();
  db.rows.gw_onboarding_guides[0].version = 0;
  assert.equal((await openPublic(t)).statusCode, 404, "案内が取り下げられた（版0）");
});

await ok("案内を出し直すと、同じURLで新しい版が見える", async () => {
  setup(); await save(F); await issue();
  const t = tokenOf((await invite()).body.invite.url);
  await save({ location: "渋谷" }); await issue();
  const r = await openPublic(t);
  assert.equal(r.body.version, 2);
  assert.equal(r.body.guide.location, "渋谷");
});

await ok("POST など GET 以外は 405。表が無ければ 503", async () => {
  setup();
  const r = res();
  await publicGuide({ method: "POST", url: "/api/onboarding/guide?t=x", headers: {} }, r);
  assert.equal(r.statusCode, 405);
  db.missing = new Set(["gw_onboarding_invites"]);
  assert.equal((await openPublic("a".repeat(43))).statusCode, 503);
});

console.log("\n=== 本人の画面（ログイン後）===\n");

const asHire = () => { who = HIRE; whoUser = { id: "u-e1", email: "hire@example.com", factors: [] }; };
const step = (d, k) => d.six.steps.find((s) => s.key === k);

await ok("ログインしていない・社員名簿に無い人は入れない", async () => {
  setup(); whoUser = null;
  assert.equal((await hire(undefined, { method: "GET" })).statusCode, 401);
  who = { ...HIRE, employee: null }; whoUser = { id: "u-z", email: "z@example.com", factors: [] };
  const r = await hire(undefined, { method: "GET" });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "no_employee");
});

await ok("案内が無い本人: 6ステップ。① は「対象外」、② 雇用契約が「会社が準備中」。金額・社内準備の内訳は返らない", async () => {
  setup(); asHire();
  const r = await hire(undefined, { method: "GET" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.deepEqual(d.six.steps.map((s) => s.label), ["入社案内確認", "雇用契約", "入社情報入力", "必要書類提出", "会社確認", "入社準備完了"]);
  assert.equal(d.employee.name, "山田 太郎");
  assert.equal(d.employee.joinOn, "2026-10-01");
  assert.equal(d.guide.issued, false);
  assert.equal(step(d, "guide").state, "na");
  assert.equal(step(d, "contract").state, "current");
  assert.equal(step(d, "contract").note, "会社が労働条件通知書を準備しています");
  assert.equal(step(d, "contract").cta, null, "本人の操作は要らない");
  assert.equal(d.six.next.actor, "owner");
  assert.equal(d.hasProcedure, true);
  const text = JSON.stringify(d);
  for (const leaked of ["wage", "salary", "給与", "PC の準備", "hire@example", "user_id"]) assert.ok(!text.includes(leaked), `${leaked} が返っている`);
});

await ok("入社手続きがまだ無い本人: hasProcedure=false。完了とは言わない", async () => {
  setup(); asHire();
  db.rows.gw_procedures = [];
  const d = (await hire(undefined, { method: "GET" })).body;
  assert.equal(d.hasProcedure, false);
  assert.equal(d.six.complete, false);
  assert.equal(step(d, "contract").state, "unlinked");
});

await ok("案内が届いたら、① が本人の番（次にやること）。案内の本文は、発行済みの版のもの", async () => {
  setup(); await save(F); await issue();
  asHire();
  const d = (await hire(undefined, { method: "GET" })).body;
  assert.equal(d.guide.issued, true);
  assert.equal(d.guide.confirmed, false);
  assert.equal(d.guide.view.location, "原宿オフィス");
  assert.equal(step(d, "guide").state, "current");
  assert.deepEqual(step(d, "guide").cta, { label: "入社案内を確認する", action: "guide" });
  assert.equal(d.six.next.key, "guide");
});

await ok("契約の署名待ちは /contracts.html、締結後は入力・書類へ。既存の画面へ送る（作り直さない）", async () => {
  setup(); asHire();
  db.rows.gw_doc_orders = [{ employee_id: "e1", doc_kind: "employment", status: "sent", updated_at: daysAgo(1) }];
  db.rows.gw_sign_requests = [{ employee_id: "e1", doc_kind: "employment", status: "sent", sent_at: daysAgo(1) }];
  let d = (await hire(undefined, { method: "GET" })).body;
  assert.equal(step(d, "contract").cta.href, "/contracts.html");
  assert.equal(d.six.next.key, "contract");
  db.rows.gw_sign_requests[0].status = "signed";
  db.rows.gw_doc_orders[0].status = "signed";
  db.rows.gw_onboard_consents = CONSENT_DOCS.map((c) => ({ employee_id: "e1", kind: c.key, version: c.version, agreed_at: daysAgo(0) }));
  d = (await hire(undefined, { method: "GET" })).body;
  assert.equal(step(d, "contract").state, "done");
  assert.equal(step(d, "info").cta.href, "/onboarding.html#step-3");
  assert.equal(step(d, "docs").cta.href, "/onboarding.html#step-4");
  assert.equal(step(d, "company").state, "current");
  assert.equal(step(d, "company").cta, null, "会社の作業に、本人のボタンは出ない");
  assert.equal(step(d, "company").note, "会社が準備・確認しています");
  assert.deepEqual(step(d, "company").detail, []);
});

await ok("確認: 本人が押すと確認済み（日時が残る）。二重に押しても最初の日時のまま。操作ログが残る", async () => {
  setup(); await save(F); await issue(); asHire();
  const r = await hire({ action: "confirm_guide", version: 1 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.guide.confirmed, true);
  assert.equal(step(r.body, "guide").state, "done");
  const at = db.rows.gw_onboarding_guides[0].confirmed_at;
  assert.ok(at);
  assert.equal(logged.at(-1).action, "onboarding.guide_confirm");
  const again = await hire({ action: "confirm_guide", version: 1 });
  assert.equal(again.statusCode, 200);
  assert.equal(db.rows.gw_onboarding_guides[0].confirmed_at, at, "最初の確認日時を残す");
  assert.equal(logged.filter((l) => l.action === "onboarding.guide_confirm").length, 1);
});

await ok("確認できないもの: 案内なし・版が古い（読んでいる間に出し直された）・知らない action・版の指定なし", async () => {
  setup(); asHire();
  assert.equal((await hire({ action: "confirm_guide", version: 1 })).body.error, "guide_not_issued");
  who = OWNER; whoUser = { id: "u-own1", email: "owner@example.com", factors: [{ status: "verified", factor_type: "totp" }] };
  await save(F); await issue(); await save({ location: "渋谷" }); await issue();
  asHire();
  const stale = await hire({ action: "confirm_guide", version: 1 });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.error, "version_changed");
  assert.equal(db.rows.gw_onboarding_guides[0].confirmed_version ?? null, null);
  assert.equal((await hire({ action: "confirm_guide" })).statusCode, 409);
  assert.equal((await hire({ action: "confirm_guide", version: "2; drop" })).statusCode, 409);
  assert.equal((await hire({ action: "nope" })).statusCode, 400);
  assert.equal((await hire({ action: "confirm_guide", version: 2 })).statusCode, 200);
});

await ok("確認できるのは本人だけ。ほかの人の案内は確認できない・読めない", async () => {
  setup(); await save(F); await issue();       // e1 の案内
  who = ctxOf("e2", [], { employee: { id: "e2", display_name: "佐藤 花子", email: "e2@example.com", user_id: "u-e2" } });
  whoUser = { id: "u-e2", email: "e2@example.com", factors: [] };
  const d = (await hire(undefined, { method: "GET" })).body;
  assert.equal(d.guide.issued, false, "e2 に e1 の案内は見えない");
  assert.equal(d.employee.name, "佐藤 花子");
  assert.equal((await hire({ action: "confirm_guide", version: 1 })).body.error, "guide_not_issued");
  assert.equal(db.rows.gw_onboarding_guides[0].confirmed_version ?? null, null);
});

await ok("案内URL（t）付きでログイン: 別の人のURLなら 403 wrong_account。自分のURLなら通る", async () => {
  setup(); await save(F); await issue();
  const t = tokenOf((await invite()).body.invite.url);
  asHire();
  assert.equal((await hire(undefined, { method: "GET", q: `?t=${t}` })).statusCode, 200);
  who = ctxOf("e2", [], { employee: { id: "e2", display_name: "佐藤 花子", email: "e2@example.com", user_id: "u-e2" } });
  whoUser = { id: "u-e2", email: "e2@example.com", factors: [] };
  const r = await hire(undefined, { method: "GET", q: `?t=${t}` });
  assert.equal(r.statusCode, 403);
  assert.equal(r.body.error, "wrong_account");
  assert.ok(!JSON.stringify(r.body).includes("山田"), "別の人の名前を返さない");
});

await ok("すべて済むと「入社準備完了」。キャリアは次の一手（ステップに入れない）。案内が未確認なら完了にしない", async () => {
  setup(); asHire();
  db.rows.gw_procedures[0].status = "done";
  let d = (await hire(undefined, { method: "GET" })).body;
  assert.equal(d.six.complete, true);
  assert.equal(d.six.next.label, "入社準備完了");
  assert.equal(d.six.after.label, "キャリア設定待ち");
  assert.equal(d.six.after.cta, null, "上長の番。本人のボタンは出ない");
  db.rows.gw_employee_careers = [{ employee_id: "e1", tenant_id: "t1", is_active: true, track_id: "t", current_level_id: "l",
    one_year_target_note: "a", three_year_target_note: "b", next_review_on: "2027-04-01", confirm_requested_at: daysAgo(1), employee_confirmed_at: null }];
  d = (await hire(undefined, { method: "GET" })).body;
  assert.equal(d.six.after.actor, "employee");
  assert.equal(d.six.after.cta.href, "/career.html#confirm");
  who = OWNER; whoUser = { id: "u-own1", email: "owner@example.com", factors: [{ status: "verified", factor_type: "totp" }] };
  await save(F); await issue();
  asHire();
  d = (await hire(undefined, { method: "GET" })).body;
  assert.equal(d.six.complete, false, "案内が発行されたなら、確認が済むまで完了にしない");
  assert.equal(d.six.next.key, "guide");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
globalThis.fetch = realFetch;
process.exit(fail ? 1 : 0);
