// Source review assertions, NOT SQL execution or PostgreSQL validation.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as R from '../lib/hr-pdf-flow.js';
const sql=readFileSync(new URL('../db/proposal_hr_pdf_flow.sql',import.meta.url),'utf8');
let n=0;function t(name,fn){fn();n++;console.log('ok',name);}
t('private dedicated bucket',()=>{assert.equal(R.BUCKET,'hr-pdf-flow');assert.match(sql,/values \('hr-pdf-flow','hr-pdf-flow',false,5242880/);assert.doesNotMatch(sql,/create policy/i);});
t('single applicant flow unique',()=>assert.match(sql,/unique\(tenant_id,applicant_id\)/));
t('all tables RLS and browser grants revoked',()=>{assert.equal((sql.match(/enable row level security/g)||[]).length,5);assert.match(sql,/from public,anon,authenticated,service_role/);});
t('events and migration append only',()=>{assert.match(sql,/grant select,insert on public.gw_hr_pdf_events,public.gw_hr_pdf_legacy_migrations/);assert.match(sql,/immutable_pdf_evidence/);});
t('bytes hash identity and response immutable',()=>{assert.match(sql,/immutable_pdf_bytes/);assert.match(sql,/immutable_pdf_response/);assert.match(sql,/immutable_delivery_snapshot/);});
t('send immutable snapshots retained per request',()=>assert.match(sql,/confirmation_snapshot,status,created_by/));
t('unknown send requires explicit resolution',()=>{assert.match(sql,/interval '5 minutes'/);assert.match(sql,/unresolved_delivery/);});
t('all mutations serialized',()=>{assert.match(sql,/applicant_id=p_applicant for update/);assert.match(sql,/token_hash=p_token and flow_id=f.id and tenant_id=f.tenant_id for update/);});
t('offer response generates no employee account',()=>{assert.doesNotMatch(sql,/insert into public\.gw_employees/);assert.doesNotMatch(sql,/auth\.users/);assert.match(sql,/then 'terms_preparing' else 'onboarding'/);});
t('terms cannot candidate decline',()=>assert.match(sql,/p_action='decline' and d.kind='offer'/));
t('expired view audit precedes deadline rejection',()=>{const respond=sql.slice(sql.indexOf('function public.gw_hr_pdf_respond'));assert.ok(respond.indexOf("p_action='view'")<respond.indexOf('d.expires_at<=ts'));});
t('JST joining date explicit',()=>assert.match(sql,/at time zone 'Asia\/Tokyo'/));
t('document revoke does not cancel hiring',()=>{const revoke=sql.slice(sql.indexOf("elsif p_action='revoke'"),sql.indexOf("elsif p_action='markReady'"));assert.match(revoke,/where id=d.id/);assert.doesNotMatch(revoke,/phase='cancelled'/);assert.match(revoke,/d.responded_at is not null/);});
t('migration never nulls NOT NULL legacy token',()=>{const migration=sql.slice(sql.indexOf('function public.gw_hr_pdf_migrate_unaccepted_legacy'));assert.match(migration,/set revoked_at=coalesce\(revoked_at,now\(\)\)/);assert.doesNotMatch(migration,/token_hash=null/);});
t('migration fresh snapshot after lock',()=>{assert.match(sql,/gw_hr_pdf_legacy_snapshot[\s\S]*?language plpgsql volatile/);const m=sql.slice(sql.indexOf('function public.gw_hr_pdf_migrate_unaccepted_legacy'));assert.ok(m.indexOf('order by id for update')<m.indexOf('s=public.gw_hr_pdf_legacy_snapshot'));assert.match(m,/s is distinct from p_expected/);});
t('migration blocks external pending signatures and old replies',()=>{for(const field of ['accepted_at','declined_at','handoff_at','formal_signed_at','formal_sent_at','legalsign_doc_id','legalsign_doc_sha256','formal_doc_sha256'])assert.match(sql,new RegExp(field));});
t('legacy mail claims guarded independently of feature flag',()=>{assert.match(sql,/before insert on public.gw_hr_mail_sends/);assert.match(sql,/errcode='PT409'/);assert.doesNotMatch(sql,/HR_PDF_FLOW/);});
t('review readiness file is read only',()=>{const c=readFileSync(new URL('../db/check_proposal_hr_pdf_flow.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'');assert.doesNotMatch(c,/\b(insert|update|delete|alter|grant|revoke|create)\b/i);assert.match(c,/pg_policies/);});
t('declaration rejects nonPDF and oversize',()=>{assert.equal(R.declared({kind:'offer',sizeBytes:10,fileName:'x.exe'}),false);assert.equal(R.declared({kind:'offer',sizeBytes:R.MAX_BYTES+1,fileName:'x.pdf'}),false);});
t('expiry bounded and wish date required',()=>{assert.equal(R.expiry('2020-01-01'),null);assert.equal(R.deliveryEvidence({requested:true,evidence:'actual request'}),null);});
t('migration digest binds actor and reason',()=>{const a={tenantId:'t',actorId:'a',applicantId:'c',reason:'reason',requestKey:'k'};assert.notEqual(R.migrationConfirmation({},a).digest,R.migrationConfirmation({},{...a,actorId:'b'}).digest);assert.notEqual(R.migrationConfirmation({},a).digest,R.migrationConfirmation({},{...a,reason:'changed'}).digest);});
console.log(`${n}/${n} PASS (static/pure only; SQL never executed)`);
