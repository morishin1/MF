import test from 'node:test';
import assert from 'node:assert/strict';
import {planEngerOutreach} from '../js/sales-enger-outreach.js';

const row={companyId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'テスト会社',blocked:false,salesOnly:false};
const base=()=>({
  contact:{name:'企業担当',email:'contact@example.jp'},contactAllowed:true,contactReady:true,
  mail:{configured:true},members:[],events:[],
});
test('初回招待は保存済み担当者にしか出さない',()=>{
  const p=planEngerOutreach(row,base());
  assert.equal(p.action,'invite');assert.equal(p.email,'contact@example.jp');
  assert.equal(p.name,'企業担当');
});
test('連絡停止・未確認・SMTP未設定は除外',()=>{
  assert.match(planEngerOutreach({...row,blocked:true},base()).reason,/営業停止/);
  assert.match(planEngerOutreach(row,{...base(),contactAllowed:false,contactReason:'連絡禁止'}).reason,/連絡禁止/);
  assert.match(planEngerOutreach(row,{...base(),mail:{configured:false,reason:'SMTP未設定'}}).reason,/SMTP未設定/);
  assert.match(planEngerOutreach(row,{...base(),contactReady:false}).reason,/確認が必要/);
});
test('別の担当者との誤紐付けは案内しない',()=>{
  assert.match(planEngerOutreach(row,{...base(),members:[{email:'other@example.jp',status:'active'}]}).reason,/異なります/);
});
test('期限内招待は二重送信しない',()=>{
  assert.match(planEngerOutreach(row,{...base(),members:[{email:'contact@example.jp',status:'invited'}]}).reason,/送付済み/);
});
test('期限切れは再招待、停止済みは拒否',()=>{
  const p=planEngerOutreach(row,{...base(),members:[{id:'m1',email:'contact@example.jp',status:'expired'}]});
  assert.equal(p.action,'reinvite');assert.equal(p.memberId,'m1');
  assert.match(planEngerOutreach(row,{...base(),members:[{email:'contact@example.jp',status:'disabled'}]}).reason,/停止中/);
});
test('利用中の企業はログイン用リンクを案内する',()=>{
  const p=planEngerOutreach(row,{...base(),members:[{id:'m2',email:'contact@example.jp',displayName:'企業担当',status:'active'}]});
  assert.equal(p.action,'login_link');
});
test('直近7日の案内履歴があれば再送しない',()=>{
  const now=Date.UTC(2026,10,12);
  const p=planEngerOutreach(row,{
    ...base(),members:[{id:'m2',email:'contact@example.jp',displayName:'企業担当',status:'active'}],
    events:[{action:'portal.link_sent',member:'企業担当',at:new Date(now-2*86400000).toISOString()}],
  },now);
  assert.match(p.reason,/7日以内/);
});
