# Office「今日やること」統合・レビュー用

基点: main d7700a7。新画面/API/DB/8sp接続は追加しない。

## 表示範囲
- Office人事権限の既存申請API: pendingはOffice役割の判断、pending_ownerはKEIEI待ち。個人担当と誤認させない。
- 本人の既存tasks API scope=mine: todo/doingのみ。未受諾はAPI needsAcceptそのものを使用。
- Office業務と資料期限の既存集計、定例/単発予定（今日・期限超過・今週）。
- 種別・手番filter。上位5行、残りは展開。個別原本と集計項目の混在は「行」と表示し、総案件数と呼ばない。
- 原本種別:idで重複排除。同名の別案件は消さない。Office上部申請3行は同一一覧へ移し、件数カードは維持。
- 元画面で処理。既読・表示・filterでは状態更新しない。元画面が個別URL非対応の申請/タスクは「一覧で確認」とする。

## 不明・権限
- 未担当/期限未設定を明示。申請開始日は承認期限と見なさない。既存集計の個別担当・期限は元画面確認とする。
- 読取失敗/未準備/社員未登録は未確認表示。未確認を0件としない。API上限到達時も警告。
- Office権限を拡張しない。本人タスク以外を全社タスクとして取得しない。
- 自分が頼んだタスクはAPIが取得失敗を空配列にするため今回は除外。AI提案/入社extrasも未統合で範囲説明する。

## 今回対象外
- 8sp予約/問い合わせ、MFメッセージの返信義務・完了判定、全社担当管理。
- 8spは読取認可・手番情報の追加検討が必要。MFの社内予約を8spと混同しない。
- PR181の承認フロー/KEIEI画面、PR165のKEIEI初期表示は変更しない。

## 検証
- test/office-actions.mjs: 実adapter/実render関数VM、権限scope、手番、重複、filter、XSS escaping、空/失敗状態。
- test/office-people-dashboard-compact.mjs: 既存pulse互換と統合時の重複行なし。
- 実ブラウザはローカルChromiumのsocket() Operation not permittedで起動不可。VMを視覚/実ブラウザ検証の代替完了とは扱わない。
- 実DB/RLS/実アカウント、Preview/公開push/本番未実施。最終npm test: selfcheckと204/204 PASS。focusedテスト・inline構文・diff check・patch reverse apply checkもPASS。

注意: 既存Office予定GETは定例予定の自動生成を伴い得る。将来のPreviewで本番DBに接続している場合、読取画面だから無変更とは見なさず別途許可範囲を確認する。今回そのAPIは実呼出していない。
