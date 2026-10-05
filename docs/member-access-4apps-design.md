# メンバー管理：アプリ利用権限（4つ）と内部ロールの分離 設計案 v2

状態: **提案（未実装・SQL 未実行）**。承認後に実装する。
見た目のモック（承認済み）: `member-toggle-mock.html`（一覧は4ボタンだけ）

## 0. 前提（承認いただいた方針）

- メンバー一覧で設定するのは **採用HR / Sales / Office / 経営** の4つだけ。意味は「どのアプリへ入れるか」だけ。
- `owner / hr / finance / manager / recruiter / sales / it / labor_advisor` は **アプリの中で何ができるか** を決める内部ロール（`gw_role_grants` のまま・変更しない）。一覧には出さず「詳細設定」へ。
- Office は、入口と中身を分ける。
  - Office ON ＝ Office アプリへ入れる
  - Office ON ＋ `hr` ＝ 人事・労務
  - Office ON ＋ `finance` ＝ 経理・事務
  - Office ON ＋ 現在の月末月初権限（`owner` / `manager` / `finance`）＝ 月末月初
  - **Office ON だけで3つ全部は使えない。**
- 経営は `owner` のまま。経営 ON（＝ owner）は 4 つ全部 ON 固定。
- **移行前後で実効権限を変えない（必須）。差分 0 人でなければ止める。**
- 保存先は `gw_role_grants` に役割を足す案ではなく、**アプリ利用権限専用テーブル `gw_app_grants`**。

## 1. 新しい判定（入口 × 内部ロール）

記号: `A(x)` ＝ アプリ x へ入れる（入口）。`role(r)` ＝ 内部ロール r を持つ。

```
■ 入口（gw_app_grants ＋ 暗黙の2つ）
  A(hr)     = owner  または  app_key='hr'
  A(sales)  = owner  または  app_key='sales'
  A(office) = owner  または  会計の管理者（memberships の admin/staff）  または  app_key='office'
  A(keiei)  = owner                                   ← gw_app_grants は見ない（経営は owner のまま）

■ 実効権限（いまの access のキーと同じ名前・同じ意味で返す）
  recruit       = A(hr)
  sell          = A(sales)
  office        = A(office) かつ ( owner | manager | finance )   … 月末月初（今の OFFICE_ROLES をそのまま内部条件に）
  officeHr      = 会計の管理者 または owner または ( A(office) かつ hr )          … 人事・労務
  officeFinance = 会計の管理者 または owner または ( A(office) かつ finance )     … 経理・事務
  keiei         = owner
  isHr（canManageHr・給与閲覧などの土台）= owner または ( A(office) かつ hr )     … 内部ロール hr は Office の中の権限
```

- 内部ロールは「持っているだけでは入口は開かない」。入口は `gw_app_grants`（と owner／会計の管理者）だけが決める。
- 暗黙の2つ（owner・会計の管理者）は **行を作らない**。画面では「変更不可の ON」＋理由を出す（#78 の `accessMeta.accountingAdmin` を流用）。
  - owner を後で外したときは、いまと同じく何も開かなくなる（暗黙の分は残らない）。
- `gw_app_grants.app_key = 'keiei'` は表の CHECK に入れるが **予約**（判定は読まない）。うっかり行が入って「付けたのに効かない」を防ぐため、いまは INSERT を拒否するトリガを付ける（将来経営を独立させるときに外す）。
  - 画面の経営ボタンは、今の `owner` の付け外し API（経営者だけが操作可・MFA・最後の1人は外せない）をそのまま使う。
- 内部ロールの意味は変えない（`hr` ＝人事の管理権限、`recruiter` ＝採用担当ラベル、`manager` ＝責任者、`finance` ＝経理、`it`、`labor_advisor`）。

## 2. ① 新 DB 設計

### 2.1 テーブル `public.gw_app_grants`

| 列 | 型 | 備考 |
|---|---|---|
| `tenant_id` | uuid not null | `gw_role_grants` と同じ |
| `employee_id` | uuid not null | `gw_employees(id)` on delete cascade |
| `app_key` | text not null | check in (`hr`,`sales`,`office`,`keiei`) |
| `granted_by` | uuid | 付けた人（`auth.users`）。移行で入れた行は null |
| `created_at` | timestamptz not null default now() | |
| 主キー | `(employee_id, app_key)` | 二重付与できない（API は upsert + ignore duplicates） |
| 索引 | `(tenant_id, employee_id)` | 一覧・ctx の読み込み用 |

- **RLS**: 読み取り＝自分の行 ／ 人事・管理者（`gw_is_hr`）は全件。書き込み＝`gw_is_hr`（`gw_role_grants` と同じ考え方）。`keiei` の INSERT はトリガで拒否。
- **ヘルパー関数** `gw_has_app(p_tenant uuid, p_app text)`: `gw_has_role` と同じ作り（`gw_employees.user_id = auth.uid()` で引く。在籍状態では絞らない＝いまの `gw_has_role` と同じ）。
- 経営（owner）・会計の管理者は行を持たない（§1）。

### 2.2 DB の判定関数（SQL 2 本目で切り替え）

| 関数 | いま | 切り替え後 |
|---|---|---|
| `gw_is_recruiting` | owner / manager / hr / recruiter | owner **または** `gw_has_app('hr')` |
| `gw_is_sales` | owner / manager / sales | owner **または** `gw_has_app('sales')` |
| `gw_is_office`（月末月初） | owner / manager / finance | owner **または** (`gw_has_app('office')` かつ (manager または finance)) |
| `gw_is_office_finance` | 管理者 / owner / finance | 管理者 / owner / (`gw_has_app('office')` かつ finance) |
| `gw_is_hr` | hr / owner / 管理者 | 管理者 / owner / (`gw_has_app('office')` かつ hr) |
| `gw_expense_can_review`・`gw_request_can_review` | 上の2つを参照 | 変更なし（上が変われば追従） |
| `gw_is_owner`・`gw_is_keiei` | owner | **変更なし** |

`gw_is_hr` は RLS で最も広く使われる関数なので、**ここだけ別ステップ**にして単独で検証・巻き戻せるようにする（§5）。

## 3. ② 現在のロール → 4アプリ権限の移行表

内部ロール（`gw_role_grants`）は**1行も消さない・変えない**。`gw_app_grants` に次の行を足すだけ（同じ人に複数あれば和集合・重複なし）。

| 今の内部ロール | 足す `app_key` | 移行後に効く実効権限（いまと同じ） |
|---|---|---|
| owner | なし（暗黙で全部） | 採用HR・Sales・Office（人事・労務／経理・事務／月末月初）・経営 |
| manager | `hr`, `sales`, `office` | 採用HR・Sales・月末月初（人事・労務／経理・事務は無し） |
| hr | `hr`, `office` | 採用HR・人事・労務（**月末月初は無し**。`hr` は月末月初の内部条件に入っていないため） |
| recruiter | `hr` | 採用HR だけ |
| sales | `sales` | Sales だけ |
| finance | `office` | 経理・事務＋月末月初（今と同じ） |
| it / labor_advisor | なし | 何も開かない（今と同じ） |
| 会計の管理者（admin/staff） | なし（暗黙で Office の入口） | 人事・労務＋経理・事務（月末月初は無し。今と同じ） |

- 検算（`hr`）: 今＝採用HR○・人事・労務○・月末月初×。移行後＝`A(hr)`○ → 採用HR○ ／ `A(office)`○ かつ `hr` → 人事・労務○ ／ 月末月初は「owner/manager/finance」が条件なので×。**増えない・減らない**。
- 複数ロールの人（例: hr＋finance、manager＋hr）も和集合で今と一致する（§4 のテストで全組合せを確認）。
- 移行後に変わる運用（意図した結果）: 内部ロールを付け外ししても入口は勝手に開かない。入口は一覧の4ボタンで決める。新しい責任者の作成（`lib/onboard.js`）は、今の「責任者＝3アプリ」を保つため `manager` ＋ `hr`・`sales`・`office` を一緒に付ける。

## 4. ③ 移行前後の実効権限の比べ方（差分 0 人が条件）

比べる「実効権限ベクトル」（人ごと）:
`recruit / sell / office(月末月初) / officeHr / officeFinance / keiei / aiInquiries / canManageHr(isHr) / canSeeSalary / isOwner`（アプリ側）と、
`gw_is_recruiting / gw_is_sales / gw_is_office / gw_is_office_finance / gw_is_hr / gw_expense_can_review / gw_request_can_review / gw_is_owner / gw_is_keiei`（DB 側）。

| 段階 | 何を比べるか | 書き込み | 合格条件 |
|---|---|---|---|
| a. 書く前のドライラン | 今の式（`gw_role_grants` と memberships から）と、「移行表を当てたあとの式」を、全社員＋会計の管理者で比べる。**テーブルも行も作らない（読み取りだけ）** | なし | 差分 0 人 |
| b. 移行直後 | 本物の `gw_app_grants` から出した新しい式と、今の式（同じ SQL に残す）を比べる | 移行 SQL のあと | 差分 0 人 |
| c. DB 関数の切り替え前後 | 全員を `auth.uid()` に見立てて（`set_config('request.jwt.claim.sub', …)`）9 つの関数の結果を `gw_access_snapshot` に保存 → 切り替え → 同じ集計を取って突き合わせ | スナップショット表のみ | 差分 0 人 |
| d. アプリ側 | node テスト：8 ロールの全部分集合（256）× 会計の管理者（有無）で、凍結した「いまの式（test 内にコピー）」と「新しい式＋移行表」を比べる | なし | 差分 0 件 |
| e. 反映後の実機 | 管理者の画面で、各人の4ボタンの表示が、移行前に控えた「利用できる業務」と一致するか | なし | 一致 |

- **増える人も減る人も 1 人でも出たら止める**（その人のID・どのキーが変わったかを出力して中断。適用を進めない）。
- 差分の出力は「社員ID・名前・キー・移行前・移行後」。個人情報を外に出さないよう、会社内の SQL Editor 上だけで見る（ログには人数だけ残す）。

## 5. ④ 必要な SQL ファイル（**作るだけ・まだ流さない**）

段階を分けて、各段階が権限にとって中立になるようにする。

| 順 | ファイル | 内容 | 権限への影響 |
|---|---|---|---|
| 0 | `db/check_app_grants_dryrun.sql` | §4-a。読み取りだけ。**最初に流して差分 0 人を確認** | なし |
| 1 | `db/119_app_grants.sql` | テーブル `gw_app_grants`・RLS・`keiei` 拒否トリガ・`gw_has_app()`・§3 の移行 INSERT（べき等） | **なし**（どの判定関数もまだ読まない。古いアプリも影響を受けない） |
| 2 | `db/check_app_grants_after.sql` | §4-b。移行直後の突き合わせ | なし |
| — | （アプリのデプロイ） | 新しい判定コード。DB 関数はまだ旧式（役割基準）だが、移行済みなので結果は同じ | なし（差分 0 が前提） |
| 3 | `db/check_app_grants_functions.sql`（snapshot） | §4-c の保存側 | スナップショット表のみ |
| 4 | `db/120_app_gates.sql` | `gw_is_recruiting / sales / office / office_finance` を新式に（`gw_is_hr` は含めない） | なし（差分 0 が前提） |
| 5 | `db/121_app_gate_hr.sql` | `gw_is_hr` を新式に（単独。巻き戻し SQL をファイル内に添付） | なし（差分 0 が前提） |
| 6 | `db/check_app_grants_functions.sql`（compare） | §4-c の比較側。**各 4・5 のあとに実行** | — |
| — | `db/000_install_fresh.sql` | 新規構築用に 119〜121 を反映 | — |

- 巻き戻し: 5 → 4 → 1 の逆順。4・5 は旧式の関数定義に戻すだけ。1 の表は、4・5 を戻したあとなら消してよい（内部ロールは触っていないので、戻しても元通り）。
- 順序の注意: **SQL（1）が先、アプリが後**。アプリが先だと、入口の行が無くて全員が閉め出される。アプリのデプロイ前に §4-b の差分 0 を確認する。

## 6. ⑤ 変更対象ファイル

| 区分 | ファイル | 変更 |
|---|---|---|
| 判定 | `lib/gw.js` | `gwContext` が `gw_app_grants` を読む（`ctx.apps`）。`canAccessHr/Sales/Office/OfficeHr/OfficeFinance/isHr` を §1 の式に。`HR_ROLES` などの「入口になる役割一覧」は廃止し、月末月初の内部条件だけ `OFFICE_MONTHLY_ROLES` として残す。`accessOf` に `apps`（4つの入口）を追加。キー名・意味は既存のまま |
| 判定 | `lib/app-grants.js`（新規） | `APP_KEYS`、移行表（役割→app_key。SQL と node テストで共通に使う）、`loadApps()` |
| API | `api/me.js` | `access` に加え `apps`（4つの入口）を返す。内部の生ロール判定（1か所）を `isHr` 経由に |
| API | `api/employees/index.js` | 各人に `apps`（4つ）・ロック理由（owner／会計の管理者）・`access`・`accessMeta` を返す（#78 の形を拡張） |
| API | `api/employees/apps.js`（新規） | `POST {employeeId, app, grant}`。`hr/sales/office` は `gw_app_grants` を upsert/delete、`keiei` は owner の付け外し（既存ガードをそのまま呼ぶ）。`gwLog`（`app.grant`/`app.revoke`）。応答は #78 と同じ形（`apps`・`access`・`accessMeta`） |
| API | `api/employees/roles.js` | 内部ロールの付け外しのまま。応答に `apps` を足すだけ。詳細設定から使う |
| 作成系 | `lib/onboard.js`、`api/admin/setup.js`、`db/bootstrap_eight_accounts.sql` | 役割を付けるとき、移行表どおりの入口も一緒に付ける（付けないと新しい責任者が何も開けない） |
| 内部ロールを直接見ている所 | `lib/career.js`（3か所）、`api/week-goals.js`（1か所） | `career` は `isHr` 経由に（Office の人事・労務の内側）。`week-goals` の `manager` はアプリの入口と無関係なので変更なし。実装時に全件洗い出し直す |
| 画面 | `admin-members.html` | 一覧は4ボタンだけ（承認済みのモック）。詳細設定に内部ロール（8つ）と「Office ON ＋ hr ＝人事・労務…」の説明。CSV は4アプリ |
| 画面 | `js/layout.js` | Office の入口を `apps.office`（Office ON）に。**共有 js のため `?v=`・`api/health.js assetVersion`・`test/asset-versions.json`・`test/asset-hashes.json` の更新が必要** |
| 画面 | `office/` の各ページ | Office ON だけで中身が無い人のために、Office ホームに「担当の権限がありません」を出す |
| DB | 上の §5 の SQL 一式、`db/000_install_fresh.sql` | |
| テスト | `test/accessparity.mjs`、`test/memberaccessapi.mjs`、`test/ui/memberaccessui.mjs`、`partnerapi`・`owneronlyapi`・Office 系の判定表、`test/mfatest.mjs` | 新しい式に更新。**凍結した旧式との全組合せ比較を新設**（§4-d） |
| 触らない | `lib/mfa.js`（二段階認証は内部ロール基準のまま）、`gw_is_owner`・`gw_is_keiei`、`gw_role_grants` 本体 | |

## 7. ⑥ #78 から再利用する部分

| 再利用 | 内容 |
|---|---|
| `lib/member-access.js` | `adminFlags()`（memberships の admin/staff を1回で集める）と `accessForMember()`。入力に `apps` を足すだけ |
| `lib/gw.js memberAccessOf` | 「他人の access を `accessOf` そのもので出す」考え方（新しい式に追従させる） |
| `api/employees/index.js` | 閲覧者が人事のときだけ `access`・`accessMeta` を付ける仕組み。`null`＝確認できません の扱い |
| `api/employees/roles.js accessAfter` | 変更直後に再計算した値を応答で返す仕組み → `apps.js` が同じ形で返す |
| `admin-members.html` | その場で同じ行を更新（一覧を読み直さない）、応答に `access`/`accessMeta` が無ければ読み直す、`accessMeta.accountingAdmin` ＝「会計の管理者のため変更不可」の理由、基本区分の名称、スマホ幅の扱い |
| テスト | `memberaccessapi`（`/api/me` と一覧の全役割組合せ一致）、`memberaccessui`（その場で更新・失敗・null・狭い幅・CSV）、`officeperfui` のモック調整 |
| 捨てる | 7行の○×チップ表（`ACCESS_ROWS`）、Office 3行の凡例、3つの細かい行のテスト |

## 8. 確認したいこと

1. `gw_app_grants.app_key='keiei'` を表に入れるが、いまは INSERT を拒否する（判定は `owner` のまま）でよいか。
2. `isHr`（人事の管理権限・給与閲覧の土台）を「Office ON ＋ hr」の内側にする（§1）でよいか。これを外すと、Office OFF の `hr` が人事の管理 API を使えてしまう。
3. `gw_is_hr`（RLS）も新式にする（SQL 5）でよいか。やらない場合は API だけが入口になり、DB は役割基準のまま残る。
4. Office ON だけで中身が無い人のために、Office ホームに「担当の権限がありません」を出す扱いでよいか。
