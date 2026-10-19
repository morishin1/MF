// /sales 提案管理（api/sales/proposals/*）を、偽の Supabase（test/_memdb.mjs）と本物の判定・署名・期限計算で通す。
//
// ■ 何を守るテストか（指示書「受け入れテスト」の番号）
//   1. 下書き（送信日時が無い・まだ送っていない提案の更新）では、提案もタスクも作られない
//   2. 送信済みの提案1件で、提案1件・電話タスク1件。営業担当（CL担当のメール）に通知
//   3. 同じ連携イベントの再送では増えない。送り直し（別のイベント）は「再送」の記録だけで、タスクは増えない
//   4. 電話「不通」でメールのタスクができ、記録に残る
//   5. 電話の結果が無ければ記録にならない（チェックだけで完了にしない）
//   6. メールのあと、翌営業日に回答確認のタスク
//   7. 期限超過が、自分の一覧・管理側の一覧に出る
//   8. 面談・再提案依頼・見送り・成約が、正しい提案に入る（dx.enger への状態の返事にも出る）
//   9. 担当を変えても、過去の記録（誰が電話したか）は変わらない。開いているタスクは新しい担当へ
//  10. 別テナント・権限の無い社員・担当でない営業担当には見えない
//  11. 返信なしは 3営業日で再フォロー、5営業日で管理者確認（1回の無回答で終わりにしない）
//  12. 営業時間外・休日の送信は、次の営業日の始業から期限。連絡停止の希望で自動の追客が止まる
//  13. マッチング確定（db/140）：提案待ち・提案準備・ベルと Slack（提案ごとに1回）。電話の期限は始めない
//  14. 企業へ送った（dx.enger／Sales で記録）：電話待ち・提案準備は完了・送った時刻から30分の電話。順が入れ替わっても同じ
//  ほか：署名（鍵・用途・時刻）、自動タスクはチェックで完了にできない、期限変更は理由が必須、
//        企業に紐付ければ企業の営業履歴にも写る、ドメインが1社一致したら自動で紐付く
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T1 = uid(1), T2 = uid(2);
const E_OWNER = uid(11), E_MGR = uid(12), E_S1 = uid(13), E_S2 = uid(14), E_NONE = uid(15), E_T2 = uid(16), E_LEFT = uid(17);
const nowIso = () => new Date().toISOString();
const inSet = (v, set) => v === null || v === undefined || set.includes(v);

const STATUSES = ["proposal_wait", "call_wait", "mail_wait", "reply_wait", "meeting_adjust", "meeting_done", "considering", "reproposal", "won", "lost", "stopped", "closed_no_reply"];
const CLOSED = ["won", "lost", "stopped", "closed_no_reply"];
// 途中の失敗を1回だけ起こす（提案を電話待ちにする更新で落とす）。送り直しで埋まることを確かめる
const failOnce = { callWait: false };
// db/138・db/140 の CHECK と同じ条件
const mem = createMemDb({
  schema: {
    gw_sales_proposals: {
      required: ["tenant_id", "company_name", "title", "status"],
      unique: [["tenant_id", "source_system", "source_proposal_id"]],
      defaults: () => ({ status: "call_wait", source_system: "manual", contact_stop: false, created_at: nowIso(), updated_at: nowIso() }),
      check: (r) => (!inSet(r.status, STATUSES) ? "status"
        : CLOSED.includes(r.status) !== Boolean(r.closed_at) ? "gw_sales_proposals_closed"
        : ["lost", "stopped", "closed_no_reply"].includes(r.status) && !r.close_reason ? "gw_sales_proposals_reason"
        : r.source_system === "enger" && !r.source_proposal_id ? "gw_sales_proposals_source_key"
        : r.status === "proposal_wait" && r.sent_at ? "gw_sales_proposals_wait_chk"
        : !r.sent_at && !r.matched_at ? "gw_sales_proposals_start_chk"
        : failOnce.callWait && r.status === "call_wait" ? (failOnce.callWait = false, "injected_failure") : null),
    },
    gw_sales_proposal_activities: {
      required: ["tenant_id", "proposal_id", "kind"],
      unique: [["proposal_id", "source_event"]],
      defaults: () => ({ occurred_at: nowIso(), created_at: nowIso() }),
      check: (r) => (r.kind === "call" && (!r.result || !r.employee_id) ? "gw_sales_proposal_activities_call"
        : r.kind === "mail" && (!r.evidence || !r.employee_id) ? "gw_sales_proposal_activities_mail"
        : r.kind === "due_change" && !String(r.note || "").trim() ? "gw_sales_proposal_activities_due" : null),
    },
    gw_sales_proposal_tasks: {
      required: ["tenant_id", "proposal_id", "kind", "title", "due_at"],
      unique: [["proposal_id", "source_event"]],
      defaults: () => ({ status: "open", auto: false, created_at: nowIso(), updated_at: nowIso() }),
      check: (r) => ((r.status === "done") !== Boolean(r.done_at && r.done_activity_id) ? "gw_sales_proposal_tasks_done"
        : r.status === "canceled" && !String(r.cancel_reason || "").trim() ? "gw_sales_proposal_tasks_cancel" : null),
    },
    gw_sales_proposal_sync_log: {
      required: ["tenant_id", "event_id", "event_type", "status"],
      unique: [["tenant_id", "source_system", "event_id"]],
      defaults: () => ({ direction: "inbound", source_system: "enger", attempts: 1, received_at: nowIso(), updated_at: nowIso() }),
    },
    gw_sales_company_links: { unique: [["tenant_id", "source_system", "source_company_id"]], defaults: () => ({ source_system: "enger" }) },
    gw_sales_events: { required: ["tenant_id", "company_id", "event_key", "label"], defaults: () => ({ occurred_at: nowIso() }) },
    gw_notifications: { unique: [["employee_id", "dedupe_key"]] },
  },
});

const logged = [];
const notified = [];
// 書き込みは本物の DB では RLS（db/138。test/sql/138_sales_proposals.sql で確かめている）が守る。
// ここでは API の判定（管理側・担当だけ）を確かめるため、userClient も書ける偽物にする
mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => mem.admin(), userClient: () => mem.admin() } });
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), { namedExports: { notify: async (rows) => { notified.push(...rows); return { created: rows.length }; } } });
const REAL_GW = await import(atRoot("lib/gw.js"));
let who = null;
mock.module(atRoot("lib/gw.js"), { namedExports: { gwContext: async () => who, canSell: REAL_GW.canSell } });

// Slack（Incoming Webhook）は外へ出さずに捕まえる。slackDown で「送れなかった」を作る
const slackPosts = [];
let slackDown = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).startsWith("https://hooks.slack.test/")) {
    if (slackDown) return new Response("down", { status: 500 });
    slackPosts.push({ url: String(url), body: JSON.parse(opts.body) });
    return new Response("ok", { status: 200 });
  }
  return realFetch(url, opts);
};
process.env.SALES_SLACK_WEBHOOK_URL = "https://hooks.slack.test/sales";

const SECRET = "test-enger-sales-secret-0123456789abcdef";
process.env.ENGER_SALES_SECRET = SECRET;
process.env.SALES_PROPOSAL_TENANT_ID = T1;
process.env.PUBLIC_BASE_URL = "https://gw.example.jp";

const { default: listApi } = await import(atRoot("api/sales/proposals/index.js"));
const { default: detailApi } = await import(atRoot("api/sales/proposals/detail.js"));
const { default: intakeApi } = await import(atRoot("api/sales/proposals/intake.js"));
const { default: statusApi } = await import(atRoot("api/sales/proposals/status.js"));
const { default: settingsApi } = await import(atRoot("api/sales/proposals/settings.js"));
const { default: syncApi } = await import(atRoot("api/sales/proposals/sync.js"));
const { signGwRequest } = await import(atRoot("lib/sales-proposal-intake.js"));
const { signLeadRequest } = await import(atRoot("lib/hr-leads.js"));

const ctxOf = (employeeId, roles, { tenantId = T1, isAdmin = false, apps = ["sales"] } = {}) =>
  ({ tenantId, isAdmin, isHr: false, roles, apps, employee: { id: employeeId, display_name: employeeId } });
const OWNER = ctxOf(E_OWNER, ["owner"], { apps: [] });
const MANAGER = ctxOf(E_MGR, ["manager"]);
const S1 = ctxOf(E_S1, ["sales"]);
const S2 = ctxOf(E_S2, ["sales"]);
const NOPERM = ctxOf(E_NONE, [], { apps: [] });
const OTHER_T = ctxOf(E_T2, ["owner"], { tenantId: T2, apps: [] });

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (handler, { method = "GET", url = "/", body, headers = {}, as = null } = {}) => {
  if (as) who = as;
  const r = res();
  await handler({ method, url, headers, body }, r);
  return r;
};
const sec = () => Math.floor(Date.now() / 1000);
const signed = (body, { purpose = "proposal", secret = SECRET, ts = sec(), sign = null } = {}) => ({
  "x-gw-timestamp": String(ts), "x-gw-signature": sign ? sign(secret, ts, body) : signGwRequest(secret, purpose, ts, body),
});
const intake = (body, opts) => call(intakeApi, { method: "POST", body, headers: signed(body, opts) });
const statusOf = (ids) => {
  const body = { source_proposal_ids: ids };
  return call(statusApi, { method: "POST", body, headers: signed(body, { purpose: "proposal-status" }) });
};
const list = (as, qs = "") => call(listApi, { url: `/api/sales/proposals${qs}`, as });
const detail = (as, id) => call(detailApi, { url: `/api/sales/proposals/detail?id=${id}`, as });
const act = (as, id, body) => call(detailApi, { method: "POST", body: { id, ...body }, as });

let evn = 0;
const ev = (over = {}, pOver = {}) => ({
  event_id: `enger:proposal.sent:${over.pid || "p-1"}:${++evn}`,
  event_type: "proposal.sent",
  occurred_at: nowIso(),
  ...over,
  proposal: {
    id: over.pid || "p-1", code: "P-0001", url: "https://agent.example/proposals/p-1", stage: "提案中",
    sent_at: new Date(Date.now() - 60000).toISOString(), service: "ENGER", job_title: "Java 開発", talent_initials: "T.K.",
    company: { id: "c-enger-1", name: "株式会社テスト", website: "https://test.example.co.jp/", phone: "03-1111-2222" },
    contact: { name: "窓口 太郎", email: "Madoguchi@Test.example.co.jp" },
    matching_owner: { name: "マッチ 花子", email: "match@eight.example" },
    sales_owner: { name: "営業 一郎", email: "S1@eight.example" },
    ...pOver,
  },
});
const tbl = (n) => mem.rows[n] || [];
const proposals = () => tbl("gw_sales_proposals").filter((p) => p.tenant_id === T1);
const tasksOf = (pid) => tbl("gw_sales_proposal_tasks").filter((t) => t.proposal_id === pid);
const actsOf = (pid) => tbl("gw_sales_proposal_activities").filter((a) => a.proposal_id === pid);

function setup() {
  mem.reset(); logged.length = 0; notified.length = 0; evn = 0; slackPosts.length = 0; slackDown = false;
  mem.rows.gw_employees = [
    { id: E_OWNER, tenant_id: T1, display_name: "経営 者", email: "owner@eight.example", status: "active" },
    { id: E_MGR, tenant_id: T1, display_name: "管理 職", email: "mgr@eight.example", status: "active" },
    { id: E_S1, tenant_id: T1, display_name: "営業 一郎", email: "s1@eight.example", status: "active", manager_id: E_MGR },
    { id: E_S2, tenant_id: T1, display_name: "営業 二郎", email: "s2@eight.example", status: "active", manager_id: E_MGR },
    { id: E_NONE, tenant_id: T1, display_name: "一般 社員", email: "none@eight.example", status: "active" },
    { id: E_LEFT, tenant_id: T1, display_name: "退職 者", email: "left@eight.example", status: "left" },
    { id: E_T2, tenant_id: T2, display_name: "他社 経営", email: "s1@eight.example", status: "active" },
  ];
  mem.rows.gw_role_grants = [
    { tenant_id: T1, employee_id: E_OWNER, role: "owner" }, { tenant_id: T1, employee_id: E_MGR, role: "manager" },
    { tenant_id: T1, employee_id: E_S1, role: "sales" }, { tenant_id: T1, employee_id: E_S2, role: "sales" },
  ];
  mem.rows.gw_app_grants = [
    { tenant_id: T1, employee_id: E_MGR, app_key: "sales" }, { tenant_id: T1, employee_id: E_S1, app_key: "sales" },
    { tenant_id: T1, employee_id: E_S2, app_key: "sales" },
  ];
  mem.rows.gw_sales_companies = [
    { id: uid(100), tenant_id: T1, name: "株式会社テスト（Sales）", domain: "test.example.co.jp", status: "attacked" },
    { id: uid(101), tenant_id: T1, name: "別の会社", domain: "other.example", status: "untouched" },
  ];
}

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

console.log("sales proposals (dx.enger → /sales 提案管理)");

// ---- 署名・設定 -----------------------------------------------------------------
await ok("署名なし・違う鍵・別の用途（状態の署名・HRリードの署名）・古い時刻は 401。GET は 405。未設定は 503", async () => {
  setup();
  const b = ev();
  assert.equal((await call(intakeApi, { method: "POST", body: b, headers: {} })).statusCode, 401);
  assert.equal((await intake(b, { secret: "x".repeat(40) })).statusCode, 401);
  assert.equal((await intake(b, { purpose: "proposal-status" })).statusCode, 401, "状態の署名で起票はできない");
  assert.equal((await intake(b, { sign: signLeadRequest })).statusCode, 401, "HR リードの署名は通らない");
  const old = await intake(b, { ts: sec() - 3600 });
  assert.equal(old.statusCode, 401); assert.equal(old.body.error, "timestamp_out_of_range");
  assert.equal((await call(intakeApi, { method: "GET", headers: signed(b) })).statusCode, 405);
  const keep = process.env.SALES_PROPOSAL_TENANT_ID;
  process.env.SALES_PROPOSAL_TENANT_ID = "";
  try { assert.equal((await intake(b)).statusCode, 503); } finally { process.env.SALES_PROPOSAL_TENANT_ID = keep; }
  assert.equal(proposals().length, 0);
});

await ok("形が違えば 400（field）。直さない限り同じなので dx.enger は再送しない", async () => {
  setup();
  for (const [b, field] of [
    [{ ...ev(), event_id: "x" }, "event_id"], [{ ...ev(), event_type: "proposal.draft" }, "event_type"],
    [ev({}, { id: "" }), "proposal.id"], [ev({}, { company: { name: "" } }), "proposal.company.name"],
  ]) {
    const r = await intake(b);
    assert.equal(r.statusCode, 400, field); assert.equal(r.body.field, field);
  }
  assert.equal(proposals().length, 0);
});

// ---- 1. 下書きは起票しない ----------------------------------------------------------
await ok("1 下書き（送信日時が無い）・まだ無い提案の更新では、提案もタスクも作らない", async () => {
  setup();
  const r1 = await intake(ev({}, { sent_at: null }));
  assert.equal(r1.statusCode, 400); assert.equal(r1.body.field, "proposal.sent_at");
  const r2 = await intake(ev({ event_type: "proposal.updated" }));
  assert.equal(r2.statusCode, 200); assert.equal(r2.body.result, "skipped");
  assert.equal(proposals().length, 0); assert.equal(tbl("gw_sales_proposal_tasks").length, 0);
});

// ---- 2・3. 起票と冪等 --------------------------------------------------------------
await ok("2 送信済み1件で提案1件・電話タスク1件。営業担当はCL担当のメールで決まり、通知が届く。人材の氏名は持たない", async () => {
  setup();
  const r = await intake(ev());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.result, "created");
  assert.equal(proposals().length, 1);
  const p = proposals()[0];
  assert.equal(p.source_proposal_id, "p-1"); assert.equal(p.sales_owner_id, E_S1); assert.equal(p.status, "call_wait");
  assert.equal(p.title, "Java 開発 / T.K."); assert.equal(p.contact_email, "madoguchi@test.example.co.jp");
  assert.equal(p.matching_owner_name, "マッチ 花子");
  const ts = tasksOf(p.id);
  assert.equal(ts.length, 1); assert.equal(ts[0].kind, "call"); assert.equal(ts[0].source_event, "auto:first_call"); assert.equal(ts[0].assignee_id, E_S1);
  assert.equal(actsOf(p.id).filter((a) => a.kind === "sent").length, 1);
  assert.deepEqual(notified.map((n) => n.employeeId), [E_S1]);
  assert.match(notified[0].title, /初回電話/);
  assert.ok(!JSON.stringify(logged).includes("madoguchi"), "監査ログに連絡先を出さない");
});

await ok("3 同じイベントの再送は replayed（増えない）。送り直し（別のイベント）は「再送」の記録だけでタスクは増えない", async () => {
  setup();
  const b = ev();
  await intake(b);
  const again = await intake(b);
  assert.equal(again.body.result, "replayed");
  assert.equal(proposals().length, 1); assert.equal(tasksOf(proposals()[0].id).length, 1);
  assert.equal(tbl("gw_sales_proposal_sync_log")[0].attempts, 2);
  const resend = await intake(ev());
  assert.equal(resend.body.result, "updated");
  assert.equal(proposals().length, 1); assert.equal(tasksOf(proposals()[0].id).length, 1, "電話タスクは1つのまま");
  assert.equal(actsOf(proposals()[0].id).filter((a) => a.kind === "sent").length, 2, "送り直しは記録に残る");
  // まとめて届いても同じ（dx.enger の再送の回）
  const batch = { events: [ev({ pid: "p-2" }, { id: "p-2" }), b] };
  const r = await call(intakeApi, { method: "POST", body: batch, headers: signed(batch) });
  assert.deepEqual(r.body.results.map((x) => x.result), ["created", "replayed"]);
  assert.equal(proposals().length, 2);
});

await ok("営業担当が決まらなければ未割当（要確認）で起票し、管理側へ通知。あとで決まれば担当とタスクが寄る", async () => {
  setup();
  const r = await intake(ev({}, { sales_owner: { name: "知らない 人", email: "nobody@eight.example" } }));
  assert.equal(r.body.result, "created"); assert.deepEqual(r.body.results[0].warnings, ["owner_unmatched"]);
  const p = proposals()[0];
  assert.equal(p.sales_owner_id, null);
  assert.deepEqual(new Set(notified.map((n) => n.employeeId)), new Set([E_OWNER, E_MGR]));
  assert.equal(tbl("gw_sales_proposal_sync_log")[0].status, "warning");
  // 管理側の「連携エラー」に出る
  const s = await call(syncApi, { url: "/api/sales/proposals/sync", as: MANAGER });
  assert.equal(s.body.items.length, 1); assert.match(s.body.items[0].messageLabel, /営業担当を決められません/);
  assert.equal((await call(syncApi, { url: "/api/sales/proposals/sync", as: S1 })).statusCode, 403, "営業担当は見られない");
  // 退職者・別テナントの同じメールには付けない
  setup();
  await intake(ev({}, { sales_owner: { name: "退職 者", email: "left@eight.example" } }));
  assert.equal(proposals()[0].sales_owner_id, null);
  // 名前がちょうど1人一致なら決める（空白の違いは同じ人）
  setup();
  await intake(ev({}, { sales_owner: { name: "営業　二郎", email: null } }));
  assert.equal(proposals()[0].sales_owner_id, E_S2);
  // 後から担当が分かったとき（提案の更新）：担当と、開いているタスクの担当が決まる
  setup();
  await intake(ev({}, { sales_owner: { name: "誰か", email: null } }));
  await intake(ev({ event_type: "proposal.updated" }, { stage: "確認中" }));
  assert.equal(proposals()[0].sales_owner_id, E_S1);
  assert.equal(tasksOf(proposals()[0].id)[0].assignee_id, E_S1);
  assert.ok(actsOf(proposals()[0].id).some((a) => a.kind === "sync" && /確認中/.test(a.note)), "dx.enger のステージ変更が記録に残る");
});

await ok("企業：dx.enger の企業IDの紐付けがあればその企業。無ければサイトのドメインが1社一致したときだけ。社名だけでは紐付けない", async () => {
  setup();
  await intake(ev());
  assert.equal(proposals()[0].company_id, uid(100), "ドメインが1社一致");
  assert.equal(tbl("gw_sales_company_links").length, 1, "次からはこの企業に入る");
  setup();
  await intake(ev({}, { company: { id: null, name: "株式会社テスト（Sales）", website: null } }));
  assert.equal(proposals()[0].company_id, null, "社名が同じでも紐付けない");
});

// ---- 4・5・6. 電話・メール ---------------------------------------------------------
async function made(over, pOver) {
  setup();
  await intake(ev(over, pOver));
  return proposals()[0];
}

await ok("5 電話の結果が無い・通話できたのに内容が無い・折り返しの日時が無い → 400（記録にしない）", async () => {
  const p = await made();
  for (const [b, field] of [[{ action: "call" }, "result"], [{ action: "call", result: "connected" }, "outcome"],
    [{ action: "call", result: "callback" }, "nextAt"], [{ action: "call", result: "no_answer", occurredAt: new Date(Date.now() + 86400000).toISOString() }, "occurredAt"]]) {
    const r = await act(S1, p.id, b);
    assert.equal(r.statusCode, 400, field); assert.equal(r.body.field, field);
  }
  assert.equal(actsOf(p.id).filter((a) => a.kind === "call").length, 0);
  assert.equal(tasksOf(p.id).find((t) => t.kind === "call").status, "open", "電話タスクは開いたまま");
});

await ok("4 電話「不通」→ 記録が残り、電話タスクは完了・その営業日中のメールのタスクができる・メール待ち", async () => {
  const p = await made();
  const r = await act(S1, p.id, { action: "call", result: "no_answer" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const calls = actsOf(p.id).filter((a) => a.kind === "call");
  assert.equal(calls.length, 1); assert.equal(calls[0].employee_id, E_S1); assert.equal(calls[0].result, "no_answer");
  const call1 = tasksOf(p.id).find((t) => t.source_event === "auto:first_call");
  assert.equal(call1.status, "done"); assert.equal(call1.done_activity_id, calls[0].id);
  const mail = tasksOf(p.id).find((t) => t.kind === "mail");
  assert.ok(mail && mail.status === "open"); assert.match(mail.due_at, /T09:00:00/, "終業 18:00（日本時間）");
  assert.equal(proposals()[0].status, "mail_wait");
  assert.match(r.body.recorded.label, /不通/); assert.ok(r.body.recorded.createdTasks.length === 1);
  // もう一度不通でも、開いているメールのタスクは増やさない
  await act(S1, p.id, { action: "call", result: "absent" });
  assert.equal(tasksOf(p.id).filter((t) => t.kind === "mail" && t.status === "open").length, 1);
});

await ok("6 メールのあと、翌営業日の終業までに回答確認のタスク。メールは自己申告として残る", async () => {
  const p = await made();
  await act(S1, p.id, { action: "call", result: "no_answer" });
  const r = await act(S1, p.id, { action: "mail", occurredAt: "2026-10-16T17:00" });   // 金曜 17:00（日本時間）
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const m = actsOf(p.id).find((a) => a.kind === "mail");
  assert.equal(m.evidence, "self_report");
  assert.equal(tasksOf(p.id).find((t) => t.kind === "mail").status, "done");
  const check = tasksOf(p.id).find((t) => t.kind === "reply_check");
  assert.equal(check.due_at, "2026-10-19T09:00:00.000Z", "翌営業日（月曜）18:00");
  assert.equal(proposals()[0].status, "reply_wait");
  assert.equal(r.body.proposal.mail.selfReported, true);
});

await ok("自動のタスクはチェックだけで完了にできない（記録で片付く）。手動タスクは何をしたかが要る", async () => {
  const p = await made();
  const t = tasksOf(p.id)[0];
  const r = await act(S1, p.id, { action: "task_done", taskId: t.id, note: "電話した" });
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, "needs_record");
  await act(S1, p.id, { action: "task_add", title: "資料を送る", dueAt: "2026-10-20T10:00" });
  const manual = tasksOf(p.id).find((x) => x.kind === "manual");
  assert.equal((await act(S1, p.id, { action: "task_done", taskId: manual.id })).statusCode, 400);
  assert.equal((await act(S1, p.id, { action: "task_done", taskId: manual.id, note: "メールで送付" })).statusCode, 200);
  const done = tasksOf(p.id).find((x) => x.id === manual.id);
  assert.equal(done.status, "done"); assert.ok(done.done_activity_id);
  assert.equal((await act(S1, p.id, { action: "task_cancel", taskId: done.id, reason: "x" })).statusCode, 409, "終わったタスクは変えられない");
});

await ok("期限の変更は理由が必須で、記録に残る。自動タスクの取り消しは管理側だけ", async () => {
  const p = await made();
  const t = tasksOf(p.id)[0];
  const before = t.due_at;
  assert.equal((await act(S1, p.id, { action: "task_due", taskId: t.id, dueAt: "2026-10-20T10:00" })).statusCode, 400);
  const r = await act(S1, p.id, { action: "task_due", taskId: t.id, dueAt: "2026-10-20T10:00", reason: "先方が午後不在" });
  assert.equal(r.statusCode, 200);
  assert.equal(tasksOf(p.id)[0].due_at, "2026-10-20T01:00:00.000Z");
  const dc = actsOf(p.id).find((a) => a.kind === "due_change");
  assert.equal(dc.note, "先方が午後不在"); assert.equal(dc.detail.from, before);
  assert.equal((await act(S1, p.id, { action: "task_cancel", taskId: t.id, reason: "不要" })).statusCode, 403);
  assert.equal((await act(MANAGER, p.id, { action: "task_cancel", taskId: t.id, reason: "重複" })).statusCode, 200);
  assert.equal(tasksOf(p.id)[0].status, "canceled");
});

// ---- 7. 期限超過 -----------------------------------------------------------------
await ok("7 期限超過が、営業担当の一覧と管理側の一覧に出る（赤・件数）。担当でない営業担当には出ない", async () => {
  const p = await made();
  tasksOf(p.id)[0].due_at = new Date(Date.now() - 3600000).toISOString();
  const mine = await list(S1, "?filter=overdue");
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.body.proposals.length, 1); assert.equal(mine.body.proposals[0].overdue, true);
  assert.equal(mine.body.counts.overdue, 1); assert.equal(mine.body.today.overdue, 1);
  const mgr = await list(MANAGER, "?filter=overdue");
  assert.equal(mgr.body.proposals.length, 1);
  assert.equal(mgr.body.kpi.total.overdueTasks, 1);
  assert.equal((await list(S2, "?filter=overdue")).body.proposals.length, 0);
});

// ---- 8. 面談・結果・再提案 ---------------------------------------------------------
await ok("8 通話できた（面談調整へ）→ 面談の日程確定 → 実施 → 成約。dx.enger への状態にも出る", async () => {
  const p = await made();
  await act(S1, p.id, { action: "call", result: "connected", outcome: "meeting" });
  assert.equal(proposals()[0].status, "meeting_adjust");
  assert.ok(tasksOf(p.id).some((t) => t.kind === "meeting_fix" && t.status === "open"));
  await act(S1, p.id, { action: "meeting", result: "scheduled", nextAt: "2026-10-22T14:00" });
  assert.equal(proposals()[0].meeting_at, "2026-10-22T05:00:00.000Z");
  assert.equal(tasksOf(p.id).find((t) => t.kind === "meeting_fix").status, "done");
  await act(S1, p.id, { action: "meeting", result: "done" });
  assert.equal(proposals()[0].status, "meeting_done");
  const won = await act(S1, p.id, { action: "result", status: "won" });
  assert.equal(won.statusCode, 200, JSON.stringify(won.body));
  assert.equal(proposals()[0].status, "won"); assert.ok(proposals()[0].closed_at);
  assert.ok(tasksOf(p.id).every((t) => t.status !== "open"), "成約で開いているタスクは取り消し");
  assert.ok(tasksOf(p.id).filter((t) => t.status === "canceled").every((t) => /成約/.test(t.cancel_reason)));
  const s = await statusOf(["p-1", "p-zz"]);
  assert.equal(s.statusCode, 200);
  assert.equal(s.body.items[0].status, "won"); assert.equal(s.body.items[0].closed, true);
  assert.deepEqual(s.body.missing, ["p-zz"]);
  assert.ok(!JSON.stringify(s.body).includes("madoguchi"), "窓口の連絡先は返さない");
  assert.match(s.body.items[0].url, /^https:\/\/gw\.example\.jp\/sales\/proposals\.html\?id=/);
  // 終わった提案には電話を足せない（メモは足せる）
  assert.equal((await act(S1, p.id, { action: "call", result: "no_answer" })).statusCode, 409);
  assert.equal((await act(S1, p.id, { action: "memo", note: "契約書を送付" })).statusCode, 200);
});

await ok("8 見送りは理由コード（企業側／人材側）を分けて必須。別候補希望は再提案依頼（dx.enger に返る）", async () => {
  const p = await made();
  assert.equal((await act(S1, p.id, { action: "result", status: "lost" })).statusCode, 400);
  assert.equal((await act(S1, p.id, { action: "result", status: "lost", reason: "no_reply" })).statusCode, 400, "無回答は見送りの理由にしない");
  const p2 = await made({ pid: "p-9" }, { id: "p-9" });
  await act(S1, p2.id, { action: "call", result: "connected", outcome: "other_candidate" });
  assert.equal(proposals()[0].status, "reproposal"); assert.equal(proposals()[0].close_reason, "other_candidate");
  const s = await statusOf(["p-9"]);
  assert.equal(s.body.items[0].reproposal_requested, true);
  const r = await act(S1, p2.id, { action: "result", status: "lost", reason: "talent_declined" });
  assert.equal(r.statusCode, 200);
  assert.equal(proposals()[0].close_reason, "talent_declined"); assert.equal(r.body.proposal.closeReasonLabel, "人材側の辞退");
});

// ---- 9. 担当変更 -----------------------------------------------------------------
await ok("9 担当変更は管理側だけ。記録の実施者は変わらず、開いているタスクは新しい担当へ。新しい担当に通知", async () => {
  const p = await made();
  await act(S1, p.id, { action: "call", result: "no_answer" });
  assert.equal((await act(S1, p.id, { action: "assign", ownerId: E_S2 })).statusCode, 403);
  assert.equal((await act(MANAGER, p.id, { action: "assign", ownerId: E_NONE })).statusCode, 400, "Sales を使えない人は担当にできない");
  notified.length = 0;
  const r = await act(MANAGER, p.id, { action: "assign", ownerId: E_S2 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(proposals()[0].sales_owner_id, E_S2);
  assert.equal(actsOf(p.id).find((a) => a.kind === "call").employee_id, E_S1, "誰が電話したかは変わらない");
  assert.ok(tasksOf(p.id).filter((t) => t.status === "open").every((t) => t.assignee_id === E_S2));
  assert.deepEqual(notified.map((n) => n.employeeId), [E_S2]);
  assert.equal((await detail(S1, p.id)).statusCode, 404, "前の担当（営業担当）には見えなくなる");
  assert.equal((await detail(S2, p.id)).statusCode, 200);
  // KPI はいまの担当で数え、電話の実施は実施した人の記録のまま
  const k = (await list(MANAGER)).body.kpi;
  const s2row = k.byOwner.find((x) => x.ownerId === E_S2);
  assert.equal(s2row.proposals, 1); assert.equal(s2row.called, 1);
});

// ---- 10. 見える範囲 --------------------------------------------------------------
await ok("10 権限の無い社員は 403。別テナントには見えない。営業担当は自分の担当だけ（owner=all を付けても広がらない）", async () => {
  setup();
  await intake(ev());
  await intake(ev({ pid: "p-2" }, { id: "p-2", sales_owner: { email: "s2@eight.example" } }));
  await intake(ev({ pid: "p-3" }, { id: "p-3", sales_owner: { email: null, name: null } }));
  assert.equal((await list(NOPERM)).statusCode, 403);
  const s1 = await list(S1, "?filter=all&owner=all");
  assert.deepEqual(s1.body.proposals.map((p) => p.sourceProposalId), ["p-1"]);
  assert.equal(s1.body.counts.unassigned, undefined, "担当未割当の件数は管理側だけ");
  const mgr = await list(MANAGER, "?filter=all");
  assert.equal(mgr.body.proposals.length, 3); assert.equal(mgr.body.counts.unassigned, 1);
  assert.equal((await list(MANAGER, "?filter=all&owner=none")).body.proposals.length, 1);
  assert.equal((await list(OWNER, "?filter=all")).body.proposals.length, 3, "経営者は Sales アプリ権限が無くても全件");
  const other = await list(OTHER_T, "?filter=all");
  assert.equal(other.body.proposals.length, 0);
  const p2 = proposals().find((p) => p.source_proposal_id === "p-2");
  assert.equal((await detail(S1, p2.id)).statusCode, 404);
  assert.equal((await act(S1, p2.id, { action: "call", result: "no_answer" })).statusCode, 404, "他人の提案に記録できない");
  assert.equal((await detail(OTHER_T, p2.id)).statusCode, 404);
  // 営業担当は他人を担当にした提案を手で足せない
  assert.equal((await call(listApi, { method: "POST", body: { companyName: "A社", title: "PC", salesOwnerId: E_S2 }, as: S1 })).statusCode, 403);
  const mine = await call(listApi, { method: "POST", body: { companyName: "A社", title: "PCレンタル 20台", service: "PCレンタル" }, as: S1 });
  assert.equal(mine.statusCode, 200);
  const manual = proposals().find((p) => p.id === mine.body.proposal.id);
  assert.equal(manual.source_system, "manual"); assert.equal(manual.sales_owner_id, E_S1);
  assert.equal(tasksOf(manual.id).length, 1);
});

// ---- 11. 返信なし --------------------------------------------------------------
await ok("11 返信なし：1回目で再フォロー（3営業日）、2回目で管理者確認（5営業日・上長が担当）。その先は管理者が決める", async () => {
  const p = await made({}, { sent_at: "2026-10-16T01:00:00.000Z" });   // 金曜 10:00（日本時間）
  await act(S1, p.id, { action: "call", result: "no_answer" });
  await act(S1, p.id, { action: "mail" });
  await act(S1, p.id, { action: "check" });
  const ref = tasksOf(p.id).find((t) => t.source_event === "auto:refollow");
  assert.ok(ref);
  assert.equal(proposals()[0].status, "reply_wait", "1回の無回答で終わりにしない");
  await act(S1, p.id, { action: "call", result: "no_answer" });   // 再フォローの電話
  assert.equal(tasksOf(p.id).find((t) => t.id === ref.id).status, "done");
  await act(S1, p.id, { action: "mail" });
  await act(S1, p.id, { action: "check" });
  const rev = tasksOf(p.id).find((t) => t.source_event === "auto:review");
  assert.ok(rev); assert.equal(rev.kind, "manager_review"); assert.equal(rev.assignee_id, E_MGR, "営業担当の上長");
  await act(S1, p.id, { action: "check" });
  assert.equal(tasksOf(p.id).filter((t) => t.source_event === "auto:review").length, 1, "管理者確認は1回だけ");
  assert.equal((await act(S1, p.id, { action: "decision", result: "close" })).statusCode, 403, "判断は管理者");
  const r = await act(MANAGER, p.id, { action: "decision", result: "close", note: "3回連絡して無回答" });
  assert.equal(r.statusCode, 200);
  assert.equal(proposals()[0].status, "closed_no_reply"); assert.equal(proposals()[0].close_reason, "no_reply");
  assert.equal(tasksOf(p.id).find((t) => t.id === rev.id).status, "done");
  // 管理者は再開できる（継続）
  const again = await act(MANAGER, p.id, { action: "decision", result: "continue", nextAt: "2026-11-02T10:00" });
  assert.equal(again.statusCode, 200);
  assert.equal(proposals()[0].status, "reply_wait"); assert.equal(proposals()[0].closed_at, null);
});

// ---- 12. 営業時間・連絡停止 ---------------------------------------------------------
await ok("12 営業時間外（金曜 20:00）に送った提案は、次の営業日（月曜）9:30 が初回電話の期限。祝日・自社休業日も飛ばす", async () => {
  let p = await made({}, { sent_at: "2026-10-16T11:00:00.000Z" });   // 金曜 20:00 JST
  assert.equal(tasksOf(p.id)[0].due_at, "2026-10-19T00:30:00.000Z");
  p = await made({}, { sent_at: "2026-10-09T10:00:00.000Z" });       // 金曜 19:00 JST → 10/12（月）は祝日 → 10/13
  assert.equal(tasksOf(p.id)[0].due_at, "2026-10-13T00:30:00.000Z");
  // 自社休業日（設定）も飛ばす。設定は管理側だけが変えられる
  setup();
  assert.equal((await call(settingsApi, { method: "PATCH", body: { firstCallMinutes: 60 }, as: S1 })).statusCode, 403);
  assert.equal((await call(settingsApi, { method: "PATCH", body: { bizStart: "19:00" }, as: MANAGER })).statusCode, 400, "始業 < 終業");
  const st = await call(settingsApi, { method: "PATCH", body: { extraHolidays: "2026-10-19", firstCallMinutes: 60 }, as: MANAGER });
  assert.equal(st.statusCode, 200, JSON.stringify(st.body));
  await intake(ev({}, { sent_at: "2026-10-16T11:00:00.000Z" }));
  assert.equal(tasksOf(proposals()[0].id)[0].due_at, "2026-10-20T01:00:00.000Z", "10/19 は休業日 → 10/20 の 9:00 + 60分");
});

await ok("12 連絡停止の希望：連絡停止で終わり、開いているタスクは取り消し、自動の追客は作らない", async () => {
  const p = await made();
  const r = await act(S1, p.id, { action: "call", result: "do_not_contact", note: "今後の連絡は不要とのこと" });
  assert.equal(r.statusCode, 200);
  const after = proposals()[0];
  assert.equal(after.status, "stopped"); assert.equal(after.contact_stop, true); assert.equal(after.close_reason, "contact_stop");
  assert.equal(tasksOf(p.id).filter((t) => t.status === "open").length, 0);
  assert.equal(tasksOf(p.id).filter((t) => t.kind === "mail").length, 0);
  // dx.enger から送り直しが来ても、終わった提案は再開しない
  await intake(ev());
  assert.equal(proposals()[0].status, "stopped"); assert.equal(tasksOf(p.id).filter((t) => t.status === "open").length, 0);
});

// ---- 企業の履歴 -----------------------------------------------------------------
await ok("企業に紐付いていれば、電話・メール・返信は企業の営業履歴にも写り、最終連絡が進む。手で紐付け直すと監査ログ", async () => {
  const p = await made();
  await act(S1, p.id, { action: "call", result: "no_answer" });
  const evs = tbl("gw_sales_events").filter((e) => e.company_id === uid(100));
  assert.equal(evs.length, 1); assert.equal(evs[0].event_key, "call"); assert.match(evs[0].label, /提案フォロー：電話：不通/);
  assert.ok(mem.rows.gw_sales_companies.find((c) => c.id === uid(100)).last_contact_at);
  logged.length = 0;
  const r = await act(S1, p.id, { action: "link", companyId: uid(101) });
  assert.equal(r.statusCode, 200);
  assert.equal(proposals()[0].company_id, uid(101));
  assert.equal(tbl("gw_sales_company_links")[0].company_id, uid(101), "dx.enger の企業IDの紐付けも付け替える");
  assert.ok(logged.some((l) => l.action === "sales.proposal_link" && l.detail.from === uid(100) && l.detail.to === uid(101)));
  // 未紐付けの提案から企業を登録
  const p2 = await made({}, { company: { id: null, name: "新規 株式会社", website: null } });
  const c = await act(S1, p2.id, { action: "link", create: true });
  assert.equal(c.statusCode, 200);
  assert.ok(proposals()[0].company_id);
  assert.equal(mem.rows.gw_sales_companies.find((x) => x.id === proposals()[0].company_id).name, "新規 株式会社");
});

await ok("DB 未適用（表が無い）なら 503 not_ready と、流す SQL の案内（db/138・db/140）", async () => {
  setup();
  mem.state.missing = "gw_sales_proposals";
  const r = await list(MANAGER);
  assert.equal(r.statusCode, 503); assert.match(r.body.message, /db\/138_sales_proposals\.sql/); assert.match(r.body.message, /db\/140_sales_proposal_matching\.sql/);
  mem.state.missing = null;
});

// ---- 13・14. マッチング確定（db/140） -------------------------------------------------
const matchedAt = () => new Date(Date.now() - 5 * 60000).toISOString();
const evm = (over = {}, pOver = {}) => {
  const e = ev({ event_id: `enger:proposal.matched:${over.pid || "p-1"}:fixed01`, event_type: "proposal.matched", ...over },
    { sent_at: null, matched_at: matchedAt(), ...pOver });
  return e;
};

await ok("13 マッチング確定で起票：提案待ち・送信日時は空・提案準備1件（電話のタスクは作らない）・ベルと Slack（メンション）", async () => {
  setup();
  mem.rows.gw_sales_proposal_settings = [{ tenant_id: T1, slack_members: { [E_S1]: "U0S1ABCDE" } }];
  const r = await intake(evm());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.result, "created");
  const p = proposals()[0];
  assert.equal(p.status, "proposal_wait"); assert.equal(p.sent_at, null); assert.ok(p.matched_at); assert.equal(p.sales_owner_id, E_S1);
  const ts = tasksOf(p.id);
  assert.deepEqual(ts.map((t) => [t.kind, t.source_event, t.assignee_id]), [["prepare", "auto:prepare", E_S1]], "電話のタスクは無い（30分を始めない）");
  assert.deepEqual(actsOf(p.id).map((a) => a.kind), ["matched"]);
  assert.deepEqual(notified.map((n) => n.employeeId), [E_S1]); assert.match(notified[0].title, /マッチング確定/); assert.match(notified[0].title, /提案準備/);
  assert.equal(slackPosts.length, 1, "Slack に1回");
  const text = slackPosts[0].body.text;
  assert.match(text, /マッチング確定・提案待ち/); assert.match(text, /<@U0S1ABCDE>/, "営業担当をメンション");
  assert.match(text, /株式会社テスト/); assert.match(text, /T\.K\./); assert.ok(!/madoguchi|03-1111/i.test(text), "窓口の連絡先は載せない");
  assert.ok(p.slack_notified_at, "通知済みの印");
  // 一覧：提案待ち・電話未実施に数えない・今日の提案準備
  const l = await list(S1);
  assert.equal(l.body.counts.proposal_wait, 1); assert.equal(l.body.counts.no_call, 0);
  // 「今日の提案準備」は期限が今日のものだけ（終業まで1時間を切って確定した・休日なら翌営業日の期限なので0件）。流す時刻で変わらないよう、期限から決める
  const jstDay = (iso) => new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 10);
  assert.equal(l.body.today.prepare, jstDay(ts[0].due_at) === jstDay(new Date().toISOString()) ? 1 : 0, "今日の提案準備");
  assert.equal(l.body.kpi.total.proposals, 0, "KPI は企業へ送った提案だけ");
  // dx.enger への状態：提案待ち・確定日時あり・送信日時なし
  const st = await statusOf(["p-1"]);
  assert.equal(st.body.items[0].status, "proposal_wait"); assert.equal(st.body.items[0].status_label, "マッチング済み・提案待ち");
  assert.ok(st.body.items[0].matched_at); assert.equal(st.body.items[0].sent_at, null);
  assert.match(st.body.items[0].next_task.title, /提案準備/);
});

await ok("13 確定の重複：同じイベントは replayed・別のイベント（ゴミ箱から戻した等）は記録だけ。提案もタスクも Slack も増えない", async () => {
  setup();
  const b = evm();
  await intake(b);
  assert.equal((await intake(b)).body.result, "replayed");
  const again = await intake(evm({ event_id: "enger:proposal.matched:p-1:restore1" }));
  assert.equal(again.body.result, "updated");
  assert.equal(proposals().length, 1); assert.equal(tasksOf(proposals()[0].id).length, 1); assert.equal(slackPosts.length, 1);
  // 同時に2つ届いても Slack は1回（先に印を取った方だけ）
  setup();
  const [x, y] = await Promise.all([intake(evm({ pid: "p-9" }, { id: "p-9" })), intake(evm({ pid: "p-9", event_id: "enger:proposal.matched:p-9:other01" }, { id: "p-9" }))]);
  const results = [x.body.result, y.body.result];
  assert.equal(results.filter((r) => r === "created").length, 1, `起票は1回だけ（${results.join(",")}）`);
  assert.ok(results.every((r) => ["created", "updated", "replayed"].includes(r)), results.join(","));
  assert.equal(proposals().length, 1); assert.equal(slackPosts.length, 1);
  // 確定日時の無い確定・未来の確定は 400（下書きを起票しない）
  setup();
  const bad = await intake(evm({}, { matched_at: null }));
  assert.equal(bad.statusCode, 400); assert.equal(bad.body.field, "proposal.matched_at");
  assert.equal(proposals().length, 0); assert.equal(slackPosts.length, 0);
});

await ok("14 確定のあとに dx.enger から企業へ送った：電話待ち・提案準備は完了（送った記録とひも付け）・電話は送った時刻から30分。Slack は増えない", async () => {
  setup();
  await intake(evm());
  const p0 = proposals()[0];
  const sentAt = new Date(Date.now() - 60000).toISOString();
  const r = await intake(ev({}, { sent_at: sentAt }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.result, "updated");
  const p = proposals()[0];
  assert.equal(p.status, "call_wait"); assert.equal(p.sent_at, sentAt); assert.equal(p.matched_at, p0.matched_at, "確定日時は変えない");
  const ts = tasksOf(p.id);
  const prep = ts.find((t) => t.kind === "prepare");
  const sentAct = actsOf(p.id).find((a) => a.kind === "sent");
  assert.equal(prep.status, "done"); assert.equal(prep.done_activity_id, sentAct.id, "提案準備は送った記録で完了");
  const call = ts.find((t) => t.kind === "call");
  assert.equal(call.source_event, "auto:first_call"); assert.equal(call.assignee_id, E_S1);
  assert.ok(Date.parse(call.due_at) >= Date.parse(sentAt), "期限は送った時刻から（確定から数えない）");
  assert.ok(notified.some((n) => n.dedupeKey === `sales_proposal_call:${p.id}` && /初回電話/.test(n.title)), "電話の期限をベルで知らせる");
  assert.equal(slackPosts.length, 1, "Slack は確定のときの1回だけ");
  // 送り直し：再送の記録だけ。電話は増えない
  await intake(ev({}, { sent_at: new Date().toISOString() }));
  assert.equal(tasksOf(p.id).filter((t) => t.kind === "call").length, 1);
  assert.equal(proposals()[0].sent_at, sentAt, "送信日時は最初のまま");
  assert.equal(actsOf(p.id).filter((a) => a.kind === "sent" && a.result === "resent").length, 1);
});

await ok("14 送信の受け付けが途中で落ちても、同じイベントの送り直しで電話のタスクが1つだけできる（提案準備も完了）", async () => {
  setup();
  await intake(evm());
  const b = ev();
  failOnce.callWait = true;
  const first = await intake(b);
  assert.equal(first.statusCode, 500, "途中で落ちたら 500（dx.enger が送り直す）");
  assert.equal(proposals()[0].status, "proposal_wait", "提案の状態はまだ変わっていない");
  const again = await intake(b);
  assert.equal(again.statusCode, 200, JSON.stringify(again.body)); assert.equal(again.body.result, "updated");
  const p = proposals()[0];
  assert.equal(p.status, "call_wait"); assert.ok(p.sent_at);
  const ts = tasksOf(p.id);
  assert.equal(ts.filter((t) => t.kind === "call").length, 1, "電話は1つだけ");
  assert.equal(ts.find((t) => t.kind === "prepare").status, "done");
  assert.equal(actsOf(p.id).filter((a) => a.kind === "sent").length, 1, "送った記録も1つだけ");
});

await ok("14 確定と送信が同時に届いても、電話待ち・電話のタスク1つ・提案準備は残らない（どちらが先に作っても）", async () => {
  for (let i = 0; i < 4; i++) {
    setup();
    const [m, s2] = i % 2
      ? await Promise.all([intake(evm()), intake(ev())])
      : (await Promise.all([intake(ev()), intake(evm())])).reverse();
    assert.equal(m.statusCode, 200, JSON.stringify(m.body)); assert.equal(s2.statusCode, 200, JSON.stringify(s2.body));
    assert.equal(proposals().length, 1);
    const p = proposals()[0];
    assert.equal(p.status, "call_wait", `回 ${i}`); assert.ok(p.sent_at);
    const ts = tasksOf(p.id);
    assert.equal(ts.filter((t) => t.kind === "call").length, 1, `電話は1つ（回 ${i}）`);
    assert.ok(ts.filter((t) => t.kind === "prepare").every((t) => t.status === "done"), `提案準備は開いたまま残らない（回 ${i}）`);
    assert.equal(slackPosts.length, 1, `Slack は1回（回 ${i}）`);
  }
});

await ok("14 届く順が逆（送信が先・確定があと）：送信で電話待ちに起票し、確定は日時を補うだけ（提案準備は作らない・Slack は1回）", async () => {
  setup();
  const r = await intake(ev());
  assert.equal(r.body.result, "created");
  assert.equal(proposals()[0].status, "call_wait"); assert.equal(proposals()[0].matched_at ?? null, null);
  assert.equal(slackPosts.length, 1); assert.match(slackPosts[0].body.text, /提案送信・電話待ち/);
  const m = await intake(evm());
  assert.equal(m.body.result, "updated");
  const p = proposals()[0];
  assert.equal(p.status, "call_wait"); assert.ok(p.matched_at, "確定日時を補う");
  assert.equal(tasksOf(p.id).filter((t) => t.kind === "prepare").length, 0); assert.equal(slackPosts.length, 1);
});

await ok("14 Sales で「企業へ提案した」：提案待ちのときだけ。電話・メールなどは送るまで記録できない。記録すると電話待ち＋30分", async () => {
  setup();
  await intake(evm());
  const p = proposals()[0];
  const early = await act(S1, p.id, { action: "call", result: "no_answer" });
  assert.equal(early.statusCode, 409); assert.equal(early.body.error, "not_sent");
  assert.equal((await act(S1, p.id, { action: "mail" })).statusCode, 409);
  assert.equal((await act(S2, p.id, { action: "sent" })).statusCode, 404, "担当でない営業担当には見えない");
  const r = await act(S1, p.id, { action: "sent", channel: "phone", note: "電話で提案" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(proposals()[0].status, "call_wait"); assert.ok(proposals()[0].sent_at);
  assert.deepEqual(r.body.recorded.createdTasks.length, 1); assert.match(r.body.recorded.createdTasks[0], /初回電話/);
  assert.equal(tasksOf(p.id).find((t) => t.kind === "prepare").status, "done");
  assert.equal(actsOf(p.id).find((a) => a.kind === "sent").evidence, "self_report");
  const twice = await act(S1, p.id, { action: "sent" });
  assert.equal(twice.statusCode, 409); assert.equal(twice.body.error, "already_sent");
  assert.equal((await act(S1, p.id, { action: "call", result: "no_answer" })).statusCode, 200, "送ったあとは電話を記録できる");
  // 提案待ちのまま見送り（人材の辞退など）にもできる
  setup();
  await intake(evm());
  const q = proposals()[0];
  const lost = await act(S1, q.id, { action: "result", status: "lost", reason: "talent_declined" });
  assert.equal(lost.statusCode, 200); assert.equal(proposals()[0].status, "lost");
  assert.equal(tasksOf(q.id).find((t) => t.kind === "prepare").status, "canceled", "提案準備は取り消し（完了にはしない）");
});

await ok("13 Slack：送れなかったら印を戻して連携の確認に要確認。未設定なら送らない（ベルは届く）。担当未割当は名前の代わりに未割当", async () => {
  setup();
  slackDown = true;
  const r = await intake(evm());
  assert.equal(r.statusCode, 200);
  assert.equal(proposals()[0].slack_notified_at, null, "送れなかった印は戻す");
  const log = tbl("gw_sales_proposal_sync_log")[0];
  assert.equal(log.status, "warning"); assert.match(log.message, /slack_failed/);
  assert.ok(notified.length >= 1, "ベルには届いている");
  // 未設定
  setup();
  const keepS = process.env.SALES_SLACK_WEBHOOK_URL, keepG = process.env.SLACK_WEBHOOK_URL;
  process.env.SALES_SLACK_WEBHOOK_URL = ""; process.env.SLACK_WEBHOOK_URL = "";
  try {
    await intake(evm());
    assert.equal(slackPosts.length, 0); assert.equal(proposals()[0].slack_notified_at ?? null, null);
    assert.equal(tbl("gw_sales_proposal_sync_log")[0].status, "ok");
  } finally { process.env.SALES_SLACK_WEBHOOK_URL = keepS; process.env.SLACK_WEBHOOK_URL = keepG || ""; }
  // 担当未割当（CL担当が社員名簿に無い）
  setup();
  await intake(evm({}, { sales_owner: { name: "知らない人", email: "nobody@eight.example" } }));
  assert.match(slackPosts[0].body.text, /担当未割当/);
  assert.deepEqual(notified.map((n) => n.employeeId).sort(), [E_MGR, E_OWNER].sort(), "管理側に知らせる");
});

console.log(`\nsales proposals: 合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) process.exit(1);
