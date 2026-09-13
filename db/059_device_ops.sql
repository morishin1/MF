-- =============================================================================
-- 059: 端末管理を「週1回で回る」形にする
--
-- ■ 何が足りていなかったか
--
--   1. WEB履歴（gw_device_web_visits）を消す仕組みが無かった
--      保存期間は 90日と決めてあるのに、消すのは gw_device_web_usage
--      （ドメインごとの合計）だけで、1件ずつの履歴が残り続けていた。
--      「90日で消える」と社員に言うなら、消える仕組みが要る。
--
--   2. 「△ 要確認」が、どこにも残らなかった
--      画面を開いたときに計算して出すだけだったので、
--      誰も開かなければ無かったことになり、
--      開いても「確認した」を押す先が無かった。
--
--   3. 「本人の確認待ち」が溜まっても、誰も気づかなかった
--      押していない人は、記録が1件も入らないまま放置される。
--      週1回ゼロにする運用にするなら、放置が見えないと回らない。
--
-- ■ どう直すか
--
--   ・履歴を消すための索引を足す（日付だけで引けるように）
--   ・△ は毎晩 gw_device_alerts に立てる（cron）。
--     既にある open → ack の流れに乗るので、「確認した」が押せる
--   ・確認待ちが何日か続いたら、同じくアラートにする
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: 057 を先に流してあること
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) 保存期間を過ぎた WEB履歴を消すための索引
--
--    既にある索引は (tenant_id, employee_id, work_date, started_at)。
--    「その人の、その日」を引くには効くが、
--    「この会社の、この日より前ぜんぶ」には効かない。
--    毎晩消しにいくので、そのための索引を足す
-- -----------------------------------------------------------------------------
create index if not exists idx_gw_device_web_visits_purge
  on public.gw_device_web_visits(tenant_id, work_date);


-- -----------------------------------------------------------------------------
-- 2) 確認待ちを、何日で「放置」とみなすか
--
--    押すまで記録は1件も入らない。押されないまま溜まるのが、
--    この仕組みでいちばん起きやすい失敗
-- -----------------------------------------------------------------------------
alter table public.gw_device_policies
  add column if not exists confirm_wait_days integer not null default 3;

comment on column public.gw_device_policies.confirm_wait_days is
  '本人が「このパソコンです」を押さないまま何日たったら知らせるか。'
  '既定3日。0 にすると知らせない';

comment on column public.gw_device_policies.keep_visits_days is
  'WEB履歴（1件ずつ）を何日ぶん残すか。既定90日。'
  '毎晩の cron（api/cron/devices.js）が、これを過ぎたぶんを消す';


-- -----------------------------------------------------------------------------
-- 3) アラートを、日付で引けるようにする
--
--    管理画面TOPで「未確認が何件あるか」を出す。
--    毎回ぜんぶ読んでいては重くなる
-- -----------------------------------------------------------------------------
create index if not exists idx_gw_device_alerts_open_sev
  on public.gw_device_alerts(tenant_id, status, severity);


notify pgrst, 'reload schema';

-- 確認:
--   select keep_visits_days, confirm_wait_days from public.gw_device_policies;
--
--   -- 90日より古い履歴が残っていないか（cron を1回まわしたあと）
--   select count(*) from public.gw_device_web_visits
--    where work_date < (current_date - 90);
--
--   -- 未確認のアラート
--   select rule, count(*) from public.gw_device_alerts
--    where status = 'open' and severity in ('warn','critical')
--    group by 1 order by 2 desc;
