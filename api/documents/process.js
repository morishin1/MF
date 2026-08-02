// POST /api/documents/process
// メンバーのワンアクション処理。アップロード済み書類を AI で:
//   1) 種別判定（会計/非会計を問わない）＋月次振り分け（doc_date→period）
//   2) 会計証憑（is_accounting=true）なら続けて仕訳ドラフトを生成
// ダウンロードは1回だけ行い、分類と仕訳で使い回す。
//
// 入力: { documentId }
// 出力: { document, journal? }

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships, canAccessClient } from "../../lib/auth.js";
import { admin } from "../../lib/supabase.js";
import { audit } from "../../lib/audit.js";
import { classifyDocument, recognizeDocument } from "../../lib/ai.js";
import { isSpreadsheet, extractSpreadsheetText } from "../../lib/extract.js";
import { syncDocumentToDrive, syncMonthlyCsv } from "../../lib/drive-sync.js";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const { documentId } = await readJson(req);
  if (!documentId) return json(res, 400, { error: "invalid_body", required: ["documentId"] });

  const sb = admin();
  const { data: doc, error: e1 } = await sb
    .from("documents")
    .select("id, tenant_id, client_id, filename, mime_type, storage_path, status, uploaded_at")
    .eq("id", documentId).single();
  if (e1 || !doc) return json(res, 404, { error: "document_not_found" });

  const { data: client } = await sb.from("clients").select("name").eq("id", doc.client_id).single();
  const clientName = client?.name || "未設定";

  const memberships = await getMemberships(user.id);
  if (!canAccessClient(memberships, doc.client_id, doc.tenant_id)) {
    return json(res, 403, { error: "forbidden" });
  }

  await sb.from("documents").update({ status: "recognizing" }).eq("id", doc.id);

  try {
    // --- ダウンロード（短期署名URL→fetch）。1回だけ ---
    const { data: signed, error: e2 } = await sb.storage
      .from("documents").createSignedUrl(doc.storage_path, 60);
    if (e2) throw new Error("sign_failed: " + e2.message);
    const r = await fetch(signed.signedUrl);
    if (!r.ok) throw new Error("download_failed: " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());

    let pdfBase64 = null, textContent = null;
    if (isSpreadsheet(doc.mime_type)) {
      textContent = extractSpreadsheetText(buf);
    } else {
      pdfBase64 = buf.toString("base64");
    }

    // --- 1) 種別判定 ---
    const cls = await classifyDocument({ pdfBase64, mimeType: doc.mime_type, textContent });
    const docDate = YMD.test(cls.doc_date || "") ? cls.doc_date : null;
    const period = docDate ? docDate.slice(0, 7) : String(doc.uploaded_at).slice(0, 7);

    const docUpdate = {
      doc_type: cls.doc_type || "unknown",
      doc_date: docDate,
      period,
      ai_summary: cls.summary || null,
      is_accounting: !!cls.is_accounting,
    };

    // --- 2) 会計証憑なら仕訳ドラフト生成 ---
    let journal = null;
    if (cls.is_accounting) {
      // 再処理時の重複を防ぐ: この書類に紐づく未承認(draft)仕訳は作り直す
      await sb.from("journals").delete().eq("document_id", doc.id).eq("status", "draft");

      const draft = await recognizeDocument({ pdfBase64, mimeType: doc.mime_type, textContent });
      const total = Number(draft.total_amount) || 0;
      // 安全装置: 50万円超は自動承認させないため confidence=low
      const confidence = total > 500000 ? "low" : (draft.confidence || "mid");

      // 自動承認: 確度が low 以外はそのまま承認済みにする。
      // low（＝新規パターン / 50万円超 など）は人の確認を残す。
      const autoApprove = confidence !== "low";
      const jid = crypto.randomUUID();
      const now = new Date().toISOString();

      const { data: jrow, error: je } = await sb.from("journals").insert({
        id: jid,
        tenant_id: doc.tenant_id,
        client_id: doc.client_id,
        document_id: doc.id,
        partner_name: draft.partner_name || null,
        description: draft.description || null,
        txn_date: YMD.test(draft.txn_date || "") ? draft.txn_date : (docDate || null),
        total_amount: total || null,
        tax_category: draft.tax_category || null,
        confidence,
        lines: Array.isArray(draft.lines) ? draft.lines : [],
        ai_note: draft.ai_note || null,
        status: autoApprove ? "approved" : "draft",
        approved_by: autoApprove ? user.id : null,
        approved_at: autoApprove ? now : null,
        idempotency_key: autoApprove ? `kp_${doc.client_id}_${jid}` : null,
      }).select().single();
      if (je) throw new Error("journal_insert: " + je.message);
      journal = jrow;
      docUpdate.status = autoApprove ? "approved" : "ready";
    } else {
      docUpdate.status = "filed";
    }

    const { data: updated, error: ue } = await sb
      .from("documents").update(docUpdate).eq("id", doc.id).select().single();
    if (ue) throw new Error("doc_update: " + ue.message);

    await audit({
      tenantId: doc.tenant_id, clientId: doc.client_id, actorId: user.id,
      action: "document.processed", target: `document:${doc.id}`,
      detail: { doc_type: docUpdate.doc_type, period, is_accounting: docUpdate.is_accounting, journalId: journal?.id },
    });

    // --- 3) Google Drive へ自動保存（未設定・失敗でも処理は成功扱い） ---
    let drive = null;
    try {
      const r = await syncDocumentToDrive(sb, { doc: { ...updated }, clientName, buffer: buf });
      if (r.link || r.fileId) {
        drive = r;
        updated.drive_file_id = r.fileId;
        updated.drive_link = r.link;
        // 仕訳一覧CSVも同じ月フォルダで最新化
        try { await syncMonthlyCsv(sb, { clientId: doc.client_id, clientName, period }); } catch (_) {}
      }
    } catch (e) {
      drive = { error: String(e?.message || e) };
    }

    return json(res, 200, { document: updated, journal, drive });
  } catch (err) {
    await sb.from("documents").update({ status: "error" }).eq("id", doc.id);
    return json(res, 500, { error: "process_failed", detail: String(err?.message || err) });
  }
}
