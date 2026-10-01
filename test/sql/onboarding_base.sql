-- 入社管理の「土台」。本番では、すでに適用されているはずのもの（check_onboarding_ready.sql の 1xx・121 が、無ければ「不足」と言う）。
-- この土台の上に、docs/onboarding-db-prereq.md の最小の流し方（006 → 008 → 009 → 012 → 037 → 039 → 066 → 110）を流して確かめる。
--   007 … 本人が自分の社員名簿の行を読めるポリシー（gw_employees_self_select）
--   031・033 … gw_employees の列（autonomy_level・manager_id・job_family_code・initial_role・work_style）。
--              この2つは日報の表（tc_nippo など、別のアプリの表）を前提にしていて、ここでは流せないので、列だけを足す
--   026 … gw_is_internal_staff()（db/039 の前提）。026 そのものも日報の表が要るので、関数の定義だけを、ファイルから切り出して流す
\set ON_ERROR_STOP 0
\set p007 `echo "$SCEN_ROOT/db/007_notices.sql"`
\set f026 `awk '/^create or replace function public.gw_is_internal_staff/,/^grant execute on function public.gw_is_internal_staff/' "$SCEN_ROOT/db/026_nippo_ai_eval.sql"`
\i :p007
alter table public.gw_employees add column if not exists manager_id uuid references public.gw_employees(id) on delete set null;
alter table public.gw_employees add column if not exists job_family_code text;
alter table public.gw_employees add column if not exists initial_role text;
alter table public.gw_employees add column if not exists work_style text;
alter table public.gw_employees add column if not exists autonomy_level smallint;
:f026
grant all on all tables in schema public to authenticated, service_role;
