# 経営（`/keiei`）と入社準備 — 実装の現在地

Phase 0 報告（`docs/keiei-phase0-investigation.md`）のあと、決定いただいた内容と着手順に沿って実装した状況。
Phase 0 の記述のうち、権限・給与・ヘッダーに関するものは、この文書が新しい。

> **本番DBへの SQL の適用・`main` へのマージ・本番のメール送信は、まだ行っていない。**
> 反映の手順は `docs/keiei-production-rollout.md`。

## 1. 決定事項（反映済み）

| 項目 | 決定 | 状態 |
|---|---|---|
| 管理画面（`admin.html`）の「会計」 | **外さない。** 既存の管理者が行っている仕訳承認・試算表の実務は残す。`/keiei` へ会計を統合できた段階で整理する | 変更なし（`/keiei` の「会計」は入口・確認として併存） |
| owner の二段階認証のリセット | owner → 一般ユーザー 可 / owner → 他の owner 可 / **管理者・人事 → owner 不可** / 最後の owner が入れなくなったら緊急復旧（break-glass） | 実装済み（`api/mfa.js`）。手順は `docs/keiei-owner-recovery.md`（SQL は PostgreSQL 上で文書のまま実行して確認） |
| `unit_price` | **変更・移行・改名しない。** 実データを確認できる状態だけ。PP・BP それぞれ、売上単価・仕入単価・支払単価・粗利計算用単価のどれかを確定してから変更する。推測によるマイグレーションは禁止 | `docs/keiei-unit-price.md`（読み取り専用の SQL・確定表） |
| 入社案内・本人側オンボーディング | `/onboarding/` を作る。6ステップ（入社案内確認 / 雇用契約 / 入社情報入力 / 必要書類提出 / 会社確認 / 入社準備完了）。新しい状態判定は作らず、既存の判定を使う。本人に金額を出さない | 実装済み（§3） |
| 入社案内メール | 送信サービスを交換できる設計。送信元は `HR_ONBOARDING_FROM`。未設定なら実送信せず、案内URLをコピー。先に本人側を完成させ、そのあとメール | 実装済み（§3）。**本番では有効にしない**（`MAIL_SEND_ENABLED` が既定で止めている） |
| 給与の段階2 | まだ実施しない。先に `/keiei` に給与の入力・各種手当・通勤手当・契約賃金・変更履歴・監査ログの導線を作る。その後に、人事・管理者から給与閲覧権限を外す。給与業務を止めない | 未着手（次の段階） |
| 本番反映 | 本番DBへは適用しない。Draft PR を作成。`check_salary_exposure.sql` の実行手順。適用順は `099` → `100` → `HR_PAY_SPLIT=1` で再デプロイ → 動作確認 → `101` → `102` → `103`。異常があれば次へ進まない | 手順書を作成（`docs/keiei-production-rollout.md`）。`104` は独立した最後のステップ |

## 2. 着手順ごとの状況

| # | 内容 | 状態 | 主な場所 |
|---|---|---|---|
| ① | owner の付与・剥奪を現 owner だけに。履歴・最後の owner の保護・乗っ取り経路の遮断。**owner の MFA リセットも owner だけ** | 完了 | `lib/owner-guard.js`・`api/employees/*`・`api/mfa.js`・`db/099` |
| ② | 給与の漏えい対策（段階1: 採用担当・責任者に見せない） | 完了（API は即有効。DB は段階適用） | `lib/salary.js`・`lib/hr-pay.js`・`db/100`〜`103`・`docs/keiei-salary-separation.md` |
| ③ | `/keiei` の owner 専用権限（画面・API・DB） | 完了 | `lib/gw.js`（`canKeiei`）・`lib/keiei-gate.js`・`lib/mfa.js`（`requireMfaStrict`） |
| ④ | ヘッダー「経営」（データ駆動のツール切替） | 完了 | `js/layout.js`（`TOOLS`） |
| ⑤⑥ | `/keiei` の基本画面。経費・会計を接続 | 完了（売上・粗利・入金・残高は「データ未連携」） | `keiei/index.html`・`api/keiei/index.js` |
| ⑦ | 入社準備6ステップ | 完了 | `lib/onboard-six.js` |
| 新① | owner MFA 保護の仕上げ | 完了 | 上記 |
| 新② | `/onboarding/` 本人画面 | 完了 | `onboarding/index.html`・`api/onboarding/start.js`・`guide.js` |
| 新③ | 入社案内の作成・URL発行 | 完了 | `keiei/onboarding.js`・`api/keiei/onboarding.js`・`db/104` |
| 新④ | メール送信の接続（交換できる設計） | 完了（実送信は止めてある） | `lib/mail/` |

### 権限（3層で同じ条件）

| 業務 | 条件 |
|---|---|
| HR | `owner` or `manager` or `hr` or `recruiter` |
| Sales | `owner` or `manager` or `sales` |
| Office | `owner` or `manager` or `finance`（画面はまだ無いので、ヘッダーに出さない） |
| 経営 | `owner` のみ。さらに二段階認証（aal2）が**いつでも**必要 |

判定は `lib/gw.js` の1か所。ヘッダー・画面の入口・API・DB の RLS が同じ条件を使い、`test/accessparity.mjs` が食い違いを検出する。
owner は HR・Sales・Office から締め出されない。ほかのロールに、owner の閲覧権限は引き継がれない。

## 3. 入社準備（6ステップ・入社案内・メール）

詳細は `docs/onboarding-guide-mail.md`。要点:

- **新しい状態判定は作っていない。** `lib/onboard-six.js` が、既存の段階（`computeStage`）・キャリア（`careerStatus`）・契約・提出の事実を並べ替える。
  経営者の一覧と、本人の画面が同じ関数を使う（言い方だけが違う）。事実の組み合わせ 6,000 通り以上で、段階と食い違わないことをテストしている。
- 足りなかった事実だけを表にした（`db/104`）: 入社案内・発行した版・案内URL（ハッシュのみ）・メール履歴。すべて RLS は経営者のみ。
- 本人には、給与・手当などの金額を出さない。社内準備の内訳も出さない。案内に金額らしい表記を書くと、保存を断る。
- キャリア設計はステップに入れず、完了のあとの「次の一手」。

## 4. まだやっていないこと・これから

順番: ⑤ `/keiei` 給与管理 → ⑥ 給与の段階2 → ⑦ 売上・粗利・入金・BP支払・キャッシュ残高 → ⑧ Office

- **⑤ `/keiei` の給与管理:** 給与情報の入力・基本給・各種手当・通勤手当・契約賃金・変更履歴・誰がいつ変更したかの監査ログ。人事・管理者の給与業務が止まらないよう、導線を先に作る。
- **⑥ 給与の段階2:** 上ができてから。`SALARY_OWNER_ONLY=1` と `gw_can_see_salary` の差し替えを同時に（`docs/keiei-salary-separation.md`）。
- **⑦ 売上・粗利・入金・BP支払・キャッシュ残高:** `unit_price` の確定のあと。
- **⑧ Office。**
- 初回パスワードの設定URL（期限つき）。いまは、管理画面で作ったパスワードを担当者が別の方法で渡す運用（メールには書かない）。
- `lib/journey.js`・通知の「押す先」を `/onboarding/` へ切り替える（様子を見て）。
- MF の会計実績との照合。
