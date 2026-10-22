-- 146: スポット人材の選択更新・一覧から除外/復元（物理削除しない）
-- db/145_hr_spot_talents.sql 適用後に実行。既存データの削除なし。
begin;
alter table public.gw_hr_spot_talents
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete set null;
create index if not exists idx_gw_hr_spot_active
  on public.gw_hr_spot_talents (tenant_id, worked_on desc)
  where deleted_at is null;
comment on column public.gw_hr_spot_talents.deleted_at is
  '一覧から削除した日時。元のアンケート回答・社内評価は保持し、専用フィルターから復元可能。';
create or replace function public.gw_hr_spot_bulk(
  p_tenant uuid, p_ids uuid[], p_action text, p_actor uuid
) returns integer
language plpgsql security invoker set search_path = public
as $fn$
declare v_count integer; v_n integer; v_bad integer;
begin
  v_n := coalesce(array_length(p_ids,1),0);
  if p_tenant is null or p_actor is null or v_n < 1 or v_n > 50
    or p_action not in ('archive','restore','candidate','closed') then
    raise exception 'invalid_bulk_request' using errcode = '22023';
  end if;
  if (select count(distinct id) from unnest(p_ids) as id) <> v_n then
    raise exception 'duplicate_ids' using errcode = '22023';
  end if;
  -- トランザクション内で全対象を行ロック。1件でも他テナント/不存在なら何も変更しない。
  perform 1 from public.gw_hr_spot_talents s
    where s.tenant_id = p_tenant and s.id = any(p_ids) for update;
  get diagnostics v_count = row_count;
  if v_count <> v_n then
    raise exception 'missing_or_foreign_record' using errcode = '22023';
  end if;
  if p_action = 'restore' then
    select count(*) into v_bad from public.gw_hr_spot_talents
      where tenant_id=p_tenant and id=any(p_ids)
        and (deleted_at is null or applicant_id is not null);
  else
    select count(*) into v_bad from public.gw_hr_spot_talents
      where tenant_id=p_tenant and id=any(p_ids)
        and (deleted_at is not null or applicant_id is not null or status='converted');
  end if;
  if v_bad <> 0 then
    raise exception 'record_not_editable' using errcode = '22023';
  end if;
  if p_action='candidate' then
    select count(*) into v_bad from public.gw_hr_spot_talents
      where tenant_id=p_tenant and id=any(p_ids)
      and (not contact_consent or survey_answered_at is null
        or coalesce(survey_answers->>'longTerm','') not in ('ぜひ継続したい','条件が合えば')
        or jsonb_typeof(staff_scores) is distinct from 'array'
        or jsonb_array_length(coalesce(staff_scores,'[]'::jsonb)) <> 5);
    if v_bad <> 0 then
      raise exception 'consent_or_evaluation_required' using errcode = '22023';
    end if;
  end if;
  if p_action='archive' then
    update public.gw_hr_spot_talents set deleted_at=now(),deleted_by=p_actor,
      survey_token_hash=null,survey_expires_at=null,updated_at=now()
      where tenant_id=p_tenant and id=any(p_ids);
  elsif p_action='restore' then
    update public.gw_hr_spot_talents set deleted_at=null,deleted_by=null,updated_at=now()
      where tenant_id=p_tenant and id=any(p_ids);
  elsif p_action='candidate' then
    update public.gw_hr_spot_talents set status='candidate',updated_at=now()
      where tenant_id=p_tenant and id=any(p_ids);
  elsif p_action='closed' then
    update public.gw_hr_spot_talents set status='closed',
      survey_token_hash=null,survey_expires_at=null,updated_at=now()
      where tenant_id=p_tenant and id=any(p_ids);
  end if;
  return v_n;
end;
$fn$;
revoke all on function public.gw_hr_spot_bulk(uuid,uuid[],text,uuid) from public,anon,authenticated;
grant execute on function public.gw_hr_spot_bulk(uuid,uuid[],text,uuid) to service_role;
notify pgrst,'reload schema';
commit;
