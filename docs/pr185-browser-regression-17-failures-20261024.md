# PR #185｜共通ブラウザテスト17件の一次原因調査（2026-10-24）

## 実行の識別
- PR head `4cc36a71029cfd6cfc7ea4f904ff1b5275451795` の「サーバ側を確かめる」CI [run 40050267479](https://github.com/morishin1/MF/actions/runs/40050267479)：サーバ側ジョブは成功、ブラウザ側は **113本中96本成功、17本失敗**。
- 同じheadの「Sales journey focused browser regression」[run 40050267544](https://github.com/morishin1/MF/actions/runs/40050267544) は成功。共通スイートでも新規 `salesanalyticschartsui` / `salesanalyticshubui` / `salesproposaljourneyui`、および `salesproposalsui` は成功。
- Vercel Previewも成功。**共通CIが赤なので「全テスト合格」とは判定しない**。
- 利用者報告ではHR関連4件は変更前のmainでも同じ失敗。ここではPR差分・ログの状況と区別して扱う。未再現のものまで「mainが原因」とは断定しない。

## 17件・観測された失敗と原因候補

| # | テスト | CI上の症状 | 判定/次の確認 |
|---:|---|---|---|
| 1 | `calendarui` | 日付クリック→予定登録モーダルが開かず30秒タイムアウト | カレンダーのHTML/クリック対象・イベント結線の確認 |
| 2 | `coachui` | 見出し・手順（目的、成果、完了条件）が欠落 | 既存画面と旧テストの表示仕様不一致疑い |
| 3 | `headershortcutui` | 狭い幅で「HR/Sales/Office」を期待、実際は `person_add` 等のアイコン名 | ショートカット省略表示とMaterial Symbolsの読込み検査 |
| 4 | `hrinboxui` | 390px横はみ出し検証に失敗、`innerText` 30秒待ち | HR既存の画面・fixture待機。ユーザー報告でmain同様 |
| 5 | `hrinterviewedite2eui` | `innerText` 30秒待ち | HR面談編集の要素/モック応答。ユーザー報告でmain同様 |
| 6 | `hrinterviewui` | `innerText` 30秒待ち | HR面談の要素/モック応答。ユーザー報告でmain同様 |
| 7 | `hrmobileui` | 390/360pxで「タブ5つ」の期待と現在のHRタブ表示が不一致 | ナビ変更後の表示仕様とテスト期待の整合 |
| 8 | `hrschedulingui` | `innerText` 30秒待ち | HR日程調整の要素/モック応答。ユーザー報告でmain同様 |
| 9 | `memoui` | 見出し/内容が無く、クリック30秒待ち | GWメモUIの旧セレクタ/前提データ |
| 10 | `nippotodayui` | 提出済み/人数/今日列など複数の期待値不一致 | 固定日時は2026-10-08、日報の表示ロジック・テストfixture要照合 |
| 11 | `nippoweekui` | 提出済み/今日（水）の列・ステータス印の期待値不一致 | 固定日時は2026-10-07、同上 |
| 12 | `nippoworkui` | クリック30秒待ち | 日報モーダル/クリック対象の調査 |
| 13 | `officerecurringui` | 2026年10月の見出し/「+2件」不一致、クリック30秒待ち | 日時固定は2026-10-07、Office予定画面とfixtureの整合 |
| 14 | `onboardinghubui` | 入社完了後も「入社手続き」メニュー表示 | 入社ステータス/メニュー更新の既存ロジック |
| 15 | `salesui` | `locator.getAttribute` 30秒待ち | **PR #185の差分あり、独立調査必須**（後述） |
| 16 | `swrui` | `page.waitForFunction` 30秒待ち | Service Worker画面の旧アサーション/初期化タイミング |
| 17 | `workweekui` | `ERR_MODULE_NOT_FOUND: test/ui/_browser.mjs` | **確定：テスト自身の相対importミス**（下記） |

## 確定できた直接原因
### workweekui
`test/ui/workweekui.mjs` の `import { launch, BASE } from "./_browser.mjs";` は、実在しない `test/ui/_browser.mjs` を参照している。実在するヘルパーは `test/_browser.mjs` なので `../_browser.mjs` が正しい。**mainの同一テストにも同じ行がある**。これは画面そのものの障害ではなくテストの決定的な失敗であり、別PRで最小修正が適切。

### PR #185に直接かかわりうる salesui
- `sales/analytics.html` と `test/ui/salesui.mjs` はPRで変更されている。`#funnel .an2-card` → `#funnel [data-chart-key]`、`#revenue-btn` にテスト/表示を変更。
- 現在の `test/run.mjs ui` はテスト出力を `^\\s*NG|Error|Timeout` の先頭6行へ絞り、Playwrightの **どの `getAttribute` が待ち続けたかをログから切り落としている**。このログだけでは、今回変更したファネル由来か、別の既存Salesの要素か特定できない。
- 優先して `node --experimental-test-module-mocks test/ui/salesui.mjs` を**静的テストサーバとPlaywrightがある環境で単独実行**し、生の失敗位置とコールログを確認する。PR固有と確定するまでは安易に既存問題へ分類しない。

## 17件の扱いと次のアクション
1. **PR #185の新規経路はfocused test合格**。ただし共通CI失敗のため、まだmainマージはしない。
2. **最優先で salesui 単独失敗を再現・特定**。画面差分に関わる場合、PR185のブランチ上で修正し、専用UIテストと全体スイートを再検証。
3. `workweekui` のimport誤りは別のテスト基盤修正に切り出す。HR・日報・Office・GWの画面失敗は各担当の既存UI仕様・fixtureと比較し、サイレントにテスト期待を弱めない。
4. 30秒タイムアウト群はCIログにセレクタ・Call logが出ていないため、**根本原因確定前**。再現なしに「全件テストの不安定性」と決めつけない。
5. PR#185はDraftのまま維持。本番マージ・DB・SQL・実Sales API・本番デプロイは一切行っていない。
