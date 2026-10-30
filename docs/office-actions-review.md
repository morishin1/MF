# Office「今日やること」統合 — PR186 の最新 main への移植

## 基点と範囲

- 基点: MF main `c562979dad15a05d63c5299c0cefd56923270b32`（PR234・235・236 を含む）。ローカル基点 tree `5c3e1981e20f826072b6c2e965df0cc4f6e36727` は GitHub の同 commit と一致。
- PR186 の 8 機能ファイルを再統合。旧 107 ファイル patch の丸ごと適用はしない。
- 新画面・業務 API・DB・権限の追加なし。Sales、HR/Slack履歴、Marketing、専門家タブを保持。

## 表示

- Office人事権限で既存申請 API を取得。`pending` は Office の判断、`pending_owner` は KEIEI 待ち。個人担当と混同しない。
- 本人の tasks API `scope=mine` の todo/doing、Office 業務・資料期限・予定を統合。原本種別＋IDで重複排除し、同名別件は保持。
- 種別・手番フィルター、上位5行＋展開。個別案件と集計の混在は「行」と表示し、全件総数と呼ばない。
- 担当・期限がないものは未設定／元画面確認。申請開始日を承認期限にしない。取得不能は未確認、0件と断定しない。
- 処理は元画面。閲覧・フィルター操作で承認・受諾・完了・既読への書込みはしない。
- 日報週次 KPI が遅れても申請と本人タスクを表示する。古い再読込結果で最新表示を上書きしない世代ガードを追加。

## 対象外

人に頼んだタスク、AI提案、入社 extras、8sp 予約・問い合わせ、全社担当管理、PR181/165 の仕様変更。
手元の引継ぎには「仕様確認4点」の実文がないため内容を創作しない。既存 PR186 の範囲を保持。

## キャッシュ

- 公開済み `20261030hrslack3` の記録を変更せず、新版 `20261030officeactions1` を追加。
- 共通参照を一括更新し、`test/assethash.mjs --update` で新 manifest を生成。API 関数版履歴は追記。
- Office以外のHTML差分は共通キャッシュ版のみ。API実装・既存データ処理は変更しない。

## 検証と未完了の区別

- adapter/render VM: 本人 scope、手番、重複、filter、固定リンク、XSS escaping、未確認表示。
- pulse VM: 未解決 KPI が申請を止めないこと、古い KPI の遅着を無視すること。
- browser source: PC/スマホ、6行の展開、申請とKEIEI待ち、複合フィルター、再訪問、タスク取得失敗を追加。
- focused CI は架空 API のみ。Secrets・実DB・業務データ書込みなし。
- この環境の Chromium は `socket() failed: Operation not permitted` で起動できず、ブラウザ通過・視覚QA完了とは扱わない。
- CI/Preview/実アカウント/本番は未確認。実行結果は引継ぎに記録。

既存 Office 予定 GET は定例予定生成を伴い得るため、本番DB接続 Preview を副作用のない読取確認とみなさない。公開ソース保存・push・PR・merge・本番操作はこのローカル準備では行わない。
