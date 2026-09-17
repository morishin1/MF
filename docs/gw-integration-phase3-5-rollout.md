# GW統合 優先3〜5 本番適用手順

対象: 業務イベント→共通タスク（優先3）／SES現場契約マスター（優先4）／月次請求進捗（優先5）／
管理者ダッシュボードの絞り込み
ブランチ: `claude/mf-system-workflow-check-xj2fad`

先にこれだけ: **`db/076`・`db/077` はまだ本番に流していません。** 流すまで、これらの機能は
「表が無い」として黙って無効化されます（cron・APIとも落ちません）。手順は下から。

管理者ダッシュボード（`admin-dashboard.html`）は `db/068_task_flow.sql`（期限超過・契約更新待ち
の数、is_template列）と `db/072_focus_tasks.sql`（今日の3つ）に依存する。どちらか未適用でも
`api/dashboard/team.js` は落ちない（068未適用なら画面全体が「まだ」表示、072未適用なら
「今日の3つ」欄だけ空欄になり、他の数はそのまま出る）。両方とも入社手続き・タスク機能の
前提として、このブランチより前から本番に入っている想定だが、念のため手順0で確認する。

## 0. いま何が流れているかを確認する

Supabase の SQL Editor で:

```sql
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('gw_tasks', 'gw_partner_companies', 'gw_site_contracts', 'gw_billing_progress')
 order by table_name;

select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'gw_tasks' and column_name = 'occ_key';

select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'gw_employees'
   and column_name in ('employee_kind', 'partner_company_id');
```

- `gw_tasks.occ_key` が無い → 先に `db/068_task_flow.sql` を流す（優先3の土台。無いと `api/cron/task-events.js` の二重防止が効かない）
- `gw_employees.employee_kind` が無い → `db/075_partner_bp.sql` が未適用。無くても優先3・4は動くが、
  月初のBP勤務表チェック（優先3の④）と現場契約の対象者選択（優先4）が空振りする
- `gw_site_contracts` / `gw_billing_progress` が無い → 下の手順1へ

## 1. SQL を流す（この順で）

Supabase の SQL Editor に貼って Run。すべて「べき等」（もう一度流しても壊れない）。

1. `db/068_task_flow.sql` … 未適用なら（優先3の前提）
2. `db/075_partner_bp.sql` … 未適用なら（優先3④・優先4の前提。無くてもエラーにはならないが機能が空になる）
3. `db/076_site_contracts.sql` … SES現場契約マスター
4. `db/077_billing_progress.sql` … 月次請求進捗（076のあと。`gw_site_contracts` へのFKがある）

## 2. RLS を確認する（自分のアカウントで）

`gw_site_contracts` / `gw_billing_progress` は `is_tenant_staff`（memberships が admin/staff の人）
だけに絞ってある。単価・精算条件・請求進捗は本人にも社労士にも見せない設計なので、これを確認する。

```sql
-- 管理者・staff の自分のアカウントで実行して、見えること
select id, site_company, unit_price from public.gw_site_contracts limit 5;
```

社労士アカウント（`labor_advisor` の権限付与のみで `memberships.role` が admin/staff でない人）で
同じクエリを実行すると **0件** になるはずです。0件にならない場合は、そのアカウントの
`memberships.role` を確認してください（意図せず admin/staff になっている可能性があります）。

```sql
-- そのアカウントの実際の role を見る
select m.role, e.display_name
  from public.memberships m
  join public.gw_employees e on e.user_id = m.user_id and e.tenant_id = m.tenant_id
 where e.display_name = '（確認したい人の氏名）';
```

参考: `is_tenant_staff` と `gw_is_hr` の違い（`db/000_install_fresh.sql` / `db/041_admin_is_hr.sql`）。
`gw_is_hr` は `hr`/`owner` の権限付与 **OR** `is_tenant_staff` の合成で、`is_tenant_staff` の
上位互換（より広い）。「人事だけ」に絞りたい場合、いまの2関数では表現できない
（`db/076_site_contracts.sql` 冒頭のコメントに詳細）。今回は075の書き込みポリシーと同じ考え方
（社内スタッフ全員）で作ってあり、変えていない。

## 3. cron の二重起票防止を確認する

`api/cron/task-events.js` は `occ_key`（`gw_tasks`）・一意制約
`(employee_id, billing_month, site_contract_id)`（`gw_billing_progress`）の2つで守られている。
本番デプロイ前に、ローカルで自動テストが通ることを確認：

```bash
node --experimental-test-module-mocks test/taskevents.mjs
```

「cronを続けて2回走らせても、タスクも請求進捗の行も増えない」が緑であることを確認する
（このテストは cron ハンドラを実際に2回連続で呼び、行数が変わらないことを見ている）。

本番適用後は、実際に2回叩いて確認する：

```bash
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://mf.8grp.co.jp/api/cron/task-events
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://mf.8grp.co.jp/api/cron/task-events
```

2回目の応答で `made` が `0`（1回目に何か作られていれば）になっていることを確認する。
SQL側でも数えられる：

```sql
select occ_key, count(*) from public.gw_tasks
 where occ_key like 'evt:%'
 group by occ_key having count(*) > 1;   -- 0件であること
```

## 4. Vercel cron の登録を確認する

`vercel.json` に `/api/cron/task-events`（`10 21 * * *` = 毎朝6:10 JST）を追加済み。
**Vercel の cron は Production デプロイにしか登録されない**（Preview ではスケジュール実行されない）。
このブランチを `main` にマージしてデプロイしたあと、Vercel ダッシュボードの
Project → Settings → Cron Jobs で `task-events` が一覧に出ていることを確認する。

`CRON_SECRET` 環境変数が設定されていれば、cronのURLを直接叩かれても弾かれる
（`api/cron/task-events.js` の先頭）。未設定の場合は認証なしで誰でも叩けてしまうので、
本番では必ず設定すること（他のcronと同じ変数を共用できる）。

## 5. 実データでのE2E確認（ここは人の手が要ります）

このセッションからは本番の Supabase に接続できないため、実データでの確認は
そちらで実施し、結果を貼っていただければ引き続き見ます。チェックリスト：

- [ ] 手順1のSQLを、本番相当の環境（できればステージング）に流す
- [ ] `admin-members.html` を開き、既存メンバーの1人に「現場契約」を1件登録できる
- [ ] 同じ画面の「今月の請求進捗」で「今月の進捗を用意する」→5つのチェックが進む
- [ ] 新規入社の手続きを1件作成し、`admin-tasks.html`（または対象者のホーム）に
      「〇〇さんの入社準備を進める」タスクが1件だけ出る（2件出ない）
- [ ] `/api/cron/task-events` を手で1回叩き、対象がいれば `gw_tasks` に行ができる
- [ ] もう一度叩いて、増えないことを確認（手順3のSQL）
- [ ] 076・077 未適用のテナントがもしあれば（マルチテナントで段階適用する場合）、
      そのテナントで `admin-members.html` の「現場契約」ボタンを押しても画面が落ちない
      （`notReady` 応答で空表示になることを確認）
- [ ] `admin-dashboard.html` を管理者アカウントで開き、担当者ごとに今日の3つ・完了数・
      期限超過・契約更新待ちが出る。タスクを押すと右ドロワーが開く（別画面へ飛ばない）
- [ ] 契約更新確認のタスク（優先3③）を1件、誰かに割り当てて、ダッシュボードの
      「契約更新待ち」に数が反映される

## ロールバック

- **機能だけ止めたい**（表は残したまま）: `vercel.json` から `task-events` の cron エントリを消して
  再デプロイ。API自体（`/api/site-contracts` `/api/billing-progress`）は
  `canManageHr` チェックのみなので、画面から使わなければ実害はない
- **表ごと戻したい**: `077` → `076` の順で `drop table`（077が076を参照しているため）。
  `gw_tasks` に増えた `evt:*` の occ_key の行だけ消したい場合は
  `delete from gw_tasks where occ_key like 'evt:%'`
