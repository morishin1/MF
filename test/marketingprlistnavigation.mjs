// Executes the real page script against a minimal DOM, with synthetic GET responses only.
// This verifies state/event behavior, not CSS geometry or browser rendering.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const html=read('marketing/index.html');
let checks=0;const check=(v,label)=>{assert.ok(v,label);checks++;console.log('ok',label);};
const nodes=new Map(),docEvents={},winEvents={};let document;
class Element{
 constructor(tag,raw=''){this.tagName=tag.toUpperCase();this.attrs={};this.dataset={};this.listeners={};this.children=[];this.value='';this.textContent='';this.hidden=/\bhidden(?:\s|>|$)/.test(raw);this.open=false;this.disabled=/\bdisabled(?:\s|>|$)/.test(raw);this.classList={toggle(){}};this.style={};for(const m of raw.matchAll(/([\w-]+)="([^"]*)"/g))this.setAttribute(m[1],m[2]);}
 setAttribute(k,v){this.attrs[k]=String(v);if(k==='id'){this.id=v;nodes.set(v,this);}if(k==='class')this.className=v;if(k==='value')this.value=v;if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=v;}
 getAttribute(k){return this.attrs[k];}
 set innerHTML(value){this._html=value;this.children=[];for(const m of value.matchAll(/<(button|option|div|span|p|article)\b([^>]*)>/g)){const n=new Element(m[1],m[2]);n.parentElement=this;this.children.push(n);}}
 get innerHTML(){return this._html||'';}
 get options(){return this.children.filter(x=>x.tagName==='OPTION');}
 addEventListener(k,fn){(this.listeners[k]||=[]).push(fn);}
 fire(k,event){for(const fn of this.listeners[k]||[])fn(event);}
 appendChild(n){this.children.push(n);}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=[...children];this._html='';}
 querySelectorAll(selector){if(this.id==='marketing-primary-tabs')return primaryTabs;return this.children.filter(x=>selector==='[role="tab"]'?x.attrs.role==='tab':false);}
 focus(){document.activeElement=this;}
 scrollIntoView(){}
 closest(selector){if(selector==='#wrap')return nodes.get('wrap');if(selector==='button[data-site]'&&'site'in this.dataset)return this;if(selector==='button[data-page]'&&'page'in this.dataset)return this;if(selector==='[data-marketing-step]'&&this.dataset.marketingStep)return this;return null;}
 click(){if(this.disabled)return;for(const fn of docEvents.click||[])fn({target:this});}
}
for(const m of html.matchAll(/<([a-z][a-z\d]*)\b([^>]*\bid="[^"]+"[^>]*)>/gi))new Element(m[1],m[2]);
const primaryTabs=[...nodes.values()].filter(n=>n.id?.startsWith('mkt-tab-'));
const primaryPanels=[...nodes.values()].filter(n=>n.id?.startsWith('mkt-panel-'));
const location={pathname:'/marketing/',search:'?step=dashboard&biz=mugen'};
const urls=[location.pathname+location.search];let cursor=0;
const setLocation=url=>{const u=new URL(url,'https://test.invalid');location.pathname=u.pathname;location.search=u.search;};
const history={pushState(a,b,url){urls.splice(++cursor);urls.push(url);setLocation(url);},replaceState(a,b,url){urls[cursor]=url;setLocation(url);}};
document={activeElement:null,getElementById:id=>nodes.get(id)||null,createElement:tag=>new Element(tag),querySelectorAll:s=>s.startsWith('#marketing-primary-tabs')?primaryTabs:s==='.mkt-primary-panel'?primaryPanels:[],addEventListener(k,fn){(docEvents[k]||=[]).push(fn);},dispatchEvent(e){for(const fn of docEvents[e.type]||[])fn(e);}};
const items=Array.from({length:45},(_,i)=>({key:'site_news:'+i,origin:'site_news',biz:'site',medium:'column',mediumLabel:'コラム',title:'記事'+i,state:{key:'drafting',label:'作成中'}}));items.push({key:'plan:1',version:1,origin:'plan',biz:'mugen',medium:'sns',mediumLabel:'SNS',title:'企画',state:{key:'review',label:'確認待ち'}});
const production={sources:[{key:'site_news',biz:'site',label:'記事',state:'ok',count:45},{key:'plan',biz:null,label:'企画',state:'ok',count:1},{key:'mugen_contents',biz:'mugen',label:'原本',state:'not_connected'},{key:'space_articles',biz:'space',label:'原本',state:'forbidden'}],items,employees:[]};
const calls=[];let mounts=0,init;
const context={document,location,history,URLSearchParams,Date,console,crypto:{randomUUID:()=>''},navigator:{},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},addEventListener(k,fn){(winEvents[k]||=[]).push(fn);}};context.window=context;
context.API={api:async(path,options={})=>{calls.push({path,method:options.method||'GET'});if(options.method&&options.method!=='GET')throw Error('write forbidden');return path.includes('view=production')?production:{sources:[],items:[],openCount:0};}};
context.MarketingLayout={esc:s=>String(s??''),fmt:s=>s||'',fmtDay:s=>s||'',pill:s=>String(s),init:()=>({then:fn=>{init=fn;}})};
context.MarketingHandoffDashboard={renderSplit(){}};context.MarketingOmniDashboard={render(){}};context.MarketingHandoffSites={render(){}};context.MarketingDashboardUI={render(){}};context.MarketingHandoffComposer={mount(){mounts++;}};context.MarketingManualShare={render(){}};
vm.createContext(context);vm.runInContext(read('js/marketing-pr-list.js'),context);
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1].replace('  O.init({ active:', '  window.__listTest={S,selectPrimaryStep,renderProd,renderAll,selectProdSite,productionInputs,rememberProdInput,restoreProdInputs,acknowledgeProdInput,prodInputConflict,savePlan,get primary(){return primaryStep;}};\n  O.init({ active:');
vm.runInContext(script,context);context.MarketingOverviewCharts={render(){}};vm.runInContext(read('js/marketing-handoff-dashboard.js'),context);init({});await new Promise(setImmediate);
const api=context.__listTest;
const visible=()=>primaryPanels.filter(x=>!x.hidden).map(x=>x.id).join();
const rows=()=>[...nodes.get('prodList').innerHTML.matchAll(/<article\b/g)].length;
check(mounts===1&&visible()==='mkt-panel-dashboard','initialization mounts composer once and dashboard only');
check(rows()===20,'initial production rendering is bounded');
nodes.get('mkt-tab-list').click();check(visible()==='mkt-panel-list'&&api.S.listSite==='','new list independent from dashboard biz');
check(primaryTabs.filter(t=>t.tabIndex===0).length===1,'one primary tab stop');
api.selectProdSite('site');check(rows()===20&&location.search.includes('prSite=site'),'site event filters and updates URL');
let next=nodes.get('prodPagination').children.find(x=>x.dataset.page==='2');nodes.get('prodPagination').fire('click',{target:next});
check(api.S.listPage===2&&rows()===20&&location.search.includes('prPage=2'),'pagination click updates state and history');
next=nodes.get('prodPagination').children.find(x=>x.dataset.page==='3');nodes.get('prodPagination').fire('click',{target:next});
check(rows()===5&&api.S.listPage===3,'last page bounded');
api.selectProdSite('space');check(rows()===0&&nodes.get('prodList').innerHTML.includes('0件という意味ではありません'),'forbidden source gets unknown empty state');
api.selectProdSite('mugen');check(rows()===1&&api.S.listPage===1,'site resets pagination');
setLocation(urls[--cursor]);for(const fn of winEvents.popstate)fn();check(api.S.listSite==='space'&&visible()==='mkt-panel-list','Back restores site');
setLocation(urls[++cursor]);for(const fn of winEvents.popstate)fn();check(api.S.listSite==='mugen','Forward restores site');
api.selectProdSite('');check(location.search.includes('prSite=')&&api.S.biz==='mugen','all site explicitly serialized with unrelated biz');
for(const fn of winEvents.popstate)fn();check(api.S.listSite==='','all site retained on restore');
api.selectProdSite('space');nodes.get('pMedium').value='youtube';nodes.get('pState').value='published';nodes.get('pOwner').value='unknown';
const walk=node=>[node,...node.children.flatMap(child=>walk(child))];
const ongoing=walk(nodes.get('marketing-home-charts')).find(node=>node.className==='mkh-work-row');
check(ongoing,'actual dashboard renderer creates an ongoing PR action');ongoing.onclick();
check(api.S.listSite==='mugen'&&rows()===1&&nodes.get('pMedium').value===''&&nodes.get('pState').value===''&&nodes.get('pOwner').value==='','dashboard drilldown resets filters and targets its site');
const ec=nodes.get('pr-site-ec');ec.focus();nodes.get('prodSiteTabs').fire('keydown',{key:'ArrowRight',preventDefault(){}});
check(api.S.listSite===''&&document.activeElement.id==='pr-site-all','site keyboard wrapping and focus');
nodes.get('pr-site-all').focus();nodes.get('prodSiteTabs').fire('keydown',{key:'End',preventDefault(){}});check(api.S.listSite==='ec','site End');
nodes.get('mkt-tab-pr').click();check(visible()==='mkt-panel-pr'&&!nodes.get('mk-worklist').open,'creation does not force-open inquiries');
nodes.get('mkt-tab-pr').focus();nodes.get('marketing-primary-tabs').fire('keydown',{key:'End',preventDefault(){}});check(visible()==='mkt-panel-analytics'&&document.activeElement.id==='mkt-tab-analytics','primary keyboard End');
const conflictMessage={innerHTML:''},saveButton={dataset:{pa:'saveText'},disabled:false};
const article={dataset:{key:'plan:1'},querySelector:()=>conflictMessage,querySelectorAll:()=>[saveButton]};
const publicInput={dataset:{f:'publicUrl'},value:'https://example.invalid/unsaved',checked:false,closest:selector=>selector==='.mk-item'?article:null};
api.rememberProdInput(publicInput);publicInput.value='';
const oldQuery=nodes.get('prodList').querySelectorAll;
nodes.get('prodList').querySelectorAll=()=>[publicInput];api.restoreProdInputs();
check(publicInput.value==='https://example.invalid/unsaved','unsaved row value restores after redraw');
publicInput.value='https://example.invalid/newer';api.rememberProdInput(publicInput);
api.acknowledgeProdInput('plan:1','publicUrl','https://example.invalid/unsaved',2,1);
check(api.productionInputs.size===1,'late save cannot clear newer unsaved row input');
api.acknowledgeProdInput('plan:1','publicUrl',publicInput.value,3,2);check(api.productionInputs.size===0,'only exact saved row value cleared');
publicInput.value='競合前の入力';api.rememberProdInput(publicInput);
const plan=api.S.prod.items.find(item=>item.key==='plan:1');plan.version=2;
api.restoreProdInputs();
check(api.prodInputConflict(plan)&&saveButton.disabled&&conflictMessage.innerHTML.includes('原本が更新'),'new server version preserves draft but blocks mutation');
publicInput.value='競合後に入力';api.rememberProdInput(publicInput);
check(api.prodInputConflict(plan),'typing after refresh cannot silently rebase edit version');
const beforeConflictSave=calls.length;await api.savePlan(plan,{summary:'古い文案'},article);
check(calls.length===beforeConflictSave,'conflicted row save sends no API request');
const discard={dataset:{pa:'discardDraft'},closest:selector=>selector==='button[data-pa]'?discard:selector==='.mk-item'?article:null};
nodes.get('prodList').fire('click',{target:discard});
check(api.productionInputs.size===0,'explicit discard clears only the conflicting row draft');
api.productionInputs.clear();plan.version=3;publicInput.value='保存中の新しい入力';api.rememberProdInput(publicInput);
api.acknowledgeProdInput(plan.key,'publicUrl',publicInput.value,2,1);
check(api.productionInputs.size===1&&api.prodInputConflict({...plan,version:2}),'old same-value acknowledgement cannot erase newer-version edit');
api.acknowledgeProdInput(plan.key,'publicUrl','先に送った入力',4,3);plan.version=4;
check(!api.prodInputConflict(plan)&&api.productionInputs.size===1,'only own successful CAS rebases newer unsaved input');
plan.version=5;check(api.prodInputConflict(plan),'later external version still conflicts');api.productionInputs.clear();
const confirmation={dataset:{f:'vpublic'},value:'on',checked:true,closest:()=>article};api.rememberProdInput(confirmation);
check(api.productionInputs.size===0,'publication consent never carried across redraw');
nodes.get('prodList').querySelectorAll=oldQuery;
check(mounts===1,'navigation never remounts composer');
check(calls.length===2&&calls.every(x=>x.method==='GET'),'all navigation uses only initial synthetic GETs');
console.log(`${checks} marketing list real-page VM navigation checks passed (not rendered-browser verification)`);
