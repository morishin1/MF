# Office：マーケティング（問い合わせ対応と制作予定）

2026-10-24。確認用の実装。**本番未反映・SQL未適用・自動取込なし・実送信なし。**
指示書：CLAUDE_OFFICE_MARKETING_INTEGRATED_20261024.md

## 入口

- Office のメニューに「マーケティング」（`/office/marketing.html`）。ダッシュボードは増やしていない（1画面に2つのタブ）
  - 対応が必要な業務（`?tab=work`、既定）
  - 制作予定（`?tab=production`）
  - 事業の絞り込みは `?biz=mugen|space|ec|site`
- Office ホームの「今日やること」に、同じ原本の「対応待ち」を原本ごとに1行（`/api/marketing?count=1`）
- 共通ヘッダーにも「マーケティング」（採用HR｜Sales｜Office｜**マーケティング**｜経営。狭い画面では「マーケ」）。2026-10-24 に追加
- 入れる人は、サーバの判定 `access.marketing`（lib/gw.js `canAccessMarketing`）ただ1つ。ヘッダー・Office のメニュー・画面・API が同じ判定を使う
  - いまは Office に入れる人と同じ（人事・労務／経理・事務／月末月初業務のどれか。経営者・会計の管理者を含む）
  - 専用の利用権限（メンバー管理の「使える業務」の marketing）は、db/119 の許可キーを広げる提案SQL（claude/member-bulk-ux-20261024 の
    `db/proposal_app_grants_marketing.sql`）の承認・適用のあとで、`canAccessMarketing` に `hasApp(ctx, "marketing")` を足す
  - 前の版の /api/me（access.marketing が無い）を覚えている画面では、Office に入れる人と同じに扱う（中身は API が確かめる）
- 中の原本ごとに、原本の権限をサーバで確かめる

## 原本と接続の状態（2026-10-24 調査）

### 対応が必要な業務

| 事業 | 原本 | 状態 | Office での操作 |
|---|---|---|---|
| 無限道場 | 無料カウンセリング／お問い合わせ（採用HRの無限道場リード `gw_hr_applicants` lead_category=mugendojo） | **接続済み**（採用HRの権限 canRecruit） | 一覧・詳細（原文・連絡先・最近の記録）・既読・返信・次のアクション |
| 無限道場 | 講座の受講申込（個人・法人）`lms.course_applications` | 未連携 | 原本リンクのみ |
| スペース | 問い合わせ・予約（`rental_records`・`space_bookings`・受信箱 SQL48/49・予約フロー SQL50） | 未連携 | 原本リンクのみ |
| EC | 注文・発送（楽天受注・在庫・Stripe・旧台帳に分かれる） | 未連携 | 原本リンクのみ |
| EC | 問い合わせ（`contact_submissions`） | 未連携 | 原本リンクのみ |
| 自社サイト | 会社HPのお問い合わせ（`contact_submissions` source=8grp_lp） | 未連携 | 原本リンクのみ |

未連携の原本は、画面で「未連携」と出し、件数は出さない（0件と書かない）。「接続に必要なこと」「原本に無い項目」を折りたたみで出す。

### 制作予定

| 事業 | 原本 | 状態 |
|---|---|---|
| 自社サイト | お知らせ・コラム（`news_articles`、既存の api/site-news と同じ権限＝管理者・経営者） | **接続済み**（下書き・公開予定・30日以内の公開済み） |
| 共通 | この画面で登録する企画（`gw_marketing_items`） | **SQL未適用**（未準備と表示。追加ボタンは押せない） |
| 無限道場 | コラム・SNS文案（投稿URLの記録あり）・YouTube動画（`lms.mgn_*`） | 未連携 |
| 自社サイト | メディア記事・SNS投稿（`marke_articles`・`marke_sns_posts`） | 未連携 |
| スペース | お知らせ・コラム・SNS文案（`space_articles`・`space_article_social`） | 未連携 |
| EC | SNS文案（`ec_sns_posts`）・コラム（PRで追加） | 未連携 |

### 接続できない理由（共通）

- 無限道場・スペース・EC・事務ポータルは Supabase `htglvascsuqkixpmclwr`。MF の設定書（`.env.example`・`docs/SETUP_APP.md`）は別プロジェクト `vuqzsuhwuznclqxxtgfn` だが、
  `db/021`・`db/069` のコメントと `api/site-news`（`news_articles` を直接書く）は「共用」を前提にしている。**本番の MF がどちらに接続しているか未確認**（Vercel の `SUPABASE_URL` を見れば分かる）
- どちらの場合も、各事業の事務用の関数は事務ログイン（JWT）でしか読めない。サーバ同士で読むには、読むだけの関数か署名付きAPIと、その鍵が要る
- **新しい鍵の発行・権限の付与は今回の範囲外**（指示書 §4）。接続は個別の承認のあと

## 見るだけでは何も変えない

- `GET /api/marketing`（一覧・詳細・件数・制作予定）は読むだけ。既読化・状態更新・送信・予定作成をしない（`test/marketingapi.mjs` で DB への書き込みが0件であることを確かめている）
- 既読は「既読にする」を押したときだけ。既読と対応状態は別（既読にしても対応待ちのまま）
- 新着＝受付から24時間以内（原本の受付日時から計算。保存しない）
- 一覧に連絡先（メール・電話）を載せない。詳細を開いたときに、権限を確かめてから取る。`Cache-Control: no-store`

## 返信・状態更新（既存の機能を使う）

| 操作 | 使う API | 安全策 |
|---|---|---|
| 返信 | 採用HRの `GET/POST /api/hr/applicants/mail`（既存） | 宛先・送信元・返信先・件名・本文を確認の窓で出す。送信の鍵（requestKey）で二重送信を防ぐ。結果は sent／duplicate／unknown を分けて出す |
| 次のアクション | 採用HRの `PATCH /api/hr/applicants/detail` action=leadNextAction（既存） | 変更前の確認の窓。採用HRの選考の記録・監査ログに残る |

注意：返信欄を開くと、採用HRの既存の挙動で、標準のメールひな型が無ければ作られる（採用HRで送信画面を開いたときと同じ）。

実メールの試験送信はしていない（テストは偽のサーバ）。

## 制作予定

- 状態：企画／作成中／確認待ち／公開予定／公開済み
- 原本（お知らせ）がある予定は、公開・下書きを**原本の値で見る**。原本が下書きの間だけ、制作側の「企画／作成中／確認待ち」を使う
- 公開予定日を入れても自動では公開しない。公開済みは「手で投稿したあと、公開URL（https）を記録」したときだけ
- SNS文案：文字数（X 140 等）・コピー。自動投稿はしない
- 文案にメールアドレス・電話番号らしい文字列があれば保存しない（公開用の文案に個人情報を写さない）
- もとにした問い合わせは「原本の種類＋ID」だけを持つ。氏名・本文は写さない。採用HRの権限が無い人には紐づけを見せない（件数だけ）
- 版（version）の比較つきで保存。古い画面からの上書きは 409

## YouTube（既存の動画をサイトに載せる）

1. 動画URLを貼る → 形を確かめる（watch?v= / youtu.be / shorts / embed / live。YouTube 以外・HTML は受けない）→ 動画IDだけを持つ
2. YouTube の oEmbed（鍵不要）で、埋め込めるかを確かめる。公開か限定公開かは区別できないので、人が YouTube 上で確かめる
3. 掲載先（無限道場・自社サイト・スペース・EC）・位置・タイトル・説明を選ぶ → プレビュー（`youtube-nocookie.com/embed/<ID>`）
4. 「確認して掲載」：プレビューのときの内容のハッシュと一致しなければ、どのサイトにも載せず確認し直し（409）。サイトごとに結果（掲載・失敗・二重・未対応）を返し、一部失敗を全件成功にしない

**いまはどのサイトも未対応**（`lib/marketing-sites.js` のアダプタが空）。画面では掲載ボタンを押せず、理由と必要な作業を出す。

| 掲載先 | 載せるのに必要なこと |
|---|---|
| 無限道場 | 動画管理（/admin/contents/youtube）が既にある。Office から登録するには署名付きの書き込みAPIと承認 |
| 自社サイト | 8grp-site の CSP に `frame-src https://www.youtube-nocookie.com`、news-sync と本文の掃除に動画IDだけの埋め込みブロック |
| スペース | 記事の許可タグ（js/space-news.js と scripts/space-news/render.py の両方）に動画IDだけの埋め込みブロック |
| EC | コラムに動画IDだけの埋め込みブロック（PRで反映） |

YouTube へのアップロード・YouTube 上の公開設定の変更・アカウント連携はしない。

## DB（提案・未適用）

`db/proposal_marketing.sql`（戻し：`db/proposal_rollback_marketing.sql`、確かめ：`db/check_proposal_marketing.sql`）

| 表 | 中身 |
|---|---|
| `gw_marketing_reads` | 人ごとの既読（tenant・原本の種類・原本ID・user）。中身は写さない |
| `gw_marketing_items` | 制作予定（企画・担当・期限・状態・公開URL・原本の種類とID・動画ID・もとにした問い合わせのID） |
| `gw_marketing_video_placements` | 動画の掲載の確認記録（サイトごと）。有効な掲載は同じ動画・同じサイト・同じ位置で1つだけ（部分一意索引） |

- 3つとも RLS 有効・anon/authenticated の権限なし（API の service_role だけ）
- 担当は同じテナントの社員だけ・掲載記録は同じテナントの予定だけ（見張り）
- 使い捨ての PostgreSQL 16 で確認：適用・2回適用・戻し・再適用、他社の担当（拒否）、公開URLなしの公開済み（拒否）、http の URL（拒否）、二重掲載（拒否）、版の自動加算、authenticated から読めない

未適用のあいだ：既読は「確認できません」、制作予定は「未準備」（追加ボタンは押せない）。お知らせと無限道場リードは読める。

## テスト（架空データのみ）

- `test/marketingapi.mjs`：API 100件超（入口・権限なし・未連携・テナント境界・GETで書かない・既読と対応状態・個人情報の歯止め・版比較・YouTube の確認／未対応／確認し直し／一部失敗／二重掲載）
- `test/ui/marketingui.mjs`：ブラウザ（1280px・390px）。取得済み／未連携／権限なし／取得失敗／未準備の表示、開いただけで書かない、返信の確認と二度押し、次のアクション、SNS文案の文字数とコピー、公開URLの記録、YouTube プレビュー、Office ホームの今日やること
- Office のメニューのテスト（navcheck・officesplit・officehomeui・navui・officebootui・gwmenuui・officesplitui・officeunifiedui）を、5つ目のグループ「マーケティング」に合わせた
- 共通ヘッダーのテスト（accessparity・headershortcutui・keieiui）を、5つ目の近道「マーケティング」に合わせた。
  ヘッダーに5つ並ぶので、721〜900px では近道のアイコンを外す（以前は 800px 以下。css/layout.css）

## 残り（承認が要るもの）

1. 本番の MF の Supabase プロジェクトの確認（共用か別か）
2. 未連携の各原本の接続方法（読むだけの関数／署名付きAPI）と鍵の発行・権限の承認
3. `db/proposal_marketing.sql` の適用と正式な番号
4. 掲載先サイトのアダプタ（CSP・本文の掃除・同期の変更を含む。各サイトのリポジトリの変更）
5. マーケティング専用の利用権限（Office に入れない人に、マーケティングだけを付ける）。DB119 の許可キーの変更（提案SQL）の承認が要る
