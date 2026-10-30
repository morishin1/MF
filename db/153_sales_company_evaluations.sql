-- MF only / 森田さん実行用・未実行。2026-10-30実スキーマ確認後の追加SQL。
-- 既存企業マスタ・営業状態・配信・ENGER・権限ルールを変更しない。
-- 企業評価sidecarと履歴のみ。confirmedも参考審査の保存であり、実停止・送信を行わない。
-- API MUST authenticate, resolve its own tenant/actor, require canSell and STRICT same-tenant
-- membership role=admin OR active owner role (NOT ctx.isAdmin, which includes staff).
-- Only trusted service-role RPC can write. Managers may read under existing RLS predicates.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DO $$ BEGIN
  IF to_regclass('public.gw_sales_companies') IS NULL
     OR to_regprocedure('public.gw_is_sales(uuid)') IS NULL
     OR to_regprocedure('public.gw_sales_is_manager(uuid)') IS NULL THEN
    RAISE EXCEPTION '153 prerequisites missing; no changes applied';
  END IF;
  IF to_regclass('public.gw_sales_company_evaluations') IS NOT NULL
     OR to_regclass('public.gw_sales_company_evaluation_history') IS NOT NULL THEN
    RAISE EXCEPTION '153 already exists; verify installed version instead of overwriting';
  END IF;
END $$;

CREATE TABLE public.gw_sales_company_evaluations (
  tenant_id uuid NOT NULL,
  -- Deliberately no FK to the company master: existing bulk deletion must remain unchanged.
  -- RPC validates and locks a live same-tenant company; orphaned history is retained but hidden by RLS.
  company_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  evaluation jsonb NOT NULL CHECK (jsonb_typeof(evaluation) = 'object')
    CHECK (evaluation->'enforcementEnabled' IS NOT DISTINCT FROM 'false'::jsonb),
  updated_at timestamptz NOT NULL,
  updated_by uuid NOT NULL,
  PRIMARY KEY (tenant_id, company_id)
);
CREATE TABLE public.gw_sales_company_evaluation_history (
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('draft_saved','decision_confirmed')),
  evaluation jsonb NOT NULL CHECK (jsonb_typeof(evaluation) = 'object')
    CHECK (evaluation->'enforcementEnabled' IS NOT DISTINCT FROM 'false'::jsonb),
  created_at timestamptz NOT NULL,
  actor_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, company_id, revision),
  UNIQUE (tenant_id, request_id),
  FOREIGN KEY (tenant_id, company_id)
    REFERENCES public.gw_sales_company_evaluations(tenant_id, company_id) ON DELETE RESTRICT
);
COMMENT ON TABLE public.gw_sales_company_evaluations IS
  'A-D評価sidecar。企業マスタではない。審査保存のみ、営業停止・メール配信に接続しない。db153';
COMMENT ON TABLE public.gw_sales_company_evaluation_history IS
  '評価の保存と同一TXで追加する監査履歴。service_roleにも直接DMLを許可しない。db153';
ALTER TABLE public.gw_sales_company_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gw_sales_company_evaluation_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_sales_company_evaluations, public.gw_sales_company_evaluation_history
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.gw_sales_company_evaluations, public.gw_sales_company_evaluation_history
  TO authenticated, service_role;
CREATE POLICY gw_sales_company_evaluations_read ON public.gw_sales_company_evaluations
  FOR SELECT TO authenticated USING (
    public.gw_is_sales(tenant_id) AND public.gw_sales_is_manager(tenant_id)
    AND EXISTS (SELECT 1 FROM public.gw_sales_companies c
      WHERE c.id = company_id AND c.tenant_id = gw_sales_company_evaluations.tenant_id)
  );
CREATE POLICY gw_sales_company_evaluation_history_read ON public.gw_sales_company_evaluation_history
  FOR SELECT TO authenticated USING (
    public.gw_is_sales(tenant_id) AND public.gw_sales_is_manager(tenant_id)
    AND EXISTS (SELECT 1 FROM public.gw_sales_companies c
      WHERE c.id = company_id AND c.tenant_id = gw_sales_company_evaluation_history.tenant_id)
  );

CREATE FUNCTION public.gw_sales_save_company_evaluation(
  p_tenant uuid, p_company uuid, p_actor uuid, p_expected_revision bigint,
  p_request_id uuid, p_evaluation jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_previous public.gw_sales_company_evaluations%ROWTYPE;
  v_replay public.gw_sales_company_evaluation_history%ROWTYPE;
  v_saved public.gw_sales_company_evaluations%ROWTYPE;
  v_now timestamptz := statement_timestamp();
  v_since timestamptz;
  v_status text;
  v_axis text;
  v_max numeric;
  v_part jsonb;
  v_points numeric;
  v_observed timestamptz;
  v_reviewed timestamptz;
  v_total numeric := 0;
  v_complete boolean := true;
  v_suggested text;
  v_revision bigint;
BEGIN
  IF p_tenant IS NULL OR p_company IS NULL OR p_actor IS NULL OR p_request_id IS NULL
     OR p_expected_revision IS NULL OR p_expected_revision < 0 THEN
    RAISE EXCEPTION 'invalid_arguments' USING ERRCODE = '22023';
  END IF;
  IF p_evaluation IS NULL OR jsonb_typeof(p_evaluation) <> 'object'
     OR octet_length(p_evaluation::text) > 20000 THEN
    RAISE EXCEPTION 'invalid_evaluation' USING ERRCODE = '22023';
  END IF;
  -- Exact request lock before company lock prevents duplicate requests racing across companies.
  -- Hash collisions only serialize unrelated operations; they cannot authorize or merge records.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || ':' || p_request_id::text, 0));
  PERFORM 1 FROM public.gw_sales_companies c WHERE c.id = p_company AND c.tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'company_not_found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_replay FROM public.gw_sales_company_evaluation_history
    WHERE tenant_id = p_tenant AND request_id = p_request_id;
  IF FOUND THEN
    IF v_replay.company_id <> p_company OR v_replay.actor_id <> p_actor
       OR v_replay.expected_revision <> p_expected_revision OR v_replay.evaluation <> p_evaluation THEN
      RETURN jsonb_build_object('status','idempotency_conflict');
    END IF;
    RETURN jsonb_build_object('status','replayed','revision',v_replay.revision::text,
      'evaluation',jsonb_build_object('tenant_id',v_replay.tenant_id,'company_id',v_replay.company_id,
        'revision',v_replay.revision::text,'evaluation',v_replay.evaluation,
        'updated_at',v_replay.created_at,'updated_by',v_replay.actor_id));
  END IF;
  SELECT * INTO v_previous FROM public.gw_sales_company_evaluations
    WHERE tenant_id = p_tenant AND company_id = p_company FOR UPDATE;
  IF coalesce(v_previous.revision,0) <> p_expected_revision THEN
    RETURN jsonb_build_object('status','revision_conflict','revision',coalesce(v_previous.revision,0)::text);
  END IF;
  IF p_expected_revision = 9223372036854775807 THEN
    RAISE EXCEPTION 'revision_exhausted' USING ERRCODE = '22023';
  END IF;
  -- Strict contract: arbitrary payload fields cannot become an unbounded personal-data store.
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_evaluation) k WHERE k NOT IN
    ('version','scoreMethod','scores','score','suggestedRank','enforcementEnabled','status',
     'rank','policy','reason','reviewedAt','improvementDiscussed','noProgressConfirmed'))
     OR p_evaluation->>'version' IS DISTINCT FROM '20261030-ad-v1'
     OR p_evaluation->>'scoreMethod' IS DISTINCT FROM 'manual_evidence'
     OR p_evaluation->'enforcementEnabled' IS DISTINCT FROM 'false'::jsonb
     OR jsonb_typeof(p_evaluation->'scores') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_evaluation->'reason') IS DISTINCT FROM 'string'
     OR length(p_evaluation->>'reason') > 2000
     OR jsonb_typeof(p_evaluation->'improvementDiscussed') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_evaluation->'noProgressConfirmed') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_evaluation->'reviewedAt') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'invalid_evaluation_contract' USING ERRCODE = '22023';
  END IF;
  v_status := p_evaluation->>'status';
  IF v_status IS NULL OR v_status NOT IN ('draft','confirmed')
     OR p_evaluation->>'policy' IS NULL
     OR p_evaluation->>'policy' NOT IN ('normal','restricted','hold','stopped','blast_only') THEN
    RAISE EXCEPTION 'invalid_status_or_policy' USING ERRCODE = '22023';
  END IF;
  BEGIN v_reviewed := (p_evaluation->>'reviewedAt')::timestamptz;
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid_review_time' USING ERRCODE = '22023'; END;
  v_since := (((v_now AT TIME ZONE 'Asia/Tokyo')::date - 89)::timestamp AT TIME ZONE 'Asia/Tokyo');
  IF NOT isfinite(v_reviewed) OR v_reviewed > v_now OR v_reviewed < v_since THEN
    RAISE EXCEPTION 'invalid_review_time' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_evaluation->'scores') k
    WHERE k NOT IN ('outcomes','response','reasons','profitability','reliability')) THEN
    RAISE EXCEPTION 'invalid_score_axis' USING ERRCODE = '22023';
  END IF;
  FOREACH v_axis IN ARRAY ARRAY['outcomes','response','reasons','profitability','reliability'] LOOP
    v_max := CASE v_axis WHEN 'outcomes' THEN 30 WHEN 'reliability' THEN 10 ELSE 20 END;
    v_part := p_evaluation->'scores'->v_axis;
    IF v_part IS NULL OR v_part = 'null'::jsonb THEN v_complete := false; CONTINUE; END IF;
    IF jsonb_typeof(v_part) <> 'object' OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_part) k
      WHERE k NOT IN ('points','evidence','observedAt')) THEN
      RAISE EXCEPTION 'invalid_axis_shape' USING ERRCODE = '22023';
    END IF;
    IF v_part->'evidence' IS NOT NULL AND v_part->'evidence' <> 'null'::jsonb AND
       (jsonb_typeof(v_part->'evidence') <> 'string' OR length(v_part->>'evidence') > 500) THEN
      RAISE EXCEPTION 'invalid_evidence' USING ERRCODE = '22023';
    END IF;
    IF v_part->'points' IS NULL OR v_part->'points' = 'null'::jsonb THEN v_complete := false; CONTINUE; END IF;
    IF jsonb_typeof(v_part->'points') <> 'number' THEN
      RAISE EXCEPTION 'invalid_points' USING ERRCODE = '22023';
    END IF;
    v_points := (v_part->>'points')::numeric;
    IF v_points < 0 OR v_points > v_max THEN RAISE EXCEPTION 'invalid_points' USING ERRCODE = '22023'; END IF;
    IF nullif(btrim(v_part->>'evidence'),'') IS NULL OR v_part->'observedAt' IS NULL
       OR v_part->'observedAt' = 'null'::jsonb THEN v_complete := false; CONTINUE; END IF;
    IF jsonb_typeof(v_part->'observedAt') <> 'string' THEN
      RAISE EXCEPTION 'invalid_observed_time' USING ERRCODE = '22023';
    END IF;
    BEGIN v_observed := (v_part->>'observedAt')::timestamptz;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'invalid_observed_time' USING ERRCODE = '22023'; END;
    IF NOT isfinite(v_observed) OR v_observed < v_since OR v_observed > v_now THEN
      v_complete := false; CONTINUE;
    END IF;
    v_total := v_total + v_points;
  END LOOP;
  IF v_complete THEN
    -- Match the API's 10-decimal score normalization before rank boundaries.
    v_total := round(v_total, 10);
    v_suggested := CASE WHEN v_total >= 80 THEN 'A' WHEN v_total >= 60 THEN 'B' WHEN v_total >= 40 THEN 'C' ELSE 'D' END;
    IF jsonb_typeof(p_evaluation->'score') IS DISTINCT FROM 'number'
       OR abs((p_evaluation->>'score')::numeric - v_total) > 0.000000001
       OR p_evaluation->>'suggestedRank' IS DISTINCT FROM v_suggested THEN
      RAISE EXCEPTION 'derived_score_mismatch' USING ERRCODE = '22023';
    END IF;
  ELSIF p_evaluation->'score' IS DISTINCT FROM 'null'::jsonb
     OR p_evaluation->'suggestedRank' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'incomplete_scores_must_be_null' USING ERRCODE = '22023';
  END IF;
  IF v_status = 'draft' THEN
    IF p_evaluation->'rank' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'draft_rank_must_be_null' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF NOT v_complete OR p_evaluation->>'rank' IS NULL OR p_evaluation->>'rank' NOT IN ('A','B','C','D')
       OR nullif(btrim(p_evaluation->>'reason'),'') IS NULL THEN
      RAISE EXCEPTION 'confirmed_requires_evidence_rank_reason' USING ERRCODE = '22023';
    END IF;
    IF p_evaluation->>'rank' = 'D' AND
      (p_evaluation->'improvementDiscussed' <> 'true'::jsonb OR p_evaluation->'noProgressConfirmed' <> 'true'::jsonb
       OR p_evaluation->>'policy' NOT IN ('stopped','blast_only')) THEN
      RAISE EXCEPTION 'D_requires_improvement_review' USING ERRCODE = '22023';
    END IF;
    IF p_evaluation->>'rank' <> 'D' AND p_evaluation->>'policy' = 'stopped' THEN
      RAISE EXCEPTION 'stopped_requires_D' USING ERRCODE = '22023';
    END IF;
  END IF;
  v_revision := p_expected_revision + 1;
  INSERT INTO public.gw_sales_company_evaluations(tenant_id,company_id,revision,evaluation,updated_at,updated_by)
    VALUES(p_tenant,p_company,v_revision,p_evaluation,v_now,p_actor)
    ON CONFLICT (tenant_id,company_id) DO UPDATE SET revision=EXCLUDED.revision,
      evaluation=EXCLUDED.evaluation,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by
    RETURNING * INTO v_saved;
  INSERT INTO public.gw_sales_company_evaluation_history
    (tenant_id,company_id,revision,expected_revision,request_id,action,evaluation,created_at,actor_id)
    VALUES(p_tenant,p_company,v_revision,p_expected_revision,p_request_id,
      CASE v_status WHEN 'confirmed' THEN 'decision_confirmed' ELSE 'draft_saved' END,p_evaluation,v_now,p_actor);
  RETURN jsonb_build_object('status','saved','revision',v_revision::text,
    'evaluation',to_jsonb(v_saved) || jsonb_build_object('revision',v_revision::text));
END $$;
REVOKE ALL ON FUNCTION public.gw_sales_save_company_evaluation(uuid,uuid,uuid,bigint,uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gw_sales_save_company_evaluation(uuid,uuid,uuid,bigint,uuid,jsonb) TO service_role;
COMMENT ON FUNCTION public.gw_sales_save_company_evaluation(uuid,uuid,uuid,bigint,uuid,jsonb) IS
  'Service-role-only atomic evaluation+audit save. API must verify strict admin/owner, tenant and actor. CAS/idempotency. Never activates enforcement.';
COMMIT;
-- 実行後のmetadata確認は別SQLで行う。既存企業/営業/配信のUPDATEはこのSQLにない。
