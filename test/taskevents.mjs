// 業務イベント → 共通タスクの自動生成。
//
// ■ 何を守るか
//
//   1. buildTask() が、二重防止に使う occ_key を正しい形（evt:種類:対象）で作ること
//   2. 同じ occ_key を持つ行は、runEventTasks() を何度呼んでも増えないこと
//   3. 端末未登録・契約更新（45日前）・月初のBP勤務表回収の、対象の絞り方が正しいこと
//      （早すぎない・遅すぎない・対象外の人を巻き込まない）
//   4. 表がまだ無い環境（053・075 未適用）でも、cron が落ちないこと
//   5. 入社手続きを作ったその場で、まとめて1件だけ「入社準備」タスクができること
//      （STEP5のチェックリストと二重に持たない）
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";

const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, missingTables: new Set() };

function table(name) {
  const f = [];
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    not(k, _op, v) { f.push(["not", k, v]); return q; },
    gte(k, v) { f.push(["gte", k, v]); return q; },
    lte(k, v) { f.push(["lte", k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    then(fn) {
      const err = db.missingTables.has(name)
        ? { code: "42703", message: `column ${name}.x does not exist` } : null;
      const rows = err ? null : match(name, f);
      return Promise.resolve({ data: rows, error: err }).then(fn);
    },
    maybeSingle() {
      const rows = match(name, f);
      return Promise.resolve({ data: rows[0] || null, error: null });
    },
    single() {
      const rows = match(name, f);
      return Promise.resolve({ data: rows[0] || null, error: null });
    },
    upsert(rows, opts) {
      const list = [].concat(rows);
      const stored = (db.rows[name] = db.rows[name] || []);
      // onConflict は "col" でも "col1,col2,col3"（複合キー）でも来る
      const keys = String(opts?.onConflict || "").split(",").map((k) => k.trim()).filter(Boolean);
      let made = 0;
      for (const r of list) {
        const dup = keys.length && stored.some((x) => keys.every((k) => x[k] != null && x[k] === r[k]));
        if (dup) continue;
        stored.push({ id: `t-${stored.length + 1}`, ...r });
        made++;
      }
      return { then: (fn) => Promise.resolve({ data: list, error: null, count: made }).then(fn) };
    },
    insert(row) {
      const rows = [].concat(row);
      const stored = (db.rows[name] = db.rows[name] || []);
      const made = rows.map((r) => ({ id: `${name}-${stored.length + 1}-${Math.random().toString(16).slice(2, 6)}`, ...r }));
      stored.push(...made);
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: made[0], error: null }),
        maybeSingle: () => Promise.resolve({ data: made[0] || null, error: null }),
        then: (fn) => Promise.resolve({ data: made, error: null }).then(fn),
      };
      return r2;
    },
    update() {
      const r2 = { eq: () => r2, then: (fn) => Promise.resolve({ data: [], error: null }).then(fn) };
      return r2;
    },
  };
  return q;
}
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([op, k, v]) => {
  if (op === "eq") return r[k] === v;
  if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
  if (op === "not") return r[k] != null;
  if (op === "gte") return String(r[k] ?? "") >= String(v);
  if (op === "lte") return String(r[k] ?? "") <= String(v);
  return true;
}));

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-admin" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => ({
      tenantId: "t1", isAdmin: true, isHr: true,
      employee: { id: "emp-admin", display_name: "事務 花子" },
    }),
    canManageHr: () => true,
  },
});
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
mock.module(atRoot("lib/hr-drive.js"), {
  namedExports: {
    linkOf: (id) => `https://drive.google.com/drive/folders/${id}`,
    shareEmployeeFolders: async () => ({ ready: false }),
    ensureProcedureFolders: async () => ({ skipped: "not_configured" }),
    shareAdvisorFolder: async () => null,
    folderIdFromUrl: () => null,
  },
});

const { buildTask, runEventTasks } = await import(atRoot("lib/task-events.js"));
const { deviceMissingEvents, contractExpiryEvents, siteContractExpiryEvents, monthStartBpEvents, default: cron } =
  await import(atRoot("api/cron/task-events.js"));
const { default: onboardingIndex } = await import(atRoot("api/onboarding/index.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== 業務イベント → 共通タスク ===\n");

console.log("— buildTask() / runEventTasks() —");

await ok("occ_key は evt:種類:対象 の形になる", () => {
  const t = buildTask({
    tenantId: "t1", eventKey: "device_missing", entityId: "emp-1",
    title: "端末登録", category: "端末管理",
  });
  assert.equal(t.occ_key, "evt:device_missing:emp-1");
  assert.equal(t.tenant_id, "t1");
  assert.equal(t.status, "todo");
  assert.equal(t.priority, "normal");
});

await ok("同じ対象は、何度流しても1件のまま", async () => {
  db.rows = {};
  const row = buildTask({
    tenantId: "t1", eventKey: "device_missing", entityId: "emp-9",
    title: "端末登録", category: "端末管理",
  });
  const sb = { from: table };
  const r1 = await runEventTasks(sb, [row]);
  const r2 = await runEventTasks(sb, [row]);
  assert.equal(r1.made, 1);
  assert.equal(r2.made, 0);
  assert.equal((db.rows.gw_tasks || []).length, 1);
});

console.log("— ① 端末未登録 —");

function setupDevices() {
  db.rows.gw_employees = [
    { id: "e-old", tenant_id: "t1", display_name: "古株 太郎", status: "active", joined_on: "2026-09-01" },
    { id: "e-new", tenant_id: "t1", display_name: "新人 花子", status: "active", joined_on: "2026-09-16" },
    { id: "e-has", tenant_id: "t1", display_name: "端末 次郎", status: "active", joined_on: "2026-09-01" },
  ];
  db.rows.gw_devices = [{ id: "d1", employee_id: "e-has" }];
}

await ok("入社から数日経っても端末が無い人だけ、対象になる", async () => {
  db.missingTables = new Set(); setupDevices();
  const { rows } = await deviceMissingEvents({ from: table }, "2026-09-17");
  const ids = rows.map((r) => r.occ_key);
  assert.ok(ids.includes("evt:device_missing:e-old"), "古株さんは対象");
  assert.ok(!ids.includes("evt:device_missing:e-has"), "端末がある人は対象外");
  assert.ok(!ids.includes("evt:device_missing:e-new"), "入社したばかりの人は、まだ対象にしない");
});

await ok("053未適用（gw_devices が無い）でも、落ちずに空で返す", async () => {
  db.missingTables = new Set(["gw_devices"]); setupDevices();
  const { rows, error } = await deviceMissingEvents({ from: table }, "2026-09-17");
  assert.deepEqual(rows, []);
  assert.ok(error);
});

console.log("— ② 契約更新の確認（45日前）—");

function setupContracts() {
  db.rows.gw_contracts = [
    { id: "c-near", tenant_id: "t1", employee_id: "e1", status: "active", fixed_term: true,
      period_to: "2026-10-20", employee: { display_name: "有期 一郎" } },      // 33日後：対象
    { id: "c-far", tenant_id: "t1", employee_id: "e2", status: "active", fixed_term: true,
      period_to: "2027-06-01", employee: { display_name: "有期 二郎" } },      // 遠い先：対象外
    { id: "c-unlimited", tenant_id: "t1", employee_id: "e3", status: "active", fixed_term: false,
      period_to: null, employee: { display_name: "無期 三郎" } },              // 無期：対象外
  ];
}

await ok("45日以内に終わる有期契約だけ、対象になる", async () => {
  setupContracts();
  const { rows } = await contractExpiryEvents({ from: table }, "2026-09-17");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occ_key, "evt:contract_expiry:c-near:2026-10-20");
  assert.match(rows[0].title, /有期 一郎/);
  assert.equal(rows[0].due_on, "2026-10-06"); // 終了日の14日前
});

console.log("— ③ 現場契約（SES）の更新確認（45日前）—");

function setupSiteContracts() {
  db.rows.gw_site_contracts = [
    { id: "sc-near", tenant_id: "t1", employee_id: "e1", site_company: "A社", renewal_status: "pending",
      period_to: "2026-10-20", employee: { display_name: "現場 一郎" } },       // 33日後：対象
    { id: "sc-confirmed", tenant_id: "t1", employee_id: "e2", site_company: "B社", renewal_status: "confirmed",
      period_to: "2026-10-01", employee: { display_name: "現場 二郎" } },       // 確認済み：対象外
    { id: "sc-far", tenant_id: "t1", employee_id: "e3", site_company: "C社", renewal_status: "pending",
      period_to: "2027-01-01", employee: { display_name: "現場 三郎" } },       // 遠い先：対象外
  ];
}

await ok("45日以内に終わる、まだ更新確認していない現場契約だけ、対象になる", async () => {
  setupSiteContracts();
  const { rows } = await siteContractExpiryEvents({ from: table }, "2026-09-17");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occ_key, "evt:site_contract_expiry:sc-near:2026-10-20");
  assert.match(rows[0].title, /現場 一郎/);
  assert.match(rows[0].title, /A社/);
});

await ok("076未適用（表が無い）でも、落ちずに空で返す", async () => {
  db.missingTables = new Set(["gw_site_contracts"]);
  const { rows, error } = await siteContractExpiryEvents({ from: table }, "2026-09-17");
  assert.deepEqual(rows, []);
  assert.ok(error);
});

console.log("— ④ 月初、BP区分ぶんの勤務表回収 —");

function setupBp() {
  db.missingTables = new Set();
  db.rows.gw_employees = [
    { id: "bp-1", tenant_id: "t1", display_name: "BP 太郎", employee_kind: "bp",
      status: "active", partner_company_id: "pc-1" },
    { id: "proper-1", tenant_id: "t1", display_name: "自社 花子", employee_kind: "proper",
      status: "active", partner_company_id: null },
  ];
  db.rows.gw_site_contracts = [
    // 継続中の現場契約。今月ぶんの請求進捗行が1つ用意されるはず
    { id: "sc-active", tenant_id: "t1", employee_id: "bp-1",
      period_from: "2026-04-01", period_to: null },
  ];
  db.rows.gw_billing_progress = [];
}

await ok("月初（1〜5日）だけ、BP区分の在籍者が対象になる", async () => {
  setupBp();
  const { rows } = await monthStartBpEvents({ from: table }, "2026-09-03");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].occ_key, "evt:month_start_bp_timesheet:bp-1:2026-09");
  assert.match(rows[0].title, /BP 太郎/);
});

await ok("動いている現場契約ぶん、今月の請求進捗の行も用意される（二重には作らない）", async () => {
  setupBp();
  const r1 = await monthStartBpEvents({ from: table }, "2026-09-03");
  assert.equal(r1.billingRowsMade, 1);
  const made = db.rows.gw_billing_progress.find((p) =>
    p.employee_id === "bp-1" && p.billing_month === "2026-09" && p.site_contract_id === "sc-active");
  assert.ok(made, "行ができている");

  const r2 = await monthStartBpEvents({ from: table }, "2026-09-04");
  assert.equal(r2.billingRowsMade, 0, "もう一度走っても増えない");
  assert.equal(db.rows.gw_billing_progress.length, 1);
});

await ok("6日以降は対象にしない（毎日は流さない）", async () => {
  setupBp();
  const { rows } = await monthStartBpEvents({ from: table }, "2026-09-17");
  assert.equal(rows.length, 0);
});

await ok("075未適用（employee_kind が無い）でも、落ちずに空で返す", async () => {
  db.missingTables = new Set(["gw_employees"]);
  const { rows, error } = await monthStartBpEvents({ from: table }, "2026-09-03");
  assert.deepEqual(rows, []);
  assert.ok(error);
});

console.log("— cron の口 —");

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};

await ok("CRON_SECRET が違えば断る", async () => {
  process.env.CRON_SECRET = "s3cret";
  const r = res();
  await cron({ method: "GET", url: "/api/cron/task-events", headers: {} }, r);
  assert.equal(r.statusCode, 401);
  delete process.env.CRON_SECRET;
});

await ok("まとめて走ると、4種類の内訳が返る", async () => {
  db.rows = {}; db.missingTables = new Set();
  setupDevices(); setupContracts(); setupSiteContracts();
  db.rows.gw_employees.push(...[
    { id: "bp-9", tenant_id: "t1", display_name: "BP 九郎", employee_kind: "bp",
      status: "active", partner_company_id: "pc-1" },
  ]);
  const r = res();
  await cron({ method: "GET", url: "/api/cron/task-events", headers: {} }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.deviceMissing, 1);
  assert.equal(r.body.contractExpiry, 1);
  assert.equal(r.body.siteContractExpiry, 1);
  // 月初かどうかは実行日次第なので、内訳の数だけ見る（0 か 1）
  assert.ok(r.body.monthStartBp === 0 || r.body.monthStartBp === 1);
  assert.equal(r.body.made,
    r.body.deviceMissing + r.body.contractExpiry + r.body.siteContractExpiry + r.body.monthStartBp);
});

await ok("cronを続けて2回走らせても、タスクも請求進捗の行も増えない（二重起票しない）", async () => {
  db.rows = {}; db.missingTables = new Set();
  setupDevices(); setupContracts(); setupSiteContracts();
  db.rows.gw_employees.push(
    { id: "bp-9", tenant_id: "t1", display_name: "BP 九郎", employee_kind: "bp",
      status: "active", partner_company_id: "pc-1" },
  );
  db.rows.gw_site_contracts.push(
    { id: "sc-bp9", tenant_id: "t1", employee_id: "bp-9", period_from: "2026-01-01", period_to: null },
  );
  db.rows.gw_billing_progress = [];

  await cron({ method: "GET", url: "/api/cron/task-events", headers: {} }, res());
  const tasksAfter1 = (db.rows.gw_tasks || []).length;
  const billingAfter1 = (db.rows.gw_billing_progress || []).length;
  assert.ok(tasksAfter1 > 0, "前提：1回目で何かしらタスクができている");

  const r2 = res();
  await cron({ method: "GET", url: "/api/cron/task-events", headers: {} }, r2);
  assert.equal(r2.body.made, 0, "2回目は新規タスクを作らない");
  assert.equal((db.rows.gw_tasks || []).length, tasksAfter1, "タスクの総数が増えない");
  assert.equal((db.rows.gw_billing_progress || []).length, billingAfter1, "請求進捗の行数も増えない");
});

console.log("— 入社手続きを作ったその場で、入社準備タスクが1件できる —");

const callOnboarding = async (body) => {
  const r = res();
  await onboardingIndex({ method: "POST", url: "/api/onboarding",
    headers: { authorization: "Bearer x" }, body }, r);
  return r;
};

await ok("入社手続きを作ると、まとめて1件だけタスクができる", async () => {
  db.rows = {}; db.missingTables = new Set();
  db.rows.gw_employees = [{ id: "e-new", tenant_id: "t1", display_name: "新人 花子",
    employment_type: "正社員" }];
  const r = await callOnboarding({ employeeId: "e-new", kind: "onboarding", targetOn: "2026-10-01" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const made = (db.rows.gw_tasks || []).filter((t) => t.occ_key?.startsWith("evt:onboarding_decided:"));
  assert.equal(made.length, 1, "タスクは1件だけ");
  assert.match(made[0].title, /新人 花子/);
  assert.equal(made[0].due_on, "2026-10-01");
  assert.equal(made[0].assignee_id, "emp-admin", "作った管理者に割り当てる");
});

await ok("退職手続きでは、入社準備タスクを作らない", async () => {
  db.rows = {}; db.missingTables = new Set();
  db.rows.gw_employees = [{ id: "e-leave", tenant_id: "t1", display_name: "退職 太郎",
    employment_type: "正社員" }];
  await callOnboarding({ employeeId: "e-leave", kind: "offboarding" });
  const made = (db.rows.gw_tasks || []).filter((t) => t.occ_key?.startsWith("evt:onboarding_decided:"));
  assert.equal(made.length, 0);
});

await ok("もう一度作ろうとしても（同じ手続きIDには普通ならないが）タスクは増えない", async () => {
  db.rows = {}; db.missingTables = new Set();
  db.rows.gw_employees = [{ id: "e-2", tenant_id: "t1", display_name: "二 郎", employment_type: "正社員" }];
  await callOnboarding({ employeeId: "e-2", kind: "onboarding" });
  const before = (db.rows.gw_tasks || []).length;
  // 同じ手続き行に対して、もう一度イベントだけ流しても増えない
  const { buildTask: bt, runEventTasks: ret } = await import(atRoot("lib/task-events.js"));
  const proc = db.rows.gw_procedures[0];
  await ret({ from: table }, [bt({
    tenantId: "t1", eventKey: "onboarding_decided", entityId: proc.id,
    title: "重複のはずのタスク", category: "入社手続き",
  })]);
  assert.equal((db.rows.gw_tasks || []).length, before);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
