// プロパー／BP の印。純粋関数だけを見る。
//
// ■ 何を守るテストか
//
//   1. 区分は2つだけ
//   2. BPには所属先が要る。プロパーには持たせない（送られても無視する）
//   3. 一覧に出す表示（BPは会社名まで見える）
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const P = await import(join(ROOT, "lib/partner.js"));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== プロパー／BP（純粋関数） ===\n");

console.log("— 区分 —");

ok("区分は2つだけ", () => {
  assert.deepEqual(P.EMPLOYEE_KIND_KEYS, ["proper", "bp"]);
});
ok("ラベルが引ける", () => {
  assert.equal(P.kindLabel("proper"), "プロパー");
  assert.equal(P.kindLabel("bp"), "BP");
});

console.log("— 組み合わせの正しさ —");

ok("既定はプロパー。所属先は持たない", () => {
  const r = P.normalizeKind(undefined, undefined);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { employee_kind: "proper", partner_company_id: null });
});
ok("プロパーに所属先を送っても、無視して null にする", () => {
  const r = P.normalizeKind("proper", "co-1");
  assert.equal(r.ok, true);
  assert.equal(r.value.partner_company_id, null);
});
ok("BPには所属先が要る", () => {
  const r = P.normalizeKind("bp", undefined);
  assert.equal(r.ok, false);
  assert.match(r.hint, /所属先/);
});
ok("BP＋所属先なら通る", () => {
  const r = P.normalizeKind("bp", "co-1");
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { employee_kind: "bp", partner_company_id: "co-1" });
});
ok("2つ以外の区分は拒否する", () => {
  const r = P.normalizeKind("gyomu_itaku", "co-1");
  assert.equal(r.ok, false);
});

console.log("— 一覧に出す表示 —");

ok("プロパーは「プロパー」とだけ出る", () => {
  assert.equal(P.kindDisplay({ employee_kind: "proper" }, new Map()), "プロパー");
});
ok("BPは会社名まで見える", () => {
  const companies = new Map([["co-1", { company_name: "株式会社サンプル" }]]);
  assert.equal(P.kindDisplay({ employee_kind: "bp", partner_company_id: "co-1" }, companies),
    "BP（株式会社サンプル）");
});
ok("会社名が引けなくても、BPだと分かる（消えない）", () => {
  assert.equal(P.kindDisplay({ employee_kind: "bp", partner_company_id: "co-9" }, new Map()), "BP");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
