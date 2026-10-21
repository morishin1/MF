# ENGERのCL担当変更 → Sales営業担当の自動同期

## 操作
ENGERの提案詳細・一覧・一括編集でCL担当を変更すると、ENGERは `proposal.updated` を署名付きAPIでSalesへ送る（名簿の改名・削除も対象）。Salesは同じ提案IDを特定し、未引継ぎ・進行中なら営業担当を更新する。

## 安全条件
- Salesに既存の提案がまだ無い場合は503を返してENGERのoutboxから再送。提案を重複作成しない。
- 同じイベントIDは二重処理せず、`enger_cl_synced_at` によって古い通知で担当が戻らない。
- CLに実際の変更が無ければ、Salesで手動変更した担当を上書きしない。
- CS/クロージングへ正式引継ぎ済み、または成約・見送り等の終了済み案件は営業担当を上書きしない。
- 初回の同期時、Salesの既存担当がENGERのCLと異なる場合は初回更新とみなす。
- 未完了の旧担当タスクだけを移し、履歴（`kind=assign`）を追加。完了済み・別担当のタスクはそのまま。
- CLが社員名簿に一致しない場合は「未割当」にして管理者へ通知し、理由を連携確認に残す。
- 新担当へベルとSlackで通知。Slackに失敗したときは同期ログに警告を残す。
- APIは従来のHMAC署名でのみ受信。更新RPCはservice_roleだけに実行許可。

## 本番適用順序（重要）
1. **SalesのSupabase** に `db/143_sales_enger_cl_owner_sync.sql` を適用。ENGERのSupabaseではない。
2. SQL Editorで Success を確認してから、MF側PRとENGER側PRをマージ（同じ機能の両端）。
3. ENGERの提案を1件選び、CL担当をA→Bに変更。Salesの営業担当・未完了タスク・担当変更履歴・通知を確認。
4. 同じCLをもう一度保存しても、余分な通知が出ないことを確認する。
5. 既にCS/クロージングに渡した案件は対象外。担当を戻してはいけない。

## 障害時
- ENGER outbox（`enger.dx2_gw_sales_outbox`）にpending/failedが無いか、Salesの「dx.enger連携確認」を確認。
- `owner_handoff_protected` は正式引継ぎ後の上書き抑止、`owner_closed` は終了済み案件。
- SQLをまだ適用せずコードだけ公開しないこと。署名受信APIで起票も失敗する可能性があるため、SQLを先に適用する。
