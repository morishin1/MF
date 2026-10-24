# 無限道場：承認された合成テスト1件だけの配信確認

レビュー用差分。未公開・未実行。通常の `/api/hr/leads` は変更しません。
LMS 側とこの MF 側の双方が必要です。MF を先に適用し、両方のコードを確認してから、
別途承認された値を設定してください。この作業では環境・DB・本番へ変更しません。

## 固定承認と無効状態

- `VERCEL_ENV=production` だけ。Preview は接続情報があっても停止。
- `MUGENDOJO_VERIFY_RUN_ID`: 1回だけに固定した小文字 UUID。応募者 ID にも使用。
- `MUGENDOJO_VERIFY_OWNER_USER_ID`: MF の Supabase Auth ユーザー UUID。
- `MUGENDOJO_VERIFY_RECIPIENT`: 明示承認された1メールアドレス（小文字、空白なし）。未選択なら未設定のまま。
- 既存の `HR_LEAD_TENANT_ID`、`MUGENDOJO_LEAD_SECRET`（32文字以上）を使用。
- 値が欠ける・不正なら `503 verification_disabled`。リクエストからの上書き不可。
- LMS のログイン UUID は別プロジェクトのため同一と推測しない。LMS 側で固定許可ユーザーを認証する。

`POST /api/hr/leads-verification` は従来と同じ HMAC と時刻検証を要求します。
本文は厳密に `{ verification: true, runId, ownerUserId, recipient }` の4項目だけです。
MF はさらに対象テナントの在籍社員と現在の `owner` 権限を DB で確認します。
LMS サーバーは認証済みの許可された操作者だけに、この固定本文を送る機能を提供します。

## 安全性と結果

- 通常 intake、outbox 再送、申込者更新、広域通知ヘルパーを呼ばない。
- 応募者は `[TEST]` と合成テストの説明・専用 attribution 付き、`lead_category=mugendojo`。
- 同じメールの既存応募者があれば拒否。競合時も update/upsert に切り替えない。
- `db/118` の既存メール一意索引、応募者 PK、通知 PK が必要。新規 SQL は不要。
- GW 通知は検証した owner 社員1名だけ。決定的 ID で insert-only。
- 同じ run の再呼出しは記録を読むだけ。未読への戻し・再通知・申込情報の更新なし。
- 成功は applicant と通知の ID が確認できたときだけ。
  `{ ok:true, verification:true, runId, applicantId, notificationIds, result:"created"|"replayed" }`。
- 通知作成前の中断や不明状態は `notification_unconfirmed` 等。自動修復・再通知せず人が確認。
  この経路単独で「メールが届いた」とは主張しない。受付メールは LMS 側の at-most-once 処理。
- DB 例外、秘密、本文、メールアドレスをログに出さない。返すエラーは固定分類だけ。

## ローカル検査

```
node test/hrleadverification.mjs
node test/hrleadverification-route.mjs
node --check lib/hr-lead-verification.js
node --check api/hr/leads-verification.js
```

最小ソーススナップショットでのモック検査です。実 DB の制約適用、Vercel の実起動、
実際のログイン、HR/GW の表示、受付メール配送は未検証。既存全体テストも未実行。
実行承認前に、この固定受信先が既存申込みと重ならないこと、実行後は1件の ID と
メールプロバイダー ID・受信箱を確認することが必要です。run ID を変える操作は新規1件を作るため、別の承認が必要です。
