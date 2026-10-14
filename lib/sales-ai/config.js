// AI営業（/sales/ai.html）の設定。既存の AI（lib/claude.js の ANTHROPIC_MODEL・ANTHROPIC_API_KEY）とは分けて持つ。
//
// ■ なぜ分けるか
//   AI営業は呼び出しの回数が多い（1社1回×数百社）。既存の AI と同じキー・同じモデル設定にすると、
//   ・既存の機能（日報・人事・会計）の設定を変えたときに、AI営業の費用が読めなくなる
//   ・AI営業の使いすぎが、既存の機能の上限まで食う
//   だから、キーは SALES_AI_ANTHROPIC_API_KEY だけを使う（無ければ止める。ANTHROPIC_API_KEY へは落ちない）。
//   Anthropic 側でも AI営業専用のワークスペースに月の上限を付ける前提（docs/ai-sales-agent-phase0.md §5.6）。
//
// ■ モデル（docs §5.5）
//   light    … Haiku 5.5：企業分析・商材の判定・一次スコア（安い。ほぼ全部これ）
//   standard … Sonnet 5.5：営業文
//   deep     … Opus 5.5：特例だけ（MVP では使わない）
//   Vercel の環境変数 SALES_AI_MODEL_LIGHT / SALES_AI_MODEL_STANDARD / SALES_AI_MODEL_DEEP で差し替えられる。

export const MODELS = {
  light: process.env.SALES_AI_MODEL_LIGHT || "claude-haiku-5-5",
  standard: process.env.SALES_AI_MODEL_STANDARD || "claude-sonnet-5-5",
  deep: process.env.SALES_AI_MODEL_DEEP || "claude-opus-5-5",
};

// 1M トークンあたりのドル（入力・出力）。知らないモデルは一番高い値で見積もる（予約が足りなくならないように）
export const PRICES = {
  "claude-haiku-5-5": { in: 0.10, out: 0.50 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
};
const FALLBACK_PRICE = { in: 15, out: 75 };
export const priceOf = (model) => PRICES[model] || FALLBACK_PRICE;

/** 費用（ドル）。usage は Messages API の usage（キャッシュの読み書きも入力として数える） */
export function costOf(model, usage = {}) {
  const p = priceOf(model);
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return Number(((input * p.in + (usage.output_tokens || 0) * p.out) / 1e6).toFixed(6));
}

/** 予約する額：入力の見込み＋出力の上限（考えるぶんも出力に入る）を全部使ったときの額 */
export function worstCost(model, inputTokens, maxTokens) {
  const p = priceOf(model);
  return Number(((inputTokens * p.in + maxTokens * p.out) / 1e6).toFixed(6));
}

/** 入力トークンの見込み。日本語は1文字≒1トークン以下なので、文字数をそのまま使えば多めに出る */
export const estimateTokens = (text) => Math.ceil(String(text || "").length) + 600;

export const aiKey = () => (process.env.SALES_AI_ANTHROPIC_API_KEY || "").trim() || null;

export const PROMPT_VERSION = "ai-sales-mvp-1";

export const LIMITS = {
  analysisMaxTokens: 6000,   // Haiku：考える＋JSON
  draftMaxTokens: 8000,      // Sonnet：考える＋営業文
  pageChars: 5000,           // 1ページから読む文字数
  totalChars: 14000,         // 1社で AI に渡す文字数の合計
  batch: 5,                  // 1回の API で分析する社数（Vercel の 60 秒に収める）
  timeoutMs: 40000,          // Vercel の 60 秒から、サイトを読む時間（最大 約18秒）を引いた残り。再試行はしない
};

// 重点商材（docs §5.2）。名前は商材マスタ（gw_sales_master_options。db/108）に登録する文字列と同じにする
export const FOCUS_SERVICES = [
  { name: "8EC・8RENT", about: "法人向けのPC販売・レンタル（新品・中古PC、まとめての入替、短期レンタル、キッティング）" },
  { name: "ENGER", about: "IT案件とエンジニアのマッチング（エンジニアを探している会社／案件を出せる会社）" },
  { name: "無限道場（企業開拓）", about: "IT・DX研修の導入先、講師・メンターになれる会社、研修生の受入企業" },
  { name: "無限道場（生徒募集）", about: "研修生を紹介してくれる団体（学校・企業・自治体・支援機関）。個人への勧誘はしない" },
];
export const serviceAbout = (name) => FOCUS_SERVICES.find((s) => s.name === name)?.about || "";

// スコアの項目と仮の配点（合計100。docs §5.9）。商材ごとに settings.score_profiles で変えられる
export const SCORE_ITEMS = [
  { key: "fit", label: "商材適合度", weight: 35 },
  { key: "need", label: "課題の兆候", weight: 25 },
  { key: "segment", label: "対象業種・企業規模", weight: 15 },
  { key: "region", label: "地域戦略", weight: 10 },
  { key: "relation", label: "既存関係・接点", weight: 10 },
  { key: "freshness", label: "データ鮮度", weight: 5 },
];
export const DEFAULT_WEIGHTS = Object.fromEntries(SCORE_ITEMS.map((i) => [i.key, i.weight]));

/** 商材の配点。settings.score_profiles = { default: {...}, "<商材>": {...} }。足りない項目は仮の配点 */
export function weightsFor(settings, service) {
  const profiles = settings?.score_profiles || {};
  const pick = profiles[service] || profiles.default || {};
  const out = {};
  for (const i of SCORE_ITEMS) {
    const v = Number(pick[i.key]);
    out[i.key] = Number.isFinite(v) && v >= 0 ? v : i.weight;
  }
  return out;
}

// 営業文で使わない言い回し（誇大・断定）。設定の banned_phrases に足せる
export const DEFAULT_BANNED = ["必ず", "絶対", "100%", "業界No.1", "業界最安", "最安値", "保証します", "今だけ", "期間限定"];

// 予約を断られた理由 → 画面の文言
export const STOP_LABEL = {
  disabled: "AI営業は停止中です（管理者が「開始」すると使えます）",
  "paused:manual": "AI営業は管理者が停止しています",
  "paused:monthly_cap": "今月の上限額に達したため停止しています",
  "paused:errors": "AIの失敗が続いたため自動停止しています（管理画面で確認して再開してください）",
  "paused:burst": "短時間の呼び出しが多すぎたため自動停止しています（管理画面で確認して再開してください）",
  monthly_cap: "今月の上限額に届くため、これ以上は使えません",
  daily_cap: "今日の上限額に届くため、これ以上は使えません（明日また使えます）",
  daily_company_limit: "今日分析できる社数の上限に達しました（明日また使えます）",
  burst: "短時間の呼び出しが多すぎたため自動停止しました",
};
export const stopLabel = (reason) => STOP_LABEL[reason] || (String(reason || "").startsWith("paused:")
  ? `AI営業は停止中です（${String(reason).slice(7)}）` : "AI営業を使えません");

export const DEFAULT_SETTINGS = {
  enabled: false, paused_reason: null, monthly_target_usd: 50, monthly_cap_usd: 100, daily_cap_usd: 10,
  daily_company_limit: 100, hourly_call_limit: 200, focus_services: FOCUS_SERVICES.map((s) => s.name),
  score_profiles: {}, effective_threshold: 60, signature: null, banned_phrases: [],
};
// API が受け付ける上限（docs §5.6：月 100 ドルが上限）
export const MAX_MONTHLY_CAP = 100;
