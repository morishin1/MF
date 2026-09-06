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
// ■ これは補助機能。通常の登録はフォーム
//   1人ずつ入れるのにファイルを作らせるのは、手間が逆に増える。
//   通常は api/employees/onboard.js（フォーム）を使い、
//   ここは複数人をまとめて入れるときだけ通る。
//
//   登録そのものは lib/onboard.js の同じ関数を呼ぶ。
//   2か所に同じ処理を書くと、必ず片方だけ直されて食い違う。
//
// ■ 既存の一括取り込みは壊さない
//   api/employees/bulk.js は別の項目名で動いていて、
//   admin-members.html から使われている。作り替えず、こちらを別に置く。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  toRows, validateRow, FIELDS, templateHeader, templateSample,
} from "../../lib/intake.js";
import { jobOptions } from "../../lib/job-templates.js";
import { onboardOne, linkManager, nextCode } from "../../lib/onboard.js";

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

  // 社員コードの自動採番。この取り込みの中で何件振ったかを数えて重ならないようにする
  let issued = 0;

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
    const code = m.employee_code || await nextCode(sb, ctx.tenantId, issued++);

    try {
      const entry = await onboardOne(sb, ctx, user, m, {
        code, importRowId: row.id, source: "import",
      });
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

  // 管理担当者の引き当て。全員できてからでないと、
  // 同じファイルの中で上長も一緒に登録した場合に当たらない
  for (const row of rows) {
    const v = validateRow(row.raw_json);
    if (v.ok) await linkManager(sb, ctx.tenantId, v.value.login_email, v.value.manager_email);
  }

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
