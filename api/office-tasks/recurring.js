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
//        … 変換一覧で「登録」にした行だけ入れる（定例 → マスター／単発 → 予定）。同じ行は2回入れない
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
import { MASTER_FIELDS, syncMaster } from "../../lib/office-recurring-db.js";

const SQL = "db/125_office_recurring.sql";
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
    masters: (rows || []).map((t) => shapeMaster(t, byId, today, perms)),
    employees: people.filter((p) => p.status !== "left").map((p) => ({ id: p.id, name: p.display_name, department: p.department })),
    categories: CATEGORIES.map((c) => ({ key: c.key, label: c.label, col: c.col, view: cats.includes(c.key), edit: canEditCategory(perms, c.key) })),
    priorities: PRIORITIES,
    perms,
  });
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

  return json(res, 400, { error: "invalid_action", detail: "create, update, set_active, import_preview, import_commit" });
}
