# Sales company mail

Company modal email opens an inline composer. Explicit Send reserves an idempotency key in `gw_sales_company_mail` before contacting SMTP. Sent means SMTP accepted; delivery, open and inbound replies are not tracked. Message bodies are visible to authenticated Sales users in the canonical tenant only.

Apply `db/sales_company_mail.sql` before deployment. The table has RLS and no grants to anon/authenticated. Server reads and writes always include the tenant; company scope and opt-outs are checked before sending. Only a registered company recipient is allowed. Viewing never creates Sales companies or sends mail.

Configure these **Sales-specific** production variables. Do not change the existing HR SMTP account:

- `SALES_MAIL_FROM`: display name + verified mailbox
- `SALES_MAIL_ENABLED=1`: enable explicit user sends after configuration
- `SALES_SMTP_HOST`: mail provider's SMTP hostname
- `SALES_SMTP_PORT=465`: implicit TLS
- `SALES_SMTP_USER`: mailbox login
- `SALES_SMTP_PASS`: mailbox password, stored as a Secret in Vercel

Reply-To uses the configured Sales mailbox. Credentials are never returned to the browser, logged, or committed. Missing configuration disables Send but keeps composing/templates available. A newly configured environment requires redeployment. Never borrow HR credentials to impersonate the Sales mailbox.

On timeout or failed audit update, the reserved message remains sending/unknown and the same request cannot call SMTP again. Inspect provider logs before any deliberate new send. The browser stores the in-flight request in session storage so reopening the modal reuses the same key; a separate new-mail action is available only for accepted/not-sent results. Clearing browser storage does not remove server reservations.

Verification: run `node --experimental-test-module-mocks test/sales-company-mail.mjs`; transport is mocked and no customer messages are sent. Phone/form/memo notes and bulk NEXT changes on the lifecycle page remain explicitly labelled temporary drafts; this change persists email history only.
