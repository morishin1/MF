// GET  /api/sign/orders                  … 作成依頼の一覧（人事・管理者。社労士は労働条件の依頼だけ）
// GET  /api/sign/orders?employeeId=…     … その人ぶんだけ
// GET  /api/sign/orders?file=<id>        … 届いた書面を見るURL（5分だけ有効）
// POST /api/sign/orders {action}
//        "create"  … 依頼を作る（誰あてか・条件）                    管理者
//        "update"  … 条件や期限を直す（発行前）                       管理者・社労士（社労士は条件と申し送りだけ）
//        "upload"  … 書面を置くための署名URLを発行する                 管理者・社労士
//        "attach"  … 置いたファイルを依頼に結びつける                  管理者・社労士
//        "preview" … いまの条件で労働条件通知書のPDFを試しに作る（保存しない） 管理者・社労士
//        "approve" … 承認・発行。書面を固めて本人に署名依頼を出す       社労士（管理者も可）
//        "send"    … 届いたPDFのまま本人に署名依頼を出す（承認と同じ道） 管理者
//        "cancel"  … 取り消す                                          管理者
//
// ■ 「誰あてか」を最初に決める
//   依頼を作る時点で employee_id が要る。あとから紐づけ直す作業を無くすため。
//
// ■ 社労士の「確認 → 修正 → 承認・発行」は、この1本で回る
//   管理者が入れた条件（conditions）を社労士が読み、直し、プレビューで確かめ、
//   「承認・発行」を押すと
//     ・PDF ができる（社労士が自分のPDFを置いていれば、それをそのまま使う）
//     ・署名依頼（gw_sign_requests）になって本人に届く
//     ・段階が ②→③ に進み、本人と管理者に知らせる
//   会社が「送る」を押す手は無くなる。社労士が承認したものを会社が読み直す必要は無い。
//   （管理者が自分で承認・発行することもできる。社労士に頼まない案件のため）
//
// ■ 発行したら、そのときのPDFを別のパスに写す
//   依頼の書面は差し替えられる。署名依頼は差し替えられない。
//   同じファイルを指したままだと、署名済みの書面が後から変わる。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import { gwLog } from "../../lib/gw-audit.js";
import { advanceFor } from "../../lib/onboard-advance.js";
import { signEvent } from "../../lib/sign-audit.js";
import { renderContractPdf, sha256 } from "../../lib/pdf-jp.js";
import {
  DOC_KINDS, DOC_KIND_KEYS, kindLabel,
  ORDER_FIELDS, ORDER_STATUS, orderStatusLabel,
  normalizeConditions, missingConditions, noticeBody, NOTICE_TITLE,
  conditionsFromContract, reconcileOfferConditions,
} from "../../lib/esign.js";

const BUCKET = "hr";
const SQL = "db/056_doc_orders.sql";
const SQL2 = "db/071_onboarding_stage2.sql";
const MAX_BYTES = 15 * 1024 * 1024;
const TTL = 60 * 5;
const ALLOWED_MIME = new Set(["application/pdf"]);

const FIELDS =
  "id, employee_id, doc_kind, title, assignee_name, assignee_email, conditions, note, "
  + "status, due_on, file_name, file_size, file_sha256, uploaded_at, "
  + "requested_at, sign_request_id, created_at, updated_at";
// 071・087 で足した列。未適用でも一覧が出るように、別に引く
const FIELDS_071 = "id, approved_by, approved_at, advisor_note, conditions_edited_at, "
  + "override_reason, override_by, override_at";

const str = (v, max = 200) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  // 個人情報を返す。対象の人は二段階認証（強制日以降）
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  // 社労士は、労働条件の依頼を「確認・修正・承認」できる。作る・取り消すは管理者
  const advisor = !canManageHr(ctx) && ctx.isAdvisor;
  if (!canManageHr(ctx) && !advisor) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(req, res, ctx, user, advisor);
  if (req.method === "POST") return act(req, res, ctx, user, advisor);
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読む ---------------------------------------------------------------------
async function read(req, res, ctx, user, advisor) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const sb = admin();

  if (q.get("file")) return fileUrl(req, res, sb, ctx, user, q.get("file"), advisor);
  if (q.get("reconcile") && q.get("employeeId")) {
    if (advisor) return json(res, 403, { error: "forbidden" });
    return json(res, 200, await loadReconciliation(sb, ctx, q.get("employeeId")));
  }

  let query = sb.from("gw_doc_orders")
    .select(`${FIELDS}, employee:gw_employees!gw_doc_orders_employee_id_fkey(id, display_name, department, email, employment_type, joined_on)`)
    .eq("tenant_id", ctx.tenantId)
    .order("requested_at", { ascending: false })
    .limit(300);
  if (q.get("employeeId")) query = query.eq("employee_id", q.get("employeeId"));
  // 社労士に見せるのは労働条件の依頼だけ。取り消したものも出さない
  if (advisor) query = query.eq("doc_kind", "employment").neq("status", "cancelled");

  const { data, error } = await query;
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const extra = await approvals(sb, ctx.tenantId, (data || []).map((o) => o.id));
  const orders = (data || []).map((o) => shape({ ...o, ...(extra.get(o.id) || {}) }, advisor));
  return json(res, 200, {
    orders,
    counts: {
      requested: orders.filter((o) => o.status === "requested").length,
      uploaded: orders.filter((o) => o.status === "uploaded").length,
      sent: orders.filter((o) => o.status === "sent").length,
      signed: orders.filter((o) => o.status === "signed").length,
    },
    kinds: DOC_KINDS,
    fields: ORDER_FIELDS,
    statuses: ORDER_STATUS,
    noticeTitle: NOTICE_TITLE,
    advisor,
  });
}

/**
 * 採用承諾条件との突き合わせ（採用HR Stage 9）。
 * 比較の基準は必ず「本人が承諾したoffer」（gw_hr_offers、accepted_atあり）。
 * gw_hr_applicants の最新値ではない（本人はそれを見ていない）。
 * 採用HR経由でない社員（gw_hr_applicantsに紐づきが無い）は比較自体をしない
 */
async function loadReconciliation(sb, ctx, employeeId) {
  const [{ data: employee }, { data: contract }, { data: applicant }] = await Promise.all([
    sb.from("gw_employees").select("id, employment_type, joined_on, position")
      .eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle(),
    sb.from("gw_contracts").select("*").eq("employee_id", employeeId).eq("status", "active")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("gw_hr_applicants").select("id").eq("employee_id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle(),
  ]);

  const prefillConditions = conditionsFromContract(employee, contract);
  if (!applicant) return { linked: false, hasAcceptedOffer: false, mismatches: [], prefillConditions };

  const { data: offers } = await sb.from("gw_hr_offers").select("*")
    .eq("applicant_id", applicant.id).order("version", { ascending: false }).limit(20);
  const offer = (offers || []).find((o) => o.accepted_at) || null;

  return {
    linked: true, hasAcceptedOffer: Boolean(offer),
    mismatches: reconcileOfferConditions(offer, employee, contract),
    prefillConditions,
  };
}

/** 071 の列。未適用なら空（一覧そのものは止めない） */
async function approvals(sb, tenantId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    const { data } = await sb.from("gw_doc_orders").select(FIELDS_071)
      .eq("tenant_id", tenantId).in("id", ids);
    for (const r of data || []) out.set(r.id, r);
  } catch { /* 071 がまだ */ }
  return out;
}

const shape = (o, advisor = false) => ({
  id: o.id,
  employeeId: o.employee_id,
  // 社労士に渡すのは、通知書に要るものだけ（メールは要らない）
  employee: o.employee
    ? (advisor
        ? { id: o.employee.id, display_name: o.employee.display_name, department: o.employee.department,
            employment_type: o.employee.employment_type, joined_on: o.employee.joined_on }
        : o.employee)
    : null,
  docKind: o.doc_kind,
  kindLabel: kindLabel(o.doc_kind),
  title: o.title,
  assigneeName: o.assignee_name,
  assigneeEmail: o.assignee_email,
  conditions: o.conditions || {},
  missing: missingConditions(o.conditions || {}),
  note: o.note,
  advisorNote: o.advisor_note || null,
  status: o.status,
  statusLabel: orderStatusLabel(o.status),
  dueOn: o.due_on,
  fileName: o.file_name,
  fileSize: o.file_size,
  fileHash: o.file_sha256,
  uploadedAt: o.uploaded_at,
  requestedAt: o.requested_at,
  approvedAt: o.approved_at || null,
  conditionsEditedAt: o.conditions_edited_at || null,
  overrideReason: o.override_reason || null,
  overrideAt: o.override_at || null,
  signRequestId: o.sign_request_id,
});

/** 届いた書面を見るためのURL。人事・管理者と、労働条件の依頼なら社労士 */
async function fileUrl(req, res, sb, ctx, user, id, advisor) {
  const { data: o } = await sb.from("gw_doc_orders")
    .select("id, title, file_path, file_name, doc_kind")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!o) return json(res, 404, { error: "not_found" });
  if (advisor && o.doc_kind !== "employment") return json(res, 403, { error: "forbidden" });
  if (!o.file_path) return json(res, 404, { error: "no_file", hint: "まだ書面が届いていません" });

  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(o.file_path, TTL);
  if (error) return json(res, 404, { error: "no_file", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "doc_order.view",
    target: `doc_order:${o.id}`, detail: { title: o.title },
  });
  return json(res, 200, { url: data.signedUrl, filename: o.file_name || `${o.title}.pdf`, expiresInSec: TTL });
}

// ---- 書く ---------------------------------------------------------------------
async function act(req, res, ctx, user, advisor) {
  const body = await readJson(req);
  const sb = admin();
  const action = body?.action;
  // 社労士にできること。作る・送る・取り消すは会社
  if (advisor && !["update", "upload", "attach", "preview", "approve"].includes(action)) {
    return json(res, 403, { error: "forbidden", hint: "社労士ができるのは 確認・修正・承認・発行 です" });
  }
  switch (action) {
    case "create":  return create(res, sb, ctx, user, body);
    case "update":  return update(res, sb, ctx, user, body, advisor);
    case "upload":  return uploadUrl(res, sb, ctx, body, advisor);
    case "attach":  return attach(res, sb, ctx, user, body, advisor);
    case "preview": return preview(res, sb, ctx, body, advisor);
    case "approve": return approve(req, res, sb, ctx, user, body, advisor);
    case "send":    return send(req, res, sb, ctx, user, body);
    case "cancel":  return cancel(res, sb, ctx, user, body);
    default: return json(res, 400, { error: "unknown_action" });
  }
}

async function create(res, sb, ctx, user, body) {
  const employeeId = str(body.employeeId, 40);
  if (!employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });

  const { data: emp } = await sb.from("gw_employees")
    .select("id, display_name").eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found" });

  const docKind = DOC_KIND_KEYS.includes(body.docKind) ? body.docKind : "employment";

  // 採用承諾条件との突き合わせ（採用HR Stage 9）。労働条件通知書だけ対象。
  // 一致しないまま、社内確認だけで正式な作成依頼を進めさせない。
  // どうしても必要なら、owner・hrだけが理由つきで進められる（override）
  let override = null;
  if (docKind === "employment") {
    const recon = await loadReconciliation(sb, ctx, employeeId);
    if (recon.mismatches.length) {
      const reason = str(body.overrideReason, 500);
      if (!reason) {
        return json(res, 409, {
          error: "offer_mismatch", mismatches: recon.mismatches,
          hint: "採用承諾時の条件と異なります。本人と条件を再確認するか、"
            + "必要ならoffer再発行・本人再承諾のうえで進めてください",
        });
      }
      if (!ctx.isHr) {
        return json(res, 403, { error: "forbidden", hint: "条件不一致のまま進められるのは社長・人事だけです" });
      }
      override = { reason, mismatches: recon.mismatches };
    }
  }

  const conditions = normalizeConditions(body.conditions);
  // 抜けたまま社労士に渡すと、そこだけ空欄の通知書が返ってくる。
  // 押す人が「承知のうえで出す」と決めたときだけ通す
  const missing = missingConditions(conditions);
  if (missing.length && !body.force) {
    return json(res, 400, {
      error: "missing_conditions", missing,
      hint: `${missing.join("・")} がまだ空です`,
    });
  }

  const row = {
    tenant_id: ctx.tenantId,
    employee_id: employeeId,
    doc_kind: docKind,
    title: str(body.title, 120) || kindLabel(docKind),
    assignee_name: str(body.assigneeName, 80),
    assignee_email: str(body.assigneeEmail, 160),
    conditions,
    note: str(body.note, 2000),
    due_on: /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueOn || "")) ? body.dueOn : null,
    requested_by: user.id,
    ...(override ? {
      override_reason: override.reason, override_by: user.id, override_at: new Date().toISOString(),
    } : {}),
  };

  const { data, error } = await sb.from("gw_doc_orders").insert(row)
    .select(FIELDS).single();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "doc_order.create",
    target: `doc_order:${data.id}`,
    detail: { title: row.title, employee: emp.display_name, missing },
  });
  if (override) {
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "doc_order.create_override_mismatch",
      target: `doc_order:${data.id}`,
      detail: { employee: emp.display_name, reason: override.reason, mismatches: override.mismatches },
    });
  }
  await notifySlack({
    text: `:memo: 書類の作成を依頼しました　${row.title}`,
    lines: [emp.display_name, row.assignee_name || "（依頼先未記入）"],
    link: "admin-esign.html",
  });
  // 入社手続きの段階が ①→② に進む。次の担当（社労士）に知らせるのはこの中
  if (row.doc_kind === "employment") await advanceFor(sb, ctx, row.employee_id);

  return json(res, 200, { order: shape({ ...data, employee: emp }), missing });
}

async function update(res, sb, ctx, user, body, advisor) {
  const o = await load(sb, ctx, body.id, advisor);
  if (!o) return json(res, 404, { error: "not_found" });
  // 送ったあとは、依頼の条件を書き換えさせない。
  // 署名依頼は固まっているので、直しても食い違うだけ
  if (o.status === "sent" || o.status === "signed") {
    return json(res, 409, { error: "already_sent", hint: "署名依頼を出したあとは直せません" });
  }
  if (o.status === "cancelled") return json(res, 409, { error: "cancelled", hint: "取り消した依頼は直せません" });

  const now = new Date().toISOString();
  const patch = { updated_at: now };
  if (!advisor) {
    if (body.title !== undefined) patch.title = str(body.title, 120) || o.title;
    if (body.assigneeName !== undefined) patch.assignee_name = str(body.assigneeName, 80);
    if (body.assigneeEmail !== undefined) patch.assignee_email = str(body.assigneeEmail, 160);
    if (body.note !== undefined) patch.note = str(body.note, 2000);
    if (body.dueOn !== undefined) {
      patch.due_on = /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueOn || "")) ? body.dueOn : null;
    }
  }
  let changed = [];
  if (body.conditions !== undefined) {
    const next = normalizeConditions(body.conditions);
    changed = ORDER_FIELDS.map((f) => f.key)
      .filter((k) => String(o.conditions?.[k] ?? "") !== String(next[k] ?? ""));
    patch.conditions = next;
  }
  const extra = {};
  if (body.advisorNote !== undefined) extra.advisor_note = str(body.advisorNote, 2000);
  if (changed.length) { extra.conditions_edited_by = user.id; extra.conditions_edited_at = now; }

  const { data, error } = await sb.from("gw_doc_orders").update(patch)
    .eq("id", o.id).select(FIELDS).single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  // 071 の列は別に書く。未適用でも条件の修正そのものは通す
  if (Object.keys(extra).length) {
    const { error: e2 } = await sb.from("gw_doc_orders").update(extra).eq("id", o.id);
    if (e2 && !/approved_|advisor_note|conditions_edited/.test(e2.message)) {
      return json(res, 500, { error: "db_update_failed", detail: e2.message });
    }
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: advisor ? "doc_order.edit" : "doc_order.update",
    target: `doc_order:${o.id}`, detail: { title: data.title, changed },
  });
  return json(res, 200, { order: shape({ ...data, ...extra }, advisor), changed });
}

async function uploadUrl(res, sb, ctx, body, advisor) {
  const o = await load(sb, ctx, body.id, advisor);
  if (!o) return json(res, 404, { error: "not_found" });
  if (o.status === "sent" || o.status === "signed") {
    return json(res, 409, { error: "already_sent", hint: "署名依頼を出したあとは差し替えられません" });
  }
  if (!ALLOWED_MIME.has(String(body.mimeType || "application/pdf"))) {
    return json(res, 400, { error: "unsupported_mime", hint: "PDFにしてください" });
  }
  if (Number(body.sizeBytes) > MAX_BYTES) {
    return json(res, 400, { error: "file_too_large", hint: "15MBまでにしてください" });
  }

  // 差し替えのたびに別のパスにする。上書きすると、
  // 前の版が何だったか分からなくなる
  const path = `${ctx.tenantId}/doc-order/${o.id}/${crypto.randomUUID()}.pdf`;
  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });
  return json(res, 200, { path, uploadUrl: data.signedUrl, token: data.token });
}

async function attach(res, sb, ctx, user, body, advisor) {
  const o = await load(sb, ctx, body.id, advisor);
  if (!o) return json(res, 404, { error: "not_found" });
  if (o.status === "sent" || o.status === "signed") {
    return json(res, 409, { error: "already_sent", hint: "署名依頼を出したあとは差し替えられません" });
  }

  const path = String(body.path || "");
  // 置き場所を自分で指定できてしまうと、他社のファイルを掴める
  if (!path.startsWith(`${ctx.tenantId}/doc-order/${o.id}/`)) {
    return json(res, 403, { error: "forbidden" });
  }

  // 実体を読んでハッシュを取る。あとで「送った書面と同じか」を突き合わせる
  const dl = await sb.storage.from(BUCKET).download(path);
  if (dl.error || !dl.data) {
    return json(res, 400, { error: "no_file", hint: "置いたファイルを読めませんでした" });
  }
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  if (!isPdf(bytes)) {
    await sb.storage.from(BUCKET).remove([path]);
    return json(res, 400, { error: "not_pdf", hint: "PDFではないようです" });
  }

  const now = new Date().toISOString();
  const { data, error } = await sb.from("gw_doc_orders").update({
    file_path: path,
    file_name: str(body.filename, 200) || "document.pdf",
    file_sha256: sha256(bytes),
    file_size: bytes.length,
    uploaded_by: user.id,
    uploaded_at: now,
    status: "uploaded",
    updated_at: now,
  }).eq("id", o.id).select(FIELDS).single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  // 前の版は消す。差し替えたのに古いのが残っていると、どれが最新か分からない
  if (o.file_path && o.file_path !== path) {
    await sb.storage.from(BUCKET).remove([o.file_path]).catch(() => {});
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "doc_order.attach",
    target: `doc_order:${o.id}`, detail: { title: o.title, hash: data.file_sha256 },
  });
  await advanceFor(sb, ctx, o.employee_id);
  return json(res, 200, { order: shape(data, advisor) });
}

// ---- 労働条件通知書（条件から作る） -------------------------------------------

/** 通知書に要るもの。氏名・入社日・会社名 */
async function noticeContext(sb, ctx, o) {
  const [{ data: emp }, tenant] = await Promise.all([
    sb.from("gw_employees").select("id, display_name, user_id, joined_on")
      .eq("id", o.employee_id).eq("tenant_id", ctx.tenantId).maybeSingle(),
    sb.from("tenants").select("name").eq("id", ctx.tenantId).maybeSingle(),
  ]);
  return { emp: emp || null, companyName: tenant?.data?.name || "" };
}

/** いまの条件で、通知書のPDFを試しに作る。保存しない */
async function preview(res, sb, ctx, body, advisor) {
  const o = await load(sb, ctx, body.id, advisor);
  if (!o) return json(res, 404, { error: "not_found" });
  const conditions = body.conditions !== undefined ? normalizeConditions(body.conditions) : (o.conditions || {});
  const { emp, companyName } = await noticeContext(sb, ctx, o);
  if (!emp) return json(res, 404, { error: "employee_not_found" });

  const text = noticeBody(conditions, { companyName, employeeName: emp.display_name, joinedOn: emp.joined_on });
  let pdf = null;
  try {
    const bytes = await renderContractPdf({
      title: o.title || NOTICE_TITLE, company: companyName, body: text,
      docId: "（プレビュー）", issuedOn: jpToday(), employeeName: emp.display_name,
    });
    pdf = Buffer.from(bytes).toString("base64");
  } catch (e) {
    console.error("[orders] プレビューのPDFを作れませんでした:", e?.message || e);
    return json(res, 500, { error: "pdf_failed", detail: String(e?.message || e) });
  }
  return json(res, 200, {
    title: o.title || NOTICE_TITLE, text, missing: missingConditions(conditions),
    employee: { id: emp.id, name: emp.display_name }, pdfBase64: pdf,
  });
}

/**
 * 承認・発行。社労士（管理者も可）。
 *   条件が付いてくれば先に保存 → PDF（置いた書面があればそれ、無ければ条件から作る）
 *   → 署名依頼 → 本人へ通知 → 段階 ②→③
 */
async function approve(req, res, sb, ctx, user, body, advisor) {
  const o = await load(sb, ctx, body.id, advisor);
  if (!o) return json(res, 404, { error: "not_found" });
  if (o.status === "sent" || o.status === "signed") {
    return json(res, 409, { error: "already_sent", hint: "この依頼はもう発行しています" });
  }
  if (o.status === "cancelled") return json(res, 409, { error: "cancelled", hint: "取り消した依頼は発行できません" });

  const now = new Date().toISOString();
  // 直した条件を、発行と同時に保存する（別に「保存」を押さなくてよい）
  let conditions = o.conditions || {};
  if (body.conditions !== undefined) {
    conditions = normalizeConditions(body.conditions);
    const changed = ORDER_FIELDS.map((f) => f.key)
      .filter((k) => String(o.conditions?.[k] ?? "") !== String(conditions[k] ?? ""));
    if (changed.length) {
      await sb.from("gw_doc_orders").update({ conditions, updated_at: now }).eq("id", o.id);
      // 071 の列。未適用なら error が返るだけ（発行は止めない）
      await sb.from("gw_doc_orders").update({ conditions_edited_by: user.id, conditions_edited_at: now })
        .eq("id", o.id);
    }
  }
  if (body.advisorNote !== undefined) {
    await sb.from("gw_doc_orders").update({ advisor_note: str(body.advisorNote, 2000) }).eq("id", o.id);
  }

  const { emp, companyName } = await noticeContext(sb, ctx, o);
  if (!emp) return json(res, 404, { error: "employee_not_found" });
  if (!emp.user_id) {
    return json(res, 409, {
      error: "no_account",
      hint: `${emp.display_name}さんにはログインアカウントがありません。会社にアカウントの作成を依頼してください`,
    });
  }

  let bytes, source, bodySnapshot, fileName;
  if (o.file_path) {
    // 社労士が自分で作ったPDFを置いている。それをそのまま
    const dl = await sb.storage.from(BUCKET).download(o.file_path);
    if (dl.error || !dl.data) return json(res, 500, { error: "no_file", hint: "書面を取り出せませんでした" });
    bytes = Buffer.from(await dl.data.arrayBuffer());
    if (o.file_sha256 && sha256(bytes) !== o.file_sha256) {
      return json(res, 500, { error: "hash_mismatch", hint: "取り込んだときと書面が一致しません。もう一度取り込み直してください" });
    }
    source = "uploaded";
    fileName = o.file_name;
    bodySnapshot = `この書類はPDFで届いています。下のPDFをご覧ください。\n（${o.file_name || "document.pdf"}）`;
  } else {
    // 条件から通知書を作る。空欄のままは発行させない
    const missing = missingConditions(conditions);
    if (missing.length && !body.force) {
      return json(res, 400, { error: "missing_conditions", missing, hint: `${missing.join("・")} がまだ空です` });
    }
    bodySnapshot = noticeBody(conditions, { companyName, employeeName: emp.display_name, joinedOn: emp.joined_on });
    try {
      bytes = Buffer.from(await renderContractPdf({
        title: o.title || NOTICE_TITLE, company: companyName, body: bodySnapshot,
        docId: o.id, issuedOn: jpToday(), employeeName: emp.display_name,
      }));
    } catch (e) {
      console.error("[orders] 通知書のPDFを作れませんでした:", e?.message || e);
      return json(res, 500, { error: "pdf_failed", detail: String(e?.message || e) });
    }
    source = "advisor";
    fileName = `${o.title || NOTICE_TITLE}.pdf`;
  }

  return issue(req, res, sb, ctx, user, {
    order: o, emp, bytes, source, bodySnapshot, fileName,
    mergedFields: source === "advisor" ? conditions : {},
    dueOn: body.dueOn, approvedBy: user.id, byAdvisor: advisor, action: "doc_order.approve",
  });
}

/** 届いた書面のまま、本人に署名依頼を出す（管理者。承認と同じ道） */
async function send(req, res, sb, ctx, user, body) {
  const o = await load(sb, ctx, body.id);
  if (!o) return json(res, 404, { error: "not_found" });
  if (!o.file_path) return json(res, 409, { error: "no_file", hint: "先に書面を取り込んでください" });
  if (o.status === "sent" || o.status === "signed") {
    return json(res, 409, { error: "already_sent", hint: "この依頼はもう署名依頼を出しています" });
  }
  if (o.status === "cancelled") {
    return json(res, 409, { error: "cancelled", hint: "取り消した依頼からは送れません" });
  }

  const { emp } = await noticeContext(sb, ctx, o);
  if (!emp) return json(res, 404, { error: "employee_not_found" });
  // ログインできない人に送っても、本人は開けない
  if (!emp.user_id) {
    return json(res, 409, {
      error: "no_account",
      hint: `${emp.display_name}さんにはログインアカウントがありません。先に作ってください`,
    });
  }

  const dl = await sb.storage.from(BUCKET).download(o.file_path);
  if (dl.error || !dl.data) return json(res, 500, { error: "no_file", hint: "書面を取り出せませんでした" });
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  // 取り込んだときと中身が違う＝途中で入れ替わっている。送らない
  if (o.file_sha256 && sha256(bytes) !== o.file_sha256) {
    return json(res, 500, {
      error: "hash_mismatch",
      hint: "取り込んだときと書面が一致しません。もう一度取り込み直してください",
    });
  }

  return issue(req, res, sb, ctx, user, {
    order: o, emp, bytes, source: "uploaded",
    bodySnapshot: `この書類はPDFで届いています。下のPDFをご覧ください。\n（${o.file_name || "document.pdf"}）`,
    fileName: o.file_name, mergedFields: {},
    dueOn: body.dueOn, approvedBy: user.id, byAdvisor: false, action: "doc_order.send",
  });
}

/**
 * 書面を固めて、署名依頼にする。承認（approve）と送信（send）の共通部分。
 *   PDF を別のパスに写す → gw_sign_requests → 依頼を sent に → 通知 → 段階を進める
 */
async function issue(req, res, sb, ctx, user, p) {
  const { order: o, emp, bytes } = p;
  const hash = sha256(bytes);
  const id = crypto.randomUUID();
  const path = `${ctx.tenantId}/esign/${id}/document.pdf`;
  const up = await sb.storage.from(BUCKET)
    .upload(path, bytes, { contentType: "application/pdf", upsert: false });
  if (up.error) return json(res, 500, { error: "upload_failed", detail: up.error.message });

  const dueOn = /^\d{4}-\d{2}-\d{2}$/.test(String(p.dueOn || "")) ? p.dueOn : addDays(7);
  const { data: row, error } = await sb.from("gw_sign_requests").insert({
    id,
    tenant_id: ctx.tenantId,
    employee_id: o.employee_id,
    title: o.title,
    doc_kind: o.doc_kind,
    source: p.source,
    order_id: o.id,
    file_name: p.fileName || null,
    body_snapshot: p.bodySnapshot,
    merged_fields: p.mergedFields || {},
    status: "sent",
    due_on: dueOn,
    pdf_path: path,
    pdf_sha256: hash,
    sent_by: user.id,
  }).select("id").single();
  if (error) {
    await sb.storage.from(BUCKET).remove([path]).catch(() => {});
    const hint = dbSetupHint(error, /source/.test(error.message) ? SQL2 : SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }

  const now = new Date().toISOString();
  await sb.from("gw_doc_orders").update({
    status: "sent", sign_request_id: row.id, updated_at: now,
  }).eq("id", o.id);
  // 承認の記録（071）。未適用でも発行は通す
  await sb.from("gw_doc_orders").update({ approved_by: p.approvedBy, approved_at: now })
    .eq("id", o.id);

  await signEvent(ctx, row.id, "sent", req, { id: user.id, name: ctx.employee?.display_name },
    { title: o.title, dueOn, hash, from: p.byAdvisor ? "advisor" : "doc_order", source: p.source });

  // 本人へ。締結のお願い
  await notify([{
    tenantId: ctx.tenantId, employeeId: o.employee_id, kind: "general",
    title: "署名をお願いします",
    body: `${o.title}（期限 ${dueOn}）`,
    link: "contracts.html",
    dedupeKey: `sign:${row.id}`,
  }]);
  // 社労士が発行したときは、会社にも「発行された」を1通
  if (p.byAdvisor) {
    const { data: grants } = await sb.from("gw_role_grants").select("employee_id")
      .eq("tenant_id", ctx.tenantId).in("role", ["hr", "owner"]);
    const ids = [...new Set((grants || []).map((g) => g.employee_id).filter(Boolean))];
    await notify(ids.map((eid) => ({
      tenantId: ctx.tenantId, employeeId: eid, kind: "general",
      title: `社労士が ${emp.display_name}さんの労働条件通知書を発行しました`,
      body: `本人に署名依頼が届いています（期限 ${dueOn}）`,
      link: `admin-esign.html?order=${o.id}`,
      dedupeKey: `order-approved:${o.id}`,
    })));
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: p.action,
    target: `doc_order:${o.id}`,
    detail: { title: o.title, employee: emp.display_name, signRequestId: row.id, dueOn, source: p.source },
  });
  await notifySlack({
    text: `:lower_left_ballpoint_pen: 署名依頼を送りました　${o.title}`,
    lines: [emp.display_name, `期限 ${dueOn}`, p.byAdvisor ? "社労士が承認・発行" : ""].filter(Boolean),
    link: "admin-esign.html",
  });
  // ②→③。本人に「締結してください」が届く
  await advanceFor(sb, ctx, o.employee_id);

  return json(res, 200, { ok: true, signRequestId: row.id, dueOn, source: p.source });
}

async function cancel(res, sb, ctx, user, body) {
  const o = await load(sb, ctx, body.id);
  if (!o) return json(res, 404, { error: "not_found" });
  if (o.status === "signed") {
    return json(res, 409, { error: "already_signed", hint: "締結ずみの依頼は取り消せません" });
  }

  const { error } = await sb.from("gw_doc_orders")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", o.id);
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "doc_order.cancel",
    target: `doc_order:${o.id}`, detail: { title: o.title },
  });
  return json(res, 200, { ok: true, status: "cancelled" });
}

// ---- 小物 ---------------------------------------------------------------------
async function load(sb, ctx, id, advisor = false) {
  if (!id) return null;
  const { data } = await sb.from("gw_doc_orders")
    .select("id, employee_id, title, doc_kind, status, conditions, file_path, file_name, file_sha256")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!data) return null;
  // 社労士が触れるのは労働条件の依頼だけ
  if (advisor && data.doc_kind !== "employment") return null;
  return data;
}

/** 先頭が %PDF- か。拡張子は名乗るだけなので、中身を見る */
const isPdf = (bytes) =>
  bytes.length > 4 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";

/** 今日から n 日後（日本時間） */
function addDays(n) {
  return new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);
}

/** 今日（日本時間）を「2026年9月16日」に */
function jpToday() {
  const d = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const [y, m, dd] = d.split("-").map(Number);
  return `${y}年${m}月${dd}日`;
}
