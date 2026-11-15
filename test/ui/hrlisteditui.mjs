// 一覧の状態・社内メモ。全通信は架空データのモック（実応募者・送信なし）。
// 状態の変更は、一覧のプルダウン（旧 .hr-list-status）ではなく、
// 一覧の行 → 対応モーダル →「状態を変更する」→「対応状況だけを変更する」→ 確認ダイアログ、の導線になった。
// 確認ダイアログ（dryRun・警告確認・対応期限）以降は同じなので、そこは同じ検証を通す。
import { launch, BASE } from '../_browser.mjs';
import assert from 'node:assert/strict';
const br = await launch();
let count = 0;
const check = (value, label) => { assert.ok(value, label); console.log('  ok', label); count++; };
// 落ちても後続の検証を続け、最後に失敗として終了する（製品側の疑いを1件で止めず、残りの回帰も見るため）
const softFailures = [];
const soft = (value, label) => { if (value) { console.log('  ok', label); count++; } else { console.log('NG:', label); softFailures.push(label); } };
const ME = { email:'hr@example.test', appRole:'admin', isAdmin:true, shows:{}, gw:{ employee:{id:'e1',display_name:'架空担当'},roles:['owner'],isAdmin:true,tenantId:'t1',stage:null } };
const OPTIONS = [{key:'todo',label:'未対応'},{key:'scheduling',label:'日程調整中'},{key:'eval_pending',label:'評価入力待ち'}];
const ctx = await br.newContext({viewport:{width:1440,height:1000}});
const page = await ctx.newPage();
const errors = [], calls = [];
page.on('pageerror', e => errors.push(String(e)));
page.setDefaultTimeout(8000);
await ctx.addInitScript(() => { try { localStorage.setItem('kp_session', JSON.stringify({access_token:'fake',email:'hr@example.test'})); } catch { /* sandbox付きiframe */ } });
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
      // stepMoves：「状態を変更する」のフォームを開くために必要（無いと「変更できる状態を取得できませんでした」になる）
      return send({applicant:a,statusOptions:OPTIONS,interviews:[],offers:[],timeline:[],
        stepMoves:{options:[{key:'applied',label:'新規応募',state:'current'},{key:'casual_interview',label:'カジュアル面談',state:'allowed'}]}});
    }
    const body = JSON.parse(req.postData() || '{}'); calls.push(body);
    if (body.dryRun) return send({dryRun:true,from:a.statusLabel,to:OPTIONS.find(x=>x.key===body.status)?.label,warnings:['面談予定は変更されません。']});
    if (delayedSave) { const gate = delayedSave; delayedSave = null; await gate; }
    if (failSave) return send({error:'fixture_failure',hint:'保存に失敗しました（テスト）'},500);
    if (body.action==='saveNote' && body.expectedNote!==a.note) return send({error:'note_conflict',hint:'最新のメモを確認してください'},409);
    if ('note' in body) a.note = body.note.trim()||null;
    if (body.completeCurrentAction) { a.decisionDueOn=body.nextDecisionDueOn; a.overdue=Boolean(body.nextDecisionDueOn && body.nextDecisionDueOn < '2026-10-27'); a.alerts=a.overdue?[{key:'overdue',level:'danger',label:'期限超過'}]:[]; }
    if (body.status) { a.status = body.status; a.statusLabel = OPTIONS.find(x=>x.key===body.status)?.label; }
    return send({applicant:a});
  }
  if (url.pathname === '/api/hr/applicants') return send({applicants:[a],employees:[],leadReady:true});
  // 対応モーダルを開いたときの既読記録（{action:'read'}）だけは、書き込みとして数えない
  if (url.pathname === '/api/hr/applicant-state' && req.method() === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    if (body.action === 'read') return send({});
    calls.push({unexpected:url.pathname}); return send({error:'unexpected'},400);
  }
  if (req.method() !== 'GET') { calls.push({unexpected:url.pathname}); return send({error:'unexpected'},400); }
  return send({notifications:[],unread:0,badges:{},talents:[]});
});
const saved = () => calls.filter(x=>!x.dryRun);
const cancel = async () => { await page.locator('#hr-modal-root').getByRole('button',{name:'キャンセル'}).click(); };
const state = page.locator('#rows [data-current-state]');
const overdueIcon = page.locator('#rows .hr-clock.over');
// 対応モーダル →「状態を変更する」→「対応状況だけを変更する」まで進み、手動で選べる状態のプルダウンを出す
const openManualStatus = async () => {
  if (!await page.locator('#hr-detail-box.hr-work-modal').count()) await state.click();
  await page.locator('#hr-work-status').click();
  await page.locator('#action-root .hr-status-other').click();
  await page.locator('#work-status').waitFor();
};
const chooseStatus = async (target) => {
  await openManualStatus();
  await page.locator('#work-status').selectOption(target);
  await page.locator('#work-status-confirm').click();
};
const waitState = (label) => page.waitForFunction(l => document.querySelector('#rows [data-current-state]')?.textContent.trim() === l, label);
try {
  await page.goto(`${BASE}/hr/applicants.html`);
  await state.waitFor();
  // 期限超過は状態の表示を置き換えず、時計アイコン（.hr-clock.over）で別に出す
  check((await state.innerText()).trim() === '未対応' && await overdueIcon.count() === 1,'期限超過バッジと実statusを区別');
  check((await overdueIcon.getAttribute('aria-label')).includes('期限超過') && await page.locator('#rows .hr-list-cta').count() === 1,'一覧に期限警告とNEXTボタンが見える');
  // NEXT の案内文は一覧ではなく、NEXT を押して開く対応モーダルの「次にすること」に出る
  await page.locator('#rows .hr-list-cta').click();
  await page.locator('#hr-detail-box.hr-work-modal .hr-work-task').waitFor();
  check(await page.locator('.hr-work-task').innerText().then(t=>t.includes('システムの次の案内') && t.includes('対応期限：2026-01-01')),'対応モーダルにNEXTの案内と対応期限が見える');
  await openManualStatus();
  check(await page.locator('#work-status option[value="scheduling"]').count() === 1 && await page.locator('#work-status option[value="todo"]').count() === 0,'手動で選べるのは、いまと違う対応状況');
  check(!await page.locator('#work-status option[value="accepted"],#work-status option[value="done"],#work-status option[value^="offer_"]').count(),'承諾・完了・通知状態を手動選択しない');
  check(await page.locator('#work-status-confirm').isDisabled(),'選ぶまで確認へ進めない');
  check(calls.length===0,'プルダウンを開いただけでは何も送らない');
  await page.locator('#work-status').selectOption('scheduling');
  await page.locator('#work-status-confirm').click();
  await page.locator('#list-status-ack').waitFor();
  // 対応期限の変更は「対応期限も変更する（任意）」の折りたたみの中
  check(!await page.locator('#list-complete').isChecked() && await page.locator('#list-next-due').isDisabled(),'対応完了は初期OFF・次期限は無効');
  check(calls.length===1 && calls[0].dryRun===true && calls[0].action==='setStatus','選択だけではdryRunのみ');
  // 状態の変更は対応モーダルから行う導線になったので、「応募者詳細（.hr-detail）へは切り替わらない」ことを見る
  check(await page.locator('.hr-detail').count()===0 && await page.locator('#hr-detail-box.hr-work-modal').count()===1,'選択操作で詳細を開かない');
  await page.locator('#list-edit-save').click();
  check(saved().length===0,'警告未確認の保存を拒否');
  await page.locator('#list-status-ack').check();
  await page.locator('#list-edit-save').click();
  await page.waitForFunction(()=>!document.querySelector('#list-edit-save'));
  await waitState('日程調整中');
  check(JSON.stringify(saved()[0])===JSON.stringify({id:a.id,action:'setStatus',status:'scheduling',acknowledgeWarnings:true}),'本保存はstatusだけと警告確認');
  check(a.note==='既存の社内メモ' && a.nextAction==='システムの次の案内','状態保存でメモ・NEXTを上書きしない');
  check(await overdueIcon.count()===1,'状態保存後も期限警告を維持');
  // Inline note regressions are exercised below.
  // Explicit completion removes only the finished deadline, with a nullable next one.
  for (const [target,date] of [['todo','2030-01-01'],['scheduling','']]) {
    const previousStatus=a.status,previousDue=a.decisionDueOn;
    await chooseStatus(target);await page.locator('#list-status-ack').waitFor();
    await page.locator('#hr-modal-root summary').click();
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
    await waitState(OPTIONS.find(x=>x.key===target).label);
    const write=saved().at(-1);
    check(write.completeCurrentAction===true && write.expectedStatus===previousStatus && write.expectedDecisionDueOn===previousDue && write.nextDecisionDueOn===(date||null),'完了payloadに期待状態・元期限・次期限を送る');
    check(await overdueIcon.count()===0 && await page.locator('#rows .hr-clock').count()===0,'完了後の未来日・期限なしでは期限超過を表示しない');
  }
  // 対応モーダルを閉じて一覧へ戻る（開いている間、一覧は操作できない）
  await page.locator('#hr-detail-box .hr-work-heading').getByRole('button',{name:'閉じる'}).click();
  await page.waitForFunction(()=>!document.querySelector('#hr-detail-box'));
  const note=page.locator('.hr-inline-note'), noteState=page.locator(`#list-note-state-${a.id}`), controls=page.locator(`#list-note-controls-${a.id}`);
  const noteWrites=()=>calls.filter(x=>x.action==='saveNote');
  const awaitSaved=async()=>{await noteState.filter({hasText:'保存済み'}).waitFor();};
  const exitWarns=()=>page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;});
  check(await note.inputValue()==='既存の社内メモ' && await note.getAttribute('maxlength')==='2000','一覧に既存メモを直接表示・2000文字制限');
  await note.click();check(await page.locator('#hr-detail-box').count()===0&&await page.locator('#list-note').count()===0,'メモ入力で詳細・別モーダルを開かない');
  await note.fill('自動保存するメモ');await page.waitForTimeout(200);check(noteWrites().length===0,'入力直後はdebounce待ち');
  check(await exitWarns(),'未保存メモは離脱警告対象');
  await awaitSaved();check(JSON.stringify(noteWrites()[0])===JSON.stringify({id:a.id,action:'saveNote',note:'自動保存するメモ',expectedNote:'既存の社内メモ'}),'debounce保存はsaveNote CASのみ');
  check(!await exitWarns(),'保存済みメモは離脱を妨げない');
  await note.fill('blurで保存');await note.blur();await awaitSaved();check(a.note==='blurで保存','blurで待ち時間なく保存');
  const afterBlur=noteWrites().length;await page.waitForTimeout(750);check(noteWrites().length===afterBlur,'blurとdebounceは重複保存しない');
  await note.dispatchEvent('compositionstart');await note.evaluate(node=>{node.value='日本語変換中';node.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,inputType:'insertCompositionText',data:'日本語変換中'}));});await note.blur();await page.waitForTimeout(750);check(noteWrites().length===afterBlur,'IME入力中はblur/debounceでも送信なし');
  await page.locator('#q').fill('対象なしの検索');check(await note.count()===0,'検索で編集中の行を非表示にできる');
  await page.locator('#q').fill('');await note.waitFor();check(await note.inputValue()==='日本語変換中','検索から戻っても下書きを保持');
  // 製品側の疑い：textarea の oncompositionstart / oncompositionend 属性（hr/applicants.html listNoteCell）は
  // ブラウザのイベントハンドラ属性ではないため発火せず、IME確定後も composing が true のまま残って保存されない。
  // 検証は残す（製品が直れば通る）。
  await note.dispatchEvent('compositionend');
  const imeSaved=await noteState.filter({hasText:'保存済み'}).waitFor({timeout:3000}).then(()=>true,()=>false);
  soft(imeSaved&&a.note==='日本語変換中','IME確定後に保存');
  let releaseNote;delayedSave=new Promise(r=>releaseNote=r);
  await note.fill('先の版');await note.blur();await noteState.filter({hasText:'保存中'}).waitFor();
  const beforeQueue=noteWrites().length;await note.fill('新しい版');await note.blur();await page.waitForTimeout(750);
  check(noteWrites().length===beforeQueue && await exitWarns(),'保存中の追加入力は並列送信せず離脱警告');
  releaseNote();await awaitSaved();check(await note.inputValue()==='新しい版'&&a.note==='新しい版'&&noteWrites().at(-1).expectedNote==='先の版','古い応答で入力を戻さず次版を順次CAS保存');
  failSave=true;await note.fill('失敗しても残す');await note.blur();await controls.getByRole('button',{name:'再試行',exact:true}).waitFor();
  const failureWrites=noteWrites().length;await note.fill('失敗後も編集');await note.blur();await page.waitForTimeout(750);check(noteWrites().length===failureWrites&&await note.inputValue()==='失敗後も編集','失敗時の入力保持・自動再送なし');
  failSave=false;await controls.getByRole('button',{name:'再試行',exact:true}).click();await awaitSaved();check(a.note==='失敗後も編集','明示再試行は最新の入力を保存');
  a.note='別担当の最新';await note.fill('自分の競合下書き');await note.blur();await controls.getByRole('button',{name:'最新のメモを確認'}).waitFor();
  check(a.note==='別担当の最新'&&await note.inputValue()==='自分の競合下書き','競合で他担当メモを上書きせず入力保持');
  await controls.getByRole('button',{name:'最新のメモを確認'}).click();await controls.locator('.hr-note-latest').waitFor();
  check((await controls.locator('.hr-note-latest').innerText()).includes('別担当の最新'),'競合時に最新原文を表示');
  const beforeAdopt=noteWrites().length;await controls.getByRole('button',{name:'最新を採用（入力を破棄）'}).click();check(await note.inputValue()==='別担当の最新'&&noteWrites().length===beforeAdopt,'最新採用は入力差替えのみで書込みなし');
  a.note='別担当のさらに新しい版';await note.fill('明示上書きのメモ');await note.blur();await controls.getByRole('button',{name:'最新のメモを確認'}).click();await controls.getByRole('button',{name:'この入力で上書き'}).click();await awaitSaved();
  check(a.note==='明示上書きのメモ'&&noteWrites().at(-1).expectedNote==='別担当のさらに新しい版','明示上書きでも確認済み最新値のCASを使用');
  const malicious='</textarea><img src=x onerror="window.__xss=1">';await note.fill(malicious);await note.blur();await awaitSaved();await page.evaluate(()=>render());
  check(await note.inputValue()===malicious&&!await page.evaluate(()=>window.__xss)&&await page.locator('#rows img').count()===0,'textarea閉じタグを含むメモもHTML実行しない');
  await note.fill('');await note.blur();await awaitSaved();check(a.note===null,'空入力を自動保存してメモを削除');
  await page.reload();await note.waitFor();check(await note.inputValue()==='','リロード後も保存内容を維持');
  await page.setViewportSize({width:390,height:844});await note.scrollIntoViewIfNeeded();const noteBox=await note.boundingBox();
  // 製品側の疑い：現在の列構成では、390px（表は min-width:900px）で社内メモ欄が約61pxまで狭くなる
  // （hr/applicants.html の .hr-table th:nth-child(n) の幅指定が、登録日時・プロフィール列の追加後の並びとずれている）。検証は残す。
  soft(noteBox.width>80&&noteBox.width<=390,`390pxでも一覧textareaを操作できる幅（いま ${Math.round(noteBox.width)}px）`);
  check(calls.every(x=>!x.unexpected),'メール等の別エンドポイントを呼ばない');
  check(errors.length===0,`ブラウザ実行エラーなし: ${errors.join(';')}`);
  if (softFailures.length) { console.log(`\n${softFailures.length} 件 NG: ${softFailures.join(' / ')}`); process.exitCode = 1; }
  else console.log(`${count}/${count} HR list edit checks PASS`);
} finally { await ctx.close();await br.close(); }
