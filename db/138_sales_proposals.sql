-- =============================================================================
-- 138: /sales 提案管理（提案後の営業フォロー）と dx.enger 連携の受け口
--
-- ■ 役割分担（docs/sales-proposals.md）
--   dx.enger … マッチング・提案の作成・送信（提案の正本は enger.proposals。別の Supabase プロジェクト）
--   /sales   … 提案を送ったあとの電話・メール・回答確認・面談調整・結果（フォローの正本はここ）
--   提案を二重に作らない。dx.enger の提案ID（source_proposal_id）を連携キーとして1件だけ持つ。
--   人材の氏名・スキルシートなどは持たない（イニシャルと案件名だけ）。
--
-- ■ 作るもの（どれも新しい表。既存の表・列・関数・ポリシーは変えない）
--   1) gw_sales_proposals            … 提案1件（提案単位でフォローする）。消さない
--   2) gw_sales_proposal_activities  … 行動の記録（電話・メール・返信・面談・結果・期限変更…）。追記だけ
--   3) gw_sales_proposal_tasks       … やること（電話・メール・回答確認…）。完了は「記録」とひも付けたときだけ
--   4) gw_sales_proposal_settings    … 営業時間・30分ルール・再フォローの営業日数（テナントごと。管理者が変える）
--   5) gw_sales_proposal_sync_log    … dx.enger から届いた連携イベント（冪等・失敗の一覧）。サーバだけが書く
--   6) gw_sales_company_links        … dx.enger の企業ID → /sales の企業。社名では名寄せしない（人が確定）
--
-- ■ 見える範囲（RLS。API の lib/gw.js と同じ判定）
--   Sales を使える人（gw_is_sales）のうち
--     管理者・経営者・マネージャー … テナントの提案すべて（担当の割り当て・期限超過の確認）
--     営業担当                     … 自分が担当の提案だけ（担当が未定の提案は管理側が割り当てる）
--   別テナント・Sales を使えない社員・退職者・anon からは見えない。
--
-- ■ 安全装置
--   ・同じ dx.enger の提案は1件だけ（一意索引）。同じ連携イベントの再送は sync_log の一意索引で1回だけ
--   ・同じ提案に、同じ自動タスクは1つだけ（source_event の一意索引）
--   ・タスクの「完了」は、行動の記録（done_activity_id）が無いとできない（CHECK）
--   ・取り消しは理由が必須（CHECK）。行動の記録は書き換え・削除のポリシーを作らない（追記だけ）
--   ・担当は同じテナントの社員だけ（トリガー）。提案のテナント・連携元・連携キーはあとから変えられない
--
-- 何度流しても同じ結果になる。前提：088・096・119・120・130 が適用済み（無ければ何も変えずに止まる）。
-- 戻すとき：db/rollback_138_sales_proposals.sql（提案管理のデータは消えます）
-- 確認：db/check_138_sales_proposals.sql（❌ が無いこと）
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0) 前提が無ければ止まる（フェイルクローズ。「無いから全員 OK」には倒さない）
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.gw_sales_companies') is null or to_regclass('public.gw_sales_events') is null then
    raise exception 'db/138: gw_sales_companies / gw_sales_events がありません（先に db/088 を適用してください）。何も変更していません';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gw_sales_events' and column_name = 'channel') then
    raise exception 'db/138: gw_sales_events.channel がありません（先に db/096 を適用してください）。何も変更していません';
  end if;
  if to_regprocedure('public.gw_is_sales(uuid)') is null
     or to_regprocedure('public.gw_has_app(uuid,text)') is null
     or to_regprocedure('public.gw_has_role(uuid,text)') is null
     or to_regprocedure('public.gw_employee_id(uuid)') is null
     or to_regprocedure('public.is_tenant_staff(uuid)') is null then
    raise exception 'db/138: 権限の判定（gw_is_sales・gw_has_app・gw_has_role・gw_employee_id・is_tenant_staff）が揃っていません（先に db/119・db/120・db/130 を適用してください）。何も変更していません';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1) 判定の部品（security definer。返すのは true / false / 社員ID だけ）
-- -----------------------------------------------------------------------------

-- 営業の管理側か（担当の割り当て・全件の確認・設定の変更・期限超過の督促）。
-- Sales を使える人のうち、会計側の管理者・スタッフ、経営者、マネージャー。lib/sales-proposals.js canManageProposals と同じ
create or replace function public.gw_sales_is_manager(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_is_sales(p_tenant)
     and (public.is_tenant_staff(p_tenant)
          or public.gw_has_role(p_tenant, 'owner')
          or public.gw_has_role(p_tenant, 'manager'))
$$;
comment on function public.gw_sales_is_manager(uuid) is
  '/sales 提案管理の管理側（Sales を使える人のうち 管理者・経営者・マネージャー）。担当の割り当て・全件の確認・設定（db/138）';

-- その担当の提案を見てよいか（管理側は全部・営業担当は自分が担当のものだけ）
create or replace function public.gw_sales_proposal_visible(p_tenant uuid, p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.gw_is_sales(p_tenant)
     and (public.gw_sales_is_manager(p_tenant)
          or (p_owner is not null and p_owner = public.gw_employee_id(p_tenant)))
$$;

-- 社員が、そのテナントの在籍中の社員か（担当・タスクの担当者に入れてよいか）。名前などは返さない
create or replace function public.gw_sales_employee_ok(p_employee uuid, p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_employee is not null and p_tenant is not null and exists (
    select 1 from public.gw_employees e
     where e.id = p_employee and e.tenant_id = p_tenant and e.status <> 'left')
$$;

-- RLS の式から呼ぶ2つは anon にも実行を許す（ログインしていなければ false を返すだけ。
-- 許さないと「0件」ではなく「権限エラー」になる）。社員の判定は RLS では使わないので anon には許さない
revoke all on function public.gw_sales_is_manager(uuid) from public;
revoke all on function public.gw_sales_proposal_visible(uuid, uuid) from public;
revoke all on function public.gw_sales_employee_ok(uuid, uuid) from public, anon;
grant execute on function public.gw_sales_is_manager(uuid) to anon, authenticated, service_role;
grant execute on function public.gw_sales_proposal_visible(uuid, uuid) to anon, authenticated, service_role;
grant execute on function public.gw_sales_employee_ok(uuid, uuid) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2) 提案（1件 = dx.enger の提案1件、または /sales で手で足した提案1件）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_proposals (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants(id) on delete cascade,

  -- 連携元。enger = dx.enger から自動で起票 / manual = /sales で手で足した（システム開発・PC・レンタルなど）
  source_system        text not null default 'manual' check (source_system in ('enger', 'manual')),
  source_proposal_id   text check (source_proposal_id is null or char_length(source_proposal_id) between 1 and 100),
  source_code          text check (source_code is null or char_length(source_code) <= 50),     -- dx.enger の提案コード（表示用）
  source_url           text check (source_url is null or char_length(source_url) <= 500),     -- dx.enger の提案詳細
  source_company_id    text check (source_company_id is null or char_length(source_company_id) <= 100),  -- enger.companies.id（連携キー。名寄せには使わない）
  source_stage         text check (source_stage is null or char_length(source_stage) <= 40),  -- dx.enger 側のステージ（参照だけ。正は dx.enger）

  company_id           uuid references public.gw_sales_companies(id) on delete set null,     -- /sales の企業（紐付けたときだけ）
  company_name         text not null check (char_length(company_name) between 1 and 200),    -- 提案時点の社名（表示用の写し）

  service              text check (service is null or char_length(service) <= 100),         -- 提案種別（ENGER・システム開発・PCレンタル・AI / DX…）
  title                text not null check (char_length(title) between 1 and 200),           -- 「Java 開発 / T.K.」
  job_title            text check (job_title is null or char_length(job_title) <= 200),
  talent_initials      text check (talent_initials is null or char_length(talent_initials) <= 20),  -- 人材はイニシャルだけ（氏名は持たない）

  -- 先方の窓口（提案メールの宛先など。フォローに要る最小限）
  contact_name         text check (contact_name is null or char_length(contact_name) <= 100),
  contact_email        text check (contact_email is null or char_length(contact_email) <= 200),
  contact_phone        text check (contact_phone is null or char_length(contact_phone) <= 40),

  -- マッチング担当（dx.enger の提案者。dx.enger は名前の文字列で持っているので写しで持つ）
  matching_owner_name  text check (matching_owner_name is null or char_length(matching_owner_name) <= 100),
  matching_owner_email text check (matching_owner_email is null or char_length(matching_owner_email) <= 200),
  -- 営業担当（/sales の社員）。未定なら null（管理側が割り当てる）
  sales_owner_id       uuid references public.gw_employees(id) on delete set null,

  sent_at              timestamptz not null,       -- 提案送信（T0）。経過日数・30分ルールはここから数える

  status text not null default 'call_wait' check (status in (
    'call_wait',        -- 電話待ち
    'mail_wait',        -- メール待ち（電話がつながらなかった）
    'reply_wait',       -- 回答待ち
    'meeting_adjust',   -- 面談調整
    'meeting_done',     -- 面談実施
    'considering',      -- 継続検討
    'reproposal',       -- 再提案依頼（dx.enger で人材の差し替え・再マッチング）
    'won',              -- 成約
    'lost',             -- 見送り（理由コードで 企業側／人材側 を分ける）
    'stopped',          -- 連絡停止
    'closed_no_reply'   -- クローズ（無回答）
  )),
  -- 理由コード。企業側の見送り・人材側の辞退・営業判断の保留を同じ値に潰さない
  close_reason text check (close_reason is null or close_reason in (
    'client_declined',  -- 企業側の見送り
    'talent_declined',  -- 人材側の辞退
    'filled',           -- 他で充足・募集終了
    'sales_hold',       -- 営業判断の保留
    'client_considering', -- 企業が検討中
    'other_candidate',  -- 別の候補を希望
    'no_reply',         -- 無回答
    'contact_stop',     -- 連絡停止の希望
    'other'
  )),
  close_note           text check (close_note is null or char_length(close_note) <= 1000),
  closed_at            timestamptz,
  contact_stop         boolean not null default false,   -- 連絡停止の希望があった（自動の追客を止める）
  meeting_at           timestamptz,                      -- 面談の日時（決まったら）

  synced_at            timestamptz,                      -- dx.enger から最後に受け取った時刻
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- dx.enger から来た提案は、必ず連携キーを持つ
  constraint gw_sales_proposals_source_key check (source_system = 'manual' or source_proposal_id is not null),
  -- 終わった提案（成約・見送り・連絡停止・無回答）は、終わった日時を持つ。進行中は持たない
  constraint gw_sales_proposals_closed check (
    (status in ('won', 'lost', 'stopped', 'closed_no_reply')) = (closed_at is not null)),
  -- 見送り・連絡停止・無回答は理由コードが要る
  constraint gw_sales_proposals_reason check (
    status not in ('lost', 'stopped', 'closed_no_reply') or close_reason is not null)
);

create unique index if not exists uq_gw_sales_proposals_source
  on public.gw_sales_proposals(tenant_id, source_system, source_proposal_id) where source_proposal_id is not null;
create index if not exists idx_gw_sales_proposals_tenant
  on public.gw_sales_proposals(tenant_id, status, sent_at desc);
create index if not exists idx_gw_sales_proposals_owner
  on public.gw_sales_proposals(sales_owner_id, status);
create index if not exists idx_gw_sales_proposals_company
  on public.gw_sales_proposals(company_id) where company_id is not null;

comment on table public.gw_sales_proposals is
  '/sales 提案管理。提案を送ったあとのフォローを提案単位で持つ。dx.enger の提案は source_proposal_id で1件だけ（db/138）';

-- 提案IDから、その提案を見てよいか（記録・タスクの RLS 用）
create or replace function public.gw_sales_proposal_visible_id(p_proposal uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.gw_sales_proposals p
     where p.id = p_proposal
       and public.gw_sales_proposal_visible(p.tenant_id, p.sales_owner_id))
$$;
revoke all on function public.gw_sales_proposal_visible_id(uuid) from public;
grant execute on function public.gw_sales_proposal_visible_id(uuid) to anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 3) 行動の記録（追記だけ。直す・消すポリシーは作らない）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_proposal_activities (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  proposal_id  uuid not null references public.gw_sales_proposals(id),        -- 既定の NO ACTION（提案は消さない）
  company_id   uuid references public.gw_sales_companies(id) on delete set null,  -- 記録した時点の企業（企業の履歴にも出す）

  kind text not null check (kind in (
    'sent',          -- 提案送信（dx.enger から）
    'call',          -- 電話（結果が必須）
    'mail',          -- メール（送信の記録）
    'reply',         -- 企業から返信・回答
    'check',         -- 回答確認（返信なし）
    'meeting',       -- 面談（日程確定・実施）
    'result',        -- 結果・状態の変更（成約・見送り・連絡停止・クローズ…）
    'decision',      -- 管理者の判断（継続・保留・クローズ）
    'assign',        -- 営業担当の変更
    'due_change',    -- タスクの期限変更（理由が必須）
    'task',          -- 手動タスクの追加・完了・取り消し
    'memo',          -- メモ
    'contact',       -- 窓口（連絡先）の更新
    'link',          -- 企業の紐付け・解除
    'sync'           -- dx.enger からの更新
  )),
  result       text check (result is null or char_length(result) <= 40),    -- 電話の結果など（lib/sales-proposals.js の値）
  outcome      text check (outcome is null or char_length(outcome) <= 40),  -- 通話できた・返信のときの中身（面談調整・検討中・見送り・別候補希望）
  evidence     text check (evidence is null or evidence in ('system', 'self_report')),  -- メール：システムで送った／自己申告
  channel      text check (channel is null or channel in ('phone', 'email', 'form', 'line', 'meeting', 'other')),
  occurred_at  timestamptz not null default now(),    -- 実施した日時
  employee_id  uuid references public.gw_employees(id) on delete set null,   -- 実施した人
  next_at      timestamptz,                           -- 折り返し予定・再連絡希望・面談の日時
  note         text check (note is null or char_length(note) <= 2000),
  detail       jsonb,                                 -- 変更の前後（担当・期限・状態）。個人情報は入れない
  source_event text check (source_event is null or char_length(source_event) <= 120),   -- 連携イベントID（同じイベントで2回記録しない）
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),

  -- 電話は結果と実施者が要る（「電話した」のチェックだけでは記録にしない）
  constraint gw_sales_proposal_activities_call check (kind <> 'call' or (result is not null and employee_id is not null)),
  constraint gw_sales_proposal_activities_mail check (kind <> 'mail' or (evidence is not null and employee_id is not null)),
  constraint gw_sales_proposal_activities_due check (kind <> 'due_change' or (note is not null and char_length(btrim(note)) > 0))
);

create index if not exists idx_gw_sales_proposal_activities_proposal
  on public.gw_sales_proposal_activities(proposal_id, occurred_at);
create index if not exists idx_gw_sales_proposal_activities_tenant
  on public.gw_sales_proposal_activities(tenant_id, kind, occurred_at desc);
create unique index if not exists uq_gw_sales_proposal_activities_event
  on public.gw_sales_proposal_activities(proposal_id, source_event) where source_event is not null;

comment on table public.gw_sales_proposal_activities is
  '/sales 提案の行動記録（電話・メール・返信・面談・結果・期限変更…）。追記だけ。誰が・いつ・何をしたか（db/138）';

-- -----------------------------------------------------------------------------
-- 4) タスク（やること）。完了は記録とひも付けたときだけ。完了・取り消しも行は残す
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_proposal_tasks (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  proposal_id      uuid not null references public.gw_sales_proposals(id),    -- NO ACTION

  kind text not null check (kind in (
    'call',            -- 電話
    'mail',            -- メール（不通のとき）
    'reply_check',     -- 回答確認
    'refollow',        -- 再フォロー（再電話・再メール）
    'manager_review',  -- 管理者の確認（継続・保留・クローズを決める）
    'meeting_fix',     -- 面談日程を確定する
    'meeting_result',  -- 面談の結果を記録する
    'manual'           -- 手で足したタスク
  )),
  title            text not null check (char_length(title) between 1 and 200),
  assignee_id      uuid references public.gw_employees(id) on delete set null,
  due_at           timestamptz not null,
  status           text not null default 'open' check (status in ('open', 'done', 'canceled')),
  auto             boolean not null default false,     -- 自動で作ったタスク
  source_event     text check (source_event is null or char_length(source_event) <= 120),  -- 同じ自動タスクを2つ作らない鍵

  done_at          timestamptz,
  done_by          uuid references auth.users(id) on delete set null,
  done_activity_id uuid references public.gw_sales_proposal_activities(id),   -- 完了の根拠になった記録
  cancel_reason    text check (cancel_reason is null or char_length(cancel_reason) <= 300),

  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- 完了は記録が要る（チェックだけで完了にしない）。完了日時と記録は完了のときだけ
  constraint gw_sales_proposal_tasks_done check (
    (status = 'done') = (done_at is not null and done_activity_id is not null)),
  constraint gw_sales_proposal_tasks_cancel check (
    status <> 'canceled' or (cancel_reason is not null and char_length(btrim(cancel_reason)) > 0))
);

create unique index if not exists uq_gw_sales_proposal_tasks_event
  on public.gw_sales_proposal_tasks(proposal_id, source_event) where source_event is not null;
create index if not exists idx_gw_sales_proposal_tasks_proposal
  on public.gw_sales_proposal_tasks(proposal_id, status, due_at);
create index if not exists idx_gw_sales_proposal_tasks_open
  on public.gw_sales_proposal_tasks(tenant_id, assignee_id, due_at) where status = 'open';

comment on table public.gw_sales_proposal_tasks is
  '/sales 提案のタスク。完了は行動記録（done_activity_id）が要る。完了・取り消しも履歴として残す（db/138）';

-- -----------------------------------------------------------------------------
-- 5) 設定（テナントごと1行。無ければ lib/sales-proposals.js の既定値）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_proposal_settings (
  tenant_id          uuid primary key references public.tenants(id) on delete cascade,
  biz_start          time not null default '09:00',
  biz_end            time not null default '18:00',
  first_call_minutes smallint not null default 30 check (first_call_minutes between 5 and 480),
  refollow_biz_days  smallint not null default 3 check (refollow_biz_days between 1 and 20),
  review_biz_days    smallint not null default 5 check (review_biz_days between 1 and 30),
  extra_holidays     date[] not null default '{}',   -- 自社の休業日（祝日・年末年始は lib/holidays.js が持っている）
  updated_by         uuid references auth.users(id) on delete set null,
  updated_at         timestamptz not null default now(),
  constraint gw_sales_proposal_settings_hours check (biz_start < biz_end),
  constraint gw_sales_proposal_settings_review check (review_biz_days >= refollow_biz_days)
);

comment on table public.gw_sales_proposal_settings is
  '/sales 提案フォローの設定（営業時間・初回電話の期限（分）・再フォロー／管理者確認の営業日数・自社休業日）。管理側だけが変える（db/138）';

-- -----------------------------------------------------------------------------
-- 6) 連携イベントの記録（dx.enger → /sales）。サーバ（service_role）だけが書く
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_proposal_sync_log (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  direction          text not null default 'inbound' check (direction in ('inbound', 'outbound')),
  source_system      text not null default 'enger' check (source_system in ('enger')),
  event_id           text not null check (char_length(event_id) between 8 and 120),
  event_type         text not null check (char_length(event_type) <= 60),
  source_proposal_id text check (source_proposal_id is null or char_length(source_proposal_id) <= 100),
  proposal_id        uuid references public.gw_sales_proposals(id) on delete set null,
  status             text not null check (status in ('ok', 'warning', 'error')),
  message            text check (message is null or char_length(message) <= 500),   -- 失敗・要確認の理由（個人情報は入れない）
  attempts           integer not null default 1 check (attempts >= 1),
  received_at        timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  resolved_at        timestamptz,       -- 管理側が「確認済み」にした
  resolved_by        uuid references auth.users(id) on delete set null
);

create unique index if not exists uq_gw_sales_proposal_sync_log_event
  on public.gw_sales_proposal_sync_log(tenant_id, source_system, event_id);
create index if not exists idx_gw_sales_proposal_sync_log_open
  on public.gw_sales_proposal_sync_log(tenant_id, status, received_at desc) where resolved_at is null;

comment on table public.gw_sales_proposal_sync_log is
  'dx.enger から届いた連携イベント。同じ event_id は1回だけ処理する。warning / error は「連携エラー」に出す（db/138）';

-- -----------------------------------------------------------------------------
-- 7) dx.enger の企業 → /sales の企業（社名では名寄せしない。人が確定したもの・ドメインが一致したもの）
-- -----------------------------------------------------------------------------
create table if not exists public.gw_sales_company_links (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  source_system     text not null default 'enger' check (source_system in ('enger')),
  source_company_id text not null check (char_length(source_company_id) between 1 and 100),
  company_id        uuid not null references public.gw_sales_companies(id) on delete cascade,
  method            text not null check (method in ('manual', 'domain', 'created')),
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists uq_gw_sales_company_links_source
  on public.gw_sales_company_links(tenant_id, source_system, source_company_id);

comment on table public.gw_sales_company_links is
  'dx.enger の企業ID → /sales の企業。社名の一致では作らない（manual＝人が確定／domain＝サイトのドメインが1社だけ一致／created＝提案から登録）（db/138）';

-- -----------------------------------------------------------------------------
-- 8) 書き込みの見張り（呼び出した人の権限で動く）
-- -----------------------------------------------------------------------------
create or replace function public.gw_sales_proposals_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_tenant uuid;
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id is distinct from old.tenant_id
       or new.source_system is distinct from old.source_system
       or new.source_proposal_id is distinct from old.source_proposal_id
       or new.sent_at is distinct from old.sent_at then
      raise exception 'gw_sales_proposals: テナント・連携元・連携キー・送信日時は変えられません' using errcode = '23514';
    end if;
    new.updated_at := now();
  end if;
  if new.sales_owner_id is not null
     and (tg_op = 'INSERT' or new.sales_owner_id is distinct from old.sales_owner_id)
     and not public.gw_sales_employee_ok(new.sales_owner_id, new.tenant_id) then
    raise exception 'gw_sales_proposals: 営業担当が同じテナントの在籍中の社員ではありません' using errcode = '23503';
  end if;
  if new.company_id is not null and (tg_op = 'INSERT' or new.company_id is distinct from old.company_id) then
    select tenant_id into v_tenant from public.gw_sales_companies where id = new.company_id;
    if v_tenant is null or v_tenant <> new.tenant_id then
      raise exception 'gw_sales_proposals: 企業が見つかりません' using errcode = '23503';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists gw_sales_proposals_guard on public.gw_sales_proposals;
create trigger gw_sales_proposals_guard
  before insert or update on public.gw_sales_proposals
  for each row execute function public.gw_sales_proposals_guard();

-- 記録・タスクは、提案と同じテナントのものだけ。タスクの担当者は同じテナントの社員だけ。
-- 完了の根拠の記録は、同じ提案のものだけ（別の提案の電話で完了にしない）
create or replace function public.gw_sales_proposal_child_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_tenant uuid;
  v_proposal uuid;
begin
  if tg_op = 'UPDATE' and (new.tenant_id is distinct from old.tenant_id or new.proposal_id is distinct from old.proposal_id) then
    raise exception '%: テナント・提案は変えられません', tg_table_name using errcode = '23514';
  end if;
  select tenant_id into v_tenant from public.gw_sales_proposals where id = new.proposal_id;
  if v_tenant is null or v_tenant <> new.tenant_id then
    raise exception '%: 提案が見つかりません', tg_table_name using errcode = '23503';
  end if;
  if tg_table_name = 'gw_sales_proposal_tasks' then
    if new.assignee_id is not null and (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id)
       and not public.gw_sales_employee_ok(new.assignee_id, new.tenant_id) then
      raise exception 'gw_sales_proposal_tasks: 担当者が同じテナントの在籍中の社員ではありません' using errcode = '23503';
    end if;
    if new.done_activity_id is not null then
      select proposal_id into v_proposal from public.gw_sales_proposal_activities where id = new.done_activity_id;
      if v_proposal is null or v_proposal <> new.proposal_id then
        raise exception 'gw_sales_proposal_tasks: 完了の記録がこの提案のものではありません' using errcode = '23503';
      end if;
    end if;
    -- 終わったタスクは開き直さない（記録の付け替え・完了の取り消しをしない。やり直しは新しいタスクで）
    if tg_op = 'UPDATE' and old.status <> 'open' and (new.status is distinct from old.status
       or new.done_activity_id is distinct from old.done_activity_id) then
      raise exception 'gw_sales_proposal_tasks: 完了・取り消し済みのタスクは変えられません' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' then new.updated_at := now(); end if;
  end if;
  return new;
end $$;

drop trigger if exists gw_sales_proposal_activities_guard on public.gw_sales_proposal_activities;
create trigger gw_sales_proposal_activities_guard
  before insert or update on public.gw_sales_proposal_activities
  for each row execute function public.gw_sales_proposal_child_guard();

drop trigger if exists gw_sales_proposal_tasks_guard on public.gw_sales_proposal_tasks;
create trigger gw_sales_proposal_tasks_guard
  before insert or update on public.gw_sales_proposal_tasks
  for each row execute function public.gw_sales_proposal_child_guard();

-- -----------------------------------------------------------------------------
-- 9) RLS
--    式には必ず gw_is_sales を入れる（db/check_130 の「gw_sales_* のポリシーは gw_is_sales」と揃える）
-- -----------------------------------------------------------------------------
alter table public.gw_sales_proposals            enable row level security;
alter table public.gw_sales_proposal_activities  enable row level security;
alter table public.gw_sales_proposal_tasks       enable row level security;
alter table public.gw_sales_proposal_settings    enable row level security;
alter table public.gw_sales_proposal_sync_log    enable row level security;
alter table public.gw_sales_company_links        enable row level security;

-- 提案：見る・作る・直す（消すポリシーは作らない）
drop policy if exists gw_sales_proposals_select on public.gw_sales_proposals;
create policy gw_sales_proposals_select on public.gw_sales_proposals
  for select using (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible(tenant_id, sales_owner_id));
drop policy if exists gw_sales_proposals_insert on public.gw_sales_proposals;
create policy gw_sales_proposals_insert on public.gw_sales_proposals
  for insert with check (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible(tenant_id, sales_owner_id));
drop policy if exists gw_sales_proposals_update on public.gw_sales_proposals;
create policy gw_sales_proposals_update on public.gw_sales_proposals
  for update using (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible(tenant_id, sales_owner_id))
  with check (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible(tenant_id, sales_owner_id));

-- 記録：見る・足すだけ（追記だけ）
drop policy if exists gw_sales_proposal_activities_select on public.gw_sales_proposal_activities;
create policy gw_sales_proposal_activities_select on public.gw_sales_proposal_activities
  for select using (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible_id(proposal_id));
drop policy if exists gw_sales_proposal_activities_insert on public.gw_sales_proposal_activities;
create policy gw_sales_proposal_activities_insert on public.gw_sales_proposal_activities
  for insert with check (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible_id(proposal_id));

-- タスク：見る・足す・直す（消すポリシーは作らない。取り消しは status = canceled）
drop policy if exists gw_sales_proposal_tasks_select on public.gw_sales_proposal_tasks;
create policy gw_sales_proposal_tasks_select on public.gw_sales_proposal_tasks
  for select using (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible_id(proposal_id));
drop policy if exists gw_sales_proposal_tasks_insert on public.gw_sales_proposal_tasks;
create policy gw_sales_proposal_tasks_insert on public.gw_sales_proposal_tasks
  for insert with check (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible_id(proposal_id));
drop policy if exists gw_sales_proposal_tasks_update on public.gw_sales_proposal_tasks;
create policy gw_sales_proposal_tasks_update on public.gw_sales_proposal_tasks
  for update using (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible_id(proposal_id))
  with check (public.gw_is_sales(tenant_id) and public.gw_sales_proposal_visible_id(proposal_id));

-- 設定：Sales の人は読める。変えるのは管理側だけ
drop policy if exists gw_sales_proposal_settings_select on public.gw_sales_proposal_settings;
create policy gw_sales_proposal_settings_select on public.gw_sales_proposal_settings
  for select using (public.gw_is_sales(tenant_id));
drop policy if exists gw_sales_proposal_settings_insert on public.gw_sales_proposal_settings;
create policy gw_sales_proposal_settings_insert on public.gw_sales_proposal_settings
  for insert with check (public.gw_is_sales(tenant_id) and public.gw_sales_is_manager(tenant_id));
drop policy if exists gw_sales_proposal_settings_update on public.gw_sales_proposal_settings;
create policy gw_sales_proposal_settings_update on public.gw_sales_proposal_settings
  for update using (public.gw_is_sales(tenant_id) and public.gw_sales_is_manager(tenant_id))
  with check (public.gw_is_sales(tenant_id) and public.gw_sales_is_manager(tenant_id));

-- 連携の記録：管理側が読む・「確認済み」にするだけ。書くのはサーバ（service_role）
drop policy if exists gw_sales_proposal_sync_log_select on public.gw_sales_proposal_sync_log;
create policy gw_sales_proposal_sync_log_select on public.gw_sales_proposal_sync_log
  for select using (public.gw_is_sales(tenant_id) and public.gw_sales_is_manager(tenant_id));
drop policy if exists gw_sales_proposal_sync_log_update on public.gw_sales_proposal_sync_log;
create policy gw_sales_proposal_sync_log_update on public.gw_sales_proposal_sync_log
  for update using (public.gw_is_sales(tenant_id) and public.gw_sales_is_manager(tenant_id))
  with check (public.gw_is_sales(tenant_id) and public.gw_sales_is_manager(tenant_id));

-- 企業の紐付け：Sales の人が見る・足す・直す（消すポリシーは作らない。付け替えは update＋監査ログ）
drop policy if exists gw_sales_company_links_select on public.gw_sales_company_links;
create policy gw_sales_company_links_select on public.gw_sales_company_links
  for select using (public.gw_is_sales(tenant_id));
drop policy if exists gw_sales_company_links_insert on public.gw_sales_company_links;
create policy gw_sales_company_links_insert on public.gw_sales_company_links
  for insert with check (public.gw_is_sales(tenant_id));
drop policy if exists gw_sales_company_links_update on public.gw_sales_company_links;
create policy gw_sales_company_links_update on public.gw_sales_company_links
  for update using (public.gw_is_sales(tenant_id)) with check (public.gw_is_sales(tenant_id));

commit;

notify pgrst, 'reload schema';

-- -----------------------------------------------------------------------------
-- 確認用（流したあと。db/check_138_sales_proposals.sql にまとめてある）
-- -----------------------------------------------------------------------------
-- select status, count(*) from public.gw_sales_proposals group by status order by 1;
-- select kind, status, count(*) from public.gw_sales_proposal_tasks group by 1, 2 order by 1, 2;
-- 完了なのに記録の無いタスク（0件のはず。CHECK で止まる）
-- select count(*) from public.gw_sales_proposal_tasks where status = 'done' and done_activity_id is null;
