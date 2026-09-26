// GET   /api/sales/approaches[?days=90]
//         … 送信済みのアタック一覧（アタック画面の履歴・分析・テンプレート比較の元）
// POST  /api/sales/approaches { companyId, templateId?, campaignId?, destinationUrl?, force? }
//         … フォームアタックを始める。専用URL（/r/<token>）を発行して返す。
//           営業文に専用URLを入れてから送るので、送る前に発行しておく必要がある
// PATCH /api/sales/approaches { id, action: "sent", body, subject?, service?, templateId?, campaignId?, force? }
//         … 「送信完了」。ここではじめて履歴として残る（sent_at が立つ）
// PATCH /api/sales/approaches { id, action: "discard" }
//         … 送らなかった。発行した専用URLを捨てる（送信済みは消せない）
//
// ■ 送ってはいけない会社を、サーバで止める（画面の警告だけに頼らない）
//   ・営業禁止（NG）の会社 … 誰であっても 403
//   ・直近30日以内に送信済み … 409。管理者・経営者だけ force で押し切れる（要件 §20）

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell, canForceAttack } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import {
  COMPANY_FIELDS, shapeApproach, newTrackingToken, recentApproach, statusRank, safeUrl, isUuid,
  NG_LABEL, RECENT_DAYS, autoNext,
} from "../../../lib/sales.js";

const SQL = "db/088_sales.sql";
const FIELDS = "id, tenant_id, company_id, campaign_id, template_id, employee_id, service, subject, body, form_url, "
  + "tracking_token, destination_url, prepared_at, sent_at, forced, first_click_at, last_click_at, click_count";
// 同じ人が同じ会社で開き直したときは、発行済みの専用URLを使い回す（捨てURLを増やさない）
const REUSE_HOURS = 24;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = userClient(req);

  if (req.method === "GET") return list(req, res, sb, ctx);
  if (req.method === "POST") return prepare(req, res, sb, ctx, user);
  if (req.method === "PATCH") return act(req, res, sb, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

/** 専用URL。PUBLIC_BASE_URL があればそのドメインで、無ければいま開いているホストで作る */
function trackingUrl(req, token) {
  const explicit = (process.env.SALES_TRACKING_BASE_URL || process.env.PUBLIC_BASE_URL || "").trim();
  if (explicit) return `${explicit.replace(/\/+$/, "")}/r/${token}`;
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host || "gw.8grp.co.jp";
  const proto = req.headers?.["x-forwarded-proto"] || "https";
  return `${proto}://${host}/r/${token}`;
}

async function list(req, res, sb, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const days = Math.min(Math.max(Number(q.get("days")) || 365, 1), 3650);
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data, error } = await sb.from("gw_sales_approaches").select(FIELDS)
    .eq("tenant_id", ctx.tenantId).gte("sent_at", since).order("sent_at", { ascending: false }).limit(10000);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { approaches: [], notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  const companyIds = [...new Set((data || []).map((a) => a.company_id))];
  const [{ data: companies }, { data: members }, { data: templates }] = await Promise.all([
    companyIds.length
      ? sb.from("gw_sales_companies").select("id, name, industry, status").in("id", companyIds)
      : Promise.resolve({ data: [] }),
    sb.from("gw_employees").select("id, display_name").eq("tenant_id", ctx.tenantId).limit(500),
    sb.from("gw_sales_templates").select("id, name").eq("tenant_id", ctx.tenantId).limit(500),
  ]);
  const company = new Map((companies || []).map((c) => [c.id, c]));
  const name = new Map((members || []).map((e) => [e.id, e.display_name]));
  const tname = new Map((templates || []).map((t) => [t.id, t.name]));

  return json(res, 200, {
    approaches: (data || []).map((a) => {
      const c = company.get(a.company_id);
      return {
        ...shapeApproach(a), body: undefined,
        companyName: c?.name || null, industry: c?.industry || null, companyStatus: c?.status || null,
        employeeName: name.get(a.employee_id) || null, templateName: tname.get(a.template_id) || null,
      };
    }),
  });
}

async function templateDestination(sb, ctx, templateId) {
  const { data: t } = await sb.from("gw_sales_templates").select("destination_url")
    .eq("id", templateId).eq("tenant_id", ctx.tenantId).maybeSingle();
  return safeUrl(t?.destination_url) || undefined;
}

/** NG・直近アタックを確かめる。止めるなら { status, body } を返す */
async function guard(sb, ctx, company, { force, exceptId } = {}) {
  if (company.ng_reason) {
    return { status: 403, body: {
      error: "ng_company", hint: `この企業は営業禁止です（${NG_LABEL[company.ng_reason] || company.ng_reason}）`,
    } };
  }
  const { data: past } = await sb.from("gw_sales_approaches").select("id, employee_id, service, sent_at")
    .eq("company_id", company.id).gte("sent_at", new Date(Date.now() - RECENT_DAYS * 86400000).toISOString())
    .limit(50);
  const recent = recentApproach((past || []).filter((a) => a.id !== exceptId));
  if (!recent) return null;
  if (force && canForceAttack(ctx)) return null;

  let employeeName = null;
  if (recent.employee_id) {
    const { data: e } = await sb.from("gw_employees").select("display_name").eq("id", recent.employee_id).maybeSingle();
    employeeName = e?.display_name || null;
  }
  const payload = { sentAt: recent.sent_at, employeeName, service: recent.service || null, days: RECENT_DAYS };
  if (force) {
    return { status: 403, body: { error: "force_forbidden", recent: payload,
      hint: "直近のアタックを押し切れるのは管理者・経営者だけです" } };
  }
  return { status: 409, body: { error: "recent_attack", recent: payload, canForce: canForceAttack(ctx),
    hint: `直近${RECENT_DAYS}日以内にアタックされています` } };
}

async function prepare(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.companyId)) return json(res, 400, { error: "invalid_body", required: ["companyId"] });

  const { data: c, error } = await sb.from("gw_sales_companies").select(COMPANY_FIELDS)
    .eq("id", body.companyId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  if (!c) return json(res, 404, { error: "not_found" });

  const stop = await guard(sb, ctx, c, { force: Boolean(body.force) });
  if (stop) return json(res, stop.status, stop.body);

  let dest = safeUrl(body.destinationUrl);
  if (dest === false) return json(res, 400, { error: "bad_url", hint: "リンク先のURLが正しくありません" });
  // リンク先はテンプレートが正。画面から渡されなければテンプレートから引く
  if (dest === undefined && isUuid(body.templateId)) dest = await templateDestination(sb, ctx, body.templateId);

  // 同じ人が同じ会社で、まだ送っていない専用URLがあれば使い回す
  const me = ctx.employee?.id || null;
  const { data: open } = me
    ? await sb.from("gw_sales_approaches").select(FIELDS)
      .eq("company_id", c.id).eq("employee_id", me).is("sent_at", null)
      .gte("prepared_at", new Date(Date.now() - REUSE_HOURS * 3600000).toISOString())
      .order("prepared_at", { ascending: false }).limit(1)
    : { data: [] };
  let row = (open || [])[0] || null;

  if (row) {
    const patch = {};
    if (dest !== undefined && dest !== row.destination_url) patch.destination_url = dest;
    if (body.templateId !== undefined && isUuid(body.templateId)) patch.template_id = body.templateId;
    if (Object.keys(patch).length) {
      const { data } = await sb.from("gw_sales_approaches").update(patch).eq("id", row.id).select(FIELDS).single();
      if (data) row = data;
    }
  } else {
    // トークンの衝突は事実上起きないが、起きたら引き直す（一意制約で止まる）
    for (let i = 0; i < 3 && !row; i++) {
      const { data, error: e2 } = await sb.from("gw_sales_approaches").insert({
        tenant_id: ctx.tenantId, company_id: c.id, employee_id: me,
        campaign_id: isUuid(body.campaignId) ? body.campaignId : c.campaign_id || null,
        template_id: isUuid(body.templateId) ? body.templateId : null,
        form_url: c.form_url || null, service: c.service || null,
        tracking_token: newTrackingToken(), destination_url: dest || null,
        created_by: user.id,
      }).select(FIELDS).single();
      if (!e2) { row = data; break; }
      if (e2.code !== "23505") {
        return json(res, e2.code === "42501" ? 403 : 500, { error: "db_insert_failed", detail: e2.message });
      }
    }
    if (!row) return json(res, 500, { error: "token_collision" });
  }

  return json(res, 200, { approach: shapeApproach(row), trackingUrl: trackingUrl(req, row.tracking_token) });
}

async function act(req, res, sb, ctx, user) {
  const body = await readJson(req);
  if (!isUuid(body.id)) return json(res, 400, { error: "invalid_body", required: ["id", "action"] });

  const { data: a, error } = await sb.from("gw_sales_approaches").select(FIELDS)
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }
  if (!a) return json(res, 404, { error: "not_found" });

  if (body.action === "discard") {
    if (a.sent_at) return json(res, 409, { error: "already_sent", hint: "送信済みのアタックは取り消せません" });
    if (a.click_count > 0) return json(res, 409, { error: "already_clicked", hint: "すでにクリックされているので取り消せません" });
    await sb.from("gw_sales_approaches").delete().eq("id", a.id).eq("tenant_id", ctx.tenantId);
    return json(res, 200, { ok: true });
  }
  if (body.action !== "sent") return json(res, 400, { error: "bad_action", allowed: ["sent", "discard"] });
  if (a.sent_at) return json(res, 409, { error: "already_sent", hint: "このアタックは送信完了として記録済みです" });

  const text = String(body.body || "").trim();
  if (!text) return json(res, 400, { error: "body_required", hint: "営業文が空です" });

  const { data: c } = await sb.from("gw_sales_companies").select(COMPANY_FIELDS)
    .eq("id", a.company_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!c) return json(res, 404, { error: "company_not_found" });

  const stop = await guard(sb, ctx, c, { force: Boolean(body.force), exceptId: a.id });
  if (stop) return json(res, stop.status, stop.body);

  const now = new Date().toISOString();
  const patch = {
    sent_at: now,
    body: text.slice(0, 20000),
    subject: body.subject ? String(body.subject).trim().slice(0, 300) || null : a.subject,
    service: body.service !== undefined ? (String(body.service || "").trim().slice(0, 100) || null) : a.service,
    form_url: c.form_url || a.form_url,
    employee_id: a.employee_id || ctx.employee?.id || null,
    forced: Boolean(body.force && canForceAttack(ctx)),
  };
  if (body.templateId !== undefined) patch.template_id = isUuid(body.templateId) ? body.templateId : null;
  if (!a.destination_url && patch.template_id) {
    const d = await templateDestination(sb, ctx, patch.template_id);
    if (d) patch.destination_url = d;
  }
  if (body.campaignId !== undefined) patch.campaign_id = isUuid(body.campaignId) ? body.campaignId : null;

  // 送信完了は1回だけ。二度押し・2つのタブからの同時送信で二重にならないよう、
  // まだ送っていない行だけを更新する
  const { data: saved, error: e2 } = await sb.from("gw_sales_approaches").update(patch)
    .eq("id", a.id).is("sent_at", null).select(FIELDS).maybeSingle();
  if (e2) return json(res, e2.code === "42501" ? 403 : 500, { error: "db_update_failed", detail: e2.message });
  if (!saved) return json(res, 409, { error: "already_sent", hint: "このアタックは送信完了として記録済みです" });

  // 会社の状態を進める（後ろへは戻さない）。NEXTは「反応確認」を3営業日後に置く。
  // すでにクリック・返信・商談まで進んでいる会社は、そちらの NEXT を残す
  const cpatch = { updated_at: now };
  if (statusRank("attacked") > statusRank(c.status)) cpatch.status = "attacked";
  if (!c.owner_id && ctx.employee?.id) cpatch.owner_id = ctx.employee.id;
  if (statusRank(c.status) <= statusRank("attacked")) Object.assign(cpatch, autoNext("sent"));
  await sb.from("gw_sales_companies").update(cpatch).eq("id", c.id).eq("tenant_id", ctx.tenantId);

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "sales.attack_sent",
    target: `sales_company:${c.id}`,
    detail: { approachId: a.id, service: patch.service, templateId: patch.template_id ?? a.template_id, forced: patch.forced },
  });
  return json(res, 200, { approach: shapeApproach(saved) });
}
