// Sales 提案管理チーム全件閲覧・3担当表示・本人だけチェックボックス編集の回帰テスト
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { shapeProposal, filterRows, FILTER_KEYS } from "../lib/sales-proposals.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(ROOT, "sales/proposals.html"), "utf8");
const inline = html.match(/<script>\s*([\s\S]*?)<\/script>/);
assert.ok(inline, "提案管理のJavaScriptが存在する");
new Script(inline[1], { filename: "sales/proposals.html" });
const cols = readFileSync(resolve(ROOT, "js/sales-proposal-columns.js"), "utf8");
new Script(cols, { filename: "js/sales-proposal-columns.js" });
const list = readFileSync(resolve(ROOT, "api/sales/proposals/index.js"), "utf8");
const detail = readFileSync(resolve(ROOT, "api/sales/proposals/detail.js"), "utf8");
const handoff = readFileSync(resolve(ROOT, "api/sales/proposals/handoff.js"), "utf8");
const bulk = readFileSync(resolve(ROOT, "api/sales/proposals/bulk.js"), "utf8");
const intake = readFileSync(resolve(ROOT, "lib/sales-proposal-intake.js"), "utf8");
const sql = readFileSync(resolve(ROOT, "db/142_sales_team_proposals_bulk.sql"), "utf8");
const assignmentSql = readFileSync(resolve(ROOT, "db/143_sales_proposal_assignment_requests.sql"), "utf8");
const assignmentApi = readFileSync(resolve(ROOT, "api/sales/proposals/assignment-requests.js"), "utf8");

for (const id of ["pp-bulk", "pp-bulk-edit", "pp-bulk-archive", "pp-bulk-restore", "pp-column-head", "pp-list-meta"]) {
  assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1, "要素:" + id);
}
assert.ok(cols.includes('id="pp-all"'), "全選択は動的な列ヘッダに表示");

for (const id of ["pp-tab-list","pp-tab-kpi","pp-tab-admin","pp-view-list","pp-view-kpi","pp-view-admin",
  "filters-extra","pp-page-size","pp-page-prev","pp-page-next","pp-page-info"]) {
  assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1, "コンパクトUI要素:" + id);
}
assert.ok(html.includes('id="pp-view-kpi" role="tabpanel"') && html.includes('id="pp-view-admin" role="tabpanel"'), "分析・連携は別タブ");
assert.ok(html.includes("max-height:min(62vh,680px)"), "提案表が画面内スクロール");
assert.ok(inline[1].includes("function ppSetPageSize(value)"), "20件と50件に切替可能");
assert.ok(inline[1].includes("rows.slice(start, start + ppPageSize)"), "一覧とカードはページ単位描画");
assert.ok(inline[1].includes("ppPageRows().filter"), "全選択は表示ページだけ");
assert.ok(inline[1].includes('const quickKeys = new Set('), "絞り込みの表示を整理");

assert.ok(cols.includes('"proposal", "cs", "closing"') || cols.includes('"proposal","cs","closing"'), "担当3列を一覧に表示");
assert.ok(inline[1].includes('const STATE = { filter: "all"'), "初期表示は全件");
assert.ok(inline[1].includes('ppChain(r)'), "一覧とスマホカードで3担当を表示");
for (const label of ["提案者", "CS担当", "クロージング"]) assert.ok(inline[1].includes(label), label);
assert.ok(inline[1].includes('!r.canEdit ? " pp-row-readonly"'), "他人の提案は閲覧バッジ");
assert.ok(inline[1].includes('r.canEdit || r.canRestore'), "自分の提案のみ選択");
assert.ok(inline[1].includes('!detail.canEdit'), "他人の詳細は閲覧専用");
assert.ok(inline[1].includes('!detail.canEdit ?'), "CTA編集禁止");
assert.ok(inline[1].includes('ppAssignment(\'direct\')') && inline[1].includes('担当変更を申請'), "担当者・管理者の直接変更と他メンバーの申請UI");
assert.ok(inline[1].includes('担当変更履歴') && inline[1].includes('ppReviewAssignment'), "担当変更の履歴と承認UI");
assert.ok(inline[1].includes('ENGER上のCL担当'), "ENGER CL担当をSales担当と分けて表示");
assert.ok(!inline[1].includes('id="n-owner"'), "手動提案で他人名義の登録不可");

assert.ok(!list.includes('query = query.eq("sales_owner_id", me)'), "一覧GETでは担当者でアクセス制限しない");
assert.ok(list.includes('manager || p.sales_owner_id === me'), "一覧の直接編集権限は管理者または担当本人");
assert.ok(detail.includes('if (!canEdit && !canAssign) return json(res, 403'), "更新POSTで他メンバーの直接編集を拒否");
assert.ok(detail.includes('proposal.sales_owner_id === me'), "担当者本人の直接編集権限を検証");
assert.ok(handoff.includes('!manager && me !== proposal.sales_owner_id'), "引継ぎRPCは現担当または管理者");
assert.ok(handoff.includes('gw_sales_transfer_proposal_owner'), "引継ぎRLS保護ラッパー");
assert.ok(assignmentApi.includes('gw_sales_proposal_request_assignment') && assignmentApi.includes('gw_sales_proposal_review_assignment_request'), "担当変更申請・承認は専用RPC");
assert.ok(assignmentSql.includes('gw_sales_is_manager(p_tenant)'), "DB RLSで管理者の直接編集を許可");
assert.ok(assignmentSql.includes('self_review_forbidden') && assignmentSql.includes('status=\'pending\''), "自己承認禁止・申請履歴保存");
assert.ok(bulk.includes('ids.length > 50') && bulk.includes('p_ids: ids'), "選択50件まで");
assert.ok(intake.includes('matchOwner(emps, p.matchingOwner)'), "ENGER提案者を初回担当にする");

assert.ok(sql.includes('gw_sales_proposal_visible(p_tenant uuid, p_owner uuid)'), "同テナント全件閲覧");
assert.ok(sql.includes('gw_sales_proposal_editable_id'), "活動記録も本人だけ編集");
assert.ok(sql.includes('for update to authenticated'), "更新RLS");
assert.ok(sql.includes('gw_sales_bulk_proposals('), "一括操作はトランザクション");
assert.ok(sql.includes("p_action not in ('archive','restore','edit')"), "アーカイブ・復元・編集");
assert.ok(sql.includes('if v_count <> cardinality(v_ids)'), "1件でも取得できないと全件ロールバック");
assert.ok(sql.includes('v.tenant_id <> v_tenant'), "複数テナント混在禁止");
assert.ok(sql.includes("cancel_reason='提案をアーカイブしたため'"), "アーカイブ時は未完了タスク停止");

const owner = "10000000-0000-4000-8000-000000000001";
const cs = "10000000-0000-4000-8000-000000000002";
const close = "10000000-0000-4000-8000-000000000003";
const p = shapeProposal({ id: "p1", source_system: "enger", company_name: "テスト社", title: "Java",
  matching_owner_name: "藤本", sales_owner_id: cs, handoff_stage: "cs",
  cs_owner_id: cs, closing_owner_id: close, status: "call_wait", sent_at: "2026-10-20T09:00:00Z",
  archived_at: null, updated_at: "2026-10-20T10:00:00Z",
},{ nameOf:(id)=>id===cs?"中村":id===close?"池永":id===owner?"藤本":null });
assert.equal(p.matchingOwnerName, "藤本");
assert.equal(p.csOwnerName, "中村");
assert.equal(p.closingOwnerName, "池永");
assert.equal(p.archived,false);
assert.ok(FILTER_KEYS.includes("archived"));
assert.equal(filterRows([p],{filter:"all"}).length,1);
assert.equal(filterRows([{...p,archived:true}],{filter:"all"}).length,0);
assert.equal(filterRows([{...p,archived:true}],{filter:"archived"}).length,1);
console.log("PASS Sales all-team visibility / owner-manager edit / assignment requests / history");
