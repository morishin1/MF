// AI 仕訳エンジン
// PDF（base64）を Claude API に渡し、仕訳ドラフトを構造化JSONで取得する。
//
// セキュリティ:
//   - ANTHROPIC_API_KEY はサーバ環境変数のみ。クライアントへ露出しない。
//   - 「学習に使わない/ゼロ保持」設定の組織キーを利用する前提。
//   - PDFは Supabase Storage の署名URL→fetch→base64 してメモリで扱い、保存しない。

import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

// 書類種別（DBの documents.doc_type と一致させる）
export const DOC_TYPES = [
  "invoice","receipt","bank","card","salary","contract",
  "quote","tax","certificate","namecard","other","unknown",
];

// PDF/画像/表テキストを Claude の user content ブロックに整形する共通関数
function buildContent({ pdfBase64, mimeType, textContent, instruction }) {
  if (textContent) {
    return [{
      type: "text",
      text: "以下は Excel/CSV/表をテキスト化したものです（シートごとのCSV）。\n\n" +
        textContent + "\n\n" + instruction,
    }];
  }
  return [
    mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } }
      : null,
    mimeType?.startsWith("image/")
      ? { type: "image", source: { type: "base64", media_type: mimeType, data: pdfBase64 } }
      : null,
    { type: "text", text: instruction },
  ].filter(Boolean);
}

/**
 * Claude による書類の種別判定（会計/非会計を問わない）。
 * 会計証憑かどうか（is_accounting）と、月次振り分け用の日付・要約も返す。
 * @param {object} args pdfBase64 | mimeType | textContent
 * @returns {Promise<{doc_type,is_accounting,doc_date,partner_name,total_amount,summary}>}
 */
export async function classifyDocument({ pdfBase64, mimeType, textContent }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY が未設定です。Vercel 環境変数を設定してください。");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const system = [
    "あなたは日本企業のバックオフィス書類仕分けの専門家です。",
    "渡された書類（画像/PDF、または表テキスト）を見て『何の書類か』を判定します。",
    "会計に関係ない書類（名刺・契約書・私的な書類など）も、無理に会計処理せず種別だけ判定してください。",
    "日付は書類に記載された発生日/発行日を優先して抽出します（例: 領収書の日付）。",
    "必ず JSON ツール `classify_document` を呼び出して返してください。本文には何も書かない。",
  ].join("\n");

  const tools = [{
    name: "classify_document",
    description: "書類の種別・会計証憑か否か・日付・要約を返す",
    input_schema: {
      type: "object",
      required: ["doc_type", "is_accounting", "summary"],
      properties: {
        doc_type: { type: "string", enum: DOC_TYPES },
        is_accounting: { type: "boolean", description: "仕訳（会計処理）が必要な証憑なら true。名刺・契約書等は false" },
        doc_date: { type: "string", description: "書類に記載の日付 YYYY-MM-DD（不明なら空文字）" },
        partner_name: { type: "string", description: "相手先・発行元（読み取れれば。無ければ空文字）" },
        total_amount: { type: "integer", description: "金額があれば税込合計（円・整数）。無ければ0" },
        summary: { type: "string", description: "一言要約（例: 6/12 タクシー代 1,200円 の領収書）" },
      },
    },
  }];

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    tools,
    tool_choice: { type: "tool", name: "classify_document" },
    messages: [{ role: "user", content: buildContent({
      pdfBase64, mimeType, textContent,
      instruction: "この書類の種別を判定して `classify_document` を呼んでください。",
    }) }],
  });

  const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === "classify_document");
  if (!tu) throw new Error("AIが分類ツールを呼びませんでした: " + JSON.stringify(message.content));
  return tu.input;
}

/**
 * Claude による仕訳推論
 * @param {object} args
 *   - pdfBase64:   base64文字列（data URL のヘッダ無し）。PDF/画像のとき指定。
 *   - mimeType:    "application/pdf" or "image/jpeg" 等
 *   - textContent: Excel/CSV をサーバ側でテキスト化した表（指定時はこちらを優先）
 *   - hints:       { accounts?:string[], partners?:string[] } 既存マスタを少しだけ参考に渡す
 * @returns {Promise<object>} 仕訳ドラフト
 */
export async function recognizeDocument({ pdfBase64, mimeType, textContent, hints = {} }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY が未設定です。Vercel 環境変数を設定してください。");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const acctList = (hints.accounts || []).slice(0, 80).join("、");
  const partnerList = (hints.partners || []).slice(0, 80).join("、");

  const system = [
    "あなたは日本の会計の仕訳プロフェッショナルです。",
    "ユーザーが渡す証憑（請求書/領収書/銀行明細など）の画像/PDF、または Excel/CSV をテキスト化した表を読み取り、複式簿記の仕訳ドラフトを作ります。",
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

  // Excel/CSV はサーバ側でテキスト化済みのため、表テキストをそのまま渡す。
  // PDF/画像は base64 の document / image ブロックで渡す。
  const userContent = textContent
    ? [
        {
          type: "text",
          text:
            "以下は Excel/CSV 帳票をテキスト化したものです（シートごとの CSV）。" +
            "この表の各明細から仕訳ドラフトを作って `propose_journal` を呼んでください。\n\n" +
            textContent,
        },
      ]
    : [
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
      ].filter((b) => b && (b.type !== "document" || b.source));

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system,
    tools,
    tool_choice: { type: "tool", name: "propose_journal" },
    messages: [{ role: "user", content: userContent }],
  });

  // tool_use ブロックから入力を取り出す
  const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === "propose_journal");
  if (!tu) {
    throw new Error("AIが仕訳ツールを呼びませんでした: " + JSON.stringify(message.content));
  }
  return tu.input;
}
