-- =============================================================================
-- 097: 契約と締結済み書面の明示的な関連ID（GW「契約締結×キャリア設定」完了状態 §18）
--
-- ■ 何をするものか
--   これまで「この署名依頼がどの契約に対応するか」は、doc_kind（雇用契約）と
--   時期の近さから推測していた（lib/career.js CONTRACT_DOC_KINDS）。
--   「契約締結済み」を正しく判定するには、明示的な関連が要る。
--
-- ■ 新しい大きな表は作らない
--   gw_sign_requests に contract_id を1列足すだけ。056 の order_id と同じ考え方
--   （gw_doc_orders への参照列を、そのまま gw_contracts への参照列としても持つ）。
--
-- ■ 後方互換
--   既存の署名依頼は contract_id が null のまま（無理に遡って埋めない）。
--   null のときは、これまでどおり doc_kind + 時期の近さで推測する
--   （lib/career.js の contractStatus() が両方を見る）。
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 029_contracts.sql, 046_esign.sql
-- =============================================================================

begin;

alter table public.gw_sign_requests
  add column if not exists contract_id uuid references public.gw_contracts(id) on delete set null;

create index if not exists idx_sign_requests_contract on public.gw_sign_requests(contract_id) where contract_id is not null;

comment on column public.gw_sign_requests.contract_id is
  'この署名依頼が対応する契約（gw_contracts）。null のときは doc_kind + 時期の近さで推測する（既存データ・後方互換用）';

commit;

notify pgrst, 'reload schema';

-- 確認:
--   select id, employee_id, doc_kind, status, contract_id from public.gw_sign_requests
--     where doc_kind = 'employment' order by created_at desc limit 20;
