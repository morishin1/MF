# Sales → ローカルAI → ENGER DX マッチング連携（2026-11-07）

## 目的
Sales企業詳細／商談準備の「企業サマリー」をローカルAIに分析させ、**ENGER DXで実際に使う企業ニーズ（CompanyNeed）**へ変換する。

## 既存の正本
- 企業: \`enger.companies.id\`
- 本登録済みの案件: \`enger.jobs.id\`
- 本登録済みの人材: \`enger.candidates.id\`
- 確認された企業ニーズ: \`enger.dx2_company_needs\`
- 既存の本採点: \`enger_new/src/lib/data/company-needs-match.ts\` の \`getNeedMatches\` → \`rankCandidates\` / \`rankJobs\`

企業AI分析は上記を直接上書きしない。新しい保存先 \`enger.dx2_company_local_ai_profiles\`（db/162）は追記専用。Sales担当が目視確認したAI仮説の版を保持する。

## 操作
1. Salesの企業詳細 → 商談準備 → 「分析用MDをダウンロード」。
2. ローカルAIにMDを入力 → 指定JSONを出力（ローカル実行なのでAPI費用不要）。
3. JSONをSalesへ貼り付け → **自動分解**。企業ID・source_hash・出典IDを検証。
4. previewで \`role_labels\`、\`skills\`、\`salary_min/max\`、\`work_style\`、\`location\`、\`start_date\`、\`required_experience_years\`を確認。人材ID・案件IDは実際に会社IDへ紐づくものだけ許可。
5. 明示的な保存操作 → db/162に追記。複数版が保存され、元企業・人材・案件表は変えない。
6. ENGER DXの \`/companies/[id]/local-ai\`（別リポジトリPR）で、既存の \`getNeedMatches\` に変換して参考スコア・候補を表示。オファーは自動送信しない。

## ENGERのマッチング項目
| JSON | ENGERの正式モデル | CompanyNeed |
| --- | --- | --- |
| \`direction=talent\` | 仮想Job→rankCandidates | \`kind=talent\` |
| \`direction=job\` | 仮想Candidate→rankJobs | \`kind=job\` |
| \`role\`、\`role_labels\` | \`title\`、\`role_label\`、\`role_labels\` | \`title\`、\`roleLabels\` |
| \`skills\` | \`skills\` | \`skills\` |
| \`salary_min/max\`（万円/月） | \`salary_min/max\` | \`salaryMin/Max\` |
| \`work_style\` | \`remote_type\`または\`remote_pref\` | \`remoteType\` |
| \`location\` | \`work_location\` / \`location\` | \`workLocation\` |
| \`start_date\` | \`start_date\` / \`avail\` | \`startDate\` |
| \`required_experience_years\` | \`required_experience_years\` | \`requiredExperienceYears\` |

需要が複数種類あれば、企業単位で一括1件にせず、**ニーズ1件＝プロフィール1件**で分解する。

## 確認状態と運用制約
- AI分析は \`ai_unverified\`。Salesで登録しても企業確認済み案件・人材には変わらない。
- AIの元データが古ければ \`source_hash\` 不一致で取り込み拒否し、再エクスポートする。
- 既存DXの参考マッチングは**AI仮説への採点**であり、募集継続・所属承諾・単価確定・提案可否の証明ではない。
- 現在の \`dx2_company_needs\` へAI仮説をそのまま active に登録しない。\`auto_send=false\`・\`is_focus=false\`の安全設計で、人が確認したニーズだけ正式昇格する。
- 顧客確認済みニーズへの「昇格」操作（新規\`dx2_company_needs\`登録、差分検証、監査ログ）は別PRの範囲。勝手に変更しない。
- 人材・案件の社外非公開情報（所属、氏名、仕入単価等）はMDにも企業ポータルにも含めない。
- DB/161とDB/162は本番未適用、全体E2Eは未確認。**このPRを本番へマージしてはならない。**

## 受け入れ条件
- MDに会社ID、分析元のスナップショット、出典ID、出力JSON形式がある。
- 他企業ID、不正source_hash、未登録の出典、人材IDのなりすましを拒否。
- 必要なマッチング列に分解され、確認画面と保存した\`profile_json\`で一致。
- AI仮説のみでは自動オファー・自動注力・確定案件登録されない。
- ENGER DXは既存\`getNeedMatches\`で最大5候補を実データから取得する。
