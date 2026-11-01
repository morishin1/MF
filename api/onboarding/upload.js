// POST   /api/onboarding/upload  { itemId, filename, mimeType, sizeBytes }
//          → 書き込み用の署名URLを発行する { fileId, uploadUrl, storagePath }
// PATCH  /api/onboarding/upload  { fileId }
//          → アップロード完了後の確定。人事フォルダへコピーし、項目を「提出済み」にする
// GET    /api/onboarding/upload?fileId=…
//          → 閲覧用の署名URLを返す（見てよい人かは RLS が決める）
//
// 証憑（documents）とは別のバケット 'hr' に保存する。
// マイナンバー確認書類などを、同じ取引先のメンバーから見えない場所に置くため。

import { intakeGate } from "../../lib/onboard-gate.js";
import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient, admin } from "../../lib/supabase.js";
import { hrConfigured, uploadFileOnce } from "../../lib/gdrive.js";
import { ensureProcedureFolders } from "../../lib/hr-drive.js";
import { docByTitle, docOf, folderKeyOf, driveFileName } from "../../lib/onboard-docs.js";
import { jstDate } from "../../lib/nippo.js";
import { logSensitive } from "../../lib/sensitive-log.js";
import { syncProcedureTask } from "../../lib/professional-tasks.js";

// 本人が記入して出すものなので、Word・Excel も受ける
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg", "image/png", "image/heic", "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const VIEW_TTL = 60 * 5;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  // 個人情報を返す。対象の人は二段階認証（強制日以降）
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  if (req.method === "POST") return issueUploadUrl(req, res, ctx, user);
  if (req.method === "PATCH") return confirmUpload(req, res, ctx, user);
  if (req.method === "GET") return viewUrl(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH"]);
}

// ---- 署名URLの発行 --------------------------------------------------------
async function issueUploadUrl(req, res, ctx, user) {
  const body = await readJson(req);
  const { itemId, filename, mimeType, sizeBytes } = body || {};
  if (!itemId || typeof filename !== "string" || !filename.trim() || !mimeType) {
    return json(res, 400, { error: "invalid_body", required: ["itemId", "filename", "mimeType", "sizeBytes"] });
  }
  // ファイル名は表示・Driveへの複製に使う。パスや制御文字、空の書類を受け取らない。
  if (filename.length > 255 || /[/\\\x00-\x1f\x7f]/.test(filename)) {
    return json(res, 400, { error: "invalid_filename" });
  }
  if (!ALLOWED_MIME.has(mimeType)) return json(res, 400, { error: "unsupported_mime" });
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_BYTES) {
    return json(res, 400, { error: "invalid_file_size", max: MAX_BYTES });
  }

  const item = await loadItemForWrite(ctx, itemId);
  if (item.error) return json(res, item.status, { error: item.error, hint: item.hint });
  // 個人番号の書類は共有可否や提出項目に関係なく、Office では収集しない。
  if (isMyNumberFilename(filename)) {
    return json(res, 400, { error: "sensitive_file_name", hint: "マイナンバーを含む書類はアップロードできません。社労士からの別案内をご確認ください。" });
  }

  const sb = admin();
  // 本人が出すときは、契約（署名）が済んでから（lib/onboard-gate.js）。人事の代理アップロードは止めない
  if (item.kind === "onboarding" && ctx.employee?.id === item.employeeId && !canManageHr(ctx)) {
    const gate = await intakeGate(sb, ctx.tenantId, item.employeeId);
    if (!gate.ok) return json(res, 409, { error: "contract_not_signed", stage: gate.stage, hint: gate.hint });
  }
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase().slice(0, 8) : "bin";
  const fileId = crypto.randomUUID();
  const storagePath = `${ctx.tenantId}/${item.procedureId}/${fileId}.${ext}`;

  const { error: ie } = await sb.from("gw_procedure_files").insert({
    id: fileId,
    tenant_id: ctx.tenantId,
    procedure_id: item.procedureId,
    item_id: itemId,
    filename, mime_type: mimeType, size_bytes: sizeBytes,
    storage_path: storagePath,
    uploaded_by: user.id,
  });
  if (ie) return json(res, 500, { error: "db_insert_failed", detail: ie.message });

  const { data: signed, error: se } = await sb.storage.from("hr").createSignedUploadUrl(storagePath);
  if (se) {
    await sb.from("gw_procedure_files").delete().eq("id", fileId);
    return json(res, 500, { error: "sign_failed", detail: se.message });
  }

  return json(res, 200, { fileId, storagePath, uploadUrl: signed.signedUrl, token: signed.token });
}

// ---- アップロード完了後の確定 ---------------------------------------------
async function confirmUpload(req, res, ctx, user) {
  const body = await readJson(req);
  const fileId = body?.fileId;
  const syncOnly = body?.syncOnly === true;
  if (!fileId) return json(res, 400, { error: "invalid_body", required: ["fileId"] });

  const sb = admin();
  const { data: file, error } = await sb
    .from("gw_procedure_files")
    .select("id, procedure_id, item_id, filename, mime_type, size_bytes, storage_path, drive_file_id, uploaded_by")
    .eq("id", fileId)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!file) return json(res, 404, { error: "file_not_found" });
  // 他人がアップロードURLを発行した未確定書類を、本人が誤って確定させない。
  if (file.uploaded_by !== user.id && !canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  // 署名URLを取得しただけでは提出済みにしない。実体の存在とサイズを確認する。
  const { data: stored, error: storageError } = await sb.storage.from("hr").info(file.storage_path);
  if (storageError || !stored) return json(res, 409, { error: "file_not_uploaded" });
  if (Number(stored.size) !== Number(file.size_bytes)) {
    return json(res, 409, { error: "file_size_mismatch" });
  }
  // この事実が記録されるまでは、本人・社労士の提出一覧に表示しない。
  const { error: confirmedError } = await sb.from("gw_procedure_files")
    .update({ uploaded_at: new Date().toISOString() })
    .eq("id", fileId).eq("tenant_id", ctx.tenantId);
  if (confirmedError) return json(res, 500, { error: "upload_confirmation_failed" });

  // 発行時と同じ判定をもう一度通す。署名URLだけ先に取って放置された場合に備える
  const item = await loadItemForWrite(ctx, file.item_id);
  if (item.error) return json(res, item.status, { error: item.error, hint: item.hint });
  if (isMyNumberFilename(file.filename)) {
    await sb.storage.from("hr").remove([file.storage_path]);
    await sb.from("gw_procedure_files").delete().eq("id", fileId).eq("tenant_id", ctx.tenantId);
    return json(res, 400, { error: "sensitive_file_name", hint: "マイナンバーを含む書類は提出できません。社労士からの別案内をご確認ください。" });
  }

  // 再同期は「すでに提出済み」のファイルだけ。差戻し後の古い書類を再提出扱いにしない。
  if (syncOnly && !["submitted", "done"].includes(item.status)) {
    return json(res, 409, { error: "not_submitted", hint: "現在の書類は再提出待ちです" });
  }
  // 項目を「提出済み」にして、提出日時を残す。人事が確認済み（done/na）なら触らない
  if (!syncOnly && item.status !== "done" && item.status !== "na") {
    const patch = {
      status: "submitted", document_id: null,
      submitted_at: new Date().toISOString(), advisor_review_note: null,
      updated_at: new Date().toISOString(),
    };
    const { error: updateError } = await sb
      .from("gw_procedure_items")
      .update(patch)
      .eq("id", file.item_id);
    if (updateError && /advisor_review_note|column .* does not exist/i.test(updateError.message || "")) {
      delete patch.advisor_review_note;
      await sb.from("gw_procedure_items").update(patch).eq("id", file.item_id);
    }
  }

  // 社労士に共有した書類は、提出と同時に確認タスクへ反映する。
  // 新しいマイグレーション適用前でも、本人の提出そのものは止めない。
  if (!syncOnly) await syncProcedureTask(sb, { tenantId: ctx.tenantId, itemId: file.item_id, actorId: user.id }).catch((e) =>
    console.warn("[onboarding/upload] professional task sync skipped:", e?.message || e));

  // 人事フォルダへのコピー。未設定・失敗でも提出自体は成立させる
  const drive = await copyToDrive(sb, ctx, file, item);

  // Google側が落ちても提出原本は非公開hrバケットに残し、次回再同期できる。
  // Google APIの生エラーやフォルダIDは本人に返さない。
  const driveSynced = Boolean(drive?.fileId || drive?.skipped === "already");
  return json(res, 200, {
    ok: true, fileId, stored: true, driveSynced,
    driveStatus: driveSynced ? "synced" : "pending",
    driveHint: driveSynced ? null : "提出は保存済みです。Google Driveへの保存は未完了のため、後から再同期できます。",
  });
}

// ---- 閲覧用URL ------------------------------------------------------------
async function viewUrl(req, res, ctx, user) {
  res.setHeader("Cache-Control", "private, no-store");
  const fileId = new URL(req.url, "http://localhost").searchParams.get("fileId");
  if (!fileId) return json(res, 400, { error: "invalid_query", required: ["fileId"] });

  // 見てよい人かは RLS が決める。読めなければ 0 件になる
  const { data: file } = await userClient(req)
    .from("gw_procedure_files")
    .select("id, filename, storage_path, item:gw_procedure_items(item_key,title,share_with_advisor), procedure:gw_procedures(employee_id)")
    .eq("id", fileId)
    .not("uploaded_at", "is", null)
    .maybeSingle();
  if (!file) return json(res, 404, { error: "file_not_found" });
  // RLS に加えて API でも本人／HR／共有済み社労士を明示的に確認する。
  const isMine = file.procedure?.employee_id === ctx.employee?.id;
  const isSharedAdvisor = ctx.isAdvisor && file.item?.share_with_advisor;
  if (!canManageHr(ctx) && !isMine && !isSharedAdvisor) {
    return json(res, 404, { error: "file_not_found" });
  }
  const doc = docOf(file.item?.item_key) || docByTitle(file.item?.title);
  // 旧データに混在した個人番号書類も、汎用の署名URLから渡さない。
  if (doc?.sensitive || doc?.collect === false || isMyNumberFilename(file.filename)) {
    return json(res, 404, { error: "file_not_found" });
  }

  const { data: signed, error } = await admin()
    .storage.from("hr")
    .createSignedUrl(file.storage_path, VIEW_TTL);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });

  // 誰が・誰の書類を開いたかを残す。本人が自分のを開いたときは残さない。
  // 提出書類は本人確認書類や口座の写しを含む。見ただけでも残す
  await logSensitive({
    tenantId: ctx.tenantId,
    actor: { id: user.id, name: ctx.employee?.display_name || null },
    subjectId: file.procedure?.employee_id || null,
    selfId: ctx.employee?.id || null,
    kind: "file", action: "view", target: `file:${fileId}`,
    detail: { filename: file.filename }, req,
  });

  return json(res, 200, { url: signed.signedUrl, filename: file.filename, expiresInSec: VIEW_TTL });
}

// ---- 共通 -----------------------------------------------------------------

// 「この項目にファイルを付けてよいか」を判定して、必要な情報を返す。
// 本人（自分の手続きの、自分が担当の項目）か、人事・管理者だけを通す。
async function loadItemForWrite(ctx, itemId) {
  if (!itemId) return { error: "invalid_body", status: 400, hint: "itemId が必要です" };

  const { data: item, error } = await admin()
    .from("gw_procedure_items")
    // title は、item_key が付く前に作られた項目を題名で定義に結び付けるのに使う（マイナンバー確認書類を受け取らない判定）
    .select("id, status, owner, item_key, title, share_with_advisor, procedure_id, gw_procedures!inner(id, kind, target_on, employee_id, tenant_id, drive_folders, drive_sensitive_folder_id)")
    .eq("id", itemId)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (error) return { error: "db_query_failed", status: 500, hint: error.message };
  if (!item) return { error: "item_not_found", status: 404 };

  const proc = item.gw_procedures;
  const isMine = ctx.employee && proc.employee_id === ctx.employee.id;
  if (!isMine && !canManageHr(ctx)) return { error: "forbidden", status: 403 };
  if (isMine && !canManageHr(ctx) && item.owner !== "employee") {
    return { error: "not_your_item", status: 403, hint: "会社側で対応する項目です" };
  }

  // マイナンバー確認書類は受け取らない。番号は社労士側で収集・管理する。
  // 「取扱注意」と書いて受け取るより、受け取らないほうが確実に安全
  if ((docOf(item.item_key) || docByTitle(item.title))?.collect === false) {
    return { error: "not_collected", status: 403,
             hint: "この書類はこのシステムでは受け取りません。社労士から直接ご案内があります" };
  }

  return {
    itemId, status: item.status, itemKey: item.item_key, shareWithAdvisor: item.share_with_advisor, procedureId: item.procedure_id,
    kind: proc.kind, targetOn: proc.target_on, employeeId: proc.employee_id,
    driveFolders: proc.drive_folders, sensitiveFolderId: proc.drive_sensitive_folder_id,
  };
}

function isMyNumberFilename(value) {
  return /マイナンバー|個人番号|通知カード|mynumber|my[-_ ]?number/i.test(String(value || ""));
}

// 提出ファイルを Drive の個人フォルダへ置く。失敗しても提出は取り消さない。
//
// ■ 置き場所と名前は、こちらで決める
//   どの書類かは項目の鍵（item_key）で分かるので、
//   lib/onboard-docs.js の定義から 01〜05 のどこに入れるかを引く。
//   マイナンバー確認書類は個人フォルダの外（機微情報）へ。
//   名前は YYYYMMDD_書類名_氏名.拡張子。本人が付けた名前は使わない。
async function copyToDrive(sb, ctx, file, item) {
  if (!hrConfigured()) return { skipped: "not_configured" };
  if (file.drive_file_id) return { skipped: "already" };

  try {
    const { data: employee } = await sb
      .from("gw_employees").select("display_name").eq("id", item.employeeId).maybeSingle();

    // フォルダ一式。登録時に作ってあるはずだが、無ければここで作る
    let folders = item.driveFolders;
    if (!folders) {
      const made = await ensureProcedureFolders({
        kind: item.kind, targetOn: item.targetOn, displayName: employee?.display_name,
        procedureId: item.procedureId,
      });
      if (made.skipped) return { skipped: made.skipped };
      folders = made.folders;
      const { error: folderError } = await sb.from("gw_procedures").update({
        drive_folder_id: made.folderId, drive_link: made.link,
        drive_folders: folders, drive_sensitive_folder_id: made.sensitiveFolderId,
      }).eq("id", item.procedureId).eq("tenant_id", ctx.tenantId);
      if (folderError) throw folderError;
    }

    // どこに置くか。定義に無い項目（人が手で足したもの）は 05_その他
    const doc = docOf(item.itemKey);
    if (doc?.sensitive || doc?.collect === false || isMyNumberFilename(file.filename)) {
      return { skipped: "sensitive_document" };
    }
    const folderKey = doc ? folderKeyOf(doc) : "05";
    const parentId = folders[folderKey || "05"];
    if (!parentId) return { skipped: "no_folder" };

    const { data: signed, error: signedError } = await sb.storage.from("hr").createSignedUrl(file.storage_path, 60);
    if (signedError || !signed?.signedUrl) throw new Error("hr_storage_sign_failed");
    const r = await fetch(signed.signedUrl);
    if (!r.ok) throw new Error("download_failed: " + r.status);
    const buffer = Buffer.from(await r.arrayBuffer());

    // 再同期しても複製を増やさないよう、ファイル台帳のUUIDをファイル名に含める。
    const baseName = driveFileName(jstDate(), doc?.title || "提出書類", employee?.display_name, file.filename);
    // 先頭にUUIDを置いて、Driveのファイル名上限で省略されても再実行時の一意性を守る。
    const name = `${file.id}_${baseName}`;
    const up = await uploadFileOnce({ name, mimeType: file.mime_type, buffer, parentId });

    const { error: updateError } = await sb
      .from("gw_procedure_files")
      .update({
        drive_file_id: up.id, drive_link: up.webViewLink || null,
        drive_folder_key: folderKey,
        drive_name: name,
      })
      .eq("id", file.id).eq("tenant_id", ctx.tenantId);
    if (updateError) throw updateError;

    return { fileId: up.id, folder: folderKey };
  } catch (e) {
    console.error("[onboarding] hr drive copy failed:", e?.message || e);
    return { error: "sync_failed" };
  }
}
