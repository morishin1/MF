// 退職手続きの1画面（入退社管理 ＞ 退社の詳細）。人事・管理者だけ（二段階認証・テナントは retire.js と同じ）。
//
// GET  /api/employees/retire-case?employeeId=…
//        … 基本情報・次にやること・本人対応・書類・アカウント・貸与品・案内文・履歴をまとめて返す
//          （書類の登録・公開・PDF は、これまでどおり /api/employees/retire）
// POST /api/employees/retire-case {action:"dates", employeeId, leftOn, lastWorkOn, ownerId, expect:{employee, case}, confirmImmediate?}
//        … 退職日（社員名簿の left_on）・最終出勤日・担当者。ほかの担当者の更新を上書きしない（更新日時を突き合わせる）
//          在籍状態・アカウントには触れない（止める・戻すは、メンバー管理の状態の変更と、退職日の翌日の自動処理）
// POST /api/employees/retire-case {action:"asset_request", employeeId, assetId, dueOn?}
//        … 返却を依頼した（返却予定日）。台帳の在庫の状態は変えない
// POST /api/employees/retire-case {action:"asset_return", employeeId, assetId}
//        … 返却を確認した。台帳（gw_assets）の貸出先を外して在庫に戻す（/api/assets の返却と同じ）。何を返したかは残す
// POST /api/employees/retire-case {action:"account", employeeId, service, state, scheduledOn?, note?}
//        … Google Workspace・Slack・GitHub・Vercel の状態を、担当者が記録する（外部サービスは止めない）
//
// ■ 記録
//   日付の変更・返却の依頼と確認・アカウントの記録は gw_retire_events（業務の記録。追記専用）。
//   書類の公開・再発行・管理者の閲覧・本人の閲覧は、これまでどおり gw_activity_log から読む（同じことを2か所に書かない）。
//   本文・URL・退職理由のメモは、どちらにも残さない。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { ymd } from "../../lib/jst.js";
import { KINDS, liveOf, adminState, reasonLabel } from "../../lib/retire.js";
import { viewDoc } from "../../lib/retire-store.js";
import { publicBaseUrl } from "../../lib/onboard-guide.js";
import {
  SERVICES, MANUAL_SERVICES, MANUAL_STATES, ACCOUNT_STATE_LABEL, isRealDate, checkDates, reissueHint,
  accountsView, assetsView, nextActions, selfView, guideText, historyView, lastStopOf,
} from "../../lib/retire-case.js";

const SQL = "db/123_retire_case.sql";
const STATUS_LABEL = { invited: "入社準備", active: "在籍", leaving: "退職手続き中", left: "退職" };
const DOC_FIELDS = "id, tenant_id, employee_id, kind, version, state, expected_on, note, issued_no, issued_on, issued_by, "
  + "file_name, file_size, include_reason, published, published_at, revoked_at, created_at, updated_at";
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const absent = (e) => Boolean(e) && (e.code === "PGRST205" || e.code === "42P01" || e.code === "42703" || e.code === "PGRST204"
  || /does not exist|could not find/i.test(String(e.message || "")));
/** 表・列が無ければ MISSING（その部分だけ「準備未完了」）。それ以外の失敗は投げる */
const MISSING = Symbol("missing");
const soft = async (q) => { const { data, error } = await q; if (error) { if (absent(error)) return MISSING; throw error; } return data; };
const val = (v, fallback) => (v === MISSING ? fallback : v);

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = admin();
  try {
    if (req.method === "GET") return await read(req, res, sb, ctx);
    if (req.method === "POST") return await act(req, res, sb, ctx, user);
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[employees/retire-case]", e?.message || e);
    return json(res, 500, { error: "retire_case_failed" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

const EMP_FIELDS = "id, tenant_id, user_id, display_name, department, employment_type, joined_on, left_on, status, updated_at";
const loadEmployee = (sb, ctx, id) => (id
  ? must(sb.from("gw_employees").select(EMP_FIELDS).eq("id", String(id)).eq("tenant_id", ctx.tenantId).maybeSingle())
  : null);

/** 会社のメンバーの氏名（担当者の選択肢・履歴の「誰が」） */
async function staffOf(sb, ctx) {
  const rows = await must(sb.from("gw_employees").select("id, user_id, display_name, status")
    .eq("tenant_id", ctx.tenantId).order("display_name").limit(1000));
  return rows || [];
}

/** 各システムのアカウント（読めなかったら {error:true}。無ければ undefined＝登録なし） */
async function readSystems(sb, ctx, userId) {
  if (!userId) return {};
  const one = async (q, map) => {
    try {
      const { data, error } = await q;
      if (error) return { error: true };
      return data ? map(data) : undefined;
    } catch { return { error: true }; }
  };
  const [lms, timecard, accounting] = await Promise.all([
    one(sb.from("profiles").select("id, approval_status, suspended_at").eq("id", userId).maybeSingle(),
      (r) => ({ active: r.approval_status !== "rejected" && !r.suspended_at, stoppedAt: r.suspended_at || null })),
    one(sb.from("tc_profiles").select("id, status").eq("id", userId).maybeSingle(),
      (r) => ({ active: r.status === "active" })),
    one(sb.from("memberships").select("user_id, role").eq("tenant_id", ctx.tenantId).eq("user_id", userId).limit(1).maybeSingle(),
      () => ({ active: true })),
  ]);
  return { lms, timecard, accounting };
}

async function read(req, res, sb, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const emp = await loadEmployee(sb, ctx, q.get("employeeId"));
  if (!emp) return json(res, 404, { error: "not_found" });
  const today = ymd();
  const target = `employee:${emp.id}`;

  const [caseRow, caseBase, docsRaw, assigned, returns, manualRows, events, logs, procs, staff, reads] = await Promise.all([
    soft(sb.from("gw_retire_cases").select("reason_code, last_work_on, owner_employee_id, updated_at")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).maybeSingle()),
    soft(sb.from("gw_retire_cases").select("reason_code, updated_at").eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).maybeSingle()),
    soft(sb.from("gw_retire_docs").select(DOC_FIELDS).eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).order("version", { ascending: false })),
    // 対象者の貸与品は、サーバーで絞る（全件を取ってから画面で絞ると、501 件目以降が欠ける）
    must(sb.from("gw_assets").select("id, kind, name, identifier, assigned_on, status")
      .eq("tenant_id", ctx.tenantId).eq("assigned_to", emp.id).order("kind").limit(200)),
    soft(sb.from("gw_retire_asset_returns").select("*").eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).limit(200)),
    soft(sb.from("gw_retire_accounts").select("*").eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id)),
    soft(sb.from("gw_retire_events").select("kind, detail, actor_id, actor_name, created_at")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).order("created_at", { ascending: false }).limit(200)),
    must(sb.from("gw_activity_log").select("ts, actor_id, action, detail")
      .eq("tenant_id", ctx.tenantId).eq("target", target).order("ts", { ascending: false }).limit(200)),
    soft(sb.from("gw_procedures").select("id").eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).eq("kind", "offboarding").limit(1)),
    staffOf(sb, ctx),
    readSystems(sb, ctx, emp.user_id),
  ]);

  // 121（書類）・123（基本情報の列・返却・アカウント・記録）が流してあるか。無い部分だけ「準備未完了」にする
  const ready = {
    docs: docsRaw !== MISSING,
    case: caseRow !== MISSING && returns !== MISSING && manualRows !== MISSING && events !== MISSING,
  };
  const c = val(caseRow, null) || val(caseBase, null) || null;
  const docs = val(docsRaw, []) || [];

  let selfTasks = [];
  const proc = val(procs, [])?.[0];
  if (proc?.id) {
    selfTasks = val(await soft(sb.from("gw_procedure_items").select("title, status, due_on, owner")
      .eq("procedure_id", proc.id).eq("owner", "employee").order("sort_order").limit(100)), []) || [];
  }

  const names = new Map(staff.filter((s) => s.user_id).map((s) => [s.user_id, s.display_name]));
  const byId = new Map(staff.map((s) => [s.id, s.display_name]));
  const accounts = accountsView({ employee: emp, today, reads, manualRows: val(manualRows, null), lastStop: lastStopOf(logs), names });
  const assets = assetsView(assigned, val(returns, []));
  const base = publicBaseUrl(req);
  const selfEvents = (logs || []).filter((l) => (l.action === "retire.view" || l.action === "retire.download") && emp.user_id && l.actor_id === emp.user_id);

  return json(res, 200, {
    ready,
    employee: {
      id: emp.id, name: emp.display_name, department: emp.department || null, employmentType: emp.employment_type || null,
      status: emp.status, statusLabel: STATUS_LABEL[emp.status] || emp.status,
      joinedOn: emp.joined_on || null, leftOn: emp.left_on || null, lastWorkOn: val(caseRow, null)?.last_work_on || null,
      owner: c?.owner_employee_id ? { id: c.owner_employee_id, name: byId.get(c.owner_employee_id) || "（不明）" } : null,
      reasonLabel: reasonLabel(c?.reason_code) || null,
      // 競合の検出に使う（保存のときにそのまま返してもらう）
      updatedAt: emp.updated_at, caseUpdatedAt: c?.updated_at || null,
    },
    staff: staff.filter((s) => s.status === "active" || s.status === "leaving").map((s) => ({ id: s.id, name: s.display_name })),
    next: nextActions({ employee: emp, docs, accounts, assets, today }),
    self: selfView(docs, selfEvents),
    selfTasks: selfTasks.map((t) => ({ title: t.title, status: t.status, dueOn: t.due_on || null })),
    docs: KINDS.map((k) => {
      const live = liveOf(docs, k.key);
      return { kind: k.key, label: k.label, adminState: adminState(live), current: live ? viewDoc(live) : null,
        history: docs.filter((d) => d.kind === k.key).map(viewDoc) };
    }),
    accounts,
    accountStates: MANUAL_STATES.map((k) => ({ key: k, label: ACCOUNT_STATE_LABEL[k] })),
    assets,
    guide: guideText({ employee: emp, docs, assets, selfTasks, baseUrl: base, today }),
    remind: guideText({ employee: emp, docs, assets, selfTasks, baseUrl: base, today, remind: true }),
    history: historyView(val(events, []), logs, { userId: emp.user_id }, names).slice(0, 200),
  });
}

async function record(sb, ctx, user, emp, kind, detail) {
  await must(sb.from("gw_retire_events").insert({
    tenant_id: ctx.tenantId, employee_id: emp.id, kind, detail,
    actor_id: user.id, actor_name: ctx.employee?.display_name || null,
  }).select("id").single());
}

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  const action = String(body?.action || "");
  const emp = await loadEmployee(sb, ctx, body?.employeeId);
  if (!emp) return json(res, 404, { error: "not_found" });
  const now = new Date().toISOString();
  const today = ymd();

  if (action === "dates") {
    const leftOn = body.leftOn ? String(body.leftOn) : null;
    const lastWorkOn = body.lastWorkOn ? String(body.lastWorkOn) : null;
    const ownerId = body.ownerId ? String(body.ownerId) : null;
    const stop = checkDates(emp, { leftOn, lastWorkOn, confirmImmediate: body.confirmImmediate === true }, today);
    if (stop) return json(res, stop.status, stop);
    const docs = val(await soft(sb.from("gw_retire_docs").select("id, kind, version, state")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id)), []) || [];
    const { data, error } = await sb.rpc("gw_retire_set_dates", {
      p_tenant: ctx.tenantId, p_employee: emp.id, p_actor: user.id, p_actor_name: ctx.employee?.display_name || null,
      p_left_on: leftOn, p_last_work_on: lastWorkOn, p_owner: ownerId,
      p_expect_emp: body.expect?.employee || null, p_expect_case: body.expect?.case || null,
    });
    if (error) {
      const m = String(error.message || "");
      if (/retire_conflict/.test(m)) return json(res, 409, { error: "conflict", hint: "ほかの担当者が先に更新しました。画面を読み直してから、もう一度保存してください（上書きはしていません）" });
      if (/retire_last_after_left/.test(m)) return json(res, 400, { error: "last_after_left", hint: "最終出勤日は、退職日と同じか、それより前にしてください" });
      if (/retire_bad_owner/.test(m)) return json(res, 400, { error: "bad_owner", hint: "担当者を選び直してください" });
      if (/retire_not_found/.test(m)) return json(res, 404, { error: "not_found" });
      if (error.code === "PGRST202" || /could not find the function/i.test(m)) {
        return json(res, 503, { error: "not_ready", message: `${SQL} をまだ流していません（退職日の保存に使います）` });
      }
      throw error;
    }
    const changedLeftOn = (emp.left_on || null) !== leftOn;
    return json(res, 200, { ok: true, ...(data || {}), reissue: reissueHint(docs, changedLeftOn) });
  }

  if (action === "asset_request" || action === "asset_return") {
    const assetId = String(body.assetId || "");
    const asset = await must(sb.from("gw_assets").select("id, kind, name, identifier, assigned_to, status")
      .eq("id", assetId).eq("tenant_id", ctx.tenantId).maybeSingle());
    if (!asset) return json(res, 404, { error: "asset_not_found" });
    const prev = await must(sb.from("gw_retire_asset_returns").select("id, state, due_on, requested_at")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).eq("asset_id", asset.id).maybeSingle());
    if (prev?.state === "returned") return json(res, 409, { error: "already_returned", hint: "この貸与品は、返却を確認済みです" });
    if (asset.assigned_to !== emp.id) return json(res, 409, { error: "not_assigned", hint: "この貸与品は、いまこの人に貸し出されていません（台帳を確認してください）" });
    const snap = { asset_kind: asset.kind, asset_name: asset.name, asset_identifier: asset.identifier || null };

    if (action === "asset_request") {
      const dueOn = body.dueOn ? String(body.dueOn) : null;
      if (dueOn && !isRealDate(dueOn)) return json(res, 400, { error: "invalid_date", hint: "返却予定日を、実在する日付で入れてください" });
      const row = { tenant_id: ctx.tenantId, employee_id: emp.id, asset_id: asset.id, ...snap, state: "requested",
        requested_at: prev?.requested_at || now, due_on: dueOn, updated_at: now };
      if (prev) await must(sb.from("gw_retire_asset_returns").update(row).eq("id", prev.id).select("id").single());
      else await must(sb.from("gw_retire_asset_returns").insert(row).select("id").single());
      await record(sb, ctx, user, emp, "asset.request", { assetId: asset.id, name: asset.name, dueOn });
      return json(res, 200, { ok: true });
    }

    // 返却の確認：台帳の貸出先を外して在庫へ（/api/assets の返却と同じ値）。ほかの人に付け替わっていたら何もしない
    const moved = await must(sb.from("gw_assets")
      .update({ assigned_to: null, status: "in_stock", returned_on: today, updated_at: now })
      .eq("id", asset.id).eq("tenant_id", ctx.tenantId).eq("assigned_to", emp.id).select("id").maybeSingle());
    if (!moved) return json(res, 409, { error: "not_assigned", hint: "台帳が先に更新されました。画面を読み直してください" });
    const row = { tenant_id: ctx.tenantId, employee_id: emp.id, asset_id: asset.id, ...snap, state: "returned",
      requested_at: prev?.requested_at || null, due_on: prev?.due_on || null, returned_at: now, returned_by: user.id, updated_at: now };
    if (prev) await must(sb.from("gw_retire_asset_returns").update(row).eq("id", prev.id).select("id").single());
    else await must(sb.from("gw_retire_asset_returns").insert(row).select("id").single());
    await record(sb, ctx, user, emp, "asset.return", { assetId: asset.id, name: asset.name });
    return json(res, 200, { ok: true });
  }

  if (action === "account") {
    const service = String(body.service || "");
    if (!MANUAL_SERVICES.includes(service)) {
      return json(res, 400, { error: "invalid_service", hint: "このサービスは、各システムの状態から自動で表示します（ここでは記録できません）" });
    }
    const state = String(body.state || "");
    if (!MANUAL_STATES.includes(state)) return json(res, 400, { error: "invalid_state" });
    const scheduledOn = body.scheduledOn ? String(body.scheduledOn) : null;
    if (scheduledOn && !isRealDate(scheduledOn)) return json(res, 400, { error: "invalid_date", hint: "停止予定日を、実在する日付で入れてください" });
    if (state === "scheduled" && !scheduledOn) return json(res, 400, { error: "date_required", hint: "停止予定日を入れてください" });
    const note = body.note ? String(body.note).slice(0, 200) : null;
    const prev = await must(sb.from("gw_retire_accounts").select("id, state, stopped_at, stopped_by")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).eq("service", service).maybeSingle());
    const row = {
      tenant_id: ctx.tenantId, employee_id: emp.id, service, state,
      scheduled_on: state === "scheduled" ? scheduledOn : null,
      stopped_at: state === "stopped" ? (prev?.state === "stopped" ? prev.stopped_at : now) : null,
      stopped_by: state === "stopped" ? (prev?.state === "stopped" ? prev.stopped_by : user.id) : null,
      note, updated_by: user.id, updated_at: now,
    };
    if (prev) await must(sb.from("gw_retire_accounts").update(row).eq("id", prev.id).select("id").single());
    else await must(sb.from("gw_retire_accounts").insert(row).select("id").single());
    const label = SERVICES.find((s) => s.key === service)?.label || service;
    await record(sb, ctx, user, emp, "account.update", { service, label, from: prev?.state || null, to: state, scheduledOn: row.scheduled_on });
    return json(res, 200, { ok: true });
  }

  return json(res, 400, { error: "invalid_action", detail: "dates, asset_request, asset_return, account" });
}
