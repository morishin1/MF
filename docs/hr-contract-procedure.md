# 採用HR：契約手続き（社労士への作成依頼・正式PDF・本人同意・LegalSign・Office 引き渡し）

要件「HR：社労士連携・条件通知・本人同意・LegalSign契約管理 改善要件（2026-10-19）」の P0 をここで実装した。

- 画面：応募者詳細の［書類］タブ先頭の「契約手続き」カード（`hr/applicants.html`）。操作マニュアルは `guide-hr-office.html#hr-contract`
- API：`api/hr/offers/contract.js`（新規）、`api/hr/offers/index.js`（送る・URL発行・引き渡しの確かめ）、`api/hr/applicants/{detail,index}.js`（状態の言い方）
- 決まりごと：`lib/hr-contract.js`（流れ・依頼文・7ステップ・照合・入力の確かめ）、`lib/hr-contract-db.js`（一覧・詳細でまとめて読む）
- DB：`db/139_hr_contract_procedure.sql`（確認 `db/check_139_hr_contract_procedure.sql`・戻す `db/rollback_139_hr_contract_procedure.sql`）
- テスト：`test/hrcontractapi.mjs`・`test/ui/hrcontractui.mjs`・`test/sql/139_hr_contract_procedure.sql`

> **状態**：コードとテストは揃っているが、**本番の DB（db/139）は未適用・本番の動作は未確認**。
> db/137 の本番適用も未確認（db/139 は 081・129・132・133・137 が前提。無ければ何も変えずに止まる）。

---

## 1. 既存の仕組みとの関係（重複させない）

| 既存（PR #102・#127 ほか） | 今回 |
|---|---|
| オファー＝`gw_hr_offers` の1行＝1つの版。条件同意（`accepted_at`）と正式契約（`formal_signed_at`）は別の列 | そのまま使う。新しい「契約済み」の列は作らない |
| 条件通知書PDF（HR が作る）を `notice_*` に固定して本人へ送る。承諾済みPDF＝その PDF＋電子承諾記録 | 正式PDFの流れでは、**承認した社労士の正式PDFを `notice_*` に固定**して送る。本人の画面・同意の記録・承諾済みPDF・Office の閲覧はそのまま同じ版を使う |
| HR の条件通知書 | 「社労士へ依頼するときの条件案」（プレビューのみ。本人へは送らない） |
| LegalSign：URL 登録 → 案内 → 「正式契約済みにする」（承諾のあとだけ） | 正式PDFの流れでは「契約手続き」カードから：承認した版を LegalSign に登録した記録 → 締結の記録（証跡が必須・同意の前でも可） |
| Office 引き渡し（API と DB の両方で確かめる） | 正式PDFの流れでは、版の照合も確かめる |
| Office 側の社労士依頼（`gw_doc_orders`。社員登録のあと） | 別物。HR の段階（応募者）での依頼は新しい表 |

### どのオファーが正式PDFの流れか（`lib/hr-contract.js docRouteOf`）

- 区分：正社員・幹部候補／パート・アルバイト／業務委託／スポット・副業（育成枠・区分なしは、これまでどおり）
- db/139 の列がある環境で、**まだ送っていない版**（送付・承諾・無効化・辞退が無い）。第2版以降は作るときに `doc_route` を入れる（空の第2版以降は db/139 の前に作った版なので、これまでどおり）。
- `doc_route` は最初の操作（依頼済みの記録・PDFの受け取り・送付）で `official` に固定され、DB が変えさせない。
- db/139 を流す前・既に送った版は、これまでどおり HR の条件通知書で進む（古い版を巻き込まない）。

## 2. 流れ・状態・担当

| # | ステップ | 主ボタン（1つ） | 状態の表示 | 次の担当 |
|---|---|---|---|---|
| ① | 条件を整理 | 条件を確認して確定する | 条件作成中 | 人事 |
| ② | 社労士に作成依頼 | 社労士への依頼文を作成 | 社労士へ依頼待ち／差し戻し（再依頼待ち） | 人事 |
| ③ | 正式PDFを受領 | 社労士作成のPDFをアップロード → PDFと条件を照合して承認 | 社労士へ依頼済み → 書類受領・確認待ち | 社労士 → 人事（照合・承認） |
| ④ | 本人へ案内 | LegalSign の登録を記録する → 内容を確認して本人へ案内 | 本人への案内準備中 → 正式版確認済み | 人事 |
| ⑤ | 本人が条件に同意 | （待つ） | 本人へ案内済み／回答期限切れ | 本人 |
| ⑥ | LegalSign正式契約 | LegalSign の締結を確かめて記録 | 正式契約待ち／正式契約済み（条件同意待ち） | 本人・人事 |
| ⑦ | Officeへ引き渡し | Officeへ引き渡す | 正式契約済み（条件同意済み）→ Office引き渡し済み | 人事 → Office |

- 状態は1つの列で前に進めない。`accepted_at`・`formal_signed_at`・`handoff_at`・受領記録・依頼記録から**毎回計算**する（`contractStateOf`）。
- 応募者一覧の「状態」と NEXT ACTION も同じ判定。NEXT ACTION のボタンは「契約手続きを開く」（書類タブでは重ねて出さない）。
- 辞退は本人の画面から（既存）。期限切れは既存の判定（再発行しても回答期限 `respond_by` は変わらない＝既存の仕様。期限を延ばす操作は今回の対象外）。

## 3. 依頼文（Slack に貼る下書き。Slack 連携は作らない）

- HR の条件（区分ごとの項目）だけで作る。空の項目は `【要確認】` にして一覧で警告（架空の値で埋めない）。
- 給与を見られない人が作ると、給与・報酬の行は伏せる（`【要確認】（給与・報酬は、権限のある担当者が記入してください）`）。
- 正社員・パート：「労働条件通知書（雇用契約書）」・依頼先「社労士」。業務委託・スポット：「業務委託契約書（条件通知書）」・依頼先「社労士・法務」。
- 差し戻しのあとは「修正をお願いしたい点」（差し戻しの理由）を先に書く。
- 画面で直して［文章をコピー］→ 担当者が Slack に貼って送る →「Slack で送りました」にチェック →［社労士へ依頼済みにする］。
  **コピーだけ・下書きを作っただけでは記録しない。**記録には日時・操作者・任意メモ・要確認のまま依頼した項目名が残る（依頼文そのものは残さない）。

## 4. 正式PDF（受領・照合・承認・ロック）

- アップロード：署名付きURL → `{tenant}/offers/{applicant}/{offer}/official-{uuid}.pdf`（private バケット `hr`）。
  `%PDF-` の中身・15MB まで・パスワード付き／壊れたPDFは断る（承諾記録のページを足せないため）。
- 受領記録：版（受領第1版…）・書類の種類・書類名・受領日・作成者・アップロードした人・SHA-256・大きさ。中身は不変（DB トリガー）。
- 照合・承認：**給与を見られる人だけ**（PDF に給与が入る）。区分ごとの照合項目すべてに✓。承認の前に保存ファイルの SHA-256 を確かめる。
  承認は条件の版ごとに1つ（DB の一意索引）。差し戻しは理由が必須。
- 本人へ案内した版は差し替えにできない（DB トリガー）。条件を変えるときは［条件を直す］（案内前だけ。案内後の条件変更は今回の対象外）。
- 正式PDFを開く・本人へ送る・本人が保存する・引き渡しの確認では、記録の SHA-256 と同じかを確かめてから使う（Storage の直接書き換え対策）。

## 5. 本人への案内・同意・正式契約・引き渡し（ゲート）

| いつ | 止めるもの（API と DB） |
|---|---|
| 本人へ送る・URLを発行する | 承認した正式PDFが無い／正式契約が要るのに LegalSign に同じ版を登録した記録が無い（例外ルートなら可）／保存ファイルのハッシュが違う／（既存）必須項目・回答期限・本文のURLタグ・二重送信 |
| 送った版 | 承認した正式PDFを `notice_*` と `official_doc_id` に固定。DB：`official_doc_id` が無いと送付済みにできない・LegalSign に登録した版と違う版は入らない |
| メール | 内定通知書（会社）＋正式PDFを添付。合計5MBを超えるときは正式PDFを添付せず、本人専用ページで確認と案内 |
| 締結の記録 | 社長・管理者・人事。証跡（何を確かめたか）必須・「本人へ案内した版と同じ」の確認必須。DB：締結した版のハッシュ＝案内した版 |
| Office 引き渡し | （既存）承諾済み・正式契約済み（要る区分）・社長/管理者/人事。（今回）承認＝案内＝同意＝LegalSign＝締結の版がすべて同じ |
| 再発行 | 同じ正式PDFを新しい版へ引き継ぐ（受領記録を写す）。本人の同意は引き継がない。LegalSign の案内・締結を記録したあとは再発行しない（`reissue_blocked`。締結の記録を黙って消さない） |

## 6. API

`/api/hr/offers/contract`（採用HR＝canRecruit。書き込みは service role で、権限と状態をここで先に確かめる）

| メソッド | 内容 | 権限 |
|---|---|---|
| `GET ?applicantId=` | カード（状態・7ステップ・主ボタン・受領記録・依頼記録・照合・条件の要約） | 採用HR（条件の給与は見られる人だけ） |
| `GET ?offerId=&draft=request[&kind=revision]` | 依頼文の下書き（送らない・記録しない） | 採用HR（給与は見られる人だけ） |
| `GET ?docId=&file=1` | 正式PDF（SHA-256 を確かめて返す） | 給与を見られる人 |
| `POST markRequested` | 依頼済みの記録 | 採用HR |
| `POST uploadUrl`・`attach` | 正式PDFの受け取り | 採用HR |
| `POST approve`・`return` | 照合して承認／差し戻し | 給与を見られる人 |
| `POST reopen` | 条件を直す（案内前） | 採用HR |
| `POST legalsign` | LegalSign に登録した版の記録／例外ルート | 採用HR |
| `POST signed` | 締結の記録 | 社長・管理者・人事（canAdvanceHire） |

既存 `/api/hr/offers`：`send`・`issueLink`・`markSent`・`handoff` に正式PDFの確かめを追加。正式PDFの版では `setLegalSign`・`markFormalSigned` は使わず `use_contract` を返す。`sendFormal`（LegalSign の案内メール）は案内後なら同意の前でも使える。

監査ログ（`gw_activity_log`）：`hr.attorney_requested`・`hr.official_doc_received`・`hr.official_doc_approved`・`hr.official_doc_returned`・`hr.official_doc_view`・`hr.official_doc_mismatch`・`hr.offer_conditions_reopened`・`hr.offer_contract_route_set`・`hr.offer_legalsign_url_set`・`hr.offer_formal_signed`（via: contract）。URL・本文・給与は残さない。

## 7. DB（db/139）

- `gw_hr_attorney_requests`：依頼済みの記録（追記だけ・書き換え不可）。
- `gw_hr_offer_official_docs`：正式PDFの受領記録（中身不変・状態は received → approved/returned/superseded、approved → superseded の向きだけ・承認は条件の版ごとに1つ・案内した版は差し替え不可）。
- `gw_hr_offers` に列：`doc_route`・`contract_route`・`official_doc_id`・`legalsign_doc_id`・`legalsign_doc_sha256`・`formal_evidence`・`formal_contract_ref`・`formal_doc_sha256`（CHECK とロックのトリガー）。
- 置き換える制約：`gw_hr_offers_formal_order_chk`（正式PDFの版は、同意の前でも締結を記録できる。ほかの版は従来どおり）。
- RLS：新しい2つの表は採用HR（`gw_is_recruiting`）が読むだけ。ログインした人からは書けない（service role だけ）。

## 8. 導入手順（依頼者が行う）

1. `db/137_hr_finish.sql` が本番に適用済みか確かめる（`db/check_137_hr_finish.sql`）
2. `db/139_hr_contract_procedure.sql` を Supabase（グループウェア）の SQL Editor で Run（べき等）
3. `db/check_139_hr_contract_procedure.sql` を Run して ❌ が無いこと
4. PR をマージ（環境変数の追加は無い。LegalSign の URL を絞るなら既存の `LEGALSIGN_ALLOWED_HOSTS`）
5. 確認：テスト用の応募者で 条件を確定 → 依頼文 → 依頼済み → PDF → 承認 → LegalSign → 案内 → 同意 → 締結 → 引き渡し

戻すとき：アプリを戻す → 同意の前に締結を記録した版が無いことを確かめる → `db/rollback_139_hr_contract_procedure.sql`
（依頼・受領の記録と新しい列は消える。本人へ案内した正式PDFは `notice_*` に残る）。

## 9. 未実装・確認が要ること

| 項目 | 状態 |
|---|---|
| 社労士からの差し戻し・再依頼の期限、未対応者の一覧・リマインド通知（P1） | 未実装（一覧の状態表示まで） |
| 依頼文・照合項目のテンプレート管理（会社ごとの文面・前回条件のテンプレート） | 未実装（コードの定義。会社の既定値は既存の各項目の既定値のみ） |
| LegalSign の API/Webhook による締結の自動反映（P2） | 未実装（担当者が証跡を確かめて記録） |
| Slack への自動送信 | 作らない（要件どおり） |
| PDF の中身（文面）と条件の自動照合 | 未実装（人が見比べて✓。法定の記載事項は社労士の確認が前提） |
| 雇用区分の選び方 | 既存の区分カード（説明つき）と、パート／アルバイトのボタンを維持。新しい区分（雇用期間・勤務地の種別・働き方・契約ルート）はプルダウン |
| 承諾後の条件変更（再発行） | 既存どおり承諾後は再発行できない（必要なら別途） |
| 本番の db/137・db/139 の適用、本番での動作 | 未確認 |
