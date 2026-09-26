// GET /api/guests/my
//   ログイン中の外部メンバー自身の情報と、許可されている範囲を返す。
//
// ■ ここだけは gwContext を使わない
//   gwContext（lib/gw.js）は gw_employees が無ければ空を返すだけで、
//   ゲストという概念を知らない。ここでは RLS に任せる：
//   gw_guests / gw_tasks / gw_threads / gw_library を、そのまま
//   userClient(req) で読むだけでよい。何が見えるかは db/078 のRLSが決める
//   （許可されていないものは、そもそも1行も返ってこない）

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { userClient } from "../../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const sb = userClient(req);

  // RLS（gw_guests_self）が user_id = auth.uid() に絞り、user_id には一意索引がある。
  // それでも PostgREST 側は1行である保証を知らないので、limit(1) で確実に1行にする
  const { data: guest, error } = await sb.from("gw_guests")
    .select("id, display_name, company_name, email, disabled_at").limit(1).maybeSingle();
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!guest) return json(res, 403, { error: "not_a_guest", hint: "外部メンバーとして登録されていません" });
  if (guest.disabled_at) {
    return json(res, 403, { error: "disabled", hint: "この招待は無効化されています。管理者にお問い合わせください" });
  }

  const [{ data: tasks }, { data: threads }, { data: library }] = await Promise.all([
    sb.from("gw_tasks").select("id, title, status, due_on, category").limit(200),
    sb.from("gw_threads").select("id, title, last_message_at").order("last_message_at", { ascending: false }).limit(100),
    sb.from("gw_library").select("id, title, description, link_url, file_path").limit(200),
  ]);

  return json(res, 200, {
    me: { displayName: guest.display_name, companyName: guest.company_name, email: guest.email },
    tasks: tasks || [],
    threads: threads || [],
    documents: (library || []).map((d) => ({
      id: d.id, title: d.title, description: d.description,
      url: d.link_url || null,
      // アップロードされた資料（file_path）は、このMVPでは直接開けない。
      // 署名URLの発行は社内向け（api/library/index.js）のみ対応で、
      // ゲスト向けの発行口はまだ無い
      fileOnly: !d.link_url && !!d.file_path,
    })),
  });
}
