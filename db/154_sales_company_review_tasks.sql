-- MF / 森田さん実行用・未実行。153の後に適用。業務データ更新・メール配信なし。
-- HMAC検証済みENGER全件90日summary専用。APIが署名/完全性/固定tenantを確認する。
-- partial/途中取得失敗を呼出してはいけない。DBは集計元の完全性自体を独立証明できない。
-- 5/10/15・理由・改善の審査タスクのみ。自動条件解消はclearedであり人間の完了ではない。
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF to_regclass('public.gw_sales_company_evaluations') IS NULL
   OR to_regclass('public.gw_sales_company_links') IS NULL
   OR to_regclass('public.gw_sales_companies') IS NULL
   OR to_regclass('public.gw_employees') IS NULL
   OR to_regprocedure('public.gw_is_sales(uuid)') IS NULL
   OR to_regprocedure('public.gw_sales_is_manager(uuid)') IS NULL
   OR to_regprocedure('public.gw_employee_id(uuid)') IS NULL THEN
  RAISE EXCEPTION '154 prerequisites missing; no changes applied';
 END IF;
 IF to_regclass('public.gw_sales_company_review_snapshots') IS NOT NULL
   OR to_regclass('public.gw_sales_company_review_tasks') IS NOT NULL THEN
  RAISE EXCEPTION '154 already exists; verify installed version instead of overwriting';
 END IF;
END $$;
CREATE TABLE public.gw_sales_company_review_snapshots (
 tenant_id uuid PRIMARY KEY,
 snapshot_id uuid NOT NULL,
 observed_at timestamptz NOT NULL,
 window_start timestamptz NOT NULL,
 companies jsonb NOT NULL CHECK(jsonb_typeof(companies)='array'),
 applied_at timestamptz NOT NULL
);
CREATE TABLE public.gw_sales_company_review_tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 source_company_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('alert_owner','review_proposal_hold','review_blast_only','confirm_loss_reasons','review_improvement')),
 status text NOT NULL CHECK(status IN ('open','cleared')),
 company_id uuid,
 assignee_id uuid,
 due_at timestamptz,
 first_seen timestamptz NOT NULL,
 last_seen timestamptz NOT NULL,
 cleared_at timestamptz,
 snapshot_id uuid NOT NULL,
 counts jsonb NOT NULL CHECK(jsonb_typeof(counts)='object'),
 UNIQUE(tenant_id,source_company_id,kind),
 CHECK((status='open' AND cleared_at IS NULL) OR (status='cleared' AND cleared_at IS NOT NULL))
);
CREATE INDEX gw_sales_company_review_tasks_open ON public.gw_sales_company_review_tasks(tenant_id,status,last_seen DESC);
COMMENT ON TABLE public.gw_sales_company_review_snapshots IS '署名検証済み全件ENGER90日summaryの最終スナップショット。個人/メール/根拠本文なし。db154';
COMMENT ON TABLE public.gw_sales_company_review_tasks IS '確認・保留審査・ブラスト移行審査・理由確認・改善再審査の候補。通知・停止・配信の実行ではない。clearedは条件消失、完了ではない。db154';
ALTER TABLE public.gw_sales_company_review_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gw_sales_company_review_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_sales_company_review_snapshots,public.gw_sales_company_review_tasks FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.gw_sales_company_review_snapshots,public.gw_sales_company_review_tasks TO authenticated,service_role;
CREATE POLICY gw_sales_company_review_snapshots_read ON public.gw_sales_company_review_snapshots FOR SELECT TO authenticated
 USING(public.gw_is_sales(tenant_id) AND public.gw_sales_is_manager(tenant_id));
CREATE POLICY gw_sales_company_review_tasks_read ON public.gw_sales_company_review_tasks FOR SELECT TO authenticated
 USING(public.gw_is_sales(tenant_id) AND
  (public.gw_sales_is_manager(tenant_id) OR assignee_id=public.gw_employee_id(tenant_id)));

CREATE FUNCTION public.gw_sales_apply_company_review_snapshot(
 p_tenant uuid,p_snapshot_id uuid,p_observed_at timestamptz,p_window_start timestamptz,p_companies jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
AS $$
DECLARE
 v_previous public.gw_sales_company_review_snapshots%ROWTYPE;
 v_row jsonb;
 v_key text;
 v_count numeric;
 v_total bigint:=0;
 v_expected_start timestamptz;
 v_desired jsonb;
 v_opened integer;
 v_reopened integer;
 v_cleared integer;
 v_active integer;
BEGIN
 IF p_tenant IS NULL OR p_snapshot_id IS NULL OR p_observed_at IS NULL OR p_window_start IS NULL
   OR NOT isfinite(p_observed_at) OR NOT isfinite(p_window_start)
   OR p_observed_at>statement_timestamp() THEN
  RAISE EXCEPTION 'invalid_snapshot_time' USING ERRCODE='22023';
 END IF;
 v_expected_start:=(((p_observed_at AT TIME ZONE 'Asia/Tokyo')::date-89)::timestamp AT TIME ZONE 'Asia/Tokyo');
 IF p_window_start<>v_expected_start THEN
  RAISE EXCEPTION 'invalid_90_day_window' USING ERRCODE='22023';
 END IF;
 IF p_companies IS NULL OR jsonb_typeof(p_companies)<>'array' OR octet_length(p_companies::text)>3000000 THEN
  RAISE EXCEPTION 'invalid_snapshot_payload' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(p_companies)>5000 THEN RAISE EXCEPTION 'company_limit' USING ERRCODE='22023'; END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(p_companies) LOOP
  IF jsonb_typeof(v_row)<>'object' THEN RAISE EXCEPTION 'invalid_company_summary' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v_row))<>6 OR EXISTS(
    SELECT 1 FROM jsonb_object_keys(v_row) k WHERE k NOT IN
     ('sourceCompanyId','sentCount','meetingCount','qualifiedCount','unknownReasonCount','wonCount'))
    OR jsonb_typeof(v_row->'sourceCompanyId') IS DISTINCT FROM 'string'
    OR (v_row->>'sourceCompanyId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   RAISE EXCEPTION 'invalid_company_identity_or_fields' USING ERRCODE='22023';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['sentCount','meetingCount','qualifiedCount','unknownReasonCount','wonCount'] LOOP
   IF jsonb_typeof(v_row->v_key) IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid_count' USING ERRCODE='22023'; END IF;
   v_count:=(v_row->>v_key)::numeric;
   IF v_count<0 OR v_count>20000 OR v_count<>trunc(v_count) THEN RAISE EXCEPTION 'invalid_count' USING ERRCODE='22023'; END IF;
   IF v_key<>'sentCount' AND v_count>(v_row->>'sentCount')::numeric THEN
    RAISE EXCEPTION 'count_exceeds_sent' USING ERRCODE='22023';
   END IF;
  END LOOP;
  IF (v_row->>'qualifiedCount')::integer < (v_row->>'meetingCount')::integer
    OR (v_row->>'qualifiedCount')::integer < (v_row->>'wonCount')::integer
    OR (v_row->>'unknownReasonCount')::integer > (v_row->>'qualifiedCount')::integer
    OR (v_row->>'wonCount')::integer > (v_row->>'meetingCount')::integer THEN
   RAISE EXCEPTION 'inconsistent_company_counts' USING ERRCODE='22023';
  END IF;
  v_total:=v_total+(v_row->>'sentCount')::bigint;
 END LOOP;
 IF v_total>20000 THEN RAISE EXCEPTION 'proposal_limit' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_companies) x GROUP BY x->>'sourceCompanyId' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'duplicate_company_identity' USING ERRCODE='22023';
 END IF;
 -- Existing FK metadata verifies public.tenants(id); reject a mistyped configured tenant.
 PERFORM 1 FROM public.tenants WHERE id=p_tenant;
 IF NOT FOUND THEN RAISE EXCEPTION 'tenant_not_found' USING ERRCODE='P0002'; END IF;
 -- A tenant-level lock covers first snapshot and all task transitions in one transaction.
 PERFORM pg_advisory_xact_lock(hashtextextended('company-review:'||p_tenant::text,0));
 SELECT * INTO v_previous FROM public.gw_sales_company_review_snapshots WHERE tenant_id=p_tenant FOR UPDATE;
 IF FOUND THEN
  IF v_previous.snapshot_id=p_snapshot_id THEN
   IF v_previous.observed_at=p_observed_at AND v_previous.window_start=p_window_start AND v_previous.companies=p_companies THEN
    RETURN jsonb_build_object('status','replayed','snapshotId',p_snapshot_id);
   END IF;
   RETURN jsonb_build_object('status','snapshot_conflict');
  END IF;
  IF p_observed_at=v_previous.observed_at THEN
   RETURN jsonb_build_object('status','snapshot_conflict');
  END IF;
  IF p_observed_at<v_previous.observed_at THEN
   RETURN jsonb_build_object('status','stale','observedAt',v_previous.observed_at);
  END IF;
 END IF;
 -- Exact source UUID only; never resolve by company name/domain here.
 -- Ambiguous inverse mappings are intentionally left unassigned, not silently merged.
 WITH records AS (
  SELECT (x->>'sourceCompanyId')::uuid AS source_id,x AS counts,
   (x->>'sentCount')::integer AS sent,(x->>'meetingCount')::integer AS met,
   (x->>'unknownReasonCount')::integer AS unknown_reasons
  FROM jsonb_array_elements(p_companies) x
 ), mapped AS (
  SELECT r.*,c.id AS company_id,
   CASE WHEN e.id IS NOT NULL THEN c.owner_id ELSE NULL END AS assignee_id,
   ev.evaluation AS evaluation
  FROM records r
  LEFT JOIN LATERAL (
   SELECT min(l.company_id::text)::uuid AS company_id
   FROM public.gw_sales_company_links l
   WHERE l.tenant_id=p_tenant AND l.source_system='enger' AND l.source_company_id=r.source_id::text
   HAVING count(*)=1
  ) link ON true
  LEFT JOIN public.gw_sales_companies c ON c.id=link.company_id AND c.tenant_id=p_tenant
   AND NOT EXISTS(SELECT 1 FROM public.gw_sales_company_links other
     WHERE other.tenant_id=p_tenant AND other.source_system='enger' AND other.company_id=c.id
      AND other.source_company_id<>r.source_id::text)
  LEFT JOIN public.gw_employees e ON e.id=c.owner_id AND e.tenant_id=p_tenant AND e.status='active'
  LEFT JOIN public.gw_sales_company_evaluations ev ON ev.tenant_id=p_tenant AND ev.company_id=c.id
 ), desired AS (
  SELECT m.source_id,m.company_id,m.assignee_id,m.counts,a.kind
  FROM mapped m CROSS JOIN LATERAL (VALUES
   ('alert_owner',m.sent>=5 AND m.met=0),
   ('review_proposal_hold',m.sent>=10 AND m.met=0),
   ('review_blast_only',m.sent>=15 AND m.met=0),
   ('confirm_loss_reasons',m.unknown_reasons>0),
   ('review_improvement',m.met>0 AND m.evaluation->>'status'='confirmed'
      AND m.evaluation->>'policy' IN ('hold','stopped','blast_only'))
  ) a(kind,wanted) WHERE a.wanted IS TRUE
 ) SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY source_id,kind),'[]'::jsonb) INTO v_desired FROM desired d;
 SELECT count(*) FILTER(WHERE t.id IS NULL),count(*) FILTER(WHERE t.status='cleared')
 INTO v_opened,v_reopened
 FROM jsonb_to_recordset(v_desired) d(source_id uuid,kind text)
 LEFT JOIN public.gw_sales_company_review_tasks t ON t.tenant_id=p_tenant AND t.source_company_id=d.source_id AND t.kind=d.kind;
 INSERT INTO public.gw_sales_company_review_tasks
  (tenant_id,source_company_id,kind,status,company_id,assignee_id,due_at,first_seen,last_seen,cleared_at,snapshot_id,counts)
 SELECT p_tenant,d.source_id,d.kind,'open',d.company_id,d.assignee_id,NULL,p_observed_at,p_observed_at,NULL,p_snapshot_id,d.counts
 FROM jsonb_to_recordset(v_desired) d(source_id uuid,kind text,company_id uuid,assignee_id uuid,counts jsonb)
 ON CONFLICT(tenant_id,source_company_id,kind) DO UPDATE SET status='open',company_id=EXCLUDED.company_id,
  assignee_id=EXCLUDED.assignee_id,last_seen=EXCLUDED.last_seen,cleared_at=NULL,snapshot_id=EXCLUDED.snapshot_id,counts=EXCLUDED.counts;
 GET DIAGNOSTICS v_active=ROW_COUNT;
 UPDATE public.gw_sales_company_review_tasks t SET status='cleared',cleared_at=p_observed_at,snapshot_id=p_snapshot_id
 WHERE t.tenant_id=p_tenant AND t.status='open' AND NOT EXISTS(
  SELECT 1 FROM jsonb_to_recordset(v_desired) d(source_id uuid,kind text)
  WHERE d.source_id=t.source_company_id AND d.kind=t.kind);
 GET DIAGNOSTICS v_cleared=ROW_COUNT;
 INSERT INTO public.gw_sales_company_review_snapshots(tenant_id,snapshot_id,observed_at,window_start,companies,applied_at)
 VALUES(p_tenant,p_snapshot_id,p_observed_at,p_window_start,p_companies,statement_timestamp())
 ON CONFLICT(tenant_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,observed_at=EXCLUDED.observed_at,
  window_start=EXCLUDED.window_start,companies=EXCLUDED.companies,applied_at=EXCLUDED.applied_at;
 RETURN jsonb_build_object('status','applied','snapshotId',p_snapshot_id,'opened',v_opened,
  'reopened',v_reopened,'cleared',v_cleared,'active',v_active);
END $$;
REVOKE ALL ON FUNCTION public.gw_sales_apply_company_review_snapshot(uuid,uuid,timestamptz,timestamptz,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gw_sales_apply_company_review_snapshot(uuid,uuid,timestamptz,timestamptz,jsonb) TO service_role;
COMMENT ON FUNCTION public.gw_sales_apply_company_review_snapshot(uuid,uuid,timestamptz,timestamptz,jsonb) IS
 'Service-role-only trusted complete signed snapshot. Fixed tenant/HMAC at API. Atomic idempotent candidate tasks, no enforcement/notifications.';
COMMIT;
