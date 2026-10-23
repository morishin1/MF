# Sales分析の入口統合・PDCA（ローカルレビュー案）

## 目的と今回の境界
2026-10-24指示：ヘッダーの「分析」にマッチング／アタック／提案を集約し、売上につながる仮説と検証行動を考えられる入口にする。
PR185最終head e6b78057から独立ローカルbranch。PR166 head4dbdaceは未変更・未取込。公開、マージ、本番、DB、権限変更なし。
新AI APIや新台帳は設けない。仮説は例で因果未検証。選択結果は保存せず、実行する検証は既存タスク／日報で担当・期限・根拠を管理する。

## 第一段階：現行データで動くもの
- `/sales/analytics.html#matching`：ENGER既存レポートへ。MFで未接続の属性を0件として表示しない。
- `#attack`：従来アタック分析のAPI・集計をそのまま再利用。既存URLの初期表示も維持。
- `#proposal`：PR185の既存GET `/api/sales/proposals/journey` と描画を移設。二つ目の集計/APIは作らない。
- 提案管理から分析・KPIタブと旧KPI描画を撤去。管理・理由入力・面談記録・権限は維持。API旧kpi応答は互換のため削除しない。
- 根拠数値／期間／母数→ボトルネック候補→仮説（推測）→一つの検証行動→振返指標を短い選択式案内にする。自動送信・自動タスク化・AIの原因判定はしない。

## 定義を混ぜない
### アタック
`api/sales/approaches/index.js`の送信済み活動、`api/sales/deals/`の案件を既存画面が集計。
`companiesOf/levelOf`は企業の現在状態・案件の後段から前段到達を推定する既存仕様。提案の明示証拠ファネルと同じ意味ではない。
上部アタック〜成約は期間内送信企業、受注額は期間内成約日、要因表はapproachId起点の案件帰属。受注額は会計上の売上ではない。
担当フォーム件数は実送信者、提案の担当表は現在担当。役割や期間が違う数値を横断で足し合わせない。

### 提案
送信日コホート、1提案ID1件、ENGER連携・非アーカイブ・閲覧可能範囲。
面談調整／日程確定／実施／ENGER合格／Sales成約／稼働は独立証拠。正式合格率は履歴網羅性未確認のため非表示。
少数母数、上限、未観測、当時実行担当と現在担当の違いを維持。
記録された見送り理由は真因未検証。取得状態と理由分類を分離し、旧記録は未区分。低率から会社や担当の責任を判定しない。

## PR166との統合判断
PR166はdashboard/indexのコンパクト化と役割別の起票コホート分析。今回の送信コホートとは異なり、未承認branchへ勝手にpushしない。
将来166を採用する場合は詳細分析の入口をこの3タブへ合わせ、dashboardは要約と導線に限定する案。既存の役割別APIを再利用し、現在担当の表と統合/合算しない。
PR163/145/157とのproposals/intake等の並行変更は別途統合レビューが必要。

## 第二段階：未接続のマッチング分析
ENGER既存`src/lib/data/talent-analysis.ts`と`src/app/(app)/report/page.tsx`を再利用候補にする。
既存画面：`https://dx.enger.jp/report?view=composition` / `?view=skills` / `?view=quality`（ENGERの既存認証が必要）。
MFの現行連携には`job_title`/`talent_initials`はあるが、安定job/candidate IDや需要・供給属性はない。名前・イニシャルでは名寄せしない。
必要条件：ENGER側読取モデル/APIとtenant/利用者権限、最小属性、対象期間の在庫snapshot、提案IDとjob/candidate IDの対応、母数（比較可能候補/案件）の定義、欠落/上限の扱いをレビュー。
現在の候補在庫だけから過去の供給・需要や機会損失を復元しない。提案に選ばれた人材だけを全人材の母数にしない。
実業務データ・権限・全件網羅性は未確認。数値や効果を作らず、属性×面談率/条件適合率は接続確認後。

### 調査済み属性と母集団（ENGER main 0327312）
- `data/talent-analysis.ts`：職種、年代、所属、リモート、週稼働、スキル、単価、稼働可能時期。案件側職種・スキル・勤務形態・状態。欠落列unavailable、20,000件上限truncated。
- `data/match-finder.ts`：job/candidateのstable IDと職種・スキル・単価・開始日・勤務地・リモート・商流・所属等を用いる。実在任意列のみ利用。
- `candidate-status.ts` / `matching-optout.ts` / `data/matching-optout-set.ts` / `pair-exclusion.ts`：提案可、募集状態、対象外、組合せ除外を反映。需給レポートの全登録母集団とは異なる。
- `data/matching-profiles.ts`：保存済み解析だけを読む。未解析／読取不可／検証済みを区別。新AI呼出は不要。
- `actions/match-decision.ts`の`dx2_match_feedback`は診断ID・担当判断・理由の履歴。真因/客観正解ではない。実DBの有無/認可は未確認。
- `docs/supabase.md`：proposals.job_id/candidate_idのFK。MFにはこれらを現在送らない。企業名文字列からの結合禁止。
- `data/meeting-funnel.ts`の面談はstage/日程/wonによる推定を含む。MFのmeeting doneと混ぜない。
- `/matching/improvement`は廃止済みredirect。旧画面の復活なし。

### Sales内表示の最小接続契約案（未実装・承認要）
1. ENGER既存集計をサーバ側で再利用し、権限付きGETで集計だけ返す。MFに人材原票・単価・氏名・スキルシートを複製しない。既存署名を逆方向の新analytics読取権限として暗黙流用しない。
2. まず『登録在庫の構成/需給参考』の限定集計：対象範囲、登録日期間、asOf、母数、スキル分類、unknown/unavailable/truncatedを返す。両アプリの利用者/tenantに許可される集計かレビューし、少数セル公開基準も決める。
3. 面談連動は元提案IDを使いENGER側でjob/candidateのstable IDを解決、許可された粗い属性ごとに匿名集計する案。MF実施証拠を渡す必要があれば転送方向・対象ID・最小属性・監査・保持期限を別承認。表示名/イニシャル結合は禁止。
4. 『提示候補→提案』転換は候補提示時点、採点版、母集団の履歴が不足。現在在庫や提案済み集合で代替しない。保存追加が必要ならその時点でDB/個人情報設計を別途レビューする。
5. 今回のリンク・案内は完成したマッチング数値分析ではない。接続の認可/データ最小化が確認できるまでSales内需給・属性別面談率は未実装。

### 現行接続の事実
ENGER `report/page.tsx` はServer Componentから `getTalentAnalysis` を直接呼ぶ。既存13 API routesにMF→ENGER需給取得endpointはない。
一方 `gw-sales-client.ts:309/333` はENGER→MF `/api/sales/proposals/status` をpurpose=proposal-statusでPOST読取（元提案ID最大100件・MF固定tenant）できる。従って連携は単なるpush-onlyではないが、逆方向の分析権限は存在しない。
このstatus契約の項目/権限が足りるならENGER側で必要な面談証拠を集計することを優先し、MF実施履歴の追加転送は先に必要性を確認する。

### 具体的な変更候補（次段階、未実装）
- ENGER `src/app/api/integrations/gw/matching-analytics/route.ts` と `src/lib/gw-matching-analytics.ts`：既存loaderの取得/集計を分離再利用、匿名集計DTOの認可付き読取。
- MF `api/sales/matching-analytics.js` と `lib/sales-matching-analytics-client.js`：requireUser/gwContextに加えENGER側で許可されたtenant/role対応を確認しサーバ間取得。timeout/取得失敗/欠落/上限/asOfを返す。
- ENGER画面認可は `(app)/layout.tsx` のgetAccess/requirePartnerPathAllowed。`auth/actor.ts`のJWT→active app_users、`auth/product-access.ts`のmembership/product/partner境界を新APIでも明示的に評価する。layout保護がAPIにも自動適用されると仮定しない。従来互換の未紐付け全許可を新APIで踏襲しない。
- 既存status読取はmeeting_atを返すが、meeting doneの独立フラグ/全実施履歴ではない。日程を実施へ読み替えない。実施済み証拠の最小DTO追加が必要か別レビュー。
- 承認点：閲覧tenant/role対応、新読取purpose/固定接続先/資格情報設定、集計DTO転送項目・少数セル秘匿、陰性権限テスト。canSellだけでENGER全件閲覧を許可しない。
