// GET  /api/sign/orders                  … 作成依頼の一覧（人事・管理者）
// GET  /api/sign/orders?employeeId=…     … その人ぶんだけ
// GET  /api/sign/orders?file=<id>        … 届いた書面を見るURL（5分だけ有効）
// POST /api/sign/orders {action}
//        "create" … 依頼を作る（誰あてか・条件）
//        "update" … 条件や期限を直す（届く前）
//        "upload" … 届いた書面を置くための署名URLを発行する
//        "attach" … 置いたファイルを依頼に結びつける（確認待ちになる）
//        "send"   … その書面のまま、本人に署名依頼を出す（1クリック）
//        "cancel" … 取り消す
//
// ■ 「誰あてか」を最初に決める
//   依頼を作る時点で employee_id が要る。あとから紐づけ直す作業を無くすため。
//   届いたPDFは、この行にぶら下がる。
//
// ■ 送るのは人が押す
//   届いた瞬間に本人へ流さない。会社が中身を見てから押す。
//   社労士の作り間違いを、本人が先に読むことになる。
//
// ■ 送ったら、そのときのPDFを別のパスに写す
//   依頼の書面は差し替えられる。署名依頼は差し替えられない。
//   同じファイルを指したままだと、署名済みの書面が後から変わる。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { notify } from "../../lib/notify.js";
import { notifySlack } from "../../lib/slack.js";
import { gwLog } from "../../lib/gw-audit.js";
import { signEvent } from "../../lib/sign-audit.js";
import { sha256 } from "../../lib/pdf-jp.js";
import {
  DOC_KINDS, DOC_KIND_KEYS, kindLabel,
  ORDER_FIELDS, ORDER_STATUS, orderStatusLabel,
  normalizeConditions, missingConditions,
} from "../../lib/esign.js";

const BUCKET = "hr";
const SQL = "db/056_doc_orders.sql";
const MAX_BYTES = 15 * 1024 * 1024;
const TTL = 60 * 5;
const ALLOWED_MIME = new Set(["application/pdf"]);

const FIELDS =
  "id, employee_id, doc_kind, title, assignee_name, assignee_email, conditions, note, "
  + "status, due_on, file_name, file_size, file_sha256, uploaded_at, "
  + "requested_at, sign_request_id, created_at, updated_at";

const str = (v, max = 200) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return read(req, res, ctx, user);
  if (req.method === "POST") return act(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 読む ---------------------------------------------------------------------
async function read(req, res, ctx, user) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const sb = admin();

  if (q.get("file")) return fileUrl(res, sb, ctx, user, q.get("file"));

  let query = sb.from("gw_doc_orders")
    .select(`${FIELDS}, employee:gw_employees!gw_doc_orders_employee_id_fkey(id, display_name, department, email)`)
    .eq("tenant_id", ctx.tenantId)
    .order("requested_at", { ascending: false })
    .limit(300);
  if (q.get("employeeId")) query = query.eq("employee_id", q.get("employeeId"));

  const { data, error } = await query;
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const orders = (data || []).map(shape);
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
  });
}

const shape = (o) => ({
  id: o.id,
  employeeId: o.employee_id,
  employee: o.employee || null,
  docKind: o.doc_kind,
  kindLabel: kindLabel(o.doc_kind),
  title: o.title,
  assigneeName: o.assignee_name,
  assigneeEmail: o.assignee_email,
  conditions: o.conditions || {},
  note: o.note,
  status: o.status,
  statusLabel: orderStatusLabel(o.status),
  dueOn: o.due_on,
  fileName: o.file_name,
  fileSize: o.file_size,
  fileHash: o.file_sha256,
  uploadedAt: o.uploaded_at,
  requestedAt: o.requested_at,
  signRequestId: o.sign_request_id,
});

/** 届いた書面を見るためのURL。人事・管理者だけが呼べる（handler で絞ってある） */
async function fileUrl(res, sb, ctx, user, id) {
  const { data: o } = await sb.from("gw_doc_orders")
    .select("id, title, file_path, file_name")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!o) return json(res, 404, { error: "not_found" });
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
async function act(req, res, ctx, user) {
  const body = await readJson(req);
  const sb = admin();
  switch (body?.action) {
    case "create": return create(res, sb, ctx, user, body);
    case "update": return update(res, sb, ctx, user, body);
    case "upload": return uploadUrl(res, sb, ctx, body);
    case "attach": return attach(res, sb, ctx, user, body);
    case "send":   return send(req, res, sb, ctx, user, body);
    case "cancel": return cancel(res, sb, ctx, user, body);
    default: return json(res, 400, { error: "unknown_action" });
  }
}

async function create(res, sb, ctx, user, body) {
  const employeeId = str(body.employeeId, 40);
  if (!employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });

  const { data: emp } = await sb.from("gw_employees")
    .select("id, display_name").eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!emp) return json(res, 404, { error: "employee_not_found" });

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

  const docKind = DOC_KIND_KEYS.includes(body.docKind) ? body.docKind : "employment";
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
  await notifySlack({
    text: `:memo: 書類の作成を依頼しました　${row.title}`,
    lines: [emp.display_name, row.assignee_name || "（依頼先未記入）"],
    link: "admin-esign.html",
  });

  return json(res, 200, { order: shape({ ...data, employee: emp }), missing });
}

async function update(res, sb, ctx, user, body) {
  const o = await load(sb, ctx, body.id);
  if (!o) return json(res, 404, { error: "not_found" });
  // 送ったあとは、依頼の条件を書き換えさせない。
  // 署名依頼は固まっているので、直しても食い違うだけ
  if (o.status === "sent" || o.status === "signed") {
    return json(res, 409, { error: "already_sent", hint: "署名依頼を出したあとは直せません" });
  }

  const patch = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) patch.title = str(body.title, 120) || o.title;
  if (body.assigneeName !== undefined) patch.assignee_name = str(body.assigneeName, 80);
  if (body.assigneeEmail !== undefined) patch.assignee_email = str(body.assigneeEmail, 160);
  if (body.note !== undefined) patch.note = str(body.note, 2000);
  if (body.dueOn !== undefined) {
    patch.due_on = /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueOn || "")) ? body.dueOn : null;
  }
  if (body.conditions !== undefined) patch.conditions = normalizeConditions(body.conditions);

  const { data, error } = await sb.from("gw_doc_orders").update(patch)
    .eq("id", o.id).select(FIELDS).single();
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "doc_order.update",
    target: `doc_order:${o.id}`, detail: { title: data.title },
  });
  return json(res, 200, { order: shape(data) });
}

async function uploadUrl(res, sb, ctx, body) {
  const o = await load(sb, ctx, body.id);
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

async function attach(res, sb, ctx, user, body) {
  const o = await load(sb, ctx, body.id);
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
  return json(res, 200, { order: shape(data) });
}

/** 届いた書面のまま、本人に署名依頼を出す */
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

  const { data: emp } = await sb.from("gw_employees")
    .select("id, display_name, user_id")
    .eq("id", o.employee_id).eq("tenant_id", ctx.tenantId).maybeSingle();
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
  const hash = sha256(bytes);

  // 取り込んだときと中身が違う＝途中で入れ替わっている。送らない
  if (o.file_sha256 && hash !== o.file_sha256) {
    return json(res, 500, {
      error: "hash_mismatch",
      hint: "取り込んだときと書面が一致しません。もう一度取り込み直してください",
    });
  }

  const id = crypto.randomUUID();
  const path = `${ctx.tenantId}/esign/${id}/document.pdf`;
  const up = await sb.storage.from(BUCKET)
    .upload(path, bytes, { contentType: "application/pdf", upsert: false });
  if (up.error) return json(res, 500, { error: "upload_failed", detail: up.error.message });

  const dueOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueOn || "")) ? body.dueOn : addDays(7);
  const { data: row, error } = await sb.from("gw_sign_requests").insert({
    id,
    tenant_id: ctx.tenantId,
    employee_id: o.employee_id,
    title: o.title,
    doc_kind: o.doc_kind,
    source: "uploaded",
    order_id: o.id,
    file_name: o.file_name,
    // 受け取ったPDFなので、差し込みの本文は無い。
    // 本人の画面はPDFを出す。空にすると「本文が消えた」に見えるので、
    // 何を見ればよいかをここに書いておく
    body_snapshot: `この書類はPDFで届いています。下のPDFをご覧ください。\n（${o.file_name || "document.pdf"}）`,
    merged_fields: {},
    status: "sent",
    due_on: dueOn,
    pdf_path: path,
    pdf_sha256: hash,
    sent_by: user.id,
  }).select("id").single();
  if (error) {
    await sb.storage.from(BUCKET).remove([path]).catch(() => {});
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }

  await sb.from("gw_doc_orders").update({
    status: "sent", sign_request_id: row.id, updated_at: new Date().toISOString(),
  }).eq("id", o.id);

  await signEvent(ctx, row.id, "sent", req, { id: user.id, name: ctx.employee?.display_name },
    { title: o.title, dueOn, hash, from: "doc_order" });

  await notify([{
    tenantId: ctx.tenantId, employeeId: o.employee_id, kind: "general",
    title: "署名をお願いします",
    body: `${o.title}（期限 ${dueOn}）`,
    link: "contracts.html",
    dedupeKey: `sign:${row.id}`,
  }]);

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "doc_order.send",
    target: `doc_order:${o.id}`,
    detail: { title: o.title, employee: emp.display_name, signRequestId: row.id, dueOn },
  });
  await notifySlack({
    text: `:lower_left_ballpoint_pen: 署名依頼を送りました　${o.title}`,
    lines: [emp.display_name, `期限 ${dueOn}`],
    link: "admin-esign.html",
  });

  return json(res, 200, { ok: true, signRequestId: row.id, dueOn });
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
async function load(sb, ctx, id) {
  if (!id) return null;
  const { data } = await sb.from("gw_doc_orders")
    .select("id, employee_id, title, doc_kind, status, file_path, file_name, file_sha256")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  return data || null;
}

/** 先頭が %PDF- か。拡張子は名乗るだけなので、中身を見る */
const isPdf = (bytes) =>
  bytes.length > 4 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";

/** 今日から n 日後（日本時間） */
function addDays(n) {
  return new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);
}
