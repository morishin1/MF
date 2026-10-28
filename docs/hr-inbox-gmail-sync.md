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
8. **設置の確認**：`checkRecruitmentMailTriggers` を手動実行する（読み取りだけ。Gmailは読まず、何も送らない）。ログに「トリガー3本（期待3本）／設置日時と9・13・17時／直近の自動実行の日時と成否」が出る。Apps Script は時間トリガーの「時刻」をAPIで返さないため、時刻は設置時の記録を出している。Apps Script の「トリガー」画面でも3本あることを目で確認する。
9. **自動実行の確認**：翌日以降にもう一度 `checkRecruitmentMailTriggers` を実行し、「直近の自動実行」が入っていること（手動実行と区別して記録している）を確認する。実行記録はスクリプト プロパティ `HR_INBOX_RUN_LOG` に直近20回分（時刻・自動/手動・件数・成否だけ。件名・アドレス・本文は残さない）。
10. 停止時は、先にVercel `HR_INBOX_SYNC_ENABLED=0` として再デプロイし、Apps Scriptの `removeRecruitmentMailTriggers` を実行。

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
- `node test/hr-inbox-gas-run.mjs`（Apps Script を偽の Google 部品で実際に動かす：DRY RUN・署名・実行記録・トリガー確認）
- `node test/run.mjs`：既存API等への影響確認
- HRの `/hr/inbox.html` で新着候補が1行だけ現れること（同じGmailメッセージの再取込で2行にならない）
- 受信・署名エラー時にメールや秘密鍵がログへ漏れないこと
- HR利用権限のないユーザーが受信メールを閲覧できないこと
- **上記実Googleアカウントでの動作は、認証権限の所有者が初回設定を行うまで未確認**。このPR自体はApps Scriptを外部へインストール・稼働させない。

## 追加の留意点

- GmailAppはGoogleメールを読み取る権限を要求する。可能なら採用窓口専用の受信アカウント/委任アカウントを使い、閲覧できる個人情報の範囲を最小化する。
- Gmail Apps Script時間トリガーは時刻に誤差がある。9/13/17時ぴったりで業務上のSLAが必要なら、別の確実なスケジューラと認証済みGmail受信処理を再検討する。
- 無料枠・クォータ・Apps Scriptの実行エラー通知は運用者が監視し、未着/取りこぼし時は手動の新着受付に戻す。

## 2026-10-28：「最新メールを取り込む」（即時実行）追加設定

通常の9・13・17時の時間トリガーは維持。HR採用メール受付画面の「最新メールを取り込む」は、ログイン済み採用担当がクリックすると、Vercelサーバが署名付きでApps Script Webアプリを起動し、既存のGmail取込関数を実行する。メールは「受信候補」に保存し、応募者の自動登録・返信・ステータス変更はしない。

設定前はボタンを無効化する。「一覧を更新」はDBの再読込のみであり、Gmail取得ではない。設定完了後は新規件数・重複件数を表示し、結果不明時は再読込を案内する。

### 追加の初期設定（管理者のみ）
1. Apps Scriptの hr-inbox-sync.gs を今回の版に更新。既存のGmail承認や9/13/17時トリガーは維持する。
2. Apps Script「スクリプト プロパティ」に新しい別鍵 HR_INBOX_MANUAL_SECRET を32文字以上で作る（既存の HR_INBOX_SYNC_SECRET は変更しない）。値をGitHubやSlackには公開しない。
3. Apps Script「デプロイ → 新しいデプロイ → ウェブアプリ」。実行ユーザーは採用Gmailを読めるスクリプト所有者。アクセスを「全員」とする場合でも、doPost はタイムスタンプ・nonce・HMAC署名を検証し、無署名は処理しない。専用Googleアカウントで運用し、ウェブアプリ公開禁止の組織ではこの方式を使わず、別の認証付きジョブ連携に切り替える。
4. Vercel Productionに HR_INBOX_GAS_WEBAPP_URL=https://script.google.com/macros/s/（デプロイID）/exec と同じ別鍵 HR_INBOX_MANUAL_SECRET を設定し、再デプロイする。ブラウザには秘密鍵を返さない。
5. 既存の HR_INBOX_SYNC_ENABLED=1、HR_INBOX_TENANT_ID が正しいことを確認。Apps Script HR_INBOX_DRY_RUN=1 の状態でまずボタンを押し、テストモード表示を確認。その後0に切り替え、テストメールで新着件数・再取込時の重複防止を確認する。
6. Nodeで test/hr-inbox-sync-now.mjs、test/hr-inbox-gas-run.mjs、test/hr-inbox-sync.mjs、HR全体テストを実行。GAS再デプロイ時はURLの整合性を確認する。

### セキュリティと失敗時
- 採用HR権限と法人テナントを確認してから起動。Gmail OAuthトークンや秘密鍵はブラウザへ返さない。
- Vercel→GASは timestamp.nonce.hr-inbox-sync-now のHMAC-SHA256。時刻差±5分、nonceを360秒キャッシュ、ScriptLockで同時実行を抑止。
- GAS→Vercelのメール取込は既存の署名つきingest API。メール本文・差出人はログに残さず、メッセージIDで重複を防ぐ。
- 取込結果の通信が切れても保存済みの可能性があるため「結果不明」と表示し、一覧再読込を案内。
- 本番環境の初期設定・デプロイ・実メール取込の検証まで完了したとは扱わない。
