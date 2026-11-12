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
