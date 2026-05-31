# 自社経理運用ツール（KessanPilot改）

このディレクトリは、マネーフォワード クラウド会計 MCP サーバーと連携した**自社1社の月次経理運用ツール**です。
税理士は決算と月次相談だけに絞り、毎月の仕訳・試算表作成は自分で完結させることが目的です。

## 会社情報（運用開始時に記入）

- 法人名: ___________________
- 事業内容: ___________________
- 会計期間: 4月開始 / 3月決算
- 課税区分: 課税事業者（インボイス登録: ___________________）
- 主要取引銀行: ___________________

## MCP接続

### サーバー設定
- 接続名: `mf-accounting`
- URL: `https://beta.mcp.developers.biz.moneyforward.com/mcp/ca/v3` （beta、2026/4/1〜）
- 認証: `Authorization: Bearer ${MF_ACCESS_TOKEN}`（`.env.local` から読み込み）

### セッション開始時の手順
1. `.env.local` に有効な `MF_ACCESS_TOKEN` が入っていることを確認
2. 利用可能ツール一覧で `mcp__mf-accounting__*` が見えることを確認
3. `data/company.json` の `mf_office_uuid` がセットされていなければ、まずMCPから事業者情報を取得して保存
4. 複数事業者を扱う場合はMCPセッション終了後に再設定が必要（自社1社運用なので通常不要）

### 主要MCPツール（想定）
- 事業者情報取得
- 会計年度設定取得
- 勘定科目/補助科目/取引先/部門の取得
- 仕訳の取得・新規作成・更新
- 残高試算表の取得
- 入出金明細の作成

実機の正確なツール名・パラメータ仕様はフェーズ1で確認し `.claude/skills/mf-journal-rules/SKILL.md` に記録してください。

## ディレクトリ構成

```
data/
  company.json              自社情報・MF office UUID
  master/                   MFマスタのキャッシュ
    accounts.json           勘定科目
    sub_accounts.json       補助科目
    partners.json           取引先
    departments.json        部門
    _fetched_at.json        最終取得日時
  periods/YYYY-MM/          月別データ
    journals_draft.json     未送信ドラフト
    journals_sent.json      送信済みログ（冪等キー）
    trial_balance.json      MF取得試算表
    closing_checks.json     月次締めチェック
    report.md               月次レポート
    tax_share/              税理士共有用エクスポート
  evidence/YYYY-MM/         証憑
    invoice/                請求書PDF
    receipt/                領収書画像
    bank/                   銀行CSV/明細
    card/                   カードCSV
    _index.json             証憑メタデータ
  templates/
    journal_patterns.json   過去仕訳パターン（学習用）
  log/
    mf_send_log.jsonl       MF API送信ログ（追記専用）
    audit.jsonl             操作監査ログ
backup/                     月次ZIPスナップショット
```

## 自社の勘定科目ルール（運用しながら追記）

以下はテンプレートです。実際の取引が発生したら確定し追記してください。

| パターン | 借方 | 貸方 | 税区分 |
|---|---|---|---|
| AWS/GCP/SaaS定期課金（月次） | 通信費 | 未払金 | 課仕10% |
| 国内交通費（タクシー/電車） | 旅費交通費 | 現金 | 課仕10% |
| 国内出張（宿泊込） | 旅費交通費 | 未払金/現金 | 課仕10% |
| 取引先会食（5,000円超） | 交際費 | 現金/未払金 | 課仕10%（損金不算入考慮） |
| 取引先会食（5,000円以下/人） | 会議費 | 現金/未払金 | 課仕10% |
| 書籍（業務関連） | 新聞図書費 | 現金/未払金 | 課仕10% |
| セミナー・研修 | 研修費 | 未払金 | 課仕10% |
| 文房具・消耗品 | 消耗品費 | 現金/未払金 | 課仕10% |
| 振込手数料 | 支払手数料 | 普通預金 | 課仕10% |
| 売掛金回収 | 普通預金 | 売掛金 | 対象外 |
| 売上計上（請求書発行時） | 売掛金 | 売上高 | 課売10% |

## 仕訳信頼度（confidence）の判定ルール

- **high**: 過去12件以上の類似パターンあり、かつ金額が過去平均の±30%以内
- **mid**: 類似パターン3〜11件、または金額が過去平均±30%超
- **low**: 新規取引先、または金額10万円超で初出、または手書き領収書のOCR

### 安全装置（必ず守る）
- **金額50万円超は必ずconfidence: low扱い**（自動承認させない）
- **月次締め後の修正は赤伝倒し＋新規**（送信済み仕訳の上書きはしない）
- **MF送信前に必ず `journals_sent.json` の `idempotency_key` チェック**で二重投入阻止

## 月次運用チェックリスト

毎月の経理締めはこの順で実行：

- [ ] 月初〜中旬: 前月の証憑を `data/evidence/YYYY-MM/` に集約（請求書PDF、領収書画像、銀行/カードCSV）
- [ ] `/月次仕訳 YYYY-MM` で証憑スキャン → AI仕訳ドラフト生成
- [ ] `journal-approval.html` をブラウザで開いて全件レビュー
- [ ] 必要なら修正してフラグを `approved` に更新
- [ ] `/仕訳投入 YYYY-MM` で承認済みをMFに送信
- [ ] `/試算表取得 YYYY-MM` でMFから残高試算表取得
- [ ] `report-generator.html` で当月の数値を確認
- [ ] `/月次締め YYYY-MM` でチェック項目（残高差異・滞留・異常値）を確認
- [ ] `/月次レポート YYYY-MM` で自己分析用レポート生成
- [ ] 月次相談前: `/税理士共有 YYYY-MM` で共有パッケージ生成・送付
- [ ] `data/periods/YYYY-MM/` を `backup/YYYY-MM.zip` にバックアップ

## ファイル編集時のルール

- `data/` 配下の JSON を直接編集する場合は事前に該当ファイルをバックアップする
- 既存の `js/mock-data.js` は段階的に廃止予定。フェーズ3以降は `data/*.json` を `js/data-loader.js` 経由で読む
- 既存HTMLの改修は `journal-approval.html` → `report-generator.html` → `dashboard.html` → `closing-check.html` の順で進める
- `client-report.html`、`biz/` 配下は自社1社運用では不要（`_archive/` へ退避済 or 退避予定）

## エラー・例外時の対応

- MF送信のタイムアウト: `mf_send_log.jsonl` に `status: unknown` で記録 → 次回MF仕訳一覧APIで `idempotency_key` を検索して確定
- マスタの不整合（MFに勘定科目を追加した直後など）: `/マスタ更新` で再取得
- 仕訳ドラフトの大量誤推論: `data/templates/journal_patterns.json` のパターンを見直す
