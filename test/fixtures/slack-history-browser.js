// Synthetic browser fixture for the retired inbox route's replacement.
import {accessOf} from '../../lib/gw.js';
export function historyFixture(overrides={}) {
 return {history:[{id:'synthetic-history',department:'hr',summary:'架空の業務まとめ',sent_at:'2026-10-29T03:00:00Z',slack_permalink:'https://8grp.slack.com/archives/C0CCSBTDB1S/p1793242800000000',coverage_status:'complete',coverage_note:null,period_start:'2026-10-28T23:00:00Z',period_end:'2026-10-29T03:00:00Z'}],ready:true,status:200,gate:null,gets:0,calls:[],errors:[],...overrides};
}
export async function openHistory(browser,base,fx,width=1280) {
 const context=await browser.newContext({viewport:{width,height:900},timezoneId:'Asia/Tokyo'}),page=await context.newPage();
 page.on('pageerror',e=>fx.errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('kp_session',JSON.stringify({access_token:'synthetic',email:'fixture@example.test'})));
 await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort());
 await page.route('**/api/**',async route=>{
  const req=route.request(),url=new URL(req.url());fx.calls.push({path:url.pathname,method:req.method()});
  const send=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(req.method()!=='GET')return send({error:'unexpected_write'},500);
  if(url.pathname==='/api/me')return send({email:'fixture@example.test',appRole:'member',gw:{employee:{id:'e-fixture',display_name:'確認担当'},roles:['recruiter'],tenantId:'t-fixture'},access:accessOf({roles:['recruiter']})});
  if(url.pathname==='/api/slack-history'){
   fx.gets++;if(url.searchParams.get('department')!=='hr')return send({error:'unexpected_department'},500);
   const snapshot={history:structuredClone(fx.history),ready:fx.ready},status=fx.status,gate=fx.gate;
   if(gate)await gate.promise;
   return send(status===200?snapshot:{error:status===503?'not_ready':'failed'},status);
  }
  return send({});
 });
 await page.goto(base+'/hr/inbox.html');
 return {context,page};
}
export const deferred=()=>{let release;const promise=new Promise(resolve=>{release=resolve;});return {promise,release};};
