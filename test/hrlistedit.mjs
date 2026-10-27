// Execute the actual list-editor functions in a minimal DOM harness. No live APIs.
// Complements test/ui/hrlisteditui.mjs; this is not browser layout verification.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const html=readFileSync(new URL('../hr/applicants.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('  function openHrModal('),html.indexOf('  function openBulkStatusModal('));
const statusSource=html.match(/  const STATUS_LABEL = \{[\s\S]*?\n  \};/)[0];
let checks=0; const check=(v,m)=>{assert.ok(v,m);console.log('  ok',m);checks++;};
const clone=x=>JSON.parse(JSON.stringify(x));
function harness() {
  const nodes={},inlineNodes={},listeners={},calls=[],timers=new Map(); let now=0, timerId=0;
  const esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const decode=x=>x.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&');
  const node=()=>({value:'',checked:false,textContent:'',disabled:false,classList:{toggle(){}},focus(){},setAttribute(){}});
  let markup='';
  const root={get innerHTML(){return markup},set innerHTML(s){markup=s;for(const k of Object.keys(nodes))delete nodes[k];for(const m of s.matchAll(/<[^>]*id="([^"]+)"[^>]*>/g)){nodes[m[1]]=node();nodes[m[1]].disabled=/\bdisabled\b/.test(m[0]);}const m=s.match(/<textarea[^>]*id="list-note"[^>]*>([\s\S]*?)<\/textarea>/);if(m)nodes['list-note'].value=decode(m[1]);},querySelector:()=>node(),querySelectorAll:()=>Object.values(nodes)};
  const a={id:'a1',name:'架空応募者',status:'todo',statusLabel:'未対応',note:'元のメモ',nextAction:'次のシステム案内',overdue:true,decisionDueOn:'2026-01-01'};
  const h={nodes,calls,a,root,fail:false,getGate:null,saveGate:null,loads:0,warnings:['面談は変更されません'],inFlight:0,maxInFlight:0,local:[clone(a)]};
  const context=vm.createContext({console,esc,el:id=>id==='hr-modal-root'?root:(nodes[id]||inlineNodes[id]),applicants:h.local,
    setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id),
    window:{addEventListener:(k,f)=>listeners[k]=f},document:{addEventListener:(k,f)=>listeners[k]=f},
    API:{async getHrApplicant(){if(h.getGate){const p=h.getGate;h.getGate=null;await p;}return {applicant:clone(a),statusOptions:[{key:'todo'},{key:'scheduling'}]};},
      async updateHrApplicant(b){calls.push(clone(b));if(b.dryRun)return {from:'未対応',to:'日程調整中',warnings:clone(h.warnings)};h.inFlight++;h.maxInFlight=Math.max(h.maxInFlight,h.inFlight);try{if(h.saveGate){const p=h.saveGate;h.saveGate=null;await p;}if(h.fail)throw new Error('保存失敗');if(b.action==='saveNote'&&b.expectedNote!==a.note)throw Object.assign(new Error('note_conflict'),{code:'note_conflict',status:409});if('note'in b)a.note=b.note.trim()||null;if(b.status)a.status=b.status;return {applicant:clone(a)};}finally{h.inFlight--;}}},
    KPLayout:{async busy(btn,label,fn){btn.disabled=true;try{return await fn()}finally{btn.disabled=false}}},load:async()=>{h.loads++;}});
  vm.runInContext(statusSource+'\n'+source,context);h.ctx=context;h.listeners=listeners;
  h.settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  h.tick=async(ms)=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn();}await h.settle();};
  h.mount=()=>{const cell=context.listNoteCell(h.local[0]);for(const suffix of ['','state-','controls-'])inlineNodes['list-note-'+suffix+a.id] ||= node();inlineNodes['note-save-summary'] ||= node();inlineNodes['list-note-'+a.id].value=context.noteEditor(h.local[0]).draft;return cell;};
  h.field=()=>inlineNodes['list-note-'+a.id];h.state=()=>context.noteEditor(h.local[0]);
  h.input=(value,event)=>{h.field().value=value;context.editListNote(a.id,h.field(),event);};h.inlineNodes=inlineNodes;return h;
}
{
 const h=harness();await h.ctx.openListEdit('a1','status','scheduling');
 check(h.calls.length===1&&h.calls[0].dryRun,'selection only performs dryRun');
 await h.ctx.saveListEdit(h.nodes['list-edit-save']);check(h.calls.length===1,'unacknowledged warning blocks save');
 h.nodes['list-status-ack'].checked=true;await h.ctx.saveListEdit(h.nodes['list-edit-save']);
 check(JSON.stringify(h.calls.filter(x=>!x.dryRun)[0])===JSON.stringify({id:'a1',action:'setStatus',status:'scheduling',acknowledgeWarnings:true}),'status-only explicit save payload');
 check(h.a.note==='元のメモ'&&h.a.nextAction==='次のシステム案内'&&h.a.overdue,'status preserves memo, NEXT and derived flags');
 check(h.loads===1&&h.root.innerHTML==='','successful save closes and reloads');
}
{
 const h=harness();for(const status of ['accepted','done','offer_sent'])await h.ctx.openListEdit('a1','status',status);check(h.calls.length===0&&h.root.innerHTML==='','workflow states cannot be edited through new control');
 const options=h.ctx.listStatusSelect(h.a);check(!options.includes('value="accepted"')&&!options.includes('value="offer_sent"'),'workflow-only states omitted from dropdown');
}
{
 const h=harness();await h.ctx.openListEdit('a1','status','scheduling');h.nodes['list-status-ack'].checked=true;h.warnings.push('新しい警告');await h.ctx.saveListEdit(h.nodes['list-edit-save']);
 check(h.calls.filter(x=>!x.dryRun).length===0 && h.nodes['list-edit-msg'].textContent.includes('確認内容が変わりました'),'new warning on second dryRun blocks write');
}
{
 for(const field of ['accepted','done','employee']) {
  const h=harness();if(field==='employee')h.a.employeeId='employee1';else h.a.status=field;
  check(h.ctx.listStatusSelect(h.a).includes('disabled'),'accepted/done/registered list control disabled: '+field);
  await h.ctx.openListEdit('a1','status','scheduling');check(h.calls.length===0,'fresh detail blocks protected state: '+field);
 }
}
{
 const h=harness();await h.ctx.openListEdit('a1','status','scheduling');
 check(!h.nodes['list-complete'].checked&&h.nodes['list-next-due'].disabled,'action completion is opt-in and next deadline initially disabled');
 h.nodes['list-next-due'].value='2030-01-01';h.nodes['list-status-ack'].checked=true;await h.ctx.saveListEdit(h.nodes['list-edit-save']);
 check(h.calls.every(x=>!('completeCurrentAction'in x)&&!('nextDecisionDueOn'in x)),'unchecked completion never sends a deadline even if date has a value');
}
{
 for(const date of ['', '2030-01-01']) {
  const h=harness();await h.ctx.openListEdit('a1','status','scheduling');h.nodes['list-status-ack'].checked=true;
  h.nodes['list-complete'].checked=true;h.ctx.toggleListDeadline();check(!h.nodes['list-next-due'].disabled,'completion enables next date input');
  h.nodes['list-next-due'].value=date;await h.ctx.saveListEdit(h.nodes['list-edit-save']);
  const expected={completeCurrentAction:true,expectedStatus:'todo',expectedDecisionDueOn:'2026-01-01',nextDecisionDueOn:date||null};
  const completionCalls=h.calls.filter(x=>x.completeCurrentAction);
  check(completionCalls.length===2&&completionCalls[0].dryRun===true&&!completionCalls[1].dryRun,'completion is sent on pre-save dryRun and final write');
  check(completionCalls.every(x=>Object.entries(expected).every(([key,value])=>x[key]===value)),'completion passes prior status/deadline and explicit next deadline: '+(date||'null'));
 }
}
{
 const h=harness();h.a.decisionDueOn=null;await h.ctx.openListEdit('a1','status','scheduling');h.nodes['list-status-ack'].checked=true;h.nodes['list-complete'].checked=true;h.ctx.toggleListDeadline();await h.ctx.saveListEdit(h.nodes['list-edit-save']);
 check(h.calls.filter(x=>x.completeCurrentAction).every(x=>x.expectedDecisionDueOn===null),'unset previous deadline sends explicit null expected value');
}
{
 const h=harness();await h.ctx.openListEdit('a1','status','scheduling');h.nodes['list-status-ack'].checked=true;h.nodes['list-complete'].checked=true;h.ctx.toggleListDeadline();h.nodes['list-next-due'].value='2030-01-01';h.fail=true;
 let release;h.saveGate=new Promise(r=>release=r);const p=h.ctx.saveListEdit(h.nodes['list-edit-save']);
 check(['list-status-ack','list-complete','list-next-due','list-edit-save'].every(id=>h.nodes[id].disabled),'all status form inputs disabled while saving');
 release();await p;
 check(h.nodes['list-complete'].checked&&h.nodes['list-next-due'].value==='2030-01-01'&&h.nodes['list-status-ack'].checked,'failure preserves completion, next date, and warning acknowledgment');
 check(['list-status-ack','list-complete','list-next-due','list-edit-save'].every(id=>!h.nodes[id].disabled),'failure restores original enabled input states');
 h.nodes['list-complete'].checked=false;h.ctx.toggleListDeadline();check(h.nodes['list-next-due'].disabled,'unchecking completion disables next deadline');
}
{
 const h=harness();let release;h.getGate=new Promise(r=>release=r);const pending=h.ctx.openListEdit('a1','status','scheduling');h.ctx.closeHrModal();release();await pending;check(h.root.innerHTML==='','late status GET cannot reopen dismissed modal');
 await h.ctx.openListEdit('a1','status','scheduling');h.listeners.keydown({key:'Escape',preventDefault(){}});check(h.root.innerHTML==='','Escape closes status edit');
 await h.ctx.openListEdit('a1','status','scheduling');h.listeners.popstate();check(h.root.innerHTML==='','browser history navigation closes status edit');
 check(h.calls.every(x=>x.dryRun),'cancelled status dialogs do not write');
}
{
 const h=harness();await h.ctx.openListEdit('a1','status','scheduling');h.nodes['list-status-ack'].checked=true;let release;h.getGate=new Promise(r=>release=r);const p=h.ctx.saveListEdit(h.nodes['list-edit-save']);h.ctx.closeHrModal();release();await p;check(h.calls.every(x=>x.dryRun),'close during status pre-save GET prevents write');
}
{
 const h=harness();const cell=h.mount();
 check(cell.includes('<textarea')&&cell.includes('maxlength="2000"')&&!cell.includes('openListEdit'),'memo is an inline 2000-character textarea without modal navigation');
 check(h.field().value==='元のメモ','existing memo shown directly in list');
 h.input('first');await h.tick(599);check(h.calls.length===0,'debounce waits 600ms');
 h.input('final');await h.tick(599);check(h.calls.length===0,'new input resets debounce');await h.tick(1);
 check(JSON.stringify(h.calls[0])===JSON.stringify({id:'a1',action:'saveNote',note:'final',expectedNote:'元のメモ'}),'autosave uses note-only CAS endpoint');
 check(h.a.note==='final'&&h.ctx.noteStateText(h.state())==='保存済み'&&h.loads===0,'success updates local note and saved status without list reload');
 check(h.a.status==='todo'&&h.a.nextAction==='次のシステム案内'&&h.a.decisionDueOn==='2026-01-01','autosave does not change status, NEXT or deadline');
 h.input('');h.ctx.flushListNote('a1');await h.settle();check(h.a.note===null&&h.calls.at(-1).expectedNote==='final','blur saves immediately and empty input clears memo');
 await h.tick(1000);check(h.calls.length===2,'blur clears pending debounce, avoiding duplicate saves');
}
{
 const h=harness();h.mount();h.ctx.composeListNote('a1',true,h.field());h.input('日本語の変換中',{isComposing:true});h.ctx.flushListNote('a1');await h.tick(2000);
 check(h.calls.length===0&&h.ctx.noteStateText(h.state()).includes('入力中'),'IME composition never saves on debounce or blur');
 h.ctx.composeListNote('a1',false,h.field());await h.tick(600);check(h.a.note==='日本語の変換中'&&h.calls.length===1,'IME completion resumes a single debounced save');
}
{
 const h=harness();h.mount();let release;h.saveGate=new Promise(r=>release=r);h.input('older');h.ctx.flushListNote('a1');await h.settle();
 check(h.state().inFlight&&h.ctx.noteStateText(h.state())==='保存中…','inflight save is visible');
 h.input('newer');h.ctx.flushListNote('a1');await h.tick(600);check(h.calls.length===1,'same applicant never has concurrent saves');
 release();await h.settle();check(h.field().value==='newer'&&h.state().draft==='newer','old response never overwrites newer input');
 await h.tick(600);check(h.calls.length===2&&h.calls[1].expectedNote==='older'&&h.a.note==='newer'&&h.maxInFlight===1,'queued revision saves after first response with latest CAS base');
}
{
 const h=harness();h.mount();h.fail=true;h.input('retain this draft');await h.tick(600);check(h.field().value==='retain this draft'&&h.state().error==='保存失敗','save failure retains typed draft');
 h.input('edit after failure');await h.tick(3000);h.ctx.flushListNote('a1');await h.settle();check(h.calls.length===1,'failure never auto retries after edits or blur');
 h.fail=false;h.ctx.retryInlineNote('a1');await h.settle();check(h.calls.length===2&&h.a.note==='edit after failure','explicit retry saves latest retained input');
}
{
 const h=harness();h.mount();h.input('あ'.repeat(2001));await h.tick(600);h.ctx.flushListNote('a1');await h.settle();check(h.calls.length===0&&h.state().error.includes('2000'),'overlength rejected without API call');
 h.input('あ'.repeat(2000));h.ctx.retryInlineNote('a1');await h.settle();check(h.a.note.length===2000,'corrected 2000-character draft can explicitly retry');
 const xss='</textarea><img src=x onerror=alert(1)>';h.input(xss);const cell=h.mount();check(cell.includes('&lt;/textarea&gt;')&&!cell.includes('<img'),'inline textarea escapes HTML and closing tags');
}
{
 const h=harness();h.mount();h.a.note='other editor';h.input('my draft');await h.tick(600);
 check(h.state().conflict&&h.state().draft==='my draft'&&h.a.note==='other editor','CAS conflict preserves draft without overwrite');
 h.ctx.retryInlineNote('a1');await h.tick(2000);check(h.calls.length===1,'conflict cannot blindly retry');
 await h.ctx.inspectNoteConflict('a1');check(h.state().latest==='other editor'&&h.ctx.noteControls(h.state()).includes('この入力で上書き'),'latest content shown before explicit conflict choice');
 h.ctx.adoptLatestNote('a1');check(h.field().value==='other editor'&&h.state().draft==='other editor'&&!h.state().conflict&&h.calls.length===1,'adopt latest discards draft locally without write');
}
{
 const h=harness();h.mount();h.a.note='other editor';h.input('my draft');await h.tick(600);await h.ctx.inspectNoteConflict('a1');
 h.ctx.overwriteLatestNote('a1');await h.settle();check(h.calls.at(-1).expectedNote==='other editor'&&h.a.note==='my draft','explicit overwrite uses latest note as CAS expectation');
}
{
 const h=harness();h.mount();h.a.note='v2';h.input('my draft');await h.tick(600);await h.ctx.inspectNoteConflict('a1');h.a.note='v3';h.ctx.overwriteLatestNote('a1');await h.settle();
 check(h.state().conflict&&h.a.note==='v3'&&h.state().draft==='my draft','second concurrent edit still conflicts after explicit overwrite');
}
{
 const h=harness();h.mount();let prevented=0;const event=()=>({preventDefault(){prevented++;},returnValue:undefined});h.listeners.beforeunload(event());check(prevented===0,'clean page has no exit warning');
 h.input('unsaved');h.listeners.beforeunload(event());check(prevented===1,'dirty draft warns before page exit');
 h.local[0].note='stale list refresh';const cell=h.mount();check(cell.includes('unsaved')&&h.state().draft==='unsaved','filter/rerender preserves unsaved Map draft against server list refresh');
 check(h.inlineNodes['note-save-summary'].textContent.includes('1件'),'summary includes unsaved hidden rows');
 let release;h.saveGate=new Promise(r=>release=r);h.ctx.flushListNote('a1');h.listeners.beforeunload(event());check(prevented===2,'inflight save warns before page exit');release();await h.settle();h.listeners.beforeunload(event());check(prevented===2,'saved page no longer warns');
 check(h.inlineNodes['note-save-summary'].textContent==='','pending summary clears after save');
}
{
 for(const resolveConflict of ['adoptLatestNote','overwriteLatestNote']) {
  const h=harness();h.mount();h.a.note='other editor';h.input('my draft');await h.tick(600);await h.ctx.inspectNoteConflict('a1');
  let rejectOld;h.ctx.API.getHrApplicant=()=>new Promise((resolve,reject)=>{rejectOld=reject;});
  const pending=h.ctx.inspectNoteConflict('a1');h.ctx[resolveConflict]('a1');await h.settle();rejectOld(new Error('obsolete GET failure'));await pending;
  check(!h.state().error&&!h.state().conflict,'late failed inspection cannot revive error after '+resolveConflict);
  check(h.ctx.noteStateText(h.state())==='保存済み','resolved saved state survives stale rejected GET: '+resolveConflict);
 }
}
{
 const h=harness();h.mount();h.a.note='other editor';h.input('my draft');await h.tick(600);
 const replies=[];h.ctx.API.getHrApplicant=()=>new Promise((resolve,reject)=>replies.push({resolve,reject}));
 const older=h.ctx.inspectNoteConflict('a1'),newer=h.ctx.inspectNoteConflict('a1');
 replies[1].resolve({applicant:{note:'newest snapshot'}});await newer;replies[0].resolve({applicant:{note:'older snapshot'}});await older;
 check(h.state().latest==='newest snapshot','out-of-order inspection success retains newest requested snapshot');
 const staleFailure=h.ctx.inspectNoteConflict('a1'),last=h.ctx.inspectNoteConflict('a1');
 replies[3].resolve({applicant:{note:'last snapshot'}});await last;const beforeError=h.state().error;
 replies[2].reject(new Error('obsolete network failure'));await staleFailure;
 check(h.state().latest==='last snapshot'&&h.state().error===beforeError,'older inspection rejection cannot replace newest snapshot or error');
}
{
 for(const resolveConflict of ['adoptLatestNote','overwriteLatestNote']) for(const outcome of ['success','failure']) {
  const h=harness();h.mount();h.a.note='old conflict latest';h.input('my draft');await h.tick(600);await h.ctx.inspectNoteConflict('a1');
  let finishOld,rejectOld;h.ctx.API.getHrApplicant=()=>new Promise((resolve,reject)=>{finishOld=resolve;rejectOld=reject;});
  const oldInspection=h.ctx.inspectNoteConflict('a1');
  h.a.note='new concurrent edit';h.ctx[resolveConflict]('a1');await h.settle();
  if(resolveConflict==='adoptLatestNote'){h.input('new draft after adoption');await h.tick(600);}
  check(h.state().conflict&&h.state().latest===undefined,'new CAS conflict episode starts without an old snapshot: '+resolveConflict+'/'+outcome);
  const error=h.state().error;
  if(outcome==='success')finishOld({applicant:{note:'obsolete previous-episode snapshot'}});else rejectOld(new Error('obsolete previous-episode failure'));
  await oldInspection;
  check(h.state().latest===undefined&&h.state().error===error,'previous episode GET cannot contaminate re-conflict: '+resolveConflict+'/'+outcome);
 }
}
check(html.includes('${decisionBadges(a)}${listStatusSelect(a)}')&&html.includes('a.overdue ? "期限超過"'),'existing overdue presentation remains alongside actual-status selector');
console.log(`${checks}/${checks} HR list editor VM checks PASS (not browser QA)`);
