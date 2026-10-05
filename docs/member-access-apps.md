# メンバー管理：アプリ利用権限（4つのボタン）と内部ロールの分離

実装済み（db/119・lib/app-grants.js・lib/gw.js・api/employees/apps.js・admin-members.html）。

## 考え方
- メンバー一覧で設定するのは **採用HR / Sales / Office / 経営** の4つのボタンだけ。ONは「そのアプリへ入れる」だけを意味する。
- `owner / hr / finance / manager / recruiter / sales / it / labor_advisor`（内部ロール, `gw_role_grants`）は、アプリの中で何ができるかを決める。一覧には出さず、行の「詳細設定」にだけ出す。
- **ロールを付けても入口は開かない。ボタンを ON にしても、中の業務は内部ロールが決める。**

## 判定（lib/gw.js）
```
入口   hr     = owner または gw_app_grants.app_key='hr'
       sales  = owner または gw_app_grants.app_key='sales'
       office = owner または 会計の管理者 または gw_app_grants.app_key='office'
       keiei  = owner（保存しない。owner から導出）
中身   月末月初   = 入口(office) かつ (owner | manager | finance)
       人事・労務 = 会計の管理者 | owner | (入口(office) かつ hr)
       経理・事務 = 会計の管理者 | owner | (入口(office) かつ finance)
       人事の管理権限（canManageHr・給与の閲覧の土台）= 会計の管理者 | owner | (入口(office) かつ hr)
```
- Office を ON にしただけでは、人事・労務・経理・事務・月末月初のどれも使えない（`access.officeApp` で Office へは入れる）。
- 経営者（owner）は4つとも ON 固定、会計の管理者は Office が ON 固定（行を作らない）。

## 保存先（db/119）
`gw_app_grants(tenant_id, employee_id, app_key, granted_by, created_at)`。app_key は `hr / sales / office` の3つだけ（経営は保存しない）。
RLS：読めるのは社内の管理者・人事・自分の行。付け外しは人事（`gw_role_grants` と同じ考え方）。DB の判定関数（`gw_is_hr` など）は、この PR では変えない。

## 既存ユーザーの移行（db/119 の INSERT）。実効権限は変わらない
| 内部ロール | 足すアプリ利用権限 |
|---|---|
| manager | hr, sales, office |
| hr | hr, office（**月末月初は付かない**） |
| recruiter | hr |
| sales | sales |
| finance | office |
| owner・it・labor_advisor・会計の管理者 | なし（owner と会計の管理者は暗黙の入口） |

内部ロールは1行も変えない・消さない。

## 安全装置
- **表が無い間（db/119 を流す前）**：内部ロールから上の規則どおりに入口を導出する。結果は移行前と同じ（権限は増えも減りもしない）。メンバー一覧のボタンは変更できない表示（理由つき）。
- **表が読めなかった（障害）**：入口を出さない（権限を広げない）。経営者・会計の管理者の暗黙の入口だけ残る。
- 移行前後の同値は、全ロールの組合せ（256通り×会計の管理者）で `test/appgrants.mjs` が確かめる。SQL は pglite（Postgres 互換）で、512人分の組合せに流して差分 0・べき等・RLS を確かめた。

## 実行順
1. `db/check_app_grants_dryrun.sql` … 読み取りだけ。差分が **0 行** であることを確認（1行でも出たら止める）
2. `db/119_app_grants.sql` … 表・RLS・`gw_has_app()`・移行の INSERT（べき等）
3. `db/check_app_grants_after.sql` … 差分が **0 行** であることを確認
4. アプリをデプロイ（順序を間違えても、表が無い間は内部ロールから導出するので権限は変わらない）

DB の判定関数（`gw_is_hr / gw_is_recruiting / gw_is_sales / gw_is_office / gw_is_office_finance`）をアプリ利用権限へ切り替える SQL は、次の PR。

## 元に戻す
```sql
drop function if exists public.gw_has_app(uuid, text);
drop table if exists public.gw_app_grants;
```
内部ロールは変えていないので、戻しても元の権限のまま。
