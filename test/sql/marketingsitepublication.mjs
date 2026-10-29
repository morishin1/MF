// Real isolated PostgreSQL via an already installed PGlite. No network or production DB.
// PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js node test/sql/marketingsitepublication.mjs
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
const modulePath=process.env.PGLITE_MODULE;
if(!modulePath)throw Error('Set PGLITE_MODULE to an existing local PGlite installation; this test installs nothing.');
const {PGlite}=await import(pathToFileURL(modulePath).href);
const root=fileURLToPath(new URL('../..',import.meta.url));
const db=new PGlite();
const q=(sql,args=[])=>db.query(sql,args);
const scalar=async(sql,args=[])=>Object.values((await q(sql,args)).rows[0])[0];
let n=0;
const test=async(name,fn)=>{await fn();console.log('PASS',++n,name);};
const uid=i=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const T=uid(1),T2=uid(2),U=uid(11),U2=uid(12),D=i=>uid(100+i),hash='a'.repeat(64);
const migration=readFileSync(root+'/db/proposal_marketing_site_publication.sql','utf8');
const as=async(role,fn)=>{await db.exec('set role '+role);try{return await fn();}finally{await db.exec('reset role');}};
const publish=(extra={})=>{
 const x={tenant:T,actor:U,draft:D(1),version:2,hash,title:'架空公開テスト',summary:'架空内容の要約',body:'<p>架空本文です。</p>',payload:{},...extra};
 return as('service_role',()=>scalar('select public.gw_marketing_publish_site($1,$2,$3,$4,$5,$6,$7,$8,$9)',[x.tenant,x.actor,x.draft,x.version,x.hash,x.title,x.summary,x.body,JSON.stringify(x.payload)]));
};
const rejects=async(fn,code)=>assert.rejects(fn,e=>{assert.equal(e.code,code,e.message);return true;});
const count=table=>scalar(`select count(*)::int from public.${table}`);
try {
 await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
 create schema auth; create table auth.users(id uuid primary key);
 create table public.tenants(id uuid primary key);
 -- Exact relevant 8grp-site articles.sql columns/constraints, no customer data.
 create table public.news_articles(
 id uuid primary key default gen_random_uuid(),article_id integer unique,slug text not null unique,
 title text not null,kind text not null default 'エイトブログ',summary text,body_html text,
 status text not null default 'draft' check(status in ('draft','published')),published_on date,
 notion_url text,source text not null default 'portal',created_by text,updated_by text,
 created_at timestamptz default now(),updated_at timestamptz default now());
 grant usage on schema public to anon,authenticated,service_role;
 grant all on public.news_articles to service_role;`);
 await db.exec(readFileSync(root+'/db/proposal_marketing_pr_drafts.sql','utf8'));
 await db.exec('grant select,update on public.gw_marketing_pr_drafts to service_role;');
 const beforeTargetAcl=await scalar("select relacl::text from pg_class where oid='public.news_articles'::regclass");
 await db.exec(migration);
 await test('reapply is safe and target grants are unchanged',async()=>{
  await db.exec(migration);
  assert.equal(await scalar("select relacl::text from pg_class where oid='public.news_articles'::regclass"),beforeTargetAcl);
 });
 await q('insert into public.tenants(id) values($1),($2)',[T,T2]);
 await q('insert into auth.users(id) values($1),($2)',[U,U2]);
 for(let i=1;i<=12;i++)await q(`insert into public.gw_marketing_pr_drafts(id,tenant_id,created_by,updated_by,status,version,payload,registered_at,registered_by)
 values($1,$2,$3,$3,$4,2,'{}',$5,$6)`,[D(i),i===3?T2:T,i===2?U2:U,i===4?'draft':'registered',i===4?null:new Date().toISOString(),i===4?null:i===2?U2:U]);
 await test('RLS enabled and browser roles cannot read or mutate mappings',async()=>{
  assert.equal(await scalar("select relrowsecurity from pg_class where oid='public.gw_marketing_site_publications'::regclass"),true);
  for(const role of ['anon','authenticated'])for(const op of ['select * from','delete from',"update"]){
   const sql=op==='update'?"update public.gw_marketing_site_publications set last_check='forged'":`${op} public.gw_marketing_site_publications`;
   await rejects(()=>as(role,()=>q(sql)),'42501');
  }
  for(const role of ['anon','authenticated'])await rejects(()=>as(role,()=>q('insert into public.gw_marketing_site_publications default values')),'42501');
 });
 await test('browser roles cannot execute publication RPC',async()=>{
  for(const role of ['anon','authenticated'])await rejects(()=>as(role,()=>q('select public.gw_marketing_publish_site($1,$2,$3,2,$4,$5,$6,$7,$8)',[T,U,D(1),hash,'架空','架空','<p>架空</p>','{}'])),'42501');
 });
 await test('function is invoker with empty search_path',async()=>{
  const p=(await q("select prosecdef,proconfig from pg_proc where oid='public.gw_marketing_publish_site(uuid,uuid,uuid,integer,text,text,text,text,jsonb)'::regprocedure")).rows[0];
  assert.equal(p.prosecdef,false);assert.ok(p.proconfig.includes('search_path=""'));
 });
 await test('cross-author and cross-tenant drafts rejected without writes',async()=>{
  await rejects(()=>publish({draft:D(2)}),'42501');await rejects(()=>publish({draft:D(3)}),'42501');
  await rejects(()=>publish({tenant:T2}),'42501');await rejects(()=>publish({actor:U2}),'42501');
  assert.equal(await count('news_articles'),0);assert.equal(await count('gw_marketing_site_publications'),0);
 });
 await test('unregistered draft and stale version rejected',async()=>{
  await rejects(()=>publish({draft:D(4)}),'23514');await rejects(()=>publish({version:1}),'PT409');
 });
 await test('invalid/null values rejected before target writes',async()=>{
  for(const extra of [{tenant:null},{actor:null},{draft:null},{version:null},{version:0},{hash:null},{hash:'not-hash'},{title:null},{title:' '},{title:'x'.repeat(121)},{summary:null},{summary:' '},{body:null},{body:' '},{body:'x'.repeat(200001)}])await rejects(()=>publish(extra),'23514');
  assert.equal(await count('news_articles'),0);
 });
 let saved;
 await test('publish persists one exact target and one linked snapshot atomically',async()=>{
  saved=await publish();assert.equal(saved.tenant_id,T);assert.equal(saved.draft_id,D(1));
  assert.equal(saved.last_check,'pending');assert.equal(saved.verified_at,null);assert.equal(saved.checked_at,null);
  assert.equal(saved.slug,'press-mkt-'+D(1).replaceAll('-',''));
  const row=(await q('select * from public.news_articles where id=$1',[saved.article_id])).rows[0];
  assert.equal(row.article_id,1);assert.equal(row.status,'published');assert.equal(row.kind,'プレスリリース');
  assert.equal(row.body_html,saved.body_html);assert.equal(row.title,saved.title);assert.equal(row.summary,saved.summary);
  assert.equal(row.source,'portal');assert.equal(row.created_by,'Marketing PR');assert.equal(row.updated_by,'Marketing PR');
  assert.equal(saved.requested_by,U);assert.ok(!JSON.stringify(row).includes(U),'public target excludes actor UUID');
  assert.equal(new Date(row.published_on).toISOString().slice(0,10),await scalar("select ((now() at time zone 'Asia/Tokyo')::date)::text"));
  assert.equal(await count('news_articles'),1);assert.equal(await count('gw_marketing_site_publications'),1);
 });
 await test('identical retry returns same mapping and does not insert duplicate',async()=>{
  const retry=await publish();assert.equal(retry.id,saved.id);assert.equal(retry.article_id,saved.article_id);
  assert.equal(retry.requested_at,saved.requested_at);assert.equal(await count('news_articles'),1);
 });
 await test('privileged payload change without version bump rejects stale initial publish and retry',async()=>{
  for(const draft of [D(1),D(9)]){
   await q('update public.gw_marketing_pr_drafts set payload=$1 where id=$2',[JSON.stringify({draft:{title:'管理者による訂正'}}),draft]);
   await rejects(()=>publish({draft}),'PT409');
   await q('update public.gw_marketing_pr_drafts set payload=$1 where id=$2',['{}',draft]);
  }
  assert.equal(await scalar('select count(*)::int from public.gw_marketing_site_publications where draft_id=$1',[D(9)]),0);
  assert.equal(await count('news_articles'),1);
  assert.equal((await publish()).id,saved.id);
 });
 await test('old RPC overload cannot bypass payload snapshot check',async()=>{
  assert.equal(await scalar("select to_regprocedure('public.gw_marketing_publish_site(uuid,uuid,uuid,integer,text,text,text,text)') is null"),true);
 });
 await test('retry with changed hash or body rejected rather than overwrite',async()=>{
  for(const extra of [{hash:'b'.repeat(64)},{title:'別のタイトル'},{summary:'別の要約'},{body:'<p>別の本文</p>'}])await rejects(()=>publish(extra),'PT409');
  assert.equal(await scalar('select body_html from public.news_articles where id=$1',[saved.article_id]),saved.body_html);
 });
 await test('external target edits are not overwritten by retry',async()=>{
  await q('update public.news_articles set body_html=$1,status=$2 where id=$3',['<p>原本管理画面で変更</p>','draft',saved.article_id]);
  const retry=await publish();assert.equal(retry.body_html,saved.body_html);
  assert.equal(await scalar('select status from public.news_articles where id=$1',[saved.article_id]),'draft');
 });
 await test('deterministic slug collision fails without adopting unrelated article',async()=>{
  await q('insert into public.news_articles(article_id,slug,title) values(9,$1,$2)',['press-mkt-'+D(5).replaceAll('-',''),'別の既存記事']);
  await rejects(()=>publish({draft:D(5)}),'PT409');
  assert.equal(await count('news_articles'),2);assert.equal(await count('gw_marketing_site_publications'),1);
 });
 await test('new publication allocates next article number from existing source',async()=>{
  const second=await publish({draft:D(6)});
  assert.equal(await scalar('select article_id from public.news_articles where id=$1',[second.article_id]),10);
 });
 await test('mapping failure rolls back target insert',async()=>{
  await db.exec("alter table public.gw_marketing_site_publications add constraint test_forced_mapping_failure check(title<>'reject-map')");
  const before=await count('news_articles');await rejects(()=>publish({draft:D(7),title:'reject-map'}),'23514');
  assert.equal(await count('news_articles'),before);
  assert.equal(await scalar('select count(*)::int from public.gw_marketing_site_publications where draft_id=$1',[D(7)]),0);
  await db.exec('alter table public.gw_marketing_site_publications drop constraint test_forced_mapping_failure');
 });
 await test('missing existing target privilege fails safely and grants are not widened',async()=>{
  await db.exec('revoke insert on public.news_articles from service_role');
  const before=await count('news_articles');await rejects(()=>publish({draft:D(8)}),'42501');
  assert.equal(await count('news_articles'),before);assert.equal(await scalar('select count(*)::int from public.gw_marketing_site_publications where draft_id=$1',[D(8)]),0);
  await db.exec('grant insert on public.news_articles to service_role');
 });
 await test('publication snapshot keeps registered source intact',async()=>{
  const d=(await q('select status,version,payload from public.gw_marketing_pr_drafts where id=$1',[D(1)])).rows[0];
  assert.equal(d.status,'registered');assert.equal(d.version,2);assert.deepEqual(d.payload,{});
 });
 await test('server can update verification only; snapshot and deletion remain denied',async()=>{
  await as('service_role',()=>q('update public.gw_marketing_site_publications set checked_at=now(),verified_at=now(),last_check=$1 where id=$2',['verified',saved.id]));
  await rejects(()=>as('service_role',()=>q('update public.gw_marketing_site_publications set body_html=$1 where id=$2',['<p>forged</p>',saved.id])),'42501');
  await rejects(()=>as('service_role',()=>q('delete from public.gw_marketing_site_publications where id=$1',[saved.id])),'42501');
 });
 await test('linked records cannot be deleted underneath publication evidence',async()=>{
  await rejects(()=>q('delete from public.news_articles where id=$1',[saved.article_id]),'23001');
  await rejects(()=>q('delete from public.gw_marketing_pr_drafts where id=$1',[D(1)]),'23001');
 });
 await test('read-only deployment check executes and all boolean assertions pass',async()=>{
  const checks=await db.exec(readFileSync(root+'/db/check_proposal_marketing_site_publication.sql','utf8'));
  for(const result of checks)for(const row of result.rows||[])for(const v of Object.values(row))if(typeof v==='boolean')assert.equal(v,true);
 });
 console.log(`${n}/${n} isolated PostgreSQL Marketing publication tests passed (synthetic source data; no live writes).`);
} finally { await db.close(); }
