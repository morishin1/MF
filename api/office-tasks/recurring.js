// Office 定例業務マスター（db/125・lib/office-recurring.js）。
//
// GET  /api/office-tasks/recurring
//        … 見られるカテゴリのマスター一覧（次回予定日・繰り返し・期限・担当・担当が退職していないか）と、担当に選べる社員
// POST /api/office-tasks/recurring {action:"create", ...}                 … 作る（作ったら、今日から先90日の予定を作る）
// POST /api/office-tasks/recurring {action:"update", id, ...}             … 直す（今日以降の未完了の予定を作り直す。完了・過去は残す）
// POST /api/office-tasks/recurring {action:"set_active", id, active}      … 有効／停止（停止すると今日以降の未完了の予定を消す。マスターは消さない）
// POST /api/office-tasks/recurring {action:"import_preview", cells, periodStart}
//        … Excel 年間予定表のセル（画面が読んだもの）から変換一覧を作る。まだ何も登録しない
// POST /api/office-tasks/recurring {action:"import_commit", rows}
//        … 変換一覧で「登録」にした行だけ入れる（定例 → マスター／単発 → 予定）。同じ行は2回入れない（旧い取り込み。画面は下の同期を使う）
// POST /api/office-tasks/recurring {action:"sync_preview", cells, periodStart?, decisions?}
//        … Excel 年間予定表を「Excel 由来の定例業務の最新版」として同期したときの差分（新規・更新・変更なし・停止・再有効化・要確認）。
//          まだ何も変えない。syncToken を返す（確定のときに、同じ Excel・同じ DB の状態かを確かめる）
// POST /api/office-tasks/recurring {action:"sync_commit", cells, periodStart, syncToken, decisions?, assignees?, fileName?, fileHash?}
//        … 差分をサーバでもう一度作り直して（画面から来た行は信用しない）、syncToken が同じときだけ反映する（lib/office-excel-sync.js・db/128）
//          手動のマスターは触らない。消さない（停止だけ）。担当・優先度・URL など Excel が持たない項目は空欄に戻さない。
//          今日以降の未完了の予定だけ作り直す（過去・完了・今回なしは残す）。同じテナントで同時に2つは走らせない
//
// ■ 権限（Office の既存の権限。lib/gw.js と同じ判定）
//   見る：カテゴリごと（人事・労務＝人事・労務／経理＝経理・事務／営業事務＝経理・事務か月末月初／ほか＝Office の業務のどれか）
//   直す：カテゴリごと（全体・EC・NW・その他は月末月初か管理者）。Excel の取り込みも、行のカテゴリを直せる人だけ
//   表は RLS でログインした人から閉じてあり、ここで確かめてから service role で読み書きする
//   人事・労務だけの人（canAccessOffice＝経営者・責任者・経理 に入らない）も使うので、api/office/ ではなく
//   api/office-tasks/ に置く（api/office/* は canAccessOffice 専用。api/billing-progress と同じ考え方）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import * as GW from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { jstDate } from "../../lib/timecard.js";
import {
  CATEGORIES, PRIORITIES, permsOf, canUseRecurring, canViewCategory, canEditCategory, editableCategories,
  validateMaster, describeRule, describeDue, nextOccurrence, categoryLabel, classifyExcel, isDate, TITLE_MAX,
} from "../../lib/office-recurring.js";
import { MASTER_FIELDS, syncMaster, generate } from "../../lib/office-recurring-db.js";
import { planSync, syncToken, periodFromSheets, periodLabel, sheetsOutOfPeriod } from "../../lib/office-excel-sync.js";
import { HORIZON_DAYS, addDays } from "../../lib/office-recurring.js";

const SQL = "db/125_office_recurring.sql";
const SYNC_SQL = "db/128_office_excel_sync.sql";
const SYNC_FIELDS_DB = "id, period_start, original_filename, total_rows, new_count, update_count, unchanged_count, stop_count, reactivate_count, status, created_by_name, created_at, committed_at";
const STALE_LOCK_MS = 10 * 60 * 1000;   // 同期中のまま10分たったものは、止まったとみなして鍵を外す
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const MAX_CELLS = 6000;
const MAX_IMPORT = 1000;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await GW.gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  const perms = permsOf(ctx, GW);
  if (!canUseRecurring(perms)) return json(res, 403, { error: "forbidden" });
  const sb = admin();
  try {
    if (req.method === "GET") return await list(res, sb, ctx, perms);
    if (req.method === "POST") return await act(req, res, sb, ctx, user, perms);
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[office/recurring]", e?.message || e);
    return json(res, 500, { error: "office_recurring_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function staff(sb, ctx) {
  return (await must(sb.from("gw_employees").select("id, display_name, department, status")
    .eq("tenant_id", ctx.tenantId).order("display_name").limit(500))) || [];
}

export function shapeMaster(t, people, today, perms) {
  const who = t.assignee_employee_id ? people.get(t.assignee_employee_id) : null;
  return {
    id: t.id, title: t.title, description: t.description, category: t.category, categoryLabel: categoryLabel(t.category),
    assigneeId: t.assignee_employee_id, assigneeName: who?.display_name || null,
    // 担当が退職した・名簿にいない。消さずに「担当者未設定」として知らせる
    assigneeMissing: !t.assignee_employee_id || !who || who.status === "left",
    department: t.department, priority: t.priority, note: t.note, url: t.url,
    recurrenceType: t.recurrence_type, recurrenceRule: t.recurrence_rule || {}, dueRule: t.due_rule || { type: "same" },
    ruleText: describeRule(t.recurrence_type, t.recurrence_rule || {}), dueText: describeDue(t.due_rule || {}),
    startOn: t.start_on, endOn: t.end_on, active: Boolean(t.is_active), source: t.source,
    nextDate: nextOccurrence(t, today), updatedAt: t.updated_at, canEdit: canEditCategory(perms, t.category),
  };
}

async function list(res, sb, ctx, perms) {
  const today = jstDate();
  const cats = CATEGORIES.map((c) => c.key).filter((k) => canViewCategory(perms, k));
  const [rows, people] = await Promise.all([
    must(sb.from("gw_office_recurring_tasks").select(MASTER_FIELDS).eq("tenant_id", ctx.tenantId).in("category", cats)
      .order("updated_at", { ascending: false }).limit(2000)),
    staff(sb, ctx),
  ]);
  const byId = new Map(people.map((p) => [p.id, p]));
  return json(res, 200, {
    today,
    sync: await syncState(sb, ctx),
    masters: (rows || []).map((t) => shapeMaster(t, byId, today, perms)),
    employees: people.filter((p) => p.status !== "left").map((p) => ({ id: p.id, name: p.display_name, department: p.department })),
    categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, col: c.col, view: cats.includes(c.key), edit: canEditCategory(perms, c.key) })),
    priorities: PRIORITIES,
    perms,
  });
}

// ---- Excel 最新版同期（db/128） ---------------------------------------------------------------
const shapeSync = (r) => r && ({
  id: r.id, periodStart: r.period_start, periodLabel: periodLabel(r.period_start), fileName: r.original_filename,
  total: r.total_rows, new: r.new_count, update: r.update_count, unchanged: r.unchanged_count, stop: r.stop_count, reactivate: r.reactivate_count,
  status: r.status, byName: r.created_by_name, createdAt: r.created_at, committedAt: r.committed_at,
});
/** 最後に完了した同期と、同期中のもの。表が無ければ ready=false（同期だけ使えない。ほかは止めない） */
async function syncState(sb, ctx) {
  const { data, error } = await sb.from("gw_office_excel_syncs").select(SYNC_FIELDS_DB).eq("tenant_id", ctx.tenantId)
    .order("created_at", { ascending: false }).limit(20);
  if (error) {
    if (dbSetupHint(error, SYNC_SQL)) return { ready: false, last: null, applying: null, hint: dbSetupHint(error, SYNC_SQL) };
    throw error;
  }
  const rows = data || [];
  const last = rows.filter((r) => r.status === "committed").sort((a, b) => String(b.committed_at).localeCompare(String(a.committed_at)))[0];
  const applying = rows.find((r) => r.status === "applying");
  const failed = rows[0]?.status === "failed" ? rows[0] : null;
  return { ready: true, last: shapeSync(last) || null, applying: shapeSync(applying) || null, failed: shapeSync(failed) };
}

/** 画面から来たセルを整える（決まった列・行だけ。長さも切る） */
function cleanCells(raw) {
  return (Array.isArray(raw) ? raw.slice(0, MAX_CELLS) : []).map((c) => ({
    sheet: String(c?.sheet || "").slice(0, 60), header: String(c?.header || "").slice(0, 60), row: Number(c?.row) || 0,
    day: Number(c?.day), col: String(c?.col || "").slice(0, 2), text: String(c?.text || "").slice(0, 2000),
  }));
}

/** 差分を作る（プレビューと確定で同じ手順） */
async function buildSync(sb, ctx, perms, b) {
  const cells = cleanCells(b?.cells);
  if (!cells.length) return { error: "Excel から読めた行がありません。年間予定表のファイルか確かめてください" };
  const sheetNames = [...new Set(cells.map((c) => c.sheet))];
  const periodStart = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(b?.periodStart || "")) ? b.periodStart : periodFromSheets(sheetNames);
  if (!periodStart) return { error: "期の始まり（例：2026年9月）を選んでください。シート名（例：202609月）からも分かりませんでした" };
  const out = classifyExcel(cells, { periodStart });
  const masters = (await must(sb.from("gw_office_recurring_tasks").select(MASTER_FIELDS)
    .eq("tenant_id", ctx.tenantId).eq("source", "excel").limit(5000))) || [];
  const decisions = {};
  for (const [k, v] of Object.entries(b?.decisions && typeof b.decisions === "object" ? b.decisions : {})) {
    if (v === "link" || v === "separate") decisions[String(k).slice(0, 200)] = v;
  }
  const plan = planSync({ excelRows: out.rows, masters, perms, decisions });
  return {
    periodStart, plan, masters, excelRows: out.rows, sheets: out.sheets,
    token: syncToken({ periodStart, excelRows: out.rows, masters }),
    outOfPeriod: sheetsOutOfPeriod(sheetNames, periodStart),
  };
}

async function syncPreview(res, sb, ctx, perms, b) {
  const s = await buildSync(sb, ctx, perms, b);
  if (s.error) return json(res, 400, { error: "invalid", hint: s.error });
  const state = await syncState(sb, ctx);
  return json(res, 200, {
    periodStart: s.periodStart, periodLabel: periodLabel(s.periodStart), summary: s.plan.summary, rows: s.plan.rows,
    singles: s.plan.singles, sheets: s.sheets, outOfPeriod: s.outOfPeriod, syncToken: s.token,
    ready: state.ready, hint: state.hint || null, applying: state.applying,
  });
}

async function syncCommit(res, sb, ctx, user, perms, b, today) {
  const state = await syncState(sb, ctx);
  if (!state.ready) return json(res, 503, { error: "not_ready", message: state.hint });
  const s = await buildSync(sb, ctx, perms, b);
  if (s.error) return json(res, 400, { error: "invalid", hint: s.error });
  if (!b?.syncToken || b.syncToken !== s.token) {
    return json(res, 409, { error: "stale", hint: "Excel の内容か、定例業務がプレビューのあとで変わりました。もう一度読み込んで差分を確かめてください" });
  }
  const undecided = s.plan.rows.filter((r) => r.action === "review" && !r.forbidden);
  if (undecided.length) return json(res, 400, { error: "undecided", hint: `要確認の ${undecided.length}件について、「同じ業務として更新」か「別の業務として登録」を選んでください` });

  // 担当（新規の行だけ。名簿にいる人だけ）
  const want = b?.assignees && typeof b.assignees === "object" ? b.assignees : {};
  const ids = [...new Set(Object.values(want).filter(Boolean).map(String))].slice(0, 500);
  const okIds = new Set(ids.length ? ((await must(sb.from("gw_employees").select("id").eq("tenant_id", ctx.tenantId).in("id", ids))) || []).map((e) => e.id) : []);
  for (const id of ids) if (!okIds.has(id)) return json(res, 400, { error: "invalid", hint: "担当者が名簿にいません" });

  // 同時に2つ走らせない（止まったままの古い同期は、失敗にして鍵を外す）
  const stale = new Date(Date.now() - STALE_LOCK_MS).toISOString();
  await must(sb.from("gw_office_excel_syncs").update({ status: "failed", lock_key: null, error_detail: "同期中のまま止まっていました" })
    .eq("tenant_id", ctx.tenantId).eq("status", "applying").lt("created_at", stale).select("id"));
  const ops = s.plan.ops;
  const changedUpdates = ops.updates.filter((u) => u.changed && !u.reactivate);
  const reactivates = ops.updates.filter((u) => u.reactivate);
  const { data: batch, error: lockErr } = await sb.from("gw_office_excel_syncs").insert({
    tenant_id: ctx.tenantId, period_start: s.periodStart,
    original_filename: b?.fileName ? String(b.fileName).slice(0, 255) : null,
    file_hash: b?.fileHash ? String(b.fileHash).replace(/[^0-9a-f]/gi, "").slice(0, 128) || null : null,
    total_rows: s.plan.summary.total, new_count: ops.inserts.length, update_count: changedUpdates.length,
    unchanged_count: s.plan.summary.unchanged, stop_count: ops.stops.length, reactivate_count: reactivates.length,
    status: "applying", lock_key: "sync", created_by: user.id,
    created_by_name: ctx.employee?.display_name ? String(ctx.employee.display_name).slice(0, 100) : null,
  }).select("id").single();
  if (lockErr) {
    if (lockErr.code === "23505") return json(res, 409, { error: "busy", hint: "ほかの人が同期しています。終わってから、もう一度読み込んでください" });
    throw lockErr;
  }

  const now = new Date().toISOString();
  const startOn = (() => { const p = `${s.periodStart}-01`; return p > today ? p : today; })();
  let made = 0;
  try {
    // 1. 新規（まとめて入れる）
    const inserted = [];
    for (let i = 0; i < ops.inserts.length; i += 200) {
      const chunk = ops.inserts.slice(i, i + 200).map((x) => ({
        tenant_id: ctx.tenantId, ...x.value, due_rule: { type: "same" }, start_on: startOn, is_active: true, priority: "normal",
        source: "excel", source_key: x.key, assignee_employee_id: want[x.key] && okIds.has(String(want[x.key])) ? String(want[x.key]) : null,
        created_by: user.id, updated_by: user.id,
      }));
      inserted.push(...((await must(sb.from("gw_office_recurring_tasks").insert(chunk).select(MASTER_FIELDS))) || []));
    }
    // 2. 更新・再有効化（Excel が決める項目と source_key・有効だけ。担当・優先度・URL などは送らない＝そのまま）
    //    1件ずつの update（送る列だけが変わる）を10件ずつ並べて投げる
    const updated = [];
    for (let i = 0; i < ops.updates.length; i += 10) {
      const got = await Promise.all(ops.updates.slice(i, i + 10).map((u) => must(sb.from("gw_office_recurring_tasks")
        .update({ ...u.set, updated_by: user.id, updated_at: now })
        .eq("id", u.id).eq("tenant_id", ctx.tenantId).eq("source", "excel").select(MASTER_FIELDS).single())));
      updated.push(...got);
    }
    // 3. 停止（消さない）
    const stopIds = ops.stops.map((x) => x.id);
    for (let i = 0; i < stopIds.length; i += 200) {
      await must(sb.from("gw_office_recurring_tasks").update({ is_active: false, updated_by: user.id, updated_at: now })
        .eq("tenant_id", ctx.tenantId).eq("source", "excel").in("id", stopIds.slice(i, i + 200)).select("id"));
    }
    // 4. 予定：変わった・再開した・止めたマスターの、今日以降の未完了だけ消して作り直す（過去・完了・今回なしは残す）
    const touched = new Set([...changedUpdates, ...reactivates].map((u) => u.id));
    const redo = [...touched, ...stopIds];
    for (let i = 0; i < redo.length; i += 200) {
      await must(sb.from("gw_office_calendar_events").delete().eq("tenant_id", ctx.tenantId)
        .in("recurring_task_id", redo.slice(i, i + 200)).eq("status", "pending").gte("event_date", today).select("id"));
    }
    made = await generate(sb, [...inserted, ...updated.filter((m) => touched.has(m.id))], { from: today, to: addDays(today, HORIZON_DAYS) });
    await must(sb.from("gw_office_excel_syncs").update({ status: "committed", lock_key: null, committed_at: new Date().toISOString() })
      .eq("id", batch.id).select("id"));
  } catch (e) {
    await sb.from("gw_office_excel_syncs").update({ status: "failed", lock_key: null, error_detail: String(e?.code || e?.message || "error").slice(0, 200) })
      .eq("id", batch.id);
    throw e;
  }
  const result = { new: ops.inserts.length, update: changedUpdates.length, unchanged: s.plan.summary.unchanged, stop: ops.stops.length,
    reactivate: reactivates.length, skippedForbidden: s.plan.summary.forbidden, total: s.plan.summary.total };
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "office.recurring.sync", target: "office_recurring",
    detail: { periodStart: s.periodStart, ...result, events: made, batchId: batch.id } });
  return json(res, 200, { ...result, events: made, batchId: batch.id, periodStart: s.periodStart, periodLabel: periodLabel(s.periodStart),
    sync: await syncState(sb, ctx) });
}

async function loadMaster(sb, ctx, id) {
  if (!id) return null;
  return must(sb.from("gw_office_recurring_tasks").select(MASTER_FIELDS).eq("id", String(id)).eq("tenant_id", ctx.tenantId).maybeSingle());
}

async function checkAssignee(sb, ctx, id) {
  if (!id) return true;
  const e = await must(sb.from("gw_employees").select("id").eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle());
  return Boolean(e);
}

async function act(req, res, sb, ctx, user, perms) {
  const b = await readJson(req);
  const action = String(b?.action || "");
  const today = jstDate();
  const now = new Date().toISOString();
  const log = (what, detail) => gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `office.recurring.${what}`, target: "office_recurring", detail });

  if (action === "create" || action === "update") {
    const v = validateMaster(b);
    if (v.problems) return json(res, 400, { error: "invalid", hint: v.problems[0], problems: v.problems });
    if (!canEditCategory(perms, v.value.category)) return json(res, 403, { error: "forbidden", hint: `「${categoryLabel(v.value.category)}」の定例業務を直す権限がありません` });
    if (!(await checkAssignee(sb, ctx, v.value.assignee_employee_id))) return json(res, 400, { error: "invalid", hint: "担当者が名簿にいません" });
    let row;
    if (action === "create") {
      row = await must(sb.from("gw_office_recurring_tasks").insert({
        tenant_id: ctx.tenantId, ...v.value, start_on: v.value.start_on || today, is_active: true, source: "manual",
        created_by: user.id, updated_by: user.id,
      }).select(MASTER_FIELDS).single());
    } else {
      const cur = await loadMaster(sb, ctx, b.id);
      if (!cur) return json(res, 404, { error: "not_found" });
      if (!canEditCategory(perms, cur.category)) return json(res, 403, { error: "forbidden", hint: `「${categoryLabel(cur.category)}」の定例業務を直す権限がありません` });
      row = await must(sb.from("gw_office_recurring_tasks").update({ ...v.value, updated_by: user.id, updated_at: now })
        .eq("id", cur.id).eq("tenant_id", ctx.tenantId).select(MASTER_FIELDS).single());
    }
    const made = await syncMaster(sb, row, today);
    await log(action, { id: row.id, category: row.category, made });
    const people = new Map((await staff(sb, ctx)).map((p) => [p.id, p]));
    return json(res, 200, { master: shapeMaster(row, people, today, perms), made });
  }

  if (action === "set_active") {
    const cur = await loadMaster(sb, ctx, b?.id);
    if (!cur) return json(res, 404, { error: "not_found" });
    if (!canEditCategory(perms, cur.category)) return json(res, 403, { error: "forbidden" });
    const row = await must(sb.from("gw_office_recurring_tasks").update({ is_active: b.active === true, updated_by: user.id, updated_at: now })
      .eq("id", cur.id).eq("tenant_id", ctx.tenantId).select(MASTER_FIELDS).single());
    const made = await syncMaster(sb, row, today);
    await log(row.is_active ? "activate" : "deactivate", { id: row.id, made });
    const people = new Map((await staff(sb, ctx)).map((p) => [p.id, p]));
    return json(res, 200, { master: shapeMaster(row, people, today, perms), made });
  }

  if (action === "import_preview") {
    const cells = Array.isArray(b?.cells) ? b.cells.slice(0, MAX_CELLS) : [];
    if (!cells.length) return json(res, 400, { error: "invalid", hint: "Excel から読めた行がありません。年間予定表のファイルか確かめてください" });
    const periodStart = /^\d{4}-\d{2}$/.test(String(b?.periodStart || "")) ? b.periodStart : "2025-09";
    const out = classifyExcel(cells.map((c) => ({
      sheet: String(c.sheet || "").slice(0, 60), header: String(c.header || "").slice(0, 60), row: Number(c.row) || 0,
      day: Number(c.day), col: String(c.col || "").slice(0, 2), text: String(c.text || "").slice(0, 2000),
    })), { periodStart });
    // すでに取り込んだ行（同じキー）は「登録済み」
    const keys = out.rows.map((r) => r.key);
    const [doneM, doneE] = await Promise.all([
      keys.length ? must(sb.from("gw_office_recurring_tasks").select("source_key").eq("tenant_id", ctx.tenantId).in("source_key", keys)) : [],
      keys.length ? must(sb.from("gw_office_calendar_events").select("source_id").eq("tenant_id", ctx.tenantId).in("source_id", keys)) : [],
    ]);
    const had = new Set([...(doneM || []).map((r) => r.source_key), ...(doneE || []).map((r) => r.source_id)]);
    const rows = out.rows.map((r) => ({
      ...r, ruleText: describeRule(r.recurrenceType, r.recurrenceRule), registered: had.has(r.key),
      canEdit: canEditCategory(perms, r.category), include: r.include && !had.has(r.key) && canEditCategory(perms, r.category),
    }));
    return json(res, 200, { ...out, rows });
  }

  if (action === "import_commit") {
    const rows = Array.isArray(b?.rows) ? b.rows.filter((r) => r && r.include).slice(0, MAX_IMPORT) : [];
    if (!rows.length) return json(res, 400, { error: "invalid", hint: "登録する行がありません" });
    const problems = [];
    const masters = [], singles = [];
    for (const r of rows) {
      const key = String(r.key || "").slice(0, 200);
      if (!key.startsWith("xl:")) { problems.push("取り込みの行の形が正しくありません"); continue; }
      const v = validateMaster({ ...r, recurrenceType: r.kind === "single" ? "none" : r.recurrenceType, title: String(r.title || "").slice(0, TITLE_MAX) });
      if (v.problems) { problems.push(`「${String(r.title || "").slice(0, 30)}」：${v.problems[0]}`); continue; }
      if (!canEditCategory(perms, v.value.category)) { problems.push(`「${String(r.title || "").slice(0, 30)}」：${categoryLabel(v.value.category)}を登録する権限がありません`); continue; }
      if (!(await checkAssignee(sb, ctx, v.value.assignee_employee_id))) { problems.push(`「${String(r.title || "").slice(0, 30)}」：担当者が名簿にいません`); continue; }
      if (r.kind === "single") {
        const date = v.value.recurrence_rule.date;
        if (!isDate(date)) { problems.push(`「${String(r.title || "").slice(0, 30)}」：日付がありません`); continue; }
        singles.push({ tenant_id: ctx.tenantId, recurring_task_id: null, title: v.value.title, description: v.value.description,
          category: v.value.category, event_date: date, due_on: date, assignee_employee_id: v.value.assignee_employee_id,
          department: v.value.department, priority: v.value.priority, note: v.value.note, url: v.value.url,
          status: "pending", source: "excel", source_id: key, created_by: user.id });
      } else {
        masters.push({ tenant_id: ctx.tenantId, ...v.value, start_on: v.value.start_on || today, is_active: true,
          source: "excel", source_key: key, created_by: user.id, updated_by: user.id });
      }
    }
    if (problems.length) return json(res, 400, { error: "invalid", hint: problems[0], problems });
    let mastersMade = 0, singlesMade = 0, skipped = 0, eventsMade = 0;
    for (const m of masters) {
      const { data, error } = await sb.from("gw_office_recurring_tasks").insert(m).select(MASTER_FIELDS).single();
      if (error) { if (error.code === "23505") { skipped++; continue; } throw error; }
      mastersMade++;
      eventsMade += await syncMaster(sb, data, today);
    }
    for (const s of singles) {
      const { error } = await sb.from("gw_office_calendar_events").insert(s);
      if (error) { if (error.code === "23505") { skipped++; continue; } throw error; }
      singlesMade++;
    }
    await log("import", { masters: mastersMade, singles: singlesMade, skipped, events: eventsMade });
    return json(res, 200, { masters: mastersMade, singles: singlesMade, skipped, events: eventsMade });
  }

  if (action === "sync_preview") return syncPreview(res, sb, ctx, perms, b);
  if (action === "sync_commit") return syncCommit(res, sb, ctx, user, perms, b, today);

  return json(res, 400, { error: "invalid_action", detail: "create, update, set_active, import_preview, import_commit, sync_preview, sync_commit" });
}
