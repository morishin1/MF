-- =============================================================================
-- 069: 旧タスク管理（zimu_tasks）の未完了ぶんを、グループウェアへ移す
--
-- ■ 1回だけ流すもの
--
--   068 までと違って、これは移行用。何度流しても増えないようにしてあるが
--   （移したものに印を付けて、次は飛ばす）、用が済んだら流さなくてよい。
--
-- ■ 未完了だけ移す
--
--   完了・アーカイブ済みまで移すと、新しい一覧が過去の完了タスクで埋まる。
--   過去の記録は旧画面（8grp.co.jp/8/zimu/task/）に残るので、
--   見たいときはそちらで見る。ここへ持ってくるのは、いま動いている仕事だけ。
--
-- ■ 消さない
--
--   旧の行は1件も消さない・書き換えない。
--   移したあとに何かおかしければ、旧画面がそのまま正になる。
--
-- ■ 同じ Supabase プロジェクトにあることが前提
--
--   社内の4システムは同じプロジェクト・同じ auth.users を使っている
--   （docs/accounts.md）。その前提でこの1本が動く。
--   もし zimu_tasks が別プロジェクトにあるなら、下の 0) で止まって
--   そう言うので、そのときは旧側で CSV に出して取り込む。
--
-- 実行方法: Supabase の SQL Editor に貼って Run
-- 前提: 009_tasks.sql → 044 → 068_task_flow.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) そもそも旧の表がここにあるか
--
--    無いまま下を流すと「relation does not exist」とだけ出て、
--    別プロジェクトなのか、まだ 068 を流していないのかが分からない
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.zimu_tasks') is null then
    raise exception E'\n\n'
      '旧タスクの表（public.zimu_tasks）が、このプロジェクトにありません。\n'
      '別の Supabase プロジェクトに入っている可能性があります。\n'
      'その場合は、旧側で次を実行して CSV に落とし、こちらへ取り込んでください:\n'
      '  select * from public.zimu_tasks\n'
      '   where coalesce(archived,false) = false\n'
      '     and coalesce(deleted,false)  = false\n'
      '     and status <> ''完了'';\n';
  end if;
  if to_regclass('public.gw_tasks') is null then
    raise exception '先に db/009_tasks.sql を流してください';
  end if;
  perform 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'gw_tasks' and column_name = 'occ_key';
  if not found then
    raise exception '先に db/068_task_flow.sql を流してください';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 1) 移した印を置く場所
--
--    旧の行は触らない（触ると旧画面の見え方が変わる）。
--    どれを移したかは、こちら側に持つ
-- -----------------------------------------------------------------------------
create table if not exists public.gw_task_imports (
  zimu_id    uuid primary key,
  task_id    uuid references public.gw_tasks(id) on delete set null,
  imported_at timestamptz not null default now()
);
comment on table public.gw_task_imports is
  '旧タスク管理（zimu_tasks）から移した控え。二度移さないための印';

-- ------------------------------------------------------------------------------
-- 2) 移す
--
--    ・未完了だけ（完了・アーカイブ・削除は除く）
--    ・繰り返しの「元」（is_template）は移さない
--        新しい側の繰り返しは gw_tasks 側で作り直す。
--        元まで移すと、旧の生成と新しい生成の両方が動いて二重になる
--    ・担当者は氏名ではなく auth.users の id でつなぐ
--        旧は assignee（氏名）と assignee_id の両方を持っていた。
--        氏名でつなぐと「田中」と「田中 一郎」で行方不明になるので id で引く
--
--    1行ずつ回す。まとめて insert して返ってきた行を突き合わせる書き方だと、
--    同じ名前・同じ作成時刻のタスクが2件あったときに、どちらがどれか決まらない
-- ------------------------------------------------------------------------------
do $$
declare
  v_tenant uuid;
  r        record;
  v_new    uuid;
  v_n      integer := 0;
begin
  -- 事業者は1つ（自社1社運用）。いちばん古いものを使う
  select id into v_tenant from public.tenants order by created_at limit 1;
  if v_tenant is null then
    raise exception '事業者（tenants）がありません。先に初期設定を済ませてください';
  end if;

  for r in
    select z.*,
           ea.id      as gw_assignee,
           er.user_id as gw_creator
      from public.zimu_tasks z
      left join public.gw_employees ea
             on ea.user_id = z.assignee_id  and ea.tenant_id = v_tenant
      left join public.gw_employees er
             on er.user_id = z.requester_id and er.tenant_id = v_tenant
     where coalesce(z.archived,    false) = false
       and coalesce(z.deleted,     false) = false
       and coalesce(z.is_template, false) = false
       and coalesce(z.status, '') <> '完了'
       and not exists (select 1 from public.gw_task_imports i where i.zimu_id = z.id)
     order by z.created_at
  loop
    insert into public.gw_tasks
      (tenant_id, title, body, assignee_id, due_on, priority, status, category,
       done_condition, accepted_at, created_by, created_at)
    values (
      v_tenant,
      coalesce(nullif(btrim(r.name), ''), '（名前なし）'),
      -- メモと時間帯は本文にまとめる。列を増やして持ち替えるほどのものではない
      nullif(btrim(concat_ws(E'\n',
        nullif(btrim(coalesce(r.memo, '')), ''),
        case when nullif(btrim(coalesce(r.time_range, '')), '') is not null
             then '時間帯: ' || r.time_range end)), ''),
      r.gw_assignee,
      r.due_date,
      case r.priority when '高' then 'high' when '低' then 'low' else 'normal' end,
      case r.status   when '進行中' then 'doing' else 'todo' end,
      nullif(btrim(coalesce(r.category, '')), ''),
      nullif(btrim(coalesce(r.done_condition, '')), ''),
      -- 旧で受諾済みなら、こちらでも受諾済みにする。
      -- 移した瞬間に全部が「未確認の依頼」になると、担当者の画面が赤で埋まる
      r.accepted_at,
      r.gw_creator,
      r.created_at)
    returning id into v_new;

    insert into public.gw_task_imports (zimu_id, task_id) values (r.id, v_new);
    v_n := v_n + 1;
  end loop;

  raise notice '移したタスク: % 件', v_n;
end $$;

notify pgrst, 'reload schema';

-- 確認:
--   -- 何件移ったか
--   select count(*) from public.gw_task_imports;
--   -- 担当者が付かなかったもの（旧に assignee_id が無かった行）
--   select t.title, t.due_on
--     from public.gw_tasks t
--     join public.gw_task_imports i on i.task_id = t.id
--    where t.assignee_id is null;
--   -- 旧側は減っていないこと
--   select count(*) from public.zimu_tasks;
