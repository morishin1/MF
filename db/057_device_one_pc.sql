-- =============================================================================
-- 057: 1台のパソコンを1行にする（エージェント＋ブラウザ）
--
-- ■ 何を変えるのか
--   053〜055 では、同じパソコンが台帳に2行に見えることがあった。
--     ・source='agent'   … 入れた会社のソフトが送る行
--     ・source='browser' … そのPCのブラウザが社内システムを開いたときの行
--   人から見れば1台なので、1行にまとめる。
--
--   まとめ方は今までと同じ仕組み（gw_devices.linked_device_id）を使う。
--   足りなかったのは「どのブラウザが、どういう状態でつながっているか」で、
--   それを持つ表をここで作る。
--
-- ■ ブラウザごとの状態を持つ
--   管理画面に出したいのはこの形。
--
--     田中太郎  DESKTOP-A123  Windows 11
--       Agent   ●接続中
--       Chrome  ●連携済
--       Edge    ●連携済
--       最終通信 10:32
--
--   「入っている（installed）」と「つながっている（linked）」は別。
--   Chrome が入っているのに拡張が動いていない、が分かるようにする。
--
-- ■ サイトはカテゴリだけ → ドメインも持つ
--   053 の gw_device_web_usage は category だけだった。
--   運用上ドメインまで要るという判断になったので host を足す。
--
--   ここは**取る中身が増える**変更なので、
--   本人に出す告知（api/devices/me.js の AGENT_NOTICE）も同時に直してある。
--   「取っていません」と書いてあるものを実は取っている、を作らない。
--
--   URLの全文・ページの中身・検索欄に打った文字は、今までどおり取らない。
--   入れる場所をこの表にも作っていない。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 053 → 054 → 055 を先に流してあること
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) ブラウザごとの状態
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_browsers (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  device_id   uuid not null references public.gw_devices(id) on delete cascade,

  -- chrome / edge / firefox / brave / opera
  browser     text not null,

  -- そのPCに入っているか（インストーラが見つけた）
  installed   boolean not null default false,
  -- 拡張がつながって、実際に届いているか
  linked      boolean not null default false,

  ext_version text,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz,

  updated_at  timestamptz not null default now(),

  constraint gw_device_browsers_uniq unique (device_id, browser)
);

create index if not exists idx_gw_device_browsers_dev
  on public.gw_device_browsers(device_id);

comment on table public.gw_device_browsers is
  '1台のPCの中の、ブラウザごとの状態。installed=入っている / linked=拡張から届いている';


-- -----------------------------------------------------------------------------
-- 2) サイトの記録に、ドメインと「どのブラウザから」を足す
--
--    既にある行は host='' のまま残る（カテゴリだけで入れていたぶん）。
--    一意の取り方が変わるので、古い制約は落として付け直す。
-- -----------------------------------------------------------------------------
alter table public.gw_device_web_usage
  add column if not exists host text not null default '';
alter table public.gw_device_web_usage
  add column if not exists browser text;

-- 053 で付けた (device_id, work_date, category) の一意を、host を含む形にする。
-- 名前は環境によって違うことがあるので、列の組み合わせから探して落とす
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class t on t.oid = con.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'gw_device_web_usage'
       and con.contype = 'u'
  loop
    execute format('alter table public.gw_device_web_usage drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.gw_device_web_usage
  add constraint gw_device_web_usage_uniq unique (device_id, work_date, host, category);

create index if not exists idx_gw_device_web_usage_host
  on public.gw_device_web_usage(device_id, work_date, minutes desc);

comment on column public.gw_device_web_usage.host is
  'ドメイン（example.com）。URLのパスも問い合わせも入らない。'
  '空文字は 057 より前に入れたカテゴリだけの行';


-- -----------------------------------------------------------------------------
-- 2-b) カテゴリを増やす
--
--   053 は work / research / sns / video / shopping / other の6つだった。
--   運用で見たいのは「社内システム」「AI」「検索」が分かれている形なので足す。
--   減らさないので、既にある行はそのまま通る
-- -----------------------------------------------------------------------------
alter table public.gw_device_web_usage drop constraint if exists gw_device_web_usage_category_check;
alter table public.gw_device_web_usage add constraint gw_device_web_usage_category_check
  check (category in ('internal','work','search','ai','research','sns','video','shopping','other'));


-- -----------------------------------------------------------------------------
-- 2-c) サイトの履歴（1回の滞在＝1行）
--
-- ■ ここは「取る中身がいちばん重いところ」
--   ドメインだけでなく **URLのパス** まで持つ。
--   /recruit/apply/step3 や /psychiatry/ のようなパスは、
--   転職活動・通院・信条まで映す。日別の合計とは重さが違うので、表を分ける。
--
-- ■ 取らないものは、入れる場所を作らない
--   問い合わせ（?q=…）も断片（#…）も、この表に列が無い。
--   端末の中で落としてから送る（agent/internal/collect）。
--   ページの中身・フォーム・Cookie・トークンも同じく列が無い。
--
-- ■ 勤務時間の内か外かを、入れるときに決めておく
--   「勤務中のWEB利用」を見るのが目的なので、
--   見るたびに打刻と突き合わせると重いし、あとから解釈がぶれる。
--
-- ■ 短く消す
--   日別の集計（gw_device_web_usage）より短い期間で消す。
--   既定は90日。gw_device_policies.keep_visits_days で変えられる
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_web_visits (
  id          bigserial primary key,
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  device_id   uuid not null references public.gw_devices(id) on delete cascade,
  employee_id uuid references public.gw_employees(id) on delete set null,

  work_date   date not null,
  started_at  timestamptz not null,
  ended_at    timestamptz,
  -- 実際にそのタブを見ていた秒数。開いていただけの時間は入れない
  active_sec  integer not null default 0,

  host        text not null,
  -- URLのパスだけ。問い合わせと断片は端末の中で落としてある
  path        text,
  category    text not null
              check (category in ('internal','work','search','ai','research','sns','video','shopping','other')),
  browser     text,

  -- 打刻（gw_time_entries）と突き合わせた結果。入れるときに決める
  in_work_hours boolean,

  created_at  timestamptz not null default now(),

  -- 同じ滞在が2回届いても1行。端末側の通し番号で見分ける
  constraint gw_device_web_visits_seq unique (device_id, started_at, host)
);

create index if not exists idx_gw_device_web_visits_emp
  on public.gw_device_web_visits(tenant_id, employee_id, work_date, started_at);
create index if not exists idx_gw_device_web_visits_dev
  on public.gw_device_web_visits(device_id, work_date, started_at);

comment on table public.gw_device_web_visits is
  'WEB利用の履歴。1回の滞在＝1行。ドメインとパスまで持つ。'
  '問い合わせ（?…）・断片（#…）・ページの中身・Cookie・トークンは列が無い';

alter table public.gw_device_policies
  add column if not exists keep_visits_days integer not null default 90;
-- 勤務時間の既定。打刻が無い日に使う
alter table public.gw_device_policies
  add column if not exists work_from text not null default '09:00';
alter table public.gw_device_policies
  add column if not exists work_to text not null default '18:00';
-- 勤務中にSNS・動画がこれを超えたら「要確認」
alter table public.gw_device_policies
  add column if not exists distract_min_minutes integer not null default 90;


-- -----------------------------------------------------------------------------
-- 3) 端末に、組み立ての跡を持たせる
--
--    ひとつのインストーラで済ませる形にしたので、
--    「どう入ったか」を残しておくと、あとで追える
-- -----------------------------------------------------------------------------
alter table public.gw_devices
  add column if not exists setup_kind text;         -- installer / manual
alter table public.gw_devices
  add column if not exists setup_at timestamptz;

comment on column public.gw_devices.setup_kind is
  'installer … EIGHT-Agent-Setup.exe が入れた / manual … 手で入れた';


-- -----------------------------------------------------------------------------
-- 4) 組み立てのときの、1回きりの引き換え札
--
--    インストーラは登録コードを本人に打たせない。
--    代わりに、このPCの中で作った札を持って既定のブラウザを開き、
--    ログイン済みの本人が押すと、そこで登録コードが発行されて
--    このPCへ戻る。札は1回使うと死ぬ。
--
--    札そのものは保存しない（ハッシュだけ）。
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_pairings (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text not null unique,

  -- 押した人が決まるまで tenant は分からない。使われたときに入る
  tenant_id    uuid references public.tenants(id) on delete cascade,
  employee_id  uuid references public.gw_employees(id) on delete set null,

  hostname     text,
  os           text,
  -- インストーラが見つけたブラウザ（chrome, edge …）
  browsers     text[] not null default '{}',

  -- 本人が押したブラウザの印（localStorage の device_uid）。
  -- エージェントの登録が終わった時点で、このブラウザの行を同じPCに束ねる
  device_uid   text,

  used_at      timestamptz,
  -- 発行した登録コードの行。あとから突き合わせる
  enrollment_id uuid references public.gw_device_enrollments(id) on delete set null,

  -- 発行した登録コードそのもの。
  --
  -- gw_device_enrollments は「平文は保存しない」表なので、あちらには置かない。
  -- こちらは組み立てのあいだ（15分）だけ生きる行で、
  -- インストーラが1回引き取った時点で行ごと消える。
  -- RLS のポリシーを1つも作っていないので、誰からも select できない
  code_once    text,

  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_gw_device_pairings_exp
  on public.gw_device_pairings(expires_at);

comment on table public.gw_device_pairings is
  'インストーラが作る1回きりの札。本人がブラウザで押すと登録コードに換わる。'
  '札の中身は保存しない（token_hash だけ）';


-- -----------------------------------------------------------------------------
-- 5) RLS
--
--    ブラウザの状態は、端末と同じ見え方にする（人事・管理者は全件、本人は自分の分）。
--    引き換え札は誰にも見せない。API（service_role）だけが触る
-- -----------------------------------------------------------------------------
alter table public.gw_device_browsers enable row level security;
alter table public.gw_device_pairings enable row level security;
alter table public.gw_device_web_visits enable row level security;

-- 履歴は、人事・管理者と、本人だけ。
-- 本人が自分の記録を見られないと、「何を見られているか分からない」になる
drop policy if exists gw_device_web_visits_read on public.gw_device_web_visits;
create policy gw_device_web_visits_read on public.gw_device_web_visits
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or employee_id = public.gw_employee_id(tenant_id)
  );

drop policy if exists gw_device_browsers_read on public.gw_device_browsers;
create policy gw_device_browsers_read on public.gw_device_browsers
  for select to authenticated
  using (
    public.gw_is_hr(tenant_id)
    or exists (
      select 1 from public.gw_devices d
       where d.id = gw_device_browsers.device_id
         and d.employee_id = public.gw_employee_id(gw_device_browsers.tenant_id)
    )
  );

-- gw_device_pairings には select のポリシーを1つも作らない。
-- RLS が有効で、ポリシーが無い＝ anon / authenticated からは1行も見えない


notify pgrst, 'reload schema';

-- 確認:
--   select d.label, b.browser, b.installed, b.linked, b.last_seen_at
--     from public.gw_devices d
--     join public.gw_device_browsers b on b.device_id = d.id
--    order by d.label, b.browser;
--
--   -- ドメインごとの時間（その日）
--   select host, category, sum(minutes) from public.gw_device_web_usage
--    where work_date = current_date and host <> '' group by 1,2 order by 3 desc limit 20;
