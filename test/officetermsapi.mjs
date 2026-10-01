// /api/office/terms（契約条件：単価・精算条件）を、偽の Supabase で通す。
//
// ■ 何を守るテストか
//
//   1. 入れるのは 経営者・責任者・経理 だけ（単価は機微情報）。二段階認証（MFA）は要求しない
//   2. 検査：読めない入力は 400 と理由。期間が重なる条件は登録させない（月の途中の変更は、重ならない期間で）
//   3. 書き込みは service_role だけ。gw_site_contracts.unit_price / settlement_condition は、読まない・書かない
//   4. 操作は履歴に残す（単価・金額は入れない）
import assert from "node:assert/strict";
import {
  atRoot, mem, ctl, asked, logged, call, OWNER, MANAGER, FINANCE, DENIED, P,
  uid, T1, T2, E_PP, E_X, C_PP, C_BP, C_X,
} from "./_officeharness.mjs";

const { default: termsApi } = await import(atRoot("api/office/terms.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const list = (contract = C_PP) => call(termsApi, `/api/office/terms?contract=${contract}`);
const save = (body, o = {}) => call(termsApi, "/api/office/terms", { method: "POST", body: { siteContractId: C_PP, ...body }, ...o });
const del = (id, month = "") => call(termsApi, `/api/office/terms?id=${id}${month ? `&month=${month}` : ""}`, { method: "DELETE" });
const rows = (t) => mem.rows[t] || [];

const MONTHLY = {
  validFrom: "2026-04-01", validTo: "", pricingType: "monthly", salesUnitPrice: 700000, purchaseUnitPrice: 600000,
  settlementMode: "range", settleMinHours: 140, settleMaxHours: 180, overRatePerHour: 4000, underRatePerHour: 3500, amountRounding: "floor",
};

function setup() {
  mem.reset();
  ctl.who = OWNER; ctl.aal = "aal2";
  asked.length = 0; logged.length = 0;
  mem.rows.gw_employees = [
    { id: E_PP, tenant_id: T1, display_name: "田中 太郎" },
    { id: E_X, tenant_id: T2, display_name: "他社の人" },
  ];
  mem.rows.gw_site_contracts = [
    { id: C_PP, tenant_id: T1, employee_id: E_PP, engagement_kind: "pp", site_company: "顧客A社", period_from: "2026-04-01",
      unit_price: 999999, unit_price_type: "月額", settlement_condition: "元の条件" },
    { id: C_X, tenant_id: T2, employee_id: E_X, engagement_kind: "pp", site_company: "他社", period_from: "2026-01-01" },
  ];
}

console.log("— 入れる人・二段階認証（MFA は要求しない）—");

for (const [label, p] of [["経営者", OWNER], ["責任者", MANAGER], ["経理", FINANCE]]) {
  await ok(`${label} は見られる・登録できる`, async () => {
    setup(); ctl.who = p;
    assert.equal((await list()).statusCode, 200);
    assert.equal((await save(MONTHLY)).statusCode, 200);
  });
}
for (const [label, p] of Object.entries(DENIED)) {
  await ok(`${label} は GET・POST・DELETE とも 403。何も読まず・書かない`, async () => {
    setup(); ctl.who = p;
    assert.equal((await list()).statusCode, 403);
    assert.equal((await save(MONTHLY)).statusCode, 403);
    assert.equal((await del(uid(1))).statusCode, 403);
    assert.equal(asked.length, 0);
    assert.equal(mem.state.log.length, 0);
    assert.equal(logged.length, 0);
  });
}
await ok("MFA 未登録・aal1 でも、契約条件を見られる・登録・更新・削除できる。権限のない人は aal1 でも aal2 でも 403 forbidden", async () => {
  for (const [label, p] of [["経営者", OWNER], ["責任者", MANAGER], ["経理", FINANCE]]) {
    setup(); ctl.who = { ...p, factors: [] }; ctl.aal = "aal1";
    assert.equal((await list()).statusCode, 200, `${label} GET`);
    const c = await save(MONTHLY);
    assert.equal(c.statusCode, 200, `${label} POST: ${JSON.stringify(c.body)}`);
    assert.equal((await del(rows("gw_site_contract_terms")[0].id)).statusCode, 200, `${label} DELETE`);
  }
  for (const aal of ["aal1", "aal2"]) {
    setup(); ctl.who = P(["sales"]);
    assert.equal((await call(termsApi, `/api/office/terms?contract=${C_PP}`, { aal })).body.error, "forbidden", aal);
  }
});
await ok("GET・POST・DELETE 以外は 405", async () => {
  setup();
  assert.equal((await call(termsApi, "/api/office/terms", { method: "PUT" })).statusCode, 405);
});

console.log("\n— 登録・更新・削除 —");

await ok("登録：時間は分に、空の終了日は null。応答は camelCase と説明文。履歴を残す", async () => {
  setup();
  const r = await save({ ...MONTHLY, month: "2026-10" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const t = r.body.term;
  assert.deepEqual([t.pricingType, t.salesUnitPrice, t.purchaseUnitPrice, t.settleMinMinutes, t.settleMaxMinutes, t.validTo],
    ["monthly", 700000, 600000, 8400, 10800, null]);
  assert.equal(t.description, "月額 700,000円（140〜180h）");
  const row = rows("gw_site_contract_terms")[0];
  assert.equal(row.tenant_id, T1);
  assert.equal(row.site_contract_id, C_PP);
  assert.equal(row.created_by, "u-1");
  assert.equal(row.settle_min_minutes, 8400);
  assert.equal(row.sales_unit_price, 700000);
  const ev = rows("gw_office_events")[0];
  assert.deepEqual([ev.kind, ev.billing_month, ev.employee_id, ev.site_contract_id, ev.actor_id], ["terms.create", "2026-10", E_PP, C_PP, "u-1"]);
  assert.ok(logged.some((l) => l.action === "office.terms.create"));
});
await ok("履歴・操作ログに、単価・金額を入れない", async () => {
  setup();
  await save({ ...MONTHLY, salesUnitPrice: 731234, purchaseUnitPrice: 611111, overRatePerHour: 4321, underRatePerHour: 3210 });
  assert.equal(rows("gw_site_contract_terms").length, 1);
  const text = JSON.stringify(rows("gw_office_events").map((e) => e.detail)) + JSON.stringify(logged.map((l) => l.detail));
  for (const w of ["731234", "611111", "4321", "3210"]) assert.ok(!text.includes(w), `${w} が履歴に入っている`);
});
await ok("一覧：期間の新しい順。単価は Office 権限の人にだけ返る", async () => {
  setup();
  await save({ ...MONTHLY, validTo: "2026-09-30" });
  await save({ ...MONTHLY, validFrom: "2026-10-01", salesUnitPrice: 750000 });
  const r = await list();
  assert.deepEqual(r.body.terms.map((t) => t.validFrom), ["2026-10-01", "2026-04-01"]);
  assert.equal(r.body.terms[0].salesUnitPrice, 750000);
});
await ok("一覧の見出し用に、要員名と客先を返す（名簿は必要な列だけ）。ほかの契約の情報は入らない", async () => {
  setup();
  const r = await list();
  assert.deepEqual(r.body.contract, { siteCompany: "顧客A社", engagementKind: "pp", employeeName: "田中 太郎" });
  assert.ok(!JSON.stringify(r.body).includes("他社"));
});
await ok("更新：id を指定。値が変わり、他社の・他の契約の id は更新できない（404）", async () => {
  setup();
  const c = (await save(MONTHLY)).body.term;
  const u = await save({ ...MONTHLY, id: c.id, salesUnitPrice: 720000 });
  assert.equal(u.statusCode, 200);
  assert.equal(rows("gw_site_contract_terms").length, 1);
  assert.equal(rows("gw_site_contract_terms")[0].sales_unit_price, 720000);
  assert.equal(rows("gw_office_events").at(-1).kind, "terms.update");
  // 別の契約の条件 id を、この契約として更新しようとする
  mem.rows.gw_site_contracts.push({ id: C_BP, tenant_id: T1, employee_id: E_PP, engagement_kind: "bp", site_company: "B", period_from: "2026-04-01" });
  const other = await save({ ...MONTHLY, siteContractId: C_BP, id: c.id });
  assert.equal(other.statusCode, 404);
  assert.equal(rows("gw_site_contract_terms")[0].site_contract_id, C_PP, "付け替えられていない");
  assert.equal((await save({ ...MONTHLY, id: "bad" })).statusCode, 400);
});
await ok("削除：条件が消え、履歴に残る。他社の条件は消せない", async () => {
  setup();
  const c = (await save(MONTHLY)).body.term;
  mem.rows.gw_site_contract_terms.push({ id: uid(650), tenant_id: T2, site_contract_id: C_X, valid_from: "2026-01-01", pricing_type: "hourly" });
  assert.equal((await del(uid(650))).statusCode, 404);
  assert.equal(rows("gw_site_contract_terms").length, 2);
  const r = await del(c.id, "2026-10");
  assert.equal(r.statusCode, 200);
  assert.equal(rows("gw_site_contract_terms").length, 1);
  assert.equal(rows("gw_office_events").at(-1).kind, "terms.delete");
  assert.equal((await del("bad")).statusCode, 400);
  assert.equal((await del(uid(999))).statusCode, 404);
});

console.log("\n— 検査 —");

await ok("読めない入力は 400 と理由（日本語）。何も書かない", async () => {
  setup();
  for (const bad of [{ validFrom: "2026-09-31" }, { pricingType: "yearly" }, { salesUnitPrice: -1 }, { salesUnitPrice: "1.234" },
    { settlementMode: null }, { settleMinHours: 190, settleMaxHours: 180 }, { settleUnitMinutes: 7 }, { overRatePerHour: -5 },
    { amountRounding: "trunc" }, { validFrom: "2026-10-01", validTo: "2026-09-30" }]) {
    const r = await save({ ...MONTHLY, ...bad });
    assert.equal(r.statusCode, 400, JSON.stringify(bad));
    assert.equal(r.body.error, "invalid_input");
    assert.ok(r.body.errors.length >= 1 && /[ぁ-んァ-ン一-龥]/.test(r.body.errors[0]));
  }
  assert.equal(rows("gw_site_contract_terms").length, 0);
  assert.equal(rows("gw_office_events").length, 0);
});
await ok("契約が無い・他社の契約は 404（他社の契約に、条件を足せない）", async () => {
  setup();
  assert.equal((await save({ ...MONTHLY, siteContractId: uid(888) })).statusCode, 404);
  const x = await save({ ...MONTHLY, siteContractId: C_X });
  assert.equal(x.statusCode, 404);
  assert.equal(x.body.error, "contract_not_found");
  assert.equal((await list(C_X)).statusCode, 404);
  assert.equal((await list("bad")).statusCode, 404);
  assert.equal(rows("gw_site_contract_terms").length, 0);
});
await ok("期間が重なる条件は登録させない（409 overlap）。重ならなければ、月の途中の変更として並べられる", async () => {
  setup();
  await save({ ...MONTHLY, validTo: "2026-10-15" });
  const clash = await save({ ...MONTHLY, validFrom: "2026-10-15", salesUnitPrice: 750000 });
  assert.equal(clash.statusCode, 409);
  assert.equal(clash.body.error, "overlap");
  assert.match(clash.body.hint, /2026-04-01〜2026-10-15/);
  assert.equal(rows("gw_site_contract_terms").length, 1);
  const next = await save({ ...MONTHLY, validFrom: "2026-10-16", salesUnitPrice: 750000 });
  assert.equal(next.statusCode, 200, "前の条件の終了日の翌日から");
  assert.equal(rows("gw_site_contract_terms").length, 2);
  // 期限なしの条件が既にあるところへ、あとの期間は重なる
  const late = await save({ ...MONTHLY, validFrom: "2027-01-01" });
  assert.equal(late.statusCode, 409);
});
await ok("更新のとき、自分自身とは重ならない。ほかの条件とは重ならない", async () => {
  setup();
  const a = (await save({ ...MONTHLY, validTo: "2026-09-30" })).body.term;
  const b = (await save({ ...MONTHLY, validFrom: "2026-10-01" })).body.term;
  assert.equal((await save({ ...MONTHLY, id: a.id, validTo: "2026-09-30", salesUnitPrice: 1 })).statusCode, 200);
  assert.equal((await save({ ...MONTHLY, id: a.id, validTo: "2026-10-05" })).statusCode, 409, "b と重なる");
  assert.equal((await save({ ...MONTHLY, id: b.id, validFrom: "2026-10-01", validTo: "2026-12-31" })).statusCode, 200);
});
await ok("重なりは、契約ごとに見る（別の契約の同じ期間は重ならない）", async () => {
  setup();
  mem.rows.gw_site_contracts.push({ id: C_BP, tenant_id: T1, employee_id: E_PP, engagement_kind: "bp", site_company: "B", period_from: "2026-04-01" });
  await save(MONTHLY);
  assert.equal((await save({ ...MONTHLY, siteContractId: C_BP })).statusCode, 200);
});

console.log("\n— 単価（unit_price）には触れない・書き込みは service_role だけ —");

await ok("gw_site_contracts.unit_price・settlement_condition を読まない・書かない。入力に混ぜても取り込まない", async () => {
  setup();
  const r = await save({ ...MONTHLY, unit_price: 1, unitPrice: 1, settlement_condition: "x", settlementCondition: "x" });
  assert.equal(r.statusCode, 200);
  await list();
  const cols = asked.filter((s) => ["gw_site_contracts", "gw_employees"].includes(s.table)).map((s) => s.cols).join(",");
  assert.ok(!/unit_price|settlement_condition/.test(cols), cols);
  const c = rows("gw_site_contracts").find((x) => x.id === C_PP);
  assert.equal(c.unit_price, 999999, "既存の値はそのまま");
  assert.equal(c.settlement_condition, "元の条件");
  const term = rows("gw_site_contract_terms")[0];
  assert.ok(!("unit_price" in term) && !("settlement_condition" in term));
  assert.ok(!JSON.stringify(r.body).includes("元の条件"));
});
await ok("ログインした人の権限で書こうとすると、RLS が止める（API は service_role で書く）", async () => {
  setup();
  const r = await save(MONTHLY);
  assert.equal(r.statusCode, 200, "API 経由なら書ける");
  const w = await (await import("./_officeharness.mjs")).mem.userClient(FINANCE)
    .from("gw_site_contract_terms").update({ sales_unit_price: 1 }).eq("id", r.body.term.id);
  assert.equal(w.error?.code, "42501");
  assert.equal(rows("gw_site_contract_terms")[0].sales_unit_price, 700000);
});
await ok("表が未作成なら 503 not_ready（db/106 の案内）", async () => {
  setup();
  mem.state.missing = "gw_site_contract_terms";
  const r = await list();
  assert.equal(r.statusCode, 503);
  assert.match(r.body.message, /db\/106_office_contract_terms\.sql/);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
