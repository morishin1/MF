// Actual browser with synthetic API replies; never invokes an AI provider or production data.
import assert from 'node:assert/strict';import {launch,BASE} from '../_browser.mjs';
const br=await launch();
try{for(const width of [1280,390]){
 const page=await br.newPage({viewport:{width,height:900}}),writes=[],errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.addInitScript(()=>{localStorage.setItem('kp_session',JSON.stringify({access_token:'fixture',email:'fixture@example.test'}));localStorage.setItem('kp_layout',JSON.stringify({appRole:'member',name:'架空',shows:{},stage:null}));});
 await page.route('**/api/**',async route=>{const u=new URL(route.request().url()),req=route.request(),send=b=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(b)});
  if(u.pathname==='/api/me')return send({email:'fixture@example.test',appRole:'member',shows:{},gw:{employee:{id:'self',display_name:'架空',status:'active'},roles:[],tenantId:'t'}});
  if(u.pathname==='/api/career/me')return send({career:null,growthHistory:[]});
  if(u.pathname==='/api/career/plan'){if(req.method()==='GET')return send({plan:{actions:[]},revision:0,coachReady:true,turns:[]});const b=req.postDataJSON();writes.push(b);if(b.action==='save')return send({plan:b.plan,revision:1});return send({turn:{id:'turn',question:b.question,status:'done',advice:{reply:'目標を小さな行動にしましょう。',questions:[],proposal:{oneYear:'提案を担当する',ninetyDays:'資料を1つ作る',learning:'ヒアリング'},actions:['振り返りを10分書く']}}});}
  return send({notifications:[],unread:0});
 });
 await page.goto(`${BASE}/career.html`);await page.locator('[data-editor]').waitFor();await page.locator('#cs-oneYear').fill('自分で考えた目標');await page.locator('[data-save]').click();await page.getByText('計画を保存しました。',{exact:true}).waitFor();assert.equal(writes[0].plan.oneYear,'自分で考えた目標');await page.locator('[data-coach]').click();assert.equal(writes.filter(b=>b.action==='coach').length,0);await page.locator('#cs-question').fill('今週の行動を考えたい');await page.locator('[data-send]').click();await page.locator('[data-use="oneYear"]').waitFor();await page.locator('[data-use="oneYear"]').click();assert.equal(writes.filter(b=>b.action==='save').length,1,'proposal is not auto-saved');await page.locator('[data-close]').click();assert.equal(await page.locator('#cs-oneYear').inputValue(),'提案を担当する');await page.locator('[data-step="2"]').click();assert.ok(await page.locator('[data-add]').isVisible());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);page.on('dialog',d=>d.accept());await page.close();
 }}finally{await br.close();}
console.log('PASS career browser: self-edited goals, explicit AI call and adoption, no auto-save, 3 steps and responsive width');
