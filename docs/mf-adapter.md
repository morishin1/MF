# MFアダプタ 設計書（Phase 3）

承認済み仕訳（`journals.status='approved'`）を マネーフォワード クラウド会計に送信するためのアダプタ層の設計。
MCP には依存せず、**MF Cloud API を直接 OAuth で叩く**実装にする（顧問先ごとにトークンを管理するため）。

## 1. 全体像

```
[/api/journals/approve] ──► sendToMf(journal)
                             │
                             ├ 1) 認証情報取得（accounting_credentials を decrypt）
                             ├ 2) 冪等性チェック（idempotency_key で MF 側に既存確認）
                             ├ 3) journals → MF 仕訳API ペイロード変換
                             ├ 4) MF API POST（リトライあり）
                             ├ 5) 結果保存（journals.status='sent', external_id, sent_at）
                             └ 6) audit_log に追記
```

## 2. OAuth トークン管理

- `accounting_credentials.encrypted_token`：access_token を **AES-GCM + KMS派生鍵**で暗号化して保管
- `refresh_token_encrypted`：refresh_token も同様
- 復号は API 内のみ。**クライアントには絶対に出さない**
- 有効期限切れ前に refresh する（`expires_at` を見て先回り）
- 鍵ローテーション時は再暗号化バッチで `encrypted_token` を更新

## 3. 冪等性

- `journals.idempotency_key`（`approve` API で `kp_<clientId>_<journalId>` を確定）
- 送信前に **MF の仕訳一覧API**を `idempotency_key` 相当の摘要/メタで検索 → 既存があれば `external_id` だけ更新して終了
- MF 側に冪等キー対応APIがあれば優先採用

## 4. ペイロード変換

`journals` の汎用スキーマ → MF 仕訳API のスキーマへ：

| 汎用 | MF |
|---|---|
| `txn_date` | `issue_date` |
| `description` | `description` |
| `partner_name` | `trade_partner_id`（事前マッピング/自動作成） |
| `lines[].account` | `account_id`（マスタ照合） |
| `lines[].sub_account` | `sub_account_id` |
| `lines[].amount` | `amount` |
| `lines[].tax` | `excise_id`（税区分マスタ照合） |
| `lines[].side` | `entry_side` |

- 勘定科目・税区分は **MF マスタの id にマッピング**するために、初回連携時にマスタを取り込み `data/master/*.json` 相当をSupabaseに保存
- 新規取引先は `trade_partners.write` 権限で自動作成

## 5. リトライ・エラーハンドリング

- 4xx（業務エラー）: リトライ不可。`journals.status='error'`、ai_note にエラー記録、staff に通知
- 5xx / ネットワーク：指数バックオフで最大3回
- 部分成功（複合仕訳の一部だけ失敗）はトランザクション扱いで全部巻き戻し

## 6. 送信ログ・監査

- `audit_log` に `action='mf.send'` で1行
- 別途 `mf_send_log`（追記専用）テーブルを設けて、リクエスト/レスポンスの要約と所要時間を残す（個人情報は最小化）

## 7. テナント分離

- 送信実行ユーザーが当該クライアントの staff/admin であることをサーバ側で再確認
- `accounting_credentials` の取得は `client_id` 一致 + staff/admin のみ

## 8. 将来：freee / 弥生

- 同じインターフェース `Adapter.send(journal)` を持たせ、`clients.accounting_software` で分岐
- マスタ・税区分のマッピングはアダプタ内に閉じる
