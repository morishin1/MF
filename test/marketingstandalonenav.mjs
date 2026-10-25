// Execute shared layout navigation logic in a VM; no browser, API or database calls.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../js/layout.js',import.meta.url),'utf8');
const context={window:{},location:{pathname:'/marketing/',hash:''},console};
vm.createContext(context);
vm.runInContext(source.replace('  window.KPLayout = {',`  window.__nav = {TOOLS, OFFICE_GROUPS, showsFor, shortcutsHtml, areaOf,
    renderProbe() { const calls=[]; clearChrome=()=>{}; renderTopbar=()=>calls.push('header');
      renderOfficeNav=()=>calls.push('office'); renderKeieiNav=()=>calls.push('keiei');
      renderAdminNav=()=>calls.push('admin'); renderMemberNav=()=>calls.push('member');
      renderSubnav=()=>calls.push('subnav'); soon=()=>{};
      renderChrome({name:'Test',appRole:'member',shows:{marketing:true,officeEntry:true}},'marketing');
      return calls;
    }};
  window.KPLayout = {`),context);
const nav=context.window.__nav;
let count=0;const check=(label,fn)=>{fn();count++;console.log('ok',label);};
check('one standalone Marketing tool beside existing tools',()=>{
 assert.equal(nav.TOOLS.filter(t=>t.key==='marketing').length,1);
 assert.equal(nav.TOOLS.find(t=>t.key==='marketing').href,'/marketing/');
 for(const key of ['hr','sales','office'])assert.ok(nav.TOOLS.some(t=>t.key===key));
});
check('Office categories contain no Marketing entry',()=>{
 assert.ok(!nav.OFFICE_GROUPS.some(g=>/marketing|mkt/i.test(g.key)||g.items.some(i=>/marketing/.test(i.key+i.href))));
});
check('Office permission does not imply Marketing',()=>{
 for(const appRole of ['member','admin','owner'])assert.equal(nav.showsFor({appRole,access:{office:true,officeApp:true,officeHr:true,officeFinance:true}}).marketing,false);
});
check('explicit Marketing only grant needs no Office grant',()=>{
 const shows=nav.showsFor({appRole:'member',access:{marketing:true,office:false,officeApp:false,officeHr:false,officeFinance:false}});
 assert.equal(shows.marketing,true);assert.equal(shows.officeEntry,false);
 const html=nav.shortcutsHtml(shows);assert.match(html,/href="\/marketing\/"/);assert.doesNotMatch(html,/data-shortcut="office"/);
});
check('missing false and adviser Marketing access fail closed',()=>{
 for(const me of [{appRole:'owner'},{access:{marketing:false}},{appRole:'sr',access:{marketing:true}}])assert.equal(nav.showsFor(me).marketing,false);
});
check('Marketing selected independently on home and intake routes',()=>{
 for(const path of ['/marketing','/marketing/','/marketing/inquiry-desk.html']){
  assert.equal(nav.areaOf('marketing',path),'marketing');
  const html=nav.shortcutsHtml({marketing:true,officeEntry:true},path,nav.areaOf('marketing',path));
  const links=html.match(/<a\b[^>]*>/g);
  assert.match(links.find(s=>s.includes('data-shortcut="marketing"')),/aria-current="page"/);
  assert.doesNotMatch(links.find(s=>s.includes('data-shortcut="office"')),/aria-current/);
 }
 assert.notEqual(nav.areaOf('marketing','/marketing-other/'),'marketing');
});
check('Office keeps own selected header',()=>{
 const links=nav.shortcutsHtml({marketing:true,officeEntry:true},'/office/','office').match(/<a\b[^>]*>/g);
 assert.match(links.find(s=>s.includes('data-shortcut="office"')),/aria-current/);
 assert.doesNotMatch(links.find(s=>s.includes('data-shortcut="marketing"')),/aria-current/);
});
check('Marketing renders shared header without Office or personal nav',()=>assert.deepEqual(Array.from(nav.renderProbe()),['header']));
console.log(`${count} standalone navigation checks passed (VM only; no browser)`);
