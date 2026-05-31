# 自社経理運用ツール（KessanPilot改）

マネーフォワード クラウド会計の **MCPサーバー** と連携し、自社1社の毎月の仕訳〜試算表〜月次レポートまでを **Claude Code 上で自走** させるための運用ツールです。

**目的**: 税理士は決算と月次相談だけに絞り、日常仕訳は自分で完結させる。

---

## アーキテクチャ

```
[Claude Code]  ← MCPクライアント（MF MCP）／AI仕訳推論／JSON読み書き
     ↕
[ローカルJSON] ← data/ 配下に永続化
     ↕
[HTML/JS UI]   ← 既存KessanPilot画面を実データバインドに改修
```

- ビルド不要（HTML + Vanilla JS + Chart.js のまま運用）
- データは `data/` 配下のJSON（gitignore対象）
- 認証情報は `.env.local`（gitignore対象）

> **ローカルプレビュー**: `dashboard.html` は `js/data-loader.js` が `data/*.json` を `fetch` で読むため、`file://` 直開きでは実データを読めません。簡易サーバ経由で開いてください。
> ```
> npx --yes http-server -p 8000 -c-1 .
> # → http://localhost:8000/dashboard.html
> ```

詳細設計は `CLAUDE.md` を参照。

---

## 初回セットアップ

→ [docs/SETUP.md](docs/SETUP.md) を参照

要約:
1. MFアプリポータルで MCP 連携権限を設定しアクセストークン取得
2. `.env.local.example` をコピーして `.env.local` を作成、トークンを記入
3. Claude Code を起動（`.mcp.json` が自動読込される）
4. `CLAUDE.md` の「会社情報」欄を埋める
5. `/マスタ更新` を実行して MF マスタを取得

---

## 月次運用フロー

| # | コマンド/操作 | 役割 |
|---|---|---|
| 1 | 証憑を `data/evidence/YYYY-MM/` に集約 | 人間 |
| 2 | `/月次仕訳 YYYY-MM` | Claude Code が AI 仕訳ドラフト生成 |
| 3 | `journal-approval.html` でレビュー・承認 | 人間 |
| 4 | `/仕訳投入 YYYY-MM` | 承認済みを MF 送信（冪等性チェック付） |
| 5 | `/試算表取得 YYYY-MM` | MFから残高試算表取得 |
| 6 | `/月次締め YYYY-MM` | 残高差異・滞留・異常値検出 |
| 7 | `/月次レポート YYYY-MM` | Markdown レポート生成＋バックアップ |
| 8 | `/税理士共有 YYYY-MM` | 月次相談用パッケージ生成 |

詳細は `CLAUDE.md` の月次運用チェックリストを参照。

---

## スラッシュコマンド一覧

`.claude/commands/` 配下に定義：

- `/マスタ更新` - 勘定科目/取引先/部門マスタを MF から再取得
- `/月次仕訳 YYYY-MM` - 証憑スキャン→AI仕訳ドラフト生成
- `/仕訳投入 YYYY-MM` - 承認済みドラフトを MF 送信
- `/試算表取得 YYYY-MM` - MF から残高試算表取得
- `/月次締め YYYY-MM` - 締めチェック項目検出
- `/月次レポート YYYY-MM` - 月次レポート生成
- `/税理士共有 YYYY-MM` - 月次相談用パッケージ生成
- `/未仕訳取込ぎ` - MF の未仕訳明細を取り込みドラフト化

---

## ディレクトリ構成

```
会計/
├── .mcp.json                MF MCP 接続定義
├── .env.local.example       環境変数テンプレート
├── .gitignore
├── CLAUDE.md                業務ルール・勘定科目ルール（最重要）
├── README.md                このファイル
│
├── dashboard.html           ダッシュボード
├── closing-check.html       月次締めチェック
├── journal-approval.html    仕訳承認（中核UI）
├── report-generator.html    月次レポート可視化
├── index.html               入口
│
├── css/
│   └── style.css
├── js/
│   ├── common.js
│   ├── data-loader.js       data/*.json を fetch で読む実データローダー
│   ├── mock-data.js         （段階削除予定。dashboard は脱却済）
│   ├── master.js            （将来追加）
│   └── period.js            （将来追加）
│
├── data/                    実データ（gitignore）
│   ├── company.json
│   ├── master/
│   ├── periods/YYYY-MM/
│   ├── evidence/YYYY-MM/
│   ├── templates/
│   └── log/
│
├── .claude/
│   ├── commands/            スラッシュコマンド
│   └── skills/
│       └── mf-journal-rules/
│
├── docs/
│   └── SETUP.md             初回セットアップ手順
│
├── _archive/                旧事務所向けデモ（参考用）
│   └── biz/
│
└── backup/                  月次ZIPスナップショット（gitignore）
```

---

## 段階的構築フェーズ

| Phase | 内容 | 完了条件 |
|---|---|---|
| 1 | MCP接続確認・基盤整備 | 事業者情報取得が成功、`data/company.json` の `mf_office_uuid` 確定 |
| 2 | 仕訳1件をMF投入 | 「現金/売上1,000円」が投入・重複阻止確認 |
| 3 | 証憑→AI仕訳→承認→投入フロー | 月10〜30件の証憑が一連でMF投入 |
| 4 | 試算表取得＋UI可視化 | MFと同期した試算表が画面表示・推移グラフ描画 |
| 5 | 月次レポート・税理士共有 | 1ヶ月の運用完走、税理士に月次資料送付 |
| 6+ | MF未仕訳自動取込、CSV自動仕訳、Vite/TS移行（必要なら） | - |

現在のフェーズは Phase 1 基盤整備中。

---

## セキュリティ

- `.env.local`（MFアクセストークン）と `data/`（業務データ）は **必ず gitignore**
- MF送信は **冪等性キー**で二重投入阻止
- 全 MF API 送信は `data/log/mf_send_log.jsonl` に追記、操作は `audit.jsonl` に追記
- 月次締め後 `data/periods/YYYY-MM/` を `backup/YYYY-MM.zip` へ自動圧縮

---

## 旧事務所向けデモから残したもの・捨てたもの

このリポジトリは元々「会計事務所向け AI 経理支援デモ」だった KessanPilot のUI を土台にしています。

**残したもの**:
- 仕訳承認の信頼度UI（高/中/低）
- 月次締めチェックの画面構造
- 試算表の Chart.js 可視化
- 経営レポートの構成

**捨てたもの**（`_archive/` へ）:
- 顧問先複数管理（事務所機能）
- `client-report.html`（顧問先マイページ）
- `biz/` 配下の「DriveKeiri」（法人マイページ）
