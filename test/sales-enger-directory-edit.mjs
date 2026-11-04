import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=(p)=>readFileSync(p,"utf8");
const list=source("api/sales/enger-company-directory.js");
const detail=source("api/sales/enger-company-detail.js");
const bulk=source("api/sales/enger-company-bulk.js");
const view=source("db/159_sales_enger_directory_overrides.sql");
const ui=source("js/sales-enger-directory.js");
const html=source("sales/companies.html");
const n=source("js/sales-enger-supply.js");
const expectations=[
 ["Directory auth",list.includes("requireUser(req,res)")&&list.includes("canSell(ctx)")],
 ["Tenant scope",list.includes('.eq("tenant_id",ctx.tenantId)')],
 ["Safe all-row count",list.includes("count==null")||list.includes("count:null")],
 ["Sort whitelist",list.includes("const SORTS=new Set(")],
 ["Server sort order",list.includes(".order(sort,")],
 ["Filtered hidden rows",list.includes('.is("directory_hidden_at",null)')],
 ["Source priority override",list.includes(".eq(\"effective_priority\",priority)")],
 ["Directory three buckets",list.includes("existing")&&list.includes("revive")&&list.includes("new")],
 ["Contact detail permission",detail.includes("canSell(ctx)")&&detail.includes("requireUser(req,res)")],
 ["Detail by immutable company ID",detail.includes('.eq("id",id)')&&!detail.includes('.ilike("name"')],
 ["Real contact source",detail.includes("contact_email")&&detail.includes("phone")&&detail.includes("website")],
 ["Touchpoint source by company ID",detail.includes("company_touchpoints")&&detail.includes('.eq("company_id",id)')],
 ["Proposals linked by ID",detail.includes('from("proposals")')&&detail.includes('.eq("company_id",id)')],
 ["Do not infer contracts",detail.includes("明示的に確認した契約情報")],
 ["Bulk roles enforced",bulk.includes("manager_required")&&bulk.includes("canSell(ctx)")],
 ["Bulk controlled max",bulk.includes("ids.length>50")],
 ["Bulk soft removal",bulk.includes('action==="exclude"')&&bulk.includes("hidden_at")],
 ["Bulk never deletes companies",!bulk.includes('.delete(')&&bulk.includes('from("gw_sales_enger_company_overrides")')&&!bulk.includes('from("companies").update(')],
 ["Bulk updates evidence",bulk.includes("relationship_evidence")&&bulk.includes("evidence.length<10")],
 ["Bulk tenant checked",bulk.includes('.eq("tenant_id",tenant)')],
 ["Bulk audit",bulk.includes("gwLog(")],
 ["RLS active",view.includes("ENABLE ROW LEVEL SECURITY")],
 ["Privileged only",view.includes("REVOKE ALL ON public.gw_sales_enger_company_overrides FROM PUBLIC,anon,authenticated")],
 ["Per-tenant evidence",view.includes("ON o.tenant_id=t.id")],
 ["Reversible view",view.includes("directory_hidden_at")&&view.includes("effective_priority")],
 ["Checkbox bulk",ui.includes("engr-select-all")&&ui.includes("data-engr-select")],
 ["Clickable modal",ui.includes("data-engr-detail")&&ui.includes('role="dialog"')],
 ["Hover preview",ui.includes("engr-hover-card")&&html.includes(".engr-hover-cell:hover")],
 ["Sortable priority and columns",ui.includes("effective_priority")&&ui.includes("[data-engr-sort]")],
 ["Contact links safe",ui.includes("safePhone")&&ui.includes("safeEmail")&&ui.includes("needsContactReview")],
 ["History and trade evidence",ui.includes("engr-history")&&ui.includes("relationshipEvidence")],
 ["Reversible user interface",ui.includes("一覧から除外（履歴は残す）")&&ui.includes("除外済みも表示")===false&&html.includes("除外済みも表示")],
 ["ENGER info intake preserved",ui.includes('id="enger-supply-pipeline"')&&n.includes("enger:company-open")],
 ["Standard UUIDs in supply UI",n.includes('[0-9a-f]{4}-[0-9a-f]{12}')],
];
for(const [name,result] of expectations)assert.equal(Boolean(result),true,name);
console.log("PASS ENGER Sales directory list, bulk, sorting and evidence contract ("+expectations.length+" checks)");
