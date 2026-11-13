import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
const html=readFileSync("sales/companies.html","utf8");
const helper=html.slice(html.indexOf("  const hostOf ="),html.indexOf("  async function submitBulkUrls("));
assert.ok(helper.includes("function parseUrlList"),"exercise the actual bulk registration parser");
const sandbox={URL,companies:[{domain:"known.example"}]};
vm.createContext(sandbox);
vm.runInContext(helper+";globalThis.parse=parseUrlList;",sandbox);
const rows=JSON.parse(JSON.stringify(sandbox.parse("HTTPS://WWW.ABC.EXAMPLE/about abc.example/contact known.example https://new.example/path） これはURLではない https://[broken")));
assert.deepEqual(rows.map(r=>({host:r.host,known:r.known})),[
 {host:"abc.example",known:false},{host:"abc.example",known:true},
 {host:"known.example",known:true},{host:"new.example",known:false}
]);
assert.equal(rows[1].url,"https://abc.example/contact");
assert.equal(rows[3].url,"https://new.example/path");
assert.deepEqual(JSON.parse(JSON.stringify(sandbox.parse(""))),[]);
console.log("PASS bulk URL parser: normalization, existing/in-batch duplicates, malformed input");
