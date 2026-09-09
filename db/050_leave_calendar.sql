-- =============================================================================
-- 050: 承認した休暇を、社内の予定表にも出す
--
-- ■ 何が起きていたか
--   休暇申請を承認しても、mf の「スケジュール」には何も出なかった。
--   承認処理が書いていたのは Google カレンダーだけで（lib/gcal.js の syncAllDay）、
--   社内の予定表（gw_calendar_events）には触れていなかった。
--   しかも Google 側は、サービスアカウントと既定カレンダーが設定されていないと
--   何もせずに戻る。つまり、たいていの環境では文字どおり何も起きていなかった。
--
-- ■ どこから来た予定かを持たせる
--   承認で作った予定は、取り下げ・却下のときに消さなければならない。
--   消すには「どの申請から作ったか」が要る。
--   source / source_id を足して、そこから引けるようにする。
--
--   source = 'self'    … 本人が画面から入れた予定（これまでどおり）
--            'leave'   … 休暇の承認から自動でできた予定
--            'booking' … スペース予約から（将来）
--
-- ■ 自動でできた予定は、本人にも直させない
--   直せてしまうと、申請は休みなのに予定表では出社、という食い違いが起きる。
--   直すのは申請そのもの。予定表はその結果を映すだけ。
--   （API 側で source <> 'self' の更新・削除を断る）
-- =============================================================================

alter table public.gw_calendar_events
  add column if not exists source text not null default 'self';

alter table public.gw_calendar_events
  add column if not exists source_id uuid;

do $$
begin
  alter table public.gw_calendar_events
    add constraint gw_calendar_events_source
    check (source in ('self', 'leave', 'booking'));
exception
  when duplicate_object then null;
end $$;

-- 1つの申請から予定が2つできないようにする。
-- 承認 → 取り下げ → 再承認 を繰り返しても、行は1つのまま。
--
-- ■ where を付けない理由
--   はじめ `where source <> 'self'` の部分索引にしていたが、
--   部分索引は ON CONFLICT の対象にできない
--   （"there is no unique or exclusion constraint matching the ON CONFLICT
--     specification" になる。PostgREST の upsert では where を書けない）。
--   条件を外しても困らない。本人が入れた予定は source_id が null で、
--   一意索引の中で NULL 同士はぶつからないので、何件でも入る。
create unique index if not exists uq_gw_calendar_events_source
  on public.gw_calendar_events(source, source_id);

comment on column public.gw_calendar_events.source is
  'self=本人が入れた / leave=休暇の承認から自動 / booking=予約から自動。'
  '自動でできたものは、予定表からは直せない（直すのは申請のほう）';
comment on column public.gw_calendar_events.source_id is
  'もとになった申請・予約の id。取り下げのときに、これで引いて消す';

notify pgrst, 'reload schema';

-- 確認:
--   select source, count(*) from public.gw_calendar_events group by source;
--
--   -- 承認済みの休暇と、予定表の行が対応しているか
--   select r.id, r.starts_on, r.ends_on, e.title
--     from public.gw_requests r
--     left join public.gw_calendar_events e
--            on e.source = 'leave' and e.source_id = r.id
--    where r.kind = 'leave' and r.status = 'approved'
--    order by r.starts_on desc;
