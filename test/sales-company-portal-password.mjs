import test from "node:test";
import assert from "node:assert/strict";
import {newTemporaryPassword,memberView} from "../lib/sales-company-portal.js";
test("temporary portal credentials are cryptographically generated",()=>{
 const a=Array.from({length:20},()=>newTemporaryPassword());
 assert.equal(new Set(a).size,a.length);
 for(const v of a)assert.ok(v.length>=30&&!/\s/.test(v));
});
test("portal member listing never contains a password",()=>{
 const m=memberView({
  id:"member",email:"staff@example.jp",display_name:"担当者",role:"member",
  auth_user_id:"user",created_at:"2026-11-07",last_login_at:null,
 },null);
 assert.equal(m.email,"staff@example.jp");
 assert.equal(Object.hasOwn(m,"password"),false);
 assert.equal(Object.hasOwn(m,"temporaryPassword"),false);
});