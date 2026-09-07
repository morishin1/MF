// GET    /api/sign                        … 署名依頼の一覧（人事・管理者）
// POST   /api/sign {preview:true, ...}    … 差し込んだ本文とPDFを試しに作る（保存しない）
// POST   /api/sign {templateId, employeeIds, ...} … 署名依頼を送る
// PATCH  /api/sign {id, action:"resend"|"cancel"} … 再送・取り消し
//
// ■ 送る＝そのときの文面を固める
//   雛形は後から直せる。直したあとで「あのとき何に署名したのか」を
//   雛形から復元することはできない。だから送る時点で
//     ・差し込み済みの本文（body_snapshot）
//     ・そこから作ったPDFと、そのSHA-256
//   を依頼の行に持たせる。以後、雛形を直しても消しても影響しない。
//
// ■ 署名済みには触らせない
//   status が signed の行は、再送も取り消しもできない。
//   PDFも上書きしない（署名前と署名済みは別のパス）。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import { gwLog } from "../../lib/gw-audit.js";
import { signEvent } from "../../lib/sign-audit.js";
import { renderContractPdf, sha256 } from "../../lib/pdf-jp.js";
import {
  DOC_KINDS, DOC_KIND_KEYS, MERGE_FIELDS, buildFields, merge, statusOf,
} from "../../lib/esign.js";

const BUCKET = "hr";
const R_FIELDS =
  "id, tenant_id, template_id, employee_id, title, doc_kind, doc_version, "
  + "status, due_on, pdf_path, pdf_sha256, signed_pdf_path, signed_pdf_sha256, "
  + "signed_at, signer_name, signer_email, signer_ip, signer_ua, agreed_text, "
  + "sent_at, resent_at, resent_count, first_viewed_at, created_at";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return list(req, res, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    return body?.preview ? preview(res, ctx, body) : send(req, res, ctx, user, body);
  }
  if (req.method === "PATCH") return patch(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

// ---- 一覧 ---------------------------------------------------------------------
async function list(req, res, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const want = q.get("status");            // sent | signed | overdue | all

  const { data, error } = await userClient(req)
    .from("gw_sign_requests")
    .select(`${R_FIELDS}, employee:gw_employees!gw_sign_requests_employee_id_fkey(id, display_name, department, email)`)
    .eq("tenant_id", ctx.tenantId)
    .order("sent_at", { ascending: false })
    .limit(400);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  const rows = (data || []).map((r) => ({ ...r, view: statusOf(r) }));
  const counts = {
    sent: rows.filter((r) => r.view === "sent").length,
    overdue: rows.filter((r) => r.view === "overdue").length,
    signed: rows.filter((r) => r.view === "signed").length,
    cancelled: rows.filter((r) => r.view === "cancelled").length,
  };

  return json(res, 200, {
    requests: want && want !== "all" ? rows.filter((r) => r.view === want) : rows,
    counts,
    kinds: DOC_KINDS,
    mergeFields: MERGE_FIELDS,
  });
}

// ---- 差し込みの下ごしらえ -----------------------------------------------------
//
// 名簿・入社フォーム・雇用契約から、その人ぶんの値を集める。
// 契約は active のいちばん新しいものを見る
async function fieldsFor(ctx, employeeIds) {
  const sb = admin();
  const [emps, profiles, contracts, tenant] = await Promise.all([
    sb.from("gw_employees")
      .select("id, display_name, email, department, position, employment_type, joined_on, work_location, initial_role")
      .eq("tenant_id", ctx.tenantId).in("id", employeeIds),
    sb.from("gw_onboard_profiles")
      .select("employee_id, name_kana, postal_code, address, phone, birth_date")
      .in("employee_id", employeeIds),
    sb.from("gw_contracts")
      .select("employee_id, fixed_term, period_from, period_to, probation_months, work_place, "
            + "job_content, work_hours, work_days, wage_type, wage_amount, wage_note, created_at")
      .eq("tenant_id", ctx.tenantId).in("employee_id", employeeIds)
      .eq("status", "active").order("created_at", { ascending: false }),
    sb.from("tenants").select("name").eq("id", ctx.tenantId).maybeSingle(),
  ]);

  const byProfile = new Map((profiles.data || []).map((p) => [p.employee_id, p]));
  const byContract = new Map();
  for (const c of contracts.data || []) if (!byContract.has(c.employee_id)) byContract.set(c.employee_id, c);
  const companyName = tenant.data?.name || "";

  const out = new Map();
  for (const e of emps.data || []) {
    out.set(e.id, {
      employee: e,
      fields: buildFields({
        employee: e,
        profile: byProfile.get(e.id) || {},
        contract: byContract.get(e.id) || {},
        companyName,
      }),
    });
  }
  return { map: out, companyName };
}

// ---- プレビュー（保存しない） -------------------------------------------------
async function preview(res, ctx, body) {
  const employeeId = body?.employeeId;
  if (!employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });

  const tpl = await loadTemplate(ctx, body);
  if (tpl.error) return json(res, tpl.status, tpl);

  const { map, companyName } = await fieldsFor(ctx, [employeeId]);
  const one = map.get(employeeId);
  if (!one) return json(res, 404, { error: "employee_not_found" });

  const { text, missing } = merge(tpl.body, one.fields);
  let pdf = null;
  try {
    const bytes = await renderContractPdf({
      title: tpl.name, company: companyName, body: text,
      docId: "（プレビュー）", issuedOn: one.fields["今日"],
      employeeName: one.employee.display_name, version: tpl.version,
    });
    pdf = Buffer.from(bytes).toString("base64");
  } catch (e) {
    console.error("[sign] プレビューのPDFを作れませんでした:", e?.message || e);
    return json(res, 500, { error: "pdf_failed", detail: String(e?.message || e) });
  }

  return json(res, 200, {
    title: tpl.name, text, missing, fields: one.fields,
    employee: { id: one.employee.id, name: one.employee.display_name },
    pdfBase64: pdf,
  });
}

/** 雛形（保存済み）か、画面で書きかけの本文か。どちらでもプレビューできる */
async function loadTemplate(ctx, body) {
  if (body?.templateId) {
    const { data } = await admin()
      .from("gw_sign_templates").select("id, name, body, doc_kind, version, due_days")
      .eq("id", body.templateId).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!data) return { error: "template_not_found", status: 404 };
    return data;
  }
  if (typeof body?.body === "string" && body.body.trim()) {
    return {
      id: null,
      name: String(body.title || "契約書").slice(0, 120),
      body: body.body,
      doc_kind: DOC_KIND_KEYS.includes(body.docKind) ? body.docKind : "other",
      version: null,
      due_days: 7,
    };
  }
  return { error: "no_template", status: 400, hint: "雛形を選ぶか、本文を入れてください" };
}

// ---- 署名依頼を送る -----------------------------------------------------------
async function send(req, res, ctx, user, body) {
  const ids = [...new Set((Array.isArray(body?.employeeIds) ? body.employeeIds : [body?.employeeId])
    .filter(Boolean))];
  if (!ids.length) return json(res, 400, { error: "invalid_body", required: ["employeeIds"] });
  if (ids.length > 50) return json(res, 400, { error: "too_many", hint: "一度に送れるのは50人までです" });

  const tpl = await loadTemplate(ctx, body);
  if (tpl.error) return json(res, tpl.status, tpl);

  // 期限。指定が無ければ雛形の既定日数を足す
  const dueOn = body?.dueOn || addDays(tpl.due_days || 7);

  const { map, companyName } = await fieldsFor(ctx, ids);
  const sb = admin();
  const out = { sent: [], failed: [] };

  for (const employeeId of ids) {
    const one = map.get(employeeId);
    if (!one) { out.failed.push({ employeeId, reason: "名簿にありません" }); continue; }

    const { text, missing } = merge(tpl.body, one.fields);
    // 埋まらない項目があるまま送らせない。
    // 【未入力：住所】と書かれた契約書に署名させるわけにはいかない
    if (missing.length && !body?.force) {
      out.failed.push({
        employeeId, name: one.employee.display_name,
        reason: `${missing.join("・")} が未登録です`,
        missing,
      });
      continue;
    }

    try {
      const id = crypto.randomUUID();
      const bytes = await renderContractPdf({
        title: tpl.name, company: companyName, body: text,
        docId: id, issuedOn: one.fields["今日"],
        employeeName: one.employee.display_name, version: tpl.version,
      });
      const hash = sha256(bytes);
      const path = `${ctx.tenantId}/esign/${id}/document.pdf`;

      const up = await sb.storage.from(BUCKET)
        .upload(path, Buffer.from(bytes), { contentType: "application/pdf", upsert: false });
      if (up.error) throw new Error(up.error.message);

      const { data: row, error } = await sb.from("gw_sign_requests").insert({
        id,
        tenant_id: ctx.tenantId,
        template_id: tpl.id,
        employee_id: employeeId,
        title: tpl.name,
        doc_kind: tpl.doc_kind,
        doc_version: tpl.version,
        body_snapshot: text,
        merged_fields: one.fields,
        status: "sent",
        due_on: dueOn,
        pdf_path: path,
        pdf_sha256: hash,
        sent_by: user.id,
      }).select(R_FIELDS).single();
      if (error) throw new Error(error.message);

      await signEvent(ctx, id, "sent", req, { id: user.id, name: ctx.employee?.display_name },
        { title: tpl.name, dueOn, hash });

      await notify([{
        tenantId: ctx.tenantId,
        employeeId,
        kind: "general",
        title: "署名をお願いします",
        body: `${tpl.name}（期限 ${dueOn}）`,
        link: "contracts.html",
        dedupeKey: `sign:${id}`,
      }]);

      out.sent.push({ id, employeeId, name: one.employee.display_name });
    } catch (e) {
      console.error("[sign] 送れませんでした:", e?.message || e);
      out.failed.push({ employeeId, name: one.employee.display_name, reason: String(e?.message || e) });
    }
  }

  if (out.sent.length) {
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "sign.send",
      target: `sign_template:${tpl.id || "adhoc"}`,
      detail: { title: tpl.name, count: out.sent.length, dueOn },
    });
    await notifySlack({
      text: `:memo: 署名依頼を送りました　${tpl.name}`,
      lines: [`${out.sent.length}名`, `期限 ${dueOn}`],
      link: "admin-esign.html",
    });
  }
  return json(res, 200, out);
}

// ---- 再送・取り消し -----------------------------------------------------------
async function patch(req, res, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const sb = admin();
  const { data: r } = await sb.from("gw_sign_requests")
    .select("id, status, title, employee_id, due_on")
    .eq("id", body.id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!r) return json(res, 404, { error: "request_not_found" });

  // 署名済みは動かさない。ここが緩むと、記録の意味が無くなる
  if (r.status === "signed") {
    return json(res, 409, { error: "already_signed", hint: "署名済みの契約書は変えられません" });
  }

  if (body.action === "cancel") {
    const { error } = await sb.from("gw_sign_requests")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("id", r.id);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
    await signEvent(ctx, r.id, "cancelled", req, { id: user.id, name: ctx.employee?.display_name }, null);
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "sign.cancel",
      target: `sign_request:${r.id}`, detail: { title: r.title },
    });
    return json(res, 200, { ok: true, status: "cancelled" });
  }

  if (body.action === "resend") {
    if (r.status !== "sent") return json(res, 409, { error: "not_open", hint: "取り消した依頼は再送できません" });
    // 期限を延ばすかどうかは、押す人が決める
    const dueOn = body.dueOn || r.due_on;
    const now = new Date().toISOString();
    const { error } = await sb.from("gw_sign_requests")
      .update({ resent_at: now, resent_count: (r.resent_count || 0) + 1, due_on: dueOn, updated_at: now })
      .eq("id", r.id);
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

    await signEvent(ctx, r.id, "resent", req, { id: user.id, name: ctx.employee?.display_name }, { dueOn });
    await notify([{
      tenantId: ctx.tenantId, employeeId: r.employee_id, kind: "general",
      title: "署名がまだ済んでいません",
      body: `${r.title}（期限 ${dueOn || "未設定"}）`,
      link: "contracts.html",
      dedupeKey: `sign:${r.id}`,
    }]);
    return json(res, 200, { ok: true, dueOn });
  }

  return json(res, 400, { error: "invalid_action", detail: "resend, cancel" });
}

/** 今日から n 日後（日本時間） */
function addDays(n) {
  const t = new Date(Date.now() + 9 * 3600000 + n * 86400000);
  return t.toISOString().slice(0, 10);
}
