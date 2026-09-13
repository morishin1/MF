-- =============================================================================
-- 061: 端末登録を、本人がマイページから始める形にする
--
-- ■ やめること
--
--   管理者が「登録コードを出す」→ 社員に渡す → 社員が打ち込む、という運用。
--
--   社員はグループウェアにログインしている。誰なのかはもう分かっている。
--   それなのにコードを配って打たせるのは、配る手間と打ち間違いを
--   足しているだけで、確かめられることは増えていない。
--
-- ■ 代わりにすること
--
--   ログイン中の本人が、マイページから1回きりの札を作る。
--   その札は最初から「その人のもの」なので、
--   あとから社員名を選ぶ場面が無くなる。
--
--     マイページ →「会社PCのセキュリティ設定」
--       → 端末設定ページで札を作る（15分・1回きり）
--       → EIGHT-Agent-Setup.exe を落とす（ファイル名に札が入る）
--       → 実行する
--       → インストーラが自分のファイル名から札を読む
--       → ブラウザが自動で戻る
--       →「内容を確認しました」
--
--   ファイル名から読めなかったとき（名前を変えられた等）は、
--   これまでどおりインストーラが自分で札を作る。止まらない。
--
-- ■ 表は増やさない
--
--   gw_device_pairings をそのまま使う。違いは「いつ人が決まるか」だけ:
--     installer  … インストーラが作る。押した人が持ち主になる（従来）
--     selfserve  … 本人が作る。最初から持ち主が決まっている（今回）
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 053 → 054 → 055 → 057 → 059 → 060 の順で流してあること
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 札を、誰が作ったのか
-- -----------------------------------------------------------------------------
alter table public.gw_device_pairings
  add column if not exists kind text not null default 'installer';

do $$
begin
  alter table public.gw_device_pairings
    add constraint gw_device_pairings_kind
    check (kind in ('installer', 'selfserve'));
exception when duplicate_object then null;
end $$;

comment on column public.gw_device_pairings.kind is
  'installer=インストーラが作った（押した人が持ち主になる） / '
  'selfserve=本人がマイページで作った（最初から持ち主が決まっている）';

comment on column public.gw_device_pairings.employee_id is
  'この札の持ち主。selfserve では作った時点で入る。'
  'installer では、本人が押したときに入る';

-- 本人のぶんを探す。1人が作れる生きた札は1本だけにするため、
-- 新しく作るときに古いものを消す
create index if not exists idx_gw_device_pairings_emp
  on public.gw_device_pairings(employee_id, expires_at desc)
  where employee_id is not null;


-- -----------------------------------------------------------------------------
-- 2) 管理者が発行する登録コードは、もう出さない
--
--    表は消さない。「誰が・誰あてに・いつ出し、いつ使われたか」は
--    監査の記録なので残す。出す口だけを閉じる（api/devices/index.js）
-- -----------------------------------------------------------------------------
comment on table public.gw_device_enrollments is
  '登録コードの発行と使用の記録。'
  '061 以降、管理者が新しく発行することはない（本人がマイページから登録する）。'
  '過去の記録として残す';


-- -----------------------------------------------------------------------------
-- 3) インストーラの置き場
--
--    ファイル名に札を入れて渡すには、名前を指定できる置き場が要る。
--    Supabase Storage なら、署名つきURLで名前を決められる。
--
--    非公開。落とせるのは、生きている札を持っている人だけ
--    （api/devices/setup.js が、札を確かめてから署名つきURLを作る）。
--
--    ここに置かない場合も動く。ただしファイル名を決められないので、
--    インストーラは自分で札を作る側に回り、社員が画面で1回押すことになる
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('agent', 'agent', false)
on conflict (id) do nothing;

-- 読み書きは service_role（API）だけ。
-- authenticated に直接触らせない（署名つきURLごしに渡す）
drop policy if exists gw_agent_read on storage.objects;


notify pgrst, 'reload schema';

-- 確認:
--   select kind, count(*) from public.gw_device_pairings group by 1;
--
--   -- 生きている札
--   select kind, employee_id, expires_at, used_at
--     from public.gw_device_pairings
--    where expires_at > now() order by created_at desc;
--
--   -- 置き場
--   select id, public from storage.buckets where id = 'agent';
--
-- インストーラの置き方（管理者が1回だけ）:
--   1. agent/build.sh で EIGHT-Agent-Setup.exe を作る
--   2. Supabase の Storage → agent バケットに上げる
--   3. 版に署名して gw_device_releases に入れる（docs/device-zero-cost.md）
--      url は Storage のオブジェクトURLにする。そうするとファイル名に札が入る
