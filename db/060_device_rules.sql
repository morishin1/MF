-- =============================================================================
-- 060: 端末管理を「会社ルール」の形にする
--
-- ■ 何が変わるのか
--
--   これまでは「本人が同意したら記録する」形だった。
--   これを「会社ルールとして端末管理を行い、事前に周知する」形に変える。
--
--   ・社員に「監視してよいですか」と許可を求めない
--   ・会社ルールであることを事前に周知し、本人が内容を確認した日時を残す
--   ・社員が拒否して端末管理を解除する仕組みは作らない
--
--   周知の記録は、これまでと同じ gw_devices.notified_at に入れる。
--   意味が「同意した」から「周知を受けて確認した」に変わるので、
--   誰の操作で立ったのか（本人か、管理者が対面で周知したのか）を分けて残す。
--
--   本人が押さないまま放置されても、管理者が「周知済みにする」で前に進める。
--   押さないことが拒否になってしまうと、結局は同意の仕組みと同じになる。
--
-- ■ 私物PC
--
--   業務は原則、会社貸与PCのみ。私物PCには EIGHT Agent を入れない。
--   私物・未登録のパソコンから社内システムに入られたら、管理画面に出す。
--
--   やむを得ない私物PC利用は、管理者の事前承認制にする。
--   誰が・どの端末で・なぜ・誰が承認し・いつまで、を残す。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 059 を先に流してあること
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) その端末は、会社のものか私物か
--
--    会社のソフト（エージェント）が入っているものは会社貸与。
--    ブラウザだけで入ってきたものは、まだ分からない（unknown）。
--    管理者が見て決める
-- -----------------------------------------------------------------------------
alter table public.gw_devices
  add column if not exists ownership text not null default 'unknown';

do $$
begin
  alter table public.gw_devices
    add constraint gw_devices_ownership
    check (ownership in ('company', 'personal', 'unknown'));
exception when duplicate_object then null;
end $$;

comment on column public.gw_devices.ownership is
  'company=会社貸与 / personal=私物 / unknown=まだ分からない。'
  '私物PCでの業務利用は禁止。unknown と personal は管理画面で目立たせる';

-- エージェントが入っているものは、会社が配ったものしかない
update public.gw_devices set ownership = 'company'
 where source = 'agent' and ownership = 'unknown';

create index if not exists idx_gw_devices_ownership
  on public.gw_devices(tenant_id, ownership);


-- -----------------------------------------------------------------------------
-- 2) 周知の記録を、誰の操作で立てたのか
--
--    notified_at は「本人が内容を確認した日時」。
--    同意ではなく、会社ルールを周知した記録。
--
--    本人が押せないまま止まる（休職・入院・退職直前など）ことがあるので、
--    管理者が対面や書面で周知したときも記録できるようにする。
--    そのときは理由を必ず残す
-- -----------------------------------------------------------------------------
alter table public.gw_devices
  add column if not exists notified_kind text;
alter table public.gw_devices
  add column if not exists notified_by uuid references auth.users(id) on delete set null;
alter table public.gw_devices
  add column if not exists notified_note text;

do $$
begin
  alter table public.gw_devices
    add constraint gw_devices_notified_kind
    check (notified_kind is null or notified_kind in ('self', 'admin'));
exception when duplicate_object then null;
end $$;

comment on column public.gw_devices.notified_at is
  '会社ルール（端末管理）の内容を確認した日時。同意ではなく周知の記録';
comment on column public.gw_devices.notified_kind is
  'self=本人が画面で確認した / admin=管理者が対面・書面で周知した';
comment on column public.gw_devices.notified_note is
  'admin のときの理由。「いつ・どこで・どう周知したか」を残す';

-- これまでに立っているものは、すべて本人が押したもの
update public.gw_devices set notified_kind = 'self'
 where notified_at is not null and notified_kind is null;


-- -----------------------------------------------------------------------------
-- 3) 未登録・私物のパソコンから入られたときの扱い
--
--    いまは「管理画面に出す」だけ。
--    将来、警告・管理者通知・ログイン制限・アクセス拒否まで選べるように、
--    設定を先に持っておく（画面から選べるのは、実装したものだけ）
-- -----------------------------------------------------------------------------
alter table public.gw_device_policies
  add column if not exists unregistered_action text not null default 'notice';

do $$
begin
  alter table public.gw_device_policies
    add constraint gw_device_policies_unregistered
    check (unregistered_action in ('notice', 'warn', 'notify_admin', 'restrict', 'deny'));
exception when duplicate_object then null;
end $$;

comment on column public.gw_device_policies.unregistered_action is
  '未登録・私物のパソコンから入られたときの扱い。'
  'notice=管理画面に出すだけ / warn=本人にも画面で伝える / '
  'notify_admin=管理者に通知 / restrict=一部を止める / deny=入れない。'
  'restrict と deny は入口を止める作りが別に要る（まだ実装していない）';


-- -----------------------------------------------------------------------------
-- 4) やむを得ない私物PC利用の、事前承認
--
--    「だめです」だけだと、現場は黙って使う。
--    例外の通し方を用意して、記録に残るほうを選ばせる
-- -----------------------------------------------------------------------------
create table if not exists public.gw_device_exceptions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  employee_id uuid not null references public.gw_employees(id) on delete cascade,

  -- 台帳に載っている端末を指すこともあれば、これから使う端末のこともある
  device_id   uuid references public.gw_devices(id) on delete set null,
  device_note text,                       -- 端末の説明（「自宅の Mac」など）

  reason      text not null,              -- なぜ私物を使う必要があるのか
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz not null default now(),
  expires_on  date not null,              -- いつまで。無期限にはしない

  revoked_at  timestamptz,
  revoked_by  uuid references auth.users(id) on delete set null,
  note        text,

  created_at  timestamptz not null default now()
);

create index if not exists idx_gw_device_exceptions_emp
  on public.gw_device_exceptions(tenant_id, employee_id, expires_on desc);

comment on table public.gw_device_exceptions is
  'やむを得ない私物PC利用の事前承認。'
  '対象社員・端末・理由・承認者・利用期限を残す。期限が切れたら承認は無効';

alter table public.gw_device_exceptions enable row level security;

-- 本人は、自分に出ている承認だけ読める。
-- 書けるのは service_role（API）だけ
drop policy if exists gw_device_exceptions_read on public.gw_device_exceptions;
create policy gw_device_exceptions_read on public.gw_device_exceptions
  for select to authenticated
  using (employee_id = public.gw_employee_id(tenant_id));


notify pgrst, 'reload schema';

-- 確認:
--   select ownership, count(*) from public.gw_devices group by 1;
--   select notified_kind, count(*) from public.gw_devices
--    where notified_at is not null group by 1;
--   select unregistered_action from public.gw_device_policies;
--   select e.reason, e.expires_on, e.revoked_at
--     from public.gw_device_exceptions e order by e.approved_at desc;
