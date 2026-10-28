// 採用GASの即時取込入口：正しい署名・期限・再送・実行中だけを通す（Gmail実送信なし）
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const secret = "hr_manual_test_secret_at_least_32_bytes_long";
const source = readFileSync(new URL("../scripts/google-apps-script/hr-inbox-sync.gs", import.meta.url), "utf8");
let calls = 0, busy = false;
const seen = new Map();
const context = vm.createContext({
  Date, JSON, Number, String, Math, RegExp, Error, Logger: { log(){} },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (key) =>
    key === "HR_INBOX_MANUAL_SECRET" ? secret : null }) },
  Utilities: {
    Charset: { UTF_8: "UTF-8" },
    computeHmacSha256Signature: (data, key) => Array.from(
      crypto.createHmac("sha256", key).update(data).digest()).map(x => x > 127 ? x - 256 : x),
  },
  ContentService: { MimeType: { JSON: "JSON" }, createTextOutput: (text) => ({
    text, setMimeType(){ return this; },
  }) },
  LockService: { getScriptLock: () => ({
    tryLock: () => !busy, releaseLock(){},
  }) },
  CacheService: { getScriptCache: () => ({
    get: key => seen.get(key) || null,
    put: (key, value) => seen.set(key, value),
  }) },
});
vm.runInContext(source, context, { filename: "hr-inbox-sync.gs" });
context.syncRecruitmentInbox = () => {
  calls++;
  return { inserted: 2, duplicates: 1, processed: 3 };
};
function request({timestamp=String(Math.floor(Date.now()/1000)),
                  nonce=crypto.randomBytes(16).toString("hex"), key=secret, sign}={}){
  const signature = sign || crypto.createHmac("sha256", key)
    .update(timestamp+"."+nonce+".hr-inbox-sync-now").digest("hex");
  const response=context.doPost({ postData: { contents: JSON.stringify({
    timestamp, nonce, signature,
  }) } });
  return { data: JSON.parse(response.text), timestamp, nonce, signature };
}
let a=request();
assert.equal(a.data.ok, true);
assert.equal(a.data.inserted, 2);
assert.equal(a.data.duplicates, 1);
assert.equal(calls, 1);
assert.equal(request({timestamp:a.timestamp,nonce:a.nonce,sign:a.signature}).data.code, "duplicate_request");
assert.equal(calls, 1, "replayed request must not trigger Gmail scan");
assert.equal(request({key:"incorrect_secret_at_least_32_bytes_long"}).data.code, "unauthorized");
assert.equal(calls, 1);
assert.equal(request({timestamp:String(Math.floor(Date.now()/1000)-600)}).data.code, "unauthorized");
assert.equal(calls, 1);
busy=true;
assert.equal(request().data.code, "busy");
assert.equal(calls, 1);
busy=false;
assert.equal(request().data.ok, true);
assert.equal(calls, 2);
console.log("HR instant Gmail sync auth: PASS");
