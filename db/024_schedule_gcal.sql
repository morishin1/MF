-- =============================================================================
-- 024: 社内の予定を、本人の Google カレンダーへ書き出せるようにする
--
-- これまで（018）は「読むだけ」だった。本人の Google カレンダーを読んで
-- 社内の予定と並べて表示するところまで。
-- ここから先は逆向きに、社内で入れた予定を本人の Google カレンダーへ入れる。
--
-- 何を持つか
--   書き出した予定の Google 側の id を控える。これが無いと、
--   同じ予定を2回押したときに向こうに2件できる。id があれば2回目は上書きになる。
--
-- ★ 併せて必要な作業（SQLだけでは足りない）
--   OAuth の権限（スコープ）に「予定の書き込み」を足したので、
--   既に連携している人は一度つなぎ直す必要がある。
--   古い権限のままだと書き込みが 403 で断られる。
--   画面には「つなぎ直してください」と出るようにしてある。
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- =============================================================================

-- Google 側の予定 id。null なら「まだ書き出していない」
alter table public.gw_calendar_events
  add column if not exists gcal_event_id text;

-- 最後に書き出した時刻。社内で直したあと書き出し直したかを見分ける
alter table public.gw_calendar_events
  add column if not exists gcal_synced_at timestamptz;

comment on column public.gw_calendar_events.gcal_event_id is
  '本人の Google カレンダーに書き出したときの向こうの予定id。2回押しても増やさないために持つ';

-- 書き出し済みの予定だけを引くことがあるので索引を1つ。
-- 部分索引にしているのは、大半が null（書き出していない）になるため
create index if not exists idx_gw_calendar_events_gcal
  on public.gw_calendar_events(employee_id)
  where gcal_event_id is not null;

-- PostgREST のスキーマキャッシュを更新（列追加直後の保存失敗を防ぐ）
notify pgrst, 'reload schema';

-- 確認:
--   select id, title, gcal_event_id, gcal_synced_at
--     from public.gw_calendar_events order by starts_at desc limit 20;
