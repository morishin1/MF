// 日報（tc_nippo）まわりの共通処理。
//
// ■ なぜ既存のテーブルをそのまま使うのか
//   日報は 8grp.co.jp/8/dr/ で1年以上動いていて、過去ぶんが tc_nippo に溜まっている。
//   グループウェアへ移すにあたって表を作り直すと、その過去ぶんが読めなくなるか、
//   移すあいだ「どちらが本物か」が分からない期間ができる。
//   Supabase は同じプロジェクトなので、表はそのまま使い、入口だけを移した。
//
//   さらに好都合なことに tc_profiles.id は auth.users(id) を指している。
//   つまり tc_nippo.user_id は、このグループウェアでログインしている
//   auth ユーザーの id とそのまま同じ。突き合わせ表は要らない。
//
// ■ 書き込みの入口をここ（サーバ側）に絞っている理由
//   tc_* の RLS は anon にも開いている（タイムカードが簡易ログインで動いているため）。
//   その設定はタイムカード側が壊れるので変えられない。
//   代わりに、グループウェアからの書き込みは必ず API を通し、
//   「自分の日報しか書けない」をここで担保する。

const JST = 9 * 3600000;

/** 日本時間での YYYY-MM-DD。サーバは UTC で動くので9時間足してから切る */
export function jstDate(offsetDays = 0) {
  return new Date(Date.now() + JST + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** その日を含む週の月曜日（YYYY-MM-DD） */
export function weekStart(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const dow = d.getUTCDay();               // 0=日
  const back = dow === 0 ? 6 : dow - 1;    // 月曜まで何日戻るか
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

export const MOODS = ["順調", "普通", "苦戦"];

// 朝に描いた状態になれたか。点数にしない（034 の理由を参照）
export const SUCCESS_MET = [
  { key: "o", label: "なれた",     mark: "○" },
  { key: "d", label: "途中まで",   mark: "△" },
  { key: "x", label: "ならなかった", mark: "×" },
];
const MET_KEYS = SUCCESS_MET.map((m) => m.key);

// ④ 今日の改善・学び の選択肢。自由記述を減らすため選択式にしている
export const IMPROVE_TAGS = [
  { key: "self_research", label: "自分で調べた" },
  { key: "new_method",    label: "新しい方法を試した" },
  { key: "feedback",      label: "フィードバックを反映した" },
  { key: "process",       label: "仕事のやり方を改善した" },
  { key: "ai_tool",       label: "AI・ツールを活用した" },
  { key: "other",         label: "その他" },
];
const TAG_KEYS = IMPROVE_TAGS.map((t) => t.key);

// 会社評価基準10項目。日次の行動確認と、週次の点数で同じキーを使う
export const CRITERIA = [
  { key: "quantity",             short: "量",       label: "まず量をこなせる" },
  { key: "report_consult",       short: "報連相",   label: "自分から報告・相談できる" },
  { key: "action",               short: "行動",     label: "考えるだけで終わらず、行動する" },
  { key: "self_learning",        short: "学習",     label: "自分で学べる" },
  { key: "consistency",          short: "期限",     label: "モチベーションに左右されない" },
  { key: "results",              short: "成果",     label: "努力ではなく成果を見る" },
  { key: "feedback_improvement", short: "改善",     label: "フィードバックを改善につなげる" },
  { key: "forward_thinking",     short: "前進",     label: "論破より前進を選ぶ" },
  { key: "team_attitude",        short: "チーム",   label: "周囲の空気を悪くしない" },
  { key: "customer_focus",       short: "顧客",     label: "顧客と向き合える" },
];

const text = (v, max = 2000) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

const num = (v) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 配列項目は「必須の列が空の行」を落とす。空行が残ると、あとで数えたときに嘘になる */
function rows(v, pick, required, limit = 10) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const r of v.slice(0, limit)) {
    if (!r || typeof r !== "object") continue;
    const o = {};
    for (const k of pick) o[k] = text(r[k], 500) ?? "";
    if (required.some((k) => !o[k])) continue;
    out.push(o);
  }
  return out.length ? out : null;
}

/**
 * 画面から来た日報を、tc_nippo に入れられる形にする。
 * ここを通っていない値は保存しない（列名を直接指定させない）。
 *
 * 使わなくなった旧項目（purpose / handoff / stuck / funnel / …）はここで
 * 受け取らない。列は残してあるので、過去の日報はそのまま読める。
 */
/**
 * 朝の入力。「今日成功した状態」を、結果を見る前に描く。
 *
 * ここで書けるのは3つだけ。
 *   3か月後どうなっていたいか（前日から引き継ぐ）
 *   今日の終わりに「今日は良かった」と言える状態
 *   今日やる3つの行動
 *
 * 成果（result）はここでは受け取らない。朝に結果は無い。
 */
export function normalizeMorning(body) {
  return {
    goal_image: text(body?.goalImage, 600),
    success_image: text(body?.successImage, 600),
    // 3つまで。増やすと「今日の最優先」が薄まる
    work_items: rows(body?.actions, ["task"], ["task"], 3),
    morning_at: new Date().toISOString(),
  };
}

/** 朝の入力として意味があるか。空で「描いた」ことにしない */
export const hasMorning = (m) =>
  Boolean(m.success_image || (m.work_items || []).length);

export function normalizeNippo(body) {
  const target = num(body?.kgiTarget);
  const actual = num(body?.kgiActual);

  // 達成/未達。数字が両方そろっていれば機械的に決める。
  // 数値で測らない業務のために、画面からの指定も受ける
  let achieved = null;
  if (typeof body?.kgiAchieved === "boolean") achieved = body.kgiAchieved;
  else if (target !== null && actual !== null) achieved = actual >= target;

  return {
    mood: MOODS.includes(body?.mood) ? body.mood : "順調",

    // ① 今日のKGI
    goal_today: text(body?.kgi),
    kgi_target: target,
    kgi_actual: actual,
    kgi_achieved: achieved,

    // ① 3か月後どうなっていたいか（本人の言葉）。前日から引き継ぐ
    goal_image: text(body?.goalImage, 600),

    // ② 今日の終わりに「今日は良かった」と言える状態。
    //    朝に書いたものを、夜はそのまま持ち回るだけ。書き直させない
    success_image: text(body?.successImage, 600),

    // ③④ 今日やる3つと、実際にできたこと。
    //     朝に task を書き、夜に result を埋める。
    //     朝に描いていない日もあるので、結果だけの行も受ける
    work_items: rows(body?.workItems, ["task", "result"], ["task"], 8),

    // 朝に描いた状態になれたか
    success_met: MET_KEYS.includes(body?.successMet) ? body.successMet : null,

    // ③ 困ったこと・報告相談。次の行動が空の行は落とす
    no_issues: !!body?.noIssues,
    issues: body?.noIssues
      ? null
      : rows(body?.issues, ["issue", "action_taken", "consulted", "next_action"],
             ["issue", "next_action"], 5),

    // ④ 今日の改善・学び
    improve_tags: Array.isArray(body?.improveTags)
      ? body.improveTags.filter((t) => TAG_KEYS.includes(t)).slice(0, 6)
      : null,
    challenge: text(body?.improveNote),

    // ⑤ 顧客・チームのためにしたこと
    contribution: text(body?.contribution, 600),

    // ⑤ 明日変えること。やり方をどう変えるか
    tomorrow_change: text(body?.tomorrowChange, 600),

    // ⑥ 明日の最優先。何をやるか
    tomorrow_plan: text(body?.tomorrowPlan),
    tomorrow_deadline: text(body?.tomorrowDeadline, 100),
    tomorrow_target: text(body?.tomorrowTarget, 300),
  };
}

/** 出したかどうかの最低ライン。全部空の日報を「提出済み」にしない */
export function hasContent(n) {
  return Boolean(
    n.goal_today || n.work_items || n.tomorrow_plan || n.contribution ||
    n.challenge || (n.improve_tags || []).length || n.issues ||
    n.success_image || n.success_met || n.tomorrow_change,
  );
}

/**
 * 今日の日報から「確認できた行動」を拾う。
 *
 * ★ これは人事評価の点数ではない。
 *   本人に毎日10項目を自己採点させると、点を取りにいく書き方になる。
 *   書いた内容から機械的に拾って、行動を意識してもらうためだけに出す。
 *   週次の点数は、これとは別に管理者が付ける。
 *
 * 判定は「書いてあるか」だけで決める。中身の質は見ない。
 * AIに読ませて質まで判定させると、書き方の上手さが点になってしまう。
 *
 * @returns {Record<string, "o"|"d"|"-">} o=確認できた / d=一部 / -=材料なし
 */
export function evaluateDaily(n) {
  const items = n.work_items || [];
  const issues = n.issues || [];
  const tags = n.improve_tags || [];
  const has = (...keys) => keys.some((k) => tags.includes(k));

  const f = {};

  // ① 量：KGIの実績が目標に届いたか、成果の行がいくつあるか
  f.quantity =
    n.kgi_achieved === true || items.length >= 3 ? "o"
    : items.length >= 1 ? "d"
    : "-";

  // ② 報連相：困りごとを出したうえで、誰に相談したかまで書けているか。
  //   「特になし」は材料なし。相談しなかったことを減点にはしない
  f.report_consult =
    issues.some((i) => i.consulted) ? "o"
    : issues.length ? "d"
    : "-";

  // ③ 行動：やったことに結果が伴っているか、困りごとに自分の手が入っているか
  f.action =
    items.length && (items.every((i) => i.result) || issues.some((i) => i.action_taken)) ? "o"
    : items.length ? "d"
    : "-";

  // ④ 学習：自分で調べる・試す・道具を使う
  f.self_learning =
    has("self_research", "new_method", "ai_tool") ? "o"
    : tags.length ? "d"
    : "-";

  // ⑤ 期限：明日の最優先に、期限か完了条件まで入っているか
  f.consistency =
    n.tomorrow_plan && (n.tomorrow_deadline || n.tomorrow_target) ? "o"
    : n.tomorrow_plan ? "d"
    : "-";

  // ⑥ 成果：結果まで書けている行があるか、KGIの実績が入っているか
  f.results =
    items.filter((i) => i.result).length >= 2 || n.kgi_actual !== null ? "o"
    : items.some((i) => i.result) ? "d"
    : "-";

  // ⑦ 改善：指摘を反映した・やり方を変えた
  f.feedback_improvement =
    has("feedback", "process") ? "o"
    : n.challenge ? "d"
    : "-";

  // ⑧ 前進：困りごとに「次にどうするか」まで書けているか
  f.forward_thinking =
    issues.length && issues.every((i) => i.next_action) ? "o"
    : issues.length ? "d"
    : n.no_issues ? "-"
    : "-";

  // ⑨ チーム／⑩ 顧客：⑤の記述から拾う。
  //   どちらの話かは言葉で見分けるしかないので、当てはまらなければ両方 d にする。
  //   ここで無理に○を付けると、書けば付く項目になってしまう
  const c = n.contribution || "";
  if (!c) {
    f.team_attitude = "-";
    f.customer_focus = "-";
  } else {
    const customer = /顧客|お客|クライアント|取引先|先方|ユーザー|エンドユーザ/.test(c);
    const team = /チーム|同僚|メンバー|社内|部署|後輩|先輩|さん/.test(c);
    f.team_attitude = team ? "o" : "d";
    f.customer_focus = customer ? "o" : "d";
  }

  return f;
}

/** ○ の数。画面の見出しに出す */
export const countConfirmed = (flags) =>
  Object.values(flags || {}).filter((v) => v === "o").length;

/**
 * AI自動返信を頼む。
 * 本文は送らない（Edge Function が DB から読む）。保存された日報と
 * AIが読んだ内容が食い違わないようにするため。
 * AI が落ちていても日報の保存はもう終わっているので、ここは例外を外に出さない。
 */
export async function requestAiReply(nippoId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { ok: false, reason: "not_configured" };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(`${url}/functions/v1/nippo-ai-reply`, {
      method: "POST",
      signal: ac.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, apikey: key },
      body: JSON.stringify({ mode: "auto", nippo_id: nippoId }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) return { ok: false, reason: `http_${r.status}` };
    if (data.error) return { ok: false, reason: String(data.error) };
    if (data.status === "disabled") return { ok: false, reason: "disabled" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e?.name === "AbortError" ? "timeout" : String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
