# Sales企業情報：gBizINFO法人番号登録と基本情報の照合・更新

## 目的

Sales企業詳細のgBizINFOボタンから、選択中の企業名を自動入力した検索画面に進む。法人番号をENGER企業マスタへ登録し、公式APIで照合できた法人基本情報だけを安全に更新する。

## 操作手順

1. Sales企業一覧で企業を選択 → 企業情報 → gBizINFOで法人情報を確認。
2. 選択中の企業名が入力済み。API接続済みなら候補を表示。API未接続なら企業名入りのgBizINFO掲載ページ限定Google検索を別タブで開く。2026年版gBizINFOの公式な社名検索ディープリンクは未確認のため、架空URLは使わない。
3. 社名だけで判断せず法人番号・所在地を照合。13桁法人番号を登録。
4. 公式APIに接続できた場合は法人名・本店所在地などの取得情報を差分表示。デフォルトで既存値を保持し空欄を補完。既存項目の上書きは明示チェック。
5. 登録名と公式名が違う場合は別法人でないことを明示確認。
6. 保存するとENGER企業マスタと一意に紐づくSales CRMを同じトランザクションで更新、操作履歴を記録。
7. API未接続なら手動確認後の法人番号のみ保存。基本情報の自動取得・補完はAPIトークン設定後に利用。

## 公式API

- Vercelサーバー環境変数：GBIZINFO_API_TOKEN。ブラウザには公開しない。
- 公式申請・手順：https://content.info.gbiz.go.jp/api/index.html
- 仕様：https://api.info.gbiz.go.jp/hojin/swagger-ui/index.html
- 候補エンドポイント：GET https://api.info.gbiz.go.jp/hojin/v2/hojin?name=...、GET /hojin/v2/hojin/{法人番号}（実トークンによる結合テスト必須）。
- 公式プロフィールURL：https://info.gbiz.go.jp/hojin/ichiran?hojinBango=法人番号
- 公式基本3情報は法人名・本店所在地・法人番号。ホームページや業種は取得できた場合のみ採用。

## DB・安全対策

- ENGER UUIDと13桁法人番号は別物。既存enger.companies.corporate_number列に保存。
- db/163_sales_company_official_save.sql はサービスロール専用の新規RPC。テナント範囲・他社番号の重複・元値変更・Salesリンク多重をチェック。社名だけで名寄せ統合しない。
- 取得元が手動の場合、公式基本情報のパッチは常に空。ユーザー入力した名前や住所を公式データと偽って書かない。
- 監査ログはgw_sales_company_activity（operation=profile）。
- 2026年11月7日現在、RPCは共有Supabaseに適用済み。service_roleのみEXECUTE権限を確認済み。VercelにはGBIZINFO_API_TOKENが未設定であり、API連携の本稼働は未完了。

## 受け入れ

- 3LINKS株式会社を選択すると検索語に3LINKS株式会社が入る。
- 法人番号13桁以外、他社番号重複、元データ競合、未承認上書きは拒否。
- API未接続時は番号だけ登録して制約を明示。
- API接続時、項目別の差分を確認し、空欄・承認済み項目だけ更新。
- 保存後に企業情報タブを更新し、同じ企業IDで履歴を残す。
- 本番マージ前に認証済みE2Eと公式APIの実トークン確認を実施。

## ブランチ

Sales PR #281 レビュー用。明示的なマージ承認なしにmainへ反映しない。
