# HR採用メール Gmail定期取り込み（Phase 2）

## 目的・運用

Xserverの採用窓口 `saiyou@8grp.co.jp` 宛てのメールは、現在Gmailでも受信できることを確認済み。Google Apps Scriptが**日本時間9時・13時・17時ごろ**にGmailを検索して、署名付きで `https://gw.8grp.co.jp/api/hr/inbox-ingest` に渡す。HRには「新着」の**受信候補だけ**登録する。正式な応募者登録・採用判断・返信は**自動で行わない**。外部AI APIも使用しない。

**GmailアクセスはWebサーバではなく、ユーザーのGoogle Apps Script側にだけ付与する。** VercelにGmailのパスワードやrefresh tokenは置かない。Apps Scriptが起動していない／権限未承認の場合、連携しない。ChatGPT/DotsのGmail接続だけではこのジョブは起動しない。

## 前提

- HR新着受付 PR #177 が本番へ反映済み、`db/147_hr_inbound_mail.sql` が適用済みで、`db/check_147_hr_inbound_mail.sql` の table_present / rls_enabled がともに true。
- スクリプトを実行するGoogleアカウントで、`to:saiyou@8grp.co.jp` のメールを閲覧できる。Gmailで受信できないアカウントでは動作しない。
- VercelのHRアプリにシークレット環境変数を書き込める管理者と、Apps Scriptを設置するGoogle管理者の協力が必要。いずれも**秘密鍵やメール本文をChatGPT、GitHub、Slackに貼り付けない**。
- 送信元・返信先が媒体の自動配信アドレスであることがあるため、**応募者の本人メールアドレスと自動で扱わない**。本文は最大5000文字で打ち切り。添付ファイルはコピーしない。

## 設置作業（人による初回設定）

1. VercelのMFプロジェクトの**Production**環境変数を設定する。初期状態ではデプロイしてもOFF：
   - `HR_INBOX_SYNC_ENABLED=0`（初回の接続確認後、管理者が `1` に変える）
   - `HR_INBOX_TENANT_ID=<対象のEIGHT tenant UUID>`（既存 `gw_hr_applicants.tenant_id` の対象法人をDB管理者が確認して設定。推測しない）
   - `HR_INBOX_SYNC_SECRET=<32バイト以上の安全なランダム秘密鍵>`。例：ローカル端末の `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` で生成し、どこにも公開しない。
2. GitHub `scripts/google-apps-script/hr-inbox-sync.gs` をGoogle Apps Scriptの新規プロジェクト（`script.google.com`）に貼り付ける。必要に応じて `appsscript.json`（同ディレクトリ）を反映。タイムゾーンは **Asia/Tokyo**。このApps ScriptはGmailを読み、WebへHTTPSで送り、3つの時間トリガーを作成できる権限が必要。
3. Apps Scriptの**プロジェクト設定 → スクリプト プロパティ**に以下を入力する。Vercelと同一のsecretを使うがGitHubへ含めない。
   - `HR_INBOX_INGEST_URL=https://gw.8grp.co.jp/api/hr/inbox-ingest`
   - `HR_INBOX_SYNC_SECRET=<Vercelと同じ値>`
   - `HR_INBOX_DRY_RUN=1`（既定、安全のため初回は必ず1）
   - `HR_INBOX_LOOKBACK_DAYS=3`（既定3、最大7。初回は1でも可）
4. Apps Scriptのエディタで `syncRecruitmentInbox` を**1回手動実行**してGoogleのアクセス許可を確認。実行ログには「候補n件、送信0件」だけを記録する。ログに件名・アドレス・本文・secretを出してはならない。
5. **合成のテストメール**を `saiyou@8grp.co.jp` へ送り、Gmailに到着したことを確認。Vercel側を `HR_INBOX_SYNC_ENABLED=1` に変えて再デプロイし、Apps Script側の `HR_INBOX_DRY_RUN=0` に変更。その後 `syncRecruitmentInbox` を手動実行。HRの `/hr/inbox.html` で新着候補として表示され、応募者の新規登録は行われないことを確認。
6. **同じメールをもう1回実行**し、重複が増えず、既存の手動レビュー内容が書き換わらないことを確認。
7. `installRecruitmentMailTriggers` を1回手動実行して、3つの時間トリガーを作成する。**9時・13時・17時の前後約15分の範囲**で動作する仕様であり、分単位の厳密な固定時刻は保証できない。Google Apps Scriptの「トリガー」「実行数/エラー通知」で成功・失敗を監視。
8. 停止時は、先にVercel `HR_INBOX_SYNC_ENABLED=0` として再デプロイし、Apps Scriptの `removeRecruitmentMailTriggers` を実行。

## 安全機構とデータ境界

- HTTPSのPOST本文は `text/plain` の未加工JSON、`X-Eight-Timestamp` (Unix秒) と `X-Eight-Signature` (HMAC-SHA256のhex) を使う。署名対象は **`timestamp + '.' + rawBody`**。サーバは署名を定時間比較し、許容時計差は±5分。
- `HR_INBOX_SYNC_SECRET` が未設定・31文字以下、固定tenantが不正、`HR_INBOX_SYNC_ENABLED` が `1` 以外ならHTTP 503で必ず拒否。
- 1リクエスト最大10通、本文全体120KB、個別のメール受信日時は過去14日〜未来10分。1実行30通まで、直近3日分（最大7日）を走査。
- APIにある `provider_message_id` の一意制約によって再実行/時間トリガー重複/部分失敗時の再送でも二重登録しない。**既存行をUPDATEしない**ので「対象外」「紐づけ済み」等を勝手に新着へ戻さない。
- 個々のメールの差出人・件名・本文をログ/HTTP応答に記録しない。HTTPは集計（inserted/duplicates/failed）とエラーコードのみ返す。障害時は次回実行で再取り込み。
- GmailのTo/Cc/Delivered-Toと検索条件で窓口宛てを確認。送信メール・迷惑メール・ゴミ箱は除外。
- 全件自動応募者化・採否AI判定・メール返信/自動採用連絡・添付移送は行わない。

## 検証・導入判定

- `node --experimental-test-module-mocks test/hr-inbox-sync.mjs`
- `node test/run.mjs`：既存API等への影響確認
- HRの `/hr/inbox.html` で新着候補が1行だけ現れること（同じGmailメッセージの再取込で2行にならない）
- 受信・署名エラー時にメールや秘密鍵がログへ漏れないこと
- HR利用権限のないユーザーが受信メールを閲覧できないこと
- **上記実Googleアカウントでの動作は、認証権限の所有者が初回設定を行うまで未確認**。このPR自体はApps Scriptを外部へインストール・稼働させない。

## 追加の留意点

- GmailAppはGoogleメールを読み取る権限を要求する。可能なら採用窓口専用の受信アカウント/委任アカウントを使い、閲覧できる個人情報の範囲を最小化する。
- Gmail Apps Script時間トリガーは時刻に誤差がある。9/13/17時ぴったりで業務上のSLAが必要なら、別の確実なスケジューラと認証済みGmail受信処理を再検討する。
- 無料枠・クォータ・Apps Scriptの実行エラー通知は運用者が監視し、未着/取りこぼし時は手動の新着受付に戻す。
