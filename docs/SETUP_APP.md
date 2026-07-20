# 実データ版（app.html）セットアップ手順

事務が「PDF/Excelアップ → AI自動仕訳 → 承認 → MF連動」を画面操作で行う実データ版の初期構築手順。

対象 Supabase プロジェクト: `https://vuqzsuhwuznclqxxtgfn.supabase.co`

---

## 1. Supabase 側

### 1-1. スキーマ作成
Supabase ダッシュボード → **SQL Editor** → `db/schema.sql` を全文貼り付けて **Run**。
（テーブル・RLS・ポリシー・ヘルパ関数が作成される）

### 1-2. Storage バケット
`documents` という**非公開**バケットが必要。
→ 手動作成でも、下の `/api/admin/setup` が自動作成するのでどちらでも可。

### 1-3. API キーの取得
**Project Settings → API** から以下をコピー（次の手順で Vercel に入れる）:
- Project URL … `https://vuqzsuhwuznclqxxtgfn.supabase.co`
- `anon public` キー
- `service_role` キー（**サーバ専用・絶対に公開しない**）

---

## 2. Vercel の環境変数

Vercel → Project → **Settings → Environment Variables** に設定（`.env.example` 参照）:

| 変数 | 値 |
|---|---|
| `SUPABASE_URL` | `https://vuqzsuhwuznclqxxtgfn.supabase.co` |
| `SUPABASE_ANON_KEY` | anon public キー |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role キー |
| `ANTHROPIC_API_KEY` | Anthropic のAPIキー（ゼロ保持設定推奨） |
| `SETUP_SECRET` | ランダムな長い文字列（初期投入時のみ・後で削除） |
| `MF_API_BASE` | （空でOK。MF実送信を有効化する段階で設定） |

設定後 **Redeploy**。`https://<あなたのドメイン>/api/health` で
`env.supabase=true`, `env.anthropic=true` を確認。

---

## 3. 初期データ投入（ユーザー・事務所・エイト・権限）

`SETUP_SECRET` を設定した状態で、以下を1回だけ実行。
`password` を渡すと Auth ユーザーも新規作成する（既存ユーザーなら省略可）。

```bash
curl -X POST https://<あなたのドメイン>/api/admin/setup \
  -H "content-type: application/json" \
  -H "x-setup-secret: <SETUP_SECRETと同じ値>" \
  -d '{
    "email": "keiri@eight.example.jp",
    "password": "（初回作成する場合の初期パスワード）",
    "tenantName": "エイト社内経理",
    "clientName": "株式会社エイト",
    "industry": "（任意）",
    "fiscalMonth": 3
  }'
```

成功すると `tenantId / clientId / userId / membershipId` が返る。
**投入後は `SETUP_SECRET` を削除して Redeploy**（setup エンドポイントを無効化）。

---

## 4. 動作確認（一本道）

1. `https://<あなたのドメイン>/app.html` を開く
2. 上記 email / password でログイン
3. 取引先「株式会社エイト」を選択
4. 請求書PDF か 経費Excel(.xlsx/.csv) をアップロード → 数秒〜十数秒でAI仕訳ドラフトが「確認待ち」に追加
5. 内容を確認して **承認**
6. タブ「承認済み」に移動（MF未設定のうちはここまで。`MF_API_BASE` 設定後は「MF登録済み」まで進む）

---

## 5. MF連動（最後のピース）

現状は承認までで安全停止（`lib/mf-adapter.js` が `MF_API_BASE` 未設定を検知）。
実登録の有効化には MF Cloud API の確定仕様（エンドポイント/OAuth、勘定科目・税区分のID対応）が必要。
仕様が入手でき次第 `lib/mf-adapter.js` の `sendViaHttp()` を実装し、`MF_API_BASE` を設定すれば
`承認 → sent` まで自動で繋がる（`api/journals/approve.js` は既に配線済み）。

---

## トラブルシューティング

- `app.html` 上部が「未設定の環境変数があります」→ 手順2の env が未保存/未Redeploy
- ログインで失敗 → Auth にユーザーが無い／パスワード相違（手順3で作成）
- 取引先が空 → memberships 未登録（手順3の setup を実行）
- アップロードは成功するがAI仕訳で失敗 → `ANTHROPIC_API_KEY` 未設定、またはファイルが大きすぎ(10MB上限)
- `/api/admin/setup` が 503 → `SETUP_SECRET` 未設定 / 401 → ヘッダの値が不一致
