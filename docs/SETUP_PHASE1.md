# セットアップ手順（Phase 1：Supabase + Vercel + Claude API）

このドキュメントは、**Phase 1（Web版SaaS骨組み）** を実際に動かすための手順です。
コードはリポジトリに揃っているので、**鍵を入れた瞬間に動きます**。

> 旧文書 `SETUP.md` は「自社1社のMCP連携」用なので、製品本体（顧問先SaaS）はこちらを使ってください。

---

## 0. 用意するもの

- **Supabase アカウント**（無料枠でOK / 東京リージョン推奨）
- **Vercel アカウント**（リポジトリは既に連携済み）
- **Anthropic API キー**（Claude API。https://console.anthropic.com/）
  - **「学習に使わない／ゼロ保持」**設定の組織で発行してください

> ⚠ 鍵は私（Claude）に渡さないでください。あなたが Vercel に直接設定します。

---

## 1. Supabase プロジェクト作成

1. https://supabase.com → **New project**（リージョン: **Tokyo / ap-northeast-1**）
2. **SQL Editor** を開き、リポジトリの [`db/schema.sql`](../db/schema.sql) を**全文コピー → 実行**
   - テナント / クライアント / 書類 / 仕訳 / 監査ログ / **RLS（行レベルセキュリティ）** が一式作られます

### Storage バケット
1. **Storage → New bucket** → 名前 `documents` / **Public OFF（必ず Private）**
2. SQL Editor で `db/schema.sql` 末尾のコメントブロックにある **Storage の RLS ポリシー**もペーストして実行

### Auth
1. **Authentication → Providers → Email** を有効化
2. **Users → Invite** でテストユーザーを1人作る（自分のメール）

### キー取得（Project Settings → API）
- `Project URL` ＝ `SUPABASE_URL`
- `anon` key ＝ `SUPABASE_ANON_KEY`
- `service_role` key ＝ `SUPABASE_SERVICE_ROLE_KEY` **（最重要・クライアントに絶対出さない）**

---

## 2. Vercel 環境変数を設定

Vercel の `mf` プロジェクト → **Settings → Environment Variables**。
Production / Preview / Development すべてにチェックして追加：

| Key | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_ANON_KEY` | anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key |
| `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5`（任意） |

設定後、Deployments → 最新を **Redeploy**。

---

## 3. 動作確認

```
https://mf-nu-ecru.vercel.app/api/health
```
→ `{"ok":true, "env":{"supabase":true,"anthropic":true}, "note":"ready"}` が返ればOK。

---

## 4. 最初のテナント・クライアント・メンバー作成（1回だけ）

Supabase **SQL Editor** で：

```sql
-- ① テナント
insert into public.tenants (name) values ('さくら会計事務所') returning id;
-- => TENANT_ID を控える

-- ② クライアント（顧問先）
insert into public.clients (tenant_id, name, industry, fiscal_month, accounting_software)
values ('<TENANT_ID>', 'テスト株式会社', 'IT', 3, 'mf')
returning id;
-- => CLIENT_ID を控える

-- ③ 自分（Auth ユーザー）を admin として参加
-- USER_ID は Authentication → Users で確認
insert into public.memberships (user_id, tenant_id, role)
values ('<USER_ID>', '<TENANT_ID>', 'admin');
```

---

## 5. PDF → AI仕訳のテスト（最短）

1. Supabase Storage の `documents` バケットに、テスト用PDFを1枚アップ
   （または `POST /api/documents/upload-url` で署名URL取得 → そこへ PUT する正規ルート）
2. ブラウザで Supabase に**ログインしJWTを取得**（フロントを作るまでは DevTools などから）
3. `POST /api/documents/recognize` を呼ぶ：
   ```
   Authorization: Bearer <JWT>
   Content-Type: application/json
   { "documentId": "<アップした書類のid>" }
   ```
4. 数秒〜十数秒で **`journal: {...}`** が返り、`journals` テーブルに `status='draft'` で保存
5. `POST /api/journals/approve` で `{ "journalId": "..." }` を投げると承認（staff/admin のみ）

---

## 6. セキュリティの確認（重要）

- `SUPABASE_SERVICE_ROLE_KEY` は API 内部だけで使用。クライアントには露出しない。
- RLS が ON のため、別テナントの行は SQL でも見えない（SQL Editor の **Impersonate user** で確認できます）。
- `audit_log` に全アクセスが追記され、テナント所属者のみ閲覧可能。
- `documents` バケットは Private のため、URL を知っていても**署名なしではアクセス不可**。

---

## 7. MF などへの実送信（Phase 3 で実装予定）

現状は**承認まで**。実 MF 送信は [`docs/mf-adapter.md`](mf-adapter.md) の設計書のとおり、Phase 3 で実装します。
冪等キー・トークン暗号化・エラーハンドリングは設計済みです。

---

## トラブルシューティング

- **`/api/health` で `env.supabase=false`** → Vercel の環境変数が未保存／Redeploy 必要
- **`401 unauthorized`** → リクエストに `Authorization: Bearer <JWT>` が無い／期限切れ
- **`403 forbidden`** → ログインユーザーが当該テナントの memberships に居ない
- **recognize で `recognize_failed`** → ANTHROPIC_API_KEY 未設定、または PDF サイズ過大
