// Sales 提案管理全件閲覧・管理者一括操作・3担当の直接変更の回帰テスト
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
const roleSql = readFileSync(resolve(ROOT, "db/145_sales_proposal_inline_owners.sql"), "utf8");
const roles = readFileSync(resolve(ROOT, "api/sales/proposals/owners.js"), "utf8");

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
for (const label of ["提案担当", "CS担当", "クロージング担当"]) assert.ok(inline[1].includes(label), label);
assert.ok(inline[1].includes('!r.canEdit ? " pp-row-readonly"'), "他人の提案は閲覧バッジ");
assert.ok(inline[1].includes('r.canEdit || r.canRestore'), "本人と管理者が選択可能");
assert.ok(inline[1].includes('!detail.canEdit'), "他人の詳細は閲覧専用");
assert.ok(inline[1].includes('!detail.canEdit ?'), "CTA編集禁止");
assert.ok(inline[1].includes('detail.canAssign'), "管理者は未割当の担当のみ初回設定");
assert.ok(!inline[1].includes('id="n-owner"'), "手動提案で他人名義の登録不可");

assert.ok(!list.includes('query = query.eq("sales_owner_id", me)'), "一覧GETでは担当者でアクセス制限しない");
assert.ok(list.includes('canEdit: Boolean(!p.archived_at && (manager ||'), "更新権限は管理側か現担当");
assert.ok(detail.includes('if (!canEdit && !canAssign) return json(res, 403'), "更新POSTで他人の編集を拒否");
assert.ok(detail.includes('proposal.sales_owner_id)'), "未割当かどうかの検証");
assert.ok(handoff.includes('(!manager && me !== proposal.sales_owner_id)'), "正式引継ぎは現担当か管理者");
assert.ok(handoff.includes('gw_sales_transfer_proposal_owner'), "引継ぎRLS保護ラッパー");
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
assert.ok(inline[1].includes("function ppInlineOwner("), "一覧の担当プルダウンに保存イベントがある");
assert.ok(inline[1].includes("/api/sales/proposals/owners"), "行内から変更APIへ保存");
assert.ok(inline[1].includes("ppOwnerSelect(r,role)"), "3つの担当欄にプルダウンを表示");
assert.ok(inline[1].includes("event.stopPropagation()"), "プルダウン操作で詳細を開かない");
assert.ok(bulk.includes('!canManageProposals(ctx)'), "管理者の一括操作はサーバ権限で判定");
assert.ok(roleSql.includes('gw_sales_is_manager(v.tenant_id)'), "管理者はDB側でも一括操作を許可");
assert.ok(roleSql.includes("v.tenant_id <> v_tenant"), "新RPCでもテナントを検証");
assert.ok(roleSql.includes("v_old is distinct from p_expected_owner"), "担当競合を原子的に検知");
assert.ok(roleSql.includes("public.gw_sales_employee_ok(p_owner, v.tenant_id)"), "変更先は同じ会社のSales利用者だけ");
assert.ok(roleSql.includes("gw_sales_proposal_activities"), "変更履歴を保存");
assert.ok(!roleSql.includes("delete from public.gw_sales_proposals"), "削除はアーカイブで履歴維持");
assert.ok(roles.includes("gw_sales_set_proposal_stage_owner"), "専用APIから履歴付きRPCを実行");
assert.equal(p.proposalOwnerId, null, "既存レコードの元担当未登録でも形が壊れない");
console.log("PASS Sales all-team visibility / manager bulk actions / inline stage owner updates");
