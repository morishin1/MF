-- =============================================================================
-- 087: 採用HR Stage 9 — 契約書作成依頼と、採用承諾条件の突き合わせ
--
-- ■ 何を守るか
--
--   候補者が実際に承諾した合格通知（gw_hr_offers、accepted_atあり）と、
--   契約書作成依頼を出す時点の労働条件（gw_contracts・gw_employees）が
--   食い違ったまま、社労士へ正式に契約書作成を依頼させない。
--
--   本来のやり直し方は「本人と条件を再確認し、必要ならoffer再発行→本人再承諾」。
--   それでもどうしても必要なときだけ、owner・hrに限り、理由つきで進められる
--   ようにする（override）。誰が・いつ・なぜ迂回したかを残す
--
-- ■ 新しい契約・署名の仕組みは作らない
--   gw_doc_orders（db/056）に列を足すだけ。判定そのものはコード側
--   （lib/esign.js）で行う。この移行は列の追加のみ
--
-- 実行方法: Supabase の SQL Editor に貼って Run（べき等）
-- 前提: db/056_doc_orders.sql・db/081_hr_recruiting.sql
-- =============================================================================

alter table public.gw_doc_orders
  add column if not exists override_reason text,
  add column if not exists override_by     uuid references auth.users(id) on delete set null,
  add column if not exists override_at     timestamptz;

comment on column public.gw_doc_orders.override_reason is
  '採用承諾時の条件と食い違ったまま依頼を出した理由（owner・hrだけが書ける）。'
  '通常の導線ではない。正規のやり直しは本人との再確認・offer再発行';
comment on column public.gw_doc_orders.override_by is
  'この依頼を、条件不一致のまま進めることを決めた人';

notify pgrst, 'reload schema';

-- 確認:
--   select id, employee_id, override_reason, override_by, override_at
--     from public.gw_doc_orders where override_at is not null;
