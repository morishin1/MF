// 認証ヘルパ: 受け取った JWT から user と所属メンバーシップを解決する。
// テナント/クライアント分離の前線。

import { userClient, admin } from "./supabase.js";
import { json } from "./http.js";

/**
 * リクエストから currentUser を解決して返す。
 * 失敗時はレスポンスに 401 を書き込んで null を返す。
 */
export async function requireUser(req, res) {
  const sb = userClient(req);
  const { data, error } = await sb.auth.getUser();
  if (error || !data?.user) {
    json(res, 401, { error: "unauthorized" });
    return null;
  }
  return data.user;
}

/**
 * user に紐づくメンバーシップ一覧を取得（admin クライアントで RLS バイパス、
 * ただし user_id 一致のみに絞る）。
 */
export async function getMemberships(userId) {
  const sb = admin();
  const { data, error } = await sb
    .from("memberships")
    .select("id, tenant_id, role, client_id")
    .eq("user_id", userId);
  if (error) throw error;
  return data || [];
}

/**
 * 指定 clientId にアクセス可能か判定。
 * staff/admin はテナント内の全クライアント、client は自分の client_id のみ。
 */
export function canAccessClient(memberships, clientId, tenantId) {
  for (const m of memberships) {
    if (m.tenant_id !== tenantId) continue;
    if (m.role === "admin" || m.role === "staff") return true;
    if (m.role === "client" && m.client_id === clientId) return true;
  }
  return false;
}
