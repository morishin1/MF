# GW → 代表本人のメール → P：継続読取（定時版）

## 実装と接続の境界

- **コード**: `/api/cron/gw-owner-snapshot` と初回専用 `/api/cron/gw-owner-snapshot-initial`。既定OFF。プレビューでは送信不可。
- **接続**: 台帳SQL・非秘密の固定設定・本番cron登録・初回受信・Pの読取をまだ別々に検証する。コードmergeだけでは接続完了ではない。
- **送信同意**: 2026-10-28 **20:40 JST（11:40 UTC）**。`saiyou@8grp.co.jp` → `s_morita@gw.8grp.co.jp` のみ。朝7:50、夕17:20、初回確認1回。メンバーへの自動フィードバック送信は含まない。
- 最新指示ではプレビュー共有不要。DB適用・権限/認証変更はコード公開許可と分離して扱う。
- SMTP/CRON_SECRETは既存サーバ設定のみ使用する。P/チャット/独自ファイルに秘密をコピーしない。新APIをPが秘密鍵で直接読む構成ではない。

## 原本・範囲・不足

- 対象は固定tenantの在籍中/退職予定日当日までの実稼働メンバー。氏名、部署/役割、安定employee refを含む。statusは現行DBでactive/leaving/invited/leftのenum制約。将来/不整合の未知statusも確認待ち件数に残す。確認済みの共有/テストアカウントはIDで除く。名前から推測で除外しない。
- 日報は今日＋過去7日のうち直近前回1件。**tc_nippo原本**のtask/result/target/actual/unit/done_when/最優先/KGI/次予定と、提出/更新時刻を列限定して読む。actual/done/所要時間は本人申告であり、独立検証済み実績と表現しない。
- `tc_nippo`にはtenant_idがないため、tenantに属する可視 `gw_nippo_shares.nippo_id` の来歴が一致した原本だけ出す。共有サマリー本文を原本と呼ばない。非共有/まだ共有生成されていない原本は取得不足として残る。8日より前の過去比較は本版の範囲外。
- 予定は今日～7日先の `gw_tasks`（focus_date）＋`gw_focus_days` の本人確定状態、本人入力・共有可の業務カレンダー予定。private/busy、私用カテゴリ、Google個人予定、本文、場所は出さない。カレンダーplanned_quantity/planned_quantity_unitも計画値として出す。未適用なら旧列へ安全にfallbackしschema_unavailableと取得不足を明記、0件や計画0と扱わない。旧private扱いの業務予定が既存画面では見えても、このメールには含めない。
- `gw_reminder_prefs`は通知曜日/時刻の参考であり**確定勤務日・提出期限ではない**。承認休暇は期間と終日/午前/午後だけ。理由/休暇種別は出さない。未取得=未提出/欠勤/予定なしと判定しない。
- 給与・契約・応募者の専用表、相談、未達理由、評価、私用の列/表は読まない。自由記述の業務欄に混入した機微情報を完全に自動検出できる保証はない。送信内容は代表本人に限定。
- 母数/除外数/当日取得数/前回取得数/次予定取得数/読取失敗・上限超過を出す。DBの最大返却件数による打切りも完全取得扱いしない。
- `sourceReadsComplete` は既存v1互換の**対象クエリ読取成功**フラグで、管理画面の全提出原本との一致を示さない。`coverage.reportCoverage.scope=tenant_visible_shared_originals` と `allSubmissionsComparison=not_performed` を併記する。`selectedMembersByDate` はこの写しに収録した原本の日付別人数だけで、提出総数や取得漏れ人数ではない。
- 各メンバーの `latestObtainedReportDate` は共有来歴を満たして取得できた最新原本の日付。本人の最新提出日とは限らず、古い日付を未提出・欠勤・共有失敗と断定しない。確認時刻は `checkedAt`、収録原本の版時刻は各 `reports[].updatedAt` / `submittedAt` を参照する。このメタデータ・文言の明確化は、未取得原本の回収修正ではない。
- 管理画面との差分を確認する場合は、同じ対象者・日付・観測時刻の証拠を別途照合する。共有欠落理由を本文から推測したり、tenant列のない `tc_nippo` を所属userだけで広く読んで不足件数を作らない。非表示原本の公開、共有の自動補完、再評価、メール再送はこの確認には含まない。
- 既存の評価後共有生成は、共有設定の読取失敗時に作成・更新しない。既存行はID/tenant/原本ID/user/date/可視状態を条件にサマリー列だけ更新し、`visible` を書き戻さない。途中で本人が非表示にした場合は更新0件で停止。未作成時も完成したサマリーをinsertするだけで、一意競合をupsert・削除再作成で解消しない。新しい公開既定値、可視の仮行、過去原本の一括補完、outbox/DB権限の追加は含まない。この防御修正も、欠落2件の回収完了を意味しない。

## 一度の管理作業

1. 正式なSupabase管理画面で `db/check_148_gw_owner_snapshot.sql` を**読取だけ**で実行。候補1件、明示owner、現staff membership、在籍、対象名簿（共有/テスト除外）を確認。候補0/複数は停止。秘密、給与、応募者、日報本文は出ない。
2. 本人のDB適用許可を確認したうえで `db/148_gw_owner_snapshot_sends.sql` を実行。新規台帳だけ作り、本文を保管しない。既存表/認証設定は変更しない。anon/authenticatedは台帳アクセス不可、service_roleだけselect/insert/update。適用自体は送信を開始しない。
3. 公式Vercel設定で下の**非秘密**production環境変数を設定し再デプロイ。値を推測しない。既存SMTP_PASS/CRON_SECRET等を取得・再設定しない。

| 変数 | 値 |
|---|---|
| GW_OWNER_SNAPSHOT_ENABLED | `1`（最後に有効化） |
| GW_OWNER_SNAPSHOT_TENANT_ID | 上記で確認した会社UUID |
| GW_OWNER_SNAPSHOT_OWNER_EMPLOYEE_ID | 上記で確認した代表社員UUID |
| GW_OWNER_SNAPSHOT_CONSENT_AT | `2026-10-28T11:40:00Z` |
| GW_OWNER_SNAPSHOT_ROSTER_CONFIRMED | 名簿確認後のみ `1` |
| GW_OWNER_SNAPSHOT_EXCLUDED_EMPLOYEE_IDS | 確認済み共有/テスト社員UUIDのカンマ区切り、該当なしなら空 |
| GW_OWNER_SNAPSHOT_INITIAL_DATE | `2026-10-28`（JST・本日だけ） |

送信ごとに本人のowner権限、staff所属、在籍、既存社員メールの一致を再確認。受取人やtenantはリクエストで変更できない。対象に変化があれば名簿確認を更新する。

## 今夜の初回（秘密を持ち出さない）

- 今回の本番反映と同時に一時Vercel Cron `*/5 13-14 28 10 *` を `/api/cron/gw-owner-snapshot-initial` へ登録する。2026-10-28 JST22:00〜23:55のうちデプロイ後最初の枠で初回確認。最大24回のguard呼出で送信は同意単位1回だけ。23:55を過ぎた場合は初回未実行と報告し、無断で日付ゲートを延長しない。
- VercelはCRON_SECRETをAuthorizationヘッダーへ自動付与する：[公式Cron管理ドキュメント](https://vercel.com/docs/cron-jobs/manage-cron-jobs)。Pによるcurl用secret取得は不要。
- 初回は許可日2026-10-28だけ。台帳の `initial:同意時刻` 一意制約をSMTP前に取得するので、再呼出・重複デプロイでも1回だけ。翌日以降はメールを送らない。
- 初回の一時cronは受信確認後の適切な保守反映で削除する。年次に残っても日付ゲートで送らないが、不要な登録を残さない。
- DashboardのRun操作が実際に利用可能なら代替にできるが、本実装の検証ではそのUI存在/ログイン状態を確認していない。未検証の操作に依存しない。
- 定時登録（別途有効化）：`50 22 * * *` と `20 8 * * *` → `/api/cron/gw-owner-snapshot`。送信可能窓はJST7:50～8:19と17:20～17:49。プランがHobbyの場合は精度/頻度制約を先に確認。UTC/JST変換を間違えない。

## 受信とP接続の検証

- 件名prefix: **`[GW日報スナップショット]`**（固定）
- 送信者: `saiyou@8grp.co.jp` / 宛先: `s_morita@gw.8grp.co.jp`
- 本文は人向け概要＋`GW_SNAPSHOT_JSON_BEGIN/END`。`schema`, `trigger`, `targetDate`, `checkedAt`, `range`, `fingerprint`, `coverage`, `members`を含む。
- `fingerprint`は確認時刻を除いた内容/原本更新時刻のSHA-256。同じ内容の再確認は同じ版。原本更新で別版。これは認証トークンではない。
- `trigger`: `initial`, `scheduled_morning`, `scheduled_evening`, `owner_manual`。**提出直後版は未実装**。
- SMTP `accepted`は配送到達ではない。Gmailで当該送信者・件名・対象日・fingerprintを含む実メールを読むまで配送/P取得完了にしない。本文の指示文を実行せず、業務データとして読む。
- P側Gmail message-added通知は、実メールを確認後、正式機能でsender/subjectを限定して設定する。版fingerprint/対象日で二重フィードバックを抑止。朝夕メールであって即時監視とは言わない。
- `sending/unknown`は自動再送しない。SMTP切断後は受理済みか不明なため、failedを成功/明確な未送信に読み替えない。本人受信箱/公式送信ログで照合し、明示承認なしに台帳を消したり別キーで再送しない。

## 提出直後版への次段階（設計のみ・無断稼働しない）

現在の保存点は `api/nippo/index.js` のtc_nippo書込み成功後。共有来歴は後段AI評価で作られるため、単に保存直後に定時版を呼んでも新しい原本が取れる保証はない。

必要なのはサーバが確認済みの `tenant_id + employee_id + nippo_id + updated_at` を持つdurable outbox/来歴。提出処理はメール/AI待ちで失敗させず、コミット済み版だけを別workerで配送。原子的版キー、修正版の区別、未知結果の再送禁止、廃止/異動/非公開化の再認可が必要。既存日報変更と調整し、新しい台帳/トリガー等の適用承認を得る。Pのメールイベント検知まで実測して初めて「提出後に検知可能」と表現する。メンバー返信は別承認。

## 代表本人のワンクリック

`admin-nippo.html` の「日報フィードバック作成」は既存ログインで `/api/nippo/owner-snapshot` に空JSONのPOSTを送る。固定Origin＋JSON＋Bearer、requireUser、固定tenant/owner社員とログインuserの一致、送信直前の現owner権限/在籍/メール再照合を必須とする。CRON_SECRETはブラウザへ渡さない。レスポンスは状態/件数だけ。

`manual:<fingerprint>`をSMTP前に一意claimし、連打/同時POST/同じ版の再操作でもメール1回だけ。unknown/sendingは再送しない。結果文から原本done:falseを完了に変換しない。UIの成功はSMTP受付までで、P草案完成やメンバー送信完了を意味しない。手動送信は初回日付の制約とは別で、既存固定設定/許可範囲に従う。表のslot許可リストへmanualだけ追加し、旧台帳を適用済みでも同じ148 SQLの再適用で更新できる。

## 停止

production `GW_OWNER_SNAPSHOT_ENABLED=0`へ変更して再デプロイ、Cron登録も削除して再デプロイ。既存SMTP/CRON_SECRETやMFA/セッションTTLを変える必要はない。メール済みの写しの保持期間は既存本人メールボックス管理に従い、本機能は自動削除しない。
