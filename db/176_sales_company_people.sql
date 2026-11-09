-- 176: Sales 企業に紐づく担当者と接点（名刺交換・問い合わせ・紹介・イベント）。
-- 実行順: 159_sales_enger_directory_overrides.sql → 本SQL → API/UI デプロイ。
-- 既存の current/past/future 分類や ENGER 企業マスターは変更しない。
CREATE TABLE IF NOT EXISTS public.gw_sales_company_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES enger.companies(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  department text CHECK (department IS NULL OR length(department) <= 120),
  position text CHECK (position IS NULL OR length(position) <= 120),
  email text CHECK (email IS NULL OR length(email) <= 254),
  phone text CHECK (phone IS NULL OR length(phone) <= 80),
  source text NOT NULL CHECK (source IN ('business_card','inquiry','referral','event','meeting','other')),
  met_on date,
  note text CHECK (note IS NULL OR length(note) <= 2000),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gw_sales_company_people_tenant_company
  ON public.gw_sales_company_people(tenant_id,company_id,created_at DESC);
CREATE INDEX IF NOT EXISTS gw_sales_company_people_tenant_source
  ON public.gw_sales_company_people(tenant_id,source,company_id);
ALTER TABLE public.gw_sales_company_people ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gw_sales_company_people FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.gw_sales_company_people TO service_role;
COMMENT ON TABLE public.gw_sales_company_people IS
  'Sales担当者の明示的な接点記録。メールや旧資料から名刺交換を推定しない。閲覧/編集は tenant/企業IDを検証したSales APIのみ。';
