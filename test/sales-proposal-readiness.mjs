import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { assessReadiness, evidenceFor, normalizeReadinessFacts, requiredSkillLines } from '../lib/sales-proposal-readiness.js';

const today = '2026-11-22';
const source = { job_action_type:'proceed', cand_action_type:'proceed' };
const job = {
  skills:['Java','PostgreSQL','C++'],
  detail:'【必須スキル】\n・Javaの開発経験3年以上\n・PostgreSQL\n・C++\n・年齢要件あり\n【尚可】\n・Python',
};
const candidate = { skills:['Java','PostgreSQL','C++','JavaScript'], exp:'5年' };
const fit = evidenceFor(job,candidate);
const all = {
  contact:'direct',hiring:'confirmed',budget:'yes',candidateContact:'direct',intent:'yes',
  dates:'yes',offers:'none',confirmedOn:'2026-11-20',rate:'yes',start:'yes',location:'yes',flow:'yes',
  fitVerified:'yes',note:'類似案件で進行を担当したことを確認',
};
const assess = (facts = all, extra = {}) => assessReadiness({
  facts,source,fit,history:{ meetings:2 },conditions:{ meetingHeld:false },today,...extra,
});

test('the mandatory list is separate from preferred or personal attributes and skills match whole names', () => {
  assert.deepEqual(requiredSkillLines(job.detail), ['Javaの開発経験3年以上','PostgreSQL','C++']);
  assert.deepEqual(evidenceFor(job,{ skills:['JavaScript','C','PostgreSQL'] }).checks.map(c=>c.matches), [[],['PostgreSQL'],[]]);
  assert.deepEqual(fit.matched,['Java','PostgreSQL','C++']);
  assert.equal(fit.grade,'B');
});
test('proposal grades are based on all four weighted axes and verified evidence', () => {
  assert.equal(assess().grade,'A');
  assert.equal(assess().score,100);
  assert.equal(assess().next,'企業に面談候補日を2つ提示');
  assert.equal(assess({...all,fitVerified:''}).grade,'B');
  assert.equal(assess({...all,rate:''}).grade,'B');
  assert.equal(assess({...all,candidateContact:'sheet'}).grade,'C');
  assert.equal(assess({...all,offers:'accepted'}).grade,'C');
  assert.equal(assess({...all,interviewResult:'failed'}).grade,'C');
  assert.equal(assess({interviewResult:'failed'}).next,'企業に見送り理由を確認し、ENGERと共有');
  assert.equal(assess({...all,confirmedOn:'2026-10-31'}).grade,null);
  assert.equal(assess({...all,hiringCount:0}).grade,'C');
  assert.equal(assess(all,{source:{...source,job_action_type:'pass'}}).grade,'C');
  assert.equal(assess(all,{conditions:{unlinked:true}}).grade,null);
  assert.equal(assess(all,{inactive:true}).grade,null);
  assert.equal(assess({}).grade,null);
});
test('facts reject unverifiable/future values and only accept interview outcomes after a held meeting', () => {
  assert.equal(normalizeReadinessFacts({...all,fitVerified:'yes',note:''},today,false),null);
  assert.equal(normalizeReadinessFacts({...all,confirmedOn:'2026-11-30'},today,false),null);
  assert.equal(normalizeReadinessFacts({...all,hiringCount:-1},today,false),null);
  assert.equal(normalizeReadinessFacts({...all,interviewResult:'passed'},today,false),null);
  assert.equal(normalizeReadinessFacts({...all,interviewResult:'passed'},today,true).interviewResult,'passed');
});
test('SQL enforces isolation, revision conflicts, immutable history and owner checks', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.tenants(id uuid primary key);
      create table public.gw_sales_proposals(id uuid primary key, tenant_id uuid references tenants(id), source_system text,
        sales_owner_id uuid, archived_at timestamptz, sent_at timestamptz, contact_stop boolean default false, status text);
      grant select, update on public.gw_sales_proposals to service_role;`);
    await db.exec(await readFile(new URL('../db/189_sales_proposal_readiness.sql',import.meta.url),'utf8'));
    const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12,'0');
    await db.query('insert into public.tenants values ($1),($2)', [id(1),id(6)]);
    await db.query("insert into public.gw_sales_proposals(id,tenant_id,source_system,sales_owner_id,sent_at,status) values ($1,$2,'enger',$3,now(),'meeting_done')", [id(2),id(1),id(3)]);
    const save = (revision, owner = id(3), tenant = id(1)) => db.query(
      'select public.gw_append_sales_proposal_assessment($1,$2,$3,$4,$5,false,$6,$7) as revision',
      [tenant,id(2),revision,id(4),owner,{interviewResult:'passed'},{grade:'A'}]);
    await db.exec('set role anon');
    await assert.rejects(db.query('select * from gw_sales_proposal_latest_results'),{code:'42501'});
    await assert.rejects(save(0),{code:'42501'});
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from gw_sales_proposal_assessments'),{code:'42501'});
    await assert.rejects(save(0),{code:'42501'});
    await db.exec('set role service_role');
    await assert.rejects(save(0,id(5)),{code:'42501'});
    await assert.rejects(save(0,id(3),id(6)),{code:'42501'});
    assert.equal((await save(0)).rows[0].revision,1);
    await assert.rejects(save(0),{code:'40001'});
    assert.equal((await save(1)).rows[0].revision,2);
    assert.equal((await db.query('select interview_result from gw_sales_proposal_latest_results')).rows[0].interview_result,'passed');
    await assert.rejects(db.exec('delete from gw_sales_proposal_assessments'),{code:'42501'});
    const persisted = await db.query('select count(*)::int n from public.gw_sales_proposal_assessments');
    assert.equal(persisted.rows[0].n,2);
    await db.query("update gw_sales_proposals set sales_owner_id = $1", [id(5)]);
    await assert.rejects(save(2),{code:'42501'});
    await db.query("update gw_sales_proposals set status = 'won'");
    await assert.rejects(save(2,id(5)),{code:'42501'});
  } finally { await db.close(); }
});
