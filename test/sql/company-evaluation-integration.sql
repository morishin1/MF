-- PREPARATION ONLY: isolated PostgreSQL 17 CI, synthetic data; never run against Supabase.
-- Invocation: psql -X -v ON_ERROR_STOP=1 -d company_evaluation_ci -f test/sql/company-evaluation-integration.sql
-- No production credentials, downloads, HTTP calls, source records, emails or real people.
\set ON_ERROR_STOP on
-- This must precede EVERY DDL statement (including test helpers and role creation).
DO $$ BEGIN
 IF current_database() IS DISTINCT FROM 'company_evaluation_ci' THEN
  RAISE EXCEPTION 'REFUSED: disposable company_evaluation_ci database required; no DDL performed';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
     AND c.relkind IN ('r','p','v','m','f','S'))
   OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema') THEN
  RAISE EXCEPTION 'REFUSED: expected empty non-system schemas; no DDL performed';
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) THEN
  RAISE EXCEPTION 'REFUSED: synthetic roles already exist; require a fresh disposable CI cluster';
 END IF;
END $$;

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
CREATE TABLE public.tenants(id uuid PRIMARY KEY);
CREATE TABLE public.gw_employees(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants(id),status text NOT NULL);
CREATE TABLE public.gw_sales_companies(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenants(id),name text NOT NULL,owner_id uuid);
CREATE TABLE public.gw_sales_company_links(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,
 source_system text NOT NULL,source_company_id text NOT NULL,company_id uuid NOT NULL REFERENCES public.gw_sales_companies(id) ON DELETE CASCADE,
 UNIQUE(tenant_id,source_system,source_company_id));
-- Claims-only substitutes, not production authorization implementations.
CREATE FUNCTION public.gw_is_sales(p_tenant uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT coalesce(current_setting('ci.sales',true),'false')='true'
   AND p_tenant::text=current_setting('ci.tenant',true)
$$;
CREATE FUNCTION public.gw_sales_is_manager(p_tenant uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT public.gw_is_sales(p_tenant) AND coalesce(current_setting('ci.manager',true),'false')='true'
$$;
CREATE FUNCTION public.gw_employee_id(p_tenant uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN p_tenant::text=current_setting('ci.tenant',true)
   THEN nullif(current_setting('ci.employee',true),'')::uuid ELSE NULL END
$$;
ALTER TABLE public.gw_sales_companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY ci_company_read ON public.gw_sales_companies FOR SELECT TO authenticated USING(public.gw_is_sales(tenant_id));
GRANT SELECT ON public.gw_sales_companies TO authenticated,service_role;
CREATE FUNCTION public.ci_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'CI ASSERTION FAILED: %',label; END IF;
END $$;
CREATE FUNCTION public.ci_expect(sql_text text,wanted text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual text; BEGIN
 BEGIN EXECUTE sql_text; EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS actual=RETURNED_SQLSTATE; END;
 PERFORM public.ci_assert(actual IS NOT DISTINCT FROM wanted,label||' expected '||wanted||' got '||coalesce(actual,'success'));
END $$;
SELECT set_config('ci.base',(date_trunc('second',clock_timestamp())-interval '10 minutes')::text,false);
CREATE FUNCTION public.ci_time(step integer DEFAULT 0) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT current_setting('ci.base')::timestamptz+step*interval '1 minute'
$$;
CREATE FUNCTION public.ci_window(t timestamptz) RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
 SELECT (((t AT TIME ZONE 'Asia/Tokyo')::date-89)::timestamp AT TIME ZONE 'Asia/Tokyo')
$$;
CREATE FUNCTION public.ci_eval(s text DEFAULT 'draft',r text DEFAULT NULL,p text DEFAULT 'normal') RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('version','20261030-ad-v1','scoreMethod','manual_evidence','enforcementEnabled',false,
  'status',s,'rank',r,'policy',p,'reason','synthetic evidence only','reviewedAt',public.ci_time(),
  'improvementDiscussed',true,'noProgressConfirmed',true,
  'scores',CASE WHEN s='confirmed' THEN (SELECT jsonb_object_agg(axis,jsonb_build_object('points',0,'evidence','synthetic','observedAt',public.ci_time()))
    FROM unnest(ARRAY['outcomes','response','reasons','profitability','reliability']) axis) ELSE '{}'::jsonb END,
  'score',CASE WHEN s='confirmed' THEN 0 ELSE NULL END,'suggestedRank',CASE WHEN s='confirmed' THEN 'D' ELSE NULL END)
$$;
CREATE FUNCTION public.ci_summary(id text,sent integer,met integer,qualified integer,unknowns integer DEFAULT 0,won integer DEFAULT 0)
 RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('sourceCompanyId',id,'sentCount',sent,'meetingCount',met,'qualifiedCount',qualified,'unknownReasonCount',unknowns,'wonCount',won)
$$;
INSERT INTO public.tenants VALUES('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
INSERT INTO public.gw_employees VALUES
 ('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','active'),
 ('a0000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','active'),
 ('a0000000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','left'),
 ('a0000000-0000-4000-8000-000000000004','22222222-2222-4222-8222-222222222222','active');
INSERT INTO public.gw_sales_companies VALUES
 ('c0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','synthetic one','a0000000-0000-4000-8000-000000000001'),
 ('c0000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','deletion fixture',NULL),
 ('c0000000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','synthetic three','a0000000-0000-4000-8000-000000000002'),
 ('c0000000-0000-4000-8000-000000000004','11111111-1111-4111-8111-111111111111','synthetic four','a0000000-0000-4000-8000-000000000001'),
 ('c0000000-0000-4000-8000-000000000005','11111111-1111-4111-8111-111111111111','ambiguous source fixture','a0000000-0000-4000-8000-000000000001'),
 ('c0000000-0000-4000-8000-000000000006','11111111-1111-4111-8111-111111111111','inactive owner fixture','a0000000-0000-4000-8000-000000000003'),
 ('c0000000-0000-4000-8000-000000000007','22222222-2222-4222-8222-222222222222','other tenant fixture','a0000000-0000-4000-8000-000000000004');
INSERT INTO public.gw_sales_company_links(tenant_id,source_system,source_company_id,company_id) VALUES
 ('11111111-1111-4111-8111-111111111111','enger','d0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001'),
 ('11111111-1111-4111-8111-111111111111','enger','d0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000003'),
 ('11111111-1111-4111-8111-111111111111','enger','d0000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000004'),
 ('11111111-1111-4111-8111-111111111111','enger','d0000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000005'),
 ('11111111-1111-4111-8111-111111111111','enger','d0000000-0000-4000-8000-000000000005','c0000000-0000-4000-8000-000000000005'),
 ('11111111-1111-4111-8111-111111111111','enger','d0000000-0000-4000-8000-000000000007','c0000000-0000-4000-8000-000000000006'),
 ('22222222-2222-4222-8222-222222222222','enger','d0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000007');

-- Execute the real migrations, not a test copy or approximated schema.
\ir ../../db/153_sales_company_evaluations.sql
\ir ../../db/154_sales_company_review_tasks.sql

SET ROLE service_role;
DO $$ DECLARE v jsonb; a uuid:='11111111-1111-4111-8111-111111111111'; c uuid:='c0000000-0000-4000-8000-000000000001';
 actor uuid:='90000000-0000-4000-8000-000000000001'; request uuid:='e0000000-0000-4000-8000-000000000001'; BEGIN
 v:=public.gw_sales_save_company_evaluation(a,c,actor,0,request,public.ci_eval());
 PERFORM public.ci_assert(v->>'status'='saved' AND v->>'revision'='1' AND jsonb_typeof(v->'revision')='string','first save/string revision');
 PERFORM public.ci_assert((SELECT count(*)=1 FROM public.gw_sales_company_evaluation_history WHERE company_id=c),'atomic first history');
 v:=public.gw_sales_save_company_evaluation(a,c,actor,0,request,public.ci_eval());
 PERFORM public.ci_assert(v->>'status'='replayed','same request replay');
 v:=public.gw_sales_save_company_evaluation(a,c,actor,0,request,public.ci_eval()||'{"reason":"changed"}'::jsonb);
 PERFORM public.ci_assert(v->>'status'='idempotency_conflict','same id changed body conflict');
 v:=public.gw_sales_save_company_evaluation(a,c,actor,0,'e0000000-0000-4000-8000-000000000002',public.ci_eval());
 PERFORM public.ci_assert(v->>'status'='revision_conflict','stale CAS conflict');
 PERFORM public.ci_expect(format('SELECT public.gw_sales_save_company_evaluation(%L,%L,%L,1,%L,%L)',
  '22222222-2222-4222-8222-222222222222',c,actor,'e0000000-0000-4000-8000-000000000003',public.ci_eval()),'P0002','company tenant mismatch');
 PERFORM public.ci_expect(format('SELECT public.gw_sales_save_company_evaluation(%L,%L,%L,1,%L,%L)',
  a,c,actor,'e0000000-0000-4000-8000-000000000004',public.ci_eval('confirmed','D','stopped')||'{"improvementDiscussed":false}'),'22023','D without discussion rejected');
 PERFORM public.ci_expect(format('SELECT public.gw_sales_save_company_evaluation(%L,%L,%L,1,%L,%L)',
  a,c,actor,'e0000000-0000-4000-8000-000000000005',public.ci_eval()||'{"enforcementEnabled":true}'),'22023','enforcement always disabled');
 v:=public.gw_sales_save_company_evaluation(a,c,actor,1,'e0000000-0000-4000-8000-000000000006',public.ci_eval('confirmed','D','stopped'));
 PERFORM public.ci_assert(v->>'status'='saved' AND v->>'revision'='2','D explicit review saved');
 PERFORM public.ci_assert((SELECT count(*)=2 FROM public.gw_sales_company_evaluation_history WHERE company_id=c),'rejected calls add no history');
 -- A replay after a later save returns the ORIGINAL result, not the new revision.
 v:=public.gw_sales_save_company_evaluation(a,c,actor,0,request,public.ci_eval());
 PERFORM public.ci_assert(v->>'revision'='1' AND v->'evaluation'->'evaluation'->>'status'='draft','historical replay result');
END $$;
RESET ROLE;
-- Force a synthetic audit insert failure to prove current-state and history are one transaction.
CREATE FUNCTION public.ci_fail_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.evaluation->>'reason'='FORCE_SYNTHETIC_AUDIT_FAILURE' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ci_fail_history BEFORE INSERT ON public.gw_sales_company_evaluation_history FOR EACH ROW EXECUTE FUNCTION public.ci_fail_history();
SET ROLE service_role;
SELECT public.ci_expect($q$SELECT public.gw_sales_save_company_evaluation('11111111-1111-4111-8111-111111111111','c0000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',2,'e0000000-0000-4000-8000-000000000007',public.ci_eval()||'{"reason":"FORCE_SYNTHETIC_AUDIT_FAILURE"}')$q$,'P0001','failed audit rolls back save');
SELECT public.ci_assert((SELECT revision=2 FROM public.gw_sales_company_evaluations WHERE company_id='c0000000-0000-4000-8000-000000000001'),'current state rolled back');
SELECT public.ci_assert((SELECT count(*)=2 FROM public.gw_sales_company_evaluation_history),'no partial audit after failure');
DO $$ DECLARE v jsonb; scores jsonb; payload jsonb; BEGIN
 scores:=public.ci_eval('confirmed','D','stopped')->'scores';
 scores:=jsonb_set(jsonb_set(scores,'{outcomes,points}','0.1'),'{response,points}','0.2');
 payload:=public.ci_eval()||jsonb_build_object('scores',scores,'score',0.3,'suggestedRank','D');
 v:=public.gw_sales_save_company_evaluation('11111111-1111-4111-8111-111111111111','c0000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001',0,'e0000000-0000-4000-8000-000000000008',payload);
 PERFORM public.ci_assert(v->>'status'='saved','decimal 0.1+0.2');
 scores:=jsonb_set(jsonb_set(jsonb_set(jsonb_set(scores,'{outcomes,points}','19.99999999999'),'{response,points}','20'),'{reasons,points}','20'),'{profitability,points}','20');
 payload:=public.ci_eval()||jsonb_build_object('scores',scores,'score',80,'suggestedRank','A');
 v:=public.gw_sales_save_company_evaluation('11111111-1111-4111-8111-111111111111','c0000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000001',1,'e0000000-0000-4000-8000-000000000009',payload);
 PERFORM public.ci_assert(v->>'status'='saved','10-decimal boundary normalization');
 v:=public.gw_sales_save_company_evaluation('22222222-2222-4222-8222-222222222222','c0000000-0000-4000-8000-000000000007','90000000-0000-4000-8000-000000000002',0,'e0000000-0000-4000-8000-000000000010',public.ci_eval());
 PERFORM public.ci_assert(v->>'status'='saved','separate tenant save');
END $$;
SELECT public.ci_expect('DELETE FROM public.gw_sales_company_evaluations','42501','service has no direct write');
SELECT public.ci_expect('UPDATE public.gw_sales_company_evaluation_history SET revision=revision','42501','history direct update forbidden');
RESET ROLE;
DROP TRIGGER ci_fail_history ON public.gw_sales_company_evaluation_history;
DROP FUNCTION public.ci_fail_history();
DELETE FROM public.gw_sales_companies WHERE id='c0000000-0000-4000-8000-000000000002';
SELECT public.ci_assert((SELECT count(*)=2 FROM public.gw_sales_company_evaluation_history WHERE company_id='c0000000-0000-4000-8000-000000000002'),'company deletion preserves evaluation audit');
SELECT set_config('ci.tenant','11111111-1111-4111-8111-111111111111',false),set_config('ci.sales','true',false),set_config('ci.manager','true',false),set_config('ci.employee','a0000000-0000-4000-8000-000000000001',false);
SET ROLE authenticated;
SELECT public.ci_assert((SELECT count(*)=1 FROM public.gw_sales_company_evaluations),'manager RLS excludes foreign/deleted company');
SELECT public.ci_assert((SELECT count(*)=2 FROM public.gw_sales_company_evaluation_history),'history RLS excludes foreign/deleted company');
SELECT public.ci_expect('DELETE FROM public.gw_sales_company_evaluations','42501','authenticated direct writes forbidden');
SELECT public.ci_expect($q$SELECT public.gw_sales_save_company_evaluation(NULL,NULL,NULL,0,NULL,NULL)$q$,'42501','authenticated cannot call privileged save');
SELECT set_config('ci.manager','false',false);
SELECT public.ci_assert((SELECT count(*)=0 FROM public.gw_sales_company_evaluations),'nonmanager cannot read evaluation');
RESET ROLE;
SET ROLE anon;
SELECT public.ci_expect('SELECT * FROM public.gw_sales_company_evaluations','42501','anon cannot read evaluation');
SELECT public.ci_expect($q$SELECT public.gw_sales_apply_company_review_snapshot(NULL,NULL,NULL,NULL,NULL)$q$,'42501','anon cannot call snapshot');
RESET ROLE;

CREATE FUNCTION public.ci_snapshot_initial() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_array(
 public.ci_summary('d0000000-0000-4000-8000-000000000001',5,0,5),
 public.ci_summary('d0000000-0000-4000-8000-000000000002',10,0,10),
 public.ci_summary('d0000000-0000-4000-8000-000000000003',15,0,10,2),
 public.ci_summary('d0000000-0000-4000-8000-000000000004',5,0,5),
 public.ci_summary('d0000000-0000-4000-8000-000000000005',0,0,0),
 public.ci_summary('d0000000-0000-4000-8000-000000000006',5,0,5),
 public.ci_summary('d0000000-0000-4000-8000-000000000007',5,0,5)) $$;
CREATE FUNCTION public.ci_snapshot_next() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT jsonb_build_array(
 public.ci_summary('d0000000-0000-4000-8000-000000000001',5,1,5),
 public.ci_summary('d0000000-0000-4000-8000-000000000002',10,0,10),
 public.ci_summary('d0000000-0000-4000-8000-000000000003',9,0,9)) $$;
SET ROLE service_role;
DO $$ DECLARE v jsonb; a uuid:='11111111-1111-4111-8111-111111111111'; t timestamptz:=public.ci_time(1); BEGIN
 v:=public.gw_sales_apply_company_review_snapshot(a,'f0000000-0000-4000-8000-000000000001',t,public.ci_window(t),public.ci_snapshot_initial());
 PERFORM public.ci_assert(v->>'status'='applied' AND (v->>'opened')::integer=10,'5/10/15/reason initial tasks');
 PERFORM public.ci_assert((SELECT count(*)=10 FROM public.gw_sales_company_review_tasks WHERE tenant_id=a AND status='open'),'10 open candidates');
 PERFORM public.ci_assert((SELECT count(*)=3 FROM public.gw_sales_company_review_tasks WHERE kind='review_blast_only' OR kind='confirm_loss_reasons' OR (source_company_id='d0000000-0000-4000-8000-000000000002' AND kind='review_proposal_hold')),'specific threshold/reason kinds');
 PERFORM public.ci_assert((SELECT bool_and(due_at IS NULL) FROM public.gw_sales_company_review_tasks),'no invented deadlines');
 PERFORM public.ci_assert((SELECT company_id IS NULL AND assignee_id IS NULL FROM public.gw_sales_company_review_tasks WHERE source_company_id='d0000000-0000-4000-8000-000000000004'),'ambiguous inverse mapping not assigned');
 PERFORM public.ci_assert((SELECT company_id IS NULL AND assignee_id IS NULL FROM public.gw_sales_company_review_tasks WHERE source_company_id='d0000000-0000-4000-8000-000000000006'),'unmapped source not assigned');
 PERFORM public.ci_assert((SELECT company_id IS NOT NULL AND assignee_id IS NULL FROM public.gw_sales_company_review_tasks WHERE source_company_id='d0000000-0000-4000-8000-000000000007'),'inactive owner not assigned');
 v:=public.gw_sales_apply_company_review_snapshot(a,'f0000000-0000-4000-8000-000000000001',t,public.ci_window(t),public.ci_snapshot_initial());
 PERFORM public.ci_assert(v->>'status'='replayed' AND (SELECT count(*)=10 FROM public.gw_sales_company_review_tasks),'snapshot replay creates no duplicates');
 v:=public.gw_sales_apply_company_review_snapshot(a,'f0000000-0000-4000-8000-000000000002',t,public.ci_window(t),public.ci_snapshot_initial());
 PERFORM public.ci_assert(v->>'status'='snapshot_conflict','same time different snapshot conflict');
 v:=public.gw_sales_apply_company_review_snapshot(a,'f0000000-0000-4000-8000-000000000001',t,public.ci_window(t),'[]');
 PERFORM public.ci_assert(v->>'status'='snapshot_conflict','same id different content conflict');
 v:=public.gw_sales_apply_company_review_snapshot(a,'f0000000-0000-4000-8000-000000000003',public.ci_time(),public.ci_window(public.ci_time()),'[]');
 PERFORM public.ci_assert(v->>'status'='stale','older snapshot rejected');
 v:=public.gw_sales_apply_company_review_snapshot(a,'f0000000-0000-4000-8000-000000000004',public.ci_time(2),public.ci_window(public.ci_time(2)),public.ci_snapshot_next());
 PERFORM public.ci_assert(v->>'status'='applied' AND (v->>'cleared')::integer=7 AND (v->>'active')::integer=4,'conditions clear and improvement opens');
 PERFORM public.ci_assert((SELECT count(*)=11 FROM public.gw_sales_company_review_tasks),'cleared task rows retained');
 PERFORM public.ci_assert((SELECT status='open' FROM public.gw_sales_company_review_tasks WHERE source_company_id='d0000000-0000-4000-8000-000000000001' AND kind='review_improvement'),'confirmed stop policy improvement review');
 PERFORM public.ci_assert((SELECT status='cleared' AND cleared_at=public.ci_time(2) FROM public.gw_sales_company_review_tasks WHERE source_company_id='d0000000-0000-4000-8000-000000000003' AND kind='review_blast_only'),'clear is explicit, not completion');
 -- Another tenant with identical ENGER source ID remains separately linked and assigned.
 v:=public.gw_sales_apply_company_review_snapshot('22222222-2222-4222-8222-222222222222','f0000000-0000-4000-8000-000000000005',public.ci_time(2),public.ci_window(public.ci_time(2)),jsonb_build_array(public.ci_summary('d0000000-0000-4000-8000-000000000001',5,0,5)));
 PERFORM public.ci_assert(v->>'status'='applied','tenant B snapshot');
 PERFORM public.ci_assert((SELECT assignee_id='a0000000-0000-4000-8000-000000000004' FROM public.gw_sales_company_review_tasks WHERE tenant_id='22222222-2222-4222-8222-222222222222'),'tenant B exact assignment');
END $$;
-- Invalid snapshots never partially clear/update the existing valid queue.
DO $$ DECLARE a uuid:='11111111-1111-4111-8111-111111111111'; request uuid:='f0000000-0000-4000-8000-000000000006'; t timestamptz:=public.ci_time(3); bad jsonb; BEGIN
 FOREACH bad IN ARRAY ARRAY[
  jsonb_build_array(public.ci_summary('d0000000-0000-4000-8000-000000000001',5,0,5),public.ci_summary('d0000000-0000-4000-8000-000000000001',5,0,5)),
  jsonb_build_array(public.ci_summary('d0000000-0000-4000-8000-000000000001',5,6,5)),
  jsonb_build_array(public.ci_summary('d0000000-0000-4000-8000-000000000001',5,0,5)||'{"email":"synthetic-forbidden-field"}'),
  jsonb_build_array(public.ci_summary('d0000000-0000-4000-8000-000000000001',20000,0,0),public.ci_summary('d0000000-0000-4000-8000-000000000002',1,0,0))
 ] LOOP
  PERFORM public.ci_expect(format('SELECT public.gw_sales_apply_company_review_snapshot(%L,%L,%L,%L,%L)',a,request,t,public.ci_window(t),bad),'22023','invalid snapshot rejected');
 END LOOP;
 PERFORM public.ci_assert((SELECT snapshot_id='f0000000-0000-4000-8000-000000000004' FROM public.gw_sales_company_review_snapshots WHERE tenant_id=a),'invalid snapshot keeps last valid source');
 PERFORM public.ci_assert((SELECT count(*)=4 FROM public.gw_sales_company_review_tasks WHERE tenant_id=a AND status='open'),'invalid snapshot keeps valid queue');
END $$;
SELECT public.ci_expect('UPDATE public.gw_sales_company_review_tasks SET status=status','42501','service direct task update forbidden');
RESET ROLE;
-- RPC task+snapshot transaction integrity: injected snapshot failure must undo task changes.
CREATE FUNCTION public.ci_fail_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic snapshot failure'; END $$;
CREATE TRIGGER ci_fail_snapshot BEFORE UPDATE ON public.gw_sales_company_review_snapshots FOR EACH ROW EXECUTE FUNCTION public.ci_fail_snapshot();
SET ROLE service_role;
SELECT public.ci_expect($q$SELECT public.gw_sales_apply_company_review_snapshot('11111111-1111-4111-8111-111111111111','f0000000-0000-4000-8000-000000000007',public.ci_time(3),public.ci_window(public.ci_time(3)),'[]')$q$,'P0001','snapshot failure rolls back task clears');
SELECT public.ci_assert((SELECT count(*)=4 FROM public.gw_sales_company_review_tasks WHERE tenant_id='11111111-1111-4111-8111-111111111111' AND status='open'),'no partial task clear');
RESET ROLE;
DROP TRIGGER ci_fail_snapshot ON public.gw_sales_company_review_snapshots;
DROP FUNCTION public.ci_fail_snapshot();
SELECT set_config('ci.manager','false',false);
SET ROLE authenticated;
SELECT public.ci_assert((SELECT count(*)=6 FROM public.gw_sales_company_review_tasks),'employee sees only assigned retained task rows');
SELECT public.ci_assert((SELECT count(*)=2 FROM public.gw_sales_company_review_tasks WHERE status='open'),'employee open queue only assigned');
SELECT public.ci_assert((SELECT count(*)=0 FROM public.gw_sales_company_review_snapshots),'employee cannot read raw snapshots');
SELECT public.ci_expect('DELETE FROM public.gw_sales_company_review_tasks','42501','employee cannot mutate tasks');
SELECT public.ci_expect($q$SELECT public.gw_sales_apply_company_review_snapshot(NULL,NULL,NULL,NULL,NULL)$q$,'42501','employee cannot call apply');
SELECT set_config('ci.manager','true',false);
SELECT public.ci_assert((SELECT count(*)=11 FROM public.gw_sales_company_review_tasks),'manager sees tenant A tasks only');
SELECT public.ci_assert((SELECT count(*)=1 FROM public.gw_sales_company_review_snapshots),'manager sees tenant A snapshot only');
SELECT set_config('ci.sales','false',false);
SELECT public.ci_assert((SELECT count(*)=0 FROM public.gw_sales_company_review_tasks),'sales access required');
RESET ROLE;
-- Clearing and reopening use the same task identity and original first_seen.
SET ROLE service_role;
DO $$ DECLARE v jsonb; original_id uuid; BEGIN
 SELECT id INTO original_id FROM public.gw_sales_company_review_tasks WHERE tenant_id='11111111-1111-4111-8111-111111111111' AND source_company_id='d0000000-0000-4000-8000-000000000003' AND kind='review_blast_only';
 v:=public.gw_sales_apply_company_review_snapshot('11111111-1111-4111-8111-111111111111','f0000000-0000-4000-8000-000000000008',public.ci_time(4),public.ci_window(public.ci_time(4)),public.ci_snapshot_initial());
 PERFORM public.ci_assert((v->>'reopened')::integer=7,'cleared tasks reopen without duplication');
 PERFORM public.ci_assert((SELECT id=original_id AND status='open' AND cleared_at IS NULL AND first_seen=public.ci_time(1) FROM public.gw_sales_company_review_tasks WHERE id=original_id),'reopen keeps identity/first seen');
 PERFORM public.ci_assert((SELECT count(*)=11 FROM public.gw_sales_company_review_tasks WHERE tenant_id='11111111-1111-4111-8111-111111111111'),'no duplicate tasks on reopen');
END $$;
RESET ROLE;
SELECT 'PASS company evaluation disposable PostgreSQL integration' AS result;
