// POST /api/documents/recognize
// アップロード済みの書類を Claude API に渡して仕訳ドラフトを生成し、journals に保存する。
//
// 入力: { documentId }
// 出力: { journal: {...}, document: {...} }
//
// 注意:
//   - PDFはサーバ側で短期間メモリに展開するだけ。ファイルとして保存しない。
//   - 仕訳は status='draft' で保存し、承認は別 API で行う（人による承認を必須）。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser, getMemberships, canAccessClient } from "../../lib/auth.js";
import { admin } from "../../lib/supabase.js";
import { audit } from "../../lib/audit.js";
import { recognizeDocument } from "../../lib/ai.js";
import { isSpreadsheet, extractSpreadsheetText } from "../../lib/extract.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const { documentId } = await readJson(req);
  if (!documentId) return json(res, 400, { error: "invalid_body", required: ["documentId"] });

  const sb = admin();
  const { data: doc, error: e1 } = await sb
    .from("documents")
    .select("id, tenant_id, client_id, filename, mime_type, storage_path, status")
    .eq("id", documentId).single();
  if (e1 || !doc) return json(res, 404, { error: "document_not_found" });

  const memberships = await getMemberships(user.id);
  if (!canAccessClient(memberships, doc.client_id, doc.tenant_id)) {
    return json(res, 403, { error: "forbidden" });
  }

  // 認識中フラグ
  await sb.from("documents").update({ status: "recognizing" }).eq("id", doc.id);

  try {
    // 1) Storage から短期署名URL→fetch→base64
    const { data: signed, error: e2 } = await sb.storage
      .from("documents")
      .createSignedUrl(doc.storage_path, 60);
    if (e2) throw new Error("sign_failed: " + e2.message);

    const r = await fetch(signed.signedUrl);
    if (!r.ok) throw new Error("download_failed: " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());

    // 2) ヒント（既存マスタの一部を渡して命中率を上げる）
    const hints = {}; // 仕様確定後に accounts/partners を渡す

    // 3) Claude に推論依頼
    //    Excel/CSV はサーバ側で表テキスト化して渡す。PDF/画像は base64 のまま渡す。
    const draft = isSpreadsheet(doc.mime_type)
      ? await recognizeDocument({
          mimeType: doc.mime_type,
          textContent: extractSpreadsheetText(buf),
          hints,
        })
      : await recognizeDocument({
          pdfBase64: buf.toString("base64"),
          mimeType: doc.mime_type,
          hints,
        });

    // 4) journals に保存
    const { data: jrn, error: e3 } = await sb.from("journals").insert({
      tenant_id: doc.tenant_id,
      client_id: doc.client_id,
      document_id: doc.id,
      partner_name: draft.partner_name || null,
      description: draft.description || null,
      txn_date: draft.txn_date || null,
      total_amount: draft.total_amount ?? null,
      tax_category: draft.tax_category || null,
      confidence: draft.confidence || "mid",
      lines: draft.lines,
      ai_note: draft.ai_note || null,
      status: "draft",
    }).select().single();
    if (e3) throw new Error("journal_insert_failed: " + e3.message);

    await sb.from("documents")
      .update({ status: "ready", doc_type: draft.doc_type || "unknown" })
      .eq("id", doc.id);

    await audit({
      tenantId: doc.tenant_id, clientId: doc.client_id, actorId: user.id,
      action: "document.recognized", target: `document:${doc.id}`,
      detail: { journalId: jrn.id, confidence: draft.confidence, doc_type: draft.doc_type },
    });

    return json(res, 200, { document: { ...doc, status: "ready", doc_type: draft.doc_type }, journal: jrn });
  } catch (err) {
    await sb.from("documents").update({ status: "error" }).eq("id", doc.id);
    await audit({
      tenantId: doc.tenant_id, clientId: doc.client_id, actorId: user.id,
      action: "document.recognize_failed", target: `document:${doc.id}`,
      detail: { message: String(err?.message || err) },
    });
    return json(res, 500, { error: "recognize_failed", detail: String(err?.message || err) });
  }
}
