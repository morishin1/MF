// POST /api/employees/intake { filename, table, commit? }
//        commit なし … 検証だけして結果を返す（何も登録しない）
//        commit: <batchId> … 検証を通った行を登録し、アカウントと育成計画まで作る
// GET  /api/employees/intake … 最近の取り込みと、職種テンプレートの一覧
//
// ■ なぜ2段構えなのか
//   1行のミスが、人事データと4システムぶんのアカウントを同時に生む。
//   間違ったメールで作ったアカウントは、消しても
//   無限道場・タイムカード・会計に痕跡が残る。
//
//   だから先に検証だけ走らせ、「成功N件 / エラーN件」を管理者に見せる。
//   押して初めて登録する。ここは短縮しない。
//
// ■ 一部エラーでも全件止めない（§11）
//   10行のうち2行が駄目でも、8行は登録する。
//   全部やり直しになると、結局手作業のほうが速くなる。
//
// ■ 既存の一括取り込みは壊さない
//   api/employees/bulk.js は別の項目名で動いていて、
//   admin-members.html から使われている。作り替えず、こちらを別に置く。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { attachAccount } from "../../lib/accounts.js";
import {
  toRows, validateRow, FIELDS, templateHeader, templateSample,
} from "../../lib/intake.js";
import { jobOptions, planFromTemplate } from "../../lib/job-templates.js";
import { addMonths, monthsOf } from "../../lib/growth.js";

const MAX_ROWS = 200;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 人事権限が要る。アカウントを作る操作なので、社内の誰でもは通さない
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(res, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    return body?.commit ? apply(res, ctx, user, body) : check(res, ctx, user, body);
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 一覧 -------------------------------------------------------------------
async function read(res, ctx) {
  const sb = admin();
  const { data } = await sb.from("gw_import_batches").select("*")
    .eq("tenant_id", ctx.tenantId).order("created_at", { ascending: false }).limit(10);

  return json(res, 200, {
    batches: (data || []).map(shapeBatch),
    jobs: jobOptions(),
    fields: FIELDS.map((f) => ({ key: f.key, label: f.label, required: f.required })),
    template: { header: templateHeader(), sample: templateSample() },
  });
}

// ---- 検証だけ（登録しない） ---------------------------------------------------
async function check(res, ctx, user, body) {
  const table = Array.isArray(body?.table) ? body.table : null;
  if (!table?.length) return json(res, 400, { error: "invalid_body", required: ["table"] });

  const parsed = toRows(table);
  if (parsed.missing.length) {
    return json(res, 400, {
      error: "missing_columns",
      hint: `必須の列がありません：${parsed.missing.join("、")}。雛形をダウンロードして使ってください。`,
      missing: parsed.missing,
    });
  }
  if (!parsed.rows.length) return json(res, 400, { error: "no_rows", hint: "データの行がありません" });
  if (parsed.rows.length > MAX_ROWS) {
    return json(res, 400, { error: "too_many_rows", hint: `一度に取り込めるのは ${MAX_ROWS} 行までです` });
  }

  const sb = admin();

  // 既にいる人。メールと社員コードで見る（§10）
  const { data: existing } = await sb.from("gw_employees")
    .select("email, employee_code").eq("tenant_id", ctx.tenantId).limit(2000);
  const mails = new Set((existing || []).map((e) => (e.email || "").toLowerCase()).filter(Boolean));
  const codes = new Set((existing || []).map((e) => e.employee_code).filter(Boolean));

  // ファイルの中での重複も見る。同じメールが2行あると、2つ目でアカウント作成が落ちる
  const seenMail = new Set();
  const seenCode = new Set();

  const results = parsed.rows.map((raw) => {
    const v = validateRow(raw);
    if (!v.ok) return { row: raw._row, status: "error", raw, errors: v.errors };

    const errors = [];
    const val = v.value;

    if (mails.has(val.login_email)) {
      errors.push({ field: "ログインメール", message: `「${val.login_email}」は既に登録されています` });
    } else if (seenMail.has(val.login_email)) {
      errors.push({ field: "ログインメール", message: "このファイルの中で重複しています" });
    }
    if (val.employee_code) {
      if (codes.has(val.employee_code)) {
        errors.push({ field: "社員コード", message: `「${val.employee_code}」は既に使われています` });
      } else if (seenCode.has(val.employee_code)) {
        errors.push({ field: "社員コード", message: "このファイルの中で重複しています" });
      }
    }

    if (errors.length) return { row: raw._row, status: "error", raw, errors };

    seenMail.add(val.login_email);
    if (val.employee_code) seenCode.add(val.employee_code);
    return { row: raw._row, status: "ok", raw, value: val };
  });

  // 上長メールが、この会社の誰にも当たらない場合は注意として出す。
  // エラーにはしない（同じファイルで上長も一緒に登録することがあるため）
  const known = new Set([...mails, ...results.filter((r) => r.value).map((r) => r.value.login_email)]);
  for (const r of results) {
    if (r.status !== "ok") continue;
    if (!known.has(r.value.manager_email)) {
      r.warnings = [{ field: "管理責任者メール", message: `「${r.value.manager_email}」に当てはまる人がいません。あとで設定できます` }];
    }
  }

  const okRows = results.filter((r) => r.status === "ok");

  // 検証の結果を記録に残す。押す前に一度離席しても、続きから登録できる
  const { data: batch, error } = await sb.from("gw_import_batches").insert({
    tenant_id: ctx.tenantId,
    filename: String(body.filename ?? "").slice(0, 200) || null,
    uploaded_by: user.id,
    total_rows: results.length,
    success_rows: okRows.length,
    error_rows: results.length - okRows.length,
    status: okRows.length ? "checked" : "failed",
  }).select("*").single();
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  await sb.from("gw_import_rows").insert(results.map((r) => ({
    batch_id: batch.id,
    row_no: r.row,
    raw_json: r.raw,
    status: r.status,
    error_json: r.errors || null,
  })));

  return json(res, 200, {
    batch: shapeBatch(batch),
    results: results.map(shapeResult),
    unknownColumns: parsed.unknown,
  });
}

// ---- 登録する ---------------------------------------------------------------
async function apply(res, ctx, user, body) {
  const sb = admin();

  const { data: batch } = await sb.from("gw_import_batches").select("*")
    .eq("id", body.commit).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!batch) return json(res, 404, { error: "batch_not_found" });
  if (batch.status === "applied") {
    return json(res, 409, { error: "already_applied", hint: "この取り込みは登録済みです" });
  }

  const { data: rows } = await sb.from("gw_import_rows").select("*")
    .eq("batch_id", batch.id).eq("status", "ok").order("row_no");
  if (!rows?.length) return json(res, 400, { error: "no_valid_rows", hint: "登録できる行がありません" });

  // 社員コードの自動採番（§10）。すでにある最大値の次から振る
  const { data: coded } = await sb.from("gw_employees")
    .select("employee_code").eq("tenant_id", ctx.tenantId).not("employee_code", "is", null);
  let next = (coded || []).reduce((max, e) => {
    const n = Number(String(e.employee_code).replace(/\D/g, ""));
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  const created = [];
  const failed = [];

  for (const row of rows) {
    // 検証をやり直す。検証から登録までのあいだに、別の取り込みが走ることがある
    const v = validateRow(row.raw_json);
    if (!v.ok) {
      failed.push({ row: row.row_no, name: row.raw_json?.name, errors: v.errors });
      await sb.from("gw_import_rows")
        .update({ status: "error", error_json: v.errors }).eq("id", row.id);
      continue;
    }
    const m = v.value;
    const code = m.employee_code || `E${String(++next).padStart(4, "0")}`;

    try {
      const entry = await createOne(sb, ctx, user, m, code, row.id);
      created.push({ row: row.row_no, ...entry });
      await sb.from("gw_import_rows").update({
        status: "created",
        created_employee_id: entry.employeeId,
        created_user_id: entry.userId || null,
      }).eq("id", row.id);
    } catch (err) {
      const errors = [{ field: "登録", message: String(err?.message || err).slice(0, 300) }];
      failed.push({ row: row.row_no, name: m.name, errors });
      await sb.from("gw_import_rows").update({ status: "error", error_json: errors }).eq("id", row.id);
    }
  }

  // 上長の引き当て。全員できてからでないと、
  // 同じファイルの中で上長も一緒に登録した場合に当たらない
  await linkManagers(sb, ctx.tenantId, rows.map((r) => r.raw_json));

  const { data: done } = await sb.from("gw_import_batches").update({
    status: created.length ? "applied" : "failed",
    success_rows: created.length,
    error_rows: batch.total_rows - created.length,
    applied_at: new Date().toISOString(),
  }).eq("id", batch.id).select("*").single();

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "employee.intake",
    target: `batch:${batch.id}`,
    detail: { filename: batch.filename, created: created.length, failed: failed.length },
  });

  return json(res, 200, { batch: shapeBatch(done), created, failed });
}

/**
 * 1人ぶん作る。名簿 → アカウント → 労働条件 → 3か月計画 → 初日の1件。
 *
 * 途中で失敗したら、その行だけエラーにして次へ進む（§11）。
 * 作りかけの行は残るが、消すほうが危ない。
 * 名簿だけできてアカウントが無い状態は画面から直せるが、
 * 消してしまうと何が起きたか分からなくなる。
 */
async function createOne(sb, ctx, user, m, code, importRowId) {
  // 1) 名簿
  const { data: emp, error } = await sb.from("gw_employees").insert({
    tenant_id: ctx.tenantId,
    display_name: m.name,
    email: m.login_email,
    employee_code: code,
    employment_type: m.contract_type === "有期" ? "契約社員" : "正社員",
    joined_on: m.join_date,
    job_family_code: m.job_family_code,
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

  // 3) 労働条件。契約書のPDFは無いので、マスターの値を確定済みとして入れる。
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
    remote_ok: m.work_style ? m.work_style !== "出社" : null,
    ai_status: "pending",
    note: "雇用・育成マスターの取り込みで作成。原本の書類は別途保管してください",
    confirmed_by: user.id,
    confirmed_at: new Date().toISOString(),
    uploaded_by: user.id,
  }).select("id").single();

  // 4) 3か月計画。テンプレートから作り、確定済みにする。
  //    ここを draft にすると、本人の初回ログインで画面が空になる
  const plan = planFromTemplate(m.job_family_code, m.weekly_hours, m.training_months);
  const { data: gp, error: pe } = await sb.from("gw_growth_plans").insert({
    tenant_id: ctx.tenantId,
    employee_id: emp.id,
    user_id: userId,
    contract_id: contract?.id || null,
    start_date: m.join_date,
    end_date: addMonths(m.join_date, m.training_months),
    // マスターに3か月目標が書いてあればそれを使う。空ならテンプレート（§5）
    three_month_kgi: m.three_month_goal || plan.threeMonthKgi,
    status: "active",
    ai_draft: { source: "template", code: plan.code },
    note: "取り込み時にテンプレートから作成。内容は本人と話して調整してください",
    created_by: user.id,
    approved_by: user.id,
    approved_at: new Date().toISOString(),
  }).select("id").single();
  if (pe) throw new Error(`育成計画を作れませんでした: ${pe.message}`);

  // 5) 月ごとのKGIとKPI
  const months = monthsOf(m.join_date, m.training_months);
  for (const [i, mo] of months.entries()) {
    const src = plan.months[i] || plan.months[plan.months.length - 1];
    const { data: gm } = await sb.from("gw_growth_months").insert({
      plan_id: gp.id, user_id: userId,
      month_no: mo.monthNo, month: mo.month,
      kgi: src.kgi, target_level: src.target_level,
      status: i === 0 ? "active" : "planned",
    }).select("id").single();

    if (gm && src.kpis.length) {
      await sb.from("gw_growth_kpis").insert(
        src.kpis.map((k) => ({ ...k, month_id: gm.id, user_id: userId })));
    }
  }
  entry.plan = { months: months.length, kgi: m.three_month_goal || plan.threeMonthKgi };

  // 6) 初日にやること。これが無いと、初回ログインで画面が空になる
  {
    await sb.from("gw_action_items").insert({
      user_id: userId,
      title: "はじめての日報を出す",
      detail: "今日やったことと、明日いちばんに取りかかることを書いてください。"
            + "書き方に迷ったら、上長に聞いて構いません。",
      source: "manager",
      due_date: m.join_date,
      priority: 1,
      created_by: user.id,
    });
  }

  return entry;
}

/** 上長を引き当てる。メールで名簿を引く */
async function linkManagers(sb, tenantId, masters) {
  const { data: all } = await sb.from("gw_employees")
    .select("id, email").eq("tenant_id", tenantId).not("email", "is", null).limit(2000);
  const byMail = new Map((all || []).map((e) => [(e.email || "").toLowerCase(), e.id]));

  for (const raw of masters) {
    const v = validateRow(raw);
    if (!v.ok) continue;
    const me = byMail.get(v.value.login_email);
    const boss = byMail.get(v.value.manager_email);
    // 自分を自分の上長にしない
    if (!me || !boss || me === boss) continue;
    await sb.from("gw_employees").update({ manager_id: boss }).eq("id", me);
  }
}

const shapeBatch = (b) => ({
  id: b.id, filename: b.filename, status: b.status,
  total: b.total_rows, success: b.success_rows, error: b.error_rows,
  createdAt: b.created_at, appliedAt: b.applied_at,
});

const shapeResult = (r) => ({
  row: r.row, status: r.status,
  name: r.value?.name || r.raw?.name || "",
  email: r.value?.login_email || r.raw?.login_email || "",
  job: r.value?.job_family_code || "",
  level: r.value?.autonomy_level_start || null,
  errors: r.errors || [],
  warnings: r.warnings || [],
});
