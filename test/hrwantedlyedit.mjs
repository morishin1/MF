import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../hr/applicants.html',import.meta.url),'utf8');
const code=html.slice(html.indexOf('  async function saveProfileUrl()'),html.indexOf('  function closeProfilePreview()'));
function setup(){
 const elements={'hr-profile-modal':{dataset:{applicant:'a'},isConnected:true},'hr-profile-edit-url':{value:'https://www.wantedly.com/id/a',isConnected:true},'hr-profile-save':{disabled:false},'hr-profile-save-msg':{textContent:''}};
 const calls=[], people=[{id:'a',profileUrl:null,note:'keep'},{id:'b',profileUrl:'https://example.com/b'}];
 const c=vm.createContext({URL,console,el:id=>elements[id],profileRequest:1,applicants:people,detail:{applicant:{id:'a',profileUrl:null}},render:()=>{},openProfilePreview:async()=>{},API:{updateHrApplicant:async b=>{calls.push(b);return {applicant:{id:b.id,profileUrl:b.profileUrl}};}}});
 vm.runInContext(readFileSync(new URL('../js/hr-applicant-list.js',import.meta.url),'utf8'),c);vm.runInContext(code,c);
 return {c,e:elements,calls,people};
}
{
 const {c,e,calls,people}=setup();await c.saveProfileUrl();assert.equal(calls.length,1);assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{id:'a',profileUrl:'https://www.wantedly.com/id/a'});assert.equal(people[0].note,'keep');assert.equal(people[1].profileUrl,'https://example.com/b');assert.equal(e['hr-profile-save-msg'].textContent,'保存しました');
 e['hr-profile-edit-url'].value='javascript:alert(1)';await c.saveProfileUrl();assert.equal(calls.length,1);assert.match(e['hr-profile-save-msg'].textContent,/入力してください/);
 e['hr-profile-edit-url'].value='';await c.saveProfileUrl();assert.equal(people[0].profileUrl,null);
}
{
 const {c,e}=setup();c.API.updateHrApplicant=async()=>{throw {hint:'権限がありません'};};await c.saveProfileUrl();assert.equal(e['hr-profile-save-msg'].textContent,'権限がありません');assert.equal(e['hr-profile-edit-url'].value,'https://www.wantedly.com/id/a');assert.equal(e['hr-profile-save'].disabled,false);
}
{
 const {c,e}=setup();let release,calls=0;c.API.updateHrApplicant=async b=>{calls++;await new Promise(r=>release=r);return {applicant:{id:b.id,profileUrl:b.profileUrl}};};let reopened=0;c.openProfilePreview=async()=>{reopened++;};
 const p=c.saveProfileUrl();await c.saveProfileUrl();assert.equal(calls,1);assert.equal(e['hr-profile-edit-url'].disabled,true);c.profileRequest++;e['hr-profile-modal'].isConnected=false;release();await p;assert.equal(reopened,0);
}
assert.match(html,/id="hr-profile-edit-url"/);assert.match(html,/id="hr-profile-save"/);
console.log('PASS profile-only patch, validation, clear, failure preservation, repeated click and stale modal isolation');
