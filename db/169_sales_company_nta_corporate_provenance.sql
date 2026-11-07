-- 169: Support NTA corporate number Web-API v4 as an authoritative basic-three source.
-- One atomic operation updates the ENGER company master, exactly linked Sales CRM,
-- and an auditable event. Service-role only; no public RPC access.
BEGIN;
CREATE OR REPLACE FUNCTION public.gw_sales_company_official_save(
  p_tenant uuid, p_company uuid, p_actor uuid, p_actor_name text, p_request uuid,
  p_corporate_number text, p_expected_number text, p_basic jsonb, p_source text
) RETURNS jsonb LANGUAGE plpgsql SET search_path TO '' AS $function$
DECLARE
 current_company enger.companies%rowtype;
 prior public.gw_sales_company_activity%rowtype;
 saved public.gw_sales_company_activity%rowtype;
 sales_company uuid;
 link_count integer;
 fields text[];
 payload jsonb;
BEGIN
  IF p_corporate_number !~ '^[0-9]{13}$' THEN RAISE EXCEPTION 'invalid_corporate_number' USING errcode='P0001'; END IF;
  IF p_source NOT IN ('nta_v4','gbiz_api_v1','gbiz_api_v2','manual_official_review') THEN RAISE EXCEPTION 'invalid_source' USING errcode='P0001'; END IF;
  IF p_basic IS NULL OR jsonb_typeof(p_basic)<>'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_basic) k WHERE k NOT IN ('name','address','website','industry','prefecture'))
  THEN RAISE EXCEPTION 'invalid_basic_fields' USING errcode='P0001'; END IF;
  IF p_source='manual_official_review' AND p_basic<>'{}'::jsonb THEN
    RAISE EXCEPTION 'unverified_basic_data' USING errcode='P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM enger.dx2_sales_company_directory_for_tenant
      WHERE tenant_id=p_tenant AND id=p_company)
  THEN RAISE EXCEPTION 'company_not_in_scope' USING errcode='P0001'; END IF;
  SELECT * INTO prior FROM public.gw_sales_company_activity
   WHERE tenant_id=p_tenant AND request_key=p_request;
  IF FOUND THEN
    IF prior.company_id<>p_company OR prior.actor_id IS DISTINCT FROM p_actor
       OR prior.payload->>'corporateNumber' IS DISTINCT FROM p_corporate_number
       THEN RAISE EXCEPTION 'request_conflict' USING errcode='P0001'; END IF;
    RETURN to_jsonb(prior);
  END IF;
  -- Serialize concurrent claims for the same 13-digit number across different companies.
  PERFORM pg_advisory_xact_lock(163,hashtext(p_corporate_number));
  SELECT * INTO current_company FROM enger.companies
    WHERE id=p_company AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'company_not_found' USING errcode='P0001'; END IF;
  IF coalesce(current_company.corporate_number,'') <> coalesce(p_expected_number,'')
    THEN RAISE EXCEPTION 'corporate_number_changed' USING errcode='P0001'; END IF;
  IF EXISTS (SELECT 1 FROM enger.companies c
      WHERE c.corporate_number=p_corporate_number AND c.id<>p_company AND c.deleted_at IS NULL)
    THEN RAISE EXCEPTION 'corporate_number_already_in_use' USING errcode='P0001'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(p_basic) kv
    WHERE char_length(kv.value) > CASE kv.key WHEN 'address' THEN 500
      WHEN 'website' THEN 500 WHEN 'name' THEN 200 ELSE 100 END)
    THEN RAISE EXCEPTION 'field_too_long' USING errcode='P0001'; END IF;
  IF p_basic ? 'website' AND coalesce(p_basic->>'website','') !~ '^https?://'
    THEN RAISE EXCEPTION 'invalid_website' USING errcode='P0001'; END IF;
  SELECT count(*), (array_agg(company_id))[1] INTO link_count,sales_company
    FROM public.gw_sales_company_links
    WHERE tenant_id=p_tenant AND source_system='enger' AND source_company_id=p_company::text;
  IF link_count>1 THEN RAISE EXCEPTION 'ambiguous_sales_link' USING errcode='P0001'; END IF;
  UPDATE enger.companies SET
    corporate_number=p_corporate_number,
    name=coalesce(nullif(p_basic->>'name',''),name),
    address=coalesce(nullif(p_basic->>'address',''),address),
    website=coalesce(nullif(p_basic->>'website',''),website),
    industry=coalesce(nullif(p_basic->>'industry',''),industry),
    prefecture=coalesce(nullif(p_basic->>'prefecture',''),prefecture)
    WHERE id=p_company;
  IF sales_company IS NOT NULL THEN
    UPDATE public.gw_sales_companies SET
      name=coalesce(nullif(p_basic->>'name',''),name),
      address=coalesce(nullif(p_basic->>'address',''),address),
      site_url=coalesce(nullif(p_basic->>'website',''),site_url),
      domain=case when p_basic ? 'website'
        then regexp_replace(lower(substring(p_basic->>'website' from '^https?://([^/:?#]+)')),'^www[.]','')
        else domain end,
      industry=coalesce(nullif(p_basic->>'industry',''),industry),
      updated_at=now()
    WHERE id=sales_company AND tenant_id=p_tenant;
  END IF;
  SELECT coalesce(array_agg(key),ARRAY[]::text[]) INTO fields
    FROM jsonb_object_keys(p_basic) key;
  payload=jsonb_build_object('corporateNumber',p_corporate_number,
    'officialSource',p_source,'updatedFields',to_jsonb(fields),
    'verified',p_source IN ('nta_v4','gbiz_api_v1','gbiz_api_v2'));
  INSERT INTO public.gw_sales_company_activity
    (tenant_id,company_id,request_key,actor_id,actor_name,operation,payload)
    VALUES(p_tenant,p_company,p_request,p_actor,p_actor_name,'profile',payload)
    RETURNING * INTO saved;
  RETURN to_jsonb(saved);
END $function$;
REVOKE ALL ON FUNCTION public.gw_sales_company_official_save(uuid,uuid,uuid,text,uuid,text,text,jsonb,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gw_sales_company_official_save(uuid,uuid,uuid,text,uuid,text,text,jsonb,text)
  TO service_role;
COMMIT;
