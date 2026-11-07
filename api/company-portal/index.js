// 企業向け商談ポータル。Supabase Auth JWT + 明示的な会社アクセス権で認可する。
// 一覧で返すのは公開許可済みの文言のみ。Salesの社内メモ/原価/連絡先は絶対に返さない。
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { admin } from "../../lib/supabase.js";

const SQL = "db/163_company_meeting_portal.sql";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = { interested: "興味あり", details: "詳しく聞きたい", meeting: "面談希望" };
const EARLY = ["call_wait", "mail_wait", "reply_wait", "considering", "reproposal"];
const isUuid = (value) => typeof value === "string" && UUID.test(value);
const fail = (res, error) => {
  const hint = dbSetupHint(error, SQL);
  if (hint) return json(res, 503, { error: "not_ready", message: hint });
  console.error("[company-portal]", error?.code || error?.message || "database error");
  return json(res, 503, { error: "unavailable", message: "商談情報を取得できませんでした" });
};

async function accessFor(sb, userId, companyId) {
  const { data, error } = await sb.from("gw_company_portal_access")
    .select("tenant_id,company_id,needs_password_change").eq("user_id", userId)
    .eq("active", true).order("created_at", { ascending: true }).limit(1000);
  if (error) return { error };
  if (companyId && !isUuid(companyId)) return { invalid: true };
  const rows = data || [];
  const access = companyId ? rows.find((r) => r.company_id === companyId) : rows[0];
  return { access: access || null };
}

async function getCompany(sb, access) {
  const { data, error } = await sb.from("gw_sales_companies")
    .select("id,name,ng_reason").eq("tenant_id", access.tenant_id)
    .eq("id", access.company_id).maybeSingle();
  return { company: data || null, error };
}

async function list(req, res, sb, user) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const { access, error, invalid } = await accessFor(sb, user.id, params.get("companyId"));
  if (error) return fail(res, error);
  if (invalid) return json(res, 400, { error: "invalid_company" });
  if (!access) return json(res, 403, { error: "access_denied", message: "商談ページの利用権限がありません。エイト担当者へご連絡ください。" });
  const { company, error: ce } = await getCompany(sb, access);
  if (ce) return fail(res, ce);
  if (!company || company.ng_reason) return json(res, 403, { error: "company_unavailable" });

  // パスワード初期設定が済むまで商談データは渡さない。
  if (access.needs_password_change) {
    return json(res, 200, { company: { id: company.id, name: company.name },
      needsPasswordChange: true, proposals: [], meeting: null, responses: [] });
  }

  const [shared, meetings, response] = await Promise.all([
    sb.from("gw_company_portal_shares").select("proposal_id,public_title,public_summary,document_url,updated_at")
      .eq("tenant_id", access.tenant_id).eq("company_id", company.id).eq("active", true)
      .order("updated_at", { ascending: false }).limit(100),
    sb.from("gw_sales_meetings").select("scheduled_at,meeting_url")
      .eq("tenant_id", access.tenant_id).eq("company_id", company.id)
      .eq("status", "scheduled").order("scheduled_at", { ascending: true }).limit(5),
    sb.from("gw_company_portal_responses").select("proposal_id,action,created_at")
      .eq("tenant_id", access.tenant_id).eq("company_id", company.id)
      .eq("user_id", user.id).order("created_at", { ascending: false }).limit(100),
  ]);
  if (shared.error) return fail(res, shared.error);
  if (meetings.error) return fail(res, meetings.error);
  if (response.error) return fail(res, response.error);
  const shares = shared.data || [];
  const ids = shares.map((s) => s.proposal_id);
  let allowedIds = new Set();
  if (ids.length) {
    const { data: items, error: pe } = await sb.from("gw_sales_proposals").select("id")
      .eq("tenant_id", access.tenant_id).eq("company_id", company.id).in("id", ids);
    if (pe) return fail(res, pe);
    allowedIds = new Set((items || []).map((p) => p.id));
  }
  const last = new Map();
  for (const r of (response.data || [])) {
    if (!last.has(r.proposal_id)) last.set(r.proposal_id, { action: r.action, at: r.created_at });
  }
  return json(res, 200, {
    company: { id: company.id, name: company.name },
    needsPasswordChange: false,
    proposals: shares.filter((s) => allowedIds.has(s.proposal_id)).map((s) => ({
      id: s.proposal_id,
      title: s.public_title,
      summary: s.public_summary,
      documentUrl: s.document_url,
      lastResponse: last.get(s.proposal_id) || null,
    })),
    meeting: (meetings.data || []).find((m) => m.scheduled_at && new Date(m.scheduled_at).getTime() > Date.now() - 3600000) || null,
  });
}

async function password(req, res, sb, user, body) {
  if (typeof body.password !== "string" || body.password.length < 12 || body.password.length > 100) {
    return json(res, 400, { error: "weak_password", message: "新しいパスワードは12文字以上にしてください" });
  }
  const { access, error } = await accessFor(sb, user.id, body.companyId);
  if (error) return fail(res, error);
  if (!access) return json(res, 403, { error: "access_denied" });
  const result = await sb.auth.admin.updateUserById(user.id, { password: body.password });
  if (result.error) return json(res, 400, { error: "password_update_failed", message: "パスワードを変更できませんでした" });
  const { error: ae } = await sb.from("gw_company_portal_access").update({ needs_password_change: false })
    .eq("tenant_id", access.tenant_id).eq("company_id", access.company_id).eq("user_id", user.id);
  if (ae) return fail(res, ae);
  return json(res, 200, { ok: true });
}

async function feedback(res, sb, user, body) {
  if (!isUuid(body.companyId) || !isUuid(body.proposalId)
    || !Object.hasOwn(ACTIONS, body.responseAction)
    || typeof body.message !== "string" || body.message.length > 800) {
    return json(res, 400, { error: "invalid_input", message: "内容をご確認ください" });
  }
  const { access, error } = await accessFor(sb, user.id, body.companyId);
  if (error) return fail(res, error);
  if (!access || access.needs_password_change) return json(res, 403, { error: "access_denied" });
  const { company, error: ce } = await getCompany(sb, access);
  if (ce) return fail(res, ce);
  if (!company || company.ng_reason) return json(res, 403, { error: "company_unavailable" });

  // 会社IDだけでなく「この会社へ公開された、この会社の提案」を再チェック。
  const [{ data: share, error: se }, { data: proposal, error: pe }] = await Promise.all([
    sb.from("gw_company_portal_shares").select("id")
      .eq("tenant_id", access.tenant_id).eq("company_id", company.id)
      .eq("proposal_id", body.proposalId).eq("active", true).maybeSingle(),
    sb.from("gw_sales_proposals").select("id,status,sales_owner_id")
      .eq("tenant_id", access.tenant_id).eq("company_id", company.id)
      .eq("id", body.proposalId).maybeSingle(),
  ]);
  if (se || pe) return fail(res, se || pe);
  if (!share || !proposal) return json(res, 404, { error: "not_found" });

  // 二重クリック・再送で同じ回答を二度 Sales に入れない。
  const clientId = isUuid(body.requestId) ? body.requestId : null;
  const now = new Date().toISOString();
  const insert = await sb.from("gw_company_portal_responses").insert({
    tenant_id: access.tenant_id, company_id: company.id, proposal_id: proposal.id,
    user_id: user.id, action: body.responseAction, message: body.message.trim(),
    client_request_id: clientId,
  }).select("id,created_at").single();
  if (insert.error?.code === "23505") return json(res, 200, { ok: true, duplicate: true });
  if (insert.error) return fail(res, insert.error);

  // 企業回答は既存の Sales 提案履歴に追記する。失敗しても回答の原本は残し、未連携として管理画面で確認できる。
  const note = "[企業商談ページ] " + ACTIONS[body.responseAction]
    + (body.message.trim() ? "\n" + body.message.trim() : "");
  const activity = await sb.from("gw_sales_proposal_activities").insert({
    tenant_id: access.tenant_id, company_id: company.id, proposal_id: proposal.id,
    kind: "reply", outcome: body.responseAction === "meeting" ? "meeting" : "considering",
    channel: "other", evidence: "system", created_by: user.id, occurred_at: now,
    note: note.slice(0, 2000), source_event: "company_portal:" + insert.data.id,
  });
  if (activity.error) {
    console.error("[company-portal] activity_sync", activity.error.code || activity.error.message);
    return json(res, 202, { ok: true, salesSynced: false });
  }
  // 状態変更と担当タスクが完了してから連携済みにする。失敗時は回答の原本を維持し未連携として残す。
  if (EARLY.includes(proposal.status)) {
    const { error: stateError } = await sb.from("gw_sales_proposals").update({
      status: body.responseAction === "meeting" ? "meeting_adjust" : "considering", updated_at: now,
    }).eq("id", proposal.id).eq("tenant_id", access.tenant_id).in("status", EARLY);
    if (stateError) {
      console.error("[company-portal] status_sync", stateError.code || stateError.message);
      return json(res, 202, { ok: true, salesSynced: false });
    }
  }
  if (!["won", "lost", "stopped", "closed_no_reply"].includes(proposal.status)) {
    const taskTitles = {
      interested: "企業ポータル：興味ありの回答を確認する",
      details: "企業ポータル：詳細希望に回答する",
      meeting: "企業ポータル：面談希望の日時を調整する",
    };
    const { error: taskError } = await sb.from("gw_sales_proposal_tasks").insert({
      tenant_id: access.tenant_id,
      proposal_id: proposal.id,
      kind: "manual",
      title: taskTitles[body.responseAction],
      assignee_id: proposal.sales_owner_id || null,
      due_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      created_by: user.id,
      source_event: "company_portal:" + insert.data.id,
    });
    if (taskError) {
      console.error("[company-portal] task_sync", taskError.code || taskError.message);
      return json(res, 202, { ok: true, salesSynced: false });
    }
  }
  const { error: stampError } = await sb.from("gw_company_portal_responses")
    .update({ sales_synced_at: now }).eq("id", insert.data.id).eq("tenant_id", access.tenant_id);
  if (stampError) {
    console.error("[company-portal] stamp_sync", stampError.code || stampError.message);
    return json(res, 202, { ok: true, salesSynced: false });
  }
  return json(res, 200, { ok: true, salesSynced: true });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const user = await requireUser(req, res);
  if (!user) return;
  const sb = admin();
  if (req.method === "GET") return list(req, res, sb, user);
  if (req.method === "POST") {
    const body = await readJson(req);
    if (body.action === "change_password") return password(req, res, sb, user, body);
    if (body.action === "feedback") return feedback(res, sb, user, body);
    return json(res, 400, { error: "invalid_action" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}
