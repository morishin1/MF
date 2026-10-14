// メンバー管理（一覧の4ボタン・変更直後の表示）の元データを組み立てる。
//
// ■ 判定そのものは lib/gw.js（accessOf / memberAccessOf = /api/me がその本人に返す access）
//   ここは入力を集めるだけ。条件を書き直さない。
//     roles   … 内部ロール（gw_role_grants）
//     apps    … アプリ利用権限（gw_app_grants, db/119。表が無い間は内部ロールから導出）
//     isAdmin … 会計側の管理者か（memberships の role が admin / staff。/api/me の isAdmin と同じ）
//
// ■ 4つのボタン（採用HR / Sales / Office / 経営）
//   ON の意味は「そのアプリへ入れる」だけ。アプリの中で何ができるかは内部ロール（詳細設定）が決める。
//   経営は経営者（owner）から導出する（保存しない）。owner は4つとも ON で、変更できない。
//   会計の管理者は Office の入口が暗黙なので、Office は ON で、変更できない。
//
// ■ 読めなかったときは「分からない」（null）
//   memberships が読めなかったのに「管理者ではない」として表示すると、実際と違う表示になる。
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
 * 4つのボタンの表示（ON/OFF）と、変更できない理由。
 * @returns {{apps: {hr:boolean,sales:boolean,office:boolean,keiei:boolean}, appLocks: Record<string,"owner"|"accountingAdmin">}}
 */
export function appViewOf({ roles = [], apps = [], isAdmin = false } = {}) {
  const owner = roles.includes("owner");
  const has = (k) => apps.includes(k);
  const view = { hr: owner || has("hr"), sales: owner || has("sales"), office: owner || Boolean(isAdmin) || has("office"), keiei: owner };
  const appLocks = {};
  if (owner) for (const k of ["hr", "sales", "office", "keiei"]) appLocks[k] = "owner";
  else if (isAdmin) appLocks.office = "accountingAdmin";
  return { apps: view, appLocks };
}

/**
 * 「利用できる業務」（access）・4つのボタン（apps）・変更できない理由（appLocks）と、その計算に使った入力（accessMeta）を返す。
 *
 * accessMeta.accountingAdmin は、accessOf に渡した isAdmin そのもの（memberships の admin / staff の判定結果）。
 * 画面の「会計の管理者」の注記は、これを使う（別の読み取りから推測しない）。表示する理由と、実効権限の入力元を一致させる。
 *
 * @param {string[]} roles 内部ロール
 * @param {string|null} userId ログインアカウント（まだ連携していなければ null → 会計側の管理者ではない）
 * @param {Map<string,boolean>|null} flags adminFlags の結果（null = 読めなかった）
 * @param {string[]} [apps] アプリ利用権限（gw_app_grants。省略すると内部ロールから導出）
 */
export function accessForMember(roles, userId, flags, apps) {
  const rs = roles || [];
  if (userId && flags === null) {
    const v = appViewOf({ roles: rs, apps: apps || [], isAdmin: false });
    return { access: null, accessMeta: { accountingAdmin: null }, apps: v.apps, appLocks: v.appLocks };
  }
  const isAdmin = Boolean(userId && flags?.get(userId));
  const v = appViewOf({ roles: rs, apps: apps || [], isAdmin });
  return {
    access: memberAccessOf({ roles: rs, isAdmin, apps }),
    accessMeta: { accountingAdmin: isAdmin },
    apps: v.apps,
    appLocks: v.appLocks,
  };
}
