// グループウェア共通のコンテキスト解決。
//
// 「このリクエストの人は、どのテナントの、誰で、何ができるのか」を1か所にまとめる。
// api/me.js は既存の会計画面が依存しているので触らず、新しい画面はこちらを使う。
//
// 注意: ここで返す isHr / isAdvisor は画面の出し分けと入口チェックのためのもの。
//       実際の可視範囲は DB 側の RLS が決める。API 層の if は境界ではない。

import { getMemberships } from "./auth.js";
import { admin } from "./supabase.js";

/**
 * @returns {Promise<{
 *   tenantId: string|null, isAdmin: boolean, memberships: object[],
 *   employee: object|null, roles: string[], isHr: boolean, isAdvisor: boolean
 * }>}
 */
export async function gwContext(userId) {
  const sb = admin();

  // ■ 待つ理由のないものを、順番に待たない
  //
  //   所属（memberships）と社員名簿（gw_employees）は、
  //   どちらも user_id で引くだけで、互いの結果を使わない。
  //   なのに順番に待っていたので、画面を出すまでの往復が1本ぶん多かった。
  //   ここは管理側のほぼ全部の API が通るので、1本でもよく効く。
  //
  //   社員名簿は、会計側のメンバーシップが無い人（社労士など）もここで拾う。
  //   社労士に会計の権限を持たせないため、テナントの特定を memberships だけに
  //   頼らない。テーブル未作成（マイグレーション未適用）でも落とさない。
  const [memberships, emp] = await Promise.all([
    getMemberships(userId),
    sb.from("gw_employees")
      .select("id, tenant_id, display_name, email, department, position, employment_type, "
            + "joined_on, status, manager_id, initial_role, work_style, job_family_code, autonomy_level")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle(),
  ]);
  const staff = memberships.find((m) => m.role === "admin" || m.role === "staff");
  const employee = emp.data || null;

  const tenantId =
    (staff || memberships[0])?.tenant_id || employee?.tenant_id || null;

  const base = {
    tenantId, isAdmin: !!staff, memberships,
    employee: null, roles: [], isHr: false, isAdvisor: false,
  };
  // 名簿の行が別テナントのものだった場合は使わない（多重所属は想定しない）
  if (!tenantId || !employee || employee.tenant_id !== tenantId) return base;

  const { data: grants } = await sb
    .from("gw_role_grants")
    .select("role")
    .eq("employee_id", employee.id);
  const roles = (grants || []).map((g) => g.role);

  return {
    ...base,
    employee,
    roles,
    isHr: roles.includes("hr") || roles.includes("owner"),
    isAdvisor: roles.includes("labor_advisor"),
  };
}

// 人事の操作（社員名簿・手続きの編集）ができるか
export const canManageHr = (ctx) => ctx.isAdmin || ctx.isHr;

/**
 * 端末の登録解除・資格情報の失効ができるか。
 *
 * 台帳を見る・停止するところまでは人事の担当者でもできる（canManageHr）。
 * ただし「削除」と「紛失」は取り消しがきかない。
 *
 *   ・削除  … そのPCからエージェントが消える。押し直しても戻らない
 *   ・紛失  … 資格情報がその場で死ぬ。入れ直すまで、そのPCは何も送れない
 *
 * 押し間違いの被害が大きいので、管理者と経営者だけにする。
 */
export const canWipeDevice = (ctx) => Boolean(ctx.isAdmin || (ctx.roles || []).includes("owner"));

/**
 * 業務ツール（HR・Sales・Office・経営）の利用権限は、メンバー管理の「社内権限」（gw_role_grants）だけで決める。
 *
 *   HR     … 経営者・責任者・人事・採用担当
 *   Sales  … 経営者・責任者・営業担当
 *   Office … 経営者・責任者・経理        （画面は未実装。判定だけ先に置く）
 *   経営   … 経営者だけ
 *
 * 経営者（owner）は、全ツールの最上位。どのツールにも入れる。
 * 逆に、下位の権限が経営者の権限を継承することはない（責任者が HR に入れても、給与は見えない）。
 *
 * 会計側の管理者（memberships の admin / staff ＝ ctx.isAdmin）や「IT・管理」（it）は
 * システム管理用の権限なので、それだけでは業務ツールへのアクセスを許さない。
 * 採用HRには履歴書・職務経歴書・評価などの個人情報があるため、権限を付けた人だけにする。
 * DB 側の gw_is_recruiting / gw_is_sales（db/094・db/103）・gw_is_office・gw_is_owner（db/099）も同じ役割の並び。
 */
export const RECRUIT_ROLES = ["owner", "manager", "hr", "recruiter"];   // 経営者・責任者・人事・採用担当
export const SALES_ROLES = ["owner", "manager", "sales"];               // 経営者・責任者・営業担当
export const OFFICE_ROLES = ["owner", "manager", "finance"];            // 経営者・責任者・経理
const hasAny = (ctx, list) => list.some((r) => (ctx?.roles || []).includes(r));

/**
 * 採用HR（/hr）を使えるか。経営者・責任者・人事・採用担当（社内権限だけで決める）。
 * recruiter・manager は採用機能だけを許可し、給与台帳・入退社機微・会計・他の人事機密は
 * canManageHr / gw_is_hr の対象のまま（単体では届かない）。
 * 給与は見えない（canSeeSalary。応募者・合格通知の給与は API で外し、DB は gw_hr_pay へ分けた）
 */
export const canRecruit = (ctx) => hasAny(ctx, RECRUIT_ROLES);

/**
 * 採用判断（社長推薦の最終判断）ができるか。CEO REVIEWの実行権限。
 * 採用HRを使える人の中でも、経営者ロール・管理者だけに絞る
 * （recruiter・hr だけでは判断そのものは押せない。候補を挙げるところまで）
 */
// 採用HRを使えない人（会計の管理者だけ、など）には、判断も許さない
export const canDecideHire = (ctx) => canRecruit(ctx) && Boolean(ctx.isAdmin || (ctx.roles || []).includes("owner"));

/**
 * 営業アタック管理（/sales）を使えるか。経営者・責任者・営業担当（社内権限だけで決める）。
 * DB側の gw_is_sales（db/094）と同じ判定基準
 */
export const canSell = (ctx) => hasAny(ctx, SALES_ROLES);

/**
 * Office（受注後の実務：月次業務・勤務表・稼働・請求・仕入・支払準備）を使えるか。
 * 経営者・責任者・経理。DB 側の gw_is_office（db/103）と同じ判定基準。
 * 画面（/office/）はまだ無い。ヘッダーには、実装されるまで出さない（js/layout.js の TOOLS）
 */
export const canOffice = (ctx) => hasAny(ctx, OFFICE_ROLES);

/**
 * 経営者（owner）だけ。経営（/keiei）、owner の付与・剥奪、全社員の給与の閲覧。
 *
 * ほかの判定（canManageHr / canRecruit / canSell など）から自動で継承させない。
 * 会計側の管理者（isAdmin）・人事（hr）・責任者（manager）・採用担当・経理・IT・管理は含めない。
 * DB 側の gw_is_owner（db/099）と同じ条件。
 */
export const KEIEI_ROLES = ["owner"];
// 経営者（owner）か。owner の付与・剥奪・二段階認証のリセット・給与の閲覧の判定に使う。
// 経営（/keiei）に入れる人の一覧（KEIEI_ROLES）とは別に持つ: 経営に入れる人を将来広げても、
// owner を操作できる人までは広がらないように
const OWNER_ROLES = ["owner"];
export const isOwner = (ctx) => hasAny(ctx, OWNER_ROLES);
export const canKeiei = (ctx) => hasAny(ctx, KEIEI_ROLES);

/**
 * 給与（基本給・時給・手当・給与メモ・給与レンジ・昇給の判断）を、他人の分も含めて見られるか。
 *
 * 見られる人の最終形は「経営者だけ」（本人は、自分の分だけ）。
 * ただし、人事・管理者が給与を入力・確認している業務（労働条件通知書の賃金欄、
 * 登録、契約台帳）がまだ /keiei に移っていないので、段階的に絞る。
 *
 *   段階1（既定）… 採用担当・責任者・経理・IT・営業には見せない。
 *                  人事・管理者・経営者は、これまでどおり
 *   段階2（環境変数 SALARY_OWNER_ONLY=1）… 経営者だけ
 *
 * 各 API は、この判定で応答から給与を外す（lib/salary.js・lib/http.js）。
 * DB 側は、給与を別の表へ分けて、経営者と本人だけの RLS にする（docs/keiei-salary-separation.md）。
 * 責任者・採用担当が経営者の権限を自動で継承することはない
 */
export const salaryOwnerOnly = () => process.env.SALARY_OWNER_ONLY === "1";
export const canSeeSalary = (ctx) => {
  if (isOwner(ctx)) return true;
  if (salaryOwnerOnly()) return false;
  return Boolean(ctx?.isAdmin || ctx?.isHr);
};

/**
 * 業務ツール（HR・Sales・Office・経営）に入れるか。
 *
 * 画面のヘッダーの切替・/hr /sales /keiei の画面の入口・各 API は、すべてこの結果にそろえる。
 * /api/me がこれを access として返し、画面はその値で出し分ける
 * （画面側で役割を並べ直さない。ヘッダーに出たのに API が 403、を作らない）。
 *   recruit … owner / manager / hr / recruiter（= canRecruit、DB の gw_is_recruiting）
 *   sell    … owner / manager / sales（= canSell、DB の gw_is_sales）
 *   office  … owner / manager / finance（= canOffice、DB の gw_is_office）
 *   keiei   … owner だけ（= canKeiei、DB の gw_is_owner）
 * 会計側の管理者（isAdmin）・IT・管理（it）は含めない。
 * ツールを足すときは、ここに1行足し、js/layout.js の TOOLS に1行足す
 * @param {{isAdmin?:boolean, isHr?:boolean, roles?:string[]}} ctx
 */
export const accessOf = (ctx) => ({
  recruit: canRecruit({ roles: [], ...ctx }),
  sell: canSell({ roles: [], ...ctx }),
  office: canOffice({ roles: [], ...ctx }),
  keiei: canKeiei({ roles: [], ...ctx }),
});

/**
 * 会社の印鑑（gw_seals）の登録・変更・無効化ができるか。管理者・経営者だけ。
 * 印影は契約書に押されるものなので、人事・採用担当・営業には編集させない。
 * 送るときに有効な印鑑を「選ぶ」のは、署名依頼を出せる人（canManageHr）のまま
 */
export const canManageSeals = (ctx) => Boolean(ctx.isAdmin || (ctx.roles || []).includes("owner"));

/**
 * 直近30日以内にアタック済みの会社へ、それでもアタックできるか（要件 §20）。
 * 同じ会社へ短期間に何度もフォーム営業しないための例外なので、管理者・経営者だけ
 */
// Sales を使えない人（会計の管理者だけ、など）には、強行も許さない
export const canForceAttack = (ctx) => canSell(ctx) && Boolean(ctx.isAdmin || (ctx.roles || []).includes("owner"));
