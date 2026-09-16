// オリエンテーションと、入社日が近いのに未完了のお知らせ。
//
// ■ 何を守るか
//   1. 教材の登録は、種類ごとに要るものが違う（本文／URL）。https 以外は受けない
//   2. 「確認しました」は本人だけ。人事が代わりに押す口は無い
//   3. 必須の教材が残っていると、入社手続きは完了にならない（任意は止めない）
//   4. 入社日の7日前から知らせる。誰に出すかは段階で決まる
//   5. 何度走っても、ベルには1件だけ（dedupe_key が同じ）
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {} };
function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([k, v]) =>
    (k.startsWith("!") ? r[k.slice(1)] !== v : Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq(k, v) { f.push(["!" + k, v]); return q; },
    in(k, v) { f.push([k, v]); return q; },
    is() { return q; }, not() { return q; }, lte() { return q; }, gte() { return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: rows()[0] ? { ...rows()[0] } : null, error: null }),
    single: () => Promise.resolve({ data: rows()[0] ? { ...rows()[0] } : null, error: null }),
    then: (fn) => Promise.resolve({ data: rows().map((r) => ({ ...r })), error: null }).then(fn),
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r = { select: () => r,
                  single: () => Promise.resolve({ data: made[0], error: null }),
                  then: (fn) => Promise.resolve({ data: made, error: null }).then(fn) };
      return r;
    },
    upsert(row, opts) {
      const made = [].concat(row);
      for (const m of made) {
        const had = (db.rows[name] || []).find((x) =>
          x.employee_id === m.employee_id && x.item_id === m.item_id);
        if (had) { if (!opts?.ignoreDuplicates) Object.assign(had, m); continue; }
        (db.rows[name] = db.rows[name] || []).push({ id: `${name}-${(db.rows[name] || []).length + 1}`, ...m });
      }
      return { select: () => ({ single: () => Promise.resolve({ data: made[0], error: null }) }),
               then: (fn) => Promise.resolve({ data: made, error: null }).then(fn) };
    },
    update(patch) {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        select: () => r,
        single: () => {
          const hit = (db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
          for (const x of hit) Object.assign(x, patch);
          return Promise.resolve({ data: hit[0] ? { ...hit[0] } : null, error: null });
        },
        then: (fn) => {
          const hit = (db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
          for (const x of hit) Object.assign(x, patch);
          return Promise.resolve({ data: hit, error: null }).then(fn);
        },
      };
      return r;
    },
  };
  return q;
}
mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
const EMP = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
              employee: { id: "emp-new", display_name: "山田 太郎" } };
const HR = { tenantId: "t1", isAdmin: true, isHr: true, roles: ["owner"],
             employee: { id: "emp-hr", display_name: "事務" } };
let who = EMP;
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => who, canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr) },
});
const advanced = [];
mock.module(atRoot("lib/onboard-advance.js"), {
  namedExports: {
    advanceFor: async (sb, ctx, id) => { advanced.push(id); },
    advance: async () => null, gatherFacts: async () => ({}), gatherFactsBulk: async () => new Map(),
  },
});
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/notify.js"),
  { namedExports: { notify: async (n) => ({ created: n.length }), clearNotification: async () => {} } });

const { default: ori } = await import(atRoot("api/onboarding/orientation.js"));
const O = await import(atRoot("lib/orientation.js"));
const { dueNotices, DUE_WINDOW_DAYS } = await import(atRoot("lib/onboard-due.js"));
const { computeStage } = await import(atRoot("lib/onboard-stage.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => {
  const r = res();
  await ori({ headers: { authorization: "Bearer x" }, ...req }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  advanced.length = 0;
  db.rows = {
    gw_orientation_items: [
      { id: "o1", tenant_id: "t1", title: "会社説明", kind: "video",
        url: "https://example.jp/v", required: true, sort_order: 10, active: true },
      { id: "o2", tenant_id: "t1", title: "社内ルール", kind: "text",
        body: "ルールの本文", required: true, sort_order: 20, active: true },
      { id: "o3", tenant_id: "t1", title: "おまけ", kind: "link",
        url: "https://example.jp/x", required: false, sort_order: 30, active: true },
    ],
    gw_orientation_checks: [],
  };
}

console.log("\n=== オリエンテーション ===\n");
console.log("— 登録の受け取り方 —");

await ok("動画・PDF・リンクは URL が要る", () => {
  assert.equal(O.normalizeItem({ title: "会社説明", kind: "video" }).error, "invalid_body");
  assert.ok(O.normalizeItem({ title: "会社説明", kind: "video", url: "https://x.jp/v" }).value);
});

await ok("本文の種類は、本文が要る", () => {
  assert.equal(O.normalizeItem({ title: "ルール", kind: "text" }).error, "invalid_body");
  assert.ok(O.normalizeItem({ title: "ルール", kind: "text", body: "…" }).value);
});

await ok("https 以外の URL は受けない", () => {
  const r = O.normalizeItem({ title: "x", kind: "link", url: "javascript:alert(1)" });
  assert.equal(r.error, "invalid_body");
  assert.match(r.hint, /https/);
});

await ok("題名は必ず要る", () => {
  assert.equal(O.normalizeItem({ kind: "link", url: "https://x.jp" }).error, "invalid_body");
});

await ok("知らない種類は link にする", () => {
  assert.equal(O.normalizeItem({ title: "x", kind: "でたらめ", url: "https://x.jp" }).value.kind, "link");
});

console.log("— 本人の画面 —");

await ok("有効な教材が、並び順で返る", async () => {
  setup();
  const r = await call({ method: "GET", url: "/api/onboarding/orientation" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.items.map((i) => i.title), ["会社説明", "社内ルール", "おまけ"]);
  assert.equal(r.body.done, false);
});

await ok("止めた教材は、本人には出さない", async () => {
  setup();
  db.rows.gw_orientation_items[0].active = false;
  const r = await call({ method: "GET", url: "/api/onboarding/orientation" });
  assert.deepEqual(r.body.items.map((i) => i.title), ["社内ルール", "おまけ"]);
});

await ok("確認すると、時刻が残って段階を進め直す", async () => {
  setup();
  const r = await call({ method: "POST", url: "/api/onboarding/orientation", body: { confirm: "o1" } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_orientation_checks.length, 1);
  assert.ok(db.rows.gw_orientation_checks[0].confirmed_at);
  assert.deepEqual(advanced, ["emp-new"]);
});

await ok("二度押しても、記録は1つ", async () => {
  setup();
  await call({ method: "POST", url: "/api/onboarding/orientation", body: { confirm: "o1" } });
  await call({ method: "POST", url: "/api/onboarding/orientation", body: { confirm: "o1" } });
  assert.equal(db.rows.gw_orientation_checks.length, 1);
});

await ok("止めた教材は確認できない", async () => {
  setup();
  db.rows.gw_orientation_items[0].active = false;
  const r = await call({ method: "POST", url: "/api/onboarding/orientation", body: { confirm: "o1" } });
  assert.equal(r.statusCode, 404);
});

await ok("必須が全部そろうと done。任意は数えない", () => {
  const items = [
    { id: "o1", title: "a", required: true }, { id: "o2", title: "b", required: true },
    { id: "o3", title: "c", required: false },
  ];
  assert.equal(O.orientationDone(items, [{ item_id: "o1" }]), false);
  assert.equal(O.orientationDone(items, [{ item_id: "o1" }, { item_id: "o2" }]), true);
});

await ok("教材が1つも無ければ done", () => {
  assert.equal(O.orientationDone([], []), true);
});

console.log("— 人事の画面 —");

await ok("本人は教材を登録できない", async () => {
  setup();
  const r = await call({ method: "POST", url: "/api/onboarding/orientation",
                         body: { title: "勝手に追加", kind: "link", url: "https://x.jp" } });
  assert.equal(r.statusCode, 403);
});

await ok("人事なら登録できる。止めることもできる", async () => {
  setup();
  who = HR;
  try {
    const add = await call({ method: "POST", url: "/api/onboarding/orientation",
                             body: { title: "情報セキュリティ", kind: "pdf", url: "https://x.jp/s.pdf" } });
    assert.equal(add.statusCode, 200, JSON.stringify(add.body));
    const id = add.body.item.id;
    const off = await call({ method: "DELETE", url: `/api/onboarding/orientation?id=${id}` });
    assert.equal(off.statusCode, 200);
    assert.equal(db.rows.gw_orientation_items.find((i) => i.id === id).active, false);
  } finally { who = EMP; }
});

await ok("人事の一覧には、止めたものと確認した人数も出る", async () => {
  setup();
  db.rows.gw_orientation_items[0].active = false;
  db.rows.gw_orientation_checks.push({ tenant_id: "t1", employee_id: "emp-x", item_id: "o2" });
  who = HR;
  try {
    const r = await call({ method: "GET", url: "/api/onboarding/orientation" });
    assert.equal(r.body.items.length, 3, "止めたものも出す");
    assert.equal(r.body.items.find((i) => i.id === "o2").confirmedCount, 1);
  } finally { who = EMP; }
});

console.log("— 段階との関係 —");

const facts = (over = {}) => ({
  procedure: { status: "in_progress" },
  order: { status: "signed" }, sign: { status: "signed" }, consentsOk: true,
  profile: { status: "submitted" },
  items: [{ owner: "hr", status: "done", required: true }],
  ...over,
});

await ok("必須の教材が残っていると、完了にしない", () => {
  const s = computeStage(facts({ orientationOk: false }));
  assert.equal(s.key, "intake");
  assert.ok(s.blockers.some((b) => /オリエンテーション/.test(b)));
  assert.ok(s.nextActors.includes("employee"));
});

await ok("確認が済めば完了", () => {
  assert.equal(computeStage(facts({ orientationOk: true })).key, "complete");
});

await ok("表が無い環境（事実が渡らない）では、止めない", () => {
  assert.equal(computeStage(facts()).key, "complete");
});

console.log("\n=== 入社日が近いのに未完了 ===\n");

const proc = { id: "p1", tenant_id: "t1", employee_id: "emp-new", target_on: "2026-09-20", status: "in_progress" };
const stage = (key, actors, blockers) => ({ key, nextActors: actors, blockers });

await ok("7日より先は知らせない", () => {
  const out = dueNotices({ proc, name: "山田", today: "2026-09-01",
                           stage: stage("intake", ["employee"], ["書類の提出が2件残っています"]),
                           adminIds: ["emp-hr"], advisorIds: [] });
  assert.equal(out.length, 0);
  assert.equal(DUE_WINDOW_DAYS, 7);
});

await ok("7日以内なら、本人と管理者に届く", () => {
  const out = dueNotices({ proc, name: "山田", today: "2026-09-17",
                           stage: stage("intake", ["employee"], ["書類の提出が2件残っています"]),
                           adminIds: ["emp-hr"], advisorIds: ["emp-sr"] });
  assert.equal(out.length, 2);
  const mine = out.find((n) => n.employeeId === "emp-new");
  assert.match(mine.title, /あと3日/);
  assert.match(mine.body, /書類の提出/);
  assert.equal(mine.link, "onboarding.html");
  const admin = out.find((n) => n.employeeId === "emp-hr");
  assert.match(admin.title, /山田さん/);
  assert.equal(admin.link, "admin-hr.html?id=p1");
});

await ok("社労士で止まっていれば、社労士にも届く", () => {
  const out = dueNotices({ proc, name: "山田", today: "2026-09-18",
                           stage: stage("advisor_review", ["advisor"], ["社労士の確認待ちです"]),
                           adminIds: ["emp-hr"], advisorIds: ["emp-sr"] });
  assert.ok(out.some((n) => n.employeeId === "emp-sr" && n.link === "advisor.html"));
  assert.ok(!out.some((n) => n.employeeId === "emp-new"), "本人の番ではないのに届いています");
});

await ok("入社日を過ぎたら、過ぎた日数を言う", () => {
  const out = dueNotices({ proc, name: "山田", today: "2026-09-25",
                           stage: stage("intake", ["employee"], ["入社情報の入力がまだです"]),
                           adminIds: [], advisorIds: [] });
  assert.match(out[0].title, /5日過ぎ/);
});

await ok("今日が入社日", () => {
  const out = dueNotices({ proc, name: "山田", today: "2026-09-20",
                           stage: stage("intake", ["employee"], ["x"]), adminIds: [], advisorIds: [] });
  assert.match(out[0].title, /今日が入社日/);
});

await ok("完了しているものは知らせない", () => {
  assert.equal(dueNotices({ proc, name: "山田", today: "2026-09-18",
                            stage: stage("complete", [], []), adminIds: ["emp-hr"] }).length, 0);
  assert.equal(dueNotices({ proc: { ...proc, status: "done" }, name: "山田", today: "2026-09-18",
                            stage: stage("intake", ["employee"], ["x"]), adminIds: ["emp-hr"] }).length, 0);
});

await ok("入社日が決まっていなければ知らせない", () => {
  assert.equal(dueNotices({ proc: { ...proc, target_on: null }, name: "山田", today: "2026-09-18",
                            stage: stage("intake", ["employee"], ["x"]), adminIds: ["emp-hr"] }).length, 0);
});

await ok("毎日走っても、ベルには1件（宛先ごとに鍵が同じ）", () => {
  const a = dueNotices({ proc, name: "山田", today: "2026-09-17",
                         stage: stage("intake", ["employee"], ["x"]), adminIds: ["emp-hr"] });
  const b = dueNotices({ proc, name: "山田", today: "2026-09-18",
                         stage: stage("intake", ["employee"], ["x"]), adminIds: ["emp-hr"] });
  assert.deepEqual(a.map((n) => n.dedupeKey).sort(), b.map((n) => n.dedupeKey).sort());
  assert.deepEqual([...new Set(a.map((n) => n.dedupeKey))].length, a.length);
});

await ok("本人あてが、自分の管理者あてと二重にならない", () => {
  const out = dueNotices({ proc, name: "山田", today: "2026-09-18",
                           stage: stage("intake", ["employee"], ["x"]),
                           adminIds: ["emp-new"] });   // 本人が管理者でもある場合
  assert.equal(out.length, 1);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
