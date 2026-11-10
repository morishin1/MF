import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {newMeetingPassword,emailOk,closeoutInput,proposalMail} from '../lib/sales-meeting-closeout.js';
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const page=read('../sales/company-meeting.html');
const nav=read('../js/sales-meeting-five-stage.js');
const session=read('../api/sales/meeting-session.js');
const closeout=read('../api/sales/meeting-closeout.js');
const publicApi=read('../api/sales/company-meeting-screen.js');
const sql=read('../db/174_sales_meeting_six_steps_closeout.sql');

test('cryptographically generated temporary credentials are 12 chars with mixed classes',()=>{
 const generated=Array.from({length:50},()=>newMeetingPassword());
 assert.equal(new Set(generated).size,50);
 for(const pwd of generated){
  assert.equal(pwd.length,8);
  assert.match(pwd,/[A-Z]/);assert.match(pwd,/[a-z]/);
  assert.match(pwd,/[0-9]/);assert.match(pwd,/[!@]/);
 }
});
test('closing input needs real email, outcome, concrete follow-up',()=>{
 assert.ok(emailOk('business@example.jp'));
 for(const bad of ['','not-email','test@','hello @example.com','test@example.com\r\nBCC:bad@evil.io'])
  assert.equal(emailOk(bad),false,bad);
 const good=closeoutInput({email:' SALES@EXAMPLE.COM ',contactName:'',
  outcome:'reproposal',nextAction:'3営業日以内に候補条件を再確認',nextDue:'2026-11-16'});
 assert.equal(good.value?.email,'sales@example.com');
 assert.equal(good.value?.nextDue,'2026-11-16');
 assert.equal(closeoutInput({email:'test@example.com',outcome:'offer'}).error,'next_action_required');
 assert.equal(closeoutInput({email:'test@example.com',nextAction:'test',outcome:'unknown'}).error,'invalid_outcome');
});
test('proposal email includes only selected counts and temporary credentials when newly issued',()=>{
 const x=proposalMail({companyName:'株式会社テスト',companyNo:'01234',
  recipientName:'',portalUrl:'https://enger.jp/business/login?next=example',
  password:'Fake-Strong-1!',itemsCount:2,action:'面談候補日を確認'});
 assert.match(x.subject,/ご提案内容/);
 assert.match(x.text,/01234/);
 assert.match(x.text,/Fake-Strong-1!/);
 assert.match(x.text,/2件/);
 assert.match(x.text,/案件や所属人材/);
 const existing=proposalMail({companyName:'テスト',companyNo:'01234',portalUrl:'https://enger.jp/business/login',
  password:null,itemsCount:1,action:'連絡'});
 assert.doesNotMatch(existing.text,/仮パスワード：/);
});
test('30-minute navigator includes all six step goals and time weights',()=>{
 assert.match(nav,/name:"アイスブレーク・会社概要",min:4/);
 assert.match(nav,/name:"目的確認",min:2/);
 assert.match(nav,/name:"課題確認",min:7/);
 assert.match(nav,/name:"企業専用ページへ",min:10/);
 assert.match(nav,/name:"オファー",min:4/);
 assert.match(nav,/name:"クロージング",min:3/);
 for(const field of ['meeting-step-goal','meeting-step-questions','meeting-step-checks',
   'meeting-timer','meeting-closeout','meeting-recipient','meeting-send'])
  assert.match(page,new RegExp('id="'+field+'"'));
 assert.match(nav,/stepChecks/);
 assert.match(nav,/meeting-step-save/);
 assert.match(nav,/meeting-closeout/);
});
test('staff-only step notes must never be returned from company-facing screen',()=>{
 assert.match(session,/verifiedStep/);
 assert.match(session,/step_checks:checks,staff_notes:notes/);
 assert.match(session,/stage<0\|\|body.stage>5/);
 assert.match(sql,/check \(stage between 0 and 5\)/);
 assert.match(publicApi,/readPublicCandidates/);
 assert.doesNotMatch(publicApi,/staff_notes/);
});
test('closeout checks tenant scope, publication and mail receipt before closing',()=>{
 for(const x of ['requireUser(req,res)','companyInScope(db,ctx.tenantId,companyId)',
  'mailConfig("portal")','sendMail({purpose:"portal"','offered_keys:offered',
  'mailDelivered=true','status:"closed"'])
  assert.ok(closeout.includes(x),x);
 assert.match(closeout,/if\(sent.status!=="sent"\)throw/);
 assert.match(closeout,/mail_status:"sent"/);
 assert.match(closeout,/if\(!mailDelivered\)/);
 assert.match(closeout,/post_mail_session_sync_failed/);
 assert.match(closeout,/gw_sales_events/);
 assert.doesNotMatch(closeout,/password:password[,}]/);
});
