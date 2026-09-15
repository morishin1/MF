// タスクの「依頼 → 受諾 → 完了（結果）」と、繰り返しの生成。
//
// ■ 何を守るのか
//
//   1. 頼まれた仕事は、受けるまで「未確認の依頼」として出ること
//      ここが緩いと、頼んだ側は伝わったつもりで待ち、
//      頼まれた側は見ていない、という一番よくある事故に戻る。
//
//   2. 頼まれた仕事は、結果を書かないと完了にできないこと
//      書かせないと「どうなりました？」がチャットに戻る。
//
//   3. 自分で立てたメモには、①も②も求めないこと
//      全部に求めると、面倒で完了を押さなくなる。
//      押されなくなった時点で、一覧が信用できなくなる。
//
//   4. 繰り返しが、何度走っても増えないこと
//
//   5. 068 をまだ流していない環境でも、画面が開くこと
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";

const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase ---------------------------------------------------------
const db = { rows: {}, writes: [], missing: new Set() };

/** 無い列を SELECT / 条件に使ったときの、PostgREST のエラー */
const colErr = (cols) => {
  for (const c of db.missing) {
    if (String(cols || "").includes(c)) {
      return { code: "42703", message: `column gw_tasks.${c} does not exist` };
    }
  }
  return null;
};

/**
 * 選んだ列だけを返す。
 *
 * ■ ここを手を抜くと、テストが何も守らなくなる
 *
 *   行をまるごと返す偽物にすると、068 を流していない環境でも
 *   accepted_at が入って返ってくることになり、
 *   「列が無いときの見え方」を一切確かめられない。
 *   本物（PostgREST）は選んだ列しか返さないので、そこを合わせる。
 */
function project(row, cols) {
  if (!row || !cols || cols === "*") return row;
  // 埋め込み（assignee:gw_employees!fk(...)）は、丸ごと1つの鍵として扱う
  const flat = String(cols).replace(/[a-z_]+:[a-z_]+![a-z_]+\([^)]*\)/gi, "assignee");
  const keys = flat.split(",").map((c) => c.trim()).filter(Boolean);
  const out = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
}

function table(name) {
  const f = [];
  let cols = "*";
  // 条件に使った列。本物は select に無くても、無い列で絞れば落ちる
  const filterCols = () => f.map(([k]) => k.replace(/^!/, "")).join(",");
  const rowsNow = () => (db.rows[name] || []).filter((r) => f.every(([k, v]) => {
    if (k.startsWith("!")) return r[k.slice(1)] !== v;
    return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
  }));
  const wrap = (v) => Promise.resolve(v);
  const q = {
    select(c) { cols = c ?? cols; return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq(k, v) { f.push(["!" + k, v]); return q; },
    in(k, v) { f.push([k, v]); return q; },
    is() { return q; }, not() { return q; }, or() { return q; },
    gte() { return q; }, lte() { return q; }, lt() { return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle() {
      const e = colErr(cols) || colErr(filterCols());
      return wrap({ data: e ? null : project(rowsNow()[0] || null, cols), error: e });
    },
    single() {
      const e = colErr(cols) || colErr(filterCols());
      return wrap({ data: e ? null : project(rowsNow()[0] || null, cols), error: e });
    },
    then(fn) {
      const e = colErr(cols) || colErr(filterCols());
      return wrap({ data: e ? null : rowsNow().map((r) => project(r, cols)),
                    error: e, count: rowsNow().length }).then(fn);
    },
    insert(row) {
      const rows = [].concat(row);
      const e = colErr(Object.keys(rows[0] || {}).join(","));
      if (!e) {
        for (const r of rows) {
          const made = { id: `new-${db.writes.length}-${Math.random().toString(16).slice(2, 6)}`, ...r };
          (db.rows[name] = db.rows[name] || []).push(made);
          db.writes.push({ op: "insert", table: name, row: made });
        }
      }
      const made = (db.rows[name] || []).slice(-rows.length);
      const r2 = { select: () => r2,
                   single: () => wrap({ data: e ? null : made[0], error: e }),
                   maybeSingle: () => wrap({ data: e ? null : made[0], error: e }),
                   then: (fn) => wrap({ data: e ? null : made, error: e }).then(fn) };
      return r2;
    },
    upsert(rows, opts) {
      const list = [].concat(rows);
      let made = 0;
      for (const r of list) {
        const key = opts?.onConflict;
        const dup = key && (db.rows[name] || []).some((x) => x[key] && x[key] === r[key]);
        if (dup) continue;
        (db.rows[name] = db.rows[name] || []).push({ id: `u-${made}-${r.occ_key || ""}`, ...r });
        made++;
      }
      db.writes.push({ op: "upsert", table: name, rows: list, opts, made });
      const r2 = { select: () => r2, single: () => wrap({ data: list[0], error: null }),
                   then: (fn) => wrap({ data: list, error: null, count: made }).then(fn) };
      return r2;
    },
    update(row) {
      const e = colErr(Object.keys(row).join(","));
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        is: () => r2, select(c) { cols = c ?? cols; return r2; },
        single: () => apply(),
        maybeSingle: () => apply(),
        then: (fn) => apply().then(fn),
      };
      function apply() {
        const e2 = e || colErr(cols);
        if (e2) return wrap({ data: null, error: e2 });
        const hit = (db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
        for (const h of hit) Object.assign(h, row);
        db.writes.push({ op: "update", table: name, row, hit: hit.length });
        return wrap({ data: project(hit[0] || null, cols), error: null });
      }
      return r2;
    },
    delete() {
      const g = [];
      const r2 = { eq: (k, v) => { g.push([k, v]); return r2; }, select: () => r2,
                   then: (fn) => {
                     const hit = (db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
                     db.rows[name] = (db.rows[name] || []).filter((x) => !hit.includes(x));
                     return wrap({ data: hit, error: null }).then(fn);
                   } };
      return r2;
    },
  };
  return q;
}

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});

let signedIn = { id: "u-hanako", email: "hanako@8grp.co.jp" };
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => signedIn, getMemberships: async () => [] },
});

let ctxNow = null;
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => ctxNow, canManageHr: () => Boolean(ctxNow.isHr) },
});

const told = [];
mock.module(atRoot("lib/notify.js"), {
  namedExports: {
    notify: async (l) => { told.push(...[].concat(l)); return { created: told.length }; },
    clearNotification: async () => {},
  },
});
mock.module(atRoot("lib/slack.js"), {
  namedExports: { notifySlack: async () => {}, slackConfigured: () => false },
});

const { default: tasks } = await import(atRoot("api/tasks/index.js"));
const { default: cron } = await import(atRoot("api/cron/tasks.js"));

// ---- 道具 -------------------------------------------------------------------
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => {
  const r = res();
  await h({ headers: { authorization: "Bearer x" }, ...req }, r);
  return r;
};
const get = (qs = "") => call(tasks, { method: "GET", url: `/api/tasks${qs}` });
const patch = (body) => call(tasks, { method: "PATCH", url: "/api/tasks", body });
const post = (body) => call(tasks, { method: "POST", url: "/api/tasks", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const TASK_ID = "11111111-1111-1111-1111-111111111111";

/**
 * 花子さんが、太郎さんに頼まれた仕事を1件持っている状態。
 * 花子＝担当、太郎＝依頼者
 */
function setup(over = {}) {
  db.writes = []; db.missing = new Set(); told.length = 0;
  signedIn = { id: "u-hanako", email: "hanako@8grp.co.jp" };
  ctxNow = {
    tenantId: "t1", isAdmin: false, isHr: false, roles: [],
    employee: { id: "emp-hanako", tenant_id: "t1", display_name: "佐藤 花子" },
  };
  db.rows = {
    gw_tasks: [{
      id: TASK_ID, tenant_id: "t1", title: "8月分の請求書をアップロード",
      body: null, assignee_id: "emp-hanako", escalate_to: null,
      due_on: "2026-09-30", priority: "normal", status: "todo", category: "月次経理",
      completed_at: null, created_by: "u-taro",
      created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
      // 068
      done_condition: "MFに8月分が全部入っていること",
      accepted_at: null, result: null,
      is_template: false, recur: null, template_id: null, occ_key: null,
      ...(over.task || {}),
    }],
    gw_employees: [
      { id: "emp-hanako", tenant_id: "t1", user_id: "u-hanako", display_name: "佐藤 花子" },
      { id: "emp-taro",   tenant_id: "t1", user_id: "u-taro",   display_name: "山田 太郎" },
    ],
    gw_actions: [], gw_procedures: [], gw_procedure_items: [], gw_nippo: [],
  };
}

console.log("=== タスク：依頼 → 受諾 → 完了 ===\n");
console.log("— 受けるまでは「未確認の依頼」—");

await ok("人から頼まれた仕事は、受けるまで未確認", async () => {
  setup();
  const r = await get("?scope=mine");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  const t = r.body.tasks[0];
  assert.equal(t.requestedByOther, true);
  assert.equal(t.needsAccept, true);
  assert.equal(t.done_condition, "MFに8月分が全部入っていること",
    "終わりの条件が見えないと、受けるかどうか決められない");
});

await ok("自分で立てたメモは、未確認にしない", async () => {
  setup({ task: { created_by: "u-hanako" } });
  const t = (await get("?scope=mine")).body.tasks[0];
  assert.equal(t.requestedByOther, false);
  assert.equal(t.needsAccept, false);
});

await ok("引き受けると、未確認ではなくなる", async () => {
  setup();
  const r = await patch({ id: TASK_ID, action: "accept" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  assert.ok(db.rows.gw_tasks[0].accepted_at, "受けた時刻が残っていない");
  const t = (await get("?scope=mine")).body.tasks[0];
  assert.equal(t.needsAccept, false);
});

await ok("引き受けるときに、期限を引き直せる", async () => {
  // 「その日は無理です」を言う場所が無いと、黙って期限を過ぎる
  setup();
  await patch({ id: TASK_ID, action: "accept", dueOn: "2026-10-15" });
  assert.equal(db.rows.gw_tasks[0].due_on, "2026-10-15");
});

await ok("引き受けたことは、頼んだ人に届く", async () => {
  setup();
  await patch({ id: TASK_ID, action: "accept", dueOn: "2026-10-15" });
  const n = told.find((x) => /引き受け/.test(x.title || ""));
  assert.ok(n, told.map((x) => x.title).join(","));
  assert.equal(n.employeeId, "emp-taro", "頼んだ人に届いていない");
  assert.ok(/2026-10-15/.test(n.body), `引き直した期限が伝わらない: ${n.body}`);
});

await ok("他人のタスクは引き受けられない", async () => {
  setup({ task: { assignee_id: "emp-taro" } });
  const r = await patch({ id: TASK_ID, action: "accept" });
  assert.equal(r.statusCode, 403);
});

console.log("\n— 終わったことを、終わったと書く —");

await ok("頼まれた仕事は、結果なしでは完了にできない", async () => {
  setup();
  const r = await patch({ id: TASK_ID, status: "done" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "result_required");
  assert.ok(/1行/.test(r.body.hint), r.body.hint);
  assert.equal(db.rows.gw_tasks[0].status, "todo", "書かずに完了になっています");
});

await ok("結果を書けば完了できる", async () => {
  setup();
  const r = await patch({ id: TASK_ID, status: "done", result: "MFに8月分を投入しました" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(db.rows.gw_tasks[0].status, "done");
  assert.equal(db.rows.gw_tasks[0].result, "MFに8月分を投入しました");
  assert.ok(db.rows.gw_tasks[0].completed_at);
});

await ok("結果は、頼んだ人の通知にも入る", async () => {
  // 開かなくても読めるようにしないと、「どうなりました？」がチャットに戻る
  setup();
  await patch({ id: TASK_ID, status: "done", result: "MFに8月分を投入しました" });
  const n = told.find((x) => /終わらせました/.test(x.title || ""));
  assert.ok(n, told.map((x) => x.title).join(","));
  assert.ok(/MFに8月分を投入しました/.test(n.body), `結果が入っていない: ${n.body}`);
});

await ok("自分のメモは、結果なしで完了できる", async () => {
  setup({ task: { created_by: "u-hanako" } });
  const r = await patch({ id: TASK_ID, status: "done" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(db.rows.gw_tasks[0].status, "done");
});

console.log("\n— 頼むときに「終わりの条件」を書ける —");

await ok("作るときに、終わりの条件を入れられる", async () => {
  setup();
  const r = await post({ title: "請求書を送る", assigneeId: "emp-taro",
                         doneCondition: "先方に届いて、受領の返事が来ていること" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  const made = db.rows.gw_tasks.find((t) => t.title === "請求書を送る");
  assert.equal(made.done_condition, "先方に届いて、受領の返事が来ていること");
});

console.log("\n— 繰り返し —");

await ok("形の崩れた繰り返しは受け付けない", async () => {
  // 静かに0件生成になるのを、入口で止める
  setup();
  const r = await post({ title: "月次締め", recur: { type: "dom", n: 99 } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_recur");
  assert.ok(/1〜31/.test(r.body.hint), r.body.hint);
});

await ok("繰り返しを付けると、「元」になる", async () => {
  setup();
  await post({ title: "月次締め", assigneeId: "emp-hanako",
               recur: { type: "biz", n: 3 } });
  const tpl = db.rows.gw_tasks.find((t) => t.title === "月次締め");
  assert.equal(tpl.is_template, true);
  assert.deepEqual(tpl.recur, { type: "biz", n: 3 });
});

await ok("「元」は、やることの一覧に出さない", async () => {
  // 混ぜると、毎日の繰り返し1本で一覧の先頭が埋まる
  setup();
  db.rows.gw_tasks.push({
    id: "tpl-1", tenant_id: "t1", title: "月次締め", assignee_id: "emp-hanako",
    status: "todo", priority: "normal", created_by: "u-hanako",
    is_template: true, recur: { type: "biz", n: 3 }, accepted_at: null,
  });
  const r = await get("?scope=mine");
  assert.ok(!r.body.tasks.some((t) => t.id === "tpl-1"), "一覧に元が出ています");
  assert.equal(r.body.templates.length, 1, "別の箱にも出ていない");
  assert.equal(r.body.templates[0].recurLabel, "毎月 第3営業日");
});

console.log("\n— 繰り返しの生成（cron）—");

const runCron = () => call(cron, { method: "GET", url: "/api/cron/tasks" });

function withTemplate(recur) {
  setup();
  db.rows.gw_tasks = [{
    id: "tpl-1", tenant_id: "t1", title: "月次締め", body: null,
    assignee_id: "emp-hanako", escalate_to: null, priority: "high",
    category: "月次経理", done_condition: "試算表が合っていること",
    created_by: "u-taro", is_template: true, recur,
  }];
}

await ok("元から、これから来る回が作られる", async () => {
  withTemplate({ type: "dom", n: 25, adj: "" });
  const r = await runCron();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  const made = db.rows.gw_tasks.filter((t) => t.occ_key);
  assert.ok(made.length >= 1, "1件も作られていない");
  assert.ok(made.every((t) => t.is_template === false));
  assert.ok(made.every((t) => t.template_id === "tpl-1"));
  assert.ok(made.every((t) => /^tpl-1\|\d{4}-\d{2}-\d{2}$/.test(t.occ_key)));
});

await ok("作られた回は、元の中身を引き継ぐ", async () => {
  withTemplate({ type: "dom", n: 25, adj: "" });
  await runCron();
  const t = db.rows.gw_tasks.find((x) => x.occ_key);
  assert.equal(t.title, "月次締め");
  assert.equal(t.assignee_id, "emp-hanako");
  assert.equal(t.priority, "high");
  assert.equal(t.done_condition, "試算表が合っていること");
});

await ok("決まってやる仕事に、毎回「受けますか」と聞かない", async () => {
  withTemplate({ type: "dom", n: 25, adj: "" });
  await runCron();
  const t = db.rows.gw_tasks.find((x) => x.occ_key);
  assert.ok(t.accepted_at, "繰り返しのぶんまで未確認にすると、毎月それが並ぶ");
});

await ok("何度走っても増えない", async () => {
  withTemplate({ type: "dom", n: 25, adj: "" });
  await runCron();
  const after1 = db.rows.gw_tasks.filter((t) => t.occ_key).length;
  await runCron();
  await runCron();
  const after3 = db.rows.gw_tasks.filter((t) => t.occ_key).length;
  assert.equal(after3, after1, `増えています（${after1} → ${after3}）`);
});

await ok("先の月まで作りすぎない", async () => {
  // 12か月ぶん作ると、月1件でも一覧に12件並び、片付けても減らなくなる
  withTemplate({ type: "dom", n: 25, adj: "" });
  await runCron();
  const dates = db.rows.gw_tasks.filter((t) => t.occ_key).map((t) => t.due_on).sort();
  const months = new Set(dates.map((d) => d.slice(0, 7)));
  assert.ok(months.size <= 2, `${months.size} か月ぶん作っています: ${[...months].join(",")}`);
});

await ok("元が無ければ、何もしない", async () => {
  setup();
  const r = await runCron();
  assert.equal(r.body.templates, 0);
  assert.equal(r.body.made, 0);
});

await ok("CRON_SECRET があれば、それを要る", async () => {
  withTemplate({ type: "dom", n: 25, adj: "" });
  process.env.CRON_SECRET = "s3cret";
  const bad = await call(cron, { method: "GET", url: "/api/cron/tasks", headers: {} });
  assert.equal(bad.statusCode, 401);
  const good = await call(cron, {
    method: "GET", url: "/api/cron/tasks", headers: { authorization: "Bearer s3cret" } });
  assert.equal(good.statusCode, 200);
  delete process.env.CRON_SECRET;
});

console.log("\n— 068 をまだ流していない環境 —");

await ok("列が無くても、一覧は開ける", async () => {
  setup();
  db.missing = new Set(["accepted_at", "done_condition", "result", "is_template"]);
  const r = await get("?scope=mine");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.tasks.length, 1);
});

await ok("列が無ければ、全件を「未確認」にしない", async () => {
  // ここを間違えると、流すまで一覧が真っ赤になる
  setup();
  db.missing = new Set(["accepted_at", "done_condition", "result", "is_template"]);
  const t = (await get("?scope=mine")).body.tasks[0];
  assert.equal(t.needsAccept, false);
});

await ok("列が無くても、完了はできる", async () => {
  setup();
  db.missing = new Set(["result"]);
  const r = await patch({ id: TASK_ID, status: "done", result: "やりました" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(db.rows.gw_tasks[0].status, "done");
});

await ok("列が無ければ、cron は静かに止まる", async () => {
  setup();
  db.missing = new Set(["is_template"]);
  const r = await runCron();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notReady, true);
  assert.ok(/068/.test(r.body.message), r.body.message);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
