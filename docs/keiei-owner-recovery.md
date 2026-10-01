# 経営者（owner）の緊急復旧手順（break-glass）

通常の画面から、経営者（owner）を乗っ取れる経路は残していません。
そのため、**経営者が1人だけで、その人がログインできなくなった**ときは、画面からは復旧できません。
このときだけ、Supabase の SQL Editor（RLS を通らない）で復旧します。

## 0. 先に読む

- **経営者は2人以上にしておく**のが、いちばんの備えです。
  経営者どうしなら、画面から認証をリセットできます（管理者・人事にはできません）。
  最後の経営者は、画面・DB のどちらからも外せず、消せず、退職にもできません（`db/099`）。
- この手順は **Supabase プロジェクトへの管理権限がある人**だけが実行できます。
  実行する人は、本人確認（電話・対面など、メールとは別の経路）をしてから始めてください。
- 実行は **2人で**（実行者＋確認者）。実行したことは、下の SQL で必ず記録に残します。
- SQL は、対象のユーザー ID を確かめてから、**1文ずつ**実行してください。`<...>` は置き換えます。
- 復旧のあと、心当たりのない操作がないか、§4 で確かめます。

## 1. どの場合か

| 状況 | 使う手順 |
|---|---|
| A. 経営者が認証アプリ（端末）を失った。**パスワードはわかる** | §2-A |
| B. パスワードもメールも使えない | §2-B → §2-A |
| C. 経営者が誰もいなくなった（在籍する経営者が0人） | §2-C |
| D. 経営者のアカウントを乗っ取られたかもしれない | §3 |

## 2. 復旧

### 2-A. 認証アプリを失った（二段階認証をリセットする）

ほかに経営者がいるなら、画面（管理 → メンバー → 対象の経営者 → ログイン → 二段階認証をリセット）から、その経営者が行えます。
**いないとき**だけ、次の SQL で行います。

```sql
-- 1. 対象を特定する（経営者のメールで）
select e.id as employee_id, e.tenant_id, e.display_name, e.status, e.user_id, u.email
  from public.gw_employees e
  join auth.users u on u.id = e.user_id
 where u.email = '<経営者のメール>';
-- → 1行だけ出ること。user_id をひかえる

-- 2. その経営者であることを確かめる（owner のロールがある）
select role from public.gw_role_grants where employee_id = '<employee_id>' and role = 'owner';
-- → 1行

-- 3. 現在の認証の登録
select id, factor_type, status, created_at from auth.mfa_factors where user_id = '<user_id>';

-- 4. 外す（ここが実際の変更。まとめて1回で）
begin;
delete from auth.mfa_factors where user_id = '<user_id>';
delete from auth.sessions    where user_id = '<user_id>';   -- 今のログインも切って、次回からやり直す

-- 画面のリセットと同じ表に残す（7日のあいだに登録し直してもらう）
insert into public.gw_mfa_resets (tenant_id, user_id, employee_id, expires_at, note)
select e.tenant_id, e.user_id, e.id, now() + interval '7 days',
       'break-glass: SQL による緊急復旧。依頼者=<名前> 確認者=<名前> 理由=<理由>'
  from public.gw_employees e where e.user_id = '<user_id>';

-- 操作の記録（誰が・なぜ）。実行者・確認者・理由を書く
insert into public.gw_activity_log (tenant_id, actor_id, action, target, detail)
select e.tenant_id, null, 'owner.break_glass_mfa_reset', 'employee:' || e.id,
       jsonb_build_object('by', '<実行者>', 'confirmedBy', '<確認者>', 'reason', '<理由>')
  from public.gw_employees e where e.user_id = '<user_id>';
commit;

-- 5. 確認: 認証が0件になっている
select count(*) from auth.mfa_factors where user_id = '<user_id>';   -- → 0
```

そのあと、経営者本人にログインしてもらい、マイページ（`/mypage.html#mfa`）で認証アプリを登録し直してもらいます。
二段階認証は任意なので、登録を待たずに、パスワードだけで `/keiei` に入れます（登録し直すかどうかは、本人が決めます）。

> Supabase の管理画面（Authentication → Users → 対象のユーザー）にも、認証の登録を外す操作があります。
> 画面の名称は変わることがあるので、使う場合は、外したあとに上の手順 5 で件数を確かめ、
> 記録（`gw_mfa_resets`・`gw_activity_log` への insert）だけは SQL で残してください。

### 2-B. パスワードも、メールも使えない

1. 本人確認（§0）を済ませる。
2. Supabase の管理画面（Authentication → Users → 対象のユーザー）で、パスワードの再設定を行う。
   **新しいパスワードは、本人へ直接（口頭・対面）伝え、チャット・メールには書かない。** 初回ログインで本人が変える。
   メールアドレスを変える必要があるときは、同じ画面で変更し、`gw_employees.email` も合わせる。
3. 続けて §2-A（認証アプリの登録を外す）。

### 2-C. 経営者が誰もいなくなった

DB のトリガは「消す・変える」だけを止め、付けるのは止めません。SQL Editor から、在籍中の人に付け直します。

```sql
insert into public.gw_role_grants (tenant_id, employee_id, role)
select e.tenant_id, e.id, 'owner'
  from public.gw_employees e where e.email = '<経営者になる人のメール>'
on conflict (employee_id, role) do nothing;

insert into public.gw_activity_log (tenant_id, actor_id, action, target, detail)
select e.tenant_id, null, 'owner.break_glass_grant', 'employee:' || e.id,
       jsonb_build_object('by', '<実行者>', 'confirmedBy', '<確認者>', 'reason', '<理由>')
  from public.gw_employees e where e.email = '<経営者になる人のメール>';
```

付けた人は、パスワードだけで `/keiei` に入れます（二段階認証は任意）。復旧のあと、**すぐに2人目の経営者を付けて**ください。

## 3. 乗っ取りが疑われるとき

1. **先に止める**（§2-A の 4 の `auth.sessions` の削除）。対象の経営者のログインを、全部切る。
2. パスワードを再設定する（§2-B）。認証アプリの登録も外し（§2-A）、本人に登録し直してもらう。
3. §4 で、疑わしい操作を洗い出す。
4. 経営者のロール・名簿・ログインが書き換えられていれば、直す（§2-C。直すのも SQL で、記録を残す）。

## 4. 復旧のあとの確認（読み取りだけ）

```sql
-- 経営者の付与・剥奪・二段階認証のリセット・名簿やログインの変更の履歴（新しい順）
select ts, actor_id, action, target, detail
  from public.gw_activity_log
 where tenant_id = '<tenant_id>'
   and (action like 'owner.%' or action like 'mfa.%' or action like 'role.%' or action like 'employee.%')
 order by ts desc limit 100;

-- 試みて止められた操作（管理者・人事による、経営者の認証リセット）
select ts, actor_id, target, detail from public.gw_activity_log
 where tenant_id = '<tenant_id>' and action = 'mfa.reset_denied' order by ts desc limit 50;

-- いまの経営者（在籍中）
select e.display_name, e.status, e.email
  from public.gw_role_grants g join public.gw_employees e on e.id = g.employee_id
 where g.tenant_id = '<tenant_id>' and g.role = 'owner' order by e.display_name;
```

- 経営者が2人以上いること。
- 知らない人に、経営者の権限が付いていないこと。
- 経営者のメールアドレス・パスワードが、知らない間に変わっていないこと。

## 5. 通常の画面が守っていること（参考）

| 操作 | 経営者 | 管理者・人事 |
|---|---|---|
| 一般ユーザーの認証をリセット | できる | できる |
| ほかの経営者の認証をリセット | できる（二段階認証は要らない） | **できない**（403・試みを記録） |
| 自分の認証をリセット | できない | できない |
| 経営者の付与・剥奪 | 現経営者だけ。最後の1人は外せない | できない |
| 経営者のメール・パスワードの変更、退職・削除 | 現経営者だけ。最後の1人は不可 | できない |

経営者の認証がリセットされたときは、本人と、ほかの在籍中の経営者に通知が届きます。
