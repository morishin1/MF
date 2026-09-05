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
 * Claude による月次試算表の経営アドバイス（テキスト/Markdown）。
 * @param {object} args accounts[] / totals / period / companyName / journalCount
 * @returns {Promise<string>} アドバイス本文
 */
export async function adviseTrialBalance({ accounts = [], totals = {}, period, companyName, journalCount = 0 }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY が未設定です。Vercel 環境変数を設定してください。");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const table = accounts
    .map((a) => `${a.account}\t借方 ${a.debit}\t貸方 ${a.credit}\t残高 ${a.balance}`)
    .join("\n");

  const system = [
    "あなたは中小企業の経営に寄り添う会計アドバイザーです。",
    "渡された月次試算表（当アプリで捕捉した承認済み仕訳の集計）を読み、経営者向けに日本語で簡潔にコメントします。",
    "重要な前提: この試算表は当アプリ内の仕訳のみの集計で、期首残高・他システムの取引・未入力分は含みません。断定しすぎず、数字の根拠を添えてください。",
    "出力は Markdown。見出しは『## 今月の要点』『## 注意したい点』『## 来月のアクション』の3つで、それぞれ箇条書き2〜4項目。",
  ].join("\n");

  const user =
    `対象月: ${period}\n会社: ${companyName || "—"}\n対象仕訳数: ${journalCount}\n\n` +
    `試算表（科目 / 借方 / 貸方 / 残高、単位:円）:\n${table || "(データなし)"}\n\n` +
    `合計: 借方 ${totals.debit || 0} / 貸方 ${totals.credit || 0}`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1400,
    system,
    messages: [{ role: "user", content: user }],
  });
  return (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

/**
 * Claude による日報の読み込みと、本人への返信案。
 *
 * 管理者が1人ぶんの日報を開いて1回押すだけで、
 *   ・今日この人に何が起きたか
 *   ・上司が動くべきことがあるか
 *   ・本人へ返す文
 * までを一度に出す。返信は送らない（下書きを返すだけ）。
 * 送るかどうかは人が決める。AIが勝手に本人へ声をかける形にはしない。
 *
 * @param {object} args
 *   - today:  今日の日報（tc_nippo の行）
 *   - recent: 同じ人の直近の日報（新しい順、today を含まない）
 *   - pastReplies: これまで担当者が送った返信の本文（同じことを繰り返さないため）
 * @returns {Promise<{summary,signals,blockers,ask,reply}>}
 */
export async function analyzeNippo({ today, recent = [], pastReplies = [] }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY が未設定です。Vercel 環境変数を設定してください。");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const system = [
    "あなたは日本の中小企業で、メンバーの日報を毎日読んでいる上長の補佐役です。",
    "渡された日報を読み、上長がすぐ判断できる形に整理し、本人へ返す文の下書きを作ります。",
    "",
    "守ること:",
    "・日報に書かれていないことを推測で足さない。書いていないことは「書かれていない」と扱う。",
    "・人物評価をしない（前向き/後ろ向き、優秀/不足といった決めつけを書かない）。事実と、次に動かせることだけを扱う。",
    "・返信は本人が読むもの。ねぎらい→具体的に良かった点→次の一手 の順で、150字前後の日本語。",
    "・返信で新しい仕事を増やさない。本人が明日やると書いたことを後押しする形にする。",
    "・過去の返信と同じ言い回しを繰り返さない。",
    "・調子が『苦戦』のとき、励ましだけで終わらせない。何が詰まっているかを1つ拾って触れる。",
    "・体調不良・人間関係の悩み・ハラスメントを思わせる記述があれば needs_human を true にし、",
    "  返信は当たり障りのない短い文にとどめる（人が読んで対応すべきことなので、AIが踏み込まない）。",
    "",
    "必ず JSON ツール `review_nippo` を呼び出して返してください。本文には何も書かない。",
  ].join("\n");

  const tools = [{
    name: "review_nippo",
    description: "日報の読み取り結果と、本人への返信案を返す",
    input_schema: {
      type: "object",
      required: ["summary", "signals", "reply", "needs_human"],
      properties: {
        summary: { type: "string", description: "今日この人に何が起きたか。1〜2文" },
        signals: {
          type: "array",
          description: "上長が知っておくべき点。多くて4つ。無ければ空配列",
          items: {
            type: "object",
            required: ["level", "text"],
            properties: {
              level: { type: "string", enum: ["good", "watch", "risk"] },
              text: { type: "string", description: "1文。日報のどの記述から言えるかが分かる書き方にする" },
            },
          },
        },
        blockers: {
          type: "array",
          description: "本人だけでは動かせず、上長が動く必要があること。無ければ空配列",
          items: { type: "string" },
        },
        ask: { type: "string", description: "本人に1つだけ確認するとしたら何か。無ければ空文字" },
        reply: { type: "string", description: "本人へ送る返信の下書き。150字前後" },
        needs_human: { type: "boolean", description: "体調・人間関係など、人が読んで対応すべき内容が含まれるか" },
      },
    },
  }];

  const body = [
    `【今日の日報】\n${nippoToText(today)}`,
    recent.length
      ? `\n【この人の直近の日報】\n${recent.slice(0, 5).map(nippoToText).join("\n---\n")}`
      : "",
    pastReplies.length
      ? `\n【これまで担当者が送った返信（繰り返さないため）】\n${pastReplies.slice(0, 5).map((t) => `・${t}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n");

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    system,
    tools,
    tool_choice: { type: "tool", name: "review_nippo" },
    messages: [{ role: "user", content: `${body}\n\n読み取って \`review_nippo\` を呼んでください。` }],
  });

  const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === "review_nippo");
  if (!tu) throw new Error("AIが日報ツールを呼びませんでした");
  return tu.input;
}

/** 日報の行を、AIに渡す1つの文章にする。空の項目は落とす */
function nippoToText(n) {
  if (!n) return "";
  const rows = (v, cols) => Array.isArray(v) && v.length
    ? "\n  " + v.map((r) => cols.map(([k, label]) => (r[k] ? `${label}:${r[k]}` : "")).filter(Boolean).join(" / ")).join("\n  ")
    : "";

  const kgi = [
    n.goal_today,
    n.kgi_target != null ? `目標 ${n.kgi_target}` : "",
    n.kgi_actual != null ? `実績 ${n.kgi_actual}` : "",
    n.kgi_achieved === true ? "達成" : n.kgi_achieved === false ? "未達" : "",
  ].filter(Boolean).join(" / ");

  const parts = [
    ["日付", n.work_date],
    ["調子", n.mood],
    ["① 今日のKGI", kgi],
    ["② やったこと・成果", rows(n.work_items, [["task", "やったこと"], ["result", "結果"]])],
    ["③ 困ったこと・報告相談", n.no_issues ? "特になし"
      : rows(n.issues, [["issue", "問題"], ["action_taken", "自分でやったこと"],
                        ["consulted", "相談相手"], ["next_action", "次の行動"]])],
    ["④ 改善・学び", [(n.improve_tags || []).join("・"), n.challenge].filter(Boolean).join(" / ")],
    ["⑤ 顧客・チームのためにしたこと", n.contribution],
    ["⑥ 明日の最優先", [n.tomorrow_plan, n.tomorrow_deadline, n.tomorrow_target].filter(Boolean).join(" / ")],

    // 旧い形式の日報（項目を整理する前のもの）も読めるようにしておく
    ["今日の成果（旧）", n.today_work],
    ["止まっていること（旧）", rows(n.stuck, [["item", "案件"], ["reason", "理由"], ["ball", "ボール"]])],
    ["困っていること（旧）", n.struggle],
  ];
  return parts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
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
