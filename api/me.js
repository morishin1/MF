// GET /api/me
// ログインユーザーの基本情報とメンバーシップ（ロール）を返す。
// フロントの画面出し分け（member=アップロードのみ / admin=承認・分析）に使う。
//
// 出力: { email, userId, isAdmin, roles:[...], memberships:[{tenant_id, role, client_id}] }

import { json, methodNotAllowed } from "../lib/http.js";
import { requireUser, getMemberships } from "../lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const memberships = await getMemberships(user.id);
  const roles = [...new Set(memberships.map((m) => m.role))];
  // admin / staff は「管理者側」（承認・分析ができる）とみなす
  const isAdmin = memberships.some((m) => m.role === "admin" || m.role === "staff");

  return json(res, 200, {
    email: user.email || null,
    userId: user.id,
    isAdmin,
    roles,
    memberships,
  });
}
