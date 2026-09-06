// 入社1人ぶんを立ち上げる。
//   名簿 → アカウント → 労働条件 → 3か月計画 → 月ごとのKGI/KPI → 初日にやること
//   → 入社手続き（チェックリスト・準備タスク・本人フォーム・個人フォルダ）
//
// ■ 管理者の操作は、登録フォームを1回出すところまで
//   以前は、登録したあとで入社手続きをもう一度手で作っていた。
//   作り忘れると入社日に何も準備されていない状態になるので、
//   同じ流れの中でまとめて作る。
//
// ■ 入口は2つ、処理は1つ
//   通常はフォーム（api/employees/onboard.js）、複数人はCSV/XLSX
//   （api/employees/intake.js）。どちらも最後はこの関数を通る。
//   2か所に同じ処理を書くと、必ず片方だけ直されて食い違う。
//
// ■ 管理者に決めさせないもの
//   3か月KGI・月間KGI・KPI・NEXT ACTION は、職種テンプレートから作る。
//   管理者が毎回考える形にすると、入社のたびに時間がかかり、
//   結局「あとで決める」まま放置されて、本人の画面が空になる。
//
// ■ 途中で失敗したときに消さない
//   名簿だけできてアカウントが無い状態は、画面から直せる。
//   消してしまうと、何がどこまでできたのか分からなくなる。

import { attachAccount } from "./accounts.js";
import { createOnboardingKit } from "./onboard-kit.js";
import { planFromTemplate } from "./job-templates.js";
import { modeKpis, modeKgiSuffix } from "./work-modes.js";
import { addMonths, monthsOf } from "./growth.js";

/**
 * @param {object} m 正規化済みのマスター1件（lib/intake.js の validateRow の戻り値）
 * @param {object} opts
 *   code        社員コード
 *   importRowId CSV取り込み由来なら、その行のid
 *   source      "form" | "import"。記録に残す
 * @returns {Promise<object>} 作った結果。初回パスワードはここにしか出ない
 */
export async function onboardOne(sb, ctx, user, m, { code, importRowId = null, source = "form" } = {}) {
  const from = source === "import" ? "雇用・育成マスターの取り込み" : "新規メンバー登録フォーム";

  // 1) 名簿
  const { data: emp, error } = await sb.from("gw_employees").insert({
    tenant_id: ctx.tenantId,
    display_name: m.name,
    email: m.login_email,
    employee_code: code,
    employment_type: m.contract_type === "有期" ? "契約社員" : "正社員",
    joined_on: m.join_date,
    job_family_code: m.job_family_code,
    work_mode: m.work_mode,
    initial_role: m.initial_role,
    position: m.initial_role,
    work_style: m.work_style,
    autonomy_level: m.autonomy_level_start,
    status: "invited",
    note: m.notes,
    import_row_id: importRowId,
  }).select("*").single();
  if (error) throw new Error(error.message);

  const entry = { name: m.name, employeeId: emp.id, code };

  // 2) アカウント。4システムぶんまとめて作られる
  const acc = await attachAccount(sb, {
    tenantId: ctx.tenantId, employee: emp, email: m.login_email,
  });
  if (acc.ok) {
    entry.email = m.login_email;
    // 初回パスワードは保存しない。平文で残るため、この応答にだけ出す
    entry.password = acc.createdPassword;
    entry.systems = acc.systems;
    entry.userId = acc.userId;
  } else {
    entry.accountError = acc.hint || acc.detail || acc.error;
  }

  // ここから先は user_id で本人に紐づける。
  // emp はアカウントを作る前に取った行なので user_id はまだ空。
  // ここで取り違えると、育成計画が本人の画面に出てこない
  const userId = acc.ok ? acc.userId : null;
  if (!userId) {
    throw new Error(
      `アカウントを作れませんでした（${entry.accountError || "理由不明"}）。`
      + "名簿には登録済みなので、メンバー画面からアカウントだけ作り直せます");
  }

  // 権限。manager なら社内ロールを付ける
  if (m.account_type === "manager") {
    await sb.from("gw_role_grants").insert({
      tenant_id: ctx.tenantId, employee_id: emp.id, role: "manager", granted_by: user.id,
    });
  }

  // 3) 労働条件。書類のPDFは無いので、入力値を確定済みとして入れる。
  //    AIが読んだわけではないので ai_status は completed にしない
  const { data: contract } = await sb.from("gw_contracts").insert({
    tenant_id: ctx.tenantId,
    employee_id: emp.id,
    status: "active",
    document_type: "労働条件通知書",
    contract_type: m.contract_type === "有期" ? "契約社員" : "正社員",
    fixed_term: m.contract_type === "有期",
    period_from: m.join_date,
    period_to: m.contract_end_date,
    probation_months: m.probation_months,
    probation_end: m.probation_months ? addMonths(m.join_date, m.probation_months) : null,
    training_months: m.training_months,
    weekly_hours: m.weekly_hours,
    work_style: m.work_style,
    work_scope: m.work_scope,
    job_content: m.initial_role,
    training_programs: m.training_programs,
    // 給与は、この行を読める人だけに見せる（029のRLSを035で人事と本人に絞ってある）
    wage_type: m.wage_type,
    wage_amount: m.wage_amount,
    wage_note: m.wage_note,
    remote_ok: m.work_style ? m.work_style !== "出社" : null,
    ai_status: "pending",
    note: `${from}で作成。原本の書類は別途保管してください`,
    confirmed_by: user.id,
    confirmed_at: new Date().toISOString(),
    uploaded_by: user.id,
  }).select("id").single();

  // 4) 3か月計画。職種テンプレートから作り、確定済みにする。
  //    ここを draft にすると、本人の初回ログインで画面が空になる
  const plan = buildPlan(m);
  const { data: gp, error: pe } = await sb.from("gw_growth_plans").insert({
    tenant_id: ctx.tenantId,
    employee_id: emp.id,
    user_id: userId,
    contract_id: contract?.id || null,
    start_date: m.join_date,
    end_date: addMonths(m.join_date, m.training_months),
    three_month_kgi: plan.threeMonthKgi,
    status: "active",
    ai_draft: { source: "template", code: plan.code, work_mode: plan.workMode },
    note: `${from}でテンプレートから作成。内容は本人と話して調整してください`,
    created_by: user.id,
    approved_by: user.id,
    approved_at: new Date().toISOString(),
  }).select("id").single();
  if (pe) throw new Error(`育成計画を作れませんでした: ${pe.message}`);

  // 5) 月ごとのKGIとKPI
  for (const [i, mo] of plan.months.entries()) {
    const { data: gm } = await sb.from("gw_growth_months").insert({
      plan_id: gp.id, user_id: userId,
      month_no: mo.month_no, month: mo.month,
      kgi: mo.kgi, target_level: mo.target_level,
      status: i === 0 ? "active" : "planned",
    }).select("id").single();

    if (gm && mo.kpis.length) {
      await sb.from("gw_growth_kpis").insert(
        mo.kpis.map((k) => ({
          sort_order: k.sort_order, name: k.name, kind: k.kind,
          target_value: k.target_value, unit: k.unit,
          from_daily: k.from_daily, template_code: k.template_code,
          month_id: gm.id, user_id: userId,
        })));
    }
  }
  entry.plan = { months: plan.months.length, kgi: plan.threeMonthKgi };

  // 6) 入社準備一式。手続き・チェックリスト・準備タスク・本人フォーム・個人フォルダ。
  //    ここが失敗しても登録は成立させる（あとから管理画面で作り直せる）
  entry.onboarding = await createOnboardingKit(sb, ctx, user, { ...emp, user_id: userId }, m);

  // 7) 初日にやること。これが無いと、初回ログインで画面が空になる
  await sb.from("gw_action_items").insert({
    user_id: userId,
    title: "入社フォームに記入する",
    detail: "住所・緊急連絡先・振込口座と、誓約書などの確認を1つの画面でまとめて終わらせます。"
          + "会社が把握している内容（入社日・契約・担当業務）は入力済みです。",
    source: "manager",
    due_date: m.join_date,
    priority: 1,
    created_by: user.id,
  });

  await sb.from("gw_action_items").insert({
    user_id: userId,
    title: "はじめての日報を出す",
    detail: "朝に今日の最優先とやること3つを決めて、終業時にどうなったかを書きます。"
          + "朝1分・終業2〜3分で終わります。",
    source: "manager",
    due_date: m.join_date,
    priority: 1,
    created_by: user.id,
  });

  return entry;
}

/**
 * 育成計画を組み立てる。DBには触らない。
 *
 * 登録前のプレビューと、実際の登録で同じ関数を使う。
 * 別々に書くと、「プレビューで見た内容と違うものが登録された」が起きる。
 */
export function buildPlan(m) {
  // 担当業務がKGI・KPIを決め、勤務・育成区分がそこに足す。
  //   管理職 … 1on1・Blocker解消（担当業務のKPIには出てこない）
  //   育成併用 … 無限道場の受講
  // 足したぶんは担当業務側の枠を減らすので、月のKPIは6個を超えない
  const plan = planFromTemplate(
    m.job_family_code, m.weekly_hours, m.training_months, modeKpis(m.work_mode));
  const months = monthsOf(m.join_date, m.training_months);
  const suffix = modeKgiSuffix(m.work_mode);

  return {
    code: plan.code,
    label: plan.label,
    workMode: m.work_mode || null,
    // 3か月目標だけは、書いてあればそちらを優先する。
    // フォームでは入力させないが、CSVには任意項目として残してある
    threeMonthKgi: m.three_month_goal
      || (suffix ? `${plan.threeMonthKgi}${suffix}` : plan.threeMonthKgi),
    startDate: m.join_date,
    endDate: addMonths(m.join_date, m.training_months),
    months: months.map((mo, i) => {
      const src = plan.months[i] || plan.months[plan.months.length - 1];
      return { month_no: mo.monthNo, month: mo.month, kgi: src.kgi, target_level: src.target_level, kpis: src.kpis };
    }),
  };
}

/** 管理担当者を引き当てる。メールで名簿を引く */
export async function linkManager(sb, tenantId, myEmail, managerEmail) {
  if (!myEmail || !managerEmail || myEmail === managerEmail) return null;

  const { data } = await sb.from("gw_employees")
    .select("id, email").eq("tenant_id", tenantId)
    .in("email", [myEmail, managerEmail]).limit(4);

  const byMail = new Map((data || []).map((e) => [(e.email || "").toLowerCase(), e.id]));
  const me = byMail.get(myEmail);
  const boss = byMail.get(managerEmail);
  if (!me || !boss || me === boss) return null;

  await sb.from("gw_employees").update({ manager_id: boss }).eq("id", me);
  return boss;
}

/**
 * 社員コードの自動採番。
 * 管理者に考えさせない項目なので、フォームにも出さない。
 */
export async function nextCode(sb, tenantId, taken = 0) {
  const { data } = await sb.from("gw_employees")
    .select("employee_code").eq("tenant_id", tenantId).not("employee_code", "is", null);
  const max = (data || []).reduce((n, e) => {
    const v = Number(String(e.employee_code).replace(/\D/g, ""));
    return Number.isFinite(v) && v > n ? v : n;
  }, 0);
  return `E${String(max + 1 + taken).padStart(4, "0")}`;
}
