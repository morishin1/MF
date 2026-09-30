# `gw_site_contracts.unit_price` は何の単価か（未確定）

**結論: コードだけでは決められません。既存の値は、確認できるまで移行も改名もしません。**
`/keiei` Phase 1 は、この確認を待たずに進めています（売上・粗利は「データ未連携」）。

## 1. コードから分かること

| 観点 | 事実 | 読み取れること |
|---|---|---|
| 列 | `unit_price numeric(12,2)` と `unit_price_type`（月額 / 時給 / 日給）の**1組だけ**（`db/076_site_contracts.sql`） | 「顧客への請求単価」と「BP への支払単価」を**区別する列が無い** |
| 1行の単位 | 1人 × 1現場契約。`engagement_kind`（pp / bp）は**契約ごと**に持つ | PP・BP どちらの行にも同じ列に入る |
| 画面 | `admin-members.html` の現場契約。「所属会社（常駐先）」「上位会社」と並んで「単価」「単価の種類」。入力例は `700000`（月額） | 常駐先との条件として入力する画面に見える |
| 精算条件 | `settlement_condition` の例が「140h〜180h、超過1,500円/控除1,200円」（自由記述） | SES の**精算幅は、通常、客先との契約条件**。単価が客先向けである可能性が高い |
| BP の支払 | 請求進捗（`gw_billing_progress`）は `bp_invoice_received`（BP請求書の受領フラグ）だけ。BP への**支払額の列は無い** | 仕入の金額は、どこにも入っていない |
| 見える人 | 読み書きとも `is_tenant_staff`（管理者・スタッフ全員）。`canManageHr` が書き込み | 経営数値なのに、経営者だけの扱いになっていない（Phase 0 の J） |

つまり「客先への単価（売上側）」と読むのが自然ですが、**BP の行に入っている値が、客先単価なのか、BP への支払単価なのかは、運用次第**で、コードは決めていません。

## 2. 実データで確認する方法（読み取りだけ・変更なし）

Supabase の SQL Editor で、**経営者本人が**実行してください。`update` / `alter` は含みません。
結果には氏名・賃金が出るものがあります。ほかの人に貼らず、件数と傾向だけ教えてください。

```sql
-- Q1. 何件あり、単価がどれだけ入っているか（区分別）
select engagement_kind,
       count(*)                                   as 件数,
       count(unit_price)                          as 単価あり,
       min(unit_price)                            as 最小,
       percentile_cont(0.5) within group (order by unit_price) as 中央値,
       max(unit_price)                            as 最大
  from public.gw_site_contracts
 group by engagement_kind;

-- Q2. 単価の種類（月額・時給・日給）の内訳
select engagement_kind, unit_price_type, count(*)
  from public.gw_site_contracts
 where unit_price is not null
 group by 1, 2 order by 1, 2;

-- Q3. PP（自社社員）の行: 単価と、その人の契約上の賃金の比
--     単価が賃金の 1.2〜2 倍に並ぶなら「客先への売上単価」、ほぼ同じなら「原価（支払）」
select c.engagement_kind, c.unit_price_type, c.unit_price,
       k.wage_type, k.wage_amount,
       round(c.unit_price / nullif(k.wage_amount, 0), 2) as 単価÷賃金
  from public.gw_site_contracts c
  join public.gw_contracts k
    on k.employee_id = c.employee_id and k.status = 'active'
 where c.engagement_kind = 'pp' and c.unit_price is not null
 order by 単価÷賃金;

-- Q4. 同じ現場に複数人いるとき、単価が同じか（客先の単価表なら揃いやすい）
select site_company, engagement_kind, count(*) as 人数,
       count(distinct unit_price) as 単価の種類
  from public.gw_site_contracts
 where unit_price is not null
 group by 1, 2 having count(*) >= 2
 order by 人数 desc;

-- Q5. 上位会社が入っている行（多次請け）。上位会社がある行の単価が、どちらの会社との単価か
select engagement_kind, count(*) as 件数, count(prime_company) as 上位会社あり
  from public.gw_site_contracts group by 1;

-- Q6. 精算条件の書き方（140h〜180h・超過/控除の単価）。客先との条件なら、単価は売上単価の可能性が高い
select engagement_kind, unit_price_type, left(settlement_condition, 60) as 精算条件の例
  from public.gw_site_contracts
 where settlement_condition is not null
 order by engagement_kind limit 20;
```

あわせて、入力している担当の方に、次の1問を確認してください。

> 現場契約の「単価」に、いつも何を入れていますか？ （客先から受け取る単価 / BP に支払う単価 / 人によって違う）

## 3. 確定させること（PP・BP それぞれ）

`unit_price` が、次のどれを意味しているかを、**PP（自社プロパーの常駐）と BP（協力会社所属の常駐）のそれぞれについて**確定します。
確定するのは経営者です（実データ・入力している担当者の運用で確かめます）。

| 意味 | 説明 |
|---|---|
| 売上単価 | 客先（常駐先・上位会社）へ請求する単価 |
| 仕入単価 | BP 会社から仕入れる（BP 会社との契約上の）単価。原価の基準 |
| 支払単価 | 実際に支払う単価。仕入単価と同じとは限らない（手数料の控除後・個人BP・精算後 など） |
| 粗利計算用単価 | 粗利を計算するときに使う単価。売上単価−仕入単価か、PP は給与ベースの原価との差か、を決める |

記入表（確定したら、ここに書き込む。空欄のあいだは、何も変更しない）:

| | 現在の `unit_price` は | 確かめた方法（SQL の結果・担当者への確認） | 確定日 |
|---|---|---|---|
| PP の行 | （売上 / 仕入 / 支払 / 粗利計算用 / 行ごとに違う） | | |
| BP の行 | （売上 / 仕入 / 支払 / 粗利計算用 / 行ごとに違う） | | |

## 4. 進め方（確定するまで、何も変えない）

- **推測によるマイグレーションは禁止です。** 既存の `unit_price` の値・列名・型・RLS・画面の文言は、確定するまで、変更・移行・改名しません。
  いまあるのは、この文書の読み取り専用 SQL だけです（実データを確認できる状態）。
- 確定のあと、新しく金額を持つときは、**向きの分かる別の列**を足します（既存列の意味を書き換えない）。

  | 新しい列（案） | 意味 | 見える人 |
  |---|---|---|
  | `sales_unit_price` / `sales_unit_price_type` | 売上単価（客先へ請求） | 経営者。Sales・Office の必要範囲は、別途決める |
  | `purchase_unit_price` / `purchase_unit_price_type` | 仕入単価（BP 会社との契約上） | 経営者・Office の支払準備 |
  | `payment_unit_price` / `payment_unit_price_type` | 支払単価（実際に支払う基準）。仕入単価と同じなら、空でよい | 経営者・Office の支払準備 |

  粗利計算用単価は、列を増やさず、**計算の規則**（売上単価−仕入単価／PP は給与ベースの原価）として決めます。
- 既存 `unit_price` を新しい列へ写すのは、確定のあとに、**別の PR・別の migration** として行います。
  件数と差分をレビューし、行ごとに意味が違うなら、人が仕分けます（自動では写さない）。
- 売上・粗利は、この列（または Office の請求・仕入・支払の確定データ）ができてから出します。
  それまでの `/keiei` は「データ未連携」のままです（推測値は出しません）。

## 5. 関連

- Phase 0 報告 §7-3 の J（`unit_price` が管理者全員に読める）: 新しい列を足すときに、RLS を経営者・Office に絞る
- 売上の元データの方針: Sales の受注 → Office の稼働・請求・仕入・支払の確定 → `/keiei` で集計。MF は会計実績との照合用
