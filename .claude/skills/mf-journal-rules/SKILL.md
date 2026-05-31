---
name: mf-journal-rules
description: マネーフォワード クラウド会計 MCP の仕訳API仕様・税区分コード・補助科目指定方法・複合仕訳の組み方と、自社の勘定科目割当ルールを参照する。仕訳ドラフト生成・MF送信時に必ず参照。
---

# マネーフォワード仕訳ルール

## MCP接続先
- URL: `https://beta.mcp.developers.biz.moneyforward.com/mcp/ca/v3`（beta、2026/4/1〜）
- 認証: `Authorization: Bearer ${MF_ACCESS_TOKEN}`
- 接続名（プロジェクトの `.mcp.json` で定義）: `mf-accounting`

## MCPツール（想定／実機確認後に修正）

> **注意**: 実際のツール名は MF MCP の `tools/list` で確認すること。
> フェーズ1で確認した正確な名称・パラメータをここに上書きしてください。

| 用途 | 想定ツール名 | 主要パラメータ |
|---|---|---|
| 事業者一覧 | `list_offices` | - |
| 事業者情報 | `get_office` | office_uuid |
| 会計年度設定 | `get_fiscal_year` | office_uuid |
| 勘定科目一覧 | `list_accounts` | office_uuid |
| 補助科目一覧 | `list_sub_accounts` | office_uuid, account_id |
| 取引先一覧 | `list_partners` | office_uuid |
| 部門一覧 | `list_departments` | office_uuid |
| 仕訳作成 | `create_journal` | office_uuid, date, description, lines, tax_categories... |
| 仕訳取得 | `get_journal` / `list_journals` | office_uuid, period, filter... |
| 仕訳更新 | `update_journal` | journal_id, ... |
| 残高試算表取得 | `get_trial_balance` | office_uuid, from, to |
| 入出金明細作成 | `create_statement` | office_uuid, ... |

## 仕訳ペイロード構造（想定）

```json
{
  "office_uuid": "...",
  "date": "2026-04-15",
  "description": "工具部品仕入（4月分）",
  "partner_id": "...",
  "department_id": null,
  "memo": "ksp_drf_2026-04_0001_v1",
  "lines": [
    {
      "side": "debit",
      "account_id": "...",
      "sub_account_id": null,
      "amount": 248000,
      "tax_category": "課対仕入10%"
    },
    {
      "side": "credit",
      "account_id": "...",
      "amount": 248000,
      "tax_category": null
    }
  ]
}
```

## 冪等性キーの埋め込み
- `memo` フィールドに `ksp_{draft_id}_v{n}` 形式で記録
- 送信前に必ず `data/periods/YYYY-MM/journals_sent.json` の `idempotency_key` を検索して二重投入阻止
- タイムアウト時は `list_journals` で `memo` を検索して確定

## 税区分コード（実機確認後に上書き）

| 名称 | コード（想定） | 用途 |
|---|---|---|
| 課対仕入10% | `課仕10%` | 標準税率仕入 |
| 課対仕入8%軽 | `課仕8%軽` | 軽減税率仕入 |
| 課税売上10% | `課売10%` | 標準税率売上 |
| 課税売上8%軽 | `課売8%軽` | 軽減税率売上 |
| 非課税売上 | `非売` | 非課税売上 |
| 不課税 | `対象外` | 給与・配当など |
| 課対仕入10%（控除80%） | `課仕10%控80` | インボイス未登録事業者からの仕入（経過措置） |

## 複合仕訳の組み方
- `lines` 配列に複数行を入れる
- 借方合計 = 貸方合計（必須）
- 税区分は各行ごとに指定可能
- 例: 売上に手数料控除がある場合
  ```
  借方: 普通預金 9,500 / 売掛金 10,000
  借方: 支払手数料 500（課仕10%）
  貸方: 売掛金 0
  ```

## 補助科目の指定
- `sub_account_id` で指定
- 補助科目マスタは `data/master/sub_accounts.json` から `account_id` で絞り込んで選択
- 例: 普通預金（三菱UFJ）、普通預金（みずほ）

## エラー時の挙動
- 4xx: 内容を確認しユーザーに通知、ドラフトの `send_status = "error"` に
- 5xx: リトライ可能、最大3回まで指数バックオフ（1秒→2秒→4秒）
- タイムアウト: `send_status = "unknown"` で記録、後日 `memo` 検索で確定

## 自社の運用ルール（CLAUDE.md と二重管理しない）
- 勘定科目の割当ルールは **CLAUDE.md** を参照
- 信頼度判定ルールも **CLAUDE.md** を参照
- ここでは **MF特有のAPI仕様** だけを扱う
