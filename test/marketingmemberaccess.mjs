// Read-only display parity. No credentials, real DB, grants or network calls.
import assert from 'node:assert/strict';
import {appViewOf,accessForMember} from '../lib/member-access.js';
import {accessOf} from '../lib/gw.js';
const roles=['owner','manager','hr','recruiter','sales','finance','it','labor_advisor'];
const apps=['hr','sales','office','marketing'];
const subset=(keys,bits)=>keys.filter((_,i)=>bits&(1<<i));
// Frozen pre-Marketing display rule: the other four apps/locks must not change.
const legacy=({roles,apps,isAdmin})=>{
 const owner=roles.includes('owner'),has=k=>apps.includes(k);
 const view={hr:owner||has('hr'),sales:owner||has('sales'),office:owner||isAdmin||has('office'),keiei:owner};
 const appLocks={};
 if(owner)for(const k of ['hr','sales','office','keiei'])appLocks[k]='owner';
 else if(isAdmin)appLocks.office='accountingAdmin';
 return {apps:view,appLocks};
};
let cases=0;
for(let r=0;r<1<<roles.length;r++)for(let a=0;a<1<<apps.length;a++)for(const isAdmin of [false,true]){
 const input={roles:subset(roles,r),apps:subset(apps,a),isAdmin};
 const before=JSON.stringify(input),got=appViewOf(input),old=legacy(input);
 assert.deepEqual(Object.keys(got.apps),['hr','sales','office','marketing','keiei']);
 assert.equal(got.apps.marketing,input.roles.includes('owner')||input.apps.includes('marketing'));
 assert.equal(got.apps.marketing,accessOf(input).marketing);
 assert.equal(got.appLocks.marketing,input.roles.includes('owner')?'owner':undefined);
 const {marketing:ignoreApp,...otherApps}=got.apps,{marketing:ignoreLock,...otherLocks}=got.appLocks;
 assert.deepEqual({apps:otherApps,appLocks:otherLocks},old,'legacy app/lock semantics must not change');
 assert.equal(JSON.stringify(input),before,'display calculation never mutates grants');
 cases++;
}
const only=accessForMember([], 'u',new Map([['u',false]]),['marketing']);
assert.deepEqual(only.apps,{hr:false,sales:false,office:false,marketing:true,keiei:false});
assert.equal(only.access.marketing,true);assert.equal(only.access.officeApp,false);
assert.deepEqual(only.appLocks,{});
const missing=accessForMember([], 'u',null,['marketing']);
assert.equal(missing.access,null);assert.equal(missing.accessMeta.accountingAdmin,null,'unknown membership stays unknown');
assert.equal(missing.apps.marketing,true,'display explicit grant, not invented role inheritance');
console.log(`Marketing member display: ${cases} role/grant/admin combinations and 2 response cases passed`);
