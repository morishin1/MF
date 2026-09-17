// SES現場契約の値の定義・正規化。純粋関数だけを見る。
//
// ■ 何を守るテストか
//
//   1. 区分・単価種別・更新状態は決まった値だけ
//   2. 対象者・所属会社・契約開始日は必須（作成時）
//   3. 更新（partial）では、渡した項目だけを見る
//   4. 契約終了日は開始日より前にできない
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const S = await import(join(ROOT, "lib/site-contracts.js"));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const base = () => ({
  engagementKind: "bp", siteCompany: "A社", primeCompany: "元請B社",
  periodFrom: "2026-10-01", periodTo: "2027-03-31",
  unitPrice: 700000, unitPriceType: "月額",
  settlementCondition: "140h〜180h、超過1,500円/控除1,200円",
  renewalStatus: "pending", note: "",
});

console.log("\n=== SES現場契約（純粋関数） ===\n");

console.log("— 決まった値だけ —");

ok("区分は pp/bp の2つだけ", () => {
  assert.deepEqual(S.ENGAGEMENT_KINDS, ["pp", "bp"]);
});
ok("単価種別は3つだけ", () => {
  assert.deepEqual(S.UNIT_PRICE_TYPES, ["月額", "時給", "日給"]);
});
ok("更新状態は4つだけ", () => {
  assert.deepEqual(S.RENEWAL_STATUSES, ["pending", "confirmed", "ending", "renewed"]);
});

console.log("— 新規作成 —");

ok("そろっていれば通る", () => {
  const r = S.normalizeSiteContract(base());
  assert.equal(r.error, undefined);
  assert.equal(r.value.engagement_kind, "bp");
  assert.equal(r.value.site_company, "A社");
  assert.equal(r.value.prime_company, "元請B社");
  assert.equal(r.value.period_from, "2026-10-01");
  assert.equal(r.value.unit_price, 700000);
  assert.equal(r.value.renewal_status, "pending");
});

ok("区分が pp/bp 以外なら拒否", () => {
  const r = S.normalizeSiteContract({ ...base(), engagementKind: "gyomu_itaku" });
  assert.ok(r.error);
});
ok("所属会社が空なら拒否", () => {
  const r = S.normalizeSiteContract({ ...base(), siteCompany: "" });
  assert.ok(r.error);
});
ok("契約開始日が無ければ拒否", () => {
  const r = S.normalizeSiteContract({ ...base(), periodFrom: "" });
  assert.ok(r.error);
});
ok("契約終了日が開始日より前なら拒否", () => {
  const r = S.normalizeSiteContract({ ...base(), periodFrom: "2026-10-01", periodTo: "2026-09-01" });
  assert.ok(r.error);
});
ok("単価はマイナスを拒否", () => {
  const r = S.normalizeSiteContract({ ...base(), unitPrice: -1 });
  assert.ok(r.error);
});
ok("単価種別が決まった値以外なら拒否", () => {
  const r = S.normalizeSiteContract({ ...base(), unitPriceType: "年俸" });
  assert.ok(r.error);
});
ok("更新状態が決まった値以外なら拒否", () => {
  const r = S.normalizeSiteContract({ ...base(), renewalStatus: "done" });
  assert.ok(r.error);
});
ok("単価を渡さなければ null（未入力もOK）", () => {
  const { unitPrice, ...rest } = base();
  const r = S.normalizeSiteContract(rest);
  assert.equal(r.error, undefined);
  assert.equal(r.value.unit_price, undefined);
});

console.log("— 更新（partial）—");

ok("渡した項目だけを見る", () => {
  const r = S.normalizeSiteContract({ id: "sc-1", renewalStatus: "confirmed" }, { partial: true });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.value, { renewal_status: "confirmed" });
});
ok("渡さなかった必須項目（対象者・所属会社など）は、無くても怒らない", () => {
  const r = S.normalizeSiteContract({ id: "sc-1", unitPrice: 750000 }, { partial: true });
  assert.equal(r.error, undefined);
  assert.equal(r.value.unit_price, 750000);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
