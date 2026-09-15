// 入退社を、漏れなく進められるか。
//
// ■ 何を守るテストか
//
//   1. 日付を登録したら、担当ごとのチェックリストが自動でできること
//   2. ロールから **実際の人** が決まること（「IT・管理の誰か」にしない）
//   3. その人にお知らせと「やること」が届くこと
//      1人1通にまとまること（件数ぶん届くと読まれずに消される）
//   4. 通知から、その人の入退社画面へ直接飛べること
//   5. 一覧が「何が終わっていないか」を出すこと（次の担当）
//   6. 日付を変えたら、期限も動いて、知らせ直すこと
//   7. チェックを付けたら、段階が進むこと
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase。update / delete は本当に効かせる ------------------------
const db = { rows: {} };

function table(name) {
  const f = [];
  const wrap = (v) => Promise.resolve(v);
  const rows = () => match(name, f);
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq(k, v) { f.push(["neq:" + k, v]); return q; },
    in(k, v) { f.push([k, v]); return q; },
    is(k, v) { f.push(["is:" + k, v]); return q; },
    like(k, v) { f.push(["like:" + k, v]); return q; },
    not() { return q; }, gte() { return q; }, lte() { return q; }, lt() { return q; },
    order() { return q; },
    limit(n) { q._limit = n; return q; },
    maybeSingle() { return wrap({ data: rows()[0] || null, error: null }); },
    single() { return wrap({ data: rows()[0] || null, error: null }); },
    then(fn) {
      let out = rows();
      if (q._limit) out = out.slice(0, q._limit);
      return wrap({ data: out, error: null, count: out.length }).then(fn);
    },
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r = { select: () => r, single: () => wrap({ data: made[0], error: null }),
                  maybeSingle: () => wrap({ data: made[0], error: null }),
                  then: (fn) => wrap({ data: made, error: null }).then(fn) };
      return r;
    },
    upsert(row) { return q.insert(row); },
    update(patch) {
      const g = [];
      const run = () => {
        const hit = match(name, g);
        for (const r of hit) Object.assign(r, patch);
        return { data: hit, error: null };
      };
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        in: (k, v) => { g.push([k, v]); return r; },
        is: (k, v) => { g.push(["is:" + k, v]); return r; },
        select: () => r,
        single: () => wrap({ data: run().data[0] || null, error: null }),
        maybeSingle: () => wrap({ data: run().data[0] || null, error: null }),
        then: (fn) => wrap(run()).then(fn),
      };
      return r;
    },
    delete() {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        like: (k, v) => { g.push(["like:" + k, v]); return r; },
        then: (fn) => {
          const hit = match(name, g);
          db.rows[name] = (db.rows[name] || []).filter((x) => !hit.includes(x));
          return wrap({ data: hit, error: null }).then(fn);
        },
      };
      return r;
    },
  };
  return q;
}
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([k, v]) => {
  if (k.startsWith("is:")) { const kk = k.slice(3); return v === null ? r[kk] == null : r[kk] === v; }
  if (k.startsWith("neq:")) return r[k.slice(4)] !== v;
  if (k.startsWith("like:")) {
    const kk = k.slice(5);
    return String(r[kk] ?? "").includes(String(v).replace(/%/g, ""));
  }
  return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
}));

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-admin", email: "zimu@8grp.co.jp" }),
                  getMemberships: async () => [] },
});
// 呼ぶ人。ふだんは管理者。社労士の場合を試すときだけ差し替える
const ADMIN_CTX = {
  tenantId: "t1", isAdmin: true, isHr: true, roles: ["owner"],
  employee: { id: "emp-hr", display_name: "事務" },
};
const ADVISOR_CTX = {
  tenantId: "t1", isAdmin: false, isHr: false, isAdvisor: true, roles: ["labor_advisor"],
  employee: null,
};
let who = ADMIN_CTX;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr),
    canWipeDevice: () => true,
  },
});
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
const sent = [];
mock.module(atRoot("lib/notify.js"), {
  namedExports: {
    notify: async (rows) => { sent.push(...rows); return { created: rows.length }; },
    clearNotification: async () => {},
  },
});
const slack = [];
mock.module(atRoot("lib/slack.js"), {
  namedExports: { notifySlack: async (m) => { slack.push(m); return { sent: true }; } },
});

const { default: hr } = await import(atRoot("api/hr/index.js"));
const F = await import(atRoot("lib/hr-flow.js"));
const consentLib = await import(atRoot("lib/consent-docs.js"));

// ---- 呼び出しの道具 --------------------------------------------------------
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => {
  const r = res();
  await hr({ headers: { authorization: "Bearer x" }, ...req }, r);
  return r;
};
const get = (qs = "") => call({ method: "GET", url: `/api/hr${qs}` });
const post = (body) => call({ method: "POST", url: "/api/hr", body });
const patch = (body) => call({ method: "PATCH", url: "/api/hr", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

// きょうを固定しない（jstDate は本物）。日付は今日からの相対で作る
const day = (n) => {
  const t = Date.now() + 9 * 3600000 + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
};

/** 会社の状態をまっさらに戻す。役割は一通り付いている */
function setup({ roles = true } = {}) {
  logged.length = 0; sent.length = 0; slack.length = 0;
  db.rows = {
    gw_employees: [
      { id: "emp-new", tenant_id: "t1", display_name: "山田 太郎", department: "営業",
        manager_id: "emp-mgr", user_id: "u-new", employment_type: "正社員" },
      { id: "emp-hr",  tenant_id: "t1", display_name: "事務 花子", department: "管理",
        manager_id: null, user_id: "u-admin" },
      { id: "emp-it",  tenant_id: "t1", display_name: "情報 次郎", department: "管理",
        manager_id: null, user_id: "u-it" },
      { id: "emp-mgr", tenant_id: "t1", display_name: "部長 三郎", department: "営業",
        manager_id: null, user_id: "u-mgr" },
      { id: "emp-fin", tenant_id: "t1", display_name: "経理 四郎", department: "管理",
        manager_id: null, user_id: "u-fin" },
    ],
    gw_role_grants: roles ? [
      { tenant_id: "t1", employee_id: "emp-hr",  role: "hr" },
      { tenant_id: "t1", employee_id: "emp-it",  role: "it" },
      { tenant_id: "t1", employee_id: "emp-fin", role: "finance" },
    ] : [],
    gw_procedures: [], gw_procedure_items: [], gw_tasks: [], gw_notifications: [],
  };
}
const proc = () => db.rows.gw_procedures[0];
const items = () => db.rows.gw_procedure_items;

console.log("\n=== 入退社：漏れなく進められるか ===\n");

// ---------------------------------------------------------------------------
console.log("— 登録したら、チェックリストができる —");

await ok("入社を登録すると、担当ごとの項目が入る", async () => {
  setup();
  const r = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(proc(), "手続きができていません");
  assert.equal(items().length, F.flowItems("onboarding").length,
    `項目が足りません（${items().length}）`);
});

await ok("人事・IT・上長・経理の4つに分かれている", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const owners = new Set(items().map((i) => i.owner));
  for (const r of ["hr", "it", "manager", "finance"]) {
    assert.ok(owners.has(r), `担当「${r}」の項目がありません`);
  }
});

await ok("仕様どおりの作業が入っている（入社）", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const titles = items().map((i) => i.title).join("／");
  for (const t of ["労働条件・契約の確認", "必要書類の回収", "社内ルールの確認",
                   "会社PCの準備", "メールの発行", "Slack・グループウェアの発行",
                   "EIGHT Agent の設定", "必要システムの権限付与",
                   "初日の予定の登録", "担当業務の設定", "オリエンテーション",
                   "給与・振込情報の確認"]) {
    assert.ok(titles.includes(t), `「${t}」がありません`);
  }
});

await ok("仕様どおりの作業が入っている（退社）", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "offboarding", targetOn: day(10) });
  const titles = items().map((i) => i.title).join("／");
  for (const t of ["退職日の確認", "必要書類の受け渡し", "引継ぎの確認",
                   "PCの返却", "メールの停止", "Slack の停止",
                   "グループウェアの停止", "システム権限の削除",
                   "EIGHT Agent 端末の利用停止・削除",
                   "業務の引継ぎ", "データ・案件の確認",
                   "経費精算", "最終給与等の確認"]) {
    assert.ok(titles.includes(t), `「${t}」がありません`);
  }
});

await ok("期限は入社日・退社日", async () => {
  setup();
  const d = day(10);
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: d });
  assert.ok(items().every((i) => i.due_on === d), "期限が入っていない項目があります");
});

// ---------------------------------------------------------------------------
console.log("\n— 担当は「誰か」ではなく「この人」 —");

await ok("ロールから実際の人が決まる", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const who = (owner) => items().find((i) => i.owner === owner)?.assignee_id;
  assert.equal(who("hr"), "emp-hr");
  assert.equal(who("it"), "emp-it", "IT・管理のロールから決まっていません");
  assert.equal(who("finance"), "emp-fin");
});

await ok("上長は、その人の上長", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  assert.equal(items().find((i) => i.owner === "manager")?.assignee_id, "emp-mgr",
    "manager_id を見ていません");
});

await ok("役割が誰にも付いていないと、担当は空のまま", async () => {
  setup({ roles: false });
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  // 勝手に人事へ寄せない。寄せると、また全部が人事の仕事になる
  assert.equal(items().find((i) => i.owner === "it")?.assignee_id, null,
    "担当がいないのに、誰かに寄せています");
});

// ---------------------------------------------------------------------------
console.log("\n— 知らせる —");

await ok("担当者にお知らせが届く", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const to = sent.map((n) => n.employeeId);
  for (const who of ["emp-hr", "emp-it", "emp-mgr", "emp-fin"]) {
    assert.ok(to.includes(who), `${who} に届いていません`);
  }
});

await ok("1人1通にまとまっている", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const to = sent.map((n) => n.employeeId);
  assert.equal(new Set(to).size, to.length,
    "同じ人に何通も送っています（件数ぶん届くと読まれずに消されます）");
});

await ok("「○○さんが…入社予定です。担当が◯件あります」と書いてある", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const it = sent.find((n) => n.employeeId === "emp-it");
  assert.ok(/山田 太郎さんが.+入社予定です/.test(it.title), `題名: ${it.title}`);
  assert.ok(/担当タスクが 5件/.test(it.body), `本文: ${it.body}`);
});

await ok("通知から、その人の入退社画面へ直接飛べる", async () => {
  setup();
  const r = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const it = sent.find((n) => n.employeeId === "emp-it");
  assert.equal(it.link, `admin-hr.html?id=${r.body.id}`,
    `行き先が違います: ${it.link}`);
});

await ok("「やること」にも入る", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const t = (db.rows.gw_tasks || []).find((x) => x.assignee_id === "emp-it");
  assert.ok(t, "やることに入っていません");
  assert.equal(t.category, "入退社");
  assert.ok(String(t.link).startsWith("admin-hr.html?id="), `行き先: ${t.link}`);
  assert.ok(t.due_on, "期限が入っていません");
});

await ok("本人には、担当タスクを配らない", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  assert.ok(!sent.some((n) => n.employeeId === "emp-new"),
    "本人に「あなたの担当」を送っています");
});

await ok("Slack にも出す", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  assert.equal(slack.length, 1);
  assert.ok(/山田 太郎/.test(slack[0].text), slack[0].text);
});

// ---------------------------------------------------------------------------
console.log("\n— 一覧は「何が終わっていないか」 —");

await ok("氏名・日付・状態・進捗・次の担当が出る", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(3) });
  const r = await get();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  const row = r.body.onboarding[0];
  assert.equal(row.name, "山田 太郎");
  assert.equal(row.due, "入社まで3日");
  assert.ok(row.phaseLabel, "状態が空です");
  assert.equal(row.progress.done, 0);
  assert.ok(row.progress.total > 0);
  assert.ok(row.next?.title, "次の担当が出ていません");
  assert.equal(row.next.role, "人事");
});

// 入社は5段階を持つ。作成依頼を出していなければ ①、次は管理者
await ok("入社の段階と、止まっているものが出る", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(3) });
  const r = await get();
  const row = r.body.onboarding[0];
  assert.equal(row.stage, "conditions");
  assert.equal(row.stageN, 1);
  assert.equal(row.nextActorLabel, "管理者");
  assert.match(row.stuck, /作成依頼/);
  assert.equal(row.daysLeft, 3);
  assert.ok(row.internalOpen > 0, "社内準備の残りが数えられていない");
});

await ok("上に出す5つの数が返る", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(3) });
  const r = await get();
  assert.equal(r.body.kpi.planned, 1);
  assert.equal(r.body.kpi.advisor, 0);
  assert.equal(r.body.kpi.prep, 1, "社内準備が残っている人");
  assert.equal(r.body.kpi.complete, 0);
});

await ok("作成依頼を出したら ② になり、社労士の番と出る", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(3) });
  db.rows.gw_doc_orders = [{ id: "o1", tenant_id: "t1", employee_id: "emp-new",
                             doc_kind: "employment", status: "requested", updated_at: "2026-09-15T00:00:00Z" }];
  const r = await get();
  const row = r.body.onboarding[0];
  assert.equal(row.stage, "advisor_review");
  assert.equal(row.nextActorLabel, "社労士");
  assert.equal(r.body.kpi.advisor, 1);
});

await ok("社内準備が済んだだけでは、入社を完了にしない", async () => {
  // 本人が署名も届出もしていないのに「完了」に見えるのがいちばん困る
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(3) });
  for (const it of items().filter((i) => i.owner !== "employee")) {
    await patch({ id: proc().id, itemId: it.id, done: true });
  }
  const r = await get();
  assert.equal(r.body.onboarding.length, 1, "完了タブに移っています");
  assert.notEqual(proc().status, "done");
  assert.notEqual(r.body.onboarding[0].stage, "complete");
});

await ok("3つのタブに分かれる", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(3) });
  const r = await get();
  assert.deepEqual((r.body.tabs || []).map((t) => t.label),
    ["入社予定", "退社予定", "完了"]);
  assert.equal(r.body.onboarding.length, 1);
  assert.equal(r.body.offboarding.length, 0);
  assert.equal(r.body.done.length, 0);
});

await ok("期日が近いと、急ぎだと分かる", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(2) });
  const r = await get();
  assert.equal(r.body.onboarding[0].urgency, "soon");
});

await ok("入社日を過ぎて残っていたら、いちばん強く出す", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(-1) });
  const r = await get();
  assert.equal(r.body.onboarding[0].urgency, "late");
  assert.equal(r.body.onboarding[0].phaseLabel, "初日対応");
});

// ---------------------------------------------------------------------------
console.log("\n— 詳細は「次にやること」が先頭 —");

await ok("担当別のチェックリストが出る", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const r = await get(`?id=${made.body.id}`);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  const labels = r.body.procedure.groups.map((g) => g.label);
  assert.deepEqual(labels, ["人事", "IT・管理", "上長", "経理"],
    `並び: ${labels.join("・")}`);
});

await ok("上に出す見出しの材料がそろっている", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const p = (await get(`?id=${made.body.id}`)).body.procedure;
  // 「山田太郎｜入社まで5日｜0/12完了」を組み立てられること
  assert.equal(p.name, "山田 太郎");
  assert.equal(p.due, "入社まで5日");
  assert.equal(p.progress.total, 12);
});

await ok("行かないと終わらない作業には、行き先が付く", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const all = (await get(`?id=${made.body.id}`)).body.procedure.groups.flatMap((g) => g.items);
  const agent = all.find((i) => i.title.includes("EIGHT Agent"));
  assert.equal(agent.href, "admin-devices.html", `行き先: ${agent.href}`);
});

// ---------------------------------------------------------------------------
console.log("\n— チェックを付ける —");

await ok("付けると進捗が上がる", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const id = made.body.id;
  const first = items()[0];
  const r = await patch({ id, itemId: first.id, done: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.progress.done, 1);
  assert.equal(first.status, "done");
  assert.ok(first.completed_at, "いつ終わったかが残っていません");
});

await ok("外せる（押し間違い）", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const first = items()[0];
  await patch({ id: made.body.id, itemId: first.id, done: true });
  await patch({ id: made.body.id, itemId: first.id, done: false });
  assert.equal(first.status, "todo");
  assert.equal(first.completed_at, null);
});

/**
 * 入社の「完了」は、社内準備だけでは決まらない。
 * 作成依頼 → 社労士の発行 → 本人の締結・同意 → 届出 → 社内準備、が全部そろって ⑤。
 * ここでは本人側の事実を表に置いてから、社内準備を終わらせる
 */
function employeeSideDone(empId) {
  const { CONSENT_DOCS } = consentLib;
  db.rows.gw_doc_orders = [{ id: "o1", tenant_id: "t1", employee_id: empId,
    doc_kind: "employment", status: "signed", updated_at: "2026-09-15T00:00:00Z" }];
  db.rows.gw_sign_requests = [{ id: "s1", tenant_id: "t1", employee_id: empId,
    doc_kind: "employment", status: "signed", sent_at: "2026-09-15T00:00:00Z" }];
  db.rows.gw_onboard_profiles = [{ employee_id: empId, status: "submitted" }];
  db.rows.gw_onboard_consents = CONSENT_DOCS.map((d) => ({
    employee_id: empId, kind: d.key, version: d.version, agreed_at: "2026-09-15T00:00:00Z" }));
  for (const i of items().filter((x) => x.owner === "employee")) i.status = "submitted";
}

await ok("全部終わると「完了」に移る", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const id = made.body.id;
  employeeSideDone("emp-new");
  for (const i of items().filter((x) => x.owner !== "employee")) {
    await patch({ id, itemId: i.id, done: true });
  }
  const r = await get();
  assert.equal(r.body.onboarding.length, 0, "まだ入社予定に残っています");
  assert.equal(r.body.done.length, 1, "完了に移っていません");
  assert.equal(r.body.done[0].stage, "complete");
  assert.equal(r.body.kpi.complete, 1);
  assert.equal(proc().status, "done", "手続き本体も done になる");
});

await ok("完了したら、本人と管理者に知らせる", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  employeeSideDone("emp-new");
  sent.length = 0;
  for (const i of items().filter((x) => x.owner !== "employee")) {
    await patch({ id: made.body.id, itemId: i.id, done: true });
  }
  const done = sent.filter((n) => /完了しました/.test(n.title || ""));
  assert.ok(done.length >= 1, sent.map((n) => n.title).join(","));
  assert.ok(done.some((n) => n.employeeId === "emp-new"), "本人に届いていない");
});

await ok("次にやることは、段階の早いものから", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const id = made.body.id;
  // 準備を全部終わらせてから見ると、初日ぶんが出てくる
  for (const i of items().filter((x) => x.phase === "prep")) {
    await patch({ id, itemId: i.id, done: true });
  }
  const row = (await get()).body.onboarding[0];
  assert.equal(row.next.role, "上長");
  assert.ok(/初日|オリエン/.test(row.next.title), row.next.title);
});

// ---------------------------------------------------------------------------
console.log("\n— 日付を変える —");

await ok("期限も一緒に動く", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const to = day(20);
  await patch({ id: made.body.id, targetOn: to });
  assert.ok(items().every((i) => i.due_on === to),
    "入社日だけ動いて、期限が前のまま残っています");
});

await ok("担当者に知らせ直す", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  sent.length = 0;
  const r = await patch({ id: made.body.id, targetOn: day(20) });
  assert.equal(r.body.told, 4, `${r.body.told}名`);
  assert.ok(sent.some((n) => /20/.test(n.title) || n.title.includes("入社予定")), "題名が古いままです");
});

await ok("やることが積み上がらない", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const before = db.rows.gw_tasks.length;
  await patch({ id: made.body.id, targetOn: day(20) });
  assert.equal(db.rows.gw_tasks.length, before,
    "日付を変えるたびに、やることが増えています");
});

await ok("終わった項目の担当者には、もう送らない", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const id = made.body.id;
  for (const i of items().filter((x) => x.owner === "finance")) {
    await patch({ id, itemId: i.id, done: true });
  }
  sent.length = 0;
  await patch({ id, remind: true });
  assert.ok(!sent.some((n) => n.employeeId === "emp-fin"),
    "終わった人にも送っています");
});

// ---------------------------------------------------------------------------
console.log("\n— ホームに出す「今日対応する入退社」 —");

await ok("期日が近いものだけ出る", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(3) });
  const r = await get("?soon=1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.soon.length, 1);
  assert.equal(r.body.soon[0].due, "入社まで3日");
});

await ok("先の予定は出さない（ホームを埋めない）", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(30) });
  const r = await get("?soon=1");
  assert.equal(r.body.soon.length, 0);
});

await ok("残っているものを3件だけ出す", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(3) });
  const r = await get("?soon=1");
  assert.equal(r.body.soon[0].open.length, 3,
    "全部出すと、ホームがチェックリストになります");
  assert.ok(r.body.soon[0].open[0].role, "担当が出ていません");
});

await ok("終わったものは出さない", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(3) });
  const id = made.body.id;
  for (const i of [...items()]) await patch({ id, itemId: i.id, done: true });
  const r = await get("?soon=1");
  assert.equal(r.body.soon.length, 0, "終わったものがホームに残っています");
});

// ---------------------------------------------------------------------------
console.log("\n— 監査 —");

await ok("誰がいつ登録したか残る", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const e = logged.find((x) => x.action === "hr.onboarding.start");
  assert.ok(e, logged.map((x) => x.action).join(", "));
  assert.equal(e.actorId, "u-admin");
  assert.equal(e.detail.name, "山田 太郎");
});

await ok("日付を変えたことも残る", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  logged.length = 0;
  await patch({ id: made.body.id, targetOn: day(20) });
  assert.ok(logged.some((x) => x.action === "hr.reschedule"),
    logged.map((x) => x.action).join(", "));
});

// ---------------------------------------------------------------------------
console.log("\n— 二重に作らない —");

await ok("同じ人・同じ種別は1つだけ", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  const n = items().length;
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  assert.equal(db.rows.gw_procedures.length, 1, "手続きが2つできています");
  assert.equal(items().length, n, "項目が二重に入っています");
});

await ok("手順を増やしたら、進行中のものにも足りないぶんだけ入る", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  // 1件消して、もう一度登録する（手順を後から増やした状態）
  const dropped = items().pop();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  assert.ok(items().some((i) => i.item_key === dropped.item_key), "足りないぶんが入りません");
  assert.equal(items().length, F.flowItems("onboarding").length, "二重に入っています");
});

// ---------------------------------------------------------------------------
console.log("\n— 新規メンバー登録から作られた手続き —");
//
//   登録の画面（admin-onboard.html）は、手順は入れるが担当は入れない。
//   空のままだと誰にも知らせられず、「作ったのに誰も動かない」が起きる

await ok("担当が空の行を埋める", async () => {
  setup();
  // 登録の画面が作った状態を手で作る（担当なし）
  db.rows.gw_procedures.push({
    id: "pr-old", tenant_id: "t1", employee_id: "emp-new", kind: "onboarding",
    status: "in_progress", target_on: day(7), phase: null,
  });
  for (const f of F.flowItems("onboarding")) {
    db.rows.gw_procedure_items.push({
      id: `it-${f.key}`, tenant_id: "t1", procedure_id: "pr-old",
      item_key: f.key, title: f.title, owner: f.role, phase: null,
      assignee_id: null, status: "todo", sort_order: f.sortOrder,
    });
  }
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(7) });
  const it = items().find((i) => i.item_key === "on_it_pc");
  assert.equal(it.assignee_id, "emp-it", "担当が空のまま残っています");
  assert.equal(it.phase, "prep", "段階が空のまま残っています");
});

await ok("埋めたあと、その人に知らせが届く", async () => {
  setup();
  db.rows.gw_procedures.push({
    id: "pr-old", tenant_id: "t1", employee_id: "emp-new", kind: "onboarding",
    status: "in_progress", target_on: day(7), phase: null,
  });
  for (const f of F.flowItems("onboarding")) {
    db.rows.gw_procedure_items.push({
      id: `it-${f.key}`, tenant_id: "t1", procedure_id: "pr-old",
      item_key: f.key, title: f.title, owner: f.role, phase: null,
      assignee_id: null, status: "todo", sort_order: f.sortOrder,
    });
  }
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(7) });
  assert.ok(sent.some((n) => n.employeeId === "emp-it"), "IT・管理に届いていません");
});

// ---------------------------------------------------------------------------
console.log("— マイナンバーは、進み具合だけ —");

await ok("最初は「未提出」", async () => {
  setup();
  await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const r = await get();
  assert.equal(r.body.onboarding[0].mynumber, "not_submitted");
  assert.equal(r.body.onboarding[0].mynumberLabel, "未提出");
});

await ok("管理者が進められて、記録には番号が無い", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const r = await patch({ id: made.body.id, mynumber: "requested" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.mynumberLabel, "提出依頼済み");
  assert.equal(proc().mynumber_status, "requested");
  assert.equal(proc().mynumber_status_by, "u-admin");
  const l = logged.find((e) => e.action === "hr.mynumber");
  assert.ok(l, "操作ログが無い");
  assert.deepEqual(Object.keys(l.detail).sort(), ["label", "name", "to"]);
  const again = await get();
  assert.equal(again.body.onboarding[0].mynumber, "requested");
});

await ok("知らない状態は入らない", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const r = await patch({ id: made.body.id, mynumber: "123456789012" });
  assert.equal(r.statusCode, 400);
  assert.equal(proc().mynumber_status, undefined);
});

await ok("マイナンバーの提出が残っていても、完了を止めない", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(5) });
  employeeSideDone("emp-new");
  const mn = items().find((x) => x.item_key === "doc_mynumber");
  if (mn) mn.status = "todo";
  for (const i of items().filter((x) => x.owner !== "employee")) {
    await patch({ id: made.body.id, itemId: i.id, done: true });
  }
  const r = await get();
  assert.equal(r.body.done.length, 1, "完了に移っていません");
});

await ok("社労士も進められる", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  who = ADVISOR_CTX;
  try {
    const r = await patch({ id: made.body.id, mynumber: "submitted_to_advisor" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(proc().mynumber_status, "submitted_to_advisor");
  } finally { who = ADMIN_CTX; }
});

await ok("社労士は、それ以外（チェック・一覧）には触れない", async () => {
  setup();
  const made = await post({ employeeId: "emp-new", kind: "onboarding", targetOn: day(10) });
  const it = items().find((x) => x.owner === "hr");
  who = ADVISOR_CTX;
  try {
    const c = await patch({ id: made.body.id, itemId: it.id, done: true });
    assert.equal(c.statusCode, 403);
    assert.equal(it.status, "todo");
    const g = await get();
    assert.equal(g.statusCode, 403);
  } finally { who = ADMIN_CTX; }
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) { console.log(`${fail} 件 NG`); process.exit(1); }
