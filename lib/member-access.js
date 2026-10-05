// メンバー管理の「利用できる業務」の元データを組み立てる。
//
// ■ 判定そのものは lib/gw.js の accessOf（= /api/me がその本人に返す access）
//   ここは入力を集めるだけ。条件を書き直さない。
//     roles   … 社内権限（gw_role_grants）
//     isAdmin … 会計側の管理者か（memberships の role が admin / staff。/api/me の isAdmin と同じ）
//
// ■ 読めなかったときは「分からない」（null）
//   memberships が読めなかったのに「管理者ではない」として ○/× を出すと、実際と違う表示になる。
//   読めない人の access は null にして、画面は「確認できません」と出す。
import { memberAccessOf } from "./gw.js";

/** user_id → 会計側の管理者か。読めなかったら null（空の Map ではない） */
export async function adminFlags(sb, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const out = new Map(ids.map((id) => [id, false]));
  if (!ids.length) return out;
  let res;
  try { res = await sb.from("memberships").select("user_id, role").in("user_id", ids); }
  catch { return null; }
  if (!res || res.error) return null;
  for (const r of res.data || []) {
    if (r.role === "admin" || r.role === "staff") out.set(r.user_id, true);
  }
  return out;
}

/**
 * @param {string[]} roles 社内権限
 * @param {string|null} userId ログインアカウント（まだ連携していなければ null → 会計側の管理者ではない）
 * @param {Map<string,boolean>|null} flags adminFlags の結果（null = 読めなかった）
 * @returns {object|null} accessOf の結果（+officeAny）。分からなければ null
 */
export function accessForMember(roles, userId, flags) {
  if (userId && flags === null) return null;
  return memberAccessOf({ roles: roles || [], isAdmin: Boolean(userId && flags?.get(userId)) });
}
