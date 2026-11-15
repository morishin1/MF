# Sales / ENGER 共通利用権限

管理者は「メンバー管理」→対象者の「詳細」→「使える業務」の Sales をONにします。
本人は https://enger.jp/business/login に、GWと同じID（登録メールアドレス）・パスワードでログインします。
通常メンバーの担当企業はGW Salesの企業担当者とENGER企業との連携から判定します。担当企業が未設定なら設定待ちを表示し、企業情報を公開しません。
既存の外部エージェントは契約・秘密保持・明示的な担当割当の確認を継続します。
SalesをOFFにすると既存外部エージェントの権限・割当を閉じてから共通利用権限を外します。履歴・Authアカウントは削除しません。停止の途中でエラーがあれば失敗を表示します。
経営者は既存仕様どおりSalesを常時利用可能です。通常メンバーへのSales付与で管理者権限は追加しません。

配信順序: MFの停止API → ENGERのDB関数拡張 → ENGERの共通権限リゾルバ。
ENGER側の対応: `src/lib/gw-sales-access.mjs` / `src/lib/partner-sales.mjs` / `db/eng_sales_common_entitlement_20261116.sql`。
