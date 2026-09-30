// /api/office/contracts（案件の一括更新・削除）を、偽の Supabase で通す。
//
// ■ 何を守るテストか
//   1. 入れるのは 経営者・責任者・経理 だけ。二段階認証（MFA）は要求しない。ほかの人は 403 で、何も読まず・書かない
//   2. 更新：更新確認状況・契約終了予定・契約開始日だけ。単価・精算条件・勤務時間は 400。1件でも合わなければ何も変えない（全部かゼロ）
//   3. 削除：即削除は禁止（confirm: true と、件数の一致が要る）。請求の印が付いた案件は消せない
//   4. 削除：Storage の勤務表ファイルを、DB より先に消す。消せなかったら DB は触らない（孤児を作らない）
//   5. 削除：月次進捗・提出・契約条件・勤務表・日別は一緒に消え、要員は残る。履歴（gw_office_events）に残す
//   6. 他社（別テナント）の案件は、404 で触れない
import assert from "node:assert/strict";
import {
  atRoot, mem, ctl, asked, logged, call, OWNER, MANAGER, FINANCE, DENIED, P,
  uid, T1, T2, E_PP, E_BP, E_X, C_PP, C_BP, C_X,
} from "./_officeharness.mjs";

const { default: api } = await import(atRoot("api/office/contracts.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const post = (body, o = {}) => call(api, "/api/office/contracts", { method: "POST", body: { month: "2026-10", ...body }, ...o });
const rows = (t) => mem.rows[t] || [];
const BUCKET = "billing-submissions";
const PATH_PP = `${T1}/${E_PP}/s1.pdf`, PATH_PP2 = `${T1}/${E_PP}/s2.png`, PATH_BP = `${T1}/${E_BP}/s3.pdf`, PATH_X = `${T2}/${E_X}/s9.pdf`;
const TS_PP = uid(41), TS_BP = uid(42);

function setup() {
  mem.reset();
  ctl.who = OWNER; ctl.aal = "aal2";
  asked.length = 0; logged.length = 0;
  mem.rows.gw_employees = [
    { id: E_PP, tenant_id: T1, display_name: "田中 太郎" },
    { id: E_BP, tenant_id: T1, display_name: "鈴木 次郎" },
    { id: E_X, tenant_id: T2, display_name: "他社の人" },
  ];
  mem.rows.gw_site_contracts = [
    { id: C_PP, tenant_id: T1, employee_id: E_PP, engagement_kind: "pp", site_company: "顧客A社", period_from: "2026-04-01", period_to: "2027-03-31",
      renewal_status: "pending", unit_price: 999999, unit_price_type: "月額", settlement_condition: "元の条件" },
    { id: C_BP, tenant_id: T1, employee_id: E_BP, engagement_kind: "bp", site_company: "顧客B社", period_from: "2026-06-01", period_to: null,
      renewal_status: "confirmed", unit_price: 500000, unit_price_type: "月額", settlement_condition: "BP条件" },
    { id: C_X, tenant_id: T2, employee_id: E_X, engagement_kind: "pp", site_company: "他社", period_from: "2026-01-01", renewal_status: "pending" },
  ];
  mem.rows.gw_billing_progress = [
    { id: uid(51), tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, billing_month: "2026-10" },
    { id: uid(52), tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, billing_month: "2026-09" },
    { id: uid(53), tenant_id: T1, employee_id: E_BP, site_contract_id: C_BP, billing_month: "2026-10" },
  ];
  mem.rows.gw_submissions = [
    { id: uid(61), tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, target_month: "2026-10", kind: "timesheet", file_name: "a.pdf", mime_type: "application/pdf", storage_path: PATH_PP },
    { id: uid(62), tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, target_month: "2026-09", kind: "timesheet", file_name: "b.png", mime_type: "image/png", storage_path: PATH_PP2 },
    { id: uid(63), tenant_id: T1, employee_id: E_BP, site_contract_id: C_BP, target_month: "2026-10", kind: "timesheet", file_name: "c.pdf", mime_type: "application/pdf", storage_path: PATH_BP },
    { id: uid(64), tenant_id: T2, employee_id: E_X, site_contract_id: C_X, target_month: "2026-10", kind: "timesheet", file_name: "x.pdf", mime_type: "application/pdf", storage_path: PATH_X },
  ];
  mem.rows.gw_site_contract_terms = [
    { id: uid(71), tenant_id: T1, site_contract_id: C_PP, valid_from: "2026-04-01", pricing_type: "monthly", sales_unit_price: 700000 },
    { id: uid(72), tenant_id: T1, site_contract_id: C_BP, valid_from: "2026-06-01", pricing_type: "monthly", purchase_unit_price: 500000 },
  ];
  mem.rows.gw_timesheets = [
    { id: TS_PP, tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, target_month: "2026-10", status: "confirmed" },
    { id: TS_BP, tenant_id: T1, employee_id: E_BP, site_contract_id: C_BP, target_month: "2026-10", status: "draft" },
  ];
  mem.rows.gw_timesheet_days = [
    { id: uid(81), tenant_id: T1, timesheet_id: TS_PP, work_date: "2026-10-01" },
    { id: uid(82), tenant_id: T1, timesheet_id: TS_PP, work_date: "2026-10-02" },
    { id: uid(83), tenant_id: T1, timesheet_id: TS_BP, work_date: "2026-10-01" },
  ];
  mem.rows.gw_office_events = [
    { id: uid(91), tenant_id: T1, billing_month: "2026-10", employee_id: E_PP, site_contract_id: C_PP, kind: "sheet.upload", detail: {} },
  ];
  for (const p of [PATH_PP, PATH_PP2, PATH_BP, PATH_X]) mem.put(BUCKET, p, "x");
}

console.log("— 入れる人・二段階認証（MFA は要求しない）—");
for (const [label, p] of [["経営者", OWNER], ["責任者", MANAGER], ["経理", FINANCE]]) {
  await ok(`${label} は、preview・update・delete できる`, async () => {
    setup(); ctl.who = p;
    assert.equal((await post({ action: "preview", ids: [C_PP] })).statusCode, 200);
    assert.equal((await post({ action: "update", ids: [C_PP], fields: { renewalStatus: "confirmed" } })).statusCode, 200);
    assert.equal((await post({ action: "delete", ids: [C_PP], confirm: true, confirmCount: 1 })).statusCode, 200);
  });
}
for (const [label, p] of Object.entries(DENIED)) {
  await ok(`${label} は 403。何も読まず・書かず・消さない`, async () => {
    setup(); ctl.who = p;
    for (const action of ["preview", "update", "delete"]) {
      const r = await post({ action, ids: [C_PP], fields: { renewalStatus: "confirmed" }, confirm: true, confirmCount: 1 });
      assert.equal(r.statusCode, 403, action);
      assert.equal(r.body.error, "forbidden");
    }
    assert.equal(asked.length, 0);
    assert.equal(mem.state.log.length, 0);
    assert.equal(mem.removed.length, 0);
    assert.equal(logged.length, 0);
    assert.equal(rows("gw_site_contracts").length, 3);
  });
}
await ok("MFA 未登録・aal1 でも、更新・削除できる。権限のない人は aal1 でも 403 forbidden", async () => {
  for (const [label, p] of [["経営者", OWNER], ["責任者", MANAGER], ["経理", FINANCE]]) {
    setup(); ctl.who = { ...p, factors: [] }; ctl.aal = "aal1";
    assert.equal((await post({ action: "update", ids: [C_PP], fields: { renewalStatus: "ending" } })).statusCode, 200, `${label} update`);
    assert.equal((await post({ action: "delete", ids: [C_PP], confirm: true, confirmCount: 1 })).statusCode, 200, `${label} delete`);
  }
  setup(); ctl.who = P(["sales"]); ctl.aal = "aal1";
  assert.equal((await post({ action: "preview", ids: [C_PP] })).body.error, "forbidden");
});
await ok("POST 以外は 405。所属のない人は 403 no_membership", async () => {
  setup();
  assert.equal((await call(api, "/api/office/contracts", { method: "GET" })).statusCode, 405);
  ctl.who = { ...OWNER, tenantId: null };
  assert.equal((await post({ action: "preview", ids: [C_PP] })).body.error, "no_membership");
});

console.log("— 入力の検査 —");
await ok("ids が無い・空・UUID でない・101件 は 400", async () => {
  setup();
  for (const ids of [undefined, [], ["abc"], [C_PP, "x"], Array.from({ length: 101 }, (_, i) => uid(1000 + i))]) {
    assert.equal((await post({ action: "preview", ids })).statusCode, 400, JSON.stringify(ids)?.slice(0, 30));
  }
});
await ok("知らない action は 400", async () => {
  setup();
  assert.equal((await post({ action: "drop", ids: [C_PP] })).statusCode, 400);
  assert.equal((await post({ ids: [C_PP] })).statusCode, 400);
});
await ok("他社の案件・存在しない案件が混ざると 404。ほかの案件も触らない", async () => {
  setup();
  const a = await post({ action: "update", ids: [C_PP, C_X], fields: { renewalStatus: "confirmed" } });
  assert.equal(a.statusCode, 404);
  assert.deepEqual(a.body.missing, [C_X]);
  const b = await post({ action: "delete", ids: [C_PP, uid(999)], confirm: true, confirmCount: 2 });
  assert.equal(b.statusCode, 404);
  assert.equal(rows("gw_site_contracts").length, 3);
  assert.equal(rows("gw_site_contracts")[0].renewal_status, "pending");
  assert.equal(mem.removed.length, 0);
});
await ok("同じ id を重ねて送っても、1件として数える", async () => {
  setup();
  const r = await post({ action: "preview", ids: [C_PP, C_PP] });
  assert.equal(r.body.count, 1);
});

console.log("— 更新 —");
await ok("更新確認状況を、選んだ案件だけ変える。ほかの案件・ほかの項目は変わらない", async () => {
  setup();
  const r = await post({ action: "update", ids: [C_PP, C_BP], fields: { renewalStatus: "ending" } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.updated, 2);
  const [a, b, x] = rows("gw_site_contracts");
  assert.equal(a.renewal_status, "ending");
  assert.equal(b.renewal_status, "ending");
  assert.equal(x.renewal_status, "pending");
  assert.equal(a.unit_price, 999999);
  assert.equal(a.settlement_condition, "元の条件");
  assert.equal(a.period_to, "2027-03-31");
});
await ok("契約終了予定を変える／null で未定に戻す", async () => {
  setup();
  assert.equal((await post({ action: "update", ids: [C_PP, C_BP], fields: { periodTo: "2027-09-30" } })).statusCode, 200);
  assert.deepEqual(rows("gw_site_contracts").slice(0, 2).map((c) => c.period_to), ["2027-09-30", "2027-09-30"]);
  assert.equal((await post({ action: "update", ids: [C_PP], fields: { periodTo: null } })).statusCode, 200);
  assert.equal(rows("gw_site_contracts")[0].period_to, null);
});
await ok("契約開始日を変える（記録のある月より前なら通る）", async () => {
  setup();
  const r = await post({ action: "update", ids: [C_PP], fields: { periodFrom: "2026-01-01" } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(rows("gw_site_contracts")[0].period_from, "2026-01-01");
});
await ok("単価・精算条件・勤務時間などは一括で変えられない（400 field_not_allowed）。何も変わらない", async () => {
  setup();
  for (const k of ["unitPrice", "unit_price", "settlementCondition", "salesUnitPrice", "workHours", "siteCompany", "employeeId", "engagementKind", "tenant_id", "id"]) {
    const r = await post({ action: "update", ids: [C_PP], fields: { renewalStatus: "confirmed", [k]: 1 } });
    assert.equal(r.statusCode, 400, k);
    assert.equal(r.body.error, "field_not_allowed", k);
    assert.deepEqual(r.body.fields, [k]);
  }
  assert.equal(rows("gw_site_contracts")[0].renewal_status, "pending");
  assert.equal(rows("gw_site_contracts")[0].unit_price, 999999);
  assert.equal(mem.state.log.filter((l) => l.op === "update").length, 0);
});
await ok("fields が無い・空 は 400", async () => {
  setup();
  assert.equal((await post({ action: "update", ids: [C_PP] })).statusCode, 400);
  assert.equal((await post({ action: "update", ids: [C_PP], fields: {} })).statusCode, 400);
});
await ok("正しくない値は 400 invalid_input（状態・日付・実在しない日付）", async () => {
  setup();
  for (const fields of [{ renewalStatus: "done" }, { renewalStatus: null }, { periodFrom: "2026-13-01" }, { periodFrom: null }, { periodTo: "2027-02-30" }, { periodTo: "" }, { periodTo: 20270101 }]) {
    const r = await post({ action: "update", ids: [C_PP], fields });
    assert.equal(r.statusCode, 400, JSON.stringify(fields));
    assert.equal(r.body.error, "invalid_input");
  }
  assert.equal(mem.state.log.filter((l) => l.op === "update").length, 0);
});
await ok("終了予定が開始日より前になる案件が1件でもあれば、409 で何も変えない", async () => {
  setup();
  // C_BP の開始は 2026-06-01。終了を 2026-05-31 にすると C_BP だけ合わない
  const r = await post({ action: "update", ids: [C_PP, C_BP], fields: { periodTo: "2026-05-31", renewalStatus: "ending" } });
  assert.equal(r.statusCode, 409, JSON.stringify(r.body));
  assert.equal(r.body.error, "period_conflict");
  assert.ok(r.body.conflicts.some((c) => c.id === C_BP));
  assert.deepEqual(rows("gw_site_contracts").slice(0, 2).map((c) => [c.renewal_status, c.period_to]), [["pending", "2027-03-31"], ["confirmed", null]]);
  assert.equal(rows("gw_office_events").filter((e) => e.kind === "contract.update").length, 0);
});
await ok("記録のある月が、新しい期間の外になる場合は 409（開始日を後ろへ／終了予定を前へ）", async () => {
  setup();
  // C_PP には 2026-09・2026-10 の記録がある
  const a = await post({ action: "update", ids: [C_PP], fields: { periodFrom: "2026-10-01" } });
  assert.equal(a.statusCode, 409);
  assert.match(a.body.conflicts[0].reason, /2026-09/);
  const b = await post({ action: "update", ids: [C_PP], fields: { periodTo: "2026-09-30" } });
  assert.equal(b.statusCode, 409);
  assert.match(b.body.conflicts[0].reason, /2026-10/);
  assert.equal(rows("gw_site_contracts")[0].period_from, "2026-04-01");
});
await ok("履歴：案件ごとに contract.update を1行。変更前後・件数・操作者を残す。単価は入れない", async () => {
  setup();
  await post({ action: "update", ids: [C_PP, C_BP], fields: { renewalStatus: "ending", periodTo: "2027-06-30" } });
  const ev = rows("gw_office_events").filter((e) => e.kind === "contract.update");
  assert.equal(ev.length, 2);
  const e = ev.find((x) => x.site_contract_id === C_PP);
  assert.equal(e.billing_month, "2026-10");
  assert.equal(e.employee_id, E_PP);
  assert.equal(e.actor_id, "u-1");
  assert.equal(e.actor_name, "経理 花子");
  assert.deepEqual(e.detail.changed.sort(), ["periodTo", "renewalStatus"]);
  assert.deepEqual(e.detail.before, { renewalStatus: "pending", periodTo: "2027-03-31" });
  assert.deepEqual(e.detail.after, { renewalStatus: "ending", periodTo: "2027-06-30" });
  assert.equal(e.detail.count, 2);
  assert.ok(!/999999|500000|unit_price/.test(JSON.stringify(ev)));
  assert.equal(logged.filter((l) => l.action === "office.contract.update").length, 1);
});
await ok("書き込みは service_role だけ（userClient で書かない）", async () => {
  setup();
  const r = await post({ action: "update", ids: [C_PP], fields: { renewalStatus: "renewed" } });
  assert.equal(r.statusCode, 200);
  assert.ok(asked.filter((a) => a.asUser).every((a) => a.table === "gw_site_contracts"));
  assert.ok(asked.filter((a) => a.asUser).every((a) => !/unit_price|settlement_condition/.test(a.cols)));
});

console.log("— 削除の確認（preview）—");
await ok("preview：件数・要員名・客先名と、消える関連データの件数を返す。何も書かない", async () => {
  setup();
  const r = await post({ action: "preview", ids: [C_PP, C_BP] });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.count, 2);
  const a = r.body.contracts.find((c) => c.id === C_PP);
  assert.equal(a.employeeName, "田中 太郎");
  assert.equal(a.siteCompany, "顧客A社");
  assert.deepEqual(a.counts, { files: 2, sheets: 1, confirmedSheets: 1, terms: 1, progress: 2 });
  assert.deepEqual(r.body.totals, { files: 3, sheets: 2, confirmedSheets: 1, terms: 2, progress: 3 });
  assert.deepEqual(r.body.blocked, []);
  assert.equal(mem.state.log.filter((l) => l.op !== "select").length, 0);
  assert.equal(mem.removed.length, 0);
});
await ok("preview：請求の印が付いた案件は blocked に出る", async () => {
  setup();
  rows("gw_billing_progress")[2].sent = true;
  const r = await post({ action: "preview", ids: [C_PP, C_BP] });
  assert.deepEqual(r.body.blocked, [{ id: C_BP, reason: "billed" }]);
  assert.equal(r.body.contracts.find((c) => c.id === C_BP).blocked, "billed");
});
await ok("Phase 3 の表（db/105〜107）が無い環境でも、preview は 0件として返る", async () => {
  setup();
  mem.state.missing = "gw_timesheets";
  const r = await post({ action: "preview", ids: [C_PP] });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.contracts[0].counts.sheets, 0);
});

console.log("— 削除 —");
await ok("即削除は禁止：confirm が無い・false・件数が違う は 400 confirm_required。何も消えない", async () => {
  setup();
  for (const b of [{}, { confirm: false, confirmCount: 1 }, { confirm: true }, { confirm: true, confirmCount: 2 }, { confirm: "true", confirmCount: 1 }, { confirm: true, confirmCount: "1" }]) {
    const r = await post({ action: "delete", ids: [C_PP], ...b });
    assert.equal(r.statusCode, 400, JSON.stringify(b));
    assert.equal(r.body.error, "confirm_required");
  }
  assert.equal(rows("gw_site_contracts").length, 3);
  assert.equal(mem.removed.length, 0);
  assert.ok([PATH_PP, PATH_PP2].every((p) => mem.storageFiles.has(`${BUCKET}/${p}`)));
});
await ok("削除：案件・月次進捗・提出・契約条件・勤務表・日別が消える。要員・ほかの案件・他社は残る", async () => {
  setup();
  const r = await post({ action: "delete", ids: [C_PP], confirm: true, confirmCount: 1 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { deleted: 1, storageRemoved: 2 });
  assert.deepEqual(rows("gw_site_contracts").map((c) => c.id), [C_BP, C_X]);
  assert.deepEqual(rows("gw_billing_progress").map((p) => p.site_contract_id), [C_BP]);
  assert.deepEqual(rows("gw_submissions").map((s) => s.site_contract_id).sort(), [C_BP, C_X].sort());
  assert.deepEqual(rows("gw_site_contract_terms").map((t) => t.site_contract_id), [C_BP]);
  assert.deepEqual(rows("gw_timesheets").map((t) => t.id), [TS_BP]);
  assert.deepEqual(rows("gw_timesheet_days").map((d) => d.timesheet_id), [TS_BP]);
  assert.equal(rows("gw_employees").length, 3);
});
await ok("削除：Storage の勤務表ファイルも消える（DB だけ消して孤児にしない）。ほかの案件・他社のファイルは残る", async () => {
  setup();
  await post({ action: "delete", ids: [C_PP, C_BP], confirm: true, confirmCount: 2 });
  assert.deepEqual([...mem.storageFiles.keys()], [`${BUCKET}/${PATH_X}`]);
  assert.deepEqual(mem.removed.map((r) => r.path).sort(), [PATH_PP, PATH_PP2, PATH_BP].sort());
  assert.ok(mem.removed.every((r) => r.bucket === BUCKET));
  // 提出の行が残っていて、ファイルだけ無い、という状態は無い
  for (const s of rows("gw_submissions")) assert.ok(mem.storageFiles.has(`${BUCKET}/${s.storage_path}`), s.storage_path);
});
await ok("削除：ファイルは DB より先に消す（Storage を消す時点では、案件・提出の行がまだ残っている）", async () => {
  setup();
  const seen = [];
  mem.state.onStorageRemove = (paths) => seen.push({ paths: [...paths], contracts: rows("gw_site_contracts").length, submissions: rows("gw_submissions").length });
  await post({ action: "delete", ids: [C_PP], confirm: true, confirmCount: 1 });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].paths.sort(), [PATH_PP, PATH_PP2].sort());
  assert.deepEqual([seen[0].contracts, seen[0].submissions], [3, 4]);
  assert.equal(rows("gw_site_contracts").length, 2);
});
await ok("Storage の削除に失敗したら、502 storage_failed。DB は何も消えない（行が残る＝やり直せる）", async () => {
  setup();
  mem.state.storageFail = "storage down";
  const r = await post({ action: "delete", ids: [C_PP, C_BP], confirm: true, confirmCount: 2 });
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.error, "storage_failed");
  assert.equal(rows("gw_site_contracts").length, 3);
  assert.equal(rows("gw_submissions").length, 4);
  assert.equal(rows("gw_timesheets").length, 2);
  assert.equal(rows("gw_office_events").filter((e) => e.kind === "contract.delete").length, 0);
  assert.equal(logged.length, 0);
  // 直ったら、やり直せる
  mem.state.storageFail = null;
  const again = await post({ action: "delete", ids: [C_PP, C_BP], confirm: true, confirmCount: 2 });
  assert.equal(again.statusCode, 200);
  assert.equal(rows("gw_site_contracts").length, 1);
});
await ok("ファイルの無い案件は、Storage を呼ばずに消える", async () => {
  setup();
  rows("gw_submissions").splice(0, rows("gw_submissions").length);
  const r = await post({ action: "delete", ids: [C_PP], confirm: true, confirmCount: 1 });
  assert.deepEqual(r.body, { deleted: 1, storageRemoved: 0 });
  assert.equal(mem.removed.length, 0);
});
await ok("100件を超えるファイルは、100件ずつに分けて消す", async () => {
  setup();
  rows("gw_submissions").splice(0, rows("gw_submissions").length);
  for (let i = 0; i < 250; i++) {
    const p = `${T1}/${E_PP}/bulk${i}.pdf`; mem.put(BUCKET, p, "x");
    rows("gw_submissions").push({ id: uid(2000 + i), tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, target_month: "2026-10", kind: "timesheet", file_name: "f.pdf", mime_type: "application/pdf", storage_path: p });
  }
  const r = await post({ action: "delete", ids: [C_PP], confirm: true, confirmCount: 1 });
  assert.equal(r.body.storageRemoved, 250);
  assert.equal(mem.removed.length, 250);
  assert.equal(mem.storageFiles.size, 4);     // 消したのは submissions にあった 250 件だけ。最初から置いた 4 件は、提出の行が無いので残る
});
await ok("請求書の作成・送付・BP請求書受領の印が付いた案件は 409 has_billing。何も消えない（ファイルも）", async () => {
  for (const k of ["board_created", "sent", "bp_invoice_received"]) {
    setup();
    rows("gw_billing_progress")[2][k] = true;
    const r = await post({ action: "delete", ids: [C_PP, C_BP], confirm: true, confirmCount: 2 });
    assert.equal(r.statusCode, 409, k);
    assert.equal(r.body.error, "has_billing");
    assert.deepEqual(r.body.contracts.map((c) => c.id), [C_BP]);
    assert.equal(rows("gw_site_contracts").length, 3);
    assert.equal(mem.removed.length, 0);
    assert.equal(mem.storageFiles.size, 4);
  }
});
await ok("履歴：案件ごとに contract.delete を1行。契約の id は detail に残る。単価・氏名・金額は入れない", async () => {
  setup();
  await post({ action: "delete", ids: [C_PP, C_BP], confirm: true, confirmCount: 2 });
  const ev = rows("gw_office_events").filter((e) => e.kind === "contract.delete");
  assert.equal(ev.length, 2);
  const e = ev.find((x) => x.detail.contractId === C_PP);
  assert.equal(e.site_contract_id, null);
  assert.equal(e.employee_id, E_PP);
  assert.equal(e.billing_month, "2026-10");
  assert.equal(e.actor_id, "u-1");
  assert.equal(e.detail.siteCompany, "顧客A社");
  assert.deepEqual(e.detail.deleted, { files: 2, sheets: 1, confirmedSheets: 1, terms: 1, progress: 2 });
  assert.equal(e.detail.storageRemoved, 2);
  assert.equal(e.detail.count, 2);
  assert.ok(!/999999|500000|700000|田中|鈴木/.test(JSON.stringify(ev)));
  // もとからあった履歴は、契約の id だけ外れて残る
  const old = rows("gw_office_events").find((x) => x.kind === "sheet.upload");
  assert.ok(old && old.site_contract_id === null);
  assert.equal(logged.filter((l) => l.action === "office.contract.delete").length, 1);
  assert.deepEqual(logged.find((l) => l.action === "office.contract.delete").detail.ids, [C_PP, C_BP]);
});
await ok("書き込みは service_role だけ：userClient は gw_site_contracts を読むだけ", async () => {
  setup();
  const r = await post({ action: "delete", ids: [C_PP], confirm: true, confirmCount: 1 });
  assert.equal(r.statusCode, 200);
  assert.ok(asked.filter((a) => a.asUser).every((a) => a.table === "gw_site_contracts"));
});
await ok("RLS：読める権限の無い人（userClient が 0 件）は、案件が見つからず 404。何も消えない", async () => {
  setup();
  // 経理だが、別テナントの所属：自社の案件は見えない
  ctl.who = { ...FINANCE, tenantId: T2 };
  const r = await post({ action: "delete", ids: [C_PP], confirm: true, confirmCount: 1 });
  assert.equal(r.statusCode, 404);
  assert.equal(rows("gw_site_contracts").length, 3);
  assert.equal(mem.removed.length, 0);
});

console.log(fail ? `\n${fail} 件 NG（${pass} 件 ok）` : `\nすべて通過（${pass} 件）`);
process.exit(fail ? 1 : 0);
