# PRから自社サイト公開・反映確認まで（承認前の実装案）

基準：MF main `84d7f352b57f2e5371a48cea3bf221b107a4baaf`。
公開先の既存実装確認：8grp-site `70228844214356dc97d15d3c5872321bd726fe64`。
**この変更はローカル実装です。本番コード・SQL・環境設定は未反映、顧客原稿は公開していません。**

## 今回できるようにする範囲

1. MarketingでPRを下書き保存し、プレビュー後に社内本登録する（従来どおり、公開しない）。
2. 本登録した原稿の下に「自社サイトへの公開と結果確認」を表示する。
3. 自社サイト用のタイトル・概要・本文と公開先URL、公開される問い合わせ先を確認する。
4. 明示的な一般公開の同意にチェックし「確認した内容で自社サイトへ公開を依頼」を押す。
5. 同じDBにある既存 `news_articles` へ一度だけ登録し「サイト反映待ち（毎朝8時JSTの定時同期）」とする。
6. 既存8grp-siteのnews-syncが公開行をHTML化して配信する。**同期は起動・改変しない。即時反映ではない。**
7. 「公開ページの反映を確認」で現在の原本と公開HTMLを照合する。一致した場合だけ「公開ページの内容一致を確認済み」と日時を表示する。

現在の原本が未公開・未来日・内容変更の場合、古いHTMLが残っていても成功にしない。404、アクセス失敗、本文・概要不一致も未確認とする。
登録した本人のPRのみ対象。他人の社内原稿を新たに閲覧できるようにはしない。担当者の別人への公開引継ぎ機能は今回含めない。

## 公開されるもの／されないもの

- **公開**：8grp.co.jpの固定URLの記事、ニュース一覧、トップ新着。タイトル、概要、本文、本文に含む会社所在地・担当者名・電話番号・メールアドレス・画像説明。公開URLには原稿UUID由来の固定識別子を含む（認証情報ではない）。既存公開記事表は匿名読取可能なため作成者の内部アカウントIDを置かず `Marketing PR` とし、実操作ユーザーは非公開の記録に保持する。
- **既存同期による付随動作**：設定されていればSlack新規公開通知。MFの新APIから直接Slackを送らないが、通知が絶対に無いとはしない。
- **含まない**：画像本体アップロード、PR TIMES投稿、SNS/メール自動配信、YouTube掲載、8sp/Mugenへの展開、GA4/SNS/メール成果データ接続。
- 画像説明がある場合も文字のみ。画像を公開したと誤認しないため、確認画面に明記する。

## 既存公開経路の実根拠

- `8grp-site/8/zimu/news/articles.sql`：`news_articles` はtenant_idのない共通表。既存RLS/グラントは変更しない。
- `8grp-site/scripts/news-sync/sync.py`：portal行を読取、`/news/<slug>/`へcanonical・escapedタイトル/概要・body_htmlを生成する。
- `.github/workflows/news-sync.yml`：毎日JST08:00。portalのみでもNotionの既存接続が必要。SSH/FTPS等の既存配信設定に依存する。
- 既存portal記事 `https://8grp.co.jp/news/blog-vol166/` の公開HTMLを読み取り、経路の存在を確認した。**今回の新PRの本番公開テストではない。**
- 固定SHAのworkflow run取得は空結果／actions endpoint非対応。最近のrun成功や既存secretの有効性を独立に確認したとはしない。

## 有効化前に必要な手動承認・確認

1. 対象Supabaseプロジェクトが既存自社サイトのDBであること、`news_articles` とPR原本表の存在、既存news-syncの定時実行・配信先・Notion/SSH/FTPS接続を担当者が確認する。キーの値は共有しない。
2. 必要なら既存 `db/proposal_marketing_pr_drafts.sql` の適用状況を管理者が確認する。未適用なら別途承認後に適用する。
3. 新 `db/proposal_marketing_site_publication.sql` をレビューし、承認後に管理者が対象DBへ手動適用する。この作業では実行しない。
4. `db/check_proposal_marketing_site_publication.sql` を管理者が実行し、新表RLS、browser権限拒否、service_role最小権限、9引数RPC、既存target権限を確認する。falseなら機能を有効にせず既存構成を調べる。自動GRANTで直さない。
5. 既存サイトを所有するテナントUUIDを管理者が確認し、MFサーバ環境変数 `MARKETING_SITE_PUBLISH_TENANT_ID` に設定する。**既定未設定＝公開停止**。ユーザー入力や所属から自動推定しない。他テナントの管理者にも開放しない。設定値はsecretそのものではないが新しい公開能力を有効化するため明示承認が必要。
6. コードの公開・デプロイは別途承認後。既存site-newsと同じ管理者/ownerかつMarketing権限、原稿作成本人だけが操作できる。
7. 公開対象の原稿・表示される連絡先・画像なし・公開先・付随通知を担当者が承認してから初回公開を行う。架空テスト原稿を本番へ無断掲載しない。
8. 定時同期後、公開URLの実内容一致を確認して初回運用を受け入れる。準備不足・同期待ちを「完成／公開済み」と扱わない。

## 保護と失敗時の扱い

- 保存・本登録・プレビューGETから公開処理は呼ばない。別POSTで `confirmed:true` と最新version/preview hash必須。
- RPCはservice_roleのみ、SECURITY INVOKER。元原稿の本人・tenant・registered・version・payloadをロック下で検証する。
- 記事と公開記録は同一transaction。重複実行は同一記録を返し、競合・既存slugは上書きしない。snapshotは確認日時/結果以外更新・削除不可。
- 新記事には既存SQLのグローバル記事表を使う。別の公開データベース・資格情報・配信APIを追加しない。
- 公開確認は固定 `https://8grp.co.jp/news/press-mkt-<32桁hex>/` だけGET。リダイレクト拒否、8秒timeout、2MiB上限。入力URLや任意HTMLを外部へ送らない。
- 現在の原本と保存snapshot、公開canonical・h1・概要・rn-body全文を照合しnoindexも拒否。確認前後に原本を再読する。
- 結果不明では再取得する。冪等性があるからと確認せず連打しない。
- 記事へのFK RESTRICTで公開証跡を保持するため、今回の公開記録に結びついた記事の既存削除は拒否される。内容訂正や公開停止は既存サイト管理の承認済み手順で行い、静的サイトへの反映も確認する。
- 緊急停止は対象tenant設定を無効にすることで新規依頼を止める。既存記事・静的ページは自動削除しない。SQL/記録の削除や既存記事の一括変更をロールバックとして行わない。

## テストの範囲

`test/marketingsitepublicationapi.mjs` は実PR save/register handlerから公開handler・HTML確認までをメモリDBと合成HTTPで通す。実SQLtransactionは `test/sql/marketingsitepublication.mjs` の隔離PGliteで別途検証する。
`test/marketingsitepublicationui.mjs` は実UI controllerのDOM VM検証。実ブラウザの見た目や本番DBを検証したものではない。
実ブラウザは既知のChromium socket制限を迂回せず未実行。顧客メール、外部投稿、workflow dispatch、本番SQLは一切実行しない。
