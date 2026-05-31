// AI 仕訳エンジン
// PDF（base64）を Claude API に渡し、仕訳ドラフトを構造化JSONで取得する。
//
// セキュリティ:
//   - ANTHROPIC_API_KEY はサーバ環境変数のみ。クライアントへ露出しない。
//   - 「学習に使わない/ゼロ保持」設定の組織キーを利用する前提。
//   - PDFは Supabase Storage の署名URL→fetch→base64 してメモリで扱い、保存しない。

import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

/**
 * Claude による仕訳推論
 * @param {object} args
 *   - pdfBase64: base64文字列（data URL のヘッダ無し）
 *   - mimeType:  "application/pdf" or "image/jpeg" 等
 *   - hints:     { accounts?:string[], partners?:string[] } 既存マスタを少しだけ参考に渡す
 * @returns {Promise<object>} 仕訳ドラフト
 */
export async function recognizeDocument({ pdfBase64, mimeType, hints = {} }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY が未設定です。Vercel 環境変数を設定してください。");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const acctList = (hints.accounts || []).slice(0, 80).join("、");
  const partnerList = (hints.partners || []).slice(0, 80).join("、");

  const system = [
    "あなたは日本の会計の仕訳プロフェッショナルです。",
    "ユーザーが渡す証憑（請求書/領収書/銀行明細など）の画像/PDFを読み取り、複式簿記の仕訳ドラフトを作ります。",
    "必ず JSON ツール `propose_journal` を呼び出して結果を返してください。本文には何も書かない。",
    "判断に迷う場合は confidence='low' とし、ai_note に判断根拠と確認したい点を簡潔に書いてください。",
    acctList ? `参考になる勘定科目: ${acctList}` : "",
    partnerList ? `既知の取引先: ${partnerList}` : "",
  ].filter(Boolean).join("\n");

  const tools = [
    {
      name: "propose_journal",
      description: "証憑から推定した仕訳ドラフトを返す",
      input_schema: {
        type: "object",
        required: ["doc_type", "lines", "confidence"],
        properties: {
          doc_type: { type: "string", enum: ["invoice","receipt","bank","salary","contract","unknown"] },
          partner_name: { type: "string", description: "取引先名（読み取れなければ空文字）" },
          description: { type: "string", description: "摘要" },
          txn_date: { type: "string", description: "取引日 YYYY-MM-DD（不明なら空文字）" },
          total_amount: { type: "integer", description: "税込合計（円、整数）" },
          tax_category: { type: "string", description: "例: 課仕10% / 課売10% / 対象外" },
          confidence: { type: "string", enum: ["high","mid","low"] },
          lines: {
            type: "array",
            minItems: 2,
            items: {
              type: "object",
              required: ["side","account","amount"],
              properties: {
                side: { type: "string", enum: ["debit","credit"] },
                account: { type: "string", description: "勘定科目（例: 通信費、未払金）" },
                sub_account: { type: "string" },
                amount: { type: "integer", description: "円・整数" },
                tax: { type: "string", description: "税区分（必要なら）" },
              },
            },
          },
          ai_note: { type: "string", description: "推論メモ・確認したい点" },
        },
      },
    },
  ];

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system,
    tools,
    tool_choice: { type: "tool", name: "propose_journal" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source:
              mimeType === "application/pdf"
                ? { type: "base64", media_type: "application/pdf", data: pdfBase64 }
                : undefined,
          },
          // 画像系はフォールバック
          mimeType?.startsWith("image/")
            ? { type: "image", source: { type: "base64", media_type: mimeType, data: pdfBase64 } }
            : null,
          { type: "text", text: "この証憑から仕訳ドラフトを作って `propose_journal` を呼んでください。" },
        ].filter((b) => b && (b.type !== "document" || b.source)),
      },
    ],
  });

  // tool_use ブロックから入力を取り出す
  const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === "propose_journal");
  if (!tu) {
    throw new Error("AIが仕訳ツールを呼びませんでした: " + JSON.stringify(message.content));
  }
  return tu.input;
}
