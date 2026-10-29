import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const pages=['nippo.html','calendar.html','timecard.html','tasks.html','schedule.html','work-week.html','team-schedule.html'];
for(const path of pages) {
 const html=read(path);
 assert.match(html,/src="(?:\/)?js\/layout-marketing\.js"/,path);
 assert.doesNotMatch(html,/src="[^"]*js\/layout\.js/,path);
}
const ctx={window:{},location:{pathname:'/home.html',hash:''},console};
vm.createContext(ctx);
vm.runInContext(read('js/layout-marketing.js').replace('  window.KPLayout = {','window.__entry={showsFor,shortcutsHtml}; window.KPLayout = {'),ctx);
for(const source of [
 {appRole:'member',access:{marketing:true}},
 {appRole:'member',access:{marketing:false}},
 {appRole:'member',access:{}},
 {appRole:'sr',access:{marketing:true}}
]) {
 const shows=ctx.window.__entry.showsFor(source);
 const expected=source.appRole!=='sr'&&Boolean(source.access.marketing);
 assert.equal(shows.marketing,expected);
 assert.equal(ctx.window.__entry.shortcutsHtml(shows).includes('data-shortcut="marketing"'),expected);
}
console.log('Seven employee pages: explicit grant only, no missing legacy entry PASS');
