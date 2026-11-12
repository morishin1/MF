import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  COMPANY_ROLES, COMPANY_ROLE_LABELS, DISPATCH_LICENSE_TAG, SALES_STATUS_VALUES,
  SALES_STATUS_LABELS, rolesFromTags, hasDispatchLicense, tagsWithRoles,
  tagsWithDispatchLicense, salesAttributesInput, salesAttributePatch,
} from '../lib/sales-company-attributes.js';

const prior=['関西','紹介経由','role:bp',DISPATCH_LICENSE_TAG];
assert.deepEqual(SALES_STATUS_VALUES,['新規','既存','打ち合わせ済','その他']);
assert.equal(SALES_STATUS_LABELS['打ち合わせ済'],'打ち合わせ済み');
assert.deepEqual(COMPANY_ROLES,Object.keys(COMPANY_ROLE_LABELS));
assert.deepEqual(rolesFromTags(prior),['bp']);
assert.equal(hasDispatchLicense(prior),true);
assert.deepEqual(tagsWithRoles(prior,['end_client','ses']),['関西','紹介経由',DISPATCH_LICENSE_TAG,'role:end_client','role:ses']);
assert.deepEqual(tagsWithDispatchLicense(tagsWithRoles(prior,['ses']),false),['関西','紹介経由','role:ses']);
assert.deepEqual(salesAttributePatch({roles:['end_client'],dispatchLicense:false},prior),{
  tags:['関西','紹介経由','role:end_client'],
});
assert.deepEqual(salesAttributePatch({status:'その他'},prior),{status:'その他'});
for(const bad of [{status:'打ち合わせ済み'},{roles:['role:ses']},{roles:['ses','ses']},{dispatchLicense:'true'},{tags:['erase']},{}])
  assert.throws(()=>salesAttributesInput(bad));

const read=(path)=>readFileSync(new URL(path,import.meta.url),'utf8');
const migration=read('../db/180_sales_company_attributes.sql');
const api=read('../api/sales/company-workbench.js');
const detail=read('../api/sales/enger-company-detail.js');
const workbench=read('../js/sales-company-workbench.js');
assert.match(migration,/FOR UPDATE/);
assert.match(migration,/dx2_sales_company_directory_for_tenant[\s\S]*tenant_id=p_tenant AND id=p_company/);
assert.match(migration,/source_json->'tags' IS DISTINCT FROM p_expected->'tags'/);
assert.match(migration,/REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC,anon,authenticated/);
assert.match(api,/canAccessEightEngerDirectory\(ctx\)/);
assert.match(api,/operation==='sales_attributes'/);
assert.match(detail,/from\("company_touchpoints"\)[\s\S]*eq\("company_id",id\)/);
assert.match(detail,/tags:Array\.isArray\(c\.tags\)\?c\.tags:null/);
assert.match(workbench,/複数選択/);
assert.match(workbench,/派遣事業許可あり/);
assert.match(workbench,/過去の商談履歴/);
console.log('PASS Sales attributes: canonical status alias, multi-role tags, staffing license, optimistic UUID save and meeting history');
