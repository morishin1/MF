-- 【提案・未適用】db/proposal_hr_inbox_reads.sql の戻し。
-- 既読の記録だけを消す。受信メール（gw_hr_inbound_mail）と、その対応状態・メモ・紐づけには触れない。
-- 戻したあと、API は未読数を「確認できない」と返す（0件にはしない）。
begin;
drop table if exists public.gw_hr_inbound_mail_reads;
drop function if exists public.gw_hr_inbound_mail_reads_tenant_guard();
notify pgrst, 'reload schema';
commit;
