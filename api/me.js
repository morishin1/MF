// GET /api/me
// ログインユーザーの基本情報とメンバーシップ（ロール）を返す。
// フロントの画面出し分け（member=アップロードのみ / admin=承認・分析）に使う。
//
// 出力: { email, userId, isAdmin, roles, memberships, gw, appRole }
//   gw      … 社内グループウェアの所属・ロール（db/005_groupware_core.sql 適用後に値が入る）
//              未適用の環境では available:false になるだけで、既存の会計機能には影響しない。
//   appRole … ログイン後の振り分け先（要件セクション4）
//              member → メンバー用ホーム / admin・owner → 管理者ダッシュボード / sr → 限定画面

import { json, methodNotAllowed } from "../lib/http.js";
import { requireUser, getMemberships } from "../lib/auth.js";
import { admin } from "../lib/supabase.js";
import { stageInfo, shouldOpen, onboardingDone } from "../lib/stages.js";
import { jstDate } from "../lib/nippo.js";
import { mfaState } from "../lib/mfa.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const memberships = await getMemberships(user.id);
  const roles = [...new Set(memberships.map((m) => m.role))];
  // admin / staff は「管理者側」（承認・分析ができる）とみなす
  const isAdmin = memberships.some((m) => m.role === "admin" || m.role === "staff");

  // 社内グループウェアの所属テナント。自社1社運用なので staff 側の所属を優先する。
  const staffMembership = memberships.find((m) => m.role === "admin" || m.role === "staff");
  const tenantId = (staffMembership || memberships[0])?.tenant_id || null;

  const gw = await loadGroupware(user.id, tenantId);

  return json(res, 200, {
    email: user.email || null,
    userId: user.id,
    isAdmin,
    roles,
    memberships,
    gw,
    appRole: resolveAppRole({ isAdmin, gwRoles: gw.roles }),
    // 二段階認証。要るか・登録済みか・今回の入り方で確かめたか・いつから止めるか
    mfa: mfaState({ ctx: { isAdmin, roles: gw.roles }, user, req }),
  });
}

// 社員名簿と社内ロールを引く。005 未適用でも落とさない。
//
// ■ 入社日が来たら、ここで自動的に開く
//   「入社準備」から「メンバー」への切り替えを人の作業にすると、
//   必ず忘れられて、初日に何も使えない人が出る。
//   本人が開いた最初の1回で切り替わるので、管理者の操作は要らない。
//   （ログインしない人のぶんは api/cron/escalate.js が毎日ならす）
async function loadGroupware(userId, tenantId) {
  const empty = { available: false, tenantId, employee: null, roles: [], isHr: false, isOwner: false };

  const sb = admin();
  // 会計側のメンバーシップが無い人（社労士など）も名簿から拾えるように、
  // tenantId が決まっていないときは user_id だけで引く。
  let q = sb
    .from("gw_employees")
    // 雇用区分は返さない。メンバーの画面には出さないと決めたので、
    // 送っておいて画面で隠すのはやめる（開発者ツールで見えてしまう）。
    // サーバ側で要るところは gwContext から直接引いている
    .select("id, tenant_id, display_name, email, department, position, joined_on, status")
    .eq("user_id", userId);
  if (tenantId) q = q.eq("tenant_id", tenantId);
  const { data: employee, error } = await q.limit(1).maybeSingle();

  // テーブルが無い（マイグレーション未適用）場合はここで抜ける。
  // 会計機能はグループウェアに依存しないので、エラーにはしない。
  if (error) return empty;

  if (!employee) return { ...empty, available: true };
  tenantId = tenantId || employee.tenant_id;

  // ここは全画面の入口。往復を1本でも減らす。
  //
  // 社内ロール（gw_role_grants）と、入社手続きの進み具合は、
  // どちらも employee.id だけで引けて、互いの結果を使わない。
  // 順番に待つ理由がないので、同時に出す。
  //
  // 提出がそろっていれば、入社日前でも画面を開ける（在籍の状態は変えない）。
  // 調べるのは入社準備中の人だけ（そうでない人には要らない問い合わせ）
  const [grantsRes, itemsRes] = await Promise.all([
    sb.from("gw_role_grants").select("role").eq("employee_id", employee.id),
    employee.status === "invited"
      ? sb.from("gw_procedure_items")
          .select("owner, required, status, gw_procedures!inner(employee_id, kind)")
          .eq("gw_procedures.employee_id", employee.id)
          .eq("gw_procedures.kind", "onboarding")
          .limit(200)
      : Promise.resolve({ data: null }),
  ]);
  const done = itemsRes.data ? onboardingDone(itemsRes.data) : false;

  // 入社日が来ていれば、その場で在籍に切り替える。
  // これは書き込みなので、上の2本とは分ける（たいていの人は通らない）
  if (shouldOpen(employee, jstDate())) {
    const { error: ue } = await sb.from("gw_employees")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", employee.id);
    // 開けなくてもログインは通す。次に開いたときにもう一度試みる
    if (!ue) employee.status = "active";
  }

  const gwRoles = (grantsRes.data || []).map((g) => g.role);
  return {
    available: true,
    tenantId,
    employee,
    // いまどの段階か（入社準備 / メンバー / 退職手続き中 / 退職）と、
    // その段階で開いている画面。メニューはこれで絞る
    stage: stageInfo(employee, { onboardingDone: done }),
    roles: gwRoles,
    isHr: gwRoles.includes("hr") || gwRoles.includes("owner"),
    isOwner: gwRoles.includes("owner"),
  };
}

function resolveAppRole({ isAdmin, gwRoles }) {
  if (gwRoles.includes("labor_advisor")) return "sr";
  if (gwRoles.includes("owner")) return "owner";
  if (isAdmin) return "admin";
  return "member";
}
