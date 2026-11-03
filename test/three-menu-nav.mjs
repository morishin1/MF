// Three-primary-menu navigation contract. No live app, tenant data, or external access.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const sales=read("js/sales-layout.js"),layout=read("js/layout.js");
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};

const extract=(src,name)=>{
 const start=src.indexOf("const "+name+" = [");assert.ok(start>=0,name+" exists");
 const tail=src.slice(start+("const "+name+" = ").length);
 const last=tail.indexOf("];");assert.ok(last>=0,name+" closes");
 return Function('"use strict";return ('+tail.slice(0,last+1)+');')();
};
const salesNav=extract(sales,"NAV");
check(salesNav.length===3,"Sales exactly 3 top-level entries");
check(salesNav.map(x=>x.label).join("|")==="今日の営業判断|企業・提案|成果分析","Sales menu names/order");
check(["companies","proposals","attack","leads"].every(key=>salesNav[1].match.includes(key)),"Sales original pages remain grouped");
const salesWork=extract(sales,"WORK_NAV");
check(salesWork.map(x=>x.key).join(",")==="companies,proposals,attack,leads","Sales second row retains four workflows");
check(salesWork.every(x=>x.href.startsWith("/sales/")),"Sales old URLs retained");
check(sales.includes('aria-current="page"')&&sales.includes("isWork(active)"),"Sales active first and second row");
const officeGroups=extract(layout,"OFFICE_GROUPS"),officeTop=extract(layout,"OFFICE_TOP");
check(officeGroups.length===5,"Office original 5 permission groups retained");
check(officeTop[0].href==="/office/","Office initial route retained");
check(layout.includes('key: "office-people-docs", label: "人・書類"')&&layout.includes('key: "office-finance-admin", label: "経理・管理"'),"Office 2 grouped categories plus home");
check(layout.includes("OFFICE_DISPLAY_GROUPS.find((g) => g.items.some(hit))"),"Office active group projection");
check(layout.includes("OFFICE_TOP.filter(vis)")&&layout.includes("g.items.filter(vis).map(first)"),"Office permission gating unchanged");
const keiei=extract(layout,"KEIEI_TABS");
check(keiei.map(x=>x.label).join("|")==="経営判断|人・組織|財務・管理","Keiei 3 top categories");
check(keiei.length===3,"Keiei has exactly 3 top tabs");
check(["home","sales"].every(view=>keiei[0].views.includes(view)),"Keiei decision and sales views kept");
check(["members","people","onboarding","pay"].every(view=>keiei[1].views.includes(view)),"Keiei staff and payroll views kept");
check(["finance","payroll","risk","security"].every(view=>keiei[2].views.includes(view)),"Keiei finance and security views kept");
check(keiei[2].sub.some(x=>x.href==="/admin-members.html#roles")&&keiei[2].sub.some(x=>x.href==="/admin-analytics.html"),"Keiei rights and analytics retain direct routes");
check(layout.includes('keieiTabOf = (view) => KEIEI_TABS.find'),"Keiei existing hash deep links still resolve");
console.log(checks+" three-menu navigation contracts passed");
