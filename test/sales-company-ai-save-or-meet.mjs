import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=path=>readFileSync(new URL(path,import.meta.url),"utf8");
const html=read("../sales/company-segments.html");
const tabs=read("../js/sales-company-portal-tabs.js");
const list=read("../js/sales-company-segments.js");

test("after AI analysis, Sales offers meeting or registration completion",()=>{
 assert.match(html,/id="lc-stage-register"[^>]*hidden>登録して終了<\/button>/);
 assert.match(html,/id="lc-stage-next"[^>]*hidden>商談へ進む（候補確認） →<\/button>/);
 assert.match(tabs,/const done=progress\?\.steps\?\.analysis\?\.state==="done"/);
 assert.match(tabs,/if\(register\)\{register\.hidden=!done\|\|analyzing;register\.disabled=!done\|\|analyzing;\}/);
 assert.match(tabs,/if\(next\)\{next\.hidden=!done\|\|analyzing;next\.disabled=!done\|\|analyzing;\}/);
});

test("registration finish closes only when saved; no unsaved AI or meeting action is sent",()=>{
 assert.match(tabs,/\$\("lc-stage-register"\)\?\.addEventListener\("click"/);
 assert.match(tabs,/if\(analyzing\|\|active!=="analysis"\|\|!row\?\.companyId\|\|progress\?\.steps\?\.analysis\?\.state!=="done"\)return/);
 assert.match(tabs,/dialog\.close\(\);\s*window\.dispatchEvent\(new CustomEvent\("sales:company-registration-complete"/);
 assert.match(tabs,/\$\("lc-stage-next"\)\?\.addEventListener\("click",\(\)=>select\("proposal"\)\)/);
 assert.match(list,/window\.addEventListener\("sales:company-registration-complete"/);
 assert.match(list,/void load\(true\)\.then/);
 assert.match(list,/商談は企業一覧から後日開始できます/);
});

test("AI analysis result is saved by API before completion options become visible",()=>{
 assert.match(tabs,/API\.api\("\/api\/sales\/company-ai-single"/);
 assert.match(tabs,/if\(result\?\.ok!==true\)throw Error/);
 assert.match(tabs,/await loadProgress\(\)/);
});
