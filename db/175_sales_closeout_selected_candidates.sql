-- 175: Final proposal selections in the Sales closeout.
alter table public.gw_sales_meeting_closeouts
 add column if not exists offered_keys jsonb not null default '[]'::jsonb;
alter table public.gw_sales_meeting_closeouts
 add constraint gw_sales_closeout_offered_keys_array
 check (jsonb_typeof(offered_keys)='array' and jsonb_array_length(offered_keys) between 0 and 30);