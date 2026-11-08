# Sales商談：3段階準備 → 1クリック商談 → 5ステップ同期

## 前提
- Sales企業詳細の3ステップの既存デザインを変更しない。
- ① AIおすすめを初期表示（PR #294）→② 営業は社内ログインのまま商談を開く（PR #295）→③ 同一商談セッションの段階を双方で同期（本PR）。

## 商談セッション
- 公開承認した案件・人材を選択して、`POST /api/sales/meeting-session` で1〜10件の選択IDをサーバが公開状態と照合。
- `gw_sales_live_meeting_sessions` に企業ID、テナント、選択ID、段階0〜4、バージョンを保存。会社ごとに同時進行のセッションは1つ。
- 営業側：`/sales/company-meeting.html?companyId=...&selection=...&sessionId=...`（社内認証が必要）。
- 顧客側：ENGERの `/business/login?next=/business/meeting?companyId=...&session=...` から本人がログイン。
- 両画面はそれぞれの認証済みAPIを約3秒間隔で参照。ステップ進行は営業側のみがAPI PATCHで実行。
- 競合はversionによる楽観ロック。ステージ変更の履歴は `gw_sales_live_meeting_stage_events` に残す。

## 商談5ステップ
1. 会社紹介（エイトの支援内容）
2. 課題確認（ニーズ、時期、予算、決裁者の確認）
3. マッチング提案（公開承認済み候補）
4. 条件確認（費用・開始・契約形態等）
5. クロージング（面談/条件調整/契約準備等、成約と混同しない）

## 安全性
- 企業本人は `auth.users` と `enger.dx2_company_portal_members` の会社・テナント一致が必須。
- 企業側はステップの読取のみ。Salesの社員メモ・仕入単価・所属会社・個人連絡先は表示しない。
- 企業が見られる候補はサーバのセッションに固定した選択IDと公開中shortlistの共通部分のみ。
- セッションDBはRLS有効、`anon`/`authenticated`直接アクセス不可。`service_role`だけ操作可能。
- パスワード・認証トークン・APIキーはURLに入れない。
- 同じ会社の別セッションや別会社のステージを勝手に進められない。

## 本番前
- Supabaseで `db/165_sales_live_meeting_sessions.sql` を適用
- Sales Previewのログイン、候補公開、スタッフ用ページ、5ステップPATCH/GET、ENGER法人ログイン、別企業アクセス拒否をE2E確認
- 各PRが親ブランチの上に重なっているため、順番に取り込み、重複実装をマージしない
- 本番へはまだマージしない