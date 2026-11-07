-- 168: provenance of inbound company requests; never infer LINE messages from account connections.
BEGIN;
ALTER TABLE enger.dx2_sales_company_supply_pipeline
 ADD COLUMN IF NOT EXISTS source_channel text NOT NULL DEFAULT 'unknown';
ALTER TABLE enger.dx2_sales_company_supply_pipeline
 ADD COLUMN IF NOT EXISTS source_received_at timestamptz;
DO $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM pg_constraint WHERE conrelid='enger.dx2_sales_company_supply_pipeline'::regclass
   AND conname='dx2_supply_source_channel_check'
 ) THEN
  ALTER TABLE enger.dx2_sales_company_supply_pipeline
   ADD CONSTRAINT dx2_supply_source_channel_check
    CHECK(source_channel IN ('email','line','manual','unknown'));
 END IF;
END $$;
COMMENT ON COLUMN enger.dx2_sales_company_supply_pipeline.source_channel IS
 'Verified inbound channel. Set only by trusted e-mail/LINE import handlers or explicit Sales action; LINE connected flag alone is not proof.';
COMMIT;