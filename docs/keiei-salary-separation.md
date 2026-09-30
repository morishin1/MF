# 給与情報の分離（案A）— 進め方と現在地

給与を見られる人の最終形は次のとおり。

- **経営者（owner）**: 全員分
- **本人**: 自分の分だけ
- 人事・管理者・責任者・採用担当・経理・IT・営業: 見られない
- 社労士: 実際の労務手続きで必要な範囲だけ、個別に許可する

「経営者だけ」にすると、人事・管理者が給与を入力・確認している業務
（労働条件通知書の賃金欄、登録、契約台帳）が止まる。そのため、次の2段階で絞る。

| 段階 | 見られる人 | いつ |
|---|---|---|
| **段階1（いま）** | 経営者・人事・管理者・本人 | 採用担当・責任者に見せない。これが最優先で、実施済み |
| **段階2** | 経営者・本人だけ | `/keiei` で経営者が給与を入力・承認できるようになってから |

> 各機能は、環境変数 1 つで切り替える。DB 側も、関数 1 つの差し替えで切り替える。
> どちらも、段階1と段階2で同じ条件にそろえること。

---

## 1. 段階1で塞いだもの

### 1-1. API（実装済み・すぐ有効）

判定は `lib/gw.js` の `canSeeSalary`。見られない人の応答からは、`lib/http.js` の `json()`（唯一の出口）で、給与のキーが入れ子の中まで一括で外れる（`lib/salary.js`）。入力からも外れるので、見えていない値を保存で `null` に上書きしてしまう事故も起きない。

| API | 採用担当 | 責任者 |
|---|---|---|
| `/api/hr/applicants`（一覧・詳細・追加・更新） | 給与が返らない・書けない | （採用HRには、まだ入れない） |
| `/api/hr/offers`（作成・修正・確定・URL 発行・送付） | 給与が返らない・書けない。ただし合格通知は作れる（応募者の条件はサーバ側で引き継ぐ） | 同上 |
| `/api/hr/ceo-review`・`/api/hr/applicants/advance` | （社長・管理者だけの機能） | — |
| `/api/career`（責任者が部下の評価を扱える） | — | 現在給与・給与レンジ・給与メモ・昇給の判断が返らない・書けない |

画面は `hr/applicants.html` が、給与を見られない人には給与の欄を出さない。

### 1-2. DB（応募者・合格通知の給与）

RLS は列を隠せない。`gw_hr_applicants` / `gw_hr_offers` に給与の列がある限り、採用担当は DB から直接読める。
給与を専用の表 `gw_hr_pay` に置き、その表を `gw_can_see_salary` だけの RLS にする。

- `db/100_hr_pay.sql` — 関数 `gw_can_see_salary`・表 `gw_hr_pay`・いまの給与の移行。**流しても動きは変わらない**
- `db/101_hr_pay_clear.sql` — 元の列を空にして、書けなくする。**ここで初めて DB から読めなくなる**
- `db/102_contracts_pay_rls.sql` — 契約（`gw_contracts`）の賃金の RLS を `gw_can_see_salary` に。責任者が直接読む道を塞ぐ（035 に依存しない）

## 2. 適用の順序（本番）

**先に `db/check_salary_exposure.sql` を流して、いまの状態を確かめる**（読み取りだけ）。
`035・041・094` が本番に当たっているかも、ここで分かる。

```
① db/099_owner_only.sql        … owner 専用（先に。給与の判定が owner に依存するため）
② db/100_hr_pay.sql            … 流すだけ。動きは変わらない
③ db/check_salary_exposure.sql … 「元の列にだけ給与があるもの」が 0 件であること
④ Vercel: HR_PAY_SPLIT=1 → 再デプロイ
   → 応募者・合格通知の画面で、給与が正しく出ることを確かめる
⑤ db/101_hr_pay_clear.sql      … 元の列を空にする（安全装置が、写し漏れを止める）
⑥ db/102_contracts_pay_rls.sql … 契約の賃金の RLS
```

④と⑤のあいだに元の列へ書き込みが入ると、新しい表とずれる。間を短くする（④のあと、⑤は「ずれがない」ことを確かめてすぐ）。

### 元に戻す
- ④の前: `drop table gw_hr_pay; drop function gw_can_see_salary;`
- ⑤のあと: **先に** `db/101` の「C. 元に戻す」で、`gw_hr_pay` から元の列へ書き戻し、制約を外す。そのあと `HR_PAY_SPLIT` を外す。順序を逆にすると、給与が読めなくなる

## 3. 段階2にするとき

すべて、次の3つをそろえて切り替える。

1. アプリ: 環境変数 `SALARY_OWNER_ONLY=1`（`canSeeSalary` が経営者だけになる）
2. DB: `create or replace function public.gw_can_see_salary(uuid) ... select public.gw_is_owner(p_tenant)`
3. **先に、`docs/keiei-pay-management.md` §12「給与の段階2へ進むための完成条件」を満たし、下の「未完了」を終える**（そうしないと、人事・管理者の業務が止まる）。とくに、`/keiei` の給与管理への記録と、`db/check_pay_reconcile.sql` の差分が 0 になったことの確認（`docs/keiei-pay-management.md` §8）

`test/salaryguardapi.mjs`・`test/careerapi.mjs`・`test/sql/*.sql` が、段階1と段階2の両方を確かめている。

## 4. 未完了（段階2の前に必要）

> **`/keiei` の給与管理を作った**（`db/105`・`docs/keiei-pay-management.md`）。現在の給与額の正は `gw_compensations`（履歴つき・追記だけ・監査つき・経営者専用）になった。
> 下の表のうち、1・4・6 は、この表を使って進められるようになった。ただし**既存データの移行と、読み先の切り替えは、まだしていない**（突き合わせのあとに、別の承認で行う: `docs/keiei-pay-management.md` §8）。
> **段階2は、この工程では行わない**（人事・管理者の既存の給与閲覧権限は変えていない）。


| # | 内容 | 場所 | 状態 |
|---|---|---|---|
| 1 | 契約（`gw_contracts`）の賃金を、専用の表（`gw_compensations`。履歴つき）へ。**表は作った（`db/105`）。契約からの移行・読み先の切り替えは未着手。**`api/contracts`・`admin-contracts.html`・`api/career`・`api/onboarding/*`・`lib/onboard.js`・`lib/career-member.js`（本人の自己参照） | `db/029`・`api/contracts/index.js` ほか | 移行・切り替えは**未着手**。RLS だけ 102 で絞った。契約の賃金は「参照」に位置づけた（給与の正ではない） |
| 2 | 労働条件通知書の賃金欄（`gw_doc_orders.conditions`）・署名依頼の本文（`body_snapshot`・`merged_fields`）・PDF | `api/sign/*`・`lib/esign.js` | **未着手**。賃金入りの署名済み PDF は不変の証跡で、過去分は人事が読める状態が残る |
| 3 | 給与入り PDF の置き場所。いまは単一バケット `hr` を、テナント単位の policy で守っている。専用バケットと、経営者・本人だけの Storage policy が要る | `db/012` | **未着手** |
| 4 | 通勤手当（`gw_onboard_profiles.commute_cost`）・給与 CSV（`lib/payroll-csv.js`、社労士の個別権限） | `api/hr/payroll.js` | 会社が決める通勤手当は `gw_compensations.commute_amount` に持てる。CSV の読み先（基本給＝契約、通勤手当＝届出）の切り替えは**未着手**（食い違いは `db/check_pay_reconcile.sql` が見張る） |
| 5 | 操作ログの差分に賃金が混ざる（`gw_activity_log.detail`）。管理者が `/api/settings` で読める | `api/contracts`・`api/sign/orders.js` | **未着手** |
| 6 | 登録・CSV 取込（`admin-onboard.html`・`lib/intake.js`）の給与欄。経営者が入力する導線を `/keiei` に作る | `api/employees/onboard.js` ほか | 経営者が入力する導線は `/keiei#pay` にできた。登録・CSV取込の給与欄を外すのは**未着手** |
| 7 | 給与レンジ（`gw_career_levels.salary_min/max`）・昇給判断（`gw_career_reviews.salary_decision/note`） | `db/092` | RLS は `gw_is_hr`。専用の表へは未着手 |

**落とし穴**: `updateContract`（`api/contracts/index.js`）は、body に賃金のキーが無いと `wage_*` を `null` で上書きする。賃金欄を UI から外して呼ぶと、賃金が消える。1 を進めるときは、まずここを直す。

## 5. 賃金を持たないもの（HR に残す）

雇用区分・入社日・契約期間・試用期間・勤務形態・締結状況は、そのまま HR に残す（列が独立している）。
HR には「契約作成済み」「本人送信済み」「署名済み」などの状態は見せてよいが、金額と給与入り PDF の本文は見せない。
