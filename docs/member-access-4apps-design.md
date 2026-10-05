# メンバー管理：業務権限を4つ（採用HR / Sales / Office / 経営）だけにする設計案

状態: **提案（未実装・SQL 未実行）**。承認をもらってから実装する。
UI の見た目だけを先に確認するモック: `member-toggle-mock.html`（サンプルデータ。権限にはつながっていない）

## 1. いまの権限モデル（調査結果）

画面・API・DB は、社内権限 `gw_role_grants.role` の並びで判定している。判定は `lib/gw.js`（API・画面）と DB の `gw_is_*` 関数（RLS）。

| 役割（role） | 採用HR | Sales | Office 月末月初（`office`） | Office 経理・事務（`officeFinance`） | Office 人事・労務（`officeHr`） | 経営 |
|---|---|---|---|---|---|---|
| owner（経営者） | ○ | ○ | ○ | ○ | ○ | ○ |
| manager（責任者） | ○ | ○ | ○ | × | × | × |
| hr（人事） | ○ | × | × | × | ○ | × |
| recruiter（採用担当） | ○ | × | × | × | × | × |
| sales（営業担当） | × | ○ | × | × | × | × |
| finance（経理） | × | × | ○ | ○ | × | × |
| it / labor_advisor | × | × | × | × | × | × |
| 会計の管理者（memberships の admin/staff） | × | × | × | ○ | ○ | × |

つまり **4つの業務と既存ロールは1対1ではない**。

- **暗黙の継承がある**: owner は全部、manager は3つ、hr は採用HRも使える。採用HR を OFF にしたくても、hr や manager を持っていれば ON のまま。
- **Office は実体が3つ**に分かれている（月末月初／経理・事務／人事・労務）。
- **`hr` は「人事の業務」だけでなく、管理権限そのもの**: `canManageHr`（API 約 75 ファイル）、給与の閲覧（`canSeeSalary`）、社員名簿・雇用契約・勤怠・権限の付け外し、DB の `gw_is_hr` が `hr` を見ている。Office のボタンを `hr` に結びつけると、「Office を使える人＝人事の管理者」になってしまう。
- 経営（`/keiei`）は owner だけ。owner は権限の付与・MFA・給与・印鑑・端末の失効も握る。

→ 見た目だけ4つにして既存ロールへ割り当てると、「OFF にしても入れる」「Office を付けたら人事の管理者になる」が起きる。したがって、下の設計で**4つを独立した持ち物にする**。

## 2. 設計案（推奨）

### 2.1 考え方

1. 業務権限は **4つの明示フラグ**だけで決まる（暗黙の継承をやめる）。
2. 細かいロール（hr / manager / finance / it …）は「詳細設定」へ。上のボタンの意味は変えない。
3. 画面は、サーバが返す結果（`access`）を表示するだけ。画面側で役割を並べ直さない（今と同じ）。

### 2.2 4つのボタンの意味

| ボタン | ON の意味 | 保存先（`gw_role_grants.role`） |
|---|---|---|
| 採用HR | 採用HR（`/hr`）を使える | `recruiter`（既存） |
| Sales | Sales（`/sales`）を使える | `sales`（既存） |
| **Office** | **Office のホームと「月末月初業務」を使える**（下の「Office ON の意味」を参照） | **`office`（新設）** |
| 経営 | 経営（`/keiei`）を使える ＝ 経営者 | `owner`（既存。経営者だけが付け外せる。MFA・最後の1人は外せない、の既存ルールのまま） |

- 経営は「経営者（owner）」そのもの。owner は全業務の上位なので、経営 ON の人は他の3つも ON で固定（画面では変更不可・理由を表示）。経営を他の業務と独立させる案は §6（要判断）。
- 会計の管理者（memberships の admin/staff）は、いまも Office の経理・人事に入れる。これは会計側の権限なので変更不可の ON として表示し、理由を出す。

### 2.3 「Office ON」が何を意味するか（要確認の中心）

今の Office は3つの業務を含み、持っている役割ごとに入れる範囲が違う。選択肢はこの3つ。

| 案 | Office ON の意味 | 良い点 | 悪い点 |
|---|---|---|---|
| **A（推奨）** | Office ホーム＋月末月初業務。**経理・事務／人事・労務は「詳細設定」で別に付ける** | 最小権限。今の責任者（manager）と同じ範囲。個人情報・給与・権限管理を、Office を付けただけで渡さない | 経理担当に付けるときは「詳細設定」で経理・事務も付ける1手間 |
| B | Office ON ＝ 月末月初＋経理・事務（今の `finance` と同じ） | 経理担当は1回で済む | 責任者（月末月初のみ）に付けると経理・事務（経費承認・請求）まで広がる |
| C | Office ON ＝ 3つ全部 | 利用者から見て一番単純 | 経理に人事・労務（個人情報・給与・雇用契約・権限管理）まで渡る。#65 で分けた意味がなくなる |

**推奨は A**。「Office を ON にした人」の既定が最も狭く、広げるのは明示的な操作（詳細設定）だけになる。
A の場合、`officeFinance`（経理・事務）／`officeHr`（人事・労務）は「Office が ON の人にだけ」有効にする（Office が OFF なら詳細側が残っていても入れない）。詳細設定の持ち物は既存の `finance` ／ `hr` をそのまま使う。

### 2.4 実効権限の式（提案後）

```
recruit       = owner  または recruiter
sell          = owner  または sales
office        = owner  または office            （月末月初）
officeFinance = 会計の管理者 または owner または (office かつ finance)
officeHr      = 会計の管理者 または owner または (office かつ hr)
keiei         = owner
```

`manager` / `hr` / `finance` は、アプリの入口を開く力を失う（`hr` の人事管理者としての力・`finance` の経理業務の力は残る）。これが「独立して ON/OFF」の前提。

## 3. 必要な SQL（**まだ実行しない・提示のみ**）

`db/119_member_apps.sql`（案。べき等。Supabase SQL Editor で実行）

```sql
begin;

-- 1) role に 'office' を加える（いまの値は狭めない）
do $$
declare cur text; vals text[];
begin
  select pg_get_constraintdef(oid) into cur from pg_constraint
   where conrelid = 'public.gw_role_grants'::regclass and conname = 'gw_role_grants_role_check';
  select array_agg(distinct v order by v) into vals from (
    select m[1] as v from regexp_matches(coalesce(cur, ''), '''([^'']+)''', 'g') as m where m[1] !~ '[{},]'
    union select role from public.gw_role_grants where role is not null
    union select unnest(array['owner','hr','manager','labor_advisor','it','finance','recruiter','sales','office'])
  ) s;
  alter table public.gw_role_grants drop constraint if exists gw_role_grants_role_check;
  execute format('alter table public.gw_role_grants add constraint gw_role_grants_role_check check (role in (%s))',
    (select string_agg(quote_literal(v), ', ' order by v) from unnest(vals) as v));
end $$;

-- 2) 既存ユーザーの移行：いま入れている業務を、明示フラグにする
--    manager → 採用HR・Sales・Office       hr → 採用HR・Office       finance → Office
--    ※ hr だけは例外：Office が ON になるため、月末月初業務が新たに使える（§5・§6-5）
insert into public.gw_role_grants (tenant_id, employee_id, role, granted_by)
select g.tenant_id, g.employee_id, x.role, g.granted_by
  from public.gw_role_grants g
  join (values ('manager','recruiter'), ('manager','sales'), ('manager','office'),
               ('hr','recruiter'),      ('hr','office'),
               ('finance','office')) as x(from_role, role) on x.from_role = g.role
on conflict (employee_id, role) do nothing;

-- 3) DB の判定を、明示フラグに（owner は今までどおり全部）
create or replace function public.gw_is_recruiting(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.gw_has_role(p_tenant,'owner') or public.gw_has_role(p_tenant,'recruiter') $$;
create or replace function public.gw_is_sales(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.gw_has_role(p_tenant,'owner') or public.gw_has_role(p_tenant,'sales') $$;
create or replace function public.gw_is_office(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.gw_has_role(p_tenant,'owner') or public.gw_has_role(p_tenant,'office') $$;

notify pgrst, 'reload schema';
commit;
```

- `gw_is_hr`・`gw_is_owner`・`gw_is_keiei`・`gw_is_office_finance`・`gw_request_can_review` は**変えない**（人事管理・経営・経理の RLS は今のまま。経理・事務／人事・労務が「Office ON のときだけ」は API 側で絞る。DB を絞るかは §6）。
- 流す前に、`office` の CHECK を許可する SQL（1）と移行（2）が先。アプリを先に出さない（先に出すと、移行前の manager が HR を失う）。

### 実行前後の検証（結果が変わらないことの確認）
実行前に「人ごとの入れる業務」を保存し、実行＋デプロイ後に同じ集計を取って比べる（`db/check_member_apps.sql` を同時に用意する）。差が出てよいのは「`hr` を持つ人の月末月初業務」だけ。それ以外の差は 0 件でなければ止める。

## 4. 影響範囲（アプリ側の変更）

| 場所 | 変更 |
|---|---|
| `lib/gw.js` | `HR_ROLES` = owner/recruiter、`SALES_ROLES` = owner/sales、`OFFICE_ROLES` = owner/office。`canOfficeHr/Finance` に「Office が ON」の条件を足す |
| `api/employees/roles.js` | ROLES に `office` を足す。ボタン用に `{employeeId, app, grant}` を受け、**サーバ側の1か所の対応表**で `recruit→recruiter` `sales→sales` `office→office` `keiei→owner` に変換（owner の既存ガードはそのまま） |
| `api/employees/index.js` | 一覧に `apps`（4つの ON/OFF）と、ロックの理由（経営者／会計の管理者）を返す（#78 の `access` / `accessMeta` を土台にする） |
| `admin-members.html` | 一覧は4ボタンだけ。詳細設定に Office の範囲（経理・事務／人事・労務）と内部ロール。**一覧には人事・労務／経理・事務／月末月初／内部ロール名を出さない** |
| `lib/onboard.js` | `account_type = manager` で `manager` を付けている箇所を、`manager` ＋ `recruiter` / `sales` / `office` に（付けないと新しい責任者が何も開けなくなる） |
| `api/admin/setup.js`・初期化 SQL | 同じ理由で、初期の役割に `office` などを足す |
| テスト | `accessparity`・`memberaccess*`・`partnerapi`・`owneronlyapi`・Office 系の判定表を新しい式に更新。全 role の組合せで `/api/me` と一覧が一致すること、移行前後で同じになることを確認 |
| 影響しないもの | `manager` を使う非権限の処理（キャリア・週目標・入退社の担当者割当）、`hr` の人事管理権限、`/api/me` の応答の形（`access` のキーは同じ） |

## 5. 既存ユーザーの移行方法

§3 の SQL（2）で、今の役割から明示フラグを足す。`hr` 以外は**今と同じ範囲**になる。

| 今の役割 | 移行後に付くフラグ | 変わるか |
|---|---|---|
| owner | なし（owner が全部を含む） | 変わらない |
| manager | recruiter / sales / office | 変わらない（経理・事務、人事・労務は元から無し） |
| hr | recruiter / office（`hr` は残る＝人事・労務を使える） | **月末月初業務が新たに使える**（今は使えない。§6-5） |
| finance | office（`finance` は残る＝経理・事務を使える） | 変わらない |
| recruiter / sales | 変更なし | 変わらない |
| 会計の管理者 | 変更なし（変更不可の ON） | 変わらない |

移行後は、役割を付け外ししても入口は勝手に開かない（上のボタンで決める）。

## 6. 判断してほしい点

1. **Office ON の意味**: A（推奨）／B／C のどれにするか（§2.3）。
2. **経営を独立させるか**: 推奨は「経営＝経営者（owner）」のまま。独立した `keiei` フラグにすると、owner でない人が給与・経営指標を見られるので、給与の見せ方（`docs/keiei-salary-separation.md`）の判断が先に要る。
3. **経理・事務／人事・労務の DB（RLS）を「Office ON」でも絞るか**: 推奨は今回は API だけ（SQL を最小にする）。DB まで絞るなら `gw_is_office_finance` などの再定義が増える。
4. **#78 の扱い**: 今の「利用できる業務の細かい○×」は、この設計では不要になる。#78 は閉じるか、土台（`access` を一覧に返す部分）だけ残して作り直すかの判断。
5. **`hr`（人事）の人の月末月初業務**: 案 A で「経理・事務／人事・労務は Office が ON のときだけ有効」にすると、今は月末月初が使えない人事担当にも Office ON が付き、月末月初（単価・請求額・支払など金額の画面）が使えるようになる。避けたい場合は、(a) 人事・労務を Office フラグに依存させない（Office が OFF でも `hr` があれば Office の人事・労務には入れる）にするか、(b) 移行で `hr` の人に `office` を付けず、Office の人事・労務だけ今のまま残す。ただし (a)(b) は「一覧の Office が OFF なのに Office の一部に入れる」状態を作るので、推奨は**移行時に拡大を認めて、月末月初を外したい人だけ個別に OFF にする**運用。
