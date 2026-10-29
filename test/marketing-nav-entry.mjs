// A dedicated, immutable-safe Marketing header entry check (no real accounts/data).
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const pages=[
 "home.html","menu.html","office/index.html","office/monthly.html",
 "office/billing.html","office/recurring.html","office/terms.html","office/timesheet.html",
 "hr/index.html","hr/applicants.html","hr/ceo-review.html","hr/document.html",
 "hr/inbox.html","hr/materials.html",
 "sales/index.html","sales/analytics.html","sales/attack.html","sales/campaigns.html",
 "sales/companies.html","sales/leads.html","sales/proposals.html","sales/templates.html",
 "keiei/index.html","admin-members.html"
];
const shell=read("js/layout-marketing.js");
assert.match(shell, /key: "marketing", href: "\/marketing\//);
assert.match(shell, /if \(t\.key === "marketing"\) return Boolean\(shows\.marketing\)/);
// 社労士・税理士（restrictedAdvisor）には出さない。役割の並びは layout.js と同じ（test/layoutparity.mjs）
assert.match(shell, /const restrictedAdvisor = \["sr", "tax_advisor"\]\.includes\(me\?\.appRole\)/);
assert.match(shell, /marketing: !restrictedAdvisor && Boolean\(me\?\.access\?\.marketing\)/);
for(const file of pages) {
 const html=read(file);
 const linked=/src="(?:\.\.\/)?js\/layout-marketing\.js"/.test(html);
 assert.ok(linked,file+" must use uncached Marketing-aware header JS");
 assert.doesNotMatch(html, /src="(?:\.\.\/)?js\/layout\.js\?v=20261024nav1"/,file+" must not load stale immutable navigation");
}
const ctx={window:{},location:{pathname:"/home.html",hash:""},console};
vm.createContext(ctx);
vm.runInContext(shell.replace("  window.KPLayout = {",`
 window.__marketingNav={TOOLS,showsFor,shortcutsHtml};
 window.KPLayout = {`),ctx);
const menu=ctx.window.__marketingNav;
assert.equal(menu.TOOLS.filter(t=>t.key==="marketing").length,1,"one top menu");
const allowed=menu.showsFor({appRole:"owner",access:{marketing:true}});
const denied=menu.showsFor({appRole:"member",access:{marketing:false,office:true}});
assert.equal(allowed.marketing,true);
assert.equal(denied.marketing,false);
for(const appRole of ["sr","tax_advisor"]) assert.equal(menu.showsFor({appRole,access:{marketing:true}}).marketing,false,appRole+" には出さない");
assert.match(menu.shortcutsHtml(allowed),/href="\/marketing\//);
assert.doesNotMatch(menu.shortcutsHtml(denied),/data-shortcut="marketing"/);
console.log("Marketing menu: "+pages.length+" pages + permission-gated shared header PASS");
