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
 * 「利用できる業務」（access）と、その計算に使った入力（accessMeta）を返す。
 *
 * accessMeta.accountingAdmin は、accessOf に渡した isAdmin そのもの（memberships の admin / staff の判定結果）。
 * 画面の「会計の管理者」の注記は、これを使う（accounts など別の読み取りから推測しない）。
 * こうして、表示する理由と、実効権限の入力元を完全に一致させる。
 *
 * @param {string[]} roles 社内権限
 * @param {string|null} userId ログインアカウント（まだ連携していなければ null → 会計側の管理者ではない）
 * @param {Map<string,boolean>|null} flags adminFlags の結果（null = 読めなかった）
 * @returns {{access: object|null, accessMeta: {accountingAdmin: boolean|null}}}
 *   読めなかったとき（userId があるのに flags が null）は access も accountingAdmin も null
 */
export function accessForMember(roles, userId, flags) {
  if (userId && flags === null) return { access: null, accessMeta: { accountingAdmin: null } };
  const isAdmin = Boolean(userId && flags?.get(userId));
  return {
    access: memberAccessOf({ roles: roles || [], isAdmin }),
    accessMeta: { accountingAdmin: isAdmin },
  };
}
