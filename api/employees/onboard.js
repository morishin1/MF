// GET  /api/employees/onboard        … フォームの選択肢（区分・担当業務・管理担当者）
// POST /api/employees/onboard {form}          … 育成計画をプレビュー（登録しない）
// POST /api/employees/onboard {form, create}  … アカウント作成＋育成開始
//
// ■ 登録は3段階（勤務・育成区分 × 担当業務 → 労働条件）
//   STEP1 どう雇うか（lib/work-modes.js）… 期間・勤務時間・権限・開始レベル
//   STEP2 何をするか（lib/job-templates.js）… KGI・月間KPI
//   STEP3 その人ごとの条件 … 氏名・メール・入社日・契約・勤務時間・給与
//
//   区分と業務を掛け合わせると、STEP3 の大半が埋まる。
//   「新卒営業」のように畳んだテンプレートを並べると、雇い方が増えるたびに
//   職種のぶんだけ増えて 45通りになる。掛け合わせなら 5 + 9 で足りる。
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
//
// ■ アカウントの向きは「ここで作って、他システムへ配る」
//   無限道場に先に登録してもらう必要はない。
//   ここで登録すると auth.users を作り、そこから
//     無限道場（profiles・承認済みで作る）
//     タイムカード・日報（tc_profiles）
//     会計（memberships）
//   へ配る。逆向き（無限道場で作ってから社内アカウントにする）にすると、
//   本人が先に自分で登録して承認待ちになり、管理者の手数が増える。
//
//   ただし、その人が既に無限道場やタイムカードを使っていて
//   auth.users にアカウントがあることはある。そのときは新しく作らず、
//   既存のアカウントに紐づける（パスワードは変えない）。
//   それをプレビューの時点で見せる。押してから分かるのでは遅い。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { validateRow, WAGE_TYPES, ALLOWANCES } from "../../lib/intake.js";
import { jobOptions, JOB_GROUPS } from "../../lib/job-templates.js";
import { workModeOptions, combine } from "../../lib/work-modes.js";
import { rubric } from "../../lib/scoring.js";
import { onboardOne, buildPlan, linkManager, nextCode } from "../../lib/onboard.js";
import { findUserByEmail } from "../../lib/accounts.js";
import { LEVELS } from "../../lib/autonomy.js";
import { addMonths } from "../../lib/growth.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // アカウントを作る操作。社内の誰でもは通さない
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  // ?mode=GROWTH&job=BACKOFFICE … 掛け合わせた初期値だけを返す。
  // 組み立ての規則をサーバに1本化する。画面にも同じ規則を書くと、
  // 片方だけ直されて「プレビューで見た内容と違うものが登録された」が起きる
  if (req.method === "GET") {
    const q = new URL(req.url, "http://localhost").searchParams;
    if (q.get("mode")) {
      const values = combine(q.get("mode"), q.get("job"));
      if (!values) return json(res, 400, { error: "unknown_work_mode" });
      return json(res, 200, { values });
    }
  }
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
    workModes: workModeOptions(),
    jobs: jobOptions(),
    jobGroups: JOB_GROUPS,
    wageTypes: WAGE_TYPES,
    allowances: ALLOWANCES,
    levels: LEVELS.map((l) => ({ level: l.level, label: l.label, summary: l.summary })),
    // 担当業務が何であっても、日報で共通して見る評価軸。
    // 職種ごとにKPIは変わるが、ここは全員同じであることを画面で示す
    commonAxes: rubric().actions.map((a) => ({ short: a.short, label: a.label })),
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
    work_mode: form.workMode,
    job_family_code: form.jobFamilyCode,
    initial_role: form.initialRole,
    work_scope: list(form.workScope).join("、"),
    manager_email: form.managerEmail,
    training_program_code: list(form.trainingPrograms).join("、"),
    autonomy_level_start: form.autonomyLevel,
    three_month_goal: "",                    // AIとテンプレートが作る。入力させない
    kpi_template_code: "",
    account_type: form.accountType || "member",
    wage_type: form.wageType,
    wage_amount: form.wageAmount,
    // 選んだ手当と、当てはまらないぶんの自由記述をつなぐ。
    // 知らない語が来ても弾かない（CSVから来ることがある）
    wage_note: [
      ...(Array.isArray(form.allowances) ? form.allowances : []),
      form.wageNote,
    ].map((x) => String(x ?? "").trim()).filter(Boolean).join("、") || null,
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

  // 既にログインアカウントがあるか。無限道場やタイムカードを先に
  // 使っていた人は、ここに引っかかる。押してから分かるのでは遅い
  const acc = await accountState(sb, ctx, v.value.login_email);
  if (acc.blocked) {
    return json(res, 200, { ok: false, errors: [{ field: "メールアドレス", message: acc.message }] });
  }
  if (acc.message) warnings.push({ field: "ログインアカウント", message: acc.message });

  return json(res, 200, {
    ok: true, plan: buildPlan(v.value), warnings,
    value: shape(v.value), account: acc,
  });
}

/**
 * そのメールのログインアカウントが、いまどうなっているか。
 *
 *   new      … まだ無い。新しく作って初回パスワードを出す
 *   existing … もうある（無限道場・タイムカード・会計のどれかで作られている）。
 *              新しく作らず、そのアカウントに紐づける。パスワードは変えない
 *   taken    … もうあるが、名簿の別の人に割り当て済み。ここは進めない
 *
 * 判定できないとき（listUsers が失敗など）は new 扱いにせず、
 * 分からないことを分からないまま返す。作成側でもう一度見る
 */
async function accountState(sb, ctx, email) {
  let userId;
  try {
    userId = await findUserByEmail(sb, email);
  } catch (e) {
    return {
      kind: "unknown", blocked: false,
      message: `既存アカウントの確認ができませんでした（${String(e.message).slice(0, 120)}）。`
        + "登録は試せますが、途中で止まることがあります",
    };
  }

  if (!userId) {
    return {
      kind: "new", blocked: false,
      message: null,
    };
  }

  const { data: taken } = await sb.from("gw_employees")
    .select("display_name, employee_code")
    .eq("tenant_id", ctx.tenantId).eq("user_id", userId).maybeSingle();

  if (taken) {
    return {
      kind: "taken", blocked: true,
      message: `「${email}」のログインアカウントは、${taken.display_name} さん`
        + `（${taken.employee_code || "コード未設定"}）に割り当て済みです。`
        + "同じ人であれば、新規登録ではなくメンバー一覧からその行を直してください。",
    };
  }

  return {
    kind: "existing", blocked: false,
    message: "この方は既にログインアカウントをお持ちです"
      + "（無限道場・タイムカードなどで作成済み）。"
      + "新しくは作らず、そのアカウントに紐づけます。"
      + "パスワードは変わりません（いま使っているものでログインできます）。",
  };
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

  // プレビューで見せたのと同じ確認を、押した直後にもう一度する。
  // 見てから押すまでのあいだに、別の管理者が同じ人を入れていることがある
  const acc = await accountState(sb, ctx, m.login_email);
  if (acc.blocked) {
    return json(res, 409, { error: "account_taken", hint: acc.message });
  }

  // 初回パスワード。空なら自動生成する。
  // マスターには入れない（CSVの列にもしない）ので、ここで直接受け取る
  const password = String(body?.form?.password ?? "").trim();
  if (password && password.length < 8) {
    return json(res, 400, { error: "weak_password", hint: "パスワードは8文字以上にしてください" });
  }

  let created;
  try {
    created = await onboardOne(sb, ctx, user, m, {
      code: await nextCode(sb, ctx.tenantId),
      source: "form",
      password: password || null,
    });
  } catch (e) {
    // どの段で止まったかまで返す。「onboard_failed」だけでは調べようがない。
    // 名簿は残してあるので、画面から続きをやり直せる
    return json(res, 500, {
      error: "onboard_failed",
      step: e?.step || null,
      hint: String(e?.message || e).slice(0, 500),
      detail: String(e?.message || e).slice(0, 500),
    });
  }

  await linkManager(sb, ctx.tenantId, m.login_email, m.manager_email);

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "employee.onboard",
    target: `employee:${m.name}`,
    detail: { job: m.job_family_code, level: m.autonomy_level_start, months: m.training_months },
  });

  return json(res, 200, { ok: true, created, account: acc });
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
  workMode: m.work_mode ? (workModeOptions().find((w) => w.code === m.work_mode)?.label || m.work_mode) : null,
  job: jobOptions().find((j) => j.code === m.job_family_code)?.label || m.job_family_code,
  role: m.initial_role,
  // 給与は、この画面を開けている人（人事権限）にだけ返す。
  // 名簿や本人の画面には出さない
  wage: m.wage_amount
    ? `${m.wage_type} ${Number(m.wage_amount).toLocaleString("ja-JP")}円`
      + (m.wage_note ? `（${m.wage_note}）` : "")
    : null,
  workStyle: m.work_style || "指定なし",
  scope: m.work_scope,
  programs: m.training_programs,
  manager: m.manager_email,
  level: m.autonomy_level_start,
  accountType: m.account_type,
});
