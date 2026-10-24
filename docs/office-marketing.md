# Office：マーケティング（問い合わせ対応と制作予定）

2026-10-24。確認用の実装。**本番未反映・SQL未適用・自動取込なし・実送信なし。**
2026-10-24（後半）：各事業の問い合わせ・予約を、**原本のDBを本人の権限で直接読む**形で画面内に出すように変えた（リンクで飛ばすだけにしない）。
指示書：CLAUDE_OFFICE_MARKETING_INTEGRATED_20261024.md

## 入口と権限

- 共通ヘッダーの「マーケティング」（採用HR｜Sales｜Office｜**マーケティング**｜経営。狭い画面では「マーケ」）と、
  Office のメニューの最後のグループ「マーケティング」。行き先は `/office/marketing.html`
  - 対応が必要な業務（`?tab=work`、既定）／制作予定（`?tab=production`）。事業の絞り込みは `?biz=mugen|space|ec|site`
- Office ホームの「今日やること」に、原本ごとの「対応待ち」を1行（`/api/marketing?count=1`。マーケティングを使える人だけが呼ぶ）
- **入れる人：経営者か、メンバー管理の「使える業務」でマーケティングを付けた人だけ**（lib/gw.js `canAccessMarketing`）
  - Office の権限（人事・労務／経理・事務／月末月初業務・会計の管理者）があるだけでは入れない
  - ヘッダー・Office のメニュー・Office ホーム・画面・API（`/api/marketing` の GET/POST とも 403）が同じ判定 `access.marketing` を使う
  - メンバー管理の「使える業務」のボタンは 採用HR / Sales / Office / マーケティング / 経営 の5つ（`admin-members.html`・一括登録の列も）
  - 保存先は既存の `gw_app_grants`。ただし db/119 の許可キーに marketing が無いので、
    **提案SQL `db/proposal_app_grants_marketing.sql` を適用するまでは付けられない**。付けようとすると API が 409 `marketing_not_ready` を返し、
    画面はボタンを止めて理由を出す（黙って失敗しない）
  - 前の版の /api/me（access.marketing が無い）を覚えている画面では、マーケティングを出さない（入れない側に倒す）
- 中に入っても、原本ごとに原本の権限をもう一度確かめる（下の表の「必要な権限」）

## 原本と接続の状態（2026-10-24 調査・実装）

### MF本番の接続先（Supabase）

- 本番：`https://mf.8grp.co.jp`（`.github/workflows/agent-build.yml` の既定・各 docs）。Vercel の本番デプロイは main d84ec89
  （GitHub のデプロイ記録 `https://mf-qrg718x9u-eight-s-projects.vercel.app`）
- `gw.8grp.co.jp` も同じアプリの API の住所として使われている（社員のメールのドメインでもある）：
  会社LP（8grp.co.jp/lp）→ `https://gw.8grp.co.jp/api/sales/lp-lead`、採用メールの GAS → `/api/hr/inbox-ingest`（docs）、
  dx.enger → GW の営業連携の例（`GW_SALES_BASE_URL`）。`mf.8grp.co.jp` は端末エージェント・拡張（許可先は mf だけ）・
  Google 連携の戻り先（既定）・端末登録の URL。どちらのドメインがどの Vercel プロジェクトを指すかは**未確認**
  （確かめ方：両方の `/api/health` の `assetVersion` と `/api/public-config` の `supabaseUrl` のホスト名を見比べる）
- 共用（`htglvascsuqkixpmclwr`）を示す根拠：
  - MF は日報の中核でタイムカードの表 `tc_nippo`（db/000 のコメント「1年以上ぶんの日報が入っている」）を読み、列も足している。
    タイムカード（8grp-site `8/timecard/index.html`）の接続先は `htglvascsuqkixpmclwr`
  - MF は LMS の `profiles`（approval_status・suspended_at）と `tc_profiles` を読む（`api/employees/retire-case.js`・`onboard.js`）
  - `db/021` のコメント「この Supabase は LMS・事務ポータル・ENGER と共用」、`docs/accounts.md`（auth.users は1つ）
- 別（`vuqzsuhwuznclqxxtgfn`）を示す記載：`.env.example`・`docs/SETUP_APP.md`・`docs/sales-proposals.md`（dx.enger の docs も同じ）
- → コードの動きからは共用の可能性が高いが、**本番の値は未確認**。確かめ方（どれか1つ。秘密値は見ない）：
  1. `https://mf.8grp.co.jp/api/public-config` を開き、`supabaseUrl` のホスト名だけを見る（anon key は公開値だが、報告には載せない）
  2. Vercel の mf プロジェクトの Environment Variables で `SUPABASE_URL`（Production と Preview の両方）を見る
  3. この作業環境のネットワーク設定で `mf.8grp.co.jp` と `*.vercel.app` を許可すれば、こちらで 1 を読める
- 別プロジェクトだった場合は、下の「既存の仕組みで接続」はすべて「未連携」と出る（0件にはならない）
### 対応が必要な業務

接続のしかた：**MF に新しい鍵・権限を足さない。** API は、ログインしている本人のトークン（JWT）で各事業の既存の関数・表（RLS）を読む。
先に各事業の権限関数（`space_is_staff`・`is_lms_staff`・`zimu_is_admin`）を呼んで、権限が無いときは「権限なし」と出す（RLS の空の結果を 0件と見せない）。
関数・表が無い（別プロジェクト・未適用）ときは「未連携」、それ以外の失敗は「取得できませんでした」。

| 事業 | 原本 | 取得 | 必要な権限（本人） | 画面内でできること | 足りないもの |
|---|---|---|---|---|---|
| 無限道場 | 無料カウンセリング／お問い合わせ（採用HRの無限道場リード `gw_hr_applicants`） | **既存の仕組みで接続**（MF 採用HR） | 採用HR | 一覧・詳細（送信者・原文・最近の記録・担当・次のアクション）・既読・**返信（確認の窓・二重送信防止）**・次のアクション | 法人研修・自治体の相談はフォームで区別できない |
| 無限道場 | 講座の受講申込 `lms.course_applications` | **既存の仕組みで接続**（本人の権限で読む） | 無限道場の講師・管理者（`is_lms_staff`） | 一覧・詳細（申込者・講座・人数・状態・運営メモ）・既読 | **読むだけ**（状態を変える既存の関数・画面が無い）。担当・期限・履歴は原本に無い |
| スペース | 問い合わせ・予約（`rental_records`・`space_bookings`。8sp の既存関数） | **既存の仕組みで接続**（本人の権限で 8sp の関数を呼ぶ） | 8sp の事務権限（`space_is_staff`） | 一覧（未完了＋60日以内に完了）・詳細（送信者・本文・**予約**・**対応履歴**（イベント・メモ・送信ログ）・担当）・既読・メモ追加・完了／再開・**仮予約の承認／却下**（8sp の `space_admin_decide_booking`。仮予約でなければ 409、二重予約は 8sp 側で止まる） | **返信**：8sp のメールAPI（compose→確認→send-draft）を使う作りは済み。`SPACE_MAIL_API_URL`（秘密ではない URL）が未設定のため、いまは押せない。期限は原本に無い。受信箱（SQL48/49）・予約の進み（SQL50）は未適用で含めていない |
| 自社サイト | 会社HPのお問い合わせ（`contact_submissions` のうち送信元 `8grp_lp` だけ。8grp.co.jp のお問い合わせ・採用・AI開発・LP） | **既存の仕組みで接続**（本人の権限で読む） | 事務の共有アカウント（`zimu_is_admin`） | 一覧・詳細（送信者・本文・状態・担当メモ）・既読・状態と担当メモの更新（読んだときの更新日時と比べて、他の人の更新を上書きしない） | **事務の共有アカウント以外は読めない**（「残り」の2）。返信の既存の仕組みが無い |
| EC | 問い合わせ（同じ `contact_submissions` の 8ec.jp の送信元） | **保留**（2026-10-24。今回の連携では後回し） | — | 出さない（件数も出さない＝0件と書かない） | 作りは残してある（`lib/marketing.js` の `hold` を外すと再開） |
| EC | 注文・発送 | **保留** | — | 同上 | 注文の原本（楽天受注・在庫・Stripe・旧台帳）のどれを正とするかの決定 |

**会社HPだけを取り出す（EC と同じ表なので）**
- 一覧・詳細・更新・既読のどれも、DB への問い合わせに「送信元が `8grp_lp`」の条件を付ける。EC の行は**DB から取り出さない**
- 詳細・既読・更新で EC の行の ID を指しても、会社HPの鍵では「無い」（404）、EC の鍵では「保留」（409）。EC の行は書き換えない
- テスト（`test/marketingsourcesapi.mjs`）：DB が返した行の送信元を全部記録し、`8grp_lp` 以外が1行も無いことを確かめている
  （条件を外すと落ちることも確かめた）。EC の行が1文字も変わらず、既読も付かないこと、画面に EC の行・件数・操作ボタンが出ないこと（`test/ui/marketingui.mjs`）

- 送信元が不明な問い合わせ（どの事業か決められない `source`）は一覧に出さず、件数だけ出す
- 未連携・権限なし・取得失敗の原本は、件数を出さない（0件と書かない）。理由と「接続に必要なこと」を出す

### 制作予定

| 事業 | 原本 | 状態 |
|---|---|---|
| 自社サイト | お知らせ・コラム（`news_articles`、既存の api/site-news と同じ権限＝管理者・経営者） | **接続済み**（下書き・公開予定・30日以内の公開済み） |
| 共通 | この画面で登録する企画（`gw_marketing_items`） | **SQL未適用**（未準備と表示。追加ボタンは押せない） |
| 無限道場 | コラム・SNS文案（投稿URLの記録あり）・YouTube動画（`lms.mgn_*`） | 未連携（問い合わせ集約の次） |
| 自社サイト | メディア記事・SNS投稿（`marke_articles`・`marke_sns_posts`） | 未連携 |
| スペース | お知らせ・コラム・SNS文案（`space_articles`・`space_article_social`） | 未連携 |
| EC | SNS文案（`ec_sns_posts`）・コラム（PRで追加） | 未連携 |
## 見るだけでは何も変えない

- `GET /api/marketing`（一覧・詳細・件数・制作予定）は読むだけ。既読化・状態更新・送信・予定作成をしない（`test/marketingapi.mjs` で DB への書き込みが0件であることを確かめている）
- 既読は「既読にする」を押したときだけ。既読と対応状態は別（既読にしても対応待ちのまま）
- 新着＝受付から24時間以内（原本の受付日時から計算。保存しない）
- 一覧に連絡先（メール・電話）を載せない。詳細を開いたときに、権限を確かめてから取る。`Cache-Control: no-store`

## 返信・状態更新（各事業の既存の処理を使う）

| 原本 | 操作 | 使う処理 | 安全策 |
|---|---|---|---|
| 無限道場リード | 返信 | 採用HRの `GET/POST /api/hr/applicants/mail`（既存） | 宛先・送信元・返信先・件名・本文を確認の窓で出す。requestKey で二重送信を防ぐ。結果は sent／duplicate／unknown を分ける |
| 無限道場リード | 次のアクション | 採用HRの `PATCH /api/hr/applicants/detail` action=leadNextAction（既存） | 確認の窓。採用HRの記録・監査ログに残る |
| スペース | メモ・完了・再開 | 8sp の `space_add_inquiry_note`・`space_set_inquiry_done`・`space_reopen_inquiry` | 本人の権限で呼ぶ（8sp の事務権限が無ければ 8sp 側で拒否） |
| スペース | 仮予約の承認／却下 | 8sp の `space_admin_decide_booking` | お問い合わせに紐づく予約だけ。仮予約でなければ 409（二度押し・他の人の先行を止める）。却下は理由必須。重なりは 8sp 側の判定 |
| スペース | 返信 | 8sp のメールAPI（compose → 確認 → send-draft）。本人のトークンをそのまま渡す | 宛先は 8sp の DB から（画面で書き換えない）。送信前に宛先・送信元・件名・本文を確認の窓で出し、`confirmed: true` が無ければ送らない。8sp 側の claim で二重送信を防ぐ。時間切れは「送れたか不明」（202）と出し、成功にしない。**`SPACE_MAIL_API_URL` 未設定のいまは押せない** |
| 会社HP | 状態・担当メモ | `contact_submissions` の update（既存の RLS。事務の共有アカウントだけ）。条件に送信元 `8grp_lp` を付ける | 読んだときの更新日時と一致するときだけ更新（他の人の変更を上書きしない。ずれたら 409）。EC の行は書き換えない |
| 受講申込 | — | （既存の更新処理が無いので、読むだけ） | — |

- 書き込みは監査ログ（`gwLog`）に操作・原本の種類と ID だけを残す（本文・連絡先は残さない）
- 注意：無限道場リードの返信欄を開くと、採用HRの既存の挙動で、標準のメールひな型が無ければ作られる
- 実メールの試験送信・実データの更新はしていない（テストは偽のサーバ・偽のDB）
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

- `test/marketingapi.mjs`：入口（Office の権限だけでは 403）・権限なし・未連携・テナント境界・GETで書かない・既読と対応状態・個人情報の歯止め・版比較・YouTube
- `test/marketingsourcesapi.mjs`：偽の 8sp・無限道場・問い合わせの表（RLS と関数を再現）と偽の 8sp メールAPIで、
  一覧・詳細（予約・履歴）・メモ・完了・再開・仮予約の承認／却下（二重予約・決定済みは 409）・返信（確認なしは送らない・時間切れは不明）・
  権限なし（0件と見せない）・未連携・受講申込は読むだけ・問い合わせの更新の上書き防止・既読
- `test/ui/marketingui.mjs`：ブラウザ（1280px・390px）。全原本が取れたとき／権限なし／未連携／取得失敗、開いただけで書かない、返信の確認、仮予約の承認、Office ホーム、権限（付けた人だけ）
- ヘッダー・Office のメニュー・メンバー管理のテスト：マーケティングは経営者と「使える業務」で付けた人だけに出ること、
  メンバー管理のボタンが5つで、390px でも押せる大きさで画面に収まること

## 会社HPの問い合わせ：担当者単位の権限案（提案・未実装・未適用。EC は保留中なので範囲は会社HPだけ）

方針：共有アカウント（zimu）の使い回しも、管理用の鍵（service_role）で広く読む方式も取らない。
**本人のログイン（auth.uid()）から、その人が扱ってよい問い合わせだけを返す口**を作る。

### いまの原本（調査の結果）
- 表 `contact_submissions`（作る SQL は 8ec `admin/contact/supabase-setup.sql`）：
  source・inquiry_type・name・company・email・phone・message・status（未対応/対応中/対応済。制約なし）・staff_memo（1本）・created_at・updated_at
- 担当者の列・対応履歴の表は**無い**。updated_at は画面が手で入れる（トリガーなし）
- RLS のポリシーは1本だけ：`contact admin all`（authenticated、`zimu_is_admin()` ＝ JWT のメールが zimu@8grp.co.jp）
- 8grp-site の決まり：「Enger 側の表なので RLS ポリシーには手を触れない」「列は足さず、外部キーは張らない」
  （前例：横に1対1の表 `contact_attributions`。submission_id を外部キーなしで持つ）
- 送信元：8grp.co.jp は `8grp_lp`（お問い合わせ・採用・AI開発・LP。inquiry_type で分かれる）、
  8ec.jp は top / pc / cloud / ai-dev / company / buy / general。Enger の LP も同じ表に入るとの記載あり（経路は未確認）

### 案（原本の表・ポリシー・列には触れない）

| 部品 | 置き場所 | 中身 |
|---|---|---|
| 扱える範囲 | MF：`gw_marketing_scopes`（新） | 社員ごとに「会社HPの問い合わせ」を付ける（EC は保留。再開したら「EC の問い合わせ」を足す）。役割は「担当」か「振り分け（範囲の全件を見て担当を決める）」。メンバー管理の「使える業務」のマーケティングの中で付け外しする |
| 担当・次の対応・期限 | MF：`gw_contact_assignments`（新） | 問い合わせID（外部キーなし）ごとに 担当（社員）・次の対応・期限・版 |
| 対応履歴 | MF：`gw_contact_events`（新・追記だけ） | 誰が・いつ・何をした（担当変更・状態・メモ）。本文・連絡先は写さない |
| 読む口 | 共有DBの関数（security definer、anon から外し authenticated だけ） | `contact_inbox_list(範囲)`：本人の範囲の中で「未割り当て＋自分の担当」だけ（振り分け役は範囲の全件）。一覧に連絡先は出さない<br>`contact_inbox_detail(id)`：本文は範囲内なら見える。**メール・電話は担当者と振り分け役だけ** |
| 書く口 | 同上 | `contact_inbox_assign(id, 担当)`：振り分け役だけ<br>`contact_inbox_update(id, 状態, メモ, 読んだときの updated_at)`：担当者と振り分け役だけ。ずれていたら止める（他の人の更新を上書きしない）。履歴に1行足す |

- 判定は毎回：本人 → `gw_employees`（在籍中だけ。退職すると自動で外れる）→ マーケティングの利用権限 → 範囲 → 担当
- MF の API は本人のトークンで上の関数を呼ぶだけ（service_role で原本を読まない）
- zimu の管理画面（8ec.jp/admin/contact）はそのまま使える（ポリシーを変えないので影響なし）

### 段階
1. **読むだけ＋担当の記録**：list / detail / assign と MF 側の3つの表。原本の行は書き換えない
   （状態・メモの更新は、これまでどおり zimu の管理画面で）
2. **状態・メモの書き込み**：`contact_inbox_update` が原本の status・staff_memo を更新する。
   原本の持ち主（8ec・Enger）の承認が要る（ポリシーは変えないが、関数が原本の行を書くため）

### 承認が要ること
- 範囲の持ち方（MF のメンバー管理で付ける、でよいか）
- 段階1の SQL（MF の提案SQL。担当・履歴の表と、原本を読むだけの関数）
- 段階2：原本の持ち主の承認
- 別件（触っていない）：本番の観察記録では contact_submissions に anon の SELECT/UPDATE/DELETE 権限が付いている
  （ポリシーが authenticated だけなので RLS で止まっている）。外すかどうかは原本の持ち主の判断

### 分かっていないこと
- 本番の列構成（8grp-site のコメントでは基本の列だけ）・Enger の LP の書き込み経路・agent.enger.jp（受信箱）がこの表をどう使っているか

## 実データの読み取り検証（読むだけ。書き込み・送信をしない）

本番のデータを、**画面を開いて読むだけ**で確かめる手順。押してよいのは「開く」「絞り込み」「詳細を開く」だけ。

### 前提
- このブランチの Preview があること（push の承認が要る）。URL は推測せず、GitHub のデプロイ記録（コミットの Deployments）から取る
- Preview と本番が同じ Supabase を見ているか：Preview の `/api/public-config` と `https://mf.8grp.co.jp/api/public-config` の
  `supabaseUrl` のホスト名が同じこと（違えば、Preview では本番のデータを読めない。そこで止める）
- 検証する人：経営者（マーケティングの付与SQLが未適用でも入れる）。各原本の権限（8sp の事務・無限道場の講師/管理者・zimu）を
  その人が持っているかで、出る結果が変わる（持っていなければ「権限なし」と出るのが正しい）

### 手順
1. `/office/marketing.html` を開く。原本ごとの行の状態（取得済み／権限なし／未連携／取得できませんでした）を記録する
2. 「取得済み」の原本ごとに、件数（対応待ち）を、原本の管理画面の件数と見比べる
   - 無限道場リード：採用HR `/hr/applicants.html?category=mugendojo`
   - 受講申込：無限道場の管理画面（受講申込）
   - スペース：8sp 事務画面のお問い合わせ（未完了）
   - 会社HP：お問い合わせ管理（zimu）で、送信元 8grp_lp の行だけと比べる（EC は保留なので比べない）
3. 各原本から2〜3件の詳細を開き、送信者・本文・予約（スペース）・対応履歴・担当が原本と一致するかを見る
4. **押さない**：既読にする／メモ／完了・再開／仮予約の承認・却下／返信（返信欄を開くだけでも、採用HRの既存の挙動で
   メールひな型が作られることがある）／状態・メモの更新／制作予定の追加
5. 書いていないことの確認：検証の前後で、MF の操作記録（`gw_activity_log`）・8sp の `space_inquiry_events`・`space_inquiry_notes`・
   `space_mail_log`・`contact_submissions.updated_at` が増えていない／変わっていないこと（読むだけの SQL で件数・最大日時を見る）
6. 権限の確認：マーケティングを付けていない社員で開き、ヘッダーに出ないこと・`/api/marketing` が 403 になること
7. 記録：原本ごとに「状態・件数（画面／原本）・詳細の一致・食い違い」を残す。食い違いは画面を直さず原因を調べる

確かめ用の SQL（読むだけ。検証の前と後に1回ずつ流し、数字が同じことを見る。表が無い環境ではその行を外す）：

```sql
select 'gw_activity_log' as t, count(*) as n, max(ts) as last_at from public.gw_activity_log
union all select 'space_inquiry_events', count(*), max(at) from public.space_inquiry_events
union all select 'space_inquiry_notes', count(*), max(at) from public.space_inquiry_notes
union all select 'space_mail_log', count(*), max(at) from public.space_mail_log
union all select 'rental_records(updated)', count(*), max(updated_at) from public.rental_records
union all select 'space_bookings(updated)', count(*), max(updated_at) from public.space_bookings
union all select 'contact_submissions(updated)', count(*), max(updated_at) from public.contact_submissions;
```

### 0件の扱い
- 「取得済み・0件」は、原本を読めて対応待ちが0件という意味。「権限なし」「未連携」「取得できませんでした」は件数を出さない

## 残り（承認が要るもの）

| # | 対象 | 何のため | 種類 |
|---|---|---|---|
| 1 | 本番の MF の Supabase プロジェクトの確認 | 共用なら上の「既存の仕組みで接続」がそのまま動く。別なら全部「未連携」 | 確認だけ（`mf.8grp.co.jp` と `gw.8grp.co.jp` の両方で `/api/public-config` を見る、または作業環境のネットワークで両方を許可） |
| 2 | 会社HPの問い合わせを、担当者ごとに必要なものだけ扱えるようにする（EC は保留） | いまは zimu でログインした人しか読めない | 上の「担当者単位の権限案」。共有アカウント・管理用の鍵では読まない。範囲の持ち方・段階1の提案SQL・段階2の原本の持ち主の承認 |
| 3 | `SPACE_MAIL_API_URL`（MF の環境変数。8sp の送信APIの URL。秘密値ではない） | スペースの返信を画面内から送る | 設定の追加（鍵は増えない。本人のトークンを渡す） |
| 4 | `db/proposal_app_grants_marketing.sql` | メンバーごとに「マーケティング」を付けられるようにする（db/119 の許可キーに marketing を足す） | SQL適用 |
| 5 | `db/proposal_marketing.sql` | 人ごとの既読・制作予定・動画の掲載記録 | SQL適用（未適用のあいだは既読「確認できません」・制作予定「未準備」） |
| 6 | EC（問い合わせ・注文・発送）の再開 | 今回は保留。ほかの公開は EC を待たない | 再開の判断（注文の原本の決定を含む） |
| 7 | 8sp の受信箱（SQL48・49）と、予約〜入金の進み具合（SQL50） | 予約媒体のメール・予約の進み具合も同じ画面に | 別々の承認。48・49 は PR47（handoff/inbound-mail）、50 は claude/new-session-ubsged（Stripe の修正と一緒にマージされている）。互いの順番の決まりは無い |
| 8 | 掲載先サイトのアダプタ（CSP・本文の掃除・同期の変更） | 既存の YouTube 動画を各サイトに載せる | 各サイトのリポジトリの変更（問い合わせ集約の次） |
