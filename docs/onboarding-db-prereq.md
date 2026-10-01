# 入社管理＋労働条件通知書：本番 DB の前提チェックと、不足したときの最小の流し方

**この文書は、本番の DB に何も流さない。** 読み取り専用のチェック SQL（`db/check_onboarding_ready.sql`）と、不足が出たときの順番を決めるもの。

## 0. 先に訂正

`db/check_labor_notice.sql` の 40 行目（`gw_procedures` と `kind・stage・target_on` の列）を、前の版は **「任意」** としていた。**これは誤り。**

- 入社管理の画面（`admin-hr.html`）の一覧は、`api/hr/index.js` が `gw_procedures` を直接読む。表や列が無いと **`GET /api/hr` が `503 not_ready`** で、画面が開かない。
- 本人の `/onboarding/` も、その人の入社手続き（`gw_procedures` の行）が無いと、通知書のカードを出さない（`api/onboarding/start.js` の `hasProcedure`）。
- さらに、その行は `kind・stage・target_on` の **3 つを 1 つの判定にまとめていた**。`stage` 列（db/070）だけが無い場合も「任意（無い）」と出て、表が無いのか列だけが無いのか、見分けられなかった。

`db/110_labor_notices.sql` が本番に入っていても、`gw_procedures` ほかが無ければ、通知書の一連の動き（アップロード → 公開 → 本人が確認 → 管理側に確認日時）は **使えない**。
`db/check_labor_notice.sql` の 40 行目は、`gw_procedures` と 4 つの列（`employee_id・kind・status・target_on`）を **NG** で見るように直し、`stage`（db/070）は別の行（42）で「任意」にした。

## 1. 使い方

1. Supabase の SQL Editor に、`db/check_onboarding_ready.sql` を貼って Run。`select` が 1 本だけで、**何も書き換えない**（表も列も、行も作らない）。
2. いちばん上の「**集計**」の行を見る。「必須の不足 0 件」なら、DB 側は、入社管理と通知書の一連の動きに足りている。
3. 「判定」が「**不足**」の行を、上から見る。「不足の中身」に、無い表・列・値が出る。「無いと起きること」に、何が止まるかが書いてある。

### 判定の読み方

| 判定 | 意味 |
|---|---|
| 必須で存在 | 必須のものが、ある |
| **不足** | 必須のものが、無い。入社管理か、通知書の一連の動きが止まる |
| 任意（あり） | 任意のものが、ある |
| 任意（なし） | 任意のものが、無い。**無くても、入社管理と通知書は動く**（その分の機能だけ止まる。「無いと起きること」に書いてある） |

**番号では判断しない。** `db/` の番号は、系統（main・PR #39）で重なっている。「066 を流したか」ではなく、「その SQL が作るはずの表・列・関数・制約が、いま実際にあるか」で見る。
「出どころ」のファイル名は、足りなかったときに「どのファイルが作るものか」を知るための参考。

### 「必須」の意味

次の 2 つが動くのに要るもの。

1. 入社管理の画面が開き、入社予定者を登録し、一覧・詳細を見て、チェック・日付を変えられる（`api/hr/index.js`）
2. 通知書の、アップロード → プレビュー → 本人に公開 → 本人が「確認しました」→ 管理側に確認日時（`api/onboarding/notice.js`・`start.js`・`status.js`）

「任意」は、それが無くても上の 2 つは動くもの。

## 2. 何を見ているか（基準は、いまの main のコード）

`api/hr/index.js`・`api/onboarding/{notice,start,status}.js` と、そこから読み込まれる `lib/`（`gw.js`・`auth.js`・`onboard-advance.js`・`hr-run.js`・`labor-notice-db.js`・`notify.js`・`sensitive-log.js` ほか）が、実際に読み書きする実体。
`test/onboardready.mjs` が、コードの `select` の列が、チェックの一覧から漏れていないことを、毎回確かめる。

### 必須（不足なら、止まる）

| まとまり | 実体 | 出どころ（参考） | 無いと |
|---|---|---|---|
| 土台 | `tenants`・`memberships`・`gw_employees`（基本の 10 列＋`manager_id・initial_role・work_style・job_family_code`＋`autonomy_level`）・`gw_role_grants`・`gw_activity_log` | `schema.sql`・005・031・033 | `gwContext`（全 API が通る）が社員名簿を引けず、**全員が 403** |
| 土台 | RLS の関数 6 つ（`gw_has_role`・`gw_is_hr`・`gw_employee_id`・`gw_is_advisor`・`gw_procedure_is_mine`・`is_tenant_staff`） | 005・008・`schema.sql` | ポリシーが呼べない。通知書の RLS が効かない |
| 土台 | 本人が自分の社員名簿の行を読めるポリシー（`gw_employees_self_select`） | 007 | 本人の入社手続き（`status`）が 404 |
| 入社手続き | `gw_procedures` の基本の列（`id・tenant_id・employee_id・kind・status・target_on・note・drive_link・created_by・created_at・updated_at`） | 008 | **`GET /api/hr` が 503**。本人の画面も手続きを引けない |
| 入社手続き | `gw_procedures.phase・notified_at・notified_for` | 066 | `GET /api/hr` が 503（列が無い） |
| 入社手続き | `gw_procedures.drive_folders・advisor_shared_to・advisor_shared_at` | 039 | `GET /api/hr` が 503（列が無い） |
| 入社手続き | `gw_procedure_items` の基本の列 | 008 | チェックリストが空に見える。チェックを付けられない |
| 入社手続き | `gw_procedure_items.item_key` | 037 | 同上 |
| 入社手続き | `gw_procedure_items.phase・assignee_id` | 066 | 同上。登録のとき担当者を入れられない |
| 入社手続き | `gw_procedure_items.owner` の check が **6 種**（本人・人事・社労士・IT・上長・経理）を通す | 066 | 入社の登録（`POST /api/hr`）が `seed_failed`（500）で止まる |
| 入社手続き | `gw_procedures`・`gw_procedure_items` の check が、使う値（種別・状態・分類）を通す | 008 | 登録・チェックで check 違反（500） |
| 入社手続き | `gw_procedures` の `(employee_id, kind)` が一意 | 008（unique）／065 | 同じ人に手続きが 2 つできうる。2 つになると本人の画面から書類を出す口が消える |
| 入社手続き | 本人が自分の手続き・チェックリストを読めるポリシー | 008 | 本人の入社準備（`status`）が空に見える |
| 通知書 | `gw_labor_notices`（表・14 列）・RLS・`gw_labor_notices_read`（owner・hr だけ。古い定義ではない）・更新ガード・`(employee_id, version)` が一意 | 110（**適用済み**） | 通知書が動かない／管理者にも読めてしまう |
| 通知書 | Storage バケット `hr` が**非公開**で存在し、PDF 15MB を妨げない（`file_size_limit`・`allowed_mime_types`） | 012（＋006）／Supabase の Storage 設定 | PDF を置けない・開けない |
| データ | owner または hr ロールの人が 1 人以上いる | 005 の初期投入 | 通知書を操作できる人がいない（403） |
| データ | 同じ人・同じ種別の入社手続きが重複していない | 065（まとめる） | 重複があると、本人の画面から書類を出す口が消える |

### 任意（無くても、入社管理と通知書は動く）

| 実体 | 出どころ | 無いと起きること |
|---|---|---|
| `gw_procedures.stage・stage_at` | 070 | 段階が進んだとき、次の担当者への知らせが出ない。**画面の段階は、事実から計算するので正しく出る** |
| `gw_procedures.mynumber_status` ほか 3 列 | 070 | マイナンバーの進み具合が「未提出」のまま。変えようとすると 503（一覧と他の操作は動く） |
| `gw_sensitive_access_log` | 070 | 他人の通知書を開いた記録（閲覧ログ）が残らない。プレビュー自体は動く |
| `gw_sign_requests` | 046 | 電子署名の依頼の有無を見られない（電子署名を使っていない会社は困らない） |
| `gw_doc_orders` | 056 | 社労士への作成依頼の有無を見られない（管理側の注意書き） |
| `gw_onboard_profiles`・`gw_onboard_consents`・`gw_consent_docs` | 037・039 | 入社情報の提出・誓約書などの同意が、段階の判定に入らない（**最小の流し方に、すでに入っている**） |
| `gw_orientation_items`・`gw_orientation_checks` | 071 | オリエンテーションの確認が、段階の判定に入らない |
| `gw_contracts` | 029 | 契約の期間・試用期間が、表示に出ない |
| `gw_procedure_files` | 012 | 本人が書類をアップロードできない（**最小の流し方に、すでに入っている**） |
| `gw_employee_careers` | 092 | 入社準備のあとの「キャリアプランを確認する」が出ない |
| `gw_notifications`（表・一意・`general` を通す check） | 013（＋040 ほか） | ベルの通知が出ない（本人への「通知書を確認してください」ほか）。手続きは止まらない |
| `gw_tasks`（`link` 列を含む） | 009・066 | 担当者の「やること」に入らない |
| `gw_role_grants.role` の check が `it・manager・finance` を通す | 066 | その 3 つのロールを付けられない。担当者は、人事・経営者に寄る |
| `gw_onboarding_guides`・`…_guide_issues`・`…_invites` | 104 | STEP1（入社案内）が「データ未連携」。STEP2 以降は止めない |
| **`gw_notifications.kind` の check が `hr_flow` を通す** | **どの SQL にも無い** | 下の「既存の問題」を見る |

## 3. 不足があったときの、最小の流し方

**不足した行に対応するファイルだけを、下の順で流す。全部を流し直さない。**（どのファイルも `if not exists`・`drop policy if exists` で書いてあり、2 回流しても同じ。それでも、無いぶんだけ流す。）

### 前提（本番では、適用済みのはず）

次は、groupware 全体の土台。入社管理だけの前提ではない。チェックの「土台」の行（`gw_employees` の列・RLS の関数・`gw_employees_self_select`）と、`gw_is_internal_staff()` の行が「不足」なら、
**ここで止まる。入社管理だけの問題ではない**（全員が 403 になるはずなので、いま動いているなら、ここは揃っている）。

- `schema.sql` → 005 → 007 …（`tenants`・`memberships`・`gw_employees`・`gw_role_grants`・`gw_activity_log`・RLS の関数・本人の読み取りポリシー）
- 026 …（`gw_is_internal_staff()`。039 が呼ぶ）
- 031・033 …（`gw_employees` の列。**どちらも日報の表（`tc_nippo` など、別のアプリの表）が前提**で、単独では流せない。`db/check_status.sql` で、どこまで適用されているかを見る）

### 最小の流し方（入社管理＋通知書。110 は適用済み）

<!-- chain:start -->
db/006_storage_policies.sql
db/008_onboarding.sql
db/009_tasks.sql
db/012_hr_files.sql
db/037_onboard_form.sql
db/039_consent_and_drive.sql
db/066_hr_flow.sql
db/110_labor_notices.sql
<!-- chain:end -->

この 8 つは、**1 つも余計ではない**（どれを抜いても、必須の不足が出る。`test/sql/run.sh` の最後で、8 つを 1 つずつ抜いた DB を作って確かめている）。
順番は、前提で決まる（流す前に、これが無いと、そのファイルが途中で止まる）。

| ファイル | 作るもの | 前提 |
|---|---|---|
| 006 | `safe_uuid(text)`（012 が呼ぶ） | `schema.sql` |
| 008 | `gw_procedures`・`gw_procedure_items`・`gw_is_advisor`・`gw_procedure_is_mine`・本人の読み取りポリシー | `schema.sql`・005 |
| 009 | `gw_tasks` | 005 |
| 012 | バケット `hr`（非公開）・`gw_procedure_files` | **006**（`safe_uuid`）・**008** |
| 037 | `item_key`・`gw_onboard_profiles`・`gw_onboard_consents` | **008** |
| 039 | `drive_folders` ほか 3 列・`gw_consent_docs` | **008**・**012**（`gw_procedure_files`）・**037**（`gw_onboard_consents`）・**`gw_is_internal_staff()`（026）** |
| 066 | `phase`・`notified_*`・`assignee_id`・owner の 6 種・`gw_tasks.link` | **008**・**009**（`gw_tasks`）・**037**（`item_key`） |
| 110 | 通知書（**適用済み**） | 005（`gw_has_role`） |

実際に確かめたこと（PostgreSQL 16）:

- 006 が無いと 012 が `function public.safe_uuid(text) does not exist` で止まり、039 も `gw_procedure_files` が無くて止まる。
- 009 が無いと 066 が `relation "public.gw_tasks" does not exist` で止まる。
- 037 が無いと 039 が `gw_onboard_consents` で、066 が `i.item_key` で止まる。
- **039 は、`gw_is_internal_staff()`（db/026 が作る）が無いと `function public.gw_is_internal_staff() does not exist` で止まる。** 026 は日報の表が前提なので、無い DB では 039 を流せない（チェックの 811 行が見る）。

### 条件つきで流すもの

- **065**（入社手続きを 1 人 1 つにまとめる。**データを動かす**）: 「`(employee_id, kind)` が一意」「重複していない」の行が不足のときだけ。先に、読み取りで重複を見る。
  ```sql
  select employee_id, kind, count(*) from public.gw_procedures group by 1, 2 having count(*) > 1;
  ```
  重複があれば、いちばん古い手続きに、チェック項目・ファイルを寄せて、空になった重複を消す。**前提は 008・012・037。** 重複が無ければ、一意のインデックスを足すだけ。
以下は、どれも任意。**最小の流し方のあとに流して、途中で止まらないこと**を、ローカルで確かめてある。

- **070**（段階の写し・マイナンバーの進み具合・閲覧記録）: 008・037・066 のあと。ほかの前提は要らない（070 の冒頭には 046・056 とあるが、表は使わない）。
- **013**（通知）: 土台があれば流せる。
- **046 → 056 → 071**（電子署名の依頼・社労士への作成依頼・オリエンテーション）: 056 は 046 の、071 は 056 の表を使う。この順でなければ止まる。
- **029**（契約）・**092**（キャリア）: 最小の流し方のあとなら、そのまま流せる。

### 流さないもの（今回の方針）

- 給与関連の 099〜105（`099_owner_only`・`100_hr_pay`・`101_hr_pay_clear`・`102_contracts_pay_rls`・`103_tool_access`・`104_onboarding_guide`・`105_compensation`）と、main 系統の 099〜109 の事務所・営業まわり。
  **104（入社案内）は `gw_is_owner(uuid)`（`099_owner_only.sql`）が前提**で、流さない方針なので、入社案内（STEP1）は「データ未連携」のまま。通知書の確認には関係しない。
- Board 連携。

## 4. 不足が出たときの対応表

| 不足の行 | 流すファイル |
|---|---|
| `gw_procedures`（表）の基本の列 | 008（先に、前提の 006・009・012 …の要る・要らないを、上の表で） |
| `gw_procedures.phase・notified_*`／`gw_procedure_items.phase・assignee_id`／owner の check | 066（前提 008・009・037） |
| `gw_procedures.drive_folders ほか` | 039（前提 008・012・037・026） |
| `gw_procedure_items.item_key` | 037（前提 008） |
| Storage バケット `hr` | 012（前提 006・008） |
| 通知書の各行 | 110（適用済みのはず。古いポリシーの行が不足なら、110 をもう一度流す。べき等） |
| `(employee_id, kind)` が一意／重複 | 065（上の「条件つき」） |
| owner・hr の人がいない | データの問題（005 の初期投入）。SQL で足す前に、ご確認を |
| Storage バケット `hr` の設定（サイズ・種類） | Supabase の Storage 設定（バケット `hr` の制限）。SQL ではない |

## 5. 既存の問題（今回は直さない）

**`lib/hr-run.js` は、入退社の担当者への知らせを `kind = 'hr_flow'` で作る。どの migration も、`gw_notifications.kind` の check にこの値を入れていない**
（check は `general・task_overdue・task_assigned・notice・message`、040 ほかで `booking・expense・request・blocker・meeting・hr・sales` が足されるだけ）。
ローカルで、全 migration を番号順に流した DB でも、`hr_flow` は check で断られる。`notify()` が失敗を握りつぶすので、**画面もAPIも落ちない**が、**担当者へのベルの通知が入らない**
（「やること」への登録と、Slack は動く）。本番で実際に断られているかは、チェックの 515 行が見る。

通知書の一連の動き（本人への「通知書を確認してください」は `kind = 'general'`）には関係しない。直すなら `kind` の check に `hr_flow` を足す別の変更。**今回は、機能追加も SQL の追加もしない。**

## 6. 管理側の画面に入れる人（DB の話ではない）

`admin-hr.html` は、画面の入口で `roles: ["admin", "owner"]` を見る（`js/layout.js`）。`hr` ロール**だけ**を持つ人（会計側の管理者でも、owner でもない）は、
ログイン後の振り分けで `member` 扱いになり、入社管理の画面に入れない。通知書の API は owner・hr の両方を通すが、画面に入れるのは、管理者か owner。
本番で試すときの管理側のアカウントは、**owner か、管理者（admin）で hr も持つ人**を使う。

## 7. このチェックを確かめたこと（ローカル。PostgreSQL 16）

`test/sql/check_onboarding_ready.sql`（`test/sql/run.sh` が流す）:

- 入社の表が 1 つも無い DB でも、チェックは落ちずに「不足」を返す（表が無いときは「表が無い（gw_procedures）」と出す）
- 最小の 8 ファイル（＋土台）で、必須の不足が 0。それに owner を 1 人入れて 0 件。もう一度流しても同じ（べき等）。065 を足しても同じ
- 8 ファイルを **1 つずつ本当に抜いた DB** で、必須の不足が出る（006・008・009・012・037・039・066・110）
- 必須を 1 つずつ壊すと、その行だけが「不足」になる（列・check・一意・ポリシー・トリガ・バケット・バケットの設定・データ・関数）
- 制約が無ければ、どんな値も通るので「不足」にしない（check を外した DB）
- 任意が欠けていても、必須の判定に混ざらない。`hr_flow` を通さない既存の問題が「任意（なし）」として見える
- 読み取り専用（前後で、定義の数も行数も変わらない）

`test/onboardready.mjs`（毎回の CI）: コードの `select` の列・`P_FIELDS`・`I_FIELDS`・`gwContext`・通知書の列が、チェックの一覧から漏れていない／コードが読む表が、チェックの表にある／
チェックが読み取り専用／「出どころ」のファイルが実在する／文書の流す順が `run.sh` の順と同じ／流さないと決めたものが入っていない。
