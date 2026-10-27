// 一覧の状態・社内メモ。全通信は架空データのモック（実応募者・送信なし）。
import { launch, BASE } from '../_browser.mjs';
import assert from 'node:assert/strict';
const br = await launch();
let count = 0;
const check = (value, label) => { assert.ok(value, label); console.log('  ok', label); count++; };
const ME = { email:'hr@example.test', appRole:'admin', isAdmin:true, shows:{}, gw:{ employee:{id:'e1',display_name:'架空担当'},roles:['owner'],isAdmin:true,tenantId:'t1',stage:null } };
const OPTIONS = [{key:'todo',label:'未対応'},{key:'scheduling',label:'日程調整中'},{key:'eval_pending',label:'評価入力待ち'}];
const ctx = await br.newContext({viewport:{width:1440,height:1000}});
const page = await ctx.newPage();
const errors = [], calls = [];
page.on('pageerror', e => errors.push(String(e)));
await ctx.addInitScript(() => localStorage.setItem('kp_session', JSON.stringify({access_token:'fake',email:'hr@example.test'})));
const a = { id:'fixture-a1',name:'架空候補者',jobTitle:'テスト職種',source:'Wantedly',stage:'applied',stageLabel:'新規応募',status:'todo',statusLabel:'未対応',listTab:'active',nextAction:'システムの次の案内',nextActionKey:'schedule',note:'既存の社内メモ',overdue:true,decisionDueOn:'2026-01-01',alerts:[{key:'overdue',level:'danger',label:'期限超過'}] };
let failSave = false, holdGet = null, delayedSave = null;
await ctx.route('**/*', async route => {
  const req = route.request(), url = new URL(req.url());
  if (!['127.0.0.1','localhost'].includes(url.hostname)) return route.abort();
  if (!url.pathname.startsWith('/api/')) return route.continue();
  const send = (body, status=200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if (url.pathname === '/api/me') return send(ME);
  if (url.pathname === '/api/hr/applicants/detail') {
    if (req.method() === 'GET') {
      if (holdGet) { const gate = holdGet; holdGet = null; await gate; }
      return send({applicant:a,statusOptions:OPTIONS,interviews:[],offers:[],timeline:[]});
    }
    const body = JSON.parse(req.postData() || '{}'); calls.push(body);
    if (body.dryRun) return send({dryRun:true,from:a.statusLabel,to:OPTIONS.find(x=>x.key===body.status)?.label,warnings:['面談予定は変更されません。']});
    if (delayedSave) { const gate = delayedSave; delayedSave = null; await gate; }
    if (failSave) return send({error:'fixture_failure',hint:'保存に失敗しました（テスト）'},500);
    if ('note' in body) a.note = body.note;
    if (body.completeCurrentAction) { a.decisionDueOn=body.nextDecisionDueOn; a.overdue=Boolean(body.nextDecisionDueOn && body.nextDecisionDueOn < '2026-10-27'); a.alerts=a.overdue?[{key:'overdue',level:'danger',label:'期限超過'}]:[]; }
    if (body.status) { a.status = body.status; a.statusLabel = OPTIONS.find(x=>x.key===body.status)?.label; }
    return send({applicant:a});
  }
  if (url.pathname === '/api/hr/applicants') return send({applicants:[a],employees:[],leadReady:true});
  if (req.method() !== 'GET') { calls.push({unexpected:url.pathname}); return send({error:'unexpected'},400); }
  return send({notifications:[],unread:0,badges:{},talents:[]});
});
const saved = () => calls.filter(x=>!x.dryRun);
const openNote = async () => { await page.locator('.hr-list-note').click(); await page.locator('#list-note').waitFor(); };
const cancel = async () => { await page.locator('#hr-modal-root').getByRole('button',{name:'キャンセル'}).click(); };
try {
  await page.goto(`${BASE}/hr/applicants.html`);
  await page.locator('.hr-list-status').waitFor();
  check(await page.locator('.hr-list-status').inputValue() === 'todo','期限超過バッジと実statusを区別');
  check(await page.locator('#rows').innerText().then(t=>t.includes('期限超過') && t.includes('システムの次の案内')),'期限警告とNEXTが見える');
  check(!await page.locator('.hr-list-status option[value="accepted"],.hr-list-status option[value="done"],.hr-list-status option[value^="offer_"]').count(),'承諾・完了・通知状態を手動選択しない');
  await page.locator('.hr-list-status').selectOption('scheduling');
  await page.locator('#list-status-ack').waitFor();
  check(!await page.locator('#list-complete').isChecked() && await page.locator('#list-next-due').isDisabled(),'対応完了は初期OFF・次期限は無効');
  check(calls.length===1 && calls[0].dryRun===true && calls[0].action==='setStatus','選択だけではdryRunのみ');
  check(await page.locator('#hr-detail-box').count()===0,'選択操作で詳細を開かない');
  await page.locator('#list-edit-save').click();
  check(saved().length===0,'警告未確認の保存を拒否');
  await page.locator('#list-status-ack').check();
  await page.locator('#list-edit-save').click();
  await page.waitForFunction(()=>!document.querySelector('#list-edit-save'));
  await page.waitForFunction(()=>document.querySelector('.hr-list-status').value==='scheduling');
  check(JSON.stringify(saved()[0])===JSON.stringify({id:a.id,action:'setStatus',status:'scheduling',acknowledgeWarnings:true}),'本保存はstatusだけと警告確認');
  check(a.note==='既存の社内メモ' && a.nextAction==='システムの次の案内','状態保存でメモ・NEXTを上書きしない');
  check((await page.locator('#rows').innerText()).includes('期限超過'),'状態保存後も期限警告を維持');
  await openNote();
  check(await page.locator('#list-note').inputValue()==='既存の社内メモ','既存の応募者メモを取得');
  check(await page.locator('#list-note').getAttribute('maxlength')==='2000','2000文字の制限');
  await page.locator('#list-note').fill('キャンセルする下書き'); await cancel();
  check(saved().length===1 && a.note==='既存の社内メモ','キャンセルは保存なし');
  let release; holdGet = new Promise(r=>release=r);
  await page.locator('.hr-list-note').click(); await cancel(); release();
  await page.waitForTimeout(150);
  check(await page.locator('#list-note').count()===0,'閉じたあと遅延GETで編集画面が復活しない');
  await openNote();
  const malicious = '<img src=x onerror="window.__xss=1">\n内部だけのメモ';
  await page.locator('#list-note').fill(malicious); failSave=true;
  await page.locator('#list-edit-save').click();
  await page.locator('#list-edit-msg').filter({hasText:'保存に失敗'}).waitFor();
  check(await page.locator('#list-note').inputValue()===malicious,'失敗後もメモ入力を保持');
  failSave=false;
  let releaseSave; delayedSave=new Promise(r=>releaseSave=r);
  const before=saved().length;
  await page.evaluate(()=>{const b=document.querySelector('#list-edit-save');saveListEdit(b);saveListEdit(b);});
  await page.waitForFunction(()=>document.querySelector('#list-edit-save').disabled);
  await page.waitForTimeout(100);releaseSave();
  await page.waitForFunction(()=>!document.querySelector('#list-edit-save'));
  check(saved().length===before+1,'保存中の二度押しは1回だけ');
  check(JSON.stringify(saved().at(-1))===JSON.stringify({id:a.id,note:malicious}),'メモ保存はidとnoteだけ');
  await page.locator('.hr-list-note-text').filter({hasText:'内部だけのメモ'}).waitFor();
  check(await page.evaluate(()=>!window.__xss) && await page.locator('#rows img').count()===0,'メモのHTMLを実行しない');
  await page.reload();await page.locator('.hr-list-note-text').waitFor();
  check((await page.locator('.hr-list-note-text').innerText()).includes('内部だけのメモ'),'リロード後も保存したメモを表示');
  await openNote(); await page.locator('#list-note').fill('');await page.locator('#list-edit-save').click();
  await page.waitForFunction(()=>!document.querySelector('#list-edit-save'));
  check(saved().at(-1).note==='' && a.note==='','空メモの保存で削除可能');
  // Explicit completion removes only the finished deadline, with a nullable next one.
  for (const [target,date] of [['todo','2030-01-01'],['scheduling','']]) {
    const previousStatus=a.status,previousDue=a.decisionDueOn;
    await page.locator('.hr-list-status').selectOption(target);await page.locator('#list-complete').waitFor();
    await page.locator('#list-status-ack').check();await page.locator('#list-complete').check();
    check(await page.locator('#list-next-due').isEnabled(),'対応完了で次期限入力を有効化');
    await page.locator('#list-next-due').fill(date);
    failSave=true;await page.locator('#list-edit-save').click();
    await page.locator('#list-edit-msg').filter({hasText:'保存に失敗'}).waitFor();
    check(await page.locator('#list-complete').isChecked() && await page.locator('#list-next-due').inputValue()===date,'失敗時も完了チェック・次期限を保持');
    failSave=false;
    let releaseCompletion;delayedSave=new Promise(r=>releaseCompletion=r);
    await page.locator('#list-edit-save').click();
    check(await page.locator('#list-complete').isDisabled() && await page.locator('#list-next-due').isDisabled() && await page.locator('#list-status-ack').isDisabled(),'保存中は期限・警告の全入力を無効化');
    releaseCompletion();await page.waitForFunction(()=>!document.querySelector('#list-edit-save'));
    await page.waitForFunction(status=>document.querySelector('.hr-list-status').value===status,target);
    const write=saved().at(-1);
    check(write.completeCurrentAction===true && write.expectedStatus===previousStatus && write.expectedDecisionDueOn===previousDue && write.nextDecisionDueOn===(date||null),'完了payloadに期待状態・元期限・次期限を送る');
    check(!(await page.locator('#rows').innerText()).includes('期限超過'),'完了後の未来日・期限なしでは期限超過を表示しない');
  }
  await page.setViewportSize({width:390,height:844});await openNote();
  const box=await page.locator('#hr-modal-root .hr-modal').boundingBox();
  check(box.x>=0 && box.x+box.width<=390,'390pxで編集モーダルが画面内');
  await cancel();
  check(calls.every(x=>!x.unexpected),'メール等の別エンドポイントを呼ばない');
  check(errors.length===0,`ブラウザ実行エラーなし: ${errors.join(';')}`);
  console.log(`${count}/${count} HR list edit checks PASS`);
} finally { await ctx.close();await br.close(); }
