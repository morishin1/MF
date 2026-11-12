// Disposable in-memory PostgreSQL ONLY. No URL, credentials or live DB input.
// Install @electric-sql/pglite@0.5.12 in a temporary prefix and pass its module path.
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const proposal = `REVOKE ALL PRIVILEGES ON TABLE public.tc_weekly_review FROM anon, authenticated;
DROP POLICY "tc_weekly_review all" ON public.tc_weekly_review;`;
try {
 await db.exec(`
 CREATE ROLE anon;
 CREATE ROLE authenticated;
 CREATE ROLE service_role BYPASSRLS;
 GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
 CREATE TABLE public.tc_weekly_review (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
 week_start date NOT NULL, q1 text, q2 text, q3 text, q4 text,
 eval_total integer, submitted_at timestamptz, UNIQUE(user_id,week_start));
 ALTER TABLE public.tc_weekly_review ENABLE ROW LEVEL SECURITY;
 CREATE POLICY "tc_weekly_review all" ON public.tc_weekly_review
 FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
 GRANT ALL ON public.tc_weekly_review TO anon, authenticated, service_role;
 INSERT INTO public.tc_weekly_review(user_id,week_start,q1) VALUES
 ('00000000-0000-4000-8000-000000000001','2026-11-02','synthetic A'),
 ('00000000-0000-4000-8000-000000000002','2026-11-02','synthetic B');`);
 for (const role of ['anon','authenticated']) {
  await db.exec(`SET ROLE ${role}`);
  assert.equal((await db.query('SELECT q1 FROM public.tc_weekly_review')).rows.length,2);
  await db.exec('RESET ROLE');
 }
 console.log('baseline: both public API roles can read both synthetic owners');
 await db.exec(`BEGIN; ${proposal} ROLLBACK;`);
 assert.equal((await db.query("SELECT has_table_privilege('anon','public.tc_weekly_review','SELECT') AS ok")).rows[0].ok,true);
 console.log('transaction rollback leaves baseline privileges unchanged');
 await db.exec(`BEGIN; ${proposal} COMMIT;`);
 assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.tc_weekly_review'::regclass")).rows[0].relrowsecurity,true);
 for (const role of ['anon','authenticated']) {
  for (const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) {
   assert.equal((await db.query('SELECT has_table_privilege($1,\'public.tc_weekly_review\',$2) AS ok',[role,privilege])).rows[0].ok,false);
  }
  await db.exec(`SET ROLE ${role}`);
  for (const query of [
   'SELECT q1 FROM public.tc_weekly_review',
   "INSERT INTO public.tc_weekly_review(user_id,week_start,q1) VALUES ('00000000-0000-4000-8000-000000000003','2026-11-02','forged')",
   "UPDATE public.tc_weekly_review SET q1='forged'",
   'DELETE FROM public.tc_weekly_review',
   'TRUNCATE public.tc_weekly_review',
  ]) await assert.rejects(db.exec(query),e=>e.code==='42501');
  await db.exec('RESET ROLE');
 }
 console.log('proposal: anon/authenticated SELECT/INSERT/UPDATE/DELETE/TRUNCATE rejected (42501)');
 await db.exec('SET ROLE service_role');
 await db.exec("INSERT INTO public.tc_weekly_review(user_id,week_start,q1) VALUES ('00000000-0000-4000-8000-000000000001','2026-11-02','saved via API') ON CONFLICT(user_id,week_start) DO UPDATE SET q1=excluded.q1;");
 const rows=(await db.query('SELECT q1 FROM public.tc_weekly_review ORDER BY user_id')).rows;
 assert.deepEqual(rows.map(r=>r.q1),['saved via API','synthetic B']);
 await db.exec('RESET ROLE');
 console.log('service_role upsert/read preserved; unrelated synthetic owner unchanged; RLS stays enabled');
 console.log('PASS: disposable PostgreSQL permission migration only; no production access or mutation');
} finally {await db.close();}
