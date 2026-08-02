// Drive 同期の共通処理。
// 「取引先 / 対象月 / 種別」フォルダを自動生成して証憑を保存し、
// 同じ月フォルダに仕訳一覧CSVを最新化する。
//
// 例外は呼び出し側で握りつぶせるよう、失敗は throw ではなく結果で返す箇所と
// throw する箇所を用途で分けている（証憑保存＝throw、CSV＝任意）。

import { isConfigured, ensureFolderPath, uploadFile, upsertTextFile, documentFolderParts } from "./gdrive.js";
import { journalsCsv } from "./reports.js";

// Supabase Storage から実体を取得
export async function downloadDocument(sb, storagePath) {
  const { data: signed, error } = await sb.storage.from("documents").createSignedUrl(storagePath, 60);
  if (error) throw new Error("sign_failed: " + error.message);
  const r = await fetch(signed.signedUrl);
  if (!r.ok) throw new Error("download_failed: " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// 証憑1件を Drive へ保存し、documents に保存先を記録する
export async function syncDocumentToDrive(sb, { doc, clientName, buffer }) {
  if (!isConfigured()) return { skipped: "not_configured" };

  const folderId = await ensureFolderPath(
    documentFolderParts({ clientName, period: doc.period, docType: doc.doc_type })
  );
  const up = await uploadFile({
    name: doc.filename, mimeType: doc.mime_type, buffer, parentId: folderId,
  });

  await sb.from("documents").update({
    drive_file_id: up.id,
    drive_link: up.webViewLink || null,
    drive_synced_at: new Date().toISOString(),
  }).eq("id", doc.id);

  return { fileId: up.id, link: up.webViewLink };
}

// 対象月の仕訳一覧CSVを「取引先 / YYYY-MM」直下に最新化（同名は上書き）
export async function syncMonthlyCsv(sb, { clientId, clientName, period }) {
  if (!isConfigured() || !period) return { skipped: true };
  const csv = await journalsCsv(sb, clientId, period);
  const folderId = await ensureFolderPath([clientName, period]);
  const f = await upsertTextFile({
    name: `仕訳一覧_${period}.csv`, mimeType: "text/csv", text: csv, parentId: folderId,
  });
  return { fileId: f.id, link: f.webViewLink };
}
