// 社労士・税理士のOfficeタスク：権限、書類同期、定期業務、個人番号分離。
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { createMemDb } from "./_memdb.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => join(ROOT, p);
const moduleUrl = (p) => pathToFileURL(atRoot(p)).href;
const read = (p) => readFileSync(atRoot(p), "utf8");
const TENANT = "00000000-0000-4000-8000-000000000001";
const EMPLOYEE = "00000000-0000-4000-8000-000000000002";
const LABOR = "00000000-0000-4000-8000-000000000003";
const TAX = "00000000-0000-4000-8000-000000000004";

const GW = {
  canManageHr: (ctx) => Boolean(ctx?.isAdmin || ctx?.isHr),
  canOfficeFinance: (ctx) => Boolean(ctx?.isAdmin || ctx?.roles?.includes("owner")
    || (ctx?.apps?.includes("office") && ctx?.roles?.includes("finance"))),
  canAccessOffice: (ctx) => Boolean(ctx?.isAdmin || ctx?.roles?.includes("owner")
    || (ctx?.apps?.includes("office") && ["owner", "manager", "finance"].some((r) => ctx?.roles?.includes(r)))),
};
let notices = [];
let audit = [];
mock.module(moduleUrl("lib/notify.js"), { namedExports: { notify: async (rows) => { notices.push(...rows); return { created: rows.length }; } } });
mock.module(moduleUrl("lib/gw-audit.js"), { namedExports: { gwLog: async (row) => { audit.push(row); } } });
const T = await import(moduleUrl("lib/professional-tasks.js"));
const onboarding = await import(moduleUrl("lib/onboarding.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.stack || e.message); }
};

console.log("\n=== 専門家タスクの権限 ===\n");
const labor = { isAdvisor: true, roles: ["labor_advisor"], employee: { id: LABOR } };
const tax = { roles: ["tax_advisor"], employee: { id: TAX } };
const hr = { isHr: true, roles: ["hr"], apps: ["office"], employee: { id: EMPLOYEE } };
const finance = { roles: ["finance"], apps: ["office"], employee: { id: EMPLOYEE } };

await ok("社労士は担当の労務タスクだけ、税理士タスクやOffice業務へ入れない", async () => {
  assert.equal(T.canViewKind(labor, "labor", GW), true);
  assert.equal(T.canViewKind(labor, "tax", GW), false);
  const source = read("lib/gw.js");
  assert.match(source, /officeProfessionals: canAccessProfessionalTasks\(ctx\)/);
  assert.match(source, /isLaborAdvisor\(ctx\) \|\| isTaxAdvisor\(ctx\)/);
});

await ok("税理士も専用ポータルだけに入り、労務・採用・Officeの他機能には入れない", async () => {
  assert.equal(T.canViewKind(tax, "tax", GW), true);
  assert.equal(T.canViewKind(tax, "labor", GW), false);
  const source = read("lib/gw.js");
  assert.match(source, /officeProfessionals: canAccessProfessionalTasks\(ctx\)/);
  assert.match(source, /officeAny: Boolean\(a\.office \|\| a\.officeHr \|\| a\.officeFinance \|\| a\.officeApp \|\| a\.officeProfessionals\)/);
  const layout = read("js/layout.js");
  assert.match(layout, /if \(key === "officeProfessionals"\) return Boolean\(me\?\.access\?\.officeProfessionals\)/);
  assert.match(read("api/me.js"), /gwRoles\.includes\("tax_advisor"\).*return "tax_advisor"/s);
});

await ok("社内の人事・経理は担当領域の専門家タスクだけ管理できる", async () => {
  assert.equal(T.canManageKind(hr, "labor", GW), true);
  assert.equal(T.canManageKind(hr, "tax", GW), false);
  assert.equal(T.canManageKind(finance, "labor", GW), false);
  assert.equal(T.canManageKind(finance, "tax", GW), true);
});

await ok("タスクは担当者・作成者・業務管理者に限って見える", async () => {
  const task = { kind: "labor", assignee_employee_id: LABOR, created_by: "creator" };
  assert.equal(T.canSeeTask(labor, "unrelated", task, GW), true);
  assert.equal(T.canSeeTask({ roles: ["labor_advisor"], employee: { id: TAX } }, "unrelated", task, GW), false);
  assert.equal(T.canSeeTask(tax, TAX, task, GW), false);
  assert.equal(T.canSeeTask(tax, "creator", task, GW), false);
  assert.equal(T.canSeeTask({ roles: ["hr"], isHr: true, employee: { id: EMPLOYEE } }, "unrelated", task, GW), true);
  assert.equal(T.canSeeTask({ roles: [], employee: { id: TAX } }, "creator", task, GW), false);
});

await ok("日付と個人番号の入力を検査し、期限超過日数を正しく返す", async () => {
  assert.equal(T.isDate("2026-10-29"), true);
  assert.equal(T.isDate("2026-02-30"), false);
  assert.equal(T.safeText("確認事項を整理する").value, "確認事項を整理する");
  assert.match(T.safeText("個人番号 123456789012").error, /個人番号/);
  assert.match(T.safeText("個人番号 123-456-789-012").error, /個人番号/);
  assert.equal(T.safeText("登録番号 T1234567890123").value, "登録番号 T1234567890123");
  const shaped = T.shapeTask({ id: "x", kind: "tax", due_on: "2026-10-27", status: "open", priority: "normal" }, null, null, "2026-10-29");
  assert.equal(shaped.overdue, true);
  assert.equal(shaped.overdueDays, 2);
  assert.equal(T.monthDate(2026, 2, 31), "2026-02-28");
});

await ok("Drive の労務フォルダは、そのフォルダを共有された社労士だけに返す", async () => {
  const proc = { drive_folders: { "04": "AbCdEfGhIjKlMnOp" }, advisor_shared_to: "labor@example.com" };
  assert.equal(T.sharedAdvisorFolderLink(proc, "LABOR@example.com"), "https://drive.google.com/drive/folders/AbCdEfGhIjKlMnOp");
  assert.equal(T.sharedAdvisorFolderLink(proc, "other@example.com"), null);
  assert.equal(T.sharedAdvisorFolderLink({ drive_folders: { "01": "AbCdEfGhIjKlMnOp" }, drive_link: "https://example.com" }, "labor@example.com"), null);
});

console.log("\n=== HR書類の共有連携・定期タスク ===\n");
await ok("退職届と健康保険証の返却記録は社労士共有、ほかの退職項目は本人だけ", async () => {
  const items = onboarding.defaultChecklist("offboarding", "正社員");
  assert.equal(items.find((x) => x.title === "退職届の受理")?.share_with_advisor, true);
  assert.equal(items.find((x) => x.title === "健康保険証の返却")?.share_with_advisor, true);
  assert.equal(items.find((x) => x.title === "PC・備品の返却")?.share_with_advisor, false);
});
const mem = createMemDb({ schema: { gw_professional_tasks: { unique: [["tenant_id", "source_key"]] } } });
mem.rows.gw_procedure_items = [{ id: "item-1", tenant_id: TENANT, procedure_id: "proc-1", item_key: "doc_dependents", title: "扶養控除等申告書", status: "submitted", due_on: "2026-11-15", share_with_advisor: true }];
mem.rows.gw_procedures = [{ id: "proc-1", tenant_id: TENANT, kind: "onboarding", employee_id: EMPLOYEE, target_on: "2026-11-01" }];
mem.rows.gw_role_grants = [{ tenant_id: TENANT, employee_id: LABOR, role: "labor_advisor" }];
mem.rows.gw_employees = [{ id: LABOR, tenant_id: TENANT, status: "active", display_name: "社労士" }];

await ok("本人が提出した共有書類を一件の労務タスクにし、社労士へ通知する", async () => {
  notices = []; audit = [];
  const first = await T.syncProcedureTask(mem.admin(), { tenantId: TENANT, itemId: "item-1", actorId: "employee-user" });
  assert.equal(first.created, true);
  assert.equal(first.task.status, "submitted");
  assert.equal(first.task.assignee_employee_id, LABOR);
  assert.equal(mem.rows.gw_professional_tasks.length, 1);
  assert.equal(mem.rows.gw_professional_task_checklist.length, 2);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].employeeId, LABOR);
  assert.equal(notices[0].link, "/office/professionals.html?tab=labor");
  const repeated = await T.syncProcedureTask(mem.admin(), { tenantId: TENANT, itemId: "item-1", actorId: "employee-user" });
  assert.equal(repeated.created, false);
  assert.equal(mem.rows.gw_professional_tasks.length, 1);
});

await ok("マイナンバー対象書類は共有設定があっても社労士タスクへ出さない", async () => {
  mem.rows.gw_procedure_items[0].item_key = "doc_mynumber";
  const result = await T.syncProcedureTask(mem.admin(), { tenantId: TENANT, itemId: "item-1", actorId: "employee-user" });
  assert.equal(result.skipped, "sensitive_document");
  assert.equal(mem.rows.gw_professional_tasks.length, 1);
  mem.rows.gw_procedure_items[0].item_key = null;
  mem.rows.gw_procedure_items[0].title = "マイナンバー確認書類";
  assert.equal(await T.isSharedProcedureTask(mem.admin(), TENANT, mem.rows.gw_professional_tasks[0]), false);
});

await ok("共有解除後は社労士に手続きタスクを見せない", async () => {
  const task = mem.rows.gw_professional_tasks[0];
  mem.rows.gw_procedure_items[0].share_with_advisor = false;
  assert.equal(await T.isSharedProcedureTask(mem.admin(), TENANT, task), false);
  mem.rows.gw_procedure_items[0].share_with_advisor = true;
});

await ok("税理士の月次業務は月末日を補正し、二重作成しない", async () => {
  const monthly = createMemDb({ schema: {
    gw_professional_tasks: { unique: [["tenant_id", "source_key"]] },
  } });
  monthly.rows.gw_professional_task_templates = [{ id: "tpl", tenant_id: TENANT, title: "月次締め", description: "確認", due_day: 31,
    assignee_employee_id: TAX, checklist: ["残高を確認"], is_active: true, created_by: "manager" }];
  const first = await T.generateTaxTasks(monthly.admin(), TENANT, { from: "2026-10-29", to: "2027-01-31" });
  assert.deepEqual(first.map((r) => r.due_on), ["2026-10-31", "2026-11-30", "2026-12-31", "2027-01-31"]);
  assert.equal(monthly.rows.gw_professional_task_checklist.length, 4);
  const second = await T.generateTaxTasks(monthly.admin(), TENANT, { from: "2026-10-29", to: "2027-01-31" });
  assert.equal(second.length, 0);
  assert.equal(monthly.rows.gw_professional_tasks.length, 4);
});

console.log("\n=== 画面・API・SQLの連携 ===\n");
await ok("Officeタブ・限定ログイン・本人再提出画面・MyNumber分離を実装", async () => {
  const layout = read("js/layout.js");
  const me = read("api/me.js");
  const api = read("api/office-professionals/index.js");
  const fileApi = read("api/office-professionals/file.js");
  const onboarding = read("onboarding.html");
  const migration = read("db/151_office_professional_tasks.sql");
  assert.match(layout, /office_professionals.*officeProfessionals/);
  assert.match(me, /gwRoles\.includes\("tax_advisor"\).*return "tax_advisor"/s);
  assert.match(api, /share_with_advisor/);
  assert.match(api, /isSharedProcedureTask/);
  assert.match(fileApi, /個人番号|マイナンバー/);
  assert.match(onboarding, /advisorReviewNote/);
  assert.match(migration, /role in \([^\n]*tax_advisor/);
  assert.match(migration, /revoke all .* anon, authenticated/s);
  assert.doesNotMatch(migration, /mynumber\s+(?:text|varchar|bigint|integer)/i);
  assert.match(read("vercel.json"), /\/api\/cron\/professional-tasks/);
});

console.log(`\n${pass + fail} 項目中 ${pass} 通過${fail ? `、${fail}失敗` : ""}`);
if (fail) process.exit(1);
