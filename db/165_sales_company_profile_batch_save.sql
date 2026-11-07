-- 165. Atomic company form save. Use same audited source as per-field edit.
-- Only service_role can execute; the API checks employee permissions and company scope.
BEGIN;
CREATE OR REPLACE FUNCTION public.gw_sales_company_profile_batch_save(
  p_tenant uuid, p_company uuid, p_actor uuid, p_actor_name text,
  p_request uuid, p_patch jsonb, p_expected jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path TO '' AS $function$
DECLARE
 prior public.gw_sales_company_activity%rowtype;
 saved public.gw_sales_company_activity%rowtype;
 source_record enger.companies%rowtype;
 source_json jsonb;
 field text;
 col text;
 sval text;
 value_json jsonb;
 links integer;
 linked uuid;
BEGIN
 IF p_patch IS NULL OR jsonb_typeof(p_patch)<>'object' OR
    (SELECT count(*) FROM jsonb_object_keys(p_patch)) NOT BETWEEN 1 AND 12 OR
    p_expected IS NULL OR jsonb_typeof(p_expected)<>'object'
 THEN RAISE EXCEPTION 'invalid_patch' USING errcode='P0001'; END IF;

 SELECT * INTO prior FROM public.gw_sales_company_activity
  WHERE tenant_id=p_tenant AND request_key=p_request;
 IF FOUND THEN
   IF prior.company_id<>p_company OR prior.actor_id IS DISTINCT FROM p_actor OR
      prior.operation<>'profile' OR prior.payload<>p_patch
   THEN RAISE EXCEPTION 'request_conflict' USING errcode='P0001'; END IF;
   RETURN to_jsonb(prior);
 END IF;

 IF NOT EXISTS (SELECT 1 FROM enger.dx2_sales_company_directory_for_tenant
  WHERE tenant_id=p_tenant AND id=p_company)
 THEN RAISE EXCEPTION 'company_not_in_scope' USING errcode='P0001'; END IF;

 SELECT * INTO source_record FROM enger.companies
  WHERE id=p_company AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'company_not_found' USING errcode='P0001'; END IF;
 source_json:=to_jsonb(source_record);

 SELECT count(*),(array_agg(company_id))[1] INTO links,linked
  FROM public.gw_sales_company_links
  WHERE tenant_id=p_tenant AND source_system='enger' AND source_company_id=p_company::text;
 IF links>1 THEN RAISE EXCEPTION 'ambiguous_company_link' USING errcode='P0001'; END IF;
 IF linked IS NOT NULL AND NOT EXISTS (
   SELECT 1 FROM public.gw_sales_companies WHERE id=linked AND tenant_id=p_tenant
 ) THEN RAISE EXCEPTION 'sales_company_missing' USING errcode='P0001'; END IF;

 FOR field IN SELECT jsonb_object_keys(p_patch) LOOP
   col:=CASE field
     WHEN 'name' THEN 'name'
     WHEN 'contactName' THEN 'contact_name'
     WHEN 'contactEmail' THEN 'contact_email'
     WHEN 'phone' THEN 'phone'
     WHEN 'address' THEN 'address'
     WHEN 'industry' THEN 'industry'
     WHEN 'website' THEN 'website'
     WHEN 'formUrl' THEN 'contact_form_url'
     WHEN 'status' THEN 'status'
     WHEN 'note' THEN 'note'
     WHEN 'isFavorite' THEN 'is_favorite'
     WHEN 'isEndClient' THEN 'is_end_client'
     ELSE NULL END;
   IF col IS NULL OR NOT p_expected ? field
   THEN RAISE EXCEPTION 'invalid_field' USING errcode='P0001'; END IF;
   value_json:=p_patch->field;
   IF field IN ('isFavorite','isEndClient') THEN
     IF jsonb_typeof(value_json)<>'boolean'
       THEN RAISE EXCEPTION 'invalid_boolean' USING errcode='P0001'; END IF;
   ELSIF jsonb_typeof(value_json) NOT IN ('string','null') THEN
     RAISE EXCEPTION 'invalid_value' USING errcode='P0001';
   END IF;
   IF source_json->>col IS DISTINCT FROM p_expected->>field THEN
     RAISE EXCEPTION 'company_profile_changed' USING errcode='P0001';
   END IF;
   sval:=p_patch->>field;
   IF char_length(coalesce(sval,'')) > CASE field
     WHEN 'name' THEN 200 WHEN 'contactName' THEN 100
     WHEN 'contactEmail' THEN 254 WHEN 'phone' THEN 30
     WHEN 'address' THEN 500 WHEN 'industry' THEN 100
     WHEN 'website' THEN 500 WHEN 'formUrl' THEN 500
     WHEN 'note' THEN 2000 ELSE 100 END
     THEN RAISE EXCEPTION 'value_too_long' USING errcode='P0001'; END IF;
   IF field='name' AND nullif(trim(sval),'') IS NULL
     THEN RAISE EXCEPTION 'company_name_required' USING errcode='P0001'; END IF;
   IF field IN ('website','formUrl') AND sval IS NOT NULL AND sval <> '' AND
      sval !~ '^https?://' THEN
     RAISE EXCEPTION 'invalid_url' USING errcode='P0001'; END IF;

   IF field IN ('isFavorite','isEndClient') THEN
     EXECUTE format('UPDATE enger.companies SET %I=$1 WHERE id=$2',col)
      USING sval::boolean,p_company;
   ELSE
     EXECUTE format('UPDATE enger.companies SET %I=$1 WHERE id=$2',col)
      USING sval,p_company;
   END IF;

   IF linked IS NOT NULL THEN
     IF field='website' THEN
       UPDATE public.gw_sales_companies SET site_url=sval,
        domain=regexp_replace(lower(substring(sval from '^https?://([^/:?#]+)')),'^www[.]',''),
        updated_at=now()
         WHERE tenant_id=p_tenant AND id=linked;
     ELSIF field='contactEmail' THEN
       UPDATE public.gw_sales_companies SET
        emails=CASE WHEN sval IS NULL
          THEN array_remove(emails,emails[1])
          ELSE array_prepend(sval,array_remove(array_remove(emails,emails[1]),sval)) END,
        updated_at=now()
        WHERE tenant_id=p_tenant AND id=linked;
     ELSE
       col:=CASE field
        WHEN 'name' THEN 'name' WHEN 'phone' THEN 'phone'
        WHEN 'address' THEN 'address' WHEN 'industry' THEN 'industry'
        WHEN 'formUrl' THEN 'form_url' WHEN 'note' THEN 'note' ELSE NULL END;
       IF col IS NOT NULL THEN
         EXECUTE format(
           'UPDATE public.gw_sales_companies SET %I=$1,updated_at=now() WHERE tenant_id=$2 AND id=$3',col
         ) USING sval,p_tenant,linked;
       END IF;
     END IF;
   END IF;
 END LOOP;

 INSERT INTO public.gw_sales_company_activity
  (tenant_id,company_id,request_key,actor_id,actor_name,operation,payload)
 VALUES (p_tenant,p_company,p_request,p_actor,p_actor_name,'profile',p_patch)
 RETURNING * INTO saved;
 RETURN to_jsonb(saved);
END $function$;
REVOKE ALL ON FUNCTION public.gw_sales_company_profile_batch_save(uuid,uuid,uuid,text,uuid,jsonb,jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gw_sales_company_profile_batch_save(uuid,uuid,uuid,text,uuid,jsonb,jsonb)
 TO service_role;
COMMIT;
