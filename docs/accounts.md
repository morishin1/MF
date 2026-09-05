# 社内システムのアカウント連携

エイトの社内システムは4つあり、**すべて同じ Supabase プロジェクトの同じ `auth.users` を使っている**。

```
                       auth.users            ← 共通のキー。ここが唯一の合流点
                            │ id
   ┌────────────┬───────────┴────────┬───────────────┐
gw_employees  profiles           tc_profiles     memberships
 .user_id      .id                 .id            .user_id
グループウェア  無限道場(LMS)   タイムカード・日報      会計
★人事の正
```

## なぜ新しい「社員マスタ」を作らないのか

`auth.users.id` が既に4システム共通のキーになっている。
ここに別の紐づけ表を足すと、

- 同じ人の情報が2か所にでき、必ずどちらかが古くなる
- どちらが正なのかを、直すたびに考えることになる
- 表を増やしても「入れる／入れない」の実体は各システムのままなので、
  台帳だけ直して実際は止まっていない、が起きる

そのため **表は増やさず、`gw_employees` を人事の正（source of truth）とする**。
氏名・入社・退職はここで決め、他はそこにぶら下がる。

## 各システムが持っているもの

| システム | 表 | キー | 「入れる／入れない」を決める列 |
|---|---|---|---|
| グループウェア | `public.gw_employees` | `user_id` → auth.users.id | `status`（invited / active / leaving / left） |
| 無限道場 | `public.profiles` | `id` = auth.users.id | `suspended_at`（停止）／ `approval_status='rejected'`（却下） |
| タイムカード・日報 | `public.tc_profiles` | `id` = auth.users.id | `status`（pending / active / disabled） |
| 会計 | `public.memberships` | `user_id` → auth.users.id | 行があるかどうか（role: admin / staff / client） |

`profiles` は無限道場のリポジトリ（`eight-its/lms`）が、
`tc_profiles` は 8grp-site の `8/timecard/` が作っている。
**このリポジトリはそれらの表を作らない。** 入口の開け閉めだけを書く。

## 何が自動で起きるか

### 追加したとき（`POST /api/employees` にメールを入れる、または「アカウントを作る」）

1. `auth.users` にアカウントを作る（初回パスワードは自動生成し、**画面に1回だけ出す**）
2. 無限道場側の `on_auth_user_created` トリガーが `profiles` を自動で作る
   （このため `user_metadata.name` に氏名を渡している。渡さないとメールの `@` より前が氏名になる）
3. `profiles` … 氏名を名簿に合わせ、`approval_status='approved'`、`suspended_at=null`
4. `tc_profiles` … 氏名・雇用区分を入れ、`status='active'`
5. `memberships` … 会計の `client` ロール（既にあれば触らない）
6. `gw_employees.user_id` に紐づけ

**無限道場のロール（`profiles.role`）は触らない。** 既定の `student` のまま。
社員も受講者として入る、という運用。講師・管理者にするかは無限道場側で決めること。

### 退職にしたとき（`status` を `leaving` / `left` に）

- `profiles.suspended_at = now()` … 無限道場に入れなくなる
- `tc_profiles.status = 'disabled'` … タイムカード・日報に入れなくなる
- `memberships` を削除 … 会計から外れる
- **`auth.users` は消さない**

`approval_status='rejected'` を使っていないのは、あちらでは「却下・アカウント削除」の
意味だから。退職は却下ではないので `suspended_at` で止める。

在籍（`active` / `invited`）に戻すと、上の逆をやって開け直す。

### 削除したとき

削除できるのは、経費・申請・予約・手続き・チャットの記録が**1件も無い人**だけ
（外部キーが cascade なので、消すとその記録ごと消える）。
記録がある人は「退職」を使う。

削除しても `auth.users` は残す。ただし名簿から外した以上、
上と同じように各システムの入口は閉じる。

## ログインアカウント（auth.users）を消さない理由

同じアカウントに、4システムぶんの記録がぶら下がっている。

- 無限道場の受講履歴・提出物
- タイムカードの打刻・日報・週次レビュー
- 経費精算・稟議・有給の申請と承認の記録
- 会計書類のアップロード履歴

`auth.users` を消すと、これらが外部キーの cascade でまとめて消える。
**「入れなくする」ことと「無かったことにする」ことは別**なので、前者だけをやる。

## 知っておくべきこと

### `tc_profiles.pw` は平文のパスワード列

タイムカードと旧日報（`8grp.co.jp/8/dr/`）の簡易ログインは、
`tc_login(氏名, パスワード)` という関数が `tc_profiles.pw` と文字列比較している。
Supabase の認証とは別物で、パスワードは平文で入っている。

このリポジトリから `tc_profiles` を作るときは **`pw` を入れない**。
入れると、旧画面へ入れる合鍵をこちらが勝手に作ることになる。
日報をグループウェア側へ移しているのは、この作りから離れるためでもある。

### tc_* の RLS は anon にも開いている

タイムカードが簡易ログイン（＝認証セッションを持たない）で動いているため、
`tc_*` は `for all to anon using (true)` になっている。
グループウェア側からの読み書きは必ず API（service_role）を通し、
「自分のものしか触れない」をアプリ側で担保している。
RLS を絞るとタイムカードが止まるので、そちらは変えられない。

### 1システムの失敗で他を巻き込まない

`lib/accounts.js` の書き込みはすべて例外を握りつぶし、
`{ok, action}` / `{ok:false, detail}` の形で結果を集めて画面に返す。
無限道場の表が読めない環境でも、社員の追加そのものは成功する。

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `lib/accounts.js` | 4システムの状態を読む・揃える・止める。ここが唯一の書き込み口 |
| `api/employees/index.js` | 名簿の追加・更新・削除。状態の変化に応じて上を呼ぶ |
| `api/employees/link.js` | 既存の社員にあとからアカウントを作る |
| `api/employees/bulk.js` | 表計算から貼った複数行をまとめて追加 |
| `admin-members.html` | 一覧の「利用中のシステム」列と、まとめて追加 |
