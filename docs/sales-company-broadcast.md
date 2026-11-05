# Company list: sorting and broadcast card

Click a column heading to toggle ascending / descending. Company name and contact count, and owner and deadline, have separate controls within their combined columns. Sorting applies to the complete filtered result before 50-row pagination. Missing values stay at the end; company name and ID break ties. The sort direction selector mirrors the active header.

Select identified company rows and use 「配信に登録」 to save explicit broadcast membership. 「配信から解除」 returns companies to their original relationship classification. Membership appears in the 配信 and 全企業 cards, and is excluded from the other cards. Unmatched activity rows cannot be registered. This does not send mail, imply consent, lift contact stops, or rewrite relationships, priority, or existing history. No existing companies are automatically registered based on a legacy rank or proposal count.

Apply `db/sales_company_broadcast.sql` before deploying. Membership is held in the existing tenant-scoped, service-role-only directory overrides table with actor/time. Existing RLS and grants remain unchanged. The existing authenticated bulk API accepts `action: broadcast` and a boolean `blastTarget`; writes contain only the membership fields to avoid overwriting concurrent relationship edits. The lifecycle read model supports `refresh=1` after a mutation to bypass its short cache.

## 2026-11-05: single entry and editable workbench

The navigation and both legacy list URLs now open `company-segments.html`. Registration/import utilities remain at `company-tools.html`.

`segment` bulk updates store an explicit `lifecycle_segment` (current/past/future), or broadcast membership. `auto` clears both. Manual workflow position never claims a verified transaction and does not change suppression/evidence/priority. The same controls are available in the company modal.

The company-workbench API validates tenant scope and editable fields. A service-only SQL transaction updates the ENGER master and its existing exact Sales ID link, writes an immutable action ledger, and updates the next plan. It never creates a name-based link or sends email. The request UUID deduplicates retries; conflicting payloads are rejected. Actual in-app email uses the existing SMTP ledger, while externally performed activities are explicitly labeled as user records. Phone/form launch alone never records success.

Apply `db/sales_company_workbench.sql` before the new frontend. Verified using `test/sales-company-workbench.sql` with synthetic rows and ROLLBACK, including execution as service_role. API validation and navigation regression are in `test/sales-company-workbench.mjs`.
