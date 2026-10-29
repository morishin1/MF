# GW ログイン画面 レビュー用改修

## 範囲
- 基点: main `d7700a719dcda86f814e13abeeab699ab6e9ea83`、ローカル branch `review/gw-login-20261023`。
- PCは案内＋ログインの2列、スマホはフォーム優先。ラベル、16px入力、44px以上の操作領域、フォーカス表示、エラー通知。
- native form / username・current-password autocomplete / name でブラウザ標準の保存・自動入力に適合。独自のパスワード保存はしない。実際の保存候補表示はブラウザ・設定・password manager次第であり未保証。
- メールだけ `kp_login_email` に明示opt-inで保存（初期OFF）。認証成功後保存、チェック解除で即削除。保存不能でもログインを継続。保存したメールはログアウト後も残る。共有端末向けの警告を明示。
- 保存チェックはログイン維持設定ではない。既存 `kp_session` のaccess/refresh token保存と期限前refreshを `js/api-client.js` で再確認、変更なし。認証期限・権限・DB・環境変数変更なし。
- 重複submitを抑止。パスワード表示/非表示、タブ非表示で再マスク、MFAへ進んだ後/失敗/ページ離脱でpasswordを消す。MFAコードも検証後消去。
- MFAの戻るは既存API.logoutで中断した認証を破棄。送信中は戻るを無効化し、認証リクエスト自体を取り消したとは表示しない。
- ページ離脱後の遅い応答で画面遷移や新しいセッションのlogoutをしない。BFCache復帰は再読込して状態照合。
- 既存セッション復帰時も `/api/mfa` の `verified` を確認。登録済みAAL1なら6桁画面を再開、AAL2は再入力を要求しない。MFA取得失敗を未登録と扱わない。サーバ認証ポリシーは変更しない。
- JavaScript無効時はsubmit無効＋案内。認証情報をURLに載せない。

## 検証
- `node test/gwlogin.mjs`: 16 synthetic DOM/APIケース。
- `npm test`: selfcheck＋Node全体 **204/204 PASS**。
- `git diff --check`。
- `test/ui/gwloginui.mjs` を追加（実APIを使わずローカルファイルと合成APIのみ、1280/390/320px、横溢れ、Enter、表示切替、エラー後のpassword消去、スクリーンショット）。
- **実ブラウザは未実施**。標準Playwrightブラウザ未導入。既存 `/usr/bin/chromium` を指定すると `socket() failed: Operation not permitted` で起動拒否。スクリーンショット未生成。VMは表示品質・アクセシビリティ実操作の代替ではない。

## レビュー環境で残る確認
1. 静的サーバまたは全通信mockで `TEST_CHROME=... node test/ui/gwloginui.mjs`。
2. Tab/Shift+Tab、Enter、スクリーンリーダー、200%ズーム、320px、ソフトキーボードで確認。
3. テスト専用アカウントでpassword managerの保存/自動入力、MFAコード誤り/成功/戻る、reload/back/forward、遅い回線・切断を確認。実資格情報はレビュー資料/ログに残さない。
4. セッションrefresh・logout・共有端末でのメール削除を確認。メール保存解除ではブラウザpassword managerやsessionは消えない。

2026-10-23: 確認用Draft PR公開・CI/Preview・画面検証の明示承認あり。本番merge/deploy・認証設定変更・実資格情報の保存は対象外。

## 認証フローの独立レビュー（UIとは分けて確認）
- 表示・メール保存・autocompleteとは別に、初期復帰の `goToHome` をMFA状態照合へ変更。登録済みAAL1を再開しAAL2は通す。状態取得失敗/不正形式はfail-closed。専用回帰: status失敗/不正形式、AAL1/AAL2復帰、検証成功/失敗、戻る、中断、別タブsession変更、遅い失敗。
- 独立レビュアーの指摘（初期復帰MFA、JS無効時submit、遅いcatchによるlogout）を対応。設定・期限・API側権限の拡大なし。
- 別タブのsession変更をstorageイベントで検出し、古い画面の遷移を中止して再読込。ただし既存api-clientはログイン/verify応答を返す前にsessionを保存するため、**複数タブで同時ログインした際のAPI内部のsession上書き競合は本改修で解決していない**。共有API改修は別レビュー範囲。実ブラウザで未検証。
- 独立レビュー担当も `node test/gwlogin.mjs` 16/16 PASS を再現。
- ブラウザQAの正規escalation試行は、ランタイムのread-only filesystemエラーで実行前失敗。制限変更・禁止パスへの読取・再試行なし。
