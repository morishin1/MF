import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {newMeetingPassword,closeoutInput,proposalMail} from '../lib/sales-meeting-closeout.js';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const ui=read('../js/sales-meeting-five-stage.js');
const page=read('../sales/company-meeting.html');
const session=read('../api/sales/meeting-session.js');
const closing=read('../api/sales/meeting-closeout.js');
const sql=read('../db/174_sales_meeting_six_steps_closeout.sql');

test('six steps total exactly 30 minutes and match closing copy',()=>{
 const match=[...ui.matchAll(/min:(\d+)/g)].map(x=>Number(x[1]));
 assert.deepEqual(match,[4,2,7,10,4,3]);
 assert.equal(match.reduce((a,b)=>a+b,0),30);
 for(const title of ['アイスブレーク','会社概要','目的確認','課題確認','企業ページ','提案結果','ご案内・終了'])
  assert.match(ui,new RegExp(title));
 assert.match(page,/id="meeting-timer"/);
 assert.match(page,/id="meeting-step-checks"/);
 assert.match(page,/id="meeting-closeout"/);
 assert.match(page,/id="meeting-recipient"/);
});
test('staff-only stage stores checkboxes and notes, never exposes them to business API',()=>{
 assert.match(session,/action==="save_step"/);
 assert.match(session,/verifiedStep/);
 assert.match(session,/step_checks:checks,staff_notes:notes/);
 assert.match(session,/body\.stage>current\.stage/);
 assert.match(session,/step_check_required/);
 assert.match(session,/body\.stage>5/);
 assert.match(sql,/check \(stage between 0 and 5\)/);
});
test('new temporary password is 12 characters and unique',()=>{
 const pw=Array.from({length:40},newMeetingPassword);
 assert.equal(new Set(pw).size,pw.length);
 for(const x of pw){
  assert.equal(x.length,8);
  assert.match(x,/[A-Z]/);assert.match(x,/[a-z]/);
  assert.match(x,/[0-9]/);assert.match(x,/[!@]/);
 }
});
test('closing validates recipient, outcome and next action',()=>{
 const good=closeoutInput({email:'contact@example.co.jp',outcome:'reproposal',nextAction:'火曜日までに候補を確認',nextDue:'2026-11-17'});
 assert.ok(good.value);
 for(const bad of [
  {email:'a@',outcome:'offer',nextAction:'確認する'},
  {email:'contact@example.co.jp',outcome:'unknown',nextAction:'確認する'},
  {email:'contact@example.co.jp',outcome:'offer',nextAction:''}
 ]) assert.ok(closeoutInput(bad).error);
 const m=proposalMail({companyName:'テスト会社',companyNo:'01234',recipientName:'担当者',
  portalUrl:'https://enger.jp/business/login',password:'Test!234ABCD',itemsCount:2,action:'面談を調整'});
 assert.match(m.subject,/ENGER/);
 assert.match(m.text,/企業専用ページ/);
 assert.match(m.text,/仮パスワード/);
 assert.match(m.text,/他社へ公開されません/);
});
test('only successful mail closes session, password is not persisted',()=>{
 assert.match(closing,/mailConfig\("portal"\)/);
 assert.match(closing,/sendMail\(\{purpose:"portal"/);
 assert.match(closing,/if\(sent\.status!=="sent"\)/);
 assert.match(closing,/mail_status:"sent"/);
 assert.match(closing,/status:"closed"/);
 assert.match(closing,/gw_sales_events/);
 assert.match(closing,/selected_keys:offered/);
 assert.doesNotMatch(closing,/temporaryPassword\s*:/);
 assert.match(closing,/loginId,/);
 assert.match(closing,/activeMembers\.data\?\.length===1\?companyNo:input\.email/);
 assert.match(closing,/oneTimePassword:password/);
});
