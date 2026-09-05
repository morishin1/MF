// 雇用契約書の読み取りと、そこから生まれる予定。
//
// ■ AIが読んだものを、そのまま使わない
//   契約書は間違えられない書類で、読み違いがそのまま「契約満了日」や
//   「更新の有無」になると実害が出る。
//   AIの結果は draft として置き、人が確認して確定するまで予定を1つも作らない。
//   確定後も、元の読み取り（extracted）は残す。
//
// ■ 予定は契約から計算する
//   台帳に日付を手で入れさせない。契約期間と試用期間の長さが決まれば、
//   満了日も面談日も一意に決まる。契約を直したら予定も作り直す。

import Anthropic from "@anthropic-ai/sdk";

export const PROMPT_VERSION = "contract_v1";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";

export const CONTRACT_TYPES = ["正社員", "契約社員", "パート", "アルバイト", "業務委託", "その他"];
export const WAGE_TYPES = ["月給", "時給", "日給", "年俸", "その他"];

export const KIND_LABEL = {
  probation_end:    "試用期間の満了",
  review:           "期中の面談",
  renewal_decision: "更新の判断",
  contract_end:     "契約の満了",
};

export const DECISION_LABEL = {
  renew:  "更新する",
  end:    "更新しない",
  change: "条件を変えて更新する",
  done:   "確認した",
};

export const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

// -----------------------------------------------------------------------------
// 読み取り
// -----------------------------------------------------------------------------
const SYSTEM = [
  "あなたは日本の労務書類を読む担当者です。",
  "渡された雇用契約書（または労働条件通知書）から、決められた項目だけを抜き出します。",
  "",
  "【守ること】",
  "・書いてあることだけを取る。書かれていない項目は空にする",
  "・推測で埋めない。「たぶん正社員だろう」といった補完をしない",
  "・日付は書面の表記のまま西暦に直す（令和7年4月1日 → 2025-04-01）",
  "・期間の定めが無い契約は fixed_term を false にし、period_to は空にする",
  "・試用期間の記載が無ければ probation_months は空にする（0にしない）",
  "・金額は数字だけを取り、単位や手当の条件は wage_note に文章で残す",
  "・読み取りに自信が持てないときは confidence を low にする。",
  "  無理に埋めるより、人に確認してもらうほうが安全",
  "・原本に書かれた文言をそのまま使えるところは、言い換えない",
].join("\n");

const SCHEMA = {
  type: "object",
  required: ["confidence"],
  properties: {
    contract_type: { type: "string", description: `${CONTRACT_TYPES.join(" / ")} のいずれか。判らなければ空` },
    fixed_term: { type: ["boolean", "null"], description: "期間の定めがあるか" },
    period_from: { type: "string", description: "契約開始日 YYYY-MM-DD。無ければ空" },
    period_to: { type: "string", description: "契約終了日 YYYY-MM-DD。期間の定めが無ければ空" },
    probation_months: { type: ["integer", "null"], description: "試用期間の長さ（月）。記載が無ければ null" },
    renewable: { type: ["boolean", "null"], description: "更新する場合があるか" },
    renewal_criteria: { type: "string", description: "更新の判断基準として書かれている文言。そのまま" },
    work_hours: { type: "string", description: "所定労働時間" },
    work_days: { type: "string", description: "所定労働日・休日" },
    work_place: { type: "string", description: "就業場所" },
    job_content: { type: "string", description: "業務内容" },
    wage_type: { type: "string", description: `${WAGE_TYPES.join(" / ")} のいずれか` },
    wage_amount: { type: ["number", "null"], description: "金額（数字だけ）" },
    wage_note: { type: "string", description: "手当・控除・締日・支払日など、金額だけでは足りない条件" },
    confidence: { type: "string", enum: ["high", "mid", "low"] },
    unreadable: {
      type: "array", items: { type: "string" },
      description: "読み取れなかった項目や、判断に迷った点",
    },
  },
};

/**
 * 契約書のPDF/画像から項目を抜き出す。
 * @returns {Promise<{ok, model?, result?, detail?}>}
 */
export async function readContract({ base64, mimeType }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, detail: "ANTHROPIC_API_KEY が未設定です" };
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const content = [
    mimeType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
      : { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
    { type: "text", text: "この雇用契約書から項目を抜き出して `read_contract` を呼んでください。" },
  ];

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [{ name: "read_contract", description: "雇用契約書の項目を返す", input_schema: SCHEMA }],
      tool_choice: { type: "tool", name: "read_contract" },
      messages: [{ role: "user", content }],
    });
    const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === "read_contract");
    if (!tu) return { ok: false, detail: "AIが読み取りツールを呼びませんでした" };
    return { ok: true, model: MODEL, result: normalize(tu.input) };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) };
  }
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
const text = (v, max = 1000) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** AIの出力を、そのまま列に入れられる形にそろえる */
export function normalize(v) {
  const months = Number(v?.probation_months);
  const amount = Number(v?.wage_amount);
  return {
    contract_type: CONTRACT_TYPES.includes(v?.contract_type) ? v.contract_type : null,
    fixed_term: typeof v?.fixed_term === "boolean" ? v.fixed_term : null,
    period_from: isDate(v?.period_from) ? v.period_from : null,
    period_to: isDate(v?.period_to) ? v.period_to : null,
    probation_months: Number.isInteger(months) && months > 0 && months <= 24 ? months : null,
    renewable: typeof v?.renewable === "boolean" ? v.renewable : null,
    renewal_criteria: text(v?.renewal_criteria, 2000),
    work_hours: text(v?.work_hours, 300),
    work_days: text(v?.work_days, 300),
    work_place: text(v?.work_place, 300),
    job_content: text(v?.job_content, 2000),
    wage_type: WAGE_TYPES.includes(v?.wage_type) ? v.wage_type : null,
    wage_amount: Number.isFinite(amount) && amount >= 0 ? amount : null,
    wage_note: text(v?.wage_note, 2000),
    confidence: ["high", "mid", "low"].includes(v?.confidence) ? v.confidence : "low",
    unreadable: Array.isArray(v?.unreadable) ? v.unreadable.slice(0, 8) : [],
  };
}

// -----------------------------------------------------------------------------
// 予定の組み立て
// -----------------------------------------------------------------------------
const addMonths = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * 契約の内容から予定を組み立てる。
 * 日付は全部ここで計算する。手で入れさせると、契約を直したときに食い違う。
 *
 * @param contract 確定した契約（列の形）
 * @param reviewMonths 期中の面談を置く月（試用期間の途中で見る区切り）
 */
export function buildMilestones(contract, reviewMonths = [1]) {
  const out = [];
  const start = contract.period_from;
  if (!start) return out;

  // 試用期間。満了日に判断の場を置く
  const pEnd = contract.probation_end
    || (contract.probation_months ? addMonths(start, contract.probation_months) : null);
  if (pEnd) {
    // 途中で見る区切り。試用期間より先には置かない
    for (const m of reviewMonths) {
      const due = addMonths(start, m);
      if (due < pEnd) {
        out.push({
          kind: "review",
          title: `${m}か月面談`,
          due_on: due,
          period_from: start,
          period_to: due,
        });
      }
    }
    out.push({
      kind: "probation_end",
      title: "試用期間の満了",
      due_on: pEnd,
      period_from: start,
      period_to: pEnd,
    });
  }

  // 有期契約。満了と、その手前の更新判断
  if (contract.fixed_term && contract.period_to) {
    const notice = Number(contract.renewal_notice_days) || 30;
    const decideOn = addDays(contract.period_to, -notice);
    // 更新の判断は、契約開始より後で、試用期間の満了とも重ならない位置に置く
    if (decideOn > start && decideOn !== pEnd) {
      out.push({
        kind: "renewal_decision",
        title: `更新の判断（満了の${notice}日前）`,
        due_on: decideOn,
        period_from: start,
        period_to: decideOn,
      });
    }
    out.push({
      kind: "contract_end",
      title: "契約の満了",
      due_on: contract.period_to,
      period_from: start,
      period_to: contract.period_to,
    });
  }

  // 同じ日に同じ種類が2つ並ばないようにする
  const seen = new Set();
  return out.filter((m) => {
    const key = `${m.kind}|${m.due_on}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.due_on.localeCompare(b.due_on));
}

// -----------------------------------------------------------------------------
// 面談の所見。試用期間（lib/probation.js）と同じ考え方で、可否は言わせない
// -----------------------------------------------------------------------------
const REVIEW_SYSTEM = [
  "あなたは株式会社エイトの、面談の準備をするAIです。",
  "",
  "★ あなたは契約を更新すべきかどうかを判断しません。それは人が決めます。",
  "  「更新すべき」「終了すべき」といった結論を書かないでください。",
  "  役割は、面談する人が短時間で状況をつかめるように記録を整理し、",
  "  確認したほうがよい点を挙げることです。",
  "",
  "【守ること】",
  "・記録にないことを推測しない（性格・心理状態・やる気・意欲・家庭環境）",
  "・人物評価をしない。期間中に記録された行動事実と数字だけを扱う",
  "・数字は渡されたものをそのまま使う",
  "・契約書に書かれた業務内容や更新基準がある場合は、それと記録を突き合わせる。",
  "  ただし「基準を満たす／満たさない」と断定せず、突き合わせた事実を示すにとどめる",
  "・基準を下回った項目の理由を推測しない。本人に確認する質問の形で questions に入れる",
  "・strengths / concerns / questions はそれぞれ最大3件。summary は200〜300文字",
].join("\n");

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "strengths", "concerns", "questions"],
  properties: {
    summary: { type: "string" },
    strengths: { type: "array", maxItems: 3, items: { type: "string" } },
    concerns: { type: "array", maxItems: 3, items: { type: "string" } },
    questions: { type: "array", maxItems: 3, items: { type: "string" } },
  },
};

export async function reviewMilestone({ employee, contract, milestone, metrics, checks, weeks }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, detail: "ANTHROPIC_API_KEY が未設定です" };
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const m = metrics;

  const checkLines = Object.values(checks || {}).map((c) =>
    c.pass === null
      ? `${c.label}：判定なし（材料不足）`
      : `${c.label}：${c.value}${c.unit}（基準 ${c.threshold}${c.unit}）${c.pass ? "満たす" : "下回る"}`
  ).join("\n");

  const prompt = [
    `【対象】${employee.display_name}さん`,
    `【面談】${KIND_LABEL[milestone.kind]}（期日 ${milestone.due_on}）`,
    `【見る期間】${m.from} 〜 ${m.to}`,
    "",
    "【契約書に書かれていること】",
    contract.contract_type ? `雇用区分：${contract.contract_type}` : "",
    contract.period_from ? `契約期間：${contract.period_from} 〜 ${contract.period_to || "期間の定めなし"}` : "",
    contract.job_content ? `業務内容：${contract.job_content}` : "",
    contract.renewal_criteria ? `更新の判断基準：${contract.renewal_criteria}` : "",
    "",
    "【基準への当てはめ（システムが計算）】",
    checkLines || "（基準なし）",
    "",
    "【期間中の記録】",
    `日報の提出：${m.submitted} / ${m.workdays} 日`,
    m.kgiRate != null ? `KGI達成：${m.kgiAchieved} / ${m.kgiTotal} 日（${m.kgiRate}%）` : "KGI：数値の記録なし",
    `やったこと ${m.workCount} 件（結果まで書かれたもの ${m.resultCount} 件）`,
    `困りごと ${m.issueCount} 件（相談相手を書いたもの ${m.consultedCount} 件）`,
    m.weeklyAvg != null ? `週次評価の平均：${m.weeklyAvg} 点 / 100（${m.weeks} 週）` : "週次評価：まだなし",
    m.improving != null
      ? `週次評価の推移：期間の後半は前半より ${m.improving > 0 ? "+" : ""}${m.improving} 点` : "",
    "",
    "【各週の総評】",
    (weeks || []).map((w) => [
      `■ ${w.week_start} の週：${w.eval_total ?? w.ai_total ?? "—"} 点`,
      w.eval_comment ? `  （管理者）${w.eval_comment}` : (w.ai_summary ? `  ${w.ai_summary}` : ""),
    ].filter(Boolean).join("\n")).join("\n") || "（週次評価なし）",
  ].filter(Boolean).join("\n");

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 2500,
      system: REVIEW_SYSTEM,
      tools: [{ name: "review_milestone", description: "面談の準備をまとめて返す", input_schema: REVIEW_SCHEMA }],
      tool_choice: { type: "tool", name: "review_milestone" },
      messages: [{ role: "user", content: prompt }],
    });
    const tu = (message.content || []).find((b) => b.type === "tool_use" && b.name === "review_milestone");
    if (!tu) return { ok: false, detail: "AIがツールを呼びませんでした" };
    return { ok: true, model: MODEL, result: tu.input };
  } catch (e) {
    return { ok: false, detail: String(e?.message || e) };
  }
}
