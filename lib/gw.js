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
 * 社内AIチャットの「管理部への問い合わせ」共通受信箱を扱えるか（messages.html・admin-ai.html）。
 *
 * canManageHr（人事・経営者・会計側管理者）だけに絞らない。問い合わせは人事の話題に
 * 限らない（PC紛失＝IT、経費精算＝経理、備品＝総務…）ため、対応できる担当がいるなら
 * 誰でも拾えるようにする：経営者・会計側管理者・人事・責任者・経理（canAccessOffice と
 * 同じ並び＝ owner/manager/finance）のどれかに該当すれば扱える。
 * 一般社員・採用担当だけ・営業担当だけは入れない（自分が出した問い合わせだけ）
 */
export const canManageAiInquiries = (ctx) => canManageHr(ctx) || canAccessOffice(ctx);

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
 * 採用HR（/hr）・Sales（/sales）・Office（/office）の利用権限は、
 * メンバー管理の「社内権限」（gw_role_grants）だけで決める。
 *
 *   HR     … 経営者（owner）・責任者（manager）・人事（hr）・採用担当（recruiter）
 *   Sales  … 経営者（owner）・責任者（manager）・営業担当（sales）
 *   Office … 経営者（owner）・責任者（manager）・経理（finance）
 *   経営 /keiei … 経営者（owner）だけ。責任者にも公開しない
 *
 * 経営者と責任者は HR・Sales・Office のすべて使える。それ以外は自分の担当だけ。
 * /keiei だけは経営者のみ。この4つの条件を混同しない（責任者は3つ使えるが、/keiei には入れない）。
 * Office 専用のロールは作らない。メンバー管理の既存の「経理」チェックをそのまま使う。
 * HR から給与・人件費など経営情報が見えないようにするのは、/keiei を作るときに必ず分離する。
 *
 * 会計側の管理者（memberships の admin / staff ＝ ctx.isAdmin）や「IT・管理」（it）は
 * システム管理用の権限なので、それだけでは HR・Sales・Office への業務アクセスを許さない。
 * 採用HRには履歴書・評価などの個人情報、Office には単価・支払などの金額情報があるため、
 * 担当の権限を付けた人だけにする。社労士（labor_advisor）は3つとも入れない
 * （共有された手続きだけを、既存の労務機能で見る）。
 *
 * DB 側の gw_is_recruiting / gw_is_sales / gw_is_office（db/094・db/099）も同じ役割の並び。
 * 判定はこのファイルの canAccessHr / canAccessSales / canAccessOffice に集約する。
 * 画面・API・DB の一致は test/accessparity.mjs が見張る。
 */
export const HR_ROLES = ["owner", "manager", "hr", "recruiter"];  // 経営者・責任者・人事・採用担当
export const SALES_ROLES = ["owner", "manager", "sales"];          // 経営者・責任者・営業担当
export const OFFICE_ROLES = ["owner", "manager", "finance"];       // 経営者・責任者・経理
export const KEIEI_ROLES = ["owner"];                              // 経営者だけ（責任者にも公開しない）
export const RECRUIT_ROLES = HR_ROLES;                             // 前の呼び名（canRecruit と同じ並び）
const hasAny = (ctx, list) => list.some((r) => (ctx?.roles || []).includes(r));

/**
 * 採用HR（/hr）を使えるか。経営者・責任者・人事・採用担当（社内権限だけで決める）。
 * recruiter は採用機能だけを許可し、給与台帳・入退社機微・会計・他の人事機密は
 * canManageHr / gw_is_hr の対象のまま（recruiter 単体では届かない）。
 * 責任者（manager）が使えるのは採用HRの画面までで、採用判断（canDecideHire）は含まない。
 * 給与は見えない（canSeeSalary。応募者・合格通知の給与は API で外し、DB は gw_hr_pay へ分けた）
 */
export const canAccessHr = (ctx) => hasAny(ctx, HR_ROLES);
export const canRecruit = canAccessHr;

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
export const canAccessSales = (ctx) => hasAny(ctx, SALES_ROLES);
export const canSell = canAccessSales;

/**
 * 月末月初業務（/office・/api/office/*）を使えるか。経営者・責任者・経理（社内権限だけで決める）。
 * 単価・請求額・支払など金額の情報を扱うので、会計側の管理者・人事・IT・管理だけでは入れない。
 * DB側の gw_is_office（db/099）と同じ判定基準
 */
export const canAccessOffice = (ctx) => hasAny(ctx, OFFICE_ROLES);

/**
 * 経営（/keiei）を使えるか。経営者（owner）だけ。責任者・経理・人事にも公開しない。
 * 給与・人件費・経営指標を扱う想定なので、二段階認証も必須（lib/mfa.js の strict）。
 * DB側の gw_is_keiei（db/100）と同じ判定基準。画面（/keiei）は、これから作る
 */
export const canAccessKeiei = (ctx) => hasAny(ctx, KEIEI_ROLES);
// 経営（/keiei）まわりの呼び名（経営系の API・画面が使う）。上の canAccessXxx と同じ判定
export const canKeiei = canAccessKeiei;
export const canOffice = canAccessOffice;

/**
 * Office（管理画面）の「業務ごとの」権限。Office は1つのアプリだが、中の業務は担当で分かれる。
 *
 *   officeHr      … 人事・労務（メンバー・入退社・勤怠・休暇・雇用契約・電子署名・評価・キャリア）
 *                   管理者（isAdmin）・経営者（owner）・人事（hr）。= canManageHr と同じ並び
 *   officeFinance … 経理・事務（経費精算・月次業務・月初の請求提出・社内文書）
 *                   管理者（isAdmin）・経営者（owner）・経理（finance）
 *   officeApp     … 月末月初業務（/office/）。= canAccessOffice（経営者・責任者・経理）。意味は変えない
 *
 * 管理者・経営者は全部。人事は人事・労務だけ、経理は経理・事務だけ（互いのAPIは使えない）。
 * 責任者（manager）は officeApp だけ（人事・労務、経理・事務の管理画面には入れない）。
 * Office をヘッダーに出すのは、この3つのどれか1つでも持つ人。
 * 画面（js/layout.js）はこの値（/api/me の access）で出し分け、各 API も同じ関数で守る。
 * 画面と API の一致は test/accessparity.mjs が見張る。DB（RLS）は変えていない（API は service role で読む）
 */
export const OFFICE_FINANCE_ROLES = ["owner", "finance"];
export const canOfficeHr = (ctx) => Boolean(ctx?.isAdmin || ctx?.isHr) || hasAny(ctx, ["owner", "hr"]);
export const canOfficeFinance = (ctx) => Boolean(ctx?.isAdmin) || hasAny(ctx, OFFICE_FINANCE_ROLES);
/** 人事・労務か経理・事務のどちらかに入れる（請求の進み具合など、両方の画面が読む共有のデータ） */
export const canOfficeAny = (ctx) => canOfficeHr(ctx) || canOfficeFinance(ctx);

// 経営者（owner）か。owner の付与・剥奪・二段階認証のリセット・給与の閲覧の判定に使う。
// 経営（/keiei）に入れる人の一覧（KEIEI_ROLES）とは別に持つ: 経営に入れる人を将来広げても、
// owner を操作できる人までは広がらないように
// DB 側の gw_is_owner（db/099_owner_only.sql）と同じ条件。会計側の管理者（isAdmin）・人事（hr）・責任者（manager）・
// 採用担当・経理・IT・管理は含めない
const OWNER_ROLES = ["owner"];
export const isOwner = (ctx) => hasAny(ctx, OWNER_ROLES);

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
 * 直近30日以内にアタック済みの会社へ、それでもアタックできるか（要件 §20）。
 * 同じ会社へ短期間に何度もフォーム営業しないための例外なので、管理者・経営者だけ
 */
/**
 * 採用HR（/hr）・Sales（/sales）・Office（/office）に入れるか。
 *
 * 画面のヘッダーの近道・/hr と /sales と /office の画面の入口・各 API は、すべてこの結果にそろえる。
 * /api/me がこれを access として返し、画面はその値で出し分ける
 * （画面側で役割を並べ直さない。ヘッダーに出たのに API が 403、を作らない）。
 *   recruit … owner / manager / hr / recruiter（= canAccessHr、DB の gw_is_recruiting）
 *   sell    … owner / manager / sales（= canAccessSales、DB の gw_is_sales）
 *   office  … owner / manager / finance（= canAccessOffice、DB の gw_is_office）
 *   keiei   … owner だけ（= canAccessKeiei、DB の gw_is_keiei）
 * 会計側の管理者（isAdmin）・IT・管理（it）・社労士は含めない
 * @param {{isAdmin?:boolean, isHr?:boolean, roles?:string[]}} ctx
 */
export const accessOf = (ctx) => ({
  recruit: canAccessHr({ roles: [], ...ctx }),
  sell: canAccessSales({ roles: [], ...ctx }),
  office: canAccessOffice({ roles: [], ...ctx }),
  // Office の業務ごと。人事・労務／経理・事務（管理者・経営者は両方）。Office はこの3つのどれかがあれば出す
  officeHr: canOfficeHr(ctx),
  officeFinance: canOfficeFinance(ctx),
  keiei: canAccessKeiei({ roles: [], ...ctx }),
  // 社内AIチャットの管理部問い合わせ（messages.html・admin-ai.html の入口判定用）
  aiInquiries: canManageAiInquiries({ roles: [], ...ctx }),
});

/**
 * ほかの人（社員名簿の1人）が、いま何に入れるか。メンバー管理の「利用できる業務」の表示用。
 *
 * 判定は accessOf（= /api/me がその本人に返す access）そのもの。ここで条件を書き直さない。
 * 足りないのは入力の組み立てだけ: gwContext と同じく isHr は「hr または owner の社内権限があるか」、
 * isAdmin は「会計側の管理者（memberships の admin / staff）か」。
 * officeAny（人事・労務／経理・事務／月末月初のどれか1つ）は、Office をヘッダーに出す条件
 * （js/layout.js の shows.office）と同じ。
 *
 * @param {{roles?:string[], isAdmin?:boolean}} m 社内権限（gw_role_grants.role の並び）と、会計側の管理者か
 */
export const memberAccessOf = ({ roles = [], isAdmin = false } = {}) => {
  const a = accessOf({ isAdmin: Boolean(isAdmin), isHr: roles.includes("hr") || roles.includes("owner"), roles });
  return { ...a, officeAny: Boolean(a.office || a.officeHr || a.officeFinance) };
};

/**
 * 会社の印鑑（gw_seals）の登録・変更・無効化ができるか。管理者・経営者だけ。
 * 印影は契約書に押されるものなので、人事・採用担当・営業には編集させない。
 * 送るときに有効な印鑑を「選ぶ」のは、署名依頼を出せる人（canManageHr）のまま
 */
export const canManageSeals = (ctx) => Boolean(ctx.isAdmin || (ctx.roles || []).includes("owner"));

// Sales を使えない人（会計の管理者だけ、など）には、強行も許さない
export const canForceAttack = (ctx) => canSell(ctx) && Boolean(ctx.isAdmin || (ctx.roles || []).includes("owner"));
