# 日報・次勤務日計画 → EIGHT行動コーチ（Draft / 無効既定）

読取実装基点: `main 5ae9b9092d49da41c348bdb80ff5fa2e4a88b19f`。公開前再確認: `b287add4ceffdcfe2b9695930d64114b271345d6`（PR161のみ追加、calendar関連4ファイルの変更で今回と重複なし）。本変更はPR159の社員Q&Aと別機能。Issue147の提出通知とも別。既存calendar UI/API、既存日報保存API、17:30/08:00のautomation、Vercel cronを変更しない。

## 実装範囲

- 候補SQL `db/148_behavior_coach.sql`：提出・修正・取消/削除後はappend-onlyイベントへID/版metadataのみ記録。同期triggerでreviewをロック・更新しない。別のcollect処理が社員/対象日へ集約し、業務予定変更はその時だけ直近30日既存reviewをdirty化。
- 原子的upsert、世代CAS、10分の分析lease、旧tokenの結果拒否。source_revisionとevaluation_epochを分離、改版で承認失効。
- `lib/behavior-coach.js`：同一tenant/社員のGW正本を再読取。`tc_nippo`にtenant列がないため、user→社員対応が複数なら停止。退職/非稼働状態が明示される人は通常分析対象外。状態不明は未確認。
- 現在の材料：前回提出日報の次勤務日計画、当日日報、業務予定、登録タスク、勤務曜日設定。私用/Google個人予定、給与、採用情報、相談欄は読まない。
- 既存 `askJson` を利用するAI草案。3点以内（良かった行動／次勤務日に変える1つ／次回振り返り）。日報の成果は本人報告として扱い、独立確認済みとしない。
- `api/nippo/coach.js`：指定された代表のGW本人IDかつ管理/owner権限だけが参照・解析・個別承認可能。一般adminやHRというだけでは承認不可。
- 草案に本文・根拠・確認日時・送信元・宛先全員・mapping版を提示。承認は草案ID/本文/targetHashに束縛し、正本と宛先を再照合。
- **送信API・Slack実adapterなし**。承認しても本人へ送らない。将来用のattempt/unknown/receipt SQLだけを設計し、全delivery設定は既定OFF。

## 計画の扱い

前日の終業時に次勤務日の計画を立て、当日朝に微調整し、次の日報で変更理由と成果を振り返る。計画は「何をする」「何を完了する」「最優先」を確認する。翌日分を実績日報とは呼ばない。計画変更自体を問題としない。

`gw_reminder_prefs.workdays` は1=月〜7=日。人別設定から次勤務日の**候補**を求め、曜日設定がなければ未確認とする。一般的な月〜金を勝手に補わない。休暇・祝日・実シフトとの照合は未実装なので候補を確定勤務日と扱わず、休日翌暦日への入力を強制しない。

## 代表のレビュー導線（API段階、画面/Slack通知は未接続）

別途承認された非本番テストDBでSQLを適用し、実在しない合成ユーザーだけを使用する。現時点ではSQL適用・設定は実施していない。

1. 管理者がレビュー済みの config に代表GWユーザーIDを指定。`enabled`, `ai_enabled`, `delivery_enabled` は全てfalseが既定。DBとAIの利用をそれぞれ承認してから必要なものだけ有効化。
2. 保存成功イベントの後、`POST {action:"collect"}` で最大10件を取得・集約する（SKIP LOCKED、別transaction）。新cronは登録しない。reviewがqueuedになる。`GET /api/nippo/coach` で代表が自分のtenantのreviewを確認（最新100件、no-store）。
3. `POST {action:"refresh",id}`：既存の17:30/翌朝08:00の確認で使う入口。翌朝08:00以降はfinal評価epochへ移し旧承認を失効。元データ変化も再確認する。同文本人再送の抑止と代表の判断事項は別に保つ。未collectの同一社員イベントが残っている間は承認・将来attemptを拒否する。
4. `POST {action:"analyze",id}`：AI有効化済みの場合だけ1件をclaimし草案生成。読み取り不能・切り詰め・不正AI出力は未確認/失敗として停止、承認は作らない。分析失敗は同世代queuedへ戻り、明示再試行できる。
5. 草案の `text`, `points`, `missing`, `sources`, `checkedAt`, `target`, `targetHash` を確認。本人情報は人が照合した `gw_coach_recipients` が必要。現経路は代表+当該本人+Pのみの限定グループ。メンバー追加/宛先変更は承認を使い回せない。
6. `POST {action:"approve",id,draftId,text,targetHash}`：代表の個別承認のみ保存し、`deliveryEnabled:false` を返す。**承認=実送信ではない**。認証トークンはGitHub/チャットへ貼らない。

代表へのSlack通知・ブラウザ承認画面は今回未実装。現在はAPIとしてレビュー可能にする段階。17:30/08:00タスクからAPIへ実接続する設定も未変更。

## 不足する証拠・本番リリース前の条件

- Sales/ENGER/公開URL等の成果物を独立して読むadapterは未実装。契約業務範囲・実稼働/休暇/シフト・提出期限も未照合。これらをmissingとして草案へ常に明示するため、現readerは安易に「順調」と確定しない。
- 全員未提出チェック・既存日報の初期backfill・trigger失敗時の定時reconcileの網羅実装は未接続。triggerは同期review更新を避けた最小イベントINSERTだけとし、通常の例外は本文なしのSQLSTATE警告にする。ただしINSERT自体のDB待ち/timeoutはあり、query_canceledはOTHERSで捕捉されない。**元保存を絶対に止めない・遅延ゼロという保証はしない**。catchで失ったイベントは別途再照合が必要。既存reviewのrefreshだけでは初回キュー未作成を回収できない。
- 翌朝の最終確認は評価時点の区別であり、実際の個人別提出期限は未設定。「期限超過」を時間から推測しない。
- 保存時イベントに加え、社員/契約/recipient mapping/タスク/Sales等の変更をすべて自動invalidateするtriggerは未実装。分析完了前・承認前のsourceHash再読取で差分を検出する。実送信を実装する際は直前の在籍/権限/本人/宛先全員/業務版/評価版再照合が必須。
- draft内の根拠refsの存在検証は、文が実際に裏付けられることの完全保証ではない。代表確認を省略しない。日報内命令は未信頼データとしてAIへ渡す。
- APIには送信/削除/recipient編集/自動承認を実装していない。DBに将来のdelivery RPCがあっても本番実送信を許可した意味ではない。
- 送信開始済みは永続attemptへ先に記録。クラッシュ/timeoutはunknownへ隔離し、版変更でも解除しない。人がSlackのmessage IDと承認記録を照合するまで再送禁止。手動解消UIと実receipt adapterは未実装。
- PostgreSQLによるDDL/RLS/実並行transactionに加え、イベントINSERTのロック待ち/timeoutと元保存への影響、collectの再試行/rollback試験が本番有効化前に必須。これらは未実行。SQL148の採番は公開前に全関連branchで再確認。migrationは新規作成用（再適用ではduplicateエラー）。無断で既存tableを落として再適用しない。
- 本番DB、鍵設定、送信権限、実AI/実社員データテスト、merge/deploy/本人送信は別承認。Previewも本番DBを使う場合は設定をOFFのままにし、実データにPOSTしない。

## テスト

`node --test test/behaviorcoach.mjs`：合成データ＋mock Supabase/RPC/AIのみ。対象はsource境界、個人勤務曜日、次勤務日の計画、prompt方針、CASモデル、改版失効、出力ガード、代表認証/宛先確認、SQLの静的安全性条件。

このテストは実PostgreSQLのロック/RLSや本物のSlack到達を証明しない。元の30件in-memory状態機械テストは設計試作として別ディレクトリに残し、このPRへmock実装を本番コードとしてコピーしない。

ローカル環境はconnectorから取得した必要ファイルのみの部分checkout。全repositoryテスト・本物のauth/Supabase/model統合・ブラウザ/Previewは未実行。CIで `node test/run.mjs node` が新規 `.mjs` を自動検出する。CI通過とDBテストを確認するまでマージ可能とは扱わない。
