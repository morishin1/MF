# 週報入力とアクセス制御の調査（2026-11-13）

対象: morishin1/MF、基点 main `c61d6e47`、独立 branch `fix/weekly-review-entry-20261113`。
作業前に上位ディレクトリとリポジトリの AGENTS.md / .agents/skills を確認。該当指示ファイルは存在しなかった。
HR #335/#341、P 承認フロー、定期集計、本番設定は変更していない。

## コードで確認・修正した事実

- 既存 `renderWeekly` は最終勤務日か記入済みの場合だけフォームを表示。最終勤務日以外に新規入力できなかった。
- 既存 `saveWeekly` は API の保存結果を捨て、古い `data.weekly` を再描画していた。保存内容が画面から消えたり古い内容に戻ったりする。
- 週報専用の対象日（含まれる月〜日の週を表示）と本人読取 API を追加。日報の対象日と独立し、当週・過去週を入力保存できる。将来週、不正日付、月曜でない保存キーは拒否。
- 保存結果を反映し、未保存・未保存変更・保存済み（入力問数）を区別。未保存での週切替は確認、通信中は対象週とフォームを固定、失敗時は入力を保持。
- 週報には社員の「提出」フラグがない。`submitted_at` は管理者の評価公開。新たな提出日時を捏造しない。既存 `weeklyFilled` の「1問以上」の判定は変えず、0/4〜4/4を表示する。4問必須という新しい違反ルールは追加しない。
- 評価公開前の eval_*、内部 ai_* は本人用の日報/週報読取と週報保存レスポンスから除外。公開済みの担当者評価は維持。
- 勤務曜日の欠落、取得エラー、不正値、空配列から金曜を推定しない。既知の勤務曜日だけ最終勤務日を案内・日報ゲートへ利用。週報読取エラーは「未記入」ではなく503。
- これは現在の勤務曜日設定に基づく最終勤務日であり、休暇・祝日・過去の勤務曜日変更履歴まで確定する機能ではない。UIにも「設定上」と明記。
- `requireUser` → `gwContext` の本人・在籍/所属・名簿確認を維持。保存する user_id は検証済み user.id、名前は ctx.employee 由来。bodyの他人ID、評価点、submitted_atは採用しない。

## DBで確認した事実（正式 Supabase 接続によるメタデータ読取のみ）

project `htglvascsuqkixpmclwr` / `public.tc_weekly_review`:

- RLS は有効。
- `tc_weekly_review all`: roles `{anon,authenticated}`, command ALL, USING true, WITH CHECK true。
- 両ロールとも SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER の表権限あり。PUBLIC の表権限は検出されなかった。
- UNIQUE(user_id,week_start)、id主キーあり。service_role は表権限と BYPASSRLS を持つ。
- 調べた public/private 関数ソースの表名参照と information_schema の参照ビューは検出なし。動的SQLや外部アプリ依存の不在を保証する調査ではない。
- pgrst.db_schemas / db_pre_request はこの SQL セッションと pg_db_role_setting からは取得できなかった。Data API有効状態・公開schema・ゲートウェイ設定は未確認。

**評価:** DB権限は所有者境界を設けていない。Data APIからpublicが公開され有効キーで到達可能なら、匿名/他社員による読取・改変が可能となる構成。外部 API 経由の実データ露出を実証したという意味ではない。
秘密・資格情報・Authユーザー一覧の取得、匿名の実データ読取、実データ更新、ロール切替、RLS/GRANT/Auth変更は行っていない。

## 承認用の具体案（未実行・自動 migration に含めない）

MFの確認済み週報経路は認証付きサーバAPIから service_role を使用。まずこの表のブラウザ直接アクセスを閉じ、現在のAPIを正規経路にする。
ただし旧タイムカード等の簡易ログインが直接この表へアクセスする可能性がコードコメントにあるため、依存先確認と合成データによる隔離環境テストを実施した上で本番適用承認を受ける。

```sql
-- Proposal only. Run ONLY after explicit production approval.
BEGIN;
REVOKE ALL PRIVILEGES ON TABLE public.tc_weekly_review FROM anon, authenticated;
DROP POLICY "tc_weekly_review all" ON public.tc_weekly_review;
-- RLS stays enabled; service_role privileges remain unchanged.
COMMIT;
```

適用直前にポリシー・表/列権限・PUBLIC/継承ロール・依存先を再確認する。変更中止時はトランザクションをROLLBACK。
適用後に既存サービスから障害が起きた場合はサーバ API への切替を優先し、無条件trueポリシーを自動復活させない。緊急復旧も別途承認対象。

将来クライアント直接アクセスが必要なら、単に `TO authenticated` を付けるだけでは不足。本人一致 `(select auth.uid()) = user_id` の SELECT/INSERT/UPDATE 条件、UPDATEのUSINGとWITH CHECK、q1〜q4など本人更新列のみに限定した列権限が必要。管理者評価列や user_id の変更を許可しない。名簿の有効在籍・テナント整合性を検証し、未公開評価列の読取も避ける投影/RPC設計が必要なので、安易な所有者RLSへの置換は今回行わない。

安全な露出確認は Data API 設定のメタデータ確認を先行する。必要なら承認済みの公開クライアントキーだけを使い、`select=id&limit=0`（Countなし）の空応答テストを行い、実行可否だけを確認する。実際の行取得や書込試験は隔離環境の合成データに限定する。
参考: https://supabase.com/docs/guides/api/securing-your-api （GRANTとRLSは別の境界）。Supabase changelogも確認。

## 検証結果と限界

通過:
- `node --experimental-test-module-mocks test/weekly-review-entry.mjs`: 実APIハンドラ＋メモリDB。本人読取/保存/更新、他人ID無視、評価列保護、未公開評価非返却、日付拒否、未認証/名簿未紐付け拒否、読取/保存/勤務曜日取得失敗。
- `node test/weekly-review-form.mjs`: 実インラインJSをVM実行。保存応答の保持・再読取、週切替、未保存警告、通信失敗で保全、通信中ロック、0問保存のfilled=false。
- `test/nipposcheduleapi.mjs`: 38ケース。既知の締め日の週報必須、不明/取得エラーで違反としないことを追加。
- `test/nippo-preservation.mjs`: 43ケース。
- `test/nippotest.mjs`、`test/weekly-prep.mjs`（3ケース）、`test/keiei-weekly.mjs`（3ケース）。
- 構文・git diff --check。

未完/環境制約:
- `test/ui/weekly-review-entry-ui.mjs` を追加。1280px/390pxで実ハンドラと架空セッションを結び入力→保存→再読込、過去週、失敗、日報ゲートから独立して保存、表示幅を検証する設計。ローカルではChromium起動が `socket() failed: Operation not permitted` で停止。実画面の成功とは報告しない。CIでの実行が必要。
- 既存許可済みブラウザのタブは0。本番への本人ログイン/保存の実機確認は未実施。
- `node test/selfcheck.mjs` は既存 `test/ui/salescompanyportalui.mjs` の `_shot.mjs` 規約違反1件で失敗。同ファイルはmainと差分なし。本件で無関係なファイルを修正しない。
- 全体 node/UI スイートは完走していない。実RLS境界は合成隔離DBでの適用前後試験が残る。

## 残る最小限の操作

1. UI CI の成功を確認してから、このコードのレビュー・マージ/配信を別途承認。現時点は未マージ・未デプロイ。
2. 未周知5名について本人のログイン・名簿紐付けを確認。ユーザーからの情報では全員active、田村雅裕のみuser_id未紐付け。新井美和・市川集翔・寺島周作・関口太郎もログイン実証済みとは扱わない。管理者が田村の正しい既存アカウントを確認して紐付ける必要がある。資格情報取得/代理ログイン/権限拡張/周知送信は行っていない。
3. 本人が対象週と勤務曜日を確認して保存し、再読込で内容を確認。金曜日の集約までに保存、Pが17:30 JSTまでに集約報告する運用を既存定期集計に接続。定期設定は変更なし。
4. 上記DB変更案の依存先・隔離環境テスト結果を確認し、本番適用承認を別途取得。

## 継続検証: 旧画面依存と隔離DB（2026-11-13）

### 旧サイトへの依存は実在する

GitHubの正式接続で `morishin1/8grp-site` のコードを読取確認した。検索インデックスはヒットしなかったため、MF docs/accounts.md に記載されたパスを直接確認。旧サイトの実ログインやDBデータ読取は行っていない。

| 経路 | 確認したコード | 影響 |
|---|---|---|
| 旧本人日報 | [8/dr/index.html](https://github.com/morishin1/8grp-site/blob/main/8/dr/index.html) blob `82b57e6f1445f89aef141c14270062c6a4f24017`: L1285読取、L2192-2193更新/作成。`tc_login`、Supabase Auth signInWithPasswordなし | 通常の簡易ログインはanon。今回の剥奪後は旧週報が停止する |
| 旧管理者日報 | [8/zimu/dr/index.html](https://github.com/morishin1/8grp-site/blob/main/8/zimu/dr/index.html) blob `42d35823249aeee422dd631d5865b86bd4e737f7`: L588読取、L889-890/L1147-1148更新/作成。Supabase Auth signInWithPasswordあり | authenticated直接アクセスのため旧管理者による評価公開も停止する |
| タイムカード本体 | [8/timecard/index.html](https://github.com/morishin1/8grp-site/blob/main/8/timecard/index.html) blob `5b72908d3a6d514f8e7fe43a0616d69fafbc3f14` | このファイルにtc_weekly_review参照なし。打刻表tc_records等への今回のGRANT変更は提案しない。サイト全体の無影響保証ではない |
| 旧セットアップSQL | [8/timecard/nippo-setup.sql](https://github.com/morishin1/8grp-site/blob/main/8/timecard/nippo-setup.sql) blob `86cff5cafd19770f2e19962b3139bc74cb6397bc` | 無条件ALLポリシーを再作成する。再実行で穴が戻るため、旧セットアップ運用も停止/修正が必要 |
| MF | api/nippo/index.js, weekly.js, monthly.js, dashboard/index.js, contracts/index.js, probation/index.js, keiei/weekly-prep.js, lib/keiei-weekly.js（呼出元api/keiei/index.js） | 確認した週報アクセスはadmin()のservice_role経路。今回の匿名/認証済み表権限剥奪後もサーバ経由は維持する設計 |

追加の本番メタデータ読取では、週報の独立した列ACLとユーザー定義トリガーはなし。anon/authenticated自体が他ロール権限を継承する所属も検出なし（postgres/authenticatorからこれらロールへの所属は存在）。PUBLIC表GRANTなしという先行確認と合わせ、表GRANT剥奪に別の列権限が残るケースは検出されなかった。

### 推奨する適用順序（いずれも未適用）

1. PR #343 の画面CIを通し、MF週報入力の配信を承認・実施する。社員5名の本人ログインと正しい名簿紐付けを確認。管理者もMF側で評価公開できることを確認する。
2. 旧本人・旧管理者の日報画面から週報の直接SELECT/INSERT/UPDATEと編集ボタンを除去し、GWの本人画面 `https://gw.8grp.co.jp/nippo.html`、管理者は既存のGW管理画面へ誘導する変更を別PRでレビューする。旧簡易ログインの資格情報をGWへ転送しない。未保存入力がある利用者には保存/コピーして移行してもらう。旧サイト変更は今回実施していない。
3. 旧 nippo-setup.sql がこの表の開放ポリシーを復活させないよう別PRで修正し、運用手順を更新する。必要な旧週報利用者の切替完了を確認する。
4. 本番適用前に「対象はtc_weekly_review一表、anon/authenticatedの全表権限剥奪と無条件ALLポリシー削除、他のtc_*とAuth設定は変更なし、旧画面の直接アクセスは失敗する」を報告して明示承認を受ける。承認後、上記SQLをトランザクションで適用する。緊急に露出を閉じる方針なら、旧週報を停止する影響を承認した上でこの手順を先行できるが、無停止とは説明しない。
5. メタデータの権限再確認と、承認済みのキーによる0行RESTテスト、MFの本人/管理者のスモーク確認を行う。失敗時も無条件開放は自動復活させない。

### 隔離PostgreSQLでの権限試験

`scripts/verify-weekly-review-rls.mjs` を既存インストール済みPGlite **0.5.12**（メモリ上のPostgreSQL）で実行し、すべて通過。接続URLを受け取らず、毎回新品DBと合成2名のみを作成する。

- 修正前: anon/authenticated双方が合成2名分を読めることを再現。
- 同一のREVOKE/DROP POLICYをBEGIN→ROLLBACKした場合、元権限が維持されることを検証。
- COMMIT後: 両ロールのSELECT/INSERT/UPDATE/DELETE/TRUNCATEは実SQLで42501。表権限7種すべてfalse。
- RLSは有効のまま。service_roleによる本人キーのupsert/再読取は成功し、別の合成社員の行は不変。
- Supabase RESTゲートウェイや実認証を再現する試験ではない。そこは本番設定メタデータと承認後の0行試験が必要。

### CIの追加対応

初回PRのnodeジョブ停止は既存 `salescompanyportalui.mjs` のスクリーンショット規約違反だけだった。保存先3か所を共通 `shotPath` に統一する最小修正を追加し、selfcheckはローカル通過。
週報だけを待たずに検証できる `Weekly review entry smoke` ワークフローを追加。実API＋架空DB、実フォームJS、回帰テスト、隔離PostgreSQL、Chromiumで1280px/390pxの保存→再読込を検証し、成功画面をArtifactに保存する。本番のログイン・認証迂回・データ変更は一切含まない。

### CI実測とキャッシュ互換性の補正

[週報専用CI run 43320234731](https://github.com/morishin1/MF/actions/runs/43320234731) は成功。API/form、隔離PostgreSQL、Chromium 1280px/390pxでの保存・再読込をすべて実行し、`weekly-review-screenshots` Artifactを生成した。架空セッション・合成DBによる実ブラウザ試験であり、5名本人の本番ログイン実証ではない。

全nodeスイートをローカル実行して379本中354本成功、25本失敗を確認。そのうち `sharedassets` は本変更の `API.ownWeeklyReview` 追加により、既存の1年キャッシュ版に関数が存在しない問題だった。共有api-client.jsへの変更を取り消し、以前から公開済みの `API.api` で専用GETを呼ぶよう修正した。`sharedassets` とフォーム回帰試験は修正後に通過。全HTMLのキャッシュ版を変更する必要はない。

残る24本は別worktreeの基点main `c61d6e47` で同じコマンドを実行し、全件失敗を再現した: assethash, calendarnavtest, keieihubapi, memberdocument-phaseui, navcheck, officedesign, officemonthflow, sales-company-add-canonical, sales-company-haiku-classification, sales-company-local-ai, sales-company-login-modal, sales-company-offer-context, sales-company-portal, sales-company-preview-demo, sales-dashboard-date-controls, sales-dashboard-tabs, sales-decision-board, sales-enger-execution-link, sales-meeting-intro-public-sheet, sales-priority-period-company-modal, sales-success-fees, salesassets, slackhistoryui, speedcheck。HR・Salesなど別作業の機能に踏み込むため、このPRでは修正しない。全体CI成功とは表現しない。

### 管理者APIのテナント境界（追加修正）

旧入口移行の再点検で、`GET /api/nippo/weekly` に権限ロール判定はあるが、指定userIdの所属テナント確認が不足していた。POSTと同じ所属照合をGETにも追加。GET/POSTとも社員照合エラー時は503で停止し、存在しない社員・別テナントは404、週報読書きには進まない。
`test/weekly-review-authorization.mjs` の合成データで、admin/owner/hrの24ケース、未認証・一般社員拒否、下書き保存と評価公開の区別、自己振り返り保持を確認。実ユーザーの認証情報・行データは使用していない。
