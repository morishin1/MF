# Sales dashboard completion candidate (2026-10-30)

Base: MF main 918b4e2376d1fac68ec327ec670d5dc707b8d624. This is separate from proposal-list/company receiver PR234 and ENGER573. PR224/226 are already merged. Do not merge old PR166 wholesale.

## Changes
- Keep PR226's JST event/cohort definitions and previous same-length comparison.
- Add trailing seven days; preserve yesterday/custom date range.
- Show proposal-to-meeting and recorded loss-reason bars.
- Show all sent-to companies with numerator/denominator, not only blast candidates. Current recorded loss reasons are broken down for each sent-period company cohort; these are not calendar-period losses. IDs are not automatically merged: mixed company/source/name identity can split the same real company.
- Separate proposal/CS/closing registered-role comparisons by employee ID; never combine same-name employees. Sending activity actor takes priority only when activity timestamp matches sent_at and the actor is non-null/unambiguous; resends never replace an unknown original actor.
- Sending timestamp and matching-to-sending elapsed time are visible. Elapsed hours include waits/holidays and are NOT actual work time. Actual work time remains unmeasured.
- CS/closing are current registered role holders, NOT proven historical performers. Unknown attribution remains explicit. Small denominators are marked as reference. This is not an employee evaluation.
- Short queues (three visible rows each), two-column layout, collapsed history/details.
- Old async period responses cannot overwrite a later selection or invalid range.
- API remains GET-only, authenticated, canSell-gated, userClient/RLS, every query tenant-scoped. No service client. Paging uses 1,000 rows, 20,000 hard ceiling, 503 rather than silent truncation; aggregate chunk limits enforced.
- No DB, permissions, environment, source-sync gate, business record, or notification writes.

## Verification
- Initial UI-only candidate: server suite 280/280.
- Roles candidate: server suite 281/281 (Node 24.22.1; Node22 full rerun in progress).
- Latest API guard additions: permission/tenant/SELECT projection/1001-row paging/20001-row rejection tests passed; selectcheck and schemadrift passed.
- VM: escaped company name, old response ordering, invalidation, graph markup passed.
- Browser test test/ui/salesdashboardreportui.mjs added with synthetic APIs and actual page/report JS, PC/mobile widths. NOT executed locally: installed Chromium socket creation denied (Operation not permitted). Do not call visual verification complete.
- No publication, PR, merge, production verification performed by this candidate.

## Release gate
Owner's exact public-source scope approval is pending with parent. CI/browser verification and current main rebase/changed-file review remain required. Do not claim production completion from local tests.
