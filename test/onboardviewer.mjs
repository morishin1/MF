// 入社手続き画面を、誰が開けるか。
//
// ■ 何を守るテストか
//
//   1. 自分のぶんは、いつでも開ける
//   2. 管理者・人事は、他人のぶんを「管理者」として開ける
//   3. 社労士は、他人のぶんを「社労士」として開ける
//   4. それ以外（一般メンバー）は、他人のぶんを開けない
//   5. 見えるものは、ここでは決めない（役割を返すだけ）
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const V = await import(join(ROOT, "lib/onboard-viewer.js"));

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const member = (over = {}) => ({
  employee: { id: "emp-1" }, isAdmin: false, isHr: false, isAdvisor: false, ...over,
});

console.log("\n=== 入社手続き画面：誰が開けるか ===\n");

ok("自分のぶんは開ける", () => {
  const r = V.resolveViewer(member(), "emp-1");
  assert.deepEqual(r, { ok: true, role: "self", employeeId: "emp-1" });
});
ok("employeeId を省いても自分のぶん", () => {
  const r = V.resolveViewer(member(), null);
  assert.deepEqual(r, { ok: true, role: "self", employeeId: "emp-1" });
});

ok("管理者は、他人のぶんを開ける", () => {
  const r = V.resolveViewer(member({ isAdmin: true }), "emp-9");
  assert.deepEqual(r, { ok: true, role: "admin", employeeId: "emp-9" });
});
ok("人事も、他人のぶんを開ける", () => {
  const r = V.resolveViewer(member({ isHr: true }), "emp-9");
  assert.deepEqual(r, { ok: true, role: "admin", employeeId: "emp-9" });
});
ok("社労士は、他人のぶんを開ける", () => {
  const r = V.resolveViewer(member({ isAdvisor: true }), "emp-9");
  assert.deepEqual(r, { ok: true, role: "advisor", employeeId: "emp-9" });
});
ok("一般メンバーは、他人のぶんを開けない", () => {
  const r = V.resolveViewer(member(), "emp-9");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "forbidden");
});
ok("社員名簿に無い人（内定前など）は開けない", () => {
  const r = V.resolveViewer({ employee: null, isAdmin: true }, "emp-9");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_employee");
});
ok("管理者かつ社労士でも、優先は管理者（表示の役割は1つ）", () => {
  const r = V.resolveViewer(member({ isAdmin: true, isAdvisor: true }), "emp-9");
  assert.equal(r.role, "admin");
});

ok("ラベルが引ける", () => {
  assert.equal(V.roleLabel("self"), "本人");
  assert.equal(V.roleLabel("admin"), "管理者");
  assert.equal(V.roleLabel("advisor"), "社労士");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
