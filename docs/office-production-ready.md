# Office を本番でメンバーが使える状態にする（2026-10）

対象：Office（`/office/` と、Office の横タブから開く 人事・労務／経理・事務／社内管理 の画面）。
アプリは main にすべて入っています。残りは **本番 DB の確認（と、足りない SQL の適用）** と **本番での操作確認** だけです。

## 1. 本番 DB を確かめる（読むだけ・1回）

Supabase の SQL Editor に `db/check_office_ready.sql` を貼って Run。何も書き換えません。

| 区分 | 見るもの | ❌ のとき |
|---|---|---|
| A. 前提 | 社員名簿・現場契約・提出ファイルの表、099・100、保存先（billing-submissions） | 「やること」の列のとおり |
| B. Office の SQL | 105・106・107（勤務表）・115（人事・労務／経理・事務の分割）・117（仕入請求・支払・月次完了）・119（4ボタン） | 未適用のものだけ、下の順で流す。⚠（半分だけ）は同じファイルをもう一度流す |
| C. 使える人 | 業務ごとに使える人の数 | 月末月初が 0 人なら、メンバー管理で「責任者」か「経理」を付ける |

**適用の順番**（未適用のものだけ。どれも `begin … commit`・2回流しても同じ）：

```
099 → 100 → 105 → 106 → 107 → 115 → 117 → 119
```

- 105〜107：`docs/office-phase3-runbook.md` §1〜2（`db/check_office_phase3.sql` で前後を確認できる）
- 117：流したあと、ファイル末尾の「確認1・2」（4行・3行）
- 119：先に `db/check_app_grants_dryrun.sql`（**0 行**）→ `db/119_app_grants.sql` → `db/check_app_grants_after.sql`（**0 行**）。
  119 の前でも、入口は内部ロールから決まるので使える（メンバー一覧の4ボタンは、変更できない表示になるだけ）
- 流したあと、もう一度 `db/check_office_ready.sql` を Run して、A・B がすべて ✅ になっていること
- **再デプロイは要りません**（アプリは毎回、表があるかを見ます。表が無い間は、その部分だけ「SQL を流してください」と 503 で案内し、ほかの画面は止まりません）

## 2. 誰が何を使えるか（lib/gw.js と同じ）

| 業務 | 使える人 |
|---|---|
| 月末月初（`/office/` の月次業務・請求・支払・月次完了） | 経営者・責任者・経理 |
| 人事・労務（メンバー・入退社・勤怠・雇用契約・評価） | 経営者・人事・会計の管理者 |
| 経理・事務（経費精算・月次業務・月初の請求提出・社内文書） | 経営者・経理・会計の管理者 |

- 119 のあとは、Office の入口（メンバー一覧の「Office」ボタン）も要る（経営者は不要）。移行で、責任者・人事・経理には自動で付く
- 支払の記録は経営者・経理だけ（責任者には「支払の記録は、経営者・経理が行います」と出る）
- 担当でない画面を直接開くとホームへ戻り、API は 403（画面と API の一致は `test/accessparity.mjs`・`test/ui/officesplitui.mjs`）

## 3. 本番での操作確認（テストデータ1件）

実在の人・実在の勤務表は使いません。メール・請求書・振込は、どの手順でも外へ出ません。

1. **テストデータ**：`db/office_phase3_test_seed.sql`（【Office Phase3 TEST】の要員・契約・契約条件・2026-10 の月次進捗を1件ずつ。既存の行には触れない）
2. **勤務表**：`/office/?month=2026-10` → テスト 太郎 →「勤務表を追加」（`test/fixtures/office-timesheet/sample-2026-10.pdf`）→「AI で読み取る」→ 赤・黄の日を直す →「この内容で確定する」
   正常なら：一覧に確定した稼働時間（正解は 154:45。`expected.json`）が出て、現在工程が「請求作成待ち」
3. **売上請求**：行を開く →「請求書を作成済みにする」→「送付済みにする」
4. **仕入請求・支払**（BP の契約のとき）：受領日・小計・税 →「請求額を登録して照合する」→「照合OK・承認する」→ 支払予定日 →「支払予定を入れる」→「支払済にする」
5. **月次完了**：上の「月次完了にする」（ほかの実案件が残っていれば押せない＝正しい）
6. **履歴**：SQL Editor で
   ```sql
   select kind, count(*) from public.gw_office_events
    where billing_month = '2026-10' and created_at > now() - interval '1 day' group by kind order by kind;
   select action, count(*) from public.gw_activity_log
    where action like 'office.%' and ts > now() - interval '1 day' group by action order by action;
   ```
7. **権限**：人事だけ・経理だけ・責任者のテストアカウントで、2. の表どおりに見える・入れない画面はホームへ戻ること
8. **後始末**：`db/office_phase3_test_cleanup.sql`（削除前確認 → DELETE → 削除後確認）

AI 読取には Vercel の `ANTHROPIC_API_KEY`（Production）が要ります。`/api/health` の `"env": { "anthropic": true }` で確かめられます（値は出ません）。
