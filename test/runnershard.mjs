import assert from "node:assert/strict";
import {execFileSync,spawnSync} from "node:child_process";
import {readdirSync} from "node:fs";
const expected=readdirSync(new URL("./ui",import.meta.url)).filter(f=>f.endsWith(".mjs") && f!=="tcdata.mjs").sort();
const selected=[];
for(let i=0;i<8;i++){
 const out=execFileSync(process.execPath,["test/run.mjs","ui","--list"],{encoding:"utf8",env:{...process.env,TEST_SHARD_INDEX:String(i),TEST_SHARD_COUNT:"8"}});
 selected.push(...JSON.parse(out.split("\n")[0]));
}
assert.equal(new Set(selected).size,selected.length,"No file runs in two shards");
assert.deepEqual(selected.sort(),expected,"All UI files must run exactly once across the matrix");
for(const [index,count] of [["8","8"],["-1","8"],["0","0"],["x","8"]]){
 const r=spawnSync(process.execPath,["test/run.mjs","ui","--list"],{env:{...process.env,TEST_SHARD_INDEX:index,TEST_SHARD_COUNT:count}});
 assert.notEqual(r.status,0,"Invalid shard configuration must fail");
}
console.log(`UI shards cover every ${expected.length} test file exactly once; invalid configuration fails`);
