// Supabase クライアントの初期化
// - admin(): service_role キーで作る管理クライアント（RLSバイパス。サーバ専用）
// - userClient(req): リクエストの Bearer JWT を持って anon キーで作るユーザー文脈クライアント
//   → RLS が auth.uid() を解決でき、テナント越境を物理的に防げる

import { createClient } from "@supabase/supabase-js";

const URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertEnv() {
  if (!URL || !ANON || !SERVICE) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY が未設定です。Vercel 環境変数を設定してください。"
    );
  }
}

export function admin() {
  assertEnv();
  return createClient(URL, SERVICE, { auth: { persistSession: false } });
}

export function userClient(req) {
  assertEnv();
  const auth = req.headers["authorization"] || req.headers["Authorization"];
  return createClient(URL, ANON, {
    global: { headers: auth ? { Authorization: auth } : {} },
    auth: { persistSession: false },
  });
}
