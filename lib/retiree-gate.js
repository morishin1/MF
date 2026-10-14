// 退職者ポータル（/api/retiree/*）の入口。
//
// 通すのは「いま退職者として扱う本人」だけ（在籍中の人・顧問先の人は 403 not_retired）。
// 本人の社員 ID は、ログイン中のユーザーからサーバーで引く。リクエストで渡された ID は信用しない。
//
// 退職者を通せるのは、この入口（と /api/me）だけ。ほかの API は lib/auth.js の requireUser が止める。

import { json } from "./http.js";
import { admin } from "./supabase.js";
import { requireUserAllowLeft } from "./auth.js";
import { isLeftEmployee } from "./left-gate.js";

export const NOT_RETIRED = { error: "not_retired", hint: "このページは、退職後のお手続き用です" };

/**
 * @returns {Promise<{user:object, employee:{id:string, tenant_id:string, display_name:string, status:string, left_on:string|null}}|null>}
 *   通せないときは、レスポンスに 401 / 403 / 503 を書いて null
 */
export async function requireRetiree(req, res) {
  const user = await requireUserAllowLeft(req, res);
  if (!user) return null;

  let rows;
  try {
    const { data, error } = await admin()
      .from("gw_employees").select("id, tenant_id, display_name, status, left_on")
      .eq("user_id", user.id).limit(5);
    if (error) {
      json(res, 503, { error: "status_unavailable", hint: "在籍状態を確認できませんでした。しばらくしてからもう一度お試しください" });
      return null;
    }
    rows = data || [];
  } catch {
    json(res, 503, { error: "status_unavailable" });
    return null;
  }
  // すべての行が退職のときだけ、退職者（lib/auth.js leftStateOf と同じ）
  const employee = rows.length > 0 && rows.every((r) => isLeftEmployee(r)) ? rows[0] : null;
  if (!employee) {
    json(res, 403, NOT_RETIRED);
    return null;
  }
  return { user, employee };
}
