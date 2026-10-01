// 労働条件通知書（入社予定者に見せて、確認してもらう書類）。管理側（経営者・人事）の入口。
//
// GET  /api/onboarding/notice?employeeId=…        … その人の通知書の状態と、版の履歴
// GET  /api/onboarding/notice?file=<版のID>        … プレビュー用の署名付きURL（5分だけ有効）
// POST /api/onboarding/notice {action, employeeId, …}
//        "upload"  … PDFを置くための署名URLを発行する（置き場所は、この会社・この人の専用の場所）
//        "attach"  … 置いたPDFを確かめて、新しい版として登録する（差し替えも、新しい版を足す。旧版は消さない）
//        "publish" … いちばん新しい版を、本人に公開する（公開した版は、本人が未確認から始まる）
//
// ■ 誰が使えるか
//   経営者（owner）・人事（hr）・管理者。入社は日常の運用なので、経営（/keiei）ではなく入社管理（admin-hr.html）に置く。
//   本人は、ここを使わない（api/onboarding/start.js で、自分の「公開済みの最新版」だけを見る）。
//   二段階認証は要らない（任意のセキュリティ設定）。
//
// ■ 電子署名とは別
//   通知書の確認は、gw_sign_requests（電子署名）を書き換えない。
//   有効な電子署名依頼があるあいだは、電子署名のほうを優先する（lib/labor-notice.js）。
//
// ■ ファイルの扱い（既存の仕組みをそのまま）
//   非公開バケット hr。PDFのみ（先頭 %PDF- を実体で確認）・15MBまで・SHA-256を残す。
//   署名付きURLは数分だけ。DB・監査ログ・console には残さない（ログに入れるのは、版・ファイル名・件数だけ）。
//   他人・他社の場所を、自分で指定して登録することはできない（isNoticePath）。

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { notify } from "../../lib/notify.js";
import { logSensitive } from "../../lib/sensitive-log.js";
import { advanceFor } from "../../lib/onboard-advance.js";
import {
  NOTICE_BUCKET, NOTICE_MAX_BYTES, NOTICE_TITLE, noticePrefix, isNoticePath, checkDeclared, checkBytes, cleanFilename,
  adminState, canPublish, nextVersion,
} from "../../lib/labor-notice.js";
import {
  NOTICE_SQL, NOTICE_COLS, NOTICE_COLS_FILE, loadNoticeRows, esignState, signedNoticeUrl,
} from "../../lib/labor-notice-db.js";

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const NOT_READY = { error: "not_ready", message: `この機能に必要なテーブルがまだ作られていません。管理者に ${NOTICE_SQL} の実行を依頼してください` };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  res.setHeader?.("Cache-Control", "no-store");

  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 経営者・人事・管理者だけ。給与を含む書類なので、ほかの役割（責任者・採用担当・営業・経理など）には何も返さない
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden", hint: "労働条件通知書は、経営者・人事だけが扱えます" });

  try {
    const sb = admin();
    if (req.method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      if (q.get("file")) return await fileUrl(res, sb, ctx, user, req, String(q.get("file")));
      const employeeId = String(q.get("employeeId") || "");
      if (!employeeId) return json(res, 400, { error: "invalid_query", required: ["employeeId"] });
      const emp = await loadEmployee(sb, ctx, employeeId);
      if (!emp) return json(res, 404, { error: "not_found", hint: "この方の情報を開けません" });
      return json(res, 200, await state(sb, ctx, emp));
    }

    const body = (await readJson(req)) || {};
    const actions = ["upload", "attach", "publish"];
    if (!actions.includes(body.action)) return json(res, 400, { error: "invalid_action", actions });
    const employeeId = String(body.employeeId || "");
    if (!employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });
    const emp = await loadEmployee(sb, ctx, employeeId);
    if (!emp) return json(res, 404, { error: "not_found", hint: "この方の情報を開けません" });
    const act = { sb, ctx, user, emp, body, res, req };
    if (body.action === "upload") return await upload(act);
    if (body.action === "attach") return await attach(act);
    return await publish(act);
  } catch (e) {
    const hint = dbSetupHint(e, NOTICE_SQL);
    if (hint) return json(res, 503, NOT_READY);
    console.error("[onboarding/notice]", e?.message || e);
    return json(res, 500, { error: "notice_failed" });
  }
}

/** この会社の、この人。他社の人は 404 */
async function loadEmployee(sb, ctx, id) {
  const { data } = await sb.from("gw_employees").select("id, display_name, status, user_id")
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  return data || null;
}

/** アップロード・公開した人、確認した人の名前（社員名簿の user_id から） */
async function namesOf(sb, ctx, rows) {
  const ids = [...new Set((rows || []).flatMap((r) => [r.uploaded_by, r.published_by, r.confirmed_by]).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data } = await sb.from("gw_employees").select("user_id, display_name").eq("tenant_id", ctx.tenantId).in("user_id", ids);
  return new Map((data || []).map((e) => [e.user_id, e.display_name]));
}

const view = (r, names, currentId) => ({
  id: r.id, version: Number(r.version), filename: r.filename, sizeBytes: r.size_bytes ?? null, hash: r.sha256 || null,
  uploadedAt: r.uploaded_at, uploadedByName: names.get(r.uploaded_by) || null,
  publishedAt: r.published_at || null, publishedByName: names.get(r.published_by) || null,
  confirmedAt: r.confirmed_at || null, confirmedByName: names.get(r.confirmed_by) || null,
  phase: r.confirmed_at ? "confirmed" : r.published_at ? "published" : "draft",
  isCurrent: r.id === currentId,
});

/** 画面が使う1人ぶんの状態 */
async function state(sb, ctx, emp) {
  const employee = { id: emp.id, name: emp.display_name, status: emp.status, hasAccount: Boolean(emp.user_id) };
  const [{ rows, linked, error }, es] = await Promise.all([
    loadNoticeRows(sb, ctx.tenantId, emp.id), esignState(sb, ctx.tenantId, emp.id),
  ]);
  const esign = { active: es.esign, order: es.order, signStatus: es.signStatus };
  if (!linked) {
    return { employee, linked: false, hint: NOT_READY.message, esign, notice: null, warnings: [], limits: limits() };
  }
  if (error) throw error;

  const st = adminState(rows, { esign: es.esign });
  const names = await namesOf(sb, ctx, rows);
  const currentId = st.current?.id || null;

  const warnings = [];
  if (es.esign) warnings.push("この方には電子署名の依頼があります。通知書の確認だけでは、締結（署名）の扱いにはなりません。電子署名を優先します");
  else if (es.order) warnings.push("この方には、社労士への労働条件の作成依頼があります。通知書を公開して本人が確認すると、契約の手続きは進みます。作成依頼が不要なら、取り消してください");
  if (!emp.user_id) warnings.push("ログインアカウントが未作成のため、本人はまだ通知書を見られません");
  if (emp.status === "left") warnings.push("退職済みの方です");

  return {
    employee, linked: true, esign,
    notice: {
      mode: st.mode, status: st.status, statusLabel: st.statusLabel, replacing: st.replacing,
      current: st.current ? view(st.current, names, currentId) : null,
      pending: st.pending ? view(st.pending, names, currentId) : null,
      versions: st.versions.map((r) => view(r, names, currentId)),
    },
    warnings, limits: limits(),
  };
}

const limits = () => ({ maxBytes: NOTICE_MAX_BYTES, accept: "application/pdf" });

// ---- プレビュー（管理側）----------------------------------------------------------
async function fileUrl(res, sb, ctx, user, req, id) {
  const { data: r, error } = await sb.from("gw_labor_notices").select(NOTICE_COLS_FILE)
    .eq("id", id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (error) {
    if (dbSetupHint(error, NOTICE_SQL)) return json(res, 503, NOT_READY);
    return json(res, 500, { error: "notice_failed" });
  }
  if (!r) return json(res, 404, { error: "not_found" });
  const { url, error: e2 } = await signedNoticeUrl(sb, r.storage_path);
  if (e2) return json(res, 404, { error: "file_missing", hint: "ファイルを開けません" });
  // 誰が・誰のぶんを開いたか（URL は残さない。自分のぶんは logSensitive が残さない）
  await logSensitive({
    tenantId: ctx.tenantId, actor: { id: user.id, name: ctx.employee?.display_name || null },
    subjectId: r.employee_id, selfId: ctx.employee?.id || null,
    kind: "contract", action: "view", target: `labor_notice:${r.id}`,
    detail: { version: r.version, filename: r.filename }, req,
  });
  return json(res, 200, { url, filename: r.filename, version: Number(r.version), expiresInSec: 300 });
}

// ---- アップロード ----------------------------------------------------------------
async function upload({ sb, ctx, emp, body, res }) {
  if (emp.status === "left") return json(res, 409, { error: "employee_left", hint: "退職済みの方には、通知書を登録できません" });
  const d = checkDeclared(body);
  if (!d.ok) return json(res, 400, d);
  // 版ごとに別のパス（上書きしない。前の版を残す）
  const path = `${noticePrefix(ctx.tenantId, emp.id)}${crypto.randomUUID()}.pdf`;
  const { data, error } = await sb.storage.from(NOTICE_BUCKET).createSignedUploadUrl(path);
  if (error) return json(res, 500, { error: "sign_failed" });
  return json(res, 200, { path, uploadUrl: data.signedUrl, token: data.token });
}

// ---- 登録（新しい版）---------------------------------------------------------------
async function attach({ sb, ctx, user, emp, body, res }) {
  const path = String(body.path || "");
  // 置き場所を自分で指定できてしまうと、他人・他社のファイルを掴める
  if (!isNoticePath(path, ctx.tenantId, emp.id)) return json(res, 403, { error: "forbidden" });

  // 同じファイルを2回登録しない（再送・二重押し）
  const first = await loadNoticeRows(sb, ctx.tenantId, emp.id, NOTICE_COLS_FILE);
  if (!first.linked) return json(res, 503, NOT_READY);
  if (first.error) throw first.error;
  if (first.rows.some((r) => r.storage_path === path)) return json(res, 200, await state(sb, ctx, emp));

  const dl = await sb.storage.from(NOTICE_BUCKET).download(path);
  if (dl.error || !dl.data) return json(res, 400, { error: "no_file", hint: "置いたファイルを読めませんでした" });
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  const c = checkBytes(bytes);
  if (!c.ok) {
    await sb.storage.from(NOTICE_BUCKET).remove([path]).catch(() => {});
    return json(res, 400, c);
  }

  // 新しい版を足す（上書きしない）。同時に2人が登録して版が重なったら、数え直して足す
  let inserted = null;
  let rows = first.rows;
  for (let i = 0; i < 3 && !inserted; i++) {
    const { data, error } = await sb.from("gw_labor_notices").insert({
      tenant_id: ctx.tenantId, employee_id: emp.id, version: nextVersion(rows),
      storage_path: path, filename: cleanFilename(body.filename), size_bytes: bytes.length, sha256: sha256(bytes),
      uploaded_by: user.id,
    }).select("id, version, filename, size_bytes").single();
    if (!error) { inserted = data; break; }
    if (error.code !== "23505") {
      await sb.storage.from(NOTICE_BUCKET).remove([path]).catch(() => {});
      throw error;
    }
    rows = (await loadNoticeRows(sb, ctx.tenantId, emp.id, NOTICE_COLS_FILE)).rows;
  }
  if (!inserted) {
    await sb.storage.from(NOTICE_BUCKET).remove([path]).catch(() => {});
    return json(res, 409, { error: "version_conflict", hint: "ほかの人が同時に登録しました。もう一度お試しください" });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "labor_notice.upload", target: `employee:${emp.id}`,
    detail: { version: inserted.version, filename: inserted.filename, size: inserted.size_bytes },
  });
  return json(res, 200, await state(sb, ctx, emp));
}

// ---- 公開 -------------------------------------------------------------------------
async function publish({ sb, ctx, user, emp, body, res }) {
  const id = String(body.id || "");
  const { rows, linked, error } = await loadNoticeRows(sb, ctx.tenantId, emp.id);
  if (!linked) return json(res, 503, NOT_READY);
  if (error) throw error;
  const ok = canPublish(rows, id);
  if (!ok.ok) return json(res, 409, { error: ok.reason, hint: ok.hint });
  const row = rows.find((r) => r.id === id);

  // 公開は一度だけ（同時に押されても、先に通ったほうだけ）
  const now = new Date().toISOString();
  const { data: upd, error: ue } = await sb.from("gw_labor_notices")
    .update({ published_at: now, published_by: user.id })
    .eq("id", id).eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).is("published_at", null)
    .select("id");
  if (ue) throw ue;
  if (!upd || !upd.length) return json(res, 409, { error: "already_published", hint: "この版はもう公開しています" });

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "labor_notice.publish", target: `employee:${emp.id}`,
    detail: { version: Number(row.version), filename: row.filename },
  });
  // 本人へ（ログインアカウントがあるときだけ届く）。URL は載せない。開く先は本人の入社準備
  await notify([{
    tenantId: ctx.tenantId, employeeId: emp.id, kind: "general",
    title: `${NOTICE_TITLE}を確認してください`,
    body: "入社準備の画面から、内容をご確認ください。",
    link: "/onboarding/",
    dedupeKey: `labor-notice:${id}`,
  }]).catch(() => {});
  // 入社手続きの段階を計算し直す（公開すると、本人の番になる）
  await advanceFor(sb, ctx, emp.id);
  return json(res, 200, await state(sb, ctx, emp));
}
