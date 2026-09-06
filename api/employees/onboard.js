// GET  /api/employees/onboard        … フォームの選択肢（テンプレート・職種・管理担当者）
// POST /api/employees/onboard {form}          … 育成計画をプレビュー（登録しない）
// POST /api/employees/onboard {form, create}  … アカウント作成＋育成開始
//
// ■ 通常の登録はここ。CSV/XLSX は複数人のときだけ
//   1人ずつ入れるのにファイルを作らせるのは、手間が逆に増える。
//   入口はフォーム、複数人のときだけ api/employees/intake.js。
//   どちらも最後は lib/onboard.js の同じ関数を通る。
//
// ■ 管理者に入力させないもの
//   3か月KGI・月間KGI・KPI・NEXT ACTION・週次目標。
//   すべて職種テンプレートから作る。管理者が毎回考える形にすると、
//   入社のたびに時間がかかり、結局「あとで決める」まま放置される。
//
// ■ プレビューを挟む理由
//   押した瞬間に4システムぶんのアカウントができる。
//   何が作られるのかを見てから押せるようにする。
//   プレビューと登録で同じ関数（buildPlan）を使うので、
//   「見た内容と違うものが登録された」は起きない。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { validateRow } from "../../lib/intake.js";
import { jobOptions } from "../../lib/job-templates.js";
import { hireOptions } from "../../lib/hire-templates.js";
import { onboardOne, buildPlan, linkManager, nextCode } from "../../lib/onboard.js";
import { LEVELS } from "../../lib/autonomy.js";
import { addMonths } from "../../lib/growth.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // アカウントを作る操作。社内の誰でもは通さない
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return options(res, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    return body?.create ? create(res, ctx, user, body) : preview(res, ctx, body);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- フォームの選択肢 ---------------------------------------------------------
async function options(res, ctx) {
  const sb = admin();

  // 管理担当者に選べる人。メールがある在籍者だけ
  const { data: staff } = await sb.from("gw_employees")
    .select("display_name, email, position")
    .eq("tenant_id", ctx.tenantId).in("status", ["active", "leaving"])
    .not("email", "is", null).order("display_name").limit(300);

  return json(res, 200, {
    hireTemplates: hireOptions(),
    jobs: jobOptions(),
    levels: LEVELS.map((l) => ({ level: l.level, label: l.label, summary: l.summary })),
    managers: (staff || []).map((e) => ({
      email: e.email, name: e.display_name, position: e.position,
    })),
  });
}

// ---- 入力をマスター形式にそろえる ----------------------------------------------
// フォームとCSVで検証を1本にする。CSVだけ通る値、フォームだけ通る値を作らない
function toMaster(form) {
  const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/[、,／/・|]/))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 12);

  return {
    employee_code: "",                       // 自動採番。フォームには出さない
    name: form.name,
    login_email: form.email,
    join_date: form.joinDate,
    contract_type: form.contractType,
    contract_end_date: form.contractEndDate,
    probation_months: form.probationMonths,
    training_months: form.trainingMonths,
    weekly_hours: form.weeklyHours,
    work_style: form.workStyle,
    job_family_code: form.jobFamilyCode,
    initial_role: form.initialRole,
    work_scope: list(form.workScope).join("、"),
    manager_email: form.managerEmail,
    training_program_code: list(form.trainingPrograms).join("、"),
    autonomy_level_start: form.autonomyLevel,
    three_month_goal: "",                    // AIとテンプレートが作る。入力させない
    kpi_template_code: "",
    account_type: form.accountType || "member",
    notes: form.notes,
  };
}

// ---- プレビュー（登録しない） --------------------------------------------------
async function preview(res, ctx, body) {
  const v = validateRow(toMaster(body.form || {}));
  if (!v.ok) return json(res, 200, { ok: false, errors: v.errors });

  const sb = admin();
  const warnings = [];

  // 重複はここで見せる。押してから弾かれるより、先に分かるほうがよい
  const { data: dup } = await sb.from("gw_employees").select("display_name")
    .eq("tenant_id", ctx.tenantId).eq("email", v.value.login_email).limit(1);
  if (dup?.length) {
    return json(res, 200, {
      ok: false,
      errors: [{ field: "メールアドレス", message: `「${v.value.login_email}」は ${dup[0].display_name} さんで既に登録されています` }],
    });
  }

  const { data: boss } = await sb.from("gw_employees").select("display_name")
    .eq("tenant_id", ctx.tenantId).eq("email", v.value.manager_email).limit(1);
  if (!boss?.length) {
    warnings.push({
      field: "管理担当者",
      message: `「${v.value.manager_email}」に当てはまる人がいません。登録はできますが、あとで設定してください`,
    });
  }

  return json(res, 200, { ok: true, plan: buildPlan(v.value), warnings, value: shape(v.value) });
}

// ---- アカウント作成＋育成開始 --------------------------------------------------
async function create(res, ctx, user, body) {
  const v = validateRow(toMaster(body.form || {}));
  if (!v.ok) return json(res, 200, { ok: false, errors: v.errors });
  const m = v.value;

  const sb = admin();

  // 押す直前にもう一度見る。プレビューから登録までのあいだに
  // 別の管理者が同じ人を入れていることがある
  const { data: dup } = await sb.from("gw_employees").select("display_name")
    .eq("tenant_id", ctx.tenantId).eq("email", m.login_email).limit(1);
  if (dup?.length) {
    return json(res, 409, {
      error: "duplicate_email",
      hint: `「${m.login_email}」は ${dup[0].display_name} さんで既に登録されています`,
    });
  }

  let created;
  try {
    created = await onboardOne(sb, ctx, user, m, {
      code: await nextCode(sb, ctx.tenantId),
      source: "form",
    });
  } catch (e) {
    return json(res, 500, {
      error: "onboard_failed",
      hint: String(e?.message || e).slice(0, 400),
    });
  }

  await linkManager(sb, ctx.tenantId, m.login_email, m.manager_email);

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "employee.onboard",
    target: `employee:${m.name}`,
    detail: { job: m.job_family_code, level: m.autonomy_level_start, months: m.training_months },
  });

  return json(res, 200, { ok: true, created });
}

/** プレビューに出す、確定した値 */
const shape = (m) => ({
  name: m.name,
  email: m.login_email,
  joinDate: m.join_date,
  contract: m.contract_type === "有期"
    ? `有期（${m.join_date} 〜 ${m.contract_end_date}）`
    : "無期",
  probation: m.probation_months ? `${m.probation_months}か月` : "なし",
  training: `${m.training_months}か月（${m.join_date} 〜 ${addMonths(m.join_date, m.training_months)}）`,
  weeklyHours: `週 ${m.weekly_hours} 時間`,
  job: m.job_family_code,
  role: m.initial_role,
  workStyle: m.work_style || "指定なし",
  scope: m.work_scope,
  programs: m.training_programs,
  manager: m.manager_email,
  level: m.autonomy_level_start,
  accountType: m.account_type,
});
