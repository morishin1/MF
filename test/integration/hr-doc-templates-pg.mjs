// 雛形・発行物のテーブル（使い捨てのローカル PostgreSQL = PGlite。外部のDBには一切つながない）
import fs from 'node:fs';import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.HR_PGLITE_MODULE||'@electric-sql/pglite');const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create table auth.users(id uuid primary key);create table tenants(id uuid primary key);
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table gw_hr_applicants(id uuid primary key,tenant_id uuid,name text);grant select on gw_hr_applicants,tenants to service_role;grant usage on schema auth to service_role;grant select on auth.users to service_role;`);
await db.exec(fs.readFileSync(new URL('../../supabase/migrations/20261114120000_hr_doc_templates.sql',import.meta.url),'utf8'));
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,T=id(1),T2=id(2),U=id(3),A=id(4),A2=id(5),O=id(6),h=c=>c.repeat(64);
await db.query('insert into tenants values($1),($2)',[T,T2]);await db.query('insert into auth.users values($1)',[U]);
await db.query("insert into gw_hr_applicants values($1,$2,'架空 太郎'),($3,$4,'別テナントの人')",[A,T,A2,T2]);
const fails=async(sql,params,pattern)=>{await assert.rejects(()=>db.query(sql,params),e=>pattern.test(String(e.message)),sql.slice(0,60));};
const bucket=(await db.query("select public,file_size_limit from storage.buckets where id='hr-doc-templates'")).rows[0];assert.equal(bucket.public,false,'非公開の保存場所');

// ブラウザの役割（anon / authenticated）からは読めない・書けない
for(const role of ['anon','authenticated']){await db.exec('set role '+role);await fails('select * from gw_hr_doc_templates',[],/permission denied/);await fails('select * from gw_hr_doc_issues',[],/permission denied/);await db.exec('reset role');}
await db.exec('set role service_role');
const tpl=async(o={})=>{const v={tenant:T,kind:'employment_contract',category:'fixed_term_trial',version:1,sha:h('a'),...o};
 return (await db.query(`insert into gw_hr_doc_templates(tenant_id,kind,category,version,name,filename,path,sha256,size_bytes,placeholders,created_by)
  values($1,$2,$3,$4,'有期雇用（試用期間）','雛形.docx',$5,$6,2000,'["氏名","契約期間"]',$7) returning *`,[v.tenant,v.kind,v.category,v.version,v.path||`${v.tenant}/templates/${v.kind}/${v.category}-v${v.version}.docx`,v.sha,U])).rows[0];};
const t1=await tpl();assert.equal(t1.status,'active');
// いま使う雛形は、書類・雇用形態ごとに1つだけ。差し替えは「前の版をしまってから、新しい版を足す」
await fails(`insert into gw_hr_doc_templates(tenant_id,kind,category,version,name,filename,path,sha256,size_bytes,placeholders,created_by) values($1,'employment_contract','fixed_term_trial',2,'x','x.docx',$2,$3,2000,'["氏名"]',$4)`,[T,`${T}/templates/employment_contract/v2.docx`,h('b'),U],/hr_doc_template_current|duplicate/);
// 雛形は不変：中身・版・保存先は変えられない。消せない
await fails("update gw_hr_doc_templates set sha256=$1 where id=$2",[h('c'),t1.id],/immutable_template/);
await fails("update gw_hr_doc_templates set placeholders='[\"氏名\"]' where id=$1",[t1.id],/immutable_template/);
await fails("update gw_hr_doc_templates set path=$1 where id=$2",[`${T}/templates/employment_contract/other.docx`,t1.id],/immutable_template/);
await fails("delete from gw_hr_doc_templates where id=$1",[t1.id],/permission denied|immutable_template/);   // 削除の権限そのものを渡していない
await fails(`insert into gw_hr_doc_templates(tenant_id,kind,category,version,name,filename,path,sha256,size_bytes,placeholders,created_by) values($1,'labor_notice','fixed_term_trial',1,'x','x.docx',$2,$3,2000,'["氏名"]',$4)`,[T,`${T2}/templates/labor_notice/v1.docx`,h('d'),U],/template_scope/);
await fails(`insert into gw_hr_doc_templates(tenant_id,kind,category,version,name,filename,path,sha256,size_bytes,placeholders,created_by) values($1,'resume','fixed_term_trial',1,'x','x.docx',$2,$3,2000,'["氏名"]',$4)`,[T,`${T}/templates/resume/v1.docx`,h('d'),U],/check constraint/);
await fails(`insert into gw_hr_doc_templates(tenant_id,kind,category,version,name,filename,path,sha256,size_bytes,placeholders,created_by) values($1,'labor_notice','fixed_term_trial',1,'x','x.docx',$2,$3,2000,'[]',$4)`,[T,`${T}/templates/labor_notice/v1.docx`,h('d'),U],/check constraint/);
// 書類の種類は別々：労働条件通知書の雛形は、雇用契約書とは別に持てる
const notice=await tpl({kind:'labor_notice',sha:h('e')});assert.equal(notice.kind,'labor_notice');

// 発行：いまの雛形の、その版・その中身からだけ
const issue=(o={})=>{const v={tenant:T,app:A,kind:'employment_contract',version:1,t:t1,sha:t1.sha256,tv:t1.version,...o};
 return db.query(`insert into gw_hr_doc_issues(tenant_id,applicant_id,offer_id,kind,version,template_id,template_version,template_sha256,field_values,docx_path,docx_sha256,created_by${v.status?',status':''})
  values($1,$2,$3,$4,$5,$6,$7,$8,'{"氏名":"架空 太郎"}',$9,$10,$11${v.status?`,'${v.status}'`:''}) returning *`,[v.tenant,v.app,O,v.kind,v.version,v.t.id,v.tv,v.sha,v.path||`${v.tenant}/issues/${v.app}/${v.kind}-v${v.version}.docx`,h('1'),U]);};
const i1=(await issue()).rows[0];assert.equal(i1.status,'draft');assert.equal(i1.pdf_path,null);
await assert.rejects(()=>issue({version:2,sha:h('9')}),/issue_template_mismatch/,'雛形の中身が違えば発行しない');
await assert.rejects(()=>issue({version:2,tv:7}),/issue_template_mismatch/);
await assert.rejects(()=>issue({version:2,kind:'labor_notice'}),/issue_template_mismatch/,'雇用契約書の雛形で労働条件通知書は発行しない');
await assert.rejects(()=>issue({version:2,app:A2}),/issue_scope|foreign key/,'別テナントの応募者には発行しない');
await assert.rejects(()=>issue({version:2,path:`${T}/issues/${A2}/x.docx`}),/issue_scope/);
await assert.rejects(()=>issue({version:2,status:'confirmed'}),/issue_must_start_draft|check constraint/,'発行しただけでは確定にならない');
// PDF なしでは確定できない。確定は明示の操作（confirmed_by / confirmed_at）
await fails("update gw_hr_doc_issues set status='confirmed',confirmed_by=$1,confirmed_at=now() where id=$2",[U,i1.id],/check constraint/);
await db.query("update gw_hr_doc_issues set pdf_path=$1,pdf_sha256=$2,pdf_engine='google-drive' where id=$3",[`${T}/issues/${A}/employment_contract-v1.pdf`,h('2'),i1.id]);
await fails("update gw_hr_doc_issues set pdf_sha256=$1 where id=$2",[h('3'),i1.id],/immutable_issue/);
await fails("update gw_hr_doc_issues set field_values='{\"氏名\":\"別人\"}' where id=$1",[i1.id],/immutable_issue/);
await fails("update gw_hr_doc_issues set docx_sha256=$1 where id=$2",[h('4'),i1.id],/immutable_issue/);
await db.query("update gw_hr_doc_issues set status='confirmed',confirmed_by=$1,confirmed_at=now() where id=$2",[U,i1.id]);
await fails("update gw_hr_doc_issues set status='draft',confirmed_by=null,confirmed_at=null where id=$1",[i1.id],/issue_transition/);
await fails("delete from gw_hr_doc_issues where id=$1",[i1.id],/permission denied|immutable_issue/);

// 雛形を差し替えても、発行済みの書類は変わらない
await db.query("update gw_hr_doc_templates set status='archived',archived_at=now() where id=$1",[t1.id]);
await fails("update gw_hr_doc_templates set status='active',archived_at=null where id=$1",[t1.id],/template_archived/);
const t2=await tpl({version:2,sha:h('f')});assert.equal(t2.version,2);
await assert.rejects(()=>issue({version:2}),/issue_template_mismatch/,'しまった雛形からは新しく発行しない');
const kept=(await db.query('select template_id,template_version,template_sha256,field_values,docx_sha256,pdf_sha256,status from gw_hr_doc_issues where id=$1',[i1.id])).rows[0];
assert.deepEqual([kept.template_id,kept.template_version,kept.template_sha256,kept.docx_sha256,kept.pdf_sha256,kept.status],[t1.id,1,h('a'),h('1'),h('2'),'confirmed']);
assert.deepEqual(kept.field_values,{氏名:'架空 太郎'});
// 新しい版で作り直す：下書き → 確定は1つだけ（前の確定を「差し替え済み」にしてから）
const i2=(await issue({version:2,t:t2,sha:t2.sha256,tv:2})).rows[0];
await db.query("update gw_hr_doc_issues set pdf_path=$1,pdf_sha256=$2,pdf_engine='google-drive' where id=$3",[`${T}/issues/${A}/employment_contract-v2.pdf`,h('5'),i2.id]);
await fails("update gw_hr_doc_issues set status='confirmed',confirmed_by=$1,confirmed_at=now() where id=$2",[U,i2.id],/hr_doc_issue_confirmed|duplicate/);
await db.query("update gw_hr_doc_issues set status='superseded' where id=$1",[i1.id]);
await db.query("update gw_hr_doc_issues set status='confirmed',confirmed_by=$1,confirmed_at=now() where id=$2",[U,i2.id]);
assert.equal((await db.query("select count(*)::int n from gw_hr_doc_issues where status='confirmed'")).rows[0].n,1);
console.log('PASS local PostgreSQL: private bucket, API-only access, immutable template versions, one active template per kind/category, issue pinned to template version+hash, no confirm without PDF, explicit confirm, tenant/applicant scope, issued documents unchanged after template replacement');
