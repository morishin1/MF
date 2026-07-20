// GET /api/public-config
// ブラウザ（app.html）が Supabase Auth へ直接ログインするための「公開値」を返す。
// 返すのは publishable な anon key と URL のみ（service_role は絶対に返さない）。

import { json, methodNotAllowed } from "../lib/http.js";

export default function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  return json(res, 200, {
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
  });
}
