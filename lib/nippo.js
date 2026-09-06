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

/**
 * その週の、その人の最終勤務日。
 *
 * ■ 何に使うか
 *   週の振り返りを、毎日出すのはうるさい。最終日にだけ出す。
 *   そしてその日は、振り返りを書かないと日報を出せないようにする
 *   （api/nippo/index.js の submit）。
 *   週の終わりに一度も立ち止まらないまま、次の週が始まるのを防ぐ。
 *
 * ■ 曜日は人ごと
 *   gw_reminder_prefs.workdays（1=月 … 7=日）。既定は平日。
 *   火〜木だけの人に金曜を求めても、その日は出勤していない。
 *
 * @param {string} weekStart 月曜（YYYY-MM-DD）
 * @param {number[]} workdays 1=月 … 7=日
 * @returns {string} YYYY-MM-DD
 */
export function lastWorkdayOfWeek(weekStart, workdays) {
  const days = (Array.isArray(workdays) && workdays.length ? workdays : [1, 2, 3, 4, 5])
    .map(Number).filter((d) => d >= 1 && d <= 7);
  const last = Math.max(...days);
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (last - 1));   // 月曜が 1
  return d.toISOString().slice(0, 10);
}

/** 週の振り返りが書かれているか。4つの問いのどれかが埋まっていればよい */
export const weeklyFilled = (w) =>
  Boolean(w && [w.q1, w.q2, w.q3, w.q4].some((v) => String(v || "").trim()));

export const MOODS = ["順調", "普通", "苦戦"];

// 朝に描いた状態になれたか。036で日報から外した。
// 過去（034〜036）の日報を画面に出すときの表示用に残してある
export const SUCCESS_MET = [
  { key: "o", label: "なれた",     mark: "○" },
  { key: "d", label: "途中まで",   mark: "△" },
  { key: "x", label: "ならなかった", mark: "×" },
];
// 改善・学びの選択肢。036で日報から外した。
// 過去の日報を画面に出すときの表示用に残してある
export const IMPROVE_TAGS = [
  { key: "self_research", label: "自分で調べた" },
  { key: "new_method",    label: "新しい方法を試した" },
  { key: "feedback",      label: "フィードバックを反映した" },
  { key: "process",       label: "仕事のやり方を改善した" },
  { key: "ai_tool",       label: "AI・ツールを活用した" },
  { key: "other",         label: "その他" },
];
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
 * やること3件。朝と夜で書く場所が違うので、専用にそろえる。
 *
 *   朝（行動案から）  task / target / unit / done_when
 *   夜（本人が入れる） result か undone_reason ／ actual（実績の数値）
 *
 * 汎用の rows() を使わないのは、target と actual を数値のまま残したいため。
 * 文字にしてしまうと、達成率の計算で毎回戻すことになる
 */
function workItems(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const r of v.slice(0, 3)) {
    if (!r || typeof r !== "object") continue;
    const task = text(r.task, 500);
    if (!task) continue;
    out.push({
      task,
      target: num(r.target),
      unit: text(r.unit, 10) ?? "",
      done_when: text(r.done_when, 500) ?? "",
      result: text(r.result, 500) ?? "",
      undone_reason: text(r.undone_reason, 500) ?? "",
      actual: num(r.actual),
    });
  }
  return out.length ? out : null;
}

/**
 * 画面から来た日報を、tc_nippo に入れられる形にする。
 * ここを通っていない値は保存しない（列名を直接指定させない）。
 *
 * ■ 朝4つ・夜5つに絞ってある
 *     朝  今日の最優先 / 今日やること（最大3件） / 今日のKPI / 困っていること
 *     夜  今日できたこと / KPI実績 / 未完了と理由 / 明日やること / 相談事項
 *
 *   毎日書くものは、書ける量でなければ続かない。
 *   朝1分・夜2〜3分で終わることを、項目数の上限にしている。
 *
 *   使わなくなった旧項目（3か月後の像・今日成功した状態・改善と学びのタグ・
 *   顧客とチームのためにしたこと・明日変えること・purpose / handoff / …）は
 *   ここで受け取らない。列は残してあるので、過去の日報はそのまま読める。
 */

/**
 * 朝の入力。今日を何で判断するかを、始める前に決める。
 *
 * 成果（result）はここでは受け取らない。朝に結果は無い。
 */
export function normalizeMorning(body) {
  return {
    // 今日の最優先。1つだけ。2つ書けるようにすると最優先ではなくなる
    top_priority: text(body?.topPriority, 300),
    // 3件まで。増やすと最優先が薄まる
    work_items: rows(body?.actions, ["task"], ["task"], 3),
    // 今日のKPI。目標を持っている人だけ出る欄なので、空でも普通
    goal_today: text(body?.kpiName, 200),
    kgi_target: num(body?.kpiTarget),
    // 朝の時点で困っていること（任意）
    morning_note: text(body?.morningNote, 600),
    morning_at: new Date().toISOString(),
  };
}

/** 朝の入力として意味があるか。空で「書いた」ことにしない */
export const hasMorning = (m) =>
  Boolean(m.top_priority || (m.work_items || []).length);

export function normalizeNippo(body) {
  const target = num(body?.kpiTarget);
  const actual = num(body?.kpiActual);

  // 達成/未達。数字が両方そろっていれば機械的に決める。
  // 数値で測らない業務のために、画面からの指定も受ける
  let achieved = null;
  if (typeof body?.kgiAchieved === "boolean") achieved = body.kgiAchieved;
  else if (target !== null && actual !== null) achieved = actual >= target;

  return {
    // 今日の最優先。朝に書いたものを持ち回る
    top_priority: text(body?.topPriority, 300),

    // 今日のKPI（対象者のみ）
    goal_today: text(body?.kpiName, 200),
    kgi_target: target,
    kgi_actual: actual,
    kgi_achieved: achieved,

    // 今日できたこと ＋ 未完了と理由。
    //   朝に task を書き、夜に result（できたこと）か
    //   undone_reason（できなかった理由）のどちらかを埋める。
    //   未完了の欄を別に作らず、ここで両方そろえる
    //   朝の案から来た target / unit / done_when と、夜に入れる actual も残す
    work_items: workItems(body?.workItems),

    // 相談事項（任意）。本人と管理者だけが見る。みんなの日報には出さない
    consult_note: text(body?.consultNote, 1000),

    // 明日やること
    tomorrow_plan: text(body?.tomorrowPlan),
  };
}

/** 出したかどうかの最低ライン。全部空の日報を「提出済み」にしない */
export function hasContent(n) {
  const done = (n.work_items || []).some((w) => w.result || w.undone_reason);
  return Boolean(done || n.kgi_actual !== null || n.tomorrow_plan || n.consult_note);
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
  const done = items.filter((i) => i.result);
  const undone = items.filter((i) => !i.result && i.undone_reason);
  // 旧形式（036より前）の日報も同じ関数で見る。困りごとの行があればそれを使う
  const issues = (n.issues || []).filter((i) => i.issue);
  const spoke = Boolean(n.consult_note || n.morning_note || issues.length);

  const f = {};

  // ① 量：KPIの実績が目標に届いたか、やることをいくつ終えたか
  f.quantity =
    n.kgi_achieved === true || done.length >= 3 ? "o"
    : done.length >= 1 ? "d"
    : "-";

  // ② 報連相：詰まったことを、その日のうちに言葉にできたか。
  //   詰まらなかった日は材料なし。相談しなかったことを減点にはしない
  f.report_consult =
    spoke ? "o"
    : undone.length ? "d"      // 未完了はあるが、何も書いていない
    : "-";

  // ③ 行動：朝に決めたことに、結果か理由が付いているか
  f.action =
    items.length && items.every((i) => i.result || i.undone_reason) ? "o"
    : done.length ? "d"
    : "-";

  // ④ 学習：日報からは機械的に判定しない。
  //   「学んだか」は書かれた文章を読まないと分からないので、AI評価に任せる。
  //   ここで無理に判定すると、書けば付く項目になってしまう
  f.self_learning = "-";

  // ⑤ 期限：明日やることを、その日のうちに決められたか
  f.consistency =
    n.tomorrow_plan && n.top_priority ? "o"
    : n.tomorrow_plan ? "d"
    : "-";

  // ⑥ 成果：結果まで書けている行があるか、KPIの実績が入っているか
  f.results =
    done.length >= 2 || n.kgi_actual !== null ? "o"
    : done.length ? "d"
    : "-";

  // ⑦ 改善：できなかったことに理由を書き、明日につないでいるか
  f.feedback_improvement =
    undone.length && n.tomorrow_plan ? "o"
    : undone.length ? "d"
    : "-";

  // ⑧ 前進：詰まったことを言葉にしたうえで、明日やることまで決めているか
  f.forward_thinking =
    undone.length && spoke && n.tomorrow_plan ? "o"
    : undone.length && n.tomorrow_plan ? "d"
    : "-";

  // ⑨ チーム／⑩ 顧客：日報の項目を絞ったので、ここでは判定しない。
  //   文章を読まないと分からないものは、AI評価が点を付ける
  f.team_attitude = "-";
  f.customer_focus = "-";

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
