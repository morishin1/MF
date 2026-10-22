-- 日報コーチ（db/148_behavior_coach.sql）の取り消し。本番は代表の明示承認後のみ。
--
-- ■ 何をするか
--   1. 日報・予定の保存トリガを外す（元の保存処理へ影響を残さない）
--   2. コーチ用の関数・表を消す。日報（tc_nippo）・予定・社員の行には触れない
--
-- ■ 止まる条件
--   送信を試みた／送った記録（delivery が none 以外、送信箱の attempted/unknown/sent）が1件でもあれば中断する。
--   送信の記録は、Slack 側の実メッセージと照合するまで消さない（照合・書き出しは別手順）。
--
-- ■ 急ぎでトリガだけ外したいとき（表と記録は残す）
--   drop trigger if exists gw_coach_nippo_after_save on public.tc_nippo;
--   drop trigger if exists gw_coach_schedule_after_save on public.gw_calendar_events;
begin;
do $$
begin
  if to_regclass('public.gw_coach_outbox') is not null
     and exists(select 1 from public.gw_coach_outbox where state in ('delivery_attempted','delivery_unknown','sent')) then
    raise exception '日報コーチの送信記録があります。Slack側と照合・書き出しするまで取り消せません';
  end if;
  if to_regclass('public.gw_coach_reviews') is not null
     and exists(select 1 from public.gw_coach_reviews where delivery_state<>'none') then
    raise exception '日報コーチの個別送信記録があります。Slack側と照合・書き出しするまで取り消せません';
  end if;
end $$;
drop trigger if exists gw_coach_nippo_after_save on public.tc_nippo;
drop trigger if exists gw_coach_schedule_after_save on public.gw_calendar_events;
drop function if exists public.gw_coach_nippo_changed();
drop function if exists public.gw_coach_schedule_changed();
drop function if exists public.gw_coach_collect(uuid,int);
drop function if exists public.gw_coach_enqueue(uuid,uuid,date,text,text);
drop function if exists public.gw_coach_refresh(uuid,text);
drop function if exists public.gw_coach_claim(uuid,bigint,uuid);
drop function if exists public.gw_coach_finish(uuid,bigint,uuid,text,jsonb);
drop function if exists public.gw_coach_approve(uuid,bigint,jsonb);
drop function if exists public.gw_coach_attempt(uuid,bigint,uuid);
drop function if exists public.gw_coach_complete_attempt(uuid,uuid,boolean,text);
drop function if exists public.gw_coach_record_check(uuid,uuid,date,text,text,date,date,text,jsonb,jsonb);
drop function if exists public.gw_coach_outbox_upsert(uuid,text,date,text,text,text,jsonb,text,text);
drop function if exists public.gw_coach_outbox_approve(uuid,bigint,jsonb);
drop function if exists public.gw_coach_outbox_attempt(uuid,bigint,uuid);
drop function if exists public.gw_coach_outbox_complete(uuid,uuid,boolean,text);
drop function if exists public.gw_coach_run_begin(uuid,date,text,text,uuid);
drop function if exists public.gw_coach_run_finish(uuid,date,text,uuid,boolean,jsonb);
drop table if exists public.gw_coach_runs;
drop table if exists public.gw_coach_outbox;
drop table if exists public.gw_coach_checks;
drop table if exists public.gw_coach_events;
drop table if exists public.gw_coach_recipients;
drop table if exists public.gw_coach_reviews;
drop table if exists public.gw_coach_config;
notify pgrst, 'reload schema';
commit;
