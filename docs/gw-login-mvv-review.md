# 新ログイン画面：新ロゴ＋MISSION / VISION / VALUE（確認用Draft）

## 起点と対象

PR187 head `3fd8c5e7786bb3c65ac2f3b998801c57cd448b72` の検証済みtree `34995c11d05dda24458d4415de347c4b47c56b48` を独立cloneで使用。ユーザー添付 `libfile_191218eaf570819195378503c28e778e` の画像を正規Library経路で取得・実見し、新しい2カラムログイン画面が対象と確認した。

- `img/logo.svg`：提供ロゴ `libfile_cec8604dd7c08191bc04e6f17024c6b8` の透明PNG原bytesを無加工で埋込み。PR188と同一。
- `index.html`：案内欄を本人提供のMISSION/VISION/VALUE本文・5見出し・文化の言葉に差替え。解説や提案メタ文は掲載しない。
- PCは左に理念・右にフォーム。DOMはログインカード先頭、スマホもフォーム先頭。理念がログイン操作を下へ押し出さない。
- VALUEは標準`details/summary`（初期閉）。5項目を保持し、追加JavaScriptを使わず展開できる。
- ログインカード全体のHTMLと4つのscript要素が起点と完全一致することを比較確認。認証・保存・MFA・API・期限・権限を変更しない。
- 社労士/税理士専用画面は別作業。既知のPR187退職者導線の問題も本件では修正しない。

## 検証と限界

`gwlogin` 16/16、`gwlogo`、`gwmvv`（本文・5見出し・DOM/モバイル順序・ネイティブ展開構造）、`git diff --check` が成功。独立静的レビューで認証script/login-card無変更を再確認。最終aggregateは`npm test` **206/206成功**。既存`test/ui/gwloginui.mjs`には画像decode・モバイル順序・VALUEのEnter/Space/連続開閉・フォーム位置保持と展開スクリーンショット検査を追加（構文成功、実行は未実施）。

確認画像（Library）は**オフラインSVGで組んだ配置サンプルであり、HTMLの実ブラウザレンダリングやスクリーンショットではない**。文字の折返し・余白・フォーム補足文の表現には実装との差があり、実装本文は`index.html`を正とする。

- PC `libfile_4832d66aea00819198e455a60cf58ad3`
- スマホ `libfile_1f783e6603a48191b3575a5314bce8d8`

実ブラウザの320/390/1280px、ズーム、VALUEのEnter/Space/連続開閉/戻る、展開中のログイン・MFA/エラー配置は未実施。ローカルChromiumのsocket制約・cloud browserのfile URL制約を回避していない。公開承認後に既存CI/正規Previewで確認が必要。新workflowは追加していない。

ローカル案への明示承認後、PR187へ反映する。PR188の共通ロゴ差替えとimg/logo.svg/test/gwlogo.mjsは同一で重複するため、将来統合時に二重適用しない。PR188は閉じず変更しない。新workflow/権限追加なし。本番マージ・反映なし。
