// 契約条件の入力・月ごとの条件の選び方・売上側の精算計算（lib/office-calc.js）。
//
// ■ 何を守るテストか
//
//   1. 入力の検査：直せない入力は日本語のエラーにする。黙って直さない・推測で埋めない
//   2. 月に効く条件の選び方：0件・1件・月の一部だけ・2件以上（月の途中で変わる）
//   3. 精算：月額（精算幅の中は固定／超過・控除で増減）、時給、円未満の丸め
//   4. 自動計算しないもの（日給・日割り・複数条件・未設定・未確定）は「要確認」で理由を返す
//   期待値は、規則から手で計算した数字（実装の出力を写していない）
//     月額 700,000円・140〜180h・超過 4,000円/h・控除 3,500円/h
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const C = await import(join(ROOT, "lib/office-calc.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const H = (h, m = 0) => h * 60 + m;

// 既定の条件（月額・精算幅あり）。テストごとに上書きして使う
const rowA = (o = {}) => ({
  id: "t1", site_contract_id: "c1", valid_from: "2026-04-01", valid_to: null,
  pricing_type: "monthly", sales_unit_price: "700000.00", purchase_unit_price: "600000.00",
  settlement_mode: "range", settle_min_minutes: 8400, settle_max_minutes: 10800, settle_unit_minutes: null,
  rounding_mode: null, rounding_scope: null, over_rate_per_hour: "4000.00", under_rate_per_hour: "3500.00",
  prorate: false, amount_rounding: "floor", ...o,
});
const forMonth = (o, month = "2026-10") => C.termsForMonth([C.normalizeTerms(rowA(o))], month);
const run = (o, minutes, month) => C.settle({ terms: forMonth(o, month), minutes });

console.log("— 入力の検査（parseTermsInput） —");

const good = {
  validFrom: "2026-04-01", validTo: "", pricingType: "monthly", salesUnitPrice: 700000, purchaseUnitPrice: "600000",
  settlementMode: "range", settleMinHours: 140, settleMaxHours: "180", settleUnitMinutes: 30, roundingMode: "floor",
  roundingScope: "month", overRatePerHour: 4000, underRatePerHour: 3500, amountRounding: "floor", prorate: false,
};
await ok("正しい入力：時間は分にし、空の終了日は null。列名は DB の snake_case", async () => {
  const r = C.parseTermsInput(good);
  assert.equal(r.ok, true, r.errors.join(","));
  assert.deepEqual(r.value, {
    valid_from: "2026-04-01", valid_to: null, pricing_type: "monthly",
    sales_unit_price: 700000, purchase_unit_price: 600000, settlement_mode: "range",
    settle_min_minutes: 8400, settle_max_minutes: 10800, settle_unit_minutes: 30,
    rounding_mode: "floor", rounding_scope: "month", over_rate_per_hour: 4000, under_rate_per_hour: 3500,
    prorate: false, amount_rounding: "floor",
  });
});
await ok("時間は小数2桁まで。162.5 → 9750分", async () => {
  const r = C.parseTermsInput({ ...good, settleMinHours: "162.5", settleMaxHours: 170 });
  assert.equal(r.value.settle_min_minutes, 9750);
  assert.equal(C.parseTermsInput({ ...good, settleMinHours: "162.555" }).ok, false);
});
await ok("実在しない日付・終了が開始より前・単価の種類なし", async () => {
  assert.equal(C.parseTermsInput({ ...good, validFrom: "2026-09-31" }).ok, false, "9/31 は無い");
  assert.equal(C.parseTermsInput({ ...good, validFrom: "2026-9-1" }).ok, false);
  const r = C.parseTermsInput({ ...good, validFrom: "2026-10-01", validTo: "2026-09-30" });
  assert.match(r.errors.join(), /終了日が、開始日より前/);
  assert.equal(C.parseTermsInput({ ...good, pricingType: "yearly" }).ok, false);
  assert.equal(C.parseTermsInput({ ...good, pricingType: undefined }).ok, false);
});
await ok("単価：負数・3桁の小数・文字・上限超えは受けない。空は null（未設定）", async () => {
  for (const v of [-1, "1.234", "abc", 10000000000]) {
    assert.equal(C.parseTermsInput({ ...good, salesUnitPrice: v }).ok, false, String(v));
    assert.equal(C.parseTermsInput({ ...good, purchaseUnitPrice: v }).ok, false, String(v));
  }
  const r = C.parseTermsInput({ ...good, salesUnitPrice: "", purchaseUnitPrice: null });
  assert.equal(r.ok, true);
  assert.equal(r.value.sales_unit_price, null);
  assert.equal(r.value.purchase_unit_price, null);
});
await ok("月額は、精算の方法を選ばせる。精算幅ありなら下限・上限が要り、下限≦上限", async () => {
  assert.match(C.parseTermsInput({ ...good, settlementMode: null }).errors.join(), /精算の方法/);
  assert.equal(C.parseTermsInput({ ...good, settleMinHours: "" }).ok, false);
  assert.equal(C.parseTermsInput({ ...good, settleMaxHours: "" }).ok, false);
  assert.match(C.parseTermsInput({ ...good, settleMinHours: 190, settleMaxHours: 180 }).errors.join(), /下限が、上限より大きい/);
  assert.equal(C.parseTermsInput({ ...good, settleMinHours: 180, settleMaxHours: 180 }).ok, true, "等しいのは可");
});
await ok("精算なし（fixed）・時給では、精算幅を捨てる", async () => {
  const f = C.parseTermsInput({ ...good, settlementMode: "fixed" });
  assert.equal(f.ok, true);
  assert.equal(f.value.settle_min_minutes, null);
  assert.equal(f.value.settle_max_minutes, null);
  const h = C.parseTermsInput({ ...good, pricingType: "hourly", settlementMode: null });
  assert.equal(h.ok, true, h.errors.join());
  assert.equal(h.value.settle_min_minutes, null);
});
await ok("精算の単位：5・10・15・30・60 だけ。入れたら丸めの方向と単位（日／月）も要る。単位が無ければ丸めは捨てる", async () => {
  assert.equal(C.parseTermsInput({ ...good, settleUnitMinutes: 7 }).ok, false);
  assert.match(C.parseTermsInput({ ...good, roundingMode: null }).errors.join(), /丸めの方向と/);
  assert.match(C.parseTermsInput({ ...good, roundingScope: "" }).errors.join(), /丸めの方向と/);
  assert.equal(C.parseTermsInput({ ...good, roundingMode: "truncate" }).ok, false);
  const r = C.parseTermsInput({ ...good, settleUnitMinutes: "", roundingMode: "floor", roundingScope: "day" });
  assert.equal(r.ok, true);
  assert.equal(r.value.rounding_mode, null);
  assert.equal(r.value.rounding_scope, null);
});
await ok("超過・控除の単価：負数は不可。空は null（未設定）、0 は「精算しない」として保つ", async () => {
  assert.equal(C.parseTermsInput({ ...good, overRatePerHour: -1 }).ok, false);
  assert.equal(C.parseTermsInput({ ...good, underRatePerHour: "x" }).ok, false);
  const r = C.parseTermsInput({ ...good, overRatePerHour: 0, underRatePerHour: "" });
  assert.equal(r.value.over_rate_per_hour, 0);
  assert.equal(r.value.under_rate_per_hour, null);
});
await ok("円未満の丸め：切捨て・切上げ・四捨五入だけ。空は null", async () => {
  assert.equal(C.parseTermsInput({ ...good, amountRounding: "trunc" }).ok, false);
  assert.equal(C.parseTermsInput({ ...good, amountRounding: "" }).value.amount_rounding, null);
});
await ok("unit_price・settlement_condition は、入力に含めても受け取らない", async () => {
  const r = C.parseTermsInput({ ...good, unit_price: 1, unitPrice: 1, settlement_condition: "x", settlementCondition: "x" });
  assert.equal(r.ok, true);
  const keys = Object.keys(r.value).join();
  assert.doesNotMatch(keys, /unit_price$|settlement_condition|(^|,)unit_price(,|$)/);
  assert.ok(!("unit_price" in r.value) && !("settlement_condition" in r.value));
});

console.log("— 月に効く条件の選び方 —");

await ok("条件が無い → none", async () => {
  assert.equal(C.termsForMonth([], "2026-10").status, "none");
  assert.equal(C.termsForMonth(null, "2026-10").status, "none");
  assert.equal(C.termsForMonth([C.normalizeTerms(rowA())], "2026-13").status, "none", "月の形が不正");
});
await ok("月の全体をカバーする1件 → ok・partial でない（終了日なしも可）", async () => {
  const r = forMonth({});
  assert.equal(r.status, "ok");
  assert.equal(r.partial, false);
  assert.equal(r.terms.salesUnitPrice, 700000);
  assert.equal(r.terms.settleMinMinutes, 8400);
});
await ok("月初〜月末ちょうどの開始・終了は、月の全体（partial でない）", async () => {
  assert.equal(forMonth({ valid_from: "2026-10-01", valid_to: "2026-10-31" }).partial, false);
  assert.equal(forMonth({ valid_from: "2026-10-01", valid_to: "2026-10-30" }).partial, true, "月末より前に終わる");
  assert.equal(forMonth({ valid_from: "2026-10-02" }).partial, true, "月初より後に始まる");
});
await ok("月の途中から始まる・途中で終わる → partial", async () => {
  assert.equal(forMonth({ valid_from: "2026-10-16" }).partial, true);
  assert.equal(forMonth({ valid_from: "2026-04-01", valid_to: "2026-10-15" }).partial, true);
});
await ok("前の月に終わった条件・後の月に始まる条件は、この月には効かない", async () => {
  assert.equal(forMonth({ valid_to: "2026-09-30" }, "2026-10").status, "none");
  assert.equal(forMonth({ valid_from: "2026-11-01" }, "2026-10").status, "none");
  assert.equal(forMonth({ valid_to: "2026-10-01" }, "2026-10").status, "ok", "終了日が月初なら、その日は効く");
});
await ok("月の途中で条件が変わる（2件が重なる）→ multiple。どちらも選ばない", async () => {
  const r = C.termsForMonth([
    C.normalizeTerms(rowA({ id: "new", valid_from: "2026-10-16", sales_unit_price: 750000 })),
    C.normalizeTerms(rowA({ id: "old", valid_to: "2026-10-15" })),
  ], "2026-10");
  assert.equal(r.status, "multiple");
  assert.equal(r.terms, null);
  assert.deepEqual(r.candidates.map((t) => t.id), ["old", "new"], "開始日の順");
});
await ok("うるう年の2月末日で終わる条件は、月の全体", async () => {
  assert.equal(forMonth({ valid_from: "2028-02-01", valid_to: "2028-02-29" }, "2028-02").partial, false);
  assert.equal(forMonth({ valid_from: "2027-02-01", valid_to: "2027-02-28" }, "2027-02").partial, false);
  assert.equal(forMonth({ valid_from: "2027-02-01", valid_to: "2027-02-27" }, "2027-02").partial, true);
});

console.log("— 精算：月額（精算幅あり） —");

await ok("精算幅の中（160h）は、単価どおり 700,000円", async () => {
  const r = run({}, H(160));
  assert.equal(r.status, "calculated");
  assert.equal(r.band, "within");
  assert.equal(r.amount, 700000);
  assert.equal(r.adjustment, 0);
});
await ok("下限ちょうど（140h）・上限ちょうど（180h）は幅の中", async () => {
  assert.equal(run({}, H(140)).band, "within");
  assert.equal(run({}, H(180)).band, "within");
  assert.equal(run({}, H(180)).amount, 700000);
});
await ok("超過：185h → 5h超過 × 4,000 = +20,000 → 720,000円", async () => {
  const r = run({}, H(185));
  assert.equal(r.band, "over");
  assert.equal(r.overMinutes, 300);
  assert.equal(r.amount, 720000);
  assert.equal(r.adjustment, 20000);
});
await ok("控除：135.5h → 4.5h不足 × 3,500 = −15,750 → 684,250円", async () => {
  const r = run({}, H(135, 30));
  assert.equal(r.band, "under");
  assert.equal(r.underMinutes, 270);
  assert.equal(r.amount, 684250);
  assert.equal(r.adjustment, -15750);
});
await ok("超過が1分：4,000円/h × 1/60 = 66.67円 → 円未満の丸めで 66（切捨て）・67（切上げ・四捨五入）", async () => {
  assert.equal(run({ amount_rounding: "floor" }, H(180, 1)).amount, 700066);
  assert.equal(run({ amount_rounding: "ceil" }, H(180, 1)).amount, 700067);
  assert.equal(run({ amount_rounding: "round" }, H(180, 1)).amount, 700067);
});
await ok("四捨五入は .5 を切上げ：超過 3分 × 2,500円/h = 125円（端数なし）、超過 1分 × 1,830円/h = 30.5円 → 31", async () => {
  assert.equal(run({ over_rate_per_hour: "2500", amount_rounding: "round" }, H(180, 3)).amount, 700125);
  assert.equal(run({ over_rate_per_hour: "1830", amount_rounding: "round" }, H(180, 1)).amount, 700031);
  assert.equal(run({ over_rate_per_hour: "1830", amount_rounding: "floor" }, H(180, 1)).amount, 700030);
});
await ok("端数が出ないなら、円未満の丸めが未設定でも計算できる（超過 1h）", async () => {
  const r = run({ amount_rounding: null }, H(181));
  assert.equal(r.status, "calculated");
  assert.equal(r.amount, 704000);
});
await ok("端数が出るのに円未満の丸めが未設定 → 要確認（推測で丸めない）。位置関係は返す", async () => {
  const r = run({ amount_rounding: null }, H(180, 1));
  assert.equal(r.status, "review");
  assert.equal(r.amount, null);
  assert.equal(r.band, "over");
  assert.match(r.reasons.join(), /円未満の丸め/);
});
await ok("超過単価が未設定（null）→ 要確認。0 は「精算しない」で、単価のまま", async () => {
  const a = run({ over_rate_per_hour: null }, H(185));
  assert.equal(a.status, "review");
  assert.equal(a.band, "over");
  assert.match(a.reasons.join(), /超過単価が未設定/);
  const z = run({ over_rate_per_hour: 0 }, H(185));
  assert.equal(z.status, "calculated");
  assert.equal(z.amount, 700000);
});
await ok("控除単価が未設定 → 要確認。0 は控除しない", async () => {
  const a = run({ under_rate_per_hour: null }, H(135));
  assert.equal(a.status, "review");
  assert.match(a.reasons.join(), /控除単価が未設定/);
  assert.equal(run({ under_rate_per_hour: 0 }, H(135)).amount, 700000);
  assert.equal(run({ under_rate_per_hour: null }, H(150)).amount, 700000, "幅の中なら控除単価は要らない");
});
await ok("精算幅が未設定（range なのに下限・上限が null）→ 要確認", async () => {
  const r = run({ settle_min_minutes: null, settle_max_minutes: null }, H(160));
  assert.equal(r.status, "review");
  assert.equal(r.band, null);
  assert.match(r.reasons.join(), /精算幅/);
});
await ok("控除が単価を超える異常な条件 → 要確認（負の金額を出さない）", async () => {
  const r = run({ sales_unit_price: "10000", under_rate_per_hour: "1000000" }, H(100));
  assert.equal(r.status, "review");
  assert.equal(r.amount, null);
  assert.match(r.reasons.join(), /控除が単価を超えます/);
});
await ok("精算なし（fixed）は、何時間でも単価のまま", async () => {
  for (const h of [0, 100, 160, 250]) {
    const r = run({ settlement_mode: "fixed", settle_min_minutes: null, settle_max_minutes: null }, H(h));
    assert.equal(r.amount, 700000, `${h}h`);
    assert.equal(r.band, null);
  }
});

console.log("— 精算：時給 —");

await ok("時給 4,500円 × 162.5h = 731,250円", async () => {
  const r = run({ pricing_type: "hourly", sales_unit_price: "4500", settlement_mode: null }, H(162, 30));
  assert.equal(r.status, "calculated");
  assert.equal(r.amount, 731250);
  assert.equal(r.adjustment, null);
  assert.equal(r.band, null);
});
await ok("時給 4,333円 × 1分 = 72.2円 → 切捨て72・切上げ73。丸め未設定なら要確認", async () => {
  const h = { pricing_type: "hourly", sales_unit_price: "4333", settlement_mode: null };
  assert.equal(run({ ...h, amount_rounding: "floor" }, 1).amount, 72);
  assert.equal(run({ ...h, amount_rounding: "ceil" }, 1).amount, 73);
  assert.equal(run({ ...h, amount_rounding: null }, 1).status, "review");
});
await ok("時給で 0 時間なら 0円（未確定の null とは別）", async () => {
  const r = run({ pricing_type: "hourly", sales_unit_price: "4500", settlement_mode: null }, 0);
  assert.equal(r.status, "calculated");
  assert.equal(r.amount, 0);
});
await ok("単価が小数（4,500.50円/h）でも、整数の演算で誤差なく出す：× 2h = 9,001円", async () => {
  const r = run({ pricing_type: "hourly", sales_unit_price: "4500.50", settlement_mode: null }, H(2));
  assert.equal(r.amount, 9001);
});

console.log("— 自動計算しないもの（要確認） —");

await ok("日給は計算しない", async () => {
  const r = run({ pricing_type: "daily", sales_unit_price: "30000", settlement_mode: null }, H(160));
  assert.equal(r.status, "review");
  assert.equal(r.amount, null);
  assert.match(r.reasons.join(), /日給/);
});
await ok("月の途中で条件が変わる（multiple）は計算しない", async () => {
  const terms = C.termsForMonth([
    C.normalizeTerms(rowA({ id: "old", valid_to: "2026-10-15" })),
    C.normalizeTerms(rowA({ id: "new", valid_from: "2026-10-16" })),
  ], "2026-10");
  const r = C.settle({ terms, minutes: H(160) });
  assert.equal(r.status, "review");
  assert.equal(r.amount, null);
  assert.match(r.reasons.join(), /2件以上/);
});
await ok("月の一部だけ有効（日割り）は計算しない。prorate の有無で理由の文が変わる", async () => {
  const a = run({ valid_from: "2026-10-16", prorate: false }, H(80));
  assert.equal(a.status, "review");
  assert.match(a.reasons.join(), /日割りの扱いを確認/);
  const b = run({ valid_from: "2026-10-16", prorate: true }, H(80));
  assert.equal(b.status, "review");
  assert.match(b.reasons.join(), /日割りの精算は、まだ自動計算していません/);
  assert.equal(b.amount, null);
});
await ok("条件が無ければ none。売上単価が未設定・稼働が未確定（null）は要確認", async () => {
  const n = C.settle({ terms: C.termsForMonth([], "2026-10"), minutes: H(160) });
  assert.equal(n.status, "none");
  assert.equal(n.amount, null);
  const p = run({ sales_unit_price: null }, H(160));
  assert.equal(p.status, "review");
  assert.match(p.reasons.join(), /売上単価が未設定/);
  const m = run({}, null);
  assert.equal(m.status, "review");
  assert.match(m.reasons.join(), /稼働時間が確定していません/);
  assert.equal(m.amount, null);
});
await ok("要確認でも、複数の理由は全部返す（日給・単価未設定・未確定）", async () => {
  const r = run({ pricing_type: "daily", sales_unit_price: null, settlement_mode: null }, null);
  assert.equal(r.reasons.length, 3);
});
await ok("仕入単価は、精算の金額に使わない（売上側だけを計算）", async () => {
  const a = run({ purchase_unit_price: "1" }, H(160));
  const b = run({ purchase_unit_price: "999999" }, H(160));
  assert.equal(a.amount, 700000);
  assert.equal(b.amount, 700000);
});

console.log("— 表示用 —");

await ok("describeTerms：月額（幅あり）・月額（精算なし）・時給・未設定", async () => {
  const n = (o) => C.normalizeTerms(rowA(o));
  assert.equal(C.describeTerms(n({})), "月額 700,000円（140〜180h）");
  assert.equal(C.describeTerms(n({ settlement_mode: "fixed" })), "月額 700,000円（精算なし）");
  assert.equal(C.describeTerms(n({ pricing_type: "hourly", sales_unit_price: "4500" })), "時給 4,500円");
  assert.equal(C.describeTerms(n({ sales_unit_price: null, settle_min_minutes: null })), "月額 未設定（精算幅 未設定）");
  assert.equal(C.describeTerms(null), "");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
