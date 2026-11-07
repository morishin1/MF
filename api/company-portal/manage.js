// 社内担当者だけが企業に商談アクセスを発行・提案を公開できる。
// パスワードは一度だけ返し、DBには保管しない（Supabase Auth がハッシュを保持する）。
import { randomBytes } from "node:crypto";
import { admin, userClient } from "../../lib/supabase.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === "string" && UUID.test(s);
const SQL = "db/163_company_meeting_portal.sql";
const canIssue = (ctx) => Boolean(ctx.tenantId && (ctx.isAdmin ||
  (ctx.roles || []).includes("owner") || (ctx.roles || []).includes("manager")));
const fail = (res, err) => {
  const hint = dbSetupHint(err, SQL);
  if (hint) return json(res, 503, { error: "not_ready", message: hint });
  console.error("[company-portal/manage]", err?.code || err?.message || err);
  return json(res, 503, { error: "unavailable", message: "設定を保存できませんでした" });
};
async function companyOf(sb, ctx, id) {
  if (!isUuid(id)) return null;
  const { data } = await sb.from("gw_sales_companies").select("id,name,ng_reason")
    .eq("tenant_id", ctx.tenantId).eq("id", id).maybeSingle();
  return data && !data.ng_reason ? data : null;
}

async function findExistingUser(sb, email) {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data?.users || [];
    const found = users.find((u) => (u.email || "").toLowerCase() === email);
    if (found) return found;
    if (users.length < 200) break;
  }
  return null;
}

async function get(req, res, sb, ctx) {
  const p = new URL(req.url, "http://localhost").searchParams;
  const companyId = p.get("companyId");
  if (!companyId) {
    const q = (p.get("q") || "").trim().replace(/[%_,()]/g, "").slice(0, 60);
    if (q.length < 2) return json(res, 200, { companies: [] });
    const { data, error } = await sb.from("gw_sales_companies").select("id,name")
      .eq("tenant_id", ctx.tenantId).ilike("name", "%" + q + "%").limit(15);
    if (error) return fail(res, error);
    return json(res, 200, { companies: data || [] });
  }
  const company = await companyOf(sb, ctx, companyId);
  if (!company) return json(res, 404, { error: "not_found" });
  const [proposals, shared, access] = await Promise.all([
    sb.from("gw_sales_proposals").select("id,title,job_title,service,status")
      .eq("tenant_id", ctx.tenantId).eq("company_id", company.id).order("created_at", { ascending: false }).limit(100),
    sb.from("gw_company_portal_shares").select("proposal_id,public_title,public_summary,document_url,active")
      .eq("tenant_id", ctx.tenantId).eq("company_id", company.id).limit(100),
    sb.from("gw_company_portal_access").select("id,user_id,active,created_at")
      .eq("tenant_id", ctx.tenantId).eq("company_id", company.id).limit(30),
  ]);
  if (proposals.error || shared.error || access.error) return fail(res, proposals.error || shared.error || access.error);
  const accounts = await Promise.all((access.data || []).map(async (row) => {
    const { data } = await sb.auth.admin.getUserById(row.user_id);
    return { id: row.id, email: data?.user?.email || "—", active: row.active };
  }));
  return json(res, 200, { company: { id: company.id, name: company.name },
    proposals: proposals.data || [], shares: shared.data || [], accounts });
}

async function post(req, res, sb, ctx, user) {
  const body = await readJson(req);
  const company = await companyOf(sb, ctx, body.companyId);
  if (!company) return json(res, 404, { error: "not_found" });

  if (body.action === "issue") {
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200)
      return json(res, 400, { error: "invalid_email" });
    let found;
    try { found = await findExistingUser(sb, email); } catch (e) { return fail(res, e); }
    let initialPassword = null;
    if (!found) {
      initialPassword = randomBytes(18).toString("base64url") + "9!Aa";
      const { data, error } = await sb.auth.admin.createUser({
        email, password: initialPassword, email_confirm: true,
      });
      if (error) return fail(res, error);
      found = data?.user;
    }
    if (!found) return json(res, 503, { error: "user_unavailable" });
    const { error } = await sb.from("gw_company_portal_access").upsert({
      tenant_id: ctx.tenantId, company_id: company.id, user_id: found.id,
      active: true, needs_password_change: Boolean(initialPassword), granted_by: user.id,
    }, { onConflict: "tenant_id,company_id,user_id" });
    if (error) return fail(res, error);
    return json(res, 200, {
      ok: true, email, alreadyExistingAccount: !initialPassword,
      temporaryPassword: initialPassword,
      loginUrl: "/company-portal/login.html",
    });
  }

  if (body.action === "disable") {
    if (!isUuid(body.accessId)) return json(res, 400, { error: "invalid_access" });
    const { error } = await sb.from("gw_company_portal_access").update({ active: false })
      .eq("id", body.accessId).eq("tenant_id", ctx.tenantId).eq("company_id", company.id);
    if (error) return fail(res, error);
    return json(res, 200, { ok: true });
  }

  if (body.action === "publish") {
    if (!Array.isArray(body.items) || body.items.length > 100) return json(res, 400, { error: "invalid_items" });
    const rows = [];
    const seen = new Set();
    for (const item of body.items) {
      if (!isUuid(item?.proposalId) || seen.has(item.proposalId)
        || typeof item.title !== "string" || item.title.trim().length < 1 || item.title.length > 160
        || typeof item.summary !== "string" || item.summary.length > 2000) {
        return json(res, 400, { error: "invalid_item" });
      }
      const url = String(item.documentUrl || "").trim();
      if (url && (url.length > 1500 || !/^https:\/\//i.test(url))) return json(res, 400, { error: "invalid_document_url" });
      seen.add(item.proposalId);
      rows.push({
        tenant_id: ctx.tenantId, company_id: company.id, proposal_id: item.proposalId,
        public_title: item.title.trim(), public_summary: item.summary.trim(),
        document_url: url || null, active: true, published_by: user.id, updated_at: new Date().toISOString(),
      });
    }
    if (seen.size) {
      const { data, error: pe } = await sb.from("gw_sales_proposals").select("id")
        .eq("tenant_id", ctx.tenantId).eq("company_id", company.id).in("id", [...seen]);
      if (pe) return fail(res, pe);
      if ((data || []).length !== seen.size) return json(res, 400, { error: "proposal_not_in_company" });
    }
    // 管理者が選ばなかった提案は非公開へ。APIも active=true のみ返す。
    const { error: de } = await sb.from("gw_company_portal_shares").update({ active: false })
      .eq("tenant_id", ctx.tenantId).eq("company_id", company.id);
    if (de) return fail(res, de);
    if (rows.length) {
      const { error: pe } = await sb.from("gw_company_portal_shares").upsert(rows, {
        onConflict: "tenant_id,company_id,proposal_id",
      });
      if (pe) return fail(res, pe);
    }
    return json(res, 200, { ok: true, publishedCount: rows.length });
  }
  return json(res, 400, { error: "invalid_action" });
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!canIssue(ctx)) return json(res, 403, { error: "forbidden" });
  const sb = admin();
  if (req.method === "GET") return get(req, res, sb, ctx);
  if (req.method === "POST") return post(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}
