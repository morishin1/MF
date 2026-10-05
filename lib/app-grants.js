// アプリ利用権限（gw_app_grants, db/119）— 「どのアプリへ入れるか」を持つ。
//
// ■ 2つを分ける
//   アプリ利用権限（入口） … 採用HR（hr）・Sales（sales）・Office（office）。この表に保存する。経営は owner から導出（保存しない）。
//   内部ロール（中身）     … owner / hr / finance / manager / recruiter / sales / it / labor_advisor（gw_role_grants）。
//                             アプリの中で何ができるかを決める。入口は開けない。
//   Office を ON にしただけでは、人事・労務・経理・事務・月末月初のどれも使えない（lib/gw.js）。
//
// ■ 表がまだ無いとき（db/119 を流す前）
//   内部ロールから、移行の規則（APP_FROM_ROLES）どおりの入口を出す。結果は、移行前の実効権限と同じ。
//   権限は増えも減りもしない。メンバー一覧は、変更できない表示にする（state: "derived"）。
//   表が「無い」のではなく、読み取りに失敗しただけのときは、入口を出さない（権限を広げない。state: "error"）。
//
// ■ 移行の規則（db/119 の INSERT と同じ。test/appgrants.mjs が、全ロールの組合せで移行前と同じ権限になることを確かめる）
//     manager → hr, sales, office     hr → hr, office     recruiter → hr     sales → sales     finance → office
//     owner・it・labor_advisor → なし（owner は暗黙で全部。会計の管理者は Office の入口が暗黙）

export const APP_KEYS = ["hr", "sales", "office"];
/** 画面に出す4つ（経営は owner から導出。保存しない） */
export const APP_KEYS_VIEW = ["hr", "sales", "office", "keiei"];

export const APP_LABEL = { hr: "採用HR", sales: "Sales", office: "Office", keiei: "経営" };

export const APP_FROM_ROLES = {
  manager: ["hr", "sales", "office"],
  hr: ["hr", "office"],
  recruiter: ["hr"],
  sales: ["sales"],
  finance: ["office"],
};

/** 内部ロールの並びから、移行の規則どおりのアプリ利用権限を出す（表が無いとき・移行・テストで使う） */
export function appsFromRoles(roles = []) {
  const out = new Set();
  for (const r of roles || []) for (const a of APP_FROM_ROLES[r] || []) out.add(a);
  return APP_KEYS.filter((k) => out.has(k));
}

/** 表が無い（未適用）ときのエラーか。読めなかっただけ（障害）と分ける */
export const isAbsent = (error) => Boolean(error) && (error.code === "PGRST205" || error.code === "42P01"
  || /does not exist|could not find the table/i.test(String(error.message || "")));

/**
 * 1人のアプリ利用権限の「読み取り」だけ（内部ロールを待たずに投げられる）。resolveApps に渡して、結果にする。
 * @returns {Promise<{rows: Array|null, absent: boolean, failed: boolean}>}
 */
export async function readApps(sb, employeeId) {
  if (!employeeId) return { rows: [], absent: false, failed: false };
  try {
    const { data, error } = await sb.from("gw_app_grants").select("app_key").eq("employee_id", employeeId);
    if (!error) return { rows: data || [], absent: false, failed: false };
    return { rows: null, absent: isAbsent(error), failed: !isAbsent(error) };
  } catch {
    return { rows: null, absent: false, failed: true };
  }
}

/**
 * 読み取りの結果と内部ロールから、アプリ利用権限を決める。
 * @returns {{apps: string[], state: "table"|"derived"|"error"}}
 */
export function resolveApps(read, roles = []) {
  if (read.rows) return { apps: APP_KEYS.filter((k) => read.rows.some((g) => g.app_key === k)), state: "table" };
  if (read.absent) return { apps: appsFromRoles(roles), state: "derived" };
  return { apps: [], state: "error" };
}

/** 1人のアプリ利用権限を読む（内部ロールが分かっているとき） */
export async function loadApps(sb, employeeId, roles = []) {
  return resolveApps(await readApps(sb, employeeId), roles);
}

/**
 * 複数人（メンバー一覧）のアプリ利用権限を、1回の読み取りで。
 * @param {Map<string,string[]>|Record<string,string[]>} rolesById 社員ID → 内部ロール
 * @returns {Promise<{state: "table"|"derived"|"error", byId: Map<string,string[]>}>}
 */
export async function loadAppsMany(sb, employeeIds, rolesById) {
  const ids = [...new Set((employeeIds || []).filter(Boolean))];
  const rolesOf = (id) => (rolesById instanceof Map ? rolesById.get(id) : rolesById?.[id]) || [];
  const byId = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return { state: "table", byId };
  try {
    const rows = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb.from("gw_app_grants").select("employee_id, app_key").in("employee_id", ids.slice(i, i + 200));
      if (error) {
        if (isAbsent(error)) { for (const id of ids) byId.set(id, appsFromRoles(rolesOf(id))); return { state: "derived", byId }; }
        return { state: "error", byId };
      }
      rows.push(...(data || []));
    }
    for (const r of rows) if (APP_KEYS.includes(r.app_key)) byId.get(r.employee_id)?.push(r.app_key);
    for (const [id, list] of byId) byId.set(id, APP_KEYS.filter((k) => list.includes(k)));
    return { state: "table", byId };
  } catch {
    return { state: "error", byId };
  }
}
