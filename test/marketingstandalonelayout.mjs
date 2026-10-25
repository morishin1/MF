import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const code=read('js/marketing-layout.js');let n=0;
const check=(x,label)=>{assert.ok(x,label);n++;console.log('ok',label)};
async function run(me,logged=true){let args=null;const classes=[];const ctx={window:null,API:{isLoggedIn:()=>logged},KPLayout:{init:async a=>{args=a;return me?{me}:null}},location:{href:''},document:{getElementById:()=>null,createElement:()=>({}),head:{appendChild(){}},body:{classList:{add(...a){classes.push(...a)}}},querySelectorAll:()=>[]}};ctx.window=ctx;vm.runInNewContext(code,ctx);return {layout:ctx.MarketingLayout,got:await ctx.MarketingLayout.init(),args,ctx,classes};}
for(const me of [{access:{office:true}},{access:{}},{appRole:'owner'},{appRole:'sr',access:{marketing:true}}]){const r=await run(me);check(!r.layout.allows(me)&&!r.got,'Office/role/missing/sr do not confer Marketing');}
let r=await run({access:{marketing:true,office:false}});check(r.got&&r.args.access==='marketing'&&r.args.active==='marketing','Marketing only accepted, dedicated access passed');
r=await run(null,false);check(!r.args&&r.ctx.location.href==='/index.html','signed out never invokes shell');
r=await run(null);check(!r.got,'denied/revoked shell returns null');
const page=read('marketing/index.html'),intake=read('marketing/inquiry-desk.html');
check(page.includes('["work", "production"].includes(q0.get("tab"))'),'legacy work and production query preserved');
check(!page.includes('window.OfficeLayout')&&!intake.includes('office-layout.js'),'no Office runtime dependency');
check(page.includes('tab: "production"')&&page.includes('効果計測は未実装・未接続'),'content first, gaps explicit');
for(const [old,target] of [['office/marketing.html','/marketing/'],['office/inquiry-desk.html','/marketing/inquiry-desk.html']]){const redirect=read(old);check(redirect.includes('location.replace("'+target+'" + location.search + location.hash)')&&!redirect.includes('/api/'),'fixed same-origin redirects preserve query/hash and never mutate');}
const expected={"api/marketing/index.js": "93478ea50f1e437dbc5025ee08f9799c91877bcdf68d82317bd89214634ee868", "api/marketing/intake.js": "2fd32a7264853390c5f2d25340d7114bd76e6a3aaaf06835686ba8e0b312b4f5", "lib/gw.js": "5161b3c7416759bc5f20b3d8c8601b702f3a871d53b1a91a60c8b77725efacd3", "lib/marketing-intake.js": "17c8aeaed33440f89919e53d1ff187779cf39eaf8781c9d019d120e96ec5422e", "lib/marketing-sources.js": "7778c8c22e90782c19402b43566cf066aa15a095d0d6bc48d32659d1f93edfb3", "db/proposal_marketing_intake.sql": "aa3454b91c079f427aa3afbef640f0753649fad9c30586663896d111104b38f7"};
check(read('api/marketing/index.js').includes('publishedOn: a.published_on || null') && read('api/marketing/index.js').includes('publishedOn: linked?.a?.published_on || null'), 'published dates retain existing site-news original, including linked plans');
for(const [p,hash] of Object.entries(expected)){check(createHash("sha256").update(read(p)).digest("hex")===hash,"unchanged source/permission/DB contract "+p);}
console.log(`${n} standalone layout checks passed (VM/static; no browser)`);
