// 認証ヘルパ: 受け取った JWT から user と所属メンバーシップを解決する。
// テナント/クライアント分離の前線。

import { userClient, admin } from "./supabase.js";
import { json } from "./http.js";
import { isLeftEmployee, ACCOUNT_LEFT } from "./left-gate.js";

/**
 * リクエストから、ログイン中の user を解決して返す（退職者でも通す）。
 * 失敗時はレスポンスに 401 を書き込んで null を返す。
 *
 * 退職者ポータルと /api/me だけが使う。ほかの API は requireUser を使う（退職者は 403）。
 */
export async function requireUserAllowLeft(req, res) {
  const sb = userClient(req);
  const { data, error } = await sb.auth.getUser();
  if (error || !data?.user) {
    json(res, 401, { error: "unauthorized" });
    return null;
  }
  return data.user;
}

// ---- 退職者の判定 -------------------------------------------------------------
//
// ほぼ全部の API が通る入口なので、往復を増やしすぎない。
// 同じ人の判定は、短い間だけ覚えておく（サーバーの1つのインスタンスの中だけ）。
// 退職にした直後でも、この時間のうちに止まる。在籍に戻したときも同じだけ待てば開く
const LEFT_CACHE_MS = 15_000;
const leftCache = new Map();

/** テスト用：覚えた判定を捨てる */
export function resetLeftCache() { leftCache.clear(); }

// 名簿の表が無い（社内システム未導入の環境）ときは、退職者ではない
const TABLE_MISSING = new Set(["PGRST205", "42P01"]);

/**
 * そのログインは、退職者か。
 * 名簿に行が無い人（顧問先など）は退職者ではない。複数の行があるときは、すべてが退職のときだけ退職者。
 * @returns {Promise<{left:boolean, error?:boolean}>}
 */
export async function leftStateOf(userId) {
  const hit = leftCache.get(userId);
  if (hit && Date.now() - hit.at < LEFT_CACHE_MS) return { left: hit.left };

  let rows = null;
  try {
    const { data, error } = await admin()
      .from("gw_employees").select("id, status, left_on")
      .eq("user_id", userId).limit(5);
    if (error) {
      if (TABLE_MISSING.has(error.code)) return { left: false };
      return { left: false, error: true };
    }
    rows = data || [];
  } catch {
    return { left: false, error: true };
  }
  const left = rows.length > 0 && rows.every((r) => isLeftEmployee(r));
  leftCache.set(userId, { at: Date.now(), left });
  return { left };
}

/**
 * リクエストから currentUser を解決して返す。退職者は通さない（403 account_left）。
 * 失敗時はレスポンスに 401/403/503 を書き込んで null を返す。
 *
 * 退職者の判定は在籍状態（gw_employees.status・left_on）だけで決める。
 * 内部ロール・アプリ利用権限・会計のメンバーシップが残っていても、通さない
 */
export async function requireUser(req, res) {
  const user = await requireUserAllowLeft(req, res);
  if (!user) return null;

  const st = await leftStateOf(user.id);
  if (st.error) {
    // 在籍状態を確かめられないときは、通さない（退職者を通してしまうよりよい）
    json(res, 503, { error: "status_unavailable", hint: "在籍状態を確認できませんでした。しばらくしてからもう一度お試しください" });
    return null;
  }
  if (st.left) {
    json(res, 403, ACCOUNT_LEFT);
    return null;
  }
  return user;
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
