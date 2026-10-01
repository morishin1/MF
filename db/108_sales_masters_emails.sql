-- =============================================================================
-- 108: /sales 企業の分類マスター（業種・提案サービス）・複数メールアドレス・地域「未設定」の件数
--
-- 番号：099〜107 は他のブランチ（hr・office・contracts など）で使われているため 108。
--       100（案件・PR #38）・101（企業の件数・PR #41）とは別。101 の関数をこの 108 で置き換える
--       （101 を流していなくても、この 108 だけで足りる。両方流すなら 101 → 108 の順）。
--
--   1) gw_sales_master_options … テナントごとの 業種・提案サービス の選択肢
--        追加・名前変更・非表示（archived_at）・再表示。物理削除はしない（delete のポリシーを作らない）。
--        企業には選んだ文字列をそのまま保存しているので、非表示にしても既存企業のデータは変わらない。
--        いまある テナント には、これまでの固定の選択肢（lib/sales-master.js の既定値）を入れておく。
--   2) gw_sales_companies.emails text[] … 1社に複数のメールアドレス（小文字・重複なし。API で正規化）
--        企業規模（size）はそのまま残す（画面から外すだけ。データは消さない・流用しない）
--   3) gw_sales_company_facet_counts … 地域の件数に「未設定」（'none'）を足す
--        都道府県が取れない企業（null・空・「鹿屋市」だけ など）を 'none' にまとめる。
--        47都道府県の件数 ＋ 未設定 ＝ total（一覧の総件数）になる。p_region = 'none' で未設定だけに絞れる
--
-- 既存データの書き換え：なし（列の追加は既定値つき・表の書き直しなし。選択肢の初期値を入れるだけ）
-- 何度流しても同じ結果になる。088・096・097 の後に流す。
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1) 業種・提案サービスの選択肢
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_master_options (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  kind        text not null check (kind in ('industry', 'service')),
  label       text not null check (char_length(label) between 1 and 100 and label = btrim(label)),
  sort_order  integer not null default 0,
  archived_at timestamptz,
  created_by  uuid references auth.users(id) on delete set null,
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint gw_sales_master_options_label_key unique (tenant_id, kind, label)
);

create index if not exists idx_gw_sales_master_options_tenant
  on public.gw_sales_master_options(tenant_id, kind, sort_order);

comment on table public.gw_sales_master_options is
  '/sales の業種・提案サービスの選択肢（テナントごと）。非表示は archived_at。物理削除しない';

alter table public.gw_sales_master_options enable row level security;

-- 営業の人だけ。見る・足す・直す（非表示を含む）だけで、消すポリシーは作らない
drop policy if exists gw_sales_master_options_select on public.gw_sales_master_options;
create policy gw_sales_master_options_select on public.gw_sales_master_options
  for select using (public.gw_is_sales(tenant_id));
drop policy if exists gw_sales_master_options_insert on public.gw_sales_master_options;
create policy gw_sales_master_options_insert on public.gw_sales_master_options
  for insert with check (public.gw_is_sales(tenant_id));
drop policy if exists gw_sales_master_options_update on public.gw_sales_master_options;
create policy gw_sales_master_options_update on public.gw_sales_master_options
  for update using (public.gw_is_sales(tenant_id)) with check (public.gw_is_sales(tenant_id));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant select, insert, update on public.gw_sales_master_options to authenticated;
  end if;
end $$;

-- 初期値：これまでの固定の選択肢（lib/sales-master.js の DEFAULT_*）。
-- その種類の行がまだ1つも無いテナントにだけ入れる（名前を変えた・非表示にしたあとに流し直しても元に戻さない）
insert into public.gw_sales_master_options (tenant_id, kind, label, sort_order)
select t.id, d.kind, d.label, d.sort_order
  from public.tenants t
  cross join (values
    ('industry', '製造', 10), ('industry', '不動産', 20), ('industry', '士業', 30),
    ('industry', '医療', 40), ('industry', '小売', 50), ('industry', 'その他', 60),
    ('service', 'AI / DX', 10), ('service', 'システム開発', 20), ('service', 'PCレンタル', 30),
    ('service', 'ホームページ改善', 40), ('service', '地方創生', 50), ('service', 'ENGER', 60),
    ('service', 'その他', 70)
  ) as d(kind, label, sort_order)
 where not exists (select 1 from public.gw_sales_master_options o where o.tenant_id = t.id and o.kind = d.kind)
on conflict (tenant_id, kind, label) do nothing;

-- -----------------------------------------------------------------------------
-- 2) 複数メールアドレス
-- -----------------------------------------------------------------------------
alter table public.gw_sales_companies add column if not exists emails text[] not null default '{}';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.gw_sales_companies'::regclass and conname = 'gw_sales_companies_emails_check') then
    alter table public.gw_sales_companies add constraint gw_sales_companies_emails_check
      check (cardinality(emails) <= 20 and array_position(emails, null) is null);
  end if;
end $$;

comment on column public.gw_sales_companies.emails is
  'メールアドレス（複数）。小文字・重複なし・形式チェック済み（API で正規化）。将来の一括メール送信用';

-- -----------------------------------------------------------------------------
-- 3) 地域「未設定」を含む件数
-- -----------------------------------------------------------------------------
create or replace function public.gw_sales_prefecture(p_region text)
returns text
language sql
immutable
parallel safe
as $$
  select p from unnest(array[
    '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
    '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
    '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県',
    '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
    '鳥取県', '島根県', '岡山県', '広島県', '山口県',
    '徳島県', '香川県', '愛媛県', '高知県',
    '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'
  ]) p
  where p_region like p || '%'
  limit 1
$$;

comment on function public.gw_sales_prefecture(text) is
  '地域の値から都道府県を取り出す（先頭一致）。取れなければ null（＝一覧の「未設定」）。lib/sales-master.js の prefectureOf と同じ';

create or replace function public.gw_sales_company_facet_counts(
  p_tenant     uuid,
  p_visibility text default 'shown',   -- shown / hidden / all
  p_q          text default '',        -- 検索語（API で記号を外したもの）
  p_status     text default '',        -- '' / ステータス / 'ng'（営業禁止）
  p_owner      text default '',        -- '' / 'none'（未定）/ 社員ID（「自分」は API が社員IDにして渡す）
  p_service    text default '',
  p_industry   text default '',
  p_region     text default '',        -- 都道府県 / 'none'（未設定）
  p_channel    text default '',        -- '' / 'none' / 連絡手段
  p_attacked   text default '',        -- '' / yes / no
  p_clicked    text default ''         -- '' / yes / no
)
returns table (kind text, value text, n integer)
language sql
stable
set search_path = public
as $$
  with base as (
    select
      c.status, c.ng_reason, c.owner_id, c.service, c.industry,
      public.gw_sales_prefecture(c.region) as pref,
      c.current_contact_channel as channel,
      (c.last_sent_at is not null) as attacked,
      (c.click_count > 0) as clicked,
      (coalesce(p_status, '') = '' or (p_status = 'ng' and c.ng_reason is not null) or c.status = p_status) as m_status,
      (coalesce(p_owner, '') = '' or (p_owner = 'none' and c.owner_id is null) or c.owner_id::text = p_owner) as m_owner,
      (coalesce(p_service, '') = '' or c.service = p_service) as m_service,
      (coalesce(p_industry, '') = '' or c.industry = p_industry) as m_industry,
      (coalesce(p_region, '') = ''
        or (p_region = 'none' and public.gw_sales_prefecture(c.region) is null)
        or (p_region <> 'none' and c.region like p_region || '%')) as m_region,
      (coalesce(p_channel, '') = '' or (p_channel = 'none' and c.current_contact_channel is null)
        or c.current_contact_channel = p_channel) as m_channel,
      (coalesce(p_attacked, '') = '' or (p_attacked = 'yes') = (c.last_sent_at is not null)) as m_attacked,
      (coalesce(p_clicked, '') = '' or (p_clicked = 'yes') = (c.click_count > 0)) as m_clicked
    from public.gw_sales_companies c
    where c.tenant_id = p_tenant
      and (coalesce(p_visibility, 'shown') = 'all'
           or (coalesce(p_visibility, 'shown') = 'hidden') = (c.hidden_at is not null))
      and (coalesce(p_q, '') = ''
           or c.name ilike '%' || p_q || '%'
           or c.domain ilike '%' || p_q || '%'
           or c.site_url ilike '%' || p_q || '%')
  )
  select 'total', null, count(*)::int from base
   where m_status and m_owner and m_service and m_industry and m_region and m_channel and m_attacked and m_clicked
  union all
  select 'industry', industry, count(*)::int from base
   where industry is not null
     and m_status and m_owner and m_service and m_region and m_channel and m_attacked and m_clicked
   group by industry
  union all
  select 'region', coalesce(pref, 'none'), count(*)::int from base
   where m_status and m_owner and m_service and m_industry and m_channel and m_attacked and m_clicked
   group by coalesce(pref, 'none')
  union all
  select 'service', service, count(*)::int from base
   where service is not null
     and m_status and m_owner and m_industry and m_region and m_channel and m_attacked and m_clicked
   group by service
  union all
  select 'status', status, count(*)::int from base
   where m_owner and m_service and m_industry and m_region and m_channel and m_attacked and m_clicked
   group by status
  union all
  select 'status', 'ng', count(*)::int from base
   where ng_reason is not null
     and m_owner and m_service and m_industry and m_region and m_channel and m_attacked and m_clicked
  union all
  select 'owner', coalesce(owner_id::text, 'none'), count(*)::int from base
   where m_status and m_service and m_industry and m_region and m_channel and m_attacked and m_clicked
   group by coalesce(owner_id::text, 'none')
  union all
  select 'channel', coalesce(channel, 'none'), count(*)::int from base
   where m_status and m_owner and m_service and m_industry and m_region and m_attacked and m_clicked
   group by coalesce(channel, 'none')
  union all
  select 'attacked', case when attacked then 'yes' else 'no' end, count(*)::int from base
   where m_status and m_owner and m_service and m_industry and m_region and m_channel and m_clicked
   group by attacked
  union all
  select 'clicked', case when clicked then 'yes' else 'no' end, count(*)::int from base
   where m_status and m_owner and m_service and m_industry and m_region and m_channel and m_attacked
   group by clicked
$$;

comment on function public.gw_sales_company_facet_counts(uuid, text, text, text, text, text, text, text, text, text, text) is
  '企業一覧の絞り込みの件数。各項目はその項目以外の条件で数える。地域は都道府県＋none（未設定）。total は全条件。security invoker（RLS が効く）';

-- 画面（ログインした人）からだけ呼べるようにする
revoke all on function public.gw_sales_company_facet_counts(uuid, text, text, text, text, text, text, text, text, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.gw_sales_company_facet_counts(uuid, text, text, text, text, text, text, text, text, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant execute on function public.gw_sales_company_facet_counts(uuid, text, text, text, text, text, text, text, text, text, text) to authenticated;
  end if;
end $$;

commit;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------
-- 確認用
-- -----------------------------------------------------------------------------
-- select tenant_id, kind, label, sort_order, archived_at from public.gw_sales_master_options order by 1, 2, 4;
-- select count(*) filter (where cardinality(emails) > 0) from public.gw_sales_companies;
-- 地域の合計＝total：
-- select (select sum(n) from public.gw_sales_company_facet_counts('<tenant_id>') where kind = 'region')
--      = (select n from public.gw_sales_company_facet_counts('<tenant_id>') where kind = 'total');

-- =============================================================================
-- ロールバック（戻すときだけ）
--   emails に入れたメールアドレスは消える。選択肢の表も消える（企業に保存した業種・提案サービスの文字列は残る）。
--   件数の関数は 101 の版に戻す（101 を流し直す）か、関数ごと消す。
-- =============================================================================
-- begin;
-- alter table public.gw_sales_companies drop constraint if exists gw_sales_companies_emails_check;
-- alter table public.gw_sales_companies drop column if exists emails;
-- drop table if exists public.gw_sales_master_options;
-- commit;
-- （件数の関数）\i db/101_sales_company_facets.sql   または
-- drop function if exists public.gw_sales_company_facet_counts(uuid, text, text, text, text, text, text, text, text, text, text);
