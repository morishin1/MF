// Local presentation-only regression: no browser or live APIs.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const code=read('js/marketing-pr-list.js'),page=read('marketing/index.html'),css=read('css/marketing-design-handoff.css');
const ctx={window:{}};vm.runInNewContext(code,ctx);const M=ctx.window.MarketingPRList;
let checks=0;const check=(v,label)=>{assert.ok(v,label);checks++;};
const state=q=>M.fromUrl(new URLSearchParams(q));
check(state('').step==='dashboard','default dashboard');
check(state('tab=production&biz=mugen').step==='list'&&state('tab=production&biz=mugen').site==='mugen','legacy production business link');
check(state('tab=work&biz=space').step==='pr'&&state('tab=work&biz=space').tab==='work','legacy inquiry link');
check(state('step=pr&tab=production').step==='pr','explicit creation link still creates');
check(state('step=list&biz=mugen').site==='','new list must not inherit unrelated dashboard filter');
check(state('step=list&biz=mugen&prSite=').site==='','all-sites survives reload with dashboard filter');
check(state('step=list&prSite=space&prPage=3').site==='space'&&state('step=list&prSite=space&prPage=3').page===3,'independent site and page deep-link');
for(const bad of ['-1','0','1.5','NaN','Infinity','9007199254740992'])check(state('prPage='+bad).page===1,'invalid page '+bad);
check(state('step=unknown&prSite=machi&biz=unknown').site===''&&state('step=unknown').step==='dashboard','unknown routes and unsupported site fail safe');
const prod={sources:[{key:'site_news',biz:'site',state:'ok'},{key:'plan',biz:null,state:'ok'},{key:'mugen_contents',biz:'mugen',state:'not_connected'},{key:'space_articles',biz:'space',state:'forbidden'},{key:'ec_sns',biz:'ec',state:'not_ready'}],items:[...Array.from({length:45},(_,i)=>({origin:'site_news',biz:'site',key:'news:'+i})),{origin:'plan',biz:'mugen',key:'plan:1'},{origin:'mugen_contents',biz:'mugen',key:'unavailable:1'}]};
check(M.items(prod,'site').length===45,'corporate source only');
check(M.items(prod,'mugen').length===1,'manual plan allowed but unavailable original excluded');
check(M.items(prod,'').length===46,'all authorized originals and plans');
check(M.availability(prod,'mugen').label==='1件・一部未取得','partial site not falsely complete');
check(M.availability(prod,'space').label==='権限なし','forbidden not zero');
check(M.availability(prod,'ec').label==='未準備','not ready not zero');
check(M.availability({...prod,items:[]},'mugen').label==='未接続','unconnected not zero even common plan store ready');
check(M.availability(null,'site').label==='未取得','unknown not zero');
for(const status of ['failed','not_ready','forbidden','on_hold','not_connected'])check(!M.availability({sources:[{key:'site_news',biz:'site',state:status}],items:[]},'site').label.includes('0件'),'state label '+status);
check(M.availability({sources:[{key:'site_news',biz:'site',state:'ok'}],items:[]},'site').label==='0件','confirmed zero allowed');
const rows=M.items(prod,'site');
for(const [request,expected,start,length] of [[1,1,0,20],[2,2,20,20],[3,3,40,5],[999,3,40,5],[0,1,0,20]]){const p=M.paginate(rows,request);check(p.page===expected&&p.start===start&&p.rows.length===length,'pagination '+request);}
check(M.paginate([],2).page===1&&M.paginate([],2).rows.length===0,'empty page clamps');
check(M.items(prod,'site').map(x=>x.key).join()===rows.map(x=>x.key).join(),'source order and input preserved');
check(M.sites.map(x=>x[0]).join(',')===',site,mugen,space,ec','only verified biz sites');
check(M.steps.join(',')==='dashboard,pr,distribution,list,analytics','five primary tab order');
check(!/\bfetch\(|API\.|localStorage|sessionStorage|service_role/.test(code),'helper never reads or writes services');
check(page.indexOf('id="mkt-tab-distribution"')<page.indexOf('id="mkt-tab-list"')&&page.indexOf('id="mkt-tab-list"')<page.indexOf('id="mkt-tab-analytics"'),'list primary between distribution and analytics');
const list=page.slice(page.indexOf('id="mkt-panel-list"'),page.indexOf('id="mkt-panel-analytics"'));
const create=page.slice(page.indexOf('id="mkt-panel-pr"'),page.indexOf('<div id="mk-modal-root"'));
check(list.includes('id="prodList"')&&!create.includes('id="prodList"'),'list removed from composer panel');
check(create.includes('id="mk-worklist"')&&create.includes('id="pane-work"'),'inquiry fold retained');
check(!page.includes('if(step==="pr") el("mk-worklist").open = true'),'creation no longer force-opens long worklist');
check(page.includes('q.set("prSite", S.listSite)')&&page.includes('PRList.fromUrl(q)'),'explicit all-site URL and popstate restoration');
check(page.includes('"ArrowLeft","ArrowRight","Home","End"')&&page.includes('aria-controls="prodList"'),'site keyboard navigation and semantics');
check(css.includes('button[aria-selected=true]{background:#fff')&&css.includes('button[aria-selected=true]:hover{background:#fff}'),'selected primary tab white including hover');
check(css.includes('.mkt-site-tabs{display:flex')&&css.includes('overflow-x:auto')&&css.includes('@media(max-width:620px)'),'mobile horizontal tab strip not page overflow');
const classified={sources:[{key:'site_news',state:'ok'},{key:'plan',state:'ok'}],items:[
 {key:'press',origin:'site_news',sourceKind:'プレスリリース',medium:'column'},
 {key:'col',origin:'site_news',sourceKind:'エイトコラム',medium:'column'},
 {key:'recruit',origin:'plan',sourceType:'site_news',sourceKind:'採用コラム',medium:'column'},
 {key:'unknown',origin:'plan',sourceType:'site_news',medium:'column'},
 {key:'manual',origin:'plan',medium:'column'},
 {key:'news',origin:'site_news',sourceKind:'お知らせ',medium:'column'},
 {key:'sns',origin:'plan',medium:'sns'}]};
check(M.items(classified,'','pr').map(x=>x.key).join()==='press','PR only explicit original press kind');
check(M.items(classified,'','column').map(x=>x.key).join()==='col,recruit,manual','columns use original kind or explicitly selected manual medium');
check(M.items(classified,'','other').map(x=>x.key).join()==='unknown,sns','unknown and other records retained, not relabeled PR');
check(M.items(classified,'','news').map(x=>x.key).join()==='news','company announcements have their own explicit kind');
check(M.items(classified,'','all').length===7,'all records retained without mutation');
check(state('contentType=column').category==='column'&&state('contentType=bogus').category==='all','category deep links validated');
check(M.availability(classified,'','pr').count===1,'category counts agree');
check(page.includes('../img/logo.svg')&&page.includes('PRList.siteIcons[key]'),'verified local corporate logo and icon/name fallback');
console.log(`${checks} marketing PR list model/static checks passed`);
