# HR 育成・評価 実装

要件: #381（v1.1）および2026-11-17の実装指示。

- メニュー「育成・評価」は採用HR権限者向け。CEO REVIEWの旧URLは新画面へ移動。最終採否は応募者詳細の既存権限・既存APIを維持する。通知は対象応募者へ直接移動する。
- 書類数・書類配列とは独立したschoolアイコンを末尾に表示。ON/OFF/未確認。クリックだけで保存し、行の詳細を開かない。招待・受講登録・メール送信は行わない。
- 実学習開始はLMSを優先。手動OFFで隠せない。取得失敗・メール未確認・同一テナント内でメールが重複・確定したLMS IDと現在メールの不一致は未確認とする。手動ONの記録は通信失敗でも残る。
- LMS署名付きPOST `/api/hr/lms/learning-status`。入力はtenant_idとapplicant_ids（最大25）。LMSが共有DB上の対象テナントの応募者メールを読む。呼出側から任意のメールを渡せない。
- LMS側 `MUGENDOJO_HR_TENANT_ID` を許可テナントに設定。既存署名・時刻検証・リプレイ防止を再利用。通常講座と体験版は別のコースサマリー。回答・会話・評価本文を取得・複製しない。1000件上限をページングで回避し、受講生向け公開・ゴミ箱判定を適用する。
- HR DB `gw_hr_learning` は手動参加確認・本人紐付け・個別目標・7/14日目の担当者評価のみ。LMS進捗は保存しない。契約トライアルとは別の学習目標期間。開始から14日間、終了日は開始+13日。評価済み開始日は固定。
- 目標達成率は目標ごとの `min(実績/目標,1)` の平均。学習率や採用判断と連動させない。
- `gw_hr_save_learning` はservice_roleのみ実行可、SECURITY INVOKER。CAS、応募者ロック、状態・タイムライン・監査ログを同一トランザクションで保存。authenticatedは既存採用HRのRLS経由の読取のみ、anon不可。
- 一覧は25人単位で最新サマリーを取得し、確認途中の人数は確認中と明示。Officeと同じ1200px幅と共通CSS。詳細は最大960px・内容に応じた高さ。スマホでは一覧をカード化。

## 検証

`node --experimental-test-module-mocks test/hrlearning.mjs`

`TEST_NAME_PREFIX=hr node test/run.mjs node`

`TEST_NAME_PREFIX=hr node test/run.mjs ui`（静的サーバとChromiumが必要）

LMS: `npm run check:hr-learning`（buildの先頭でも実行）。署名入口/テナント、本人照合、1000件超、公開設定、通常/体験分離、取得失敗、本文非取得を検証。

DB移行は空のPostgreSQL互換環境で実行検証。CAS競合、監査保存エラー時の全体ロールバック、anon/authenticatedの書込不可、既存採用ステータス不変を確認。

## 適用順

1. LMS APIと許可テナント設定を反映、LMS build成功を確認。
2. `supabase/migrations/20261116210306_hr_learning_evaluation.sql` を適用。
3. MF PRのAPI・ブラウザ検証後にmainへ統合し、production READYとgwドメイン割当を確認。

既存の採用判断・内定通知・Office契約書管理・LMS学習記録は変更しない。
