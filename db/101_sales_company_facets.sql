-- =============================================================================
-- 101: /sales 企業一覧の絞り込み件数（いまの検索条件に連動）と、地域の都道府県化
--
-- 番号：100 は /sales 案件（PR #38・未マージ）で使うため、101 にする。100 とは独立（どちらを先に流してもよい）。
-- 表は変えない（列の追加・データの書き換えなし）。関数を2つ足すだけ。
--
--   1) gw_sales_prefecture(region) … 地域の値から都道府県を取り出す（先頭が47都道府県のどれかで始まるときだけ）
--        「鹿児島県鹿屋市」→ 鹿児島県。既存データは書き換えず、一覧・件数ではこれで都道府県として数える。
--        lib/sales-master.js の prefectureOf、一覧の地域絞り込み（region like '鹿児島県%'）と同じ判定
--   2) gw_sales_company_facet_counts(...) … 絞り込みの各項目の件数
--        各項目の件数は「その項目以外の、いま選んでいる条件（検索語を含む）」で数える。
--        例：業種＝製造を選ぶと、地域の件数が「製造の中での件数」になる。並べ替えは件数に関係しない。
--        total は、すべての条件で絞った件数（一覧の「○社」・ページャーの総件数と同じ）。
--        条件の意味は lib/sales.js の applyListFilters と同じ（テストで突き合わせる）。
--        security invoker（呼んだ人の RLS がそのまま効く）。tenant も引数で絞る。
--
-- 何度流しても同じ結果になる。088・096・097 の後に流す。
-- =============================================================================

begin;

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
  '地域の値から都道府県を取り出す（先頭一致）。取れなければ null。lib/sales-master.js の prefectureOf と同じ';

create or replace function public.gw_sales_company_facet_counts(
  p_tenant     uuid,
  p_visibility text default 'shown',   -- shown / hidden / all
  p_q          text default '',        -- 検索語（API で記号を外したもの）
  p_status     text default '',        -- '' / ステータス / 'ng'（営業禁止）
  p_owner      text default '',        -- '' / 'none'（未定）/ 社員ID（「自分」は API が社員IDにして渡す）
  p_service    text default '',
  p_industry   text default '',
  p_region     text default '',        -- 都道府県
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
      (coalesce(p_region, '') = '' or c.region like p_region || '%') as m_region,
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
  select 'region', pref, count(*)::int from base
   where pref is not null
     and m_status and m_owner and m_service and m_industry and m_channel and m_attacked and m_clicked
   group by pref
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
  '企業一覧の絞り込みの件数。各項目はその項目以外の条件で数える。total は全条件。security invoker（RLS が効く）';

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
-- select * from public.gw_sales_company_facet_counts('<tenant_id>') order by kind, n desc;
-- select region, public.gw_sales_prefecture(region) from public.gw_sales_companies group by 1 order by 1;

-- =============================================================================
-- ロールバック（戻すときだけ。アプリは関数が無ければ以前の件数表示に戻るので、先に戻さなくてよい）
-- =============================================================================
-- begin;
-- drop function if exists public.gw_sales_company_facet_counts(uuid, text, text, text, text, text, text, text, text, text, text);
-- drop function if exists public.gw_sales_prefecture(text);
-- commit;
