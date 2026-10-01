-- =============================================================================
-- 112: 契約と締結済み書面の明示的な関連（GW「契約締結×キャリア設定」完了状態 §18・follow-up）
--
-- ■ 何をするものか
--   これまで「この署名依頼がどの契約に対応するか」は、doc_kind（雇用契約）と
--   時期の近さから推測していた（lib/career.js CONTRACT_DOC_KINDS）。
--   「契約締結済み」を正しく判定するには、明示的な関連が要る。
--
--   1本のチェーンとして持たせる。
--     gw_contracts（現在契約）
--       ↓ contract_id
--     gw_doc_orders（作成依頼。契約からの作成依頼のときだけ入る）
--       ↓ contract_id（作成依頼から発行するとき、そのままコピーする）
--     gw_sign_requests（本人へ送った署名依頼・締結済みPDF）
--
--   api/sign/orders.js の create() が gw_doc_orders.contract_id を受け取って検証・保存し、
--   issue()（approve/send の共通部分）がそれを gw_sign_requests.contract_id へそのまま
--   コピーする。api/sign/index.js の直接送信ルートも、1名あてのときだけ受け取る。
--   どちらもテナント・本人の一致をAPI側で検証してから保存する（他人の契約を渡せない）。
--
-- ■ 新しい大きな表は作らない
--   既存の2つの表に、gw_contracts への参照列を1つずつ足すだけ。
--   056 の order_id / sign_request_id と同じ考え方。
--
-- ■ 後方互換
--   既存の作成依頼・署名依頼は contract_id が null のまま（無理に遡って埋めない）。
--   null のときは、これまでどおり doc_kind + 時期の近さで推測する
--   （lib/career.js の contractStatus() が両方を見る）。
--
--   （このファイルは以前 097→099 として配っていたが、099 も db/099_access_hr_office.sql と衝突したため
--     112 へ採番し直した。どちらも本番未適用のまま差し替え）
--
-- 実行方法: Supabase の SQL Editor にこのファイル全体を貼って Run（べき等。2回流してもよい）
-- 前提: 029_contracts.sql, 046_esign.sql, 056_doc_orders.sql
-- =============================================================================

begin;

alter table public.gw_doc_orders
  add column if not exists contract_id uuid references public.gw_contracts(id) on delete set null;

create index if not exists idx_doc_orders_contract on public.gw_doc_orders(contract_id) where contract_id is not null;

comment on column public.gw_doc_orders.contract_id is
  '契約からの作成依頼のときだけ入る、対応する契約（gw_contracts）。'
  '発行するとき gw_sign_requests.contract_id へそのままコピーされる';

alter table public.gw_sign_requests
  add column if not exists contract_id uuid references public.gw_contracts(id) on delete set null;

create index if not exists idx_sign_requests_contract on public.gw_sign_requests(contract_id) where contract_id is not null;

comment on column public.gw_sign_requests.contract_id is
  'この署名依頼が対応する契約（gw_contracts）。null のときは doc_kind + 時期の近さで推測する（既存データ・後方互換用）';

commit;

notify pgrst, 'reload schema';

-- 確認:
--   select o.id, o.employee_id, o.contract_id as order_contract, s.contract_id as sign_contract
--     from public.gw_doc_orders o
--     left join public.gw_sign_requests s on s.id = o.sign_request_id
--    where o.doc_kind = 'employment' order by o.created_at desc limit 20;
