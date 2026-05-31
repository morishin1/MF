# システム構成（設計方針）

会計事務所が顧問先に提供する **書類PDF → AI仕訳 → 各会計ソフトへ連携** するマルチテナントSaaS。
本書は会計士レビュー用の設計概要。セキュリティ詳細は [security.md](security.md) を参照。

## 確定した方針（推奨採用）

| 項目 | 決定 |
|---|---|
| 対応会計ソフト | **まず MF（マネーフォワード）優先**。freee/弥生はアダプタ層で後追い |
| テナント分離 | **共有DB + RLS（行レベルセキュリティ）** で開始。高保証要件が出たらDB分離を検討 |
| 自動化レベル | **AIはドラフト生成まで。投入前に必ず人が承認**（完全自動投入はしない） |
| データ所在地 | 日本リージョン（東京） |

## 全体像

```
[顧問先ユーザー] ─┐  ログイン(MFA)
[事務所スタッフ] ─┤
                  ▼
   [フロント: HTML/JS (将来 Next.js) @ Vercel]
                  │  署名付きURLでPDFアップロード
                  ▼
   [バックエンド: Supabase Edge Functions / Vercel Node API]
     ・テナント境界の強制   ・トークン復号はサーバ内のみ
        │              │                 │
   [Storage]       [Postgres]        [AI: Claude API]
   PDF書類          仕訳/試算表等       PDF読取→勘定科目・
   テナント別        全行 tenant_id      税区分を推論(ゼロ保持)
   署名URL/RLS       + RLS              ↓ ドラフト生成
        │              │           （人が承認）
        │              ▼
        │     [会計ソフト連携アダプタ] → MF / freee / 弥生
        │       顧問先ごとのOAuthトークンを暗号化保管
        ▼
   [監査ログ(追記型)] 誰が・いつ・どのテナントの何を見た/送ったか
```

## 処理フロー

1. 顧問先が書類PDFをアップロード（Drive風の置き場 = Supabase Storage）
2. AI（Claude API）がPDFを読み取り、勘定科目・税区分・取引先を推論して**仕訳ドラフト**を生成
3. 事務所スタッフ（または顧問先）が画面で**レビュー・承認**
4. 承認済みのみ、各社の会計ソフトAPIへ**冪等キー付きで投入**
5. 全操作を監査ログに追記

## 技術選定

- **フロント / ホスティング**: Vercel（静的 → 将来 Next.js + Node API）
- **認証**: Supabase Auth（スタッフ=MFA必須、ロール: admin/staff/client）
- **DB**: Supabase Postgres（全テーブルに `tenant_id` + RLS）
- **書類ストレージ**: Supabase Storage（非公開・署名付きURL・テナント別）
- **AI仕訳**: Claude API（vision でPDF読取、学習に使わない/ゼロ保持設定）
- **会計ソフト連携**: ソフトごとのアダプタ層。OAuthトークンは KMS/Vault で暗号化

## 段階的な進め方

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | デモUIを Vercel で公開し、会計士が UX と方針をレビュー | ✅ 公開済 https://mf-nu-ecru.vercel.app/ |
| 1 | Supabase 構築（Auth + テーブル + RLS + Storage）、テナント分離の確立 | ✅ 骨組みコード一式（`db/schema.sql` / `api/` / `lib/`） → 鍵設定で稼働。手順: [SETUP_PHASE1.md](SETUP_PHASE1.md) |
| 2 | PDFアップロード → AI仕訳ドラフト → 承認のWebフロー | 🟡 サーバ側API実装済（`/api/documents/upload-url` / `/api/documents/recognize` / `/api/journals/approve`）。フロント結線が残り |
| 3 | MF連携アダプタ（OAuth・冪等投入・送信ログ） | 設計書: [mf-adapter.md](mf-adapter.md) |
| 4 | freee/弥生アダプタ、監査・運用整備 | |

## 現デモ（Phase 0）の注意

- 表示データはすべて**架空のモック**（`js/mock-data.js`）。実顧客データは一切含まない。
- 認証は未実装（デモのため）。**実データ投入は Phase 1 で認証を入れてから**。
- 公開URLには内部ファイル（CLAUDE.md, .mcp.json, docs/ 等）を `.vercelignore` で**配信しない**。
