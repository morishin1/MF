// GET /api/public-config
// ブラウザ（app.html）が Supabase Auth へ直接ログインするための「公開値」を返す。
// 返すのは publishable な anon key と URL のみ（service_role は絶対に返さない）。

import { json, methodNotAllowed } from "../lib/http.js";

export default function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  // 中身は環境変数そのままで、人によって変わらないし、デプロイしないと変わらない。
  // それを画面を開くたびに取りにいくと、その1往復ぶん「読み込み中…」が伸びる。
  // 誰に配っても同じものなので、共有キャッシュにも置いてよい（public）。
  // 変えたときに古いものが残らないよう、長くは持たせない
  res.setHeader("Cache-Control",
    "public, max-age=600, s-maxage=600, stale-while-revalidate=86400");

  return json(res, 200, {
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    configured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
    // 別システムの入口。どちらも同じ Supabase の auth.users を使うので、
    // ここと同じメールアドレス・同じパスワードで入れる。
    // 未設定ならメニューに出さない（行き先の無いボタンを置かない）
    lmsUrl: process.env.LMS_URL || null,
    timecardUrl: process.env.TIMECARD_URL || null,
    // ブラウザ拡張のID。画面から拡張へ話しかけるのに要る（js/device.js）。
    // 公開してよい値（拡張のIDは、入れた人のブラウザからも見える）。
    // 未設定なら、画面は拡張を探しにいかない
    extensionId: process.env.AGENT_EXT_ID || null,
  });
}
