# 初回セットアップ手順

このドキュメントの通りに進めれば、Phase 1（MCP接続確認）まで完了します。

## 0. 前提条件

- マネーフォワード クラウド会計 の有料プランを利用中（MCP は追加料金なしで使える）
- Claude Code をインストール済み（CLI または IDE 連携）
- Node.js（将来 `npx serve` でローカルサーバー起動する場合に必要）

## 1. MF アプリポータルで MCP 連携権限を設定

1. MF アプリポータルにログイン
2. ユーザーに対して「アプリ連携権限」を付与
3. MCP 連携用のアクセストークンを発行
4. **重要**: 「認可コードを AI ツールの学習に使用しない」設定を有効化

詳細手順は MF 公式: https://biz.moneyforward.com/support/account/guide/others/ot10.html

## 2. 環境変数の設定

1. `.env.local.example` をコピーして `.env.local` を作成
2. `MF_ACCESS_TOKEN` に手順1で発行したトークンを記入
3. `MF_OFFICE_UUID` は空のままでOK（Phase 1 完了時に自動で埋まる）

```
cp .env.local.example .env.local
# .env.local をエディタで開いてトークンを記入
```

## 3. Claude Code 起動

このディレクトリで Claude Code を起動。`.mcp.json` が自動的に読み込まれ、`mcp__mf-accounting__*` のツールが利用可能になります。

起動後、次のコマンドで接続確認:

```
利用可能なMCPツール一覧を見せてください
```

`mcp__mf-accounting__*` が出力されればOK。

## 4. 会社情報の登録

`CLAUDE.md` の冒頭にある「会社情報」セクションを編集:

- 法人名
- 事業内容
- 会計期間（4月開始/3月決算 がデフォルト、異なれば修正）
- 課税区分・インボイス登録番号
- 主要取引銀行

自社の勘定科目ルール（AWS→通信費、タクシー→旅費交通費、など）も `CLAUDE.md` で確認・修正してください。

## 5. Phase 1 完了確認

Claude Code で次を実行:

```
/マスタ更新
```

これで MF から事業者情報・勘定科目・取引先などが取得されます。

完了条件:
- [ ] `data/company.json` の `mf_office_uuid` が埋まる
- [ ] `data/master/accounts.json` の `items` に勘定科目が入る
- [ ] `data/master/partners.json` の `items` に取引先が入る
- [ ] `data/log/audit.jsonl` に `master_update` のログ1行
- [ ] `.claude/skills/mf-journal-rules/SKILL.md` の「MCPツール（想定）」表を、実際に取得できたツール名で更新

ここまで来れば Phase 1 完了です。

## 6. 次のステップ

### Phase 2: 仕訳1件を MF に投入

`data/periods/2026-05/` を手動作成し、`journals_draft.json` に1件だけテスト仕訳を書く:

```json
{
  "period": "2026-05",
  "items": [{
    "draft_id": "drf_2026-05_0001",
    "evidence_ref": "",
    "date": "2026-05-17",
    "description": "テスト仕訳",
    "lines": [
      { "side": "debit",  "account_id": "（現金のaccount_id）", "amount": 1000 },
      { "side": "credit", "account_id": "（売上高のaccount_id）", "amount": 1000, "tax_category": "課売10%" }
    ],
    "partner_id": null,
    "confidence": "high",
    "ai_reason": "手動テスト",
    "approval": { "status": "approved", "approved_by": "manual", "approved_at": "2026-05-17T10:00:00+09:00" },
    "send_status": "not_sent"
  }]
}
```

そして:

```
/仕訳投入 2026-05
```

MF 側で当該仕訳が登録されることを確認。次に同じコマンドを再実行して、冪等性チェックでスキップされることを確認できれば Phase 2 完了。

### Phase 3 以降

- サンプル請求書PDFを `data/evidence/2026-05/invoice/` に置いて `/月次仕訳 2026-05`
- `journal-approval.html` を改修して `journals_draft.json` をバインド
- `report-generator.html` を改修して `trial_balance.json` を描画

README の段階構築フェーズ表を参照。

## トラブルシューティング

### MCP ツールが見えない
- `.env.local` のトークンが期限切れの可能性 → MF アプリポータルで再発行
- Claude Code を再起動

### マスタ取得でエラー
- MF アプリポータルで権限不足の可能性 → 「事業者情報読み取り」「マスタ読み取り」権限を確認
- 複数事業者を持っている場合、セッション再設定が必要

### 仕訳投入が失敗する
- `data/master/accounts.json` が古い可能性 → `/マスタ更新` で最新化
- 税区分コードが MF 仕様と異なる → `.claude/skills/mf-journal-rules/SKILL.md` を実機仕様で更新

### `data/` をうっかり git に追加してしまった
```
git rm -r --cached data/
git commit -m "Untrack data/"
```
