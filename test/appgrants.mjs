// アプリ利用権限（gw_app_grants, db/119）と内部ロールの分離。
//
// ■ 何を守るテストか
//   1. 移行の前と後で、実効権限が変わらない（必須条件。差分 0 件）
//      内部ロール8つの全部分集合（256通り）× 会計の管理者（あり・なし）で、
//      「移行前の式（このテストに凍結したコピー）」と「いまの式（lib/gw.js）＋移行の規則で付くアプリ利用権限」を比べる。
//   2. アプリ利用権限（入口）と内部ロール（中身）が、別になっている
//        Office ON だけでは、人事・労務・経理・事務・月末月初のどれも使えない
//        Office ON ＋ hr ＝ 人事・労務 / ＋ finance ＝ 経理・事務 / ＋ manager・finance・owner ＝ 月末月初
//        hr の人に、月末月初は付かない（移行でも、新しく付けるときも）
//        内部ロールを持っているだけでは、入口は開かない（アプリ利用権限が無ければ入れない）
//        経営は owner から導出（owner は4つとも使える。アプリ利用権限の行は要らない）
//   3. db/119 の移行 INSERT と、lib/app-grants.js の移行の規則が同じ
//   4. 確認用 SQL（dryrun / after）は読み取りだけ。db/119 は判定関数（RLS）を変えない
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  accessOf, memberAccessOf, canManageHr, canSeeSalary, canAccessHr, canAccessSales, canAccessOffice,
  canOfficeHr, canOfficeFinance, canAccessKeiei, canManageAiInquiries, isHrOf, hasOfficeEntry,
} from "../lib/gw.js";
import { APP_FROM_ROLES, APP_KEYS, appsFromRoles, resolveApps, loadAppsMany } from "../lib/app-grants.js";
import { appViewOf, accessForMember } from "../lib/member-access.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const ROLES = ["owner", "hr", "it", "finance", "manager", "labor_advisor", "recruiter", "sales"];
const subsets = [];
for (let m = 0; m < 1 << ROLES.length; m++) subsets.push(ROLES.filter((_, i) => m & (1 << i)));

/** 移行前の式（lib/gw.js が内部ロールだけで決めていたときのコピー。変えない） */
function legacy(roles, isAdmin) {
  const has = (r) => roles.includes(r);
  const o = has("owner"), m = has("manager"), h = has("hr"), fin = has("finance"), rec = has("recruiter"), sal = has("sales");
  const isHr = h || o;
  const monthly = o || m || fin;
  const manageHr = isAdmin || isHr;
  return {
    recruit: o || m || h || rec, sell: o || m || sal, office: monthly,
    officeHr: Boolean(isAdmin || isHr || o || h), officeFinance: Boolean(isAdmin || o || fin),
    keiei: o, aiInquiries: manageHr || monthly, manageHr, salary: o || manageHr,
  };
}
/** いまの式（lib/gw.js）。gwContext が作る ctx と同じ形（apps は gw_app_grants、isHr は isHrOf） */
function current(roles, isAdmin, apps) {
  const ctx = { isAdmin, roles, apps, isHr: isHrOf({ roles, apps }) };
  const a = accessOf(ctx);
  return {
    recruit: a.recruit, sell: a.sell, office: a.office, officeHr: a.officeHr, officeFinance: a.officeFinance,
    keiei: a.keiei, aiInquiries: a.aiInquiries, manageHr: Boolean(canManageHr(ctx)), salary: Boolean(canSeeSalary(ctx)),
  };
}

console.log("\n=== 移行の前と後で、実効権限が変わらない（256通り × 会計の管理者） ===\n");

await ok("全ロールの組合せ × 管理者の有無で、差分 0 件（移行の規則で付くアプリ利用権限）", () => {
  const diffs = [];
  for (const roles of subsets) for (const isAdmin of [false, true]) {
    const a = legacy(roles, isAdmin), b = current(roles, isAdmin, appsFromRoles(roles));
    for (const k of Object.keys(a)) if (Boolean(a[k]) !== Boolean(b[k])) diffs.push(`${roles.join("+") || "（なし）"}${isAdmin ? "+管理者" : ""}: ${k} ${a[k]}→${b[k]}`);
  }
  assert.equal(diffs.length, 0, `差分 ${diffs.length} 件\n${diffs.slice(0, 8).join("\n")}`);
});

await ok("表が無い間（apps を持たない ctx）も、同じ結果（内部ロールから移行の規則どおりに導出）", () => {
  const diffs = [];
  for (const roles of subsets) for (const isAdmin of [false, true]) {
    const a = legacy(roles, isAdmin);
    const b = current(roles, isAdmin, undefined);
    for (const k of Object.keys(a)) if (Boolean(a[k]) !== Boolean(b[k])) diffs.push(`${roles.join("+")}${isAdmin ? "+管理者" : ""}: ${k}`);
  }
  assert.equal(diffs.length, 0, diffs.slice(0, 5).join("\n"));
});

await ok("メンバー一覧の判定（memberAccessOf）も、移行前と同じ", () => {
  for (const roles of subsets) for (const isAdmin of [false, true]) {
    const a = legacy(roles, isAdmin), b = memberAccessOf({ roles, isAdmin, apps: appsFromRoles(roles) });
    for (const k of ["recruit", "sell", "office", "officeHr", "officeFinance", "keiei"]) {
      assert.equal(Boolean(b[k]), Boolean(a[k]), `${roles.join("+")}${isAdmin ? "+管理者" : ""}: ${k}`);
    }
  }
});

console.log("\n=== 入口（アプリ利用権限）と中身（内部ロール）は別 ===\n");

const E = (roles, apps, isAdmin = false) => {
  const ctx = { isAdmin, roles, apps, isHr: isHrOf({ roles, apps }) };
  return { recruit: canAccessHr(ctx), sell: canAccessSales(ctx), monthly: canAccessOffice(ctx), officeHr: canOfficeHr(ctx), officeFinance: canOfficeFinance(ctx), keiei: canAccessKeiei(ctx), officeApp: hasOfficeEntry(ctx), manageHr: Boolean(canManageHr(ctx)) };
};

await ok("Office ON だけでは、人事・労務・経理・事務・月末月初のどれも使えない（入口だけ）", () => {
  const e = E([], ["office"]);
  assert.equal(e.officeApp, true);
  assert.deepEqual([e.officeHr, e.officeFinance, e.monthly, e.manageHr], [false, false, false, false]);
});

await ok("Office ON ＋ hr ＝ 人事・労務だけ（経理・事務・月末月初は使えない）", () => {
  const e = E(["hr"], ["office"]);
  assert.deepEqual([e.officeHr, e.officeFinance, e.monthly, e.manageHr], [true, false, false, true]);
});

await ok("Office ON ＋ finance ＝ 経理・事務、かつ月末月初（いまの finance の範囲）。人事・労務は使えない", () => {
  const e = E(["finance"], ["office"]);
  assert.deepEqual([e.officeHr, e.officeFinance, e.monthly], [false, true, true]);
});

await ok("Office ON ＋ manager ＝ 月末月初だけ（人事・労務・経理・事務は使えない）", () => {
  const e = E(["manager"], ["office"]);
  assert.deepEqual([e.officeHr, e.officeFinance, e.monthly], [false, false, true]);
});

await ok("hr の人に、月末月初は付かない（移行でも、Office を ON にしても）", () => {
  assert.equal(E(["hr"], appsFromRoles(["hr"])).monthly, false, "移行で付く入口（hr, office）でも月末月初は使えない");
  assert.equal(E(["hr"], ["hr", "office", "sales"]).monthly, false, "ほかのアプリを足しても、月末月初は付かない");
  assert.equal(E(["hr", "recruiter"], ["hr", "office"]).monthly, false);
});

await ok("内部ロールを持っているだけでは、入口は開かない（アプリ利用権限が無ければ、どのアプリにも入れない）", () => {
  for (const r of ["hr", "manager", "finance", "recruiter", "sales"]) {
    const e = E([r], []);
    assert.deepEqual([e.recruit, e.sell, e.monthly, e.officeHr, e.officeFinance, e.officeApp], [false, false, false, false, false, false], r);
  }
});

await ok("アプリ利用権限だけでは、アプリの中の権限（内部ロール）は付かない。採用HR ON だけで人事の管理権限は付かない", () => {
  const e = E([], ["hr", "sales"]);
  assert.deepEqual([e.recruit, e.sell, e.manageHr, e.officeHr], [true, true, false, false]);
});

await ok("経営は owner から導出。owner は4つとも使える（アプリ利用権限の行が無くても）", () => {
  const e = E(["owner"], []);
  assert.deepEqual([e.recruit, e.sell, e.officeApp, e.keiei, e.monthly, e.officeHr, e.officeFinance], [true, true, true, true, true, true, true]);
  assert.equal(E(["manager"], ["hr", "sales", "office"]).keiei, false, "責任者は経営に入れない");
  assert.equal(E([], ["hr", "sales", "office"]).keiei, false, "アプリ利用権限があっても、経営は owner だけ");
});

await ok("会計の管理者は、Office の入口が暗黙（人事・労務・経理・事務は使える。月末月初は内部ロール次第）", () => {
  const e = E([], [], true);
  assert.deepEqual([e.officeApp, e.officeHr, e.officeFinance, e.monthly, e.recruit, e.sell], [true, true, true, false, false, false]);
});

await ok("管理部への問い合わせ（aiInquiries）は、人事の管理権限か月末月初。Office ON だけでは入れない", () => {
  assert.equal(canManageAiInquiries({ roles: [], apps: ["office"], isHr: false, isAdmin: false }), false);
  assert.equal(canManageAiInquiries({ roles: ["finance"], apps: ["office"], isHr: false, isAdmin: false }), true);
});

console.log("\n=== メンバー一覧の4ボタン（appViewOf）===\n");

await ok("4つのボタンの表示：owner は全部 ON で変更不可。会計の管理者は Office が ON で変更不可", () => {
  assert.deepEqual(appViewOf({ roles: ["owner"], apps: [] }), {
    apps: { hr: true, sales: true, office: true, keiei: true },
    appLocks: { hr: "owner", sales: "owner", office: "owner", keiei: "owner" },
  });
  assert.deepEqual(appViewOf({ roles: [], apps: [], isAdmin: true }), {
    apps: { hr: false, sales: false, office: true, keiei: false }, appLocks: { office: "accountingAdmin" },
  });
  assert.deepEqual(appViewOf({ roles: ["hr"], apps: ["hr", "office"] }).apps, { hr: true, sales: false, office: true, keiei: false });
});

await ok("内部ロールは、4つのボタンに出ない（hr を持っていても、アプリ利用権限が無ければ OFF）", () => {
  assert.deepEqual(appViewOf({ roles: ["hr", "manager", "finance", "recruiter", "sales"], apps: [] }).apps, { hr: false, sales: false, office: false, keiei: false });
});

await ok("accessForMember：memberships が読めない（flags=null）ときは access も accountingAdmin も null（確認できません）", () => {
  const r = accessForMember(["hr"], "u1", null, ["hr", "office"]);
  assert.equal(r.access, null); assert.equal(r.accessMeta.accountingAdmin, null);
  assert.deepEqual(r.apps, { hr: true, sales: false, office: true, keiei: false });
  const ok1 = accessForMember(["hr"], "u1", new Map([["u1", true]]), ["hr", "office"]);
  assert.equal(ok1.accessMeta.accountingAdmin, true); assert.equal(ok1.appLocks.office, "accountingAdmin");
  assert.equal(ok1.access.officeHr, true);
});

console.log("\n=== アプリ利用権限の読み込み（lib/app-grants.js）===\n");

await ok("移行の規則：manager→hr,sales,office / hr→hr,office / recruiter→hr / sales→sales / finance→office。owner・it・labor_advisor は行なし", () => {
  assert.deepEqual(appsFromRoles(["manager"]), ["hr", "sales", "office"]);
  assert.deepEqual(appsFromRoles(["hr"]), ["hr", "office"]);
  assert.deepEqual(appsFromRoles(["recruiter"]), ["hr"]);
  assert.deepEqual(appsFromRoles(["sales"]), ["sales"]);
  assert.deepEqual(appsFromRoles(["finance"]), ["office"]);
  assert.deepEqual(appsFromRoles(["owner", "it", "labor_advisor"]), []);
  assert.deepEqual(appsFromRoles(["hr", "finance", "sales"]), ["hr", "sales", "office"]);
  assert.deepEqual(APP_KEYS, ["hr", "sales", "office"], "保存するのは3つだけ（経営は owner から導出）");
});

await ok("resolveApps：表が読めた→その行 / 表が無い→内部ロールから導出 / 読めなかった→入口なし（権限を広げない）", () => {
  assert.deepEqual(resolveApps({ rows: [{ app_key: "sales" }], absent: false, failed: false }, ["manager"]), { apps: ["sales"], state: "table" });
  assert.deepEqual(resolveApps({ rows: [], absent: false, failed: false }, ["manager"]), { apps: [], state: "table" }, "表があって行が無い人は、入口なし（内部ロールを見ない）");
  assert.deepEqual(resolveApps({ rows: null, absent: true, failed: false }, ["hr"]), { apps: ["hr", "office"], state: "derived" });
  assert.deepEqual(resolveApps({ rows: null, absent: false, failed: true }, ["hr"]), { apps: [], state: "error" });
});

await ok("loadAppsMany：表が無い（PGRST205）→ 導出 / 障害 → error / 行あり → 行どおり", async () => {
  const mk = (res) => ({ from: () => ({ select: () => ({ in: async () => res }) }) });
  const roles = new Map([["e1", ["hr"]], ["e2", ["manager"]]]);
  const absent = await loadAppsMany(mk({ data: null, error: { code: "PGRST205", message: "no table" } }), ["e1", "e2"], roles);
  assert.equal(absent.state, "derived"); assert.deepEqual(absent.byId.get("e2"), ["hr", "sales", "office"]);
  const bad = await loadAppsMany(mk({ data: null, error: { code: "XX000", message: "boom" } }), ["e1"], roles);
  assert.equal(bad.state, "error"); assert.deepEqual(bad.byId.get("e1"), []);
  const live = await loadAppsMany(mk({ data: [{ employee_id: "e1", app_key: "sales" }, { employee_id: "e1", app_key: "hr" }], error: null }), ["e1", "e2"], roles);
  assert.equal(live.state, "table"); assert.deepEqual(live.byId.get("e1"), ["hr", "sales"]); assert.deepEqual(live.byId.get("e2"), []);
});

console.log("\n=== SQL（db/119・確認用）===\n");

const sql = (f) => readFileSync(join(ROOT, "db", f), "utf8");
const strip = (t) => t.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

await ok("db/119 の移行 INSERT は、lib/app-grants.js の規則と同じ", () => {
  const body = strip(sql("119_app_grants.sql"));
  const m = /join \(values([\s\S]*?)\) as x\(role, app_key\)/.exec(body);
  assert.ok(m, "VALUES が見つからない");
  const pairs = [...m[1].matchAll(/\('(\w+)',\s*'(\w+)'\)/g)].map((x) => [x[1], x[2]]);
  const fromSql = {};
  for (const [r, a] of pairs) (fromSql[r] ||= []).push(a);
  const fromJs = Object.fromEntries(Object.entries(APP_FROM_ROLES).map(([r, a]) => [r, [...a].sort()]));
  for (const k of Object.keys(fromSql)) fromSql[k].sort();
  assert.deepEqual(fromSql, fromJs);
});

await ok("db/119：保存するアプリは hr / sales / office だけ（経営は保存しない）。判定関数・既存ポリシーは変えない", () => {
  const body = strip(sql("119_app_grants.sql"));
  assert.match(body, /check \(app_key in \('hr', 'sales', 'office'\)\)/);
  assert.ok(!/keiei/.test(body), "keiei を保存しない");
  for (const fn of ["gw_is_hr", "gw_is_recruiting", "gw_is_sales", "gw_is_office", "gw_is_office_finance", "gw_is_owner", "gw_is_keiei"]) {
    assert.ok(!new RegExp(`create (or replace )?function public\\.${fn}\\b`).test(body), `${fn} を変えない`);
  }
  assert.ok(!/gw_role_grants\b[^;]*\b(delete|update)\b|delete from public\.gw_role_grants|update public\.gw_role_grants|alter table public\.gw_role_grants/i.test(body), "内部ロール（gw_role_grants）は変えない・消さない");
  assert.match(body, /on conflict \(employee_id, app_key\) do nothing/, "べき等");
  assert.match(body, /enable row level security/);
});

await ok("確認用 SQL（dryrun・after）は読み取りだけ（create / insert / update / delete / drop / alter が無い）", () => {
  for (const f of ["check_app_grants_dryrun.sql", "check_app_grants_after.sql"]) {
    const body = strip(sql(f));
    assert.ok(!/\b(create|insert|update|delete|drop|alter|truncate)\b/i.test(body), `${f} に書き込みがある`);
    assert.ok(/\bselect\b/i.test(body));
  }
});

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
