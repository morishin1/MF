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
  const nodes={},listeners={},calls=[];
  const esc=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const decode=x=>x.replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&#39;',"'").replaceAll('&amp;','&');
  const node=()=>({value:'',checked:false,textContent:'',disabled:false,focus(){},setAttribute(){}});
  let markup='';
  const root={get innerHTML(){return markup},set innerHTML(s){markup=s;for(const k of Object.keys(nodes))delete nodes[k];for(const m of s.matchAll(/<[^>]*id="([^"]+)"[^>]*>/g)){nodes[m[1]]=node();nodes[m[1]].disabled=/\bdisabled\b/.test(m[0]);}const m=s.match(/<textarea[^>]*id="list-note"[^>]*>([\s\S]*?)<\/textarea>/);if(m)nodes['list-note'].value=decode(m[1]);},querySelector:()=>node(),querySelectorAll:()=>Object.values(nodes)};
  const a={id:'a1',name:'架空応募者',status:'todo',statusLabel:'未対応',note:'元のメモ',nextAction:'次のシステム案内',overdue:true,decisionDueOn:'2026-01-01'};
  const h={nodes,calls,a,root,fail:false,getGate:null,saveGate:null,loads:0,warnings:['面談は変更されません']};
  const context=vm.createContext({console,esc,el:id=>id==='hr-modal-root'?root:nodes[id],applicants:[clone(a)],
    window:{addEventListener:(k,f)=>listeners[k]=f},document:{addEventListener:(k,f)=>listeners[k]=f},
    API:{async getHrApplicant(){if(h.getGate){const p=h.getGate;h.getGate=null;await p;}return {applicant:clone(a),statusOptions:[{key:'todo'},{key:'scheduling'}]};},
      async updateHrApplicant(b){calls.push(clone(b));if(b.dryRun)return {from:'未対応',to:'日程調整中',warnings:clone(h.warnings)};if(h.saveGate){const p=h.saveGate;h.saveGate=null;await p;}if(h.fail)throw new Error('保存失敗');if('note'in b)a.note=b.note;if(b.status)a.status=b.status;return {applicant:clone(a)};}},
    KPLayout:{async busy(btn,label,fn){btn.disabled=true;try{return await fn()}finally{btn.disabled=false}}},load:async()=>{h.loads++;}});
  vm.runInContext(statusSource+'\n'+source,context);h.ctx=context;h.listeners=listeners;return h;
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
 const h=harness();await h.ctx.openListEdit('a1','note');check(h.nodes['list-note'].value==='元のメモ','existing applicant note loaded');
 h.nodes['list-note'].value='あ'.repeat(2001);await h.ctx.saveListEdit(h.nodes['list-edit-save']);check(h.calls.length===0&&h.nodes['list-edit-msg'].textContent.includes('2000'),'overlength rejected without API');
 const text='<img src=x onerror=alert(1)>\n内部メモ';h.nodes['list-note'].value=text;h.fail=true;await h.ctx.saveListEdit(h.nodes['list-edit-save']);check(h.nodes['list-note'].value===text&&h.nodes['list-edit-msg'].textContent==='保存失敗','failed save retains input and error');
 h.fail=false;await h.ctx.saveListEdit(h.nodes['list-edit-save']);check(JSON.stringify(h.calls.at(-1))===JSON.stringify({id:'a1',note:text}),'memo PATCH only id and note');
 const cell=h.ctx.listNoteCell(h.a);check(cell.includes('&lt;img')&&!cell.includes('<img'),'memo display escapes HTML');
 await h.ctx.openListEdit('a1','note');h.nodes['list-note'].value='';await h.ctx.saveListEdit(h.nodes['list-edit-save']);check(h.a.note==='','empty memo clears existing note');
}
{
 const h=harness();await h.ctx.openListEdit('a1','note');h.nodes['list-note'].value='cancel';h.ctx.closeHrModal();check(h.calls.length===0&&h.a.note==='元のメモ','cancel does not save');
 let release;h.getGate=new Promise(r=>release=r);const pending=h.ctx.openListEdit('a1','note');h.ctx.closeHrModal();release();await pending;check(h.root.innerHTML==='','late GET cannot reopen dismissed modal');
 await h.ctx.openListEdit('a1','note');h.listeners.keydown({key:'Escape',preventDefault(){}});check(h.root.innerHTML==='','Escape closes list edit');
 await h.ctx.openListEdit('a1','note');h.listeners.popstate();check(h.root.innerHTML==='','browser history navigation closes list edit');
}
{
 const h=harness();await h.ctx.openListEdit('a1','note');h.nodes['list-note'].value='ours';h.a.note='other editor';await h.ctx.saveListEdit(h.nodes['list-edit-save']);check(h.calls.length===0&&h.nodes['list-edit-msg'].textContent.includes('別の担当者'),'fresh read detects changed note without overwrite');
}
{
 const h=harness();await h.ctx.openListEdit('a1','note');h.nodes['list-note'].value='once';let release;h.saveGate=new Promise(r=>release=r);const btn=h.nodes['list-edit-save'];const p=h.ctx.saveListEdit(btn);const q=h.ctx.saveListEdit(btn);await Promise.resolve();release();await Promise.all([p,q]);check(h.calls.length===1,'double submit while busy sends one write');
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
 const h=harness();await h.ctx.openListEdit('a1','note');let release;h.getGate=new Promise(r=>release=r);const p=h.ctx.saveListEdit(h.nodes['list-edit-save']);h.ctx.closeHrModal();release();await p;check(h.calls.length===0,'close during pre-save GET prevents write');
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
check(html.includes('${decisionBadges(a)}${listStatusSelect(a)}')&&html.includes('a.overdue ? "期限超過"'),'existing overdue presentation remains alongside actual-status selector');
console.log(`${checks}/${checks} HR list editor VM checks PASS (not browser QA)`);
