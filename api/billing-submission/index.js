// GET    /api/billing-submission?month=YYYY-MM
//          … 月初進捗一覧（今月の現場契約ごとに1行。窓口の状態・届いたファイルつき）
// POST   /api/billing-submission { employeeId }
//          … 提出の窓口を発行・再発行する（毎月使い回すので、再発行すると古いURLは無効）
// DELETE /api/billing-submission?employeeId=…
//          … 窓口を無効化する
//
// 請求書そのもの・PDF解析（日別合計・稼働時間・精算幅チェック）はD2。
// ここ（D1）は提出・回収・進捗一覧だけ。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  isBillingMonth, sha256, newSubmissionToken, LINK_TTL_DAYS, linkStatus,
} from "../../lib/billing-submission.js";

const SQL = "db/080_billing_submission.sql";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST") return issue(req, res, sb, ctx, user);
  if (req.method === "DELETE") return revoke(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "DELETE"]);
}

async function list(req, res, sb, ctx) {
  const month = new URL(req.url, "http://localhost").searchParams.get("month");
  if (!isBillingMonth(month)) return json(res, 400, { error: "invalid_query", detail: "month は YYYY-MM で指定してください" });

  // 今月動いている現場契約。cron（api/cron/task-events.js）が毎月1〜5日に
  // gw_billing_progress の行を用意しているのと同じ絞り方
  const monthStart = `${month}-01`;
  const [contractsRes, progressRes, linksRes, submissionsRes] = await Promise.all([
    sb.from("gw_site_contracts")
      .select("id, employee_id, engagement_kind, site_company, prime_company, period_from, period_to")
      .eq("tenant_id", ctx.tenantId).lte("period_from", `${month}-31`).limit(2000),
    sb.from("gw_billing_progress").select("*")
      .eq("tenant_id", ctx.tenantId).eq("billing_month", month).limit(2000),
    sb.from("gw_submission_links").select("*").eq("tenant_id", ctx.tenantId).limit(2000),
    sb.from("gw_submissions").select("id, employee_id, site_contract_id, kind, file_name, submitted_at")
      .eq("tenant_id", ctx.tenantId).eq("target_month", month).limit(2000),
  ]);
  if (contractsRes.error) {
    const hint = dbSetupHint(contractsRes.error, "db/076_site_contracts.sql");
    if (hint) return json(res, 200, { rows: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: contractsRes.error.message });
  }
  if (linksRes.error || submissionsRes.error) {
    const hint = dbSetupHint(linksRes.error || submissionsRes.error, SQL);
    if (hint) return json(res, 200, { rows: [], notReady: true, message: hint });
  }

  const active = (contractsRes.data || []).filter((c) => !c.period_to || c.period_to >= monthStart);
  if (!active.length) return json(res, 200, { rows: [], month });

  const empIds = [...new Set(active.map((c) => c.employee_id))];
  const { data: emps } = await sb.from("gw_employees")
    .select("id, display_name, department, status").in("id", empIds).limit(2000);
  const empById = new Map((emps || []).map((e) => [e.id, e]));

  const progressByKey = new Map((progressRes.data || [])
    .map((p) => [`${p.employee_id}:${p.site_contract_id}`, p]));
  const linkByEmployee = new Map((linksRes.data || []).map((l) => [l.employee_id, l]));

  const subs = submissionsRes.data || [];
  const subsByKey = new Map();
  for (const s of subs) {
    const k = `${s.employee_id}:${s.site_contract_id}`;
    if (!subsByKey.has(k)) subsByKey.set(k, []);
    subsByKey.get(k).push(s);
  }

  const rows = active
    .filter((c) => empById.has(c.employee_id))
    .map((c) => {
      const key = `${c.employee_id}:${c.id}`;
      const p = progressByKey.get(key) || null;
      const emp = empById.get(c.employee_id);
      const link = linkByEmployee.get(c.employee_id) || null;
      return {
        employeeId: c.employee_id, employeeName: emp.display_name, department: emp.department,
        siteContractId: c.id, engagementKind: c.engagement_kind,
        siteCompany: c.site_company, primeCompany: c.prime_company,
        timesheetReceived: !!p?.timesheet_received, invoiceReceived: !!p?.bp_invoice_received,
        billingProgressId: p?.id || null,
        linkStatus: linkStatus(link),
        submissions: (subsByKey.get(key) || [])
          .map((s) => ({ id: s.id, kind: s.kind, fileName: s.file_name, submittedAt: s.submitted_at })),
      };
    })
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName, "ja"));

  return json(res, 200, { rows, month });
}

async function issue(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!body?.employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });

  const { data: emp } = await sb.from("gw_employees").select("id, display_name")
    .eq("id", body.employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found" });

  const { data: contract } = await sb.from("gw_site_contracts").select("id")
    .eq("employee_id", body.employeeId).eq("tenant_id", ctx.tenantId).limit(1).maybeSingle();
  if (!contract) {
    return json(res, 400, { error: "no_site_contract", hint: "先にSES現場契約を登録してください" });
  }

  const sbAdmin = admin();
  const token = newSubmissionToken();
  const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 86400000).toISOString();

  // 1人1本（db/080の一意制約）。あれば置き換える＝古いURLはその時点で無効になる
  const { data, error } = await sbAdmin.from("gw_submission_links")
    .upsert({
      tenant_id: ctx.tenantId, employee_id: body.employeeId,
      token_hash: sha256(token), expires_at: expiresAt, revoked_at: null, created_by: user.id,
    }, { onConflict: "employee_id" })
    .select("id, expires_at").single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_upsert_failed", detail: error.message });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "billing_submission.link_issue",
    target: `submission_link:${data.id}`, detail: { employee: emp.display_name },
  });
  return json(res, 200, { token, expiresAt: data.expires_at });
}

async function revoke(req, res, sb, ctx, user) {
  const employeeId = new URL(req.url, "http://localhost").searchParams.get("employeeId");
  if (!employeeId) return json(res, 400, { error: "invalid_query", required: ["employeeId"] });

  const sbAdmin = admin();
  const { data, error } = await sbAdmin.from("gw_submission_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId).is("revoked_at", null)
    .select("id").maybeSingle();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  if (!data) return json(res, 404, { error: "not_found" });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "billing_submission.link_revoke",
    target: `submission_link:${data.id}`, detail: { employeeId },
  });
  return json(res, 200, { ok: true });
}
