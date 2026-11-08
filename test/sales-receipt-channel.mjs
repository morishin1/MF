import test from "node:test";
import assert from "node:assert/strict";
import {sourceChannel} from "../lib/sales-receipt-channel.js";
test("Email and LINE are distinguished by actual source metadata",()=>{
 assert.equal(sourceChannel({source_mail_at:"2026-11-06T12:00:00Z"}),"メール");
 assert.equal(sourceChannel({signup_source:"line"}),"LINE登録");
 assert.equal(sourceChannel({source_channel:"line",source_mail_at:"2026-11-06"}),"LINE");
 assert.equal(sourceChannel({source_channel:"email"}),"メール");
});
test("LINE connection flag alone does not invent a LINE receipt",()=>{
 assert.equal(sourceChannel({line_connected:true}),"不明");
 assert.equal(sourceChannel({}),"不明");
});