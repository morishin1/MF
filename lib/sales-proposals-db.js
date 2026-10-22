// /sales 提案管理の DB 操作（api/sales/proposals/*.js から使う）。決まりごとは lib/sales-proposals.js。
//
// ■ 書き込みは呼んだ人の権限（userClient・RLS）で行う
//   担当本人または管理者が編集できる（db/143 の RLS）。社員名簿だけは、営業の人に読めないことがあるので
//   service_role（admin）で「名前・上長・在籍」だけを読む（api/sales/approaches/counts.js と同じ）。
//
// ■ 1回の記録で起きること（recordAndPlan）
//   1. 行動の記録を足す（追記だけ）
//   2. lib/sales-proposals.js planFollowUp で、提案の状態・片付くタスク・新しいタスクを決める
//   3. 提案を直す → タスクを完了（記録とひも付け）・取り消し → 新しいタスクを足す（同じ自動タスクは一意索引で弾かれる）
//   4. 企業に紐付いていれば、企業の営業履歴（gw_sales_events）にも電話・メール・返信・面談を写す
//   PostgREST は複数の表をまとめて1つのトランザクションにできない。途中で失敗しても、記録（事実）は先に残り、
//   次の記録で planFollowUp が「いま開いているタスク」から決め直すので、タスクの漏れは次の操作で埋まる。

import { admin } from "./supabase.js";
import {
  planFollowUp, settingsOf, companyEventOf, TASK_FIELDS, PROPOSAL_FIELDS,
} from "./sales-proposals.js";

// 提案管理の表（db/138）と、マッチング確定を起点にする列・状態（db/140）。どちらかが無いと「実行を依頼してください」を出す
export const SQL_FILE = "db/138_sales_proposals.sql・db/140_sales_proposal_matching.sql・db/141_sales_cs_closing_handoff.sql・db/142_sales_team_proposals_bulk.sql・db/143_sales_proposal_assignment_requests.sql";

const isDup = (e) => e && (e.code === "23505" || /duplicate key/i.test(String(e.message || "")));

/** 社員の名前・上長・在籍（テナントの全員）。@returns {{nameOf:Function, managerOf:Function, employees:object[]}} */
export async function loadPeople(tenantId) {
  let employees = [];
  try {
    const { data } = await admin().from("gw_employees").select("id, user_id, display_name, email, status, manager_id")
      .eq("tenant_id", tenantId).limit(2000);
    employees = data || [];
  } catch (e) {
    console.error("[sales-proposals] employees:", e?.message || e);
  }
  const m = new Map(employees.map((e) => [e.id, e]));
  return {
    employees,
    nameOf: (id) => (id ? m.get(id)?.display_name || null : null),
    managerOf: (id) => {
      const mgr = id ? m.get(id)?.manager_id : null;
      return mgr && m.get(mgr) && m.get(mgr).status !== "left" ? mgr : null;
    },
  };
}

/** 営業担当に選べる人（在籍中で、Sales を使える人＝経営者 または Sales のアプリ権限） */
export async function salesMembers(tenantId, employees) {
  try {
    const sb = admin();
    const [{ data: apps }, { data: owners }] = await Promise.all([
      sb.from("gw_app_grants").select("employee_id").eq("tenant_id", tenantId).eq("app_key", "sales"),
      sb.from("gw_role_grants").select("employee_id").eq("tenant_id", tenantId).eq("role", "owner"),
    ]);
    const ok = new Set([...(apps || []), ...(owners || [])].map((r) => r.employee_id));
    return employees.filter((e) => ok.has(e.id) && e.status !== "left")
      .map((e) => ({ id: e.id, name: e.display_name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  } catch (e) {
    console.error("[sales-proposals] members:", e?.message || e);
    return [];
  }
}

/** 設定の行（無ければ null。表が無い環境でも落とさない） */
export async function loadSettingsRow(sb, tenantId) {
  const { data, error } = await sb.from("gw_sales_proposal_settings").select("*").eq("tenant_id", tenantId).maybeSingle();
  if (error) return null;
  return data || null;
}

export async function loadProposal(sb, tenantId, id) {
  const { data, error } = await sb.from("gw_sales_proposals").select(PROPOSAL_FIELDS).eq("id", id).eq("tenant_id", tenantId).maybeSingle();
  return { proposal: data || null, error };
}

export async function loadTasks(sb, proposalId) {
  const { data, error } = await sb.from("gw_sales_proposal_tasks").select(TASK_FIELDS).eq("proposal_id", proposalId)
    .order("due_at", { ascending: true }).limit(500);
  return { tasks: data || [], error };
}

/** 新しいタスクを足す（同じ自動タスクはすでにあるので飛ばす） */
export async function insertTasks(sb, tenantId, proposalId, list, userId) {
  const made = [];
  for (const t of list) {
    const { data, error } = await sb.from("gw_sales_proposal_tasks")
      .insert({ tenant_id: tenantId, proposal_id: proposalId, created_by: userId || null, ...t }).select(TASK_FIELDS).single();
    if (error && isDup(error)) continue;
    if (error) throw error;
    made.push(data);
  }
  return made;
}

/** 企業の営業履歴に写す（提案の電話・メール・返信・面談）。失敗しても提案の記録は止めない */
export async function mirrorToCompany(sb, tenantId, proposal, activity, employeeId, userId) {
  const ev = companyEventOf(activity, proposal);
  if (!ev) return;
  try {
    await sb.from("gw_sales_events").insert({
      tenant_id: tenantId, company_id: proposal.company_id, ...ev, employee_id: employeeId || null, created_by: userId || null,
    });
    const { data: c } = await sb.from("gw_sales_companies").select("id, last_contact_at").eq("id", proposal.company_id).eq("tenant_id", tenantId).maybeSingle();
    if (c && (!c.last_contact_at || ev.occurred_at > c.last_contact_at)) {
      await sb.from("gw_sales_companies").update({ last_contact_at: ev.occurred_at, updated_at: new Date().toISOString() })
        .eq("id", c.id).eq("tenant_id", tenantId);
    }
  } catch (e) {
    console.error("[sales-proposals] mirror:", e?.message || e);
  }
}

/**
 * 記録を1つ足して、状態とタスクを進める。
 * @returns {Promise<{activity:object, plan:object, proposal:object, created:object[]}>}
 */
export async function recordAndPlan(sb, { ctx, user, proposal, input, settingsRow, managerOf = () => null, now = new Date().toISOString() }) {
  const { data: activity, error } = await sb.from("gw_sales_proposal_activities").insert({
    tenant_id: ctx.tenantId, proposal_id: proposal.id, company_id: proposal.company_id || null,
    employee_id: ctx.employee?.id || null, created_by: user.id, ...input,
  }).select("*").single();
  if (error) throw error;

  const { tasks, error: e1 } = await loadTasks(sb, proposal.id);
  if (e1) throw e1;
  const plan = planFollowUp({
    proposal, activity, tasks, now, settings: settingsOf(settingsRow), managerId: managerOf(proposal.sales_owner_id),
  });

  let after = proposal;
  if (Object.keys(plan.patch).length) {
    const { data, error: e2 } = await sb.from("gw_sales_proposals").update({ ...plan.patch, updated_by: user.id })
      .eq("id", proposal.id).eq("tenant_id", ctx.tenantId).select(PROPOSAL_FIELDS).single();
    if (e2) throw e2;
    after = data;
  }
  if (plan.complete.length) {
    const { error: e3 } = await sb.from("gw_sales_proposal_tasks")
      .update({ status: "done", done_at: now, done_by: user.id, done_activity_id: activity.id })
      .in("id", plan.complete).eq("proposal_id", proposal.id).eq("status", "open");
    if (e3) throw e3;
  }
  for (const c of plan.cancel) {
    const { error: e4 } = await sb.from("gw_sales_proposal_tasks").update({ status: "canceled", cancel_reason: c.reason })
      .eq("id", c.id).eq("proposal_id", proposal.id).eq("status", "open");
    if (e4) throw e4;
  }
  const created = await insertTasks(sb, ctx.tenantId, proposal.id, plan.create, user.id);
  await mirrorToCompany(sb, ctx.tenantId, after, activity, ctx.employee?.id, user.id);
  return { activity, plan, proposal: after, created };
}

/**
 * id の一覧を 50 件ずつに分けて読む。
 * .in() の長さを抑えるのと、1回の取得が PostgREST の上限（Supabase の既定 1,000 行）に当たって
 * 黙って切れないようにするため（提案50件 × 記録20件でも 1,000 行に収まる）。分けた分は同時に読む
 */
export async function inChunks(ids, fn, size = 50) {
  const parts = [];
  for (let i = 0; i < ids.length; i += size) parts.push(ids.slice(i, i + size));
  const results = await Promise.all(parts.map((p) => fn(p)));
  const out = [];
  for (const { data, error } of results) {
    if (error) return { data: null, error };
    out.push(...(data || []));
  }
  return { data: out, error: null };
}
