# Company list: sorting and broadcast card

Click a column heading to toggle ascending / descending. Company name and contact count, and owner and deadline, have separate controls within their combined columns. Sorting applies to the complete filtered result before 50-row pagination. Missing values stay at the end; company name and ID break ties. The sort direction selector mirrors the active header.

Select identified company rows and use 「配信に登録」 to save explicit broadcast membership. 「配信から解除」 returns companies to their original relationship classification. Membership appears in the 配信 and 全企業 cards, and is excluded from the other cards. Unmatched activity rows cannot be registered. This does not send mail, imply consent, lift contact stops, or rewrite relationships, priority, or existing history. No existing companies are automatically registered based on a legacy rank or proposal count.

Apply `db/sales_company_broadcast.sql` before deploying. Membership is held in the existing tenant-scoped, service-role-only directory overrides table with actor/time. Existing RLS and grants remain unchanged. The existing authenticated bulk API accepts `action: broadcast` and a boolean `blastTarget`; writes contain only the membership fields to avoid overwriting concurrent relationship edits. The lifecycle read model supports `refresh=1` after a mutation to bypass its short cache.
