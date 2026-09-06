// 要フォローの抽出と、ランキング。
//
// ■ 何のためか
//   管理者が全員の日報を読まなくて済むようにする。
//   読むのは「異常・相談・停滞」だけにして、あとは数字で見る。
//
// ■ 出す条件
//   ・Blockerが3営業日を超えて外れていない（§24。外すのが管理職の仕事）
//   ・困りごとに相談相手が書かれている（＝返事を待っている）
//   ・KPIが3営業日続けて未達
//   ・決めた次の行動が期限を過ぎて放置されている
//   ・行動量が前の週から大きく落ちている
//   ・日報が2営業日続けて未提出
//
//   要件定義 §22 にはもう2つ（自走レベル停滞・同じ課題の繰り返し）があるが、
//   前者はレベルの運用が始まってからでないと「停滞」の線が引けず、
//   後者は文言の一致では拾えない（同じ問題を別の言葉で書くため）。
//   誤検知で人を呼び出すほうが害が大きいので、いまは入れていない。
//
//   条件を増やすほど全員が要フォローになり、結局また全部読むことになる。
//   ここに出す＝人を呼ぶ、なので、迷ったら出さない。
//
// ■ ランキングについて（社内の評価の考え方）
//   「頑張っている人ランキング」は作らない。
//   残業時間・日報の文字数・AIとの会話量は数えない。
//   長く働いた人・長く書いた人が上に来る仕組みにしない。
//
//   出すのは 成果 / 行動 / 改善 / 成長 / 顧客価値 の5つ。
//   どれも「何を前に進めたか」から出る数字にする。

/** 平日だけの日付を、新しい順に n 日ぶん */
export function recentWorkdays(date, n) {
  const out = [];
  const d = new Date(`${date}T00:00:00Z`);
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

/**
 * 要フォローを抽出する。
 *
 * @param {object} p
 * @param {string} p.date            対象日
 * @param {Array}  p.staff           名簿（user_id, display_name）
 * @param {Array}  p.nippos          直近ぶんの日報
 * @param {Array}  p.kpis            直近ぶんの gw_daily_kpis
 * @returns {Array} 出す人だけ。理由付き
 */
export function findFollowUps({ date, staff, nippos, kpis, blockers = [], items = [] }) {
  const days = recentWorkdays(date, 3);
  const [d0, d1, d2] = days;

  const byUser = new Map();
  for (const e of staff) {
    byUser.set(e.user_id, { userId: e.user_id, name: e.display_name, reasons: [] });
  }

  // --- 日報の未提出。2営業日続けて出ていない ---
  const submitted = new Set(nippos.map((n) => `${n.user_id}|${n.work_date}`));
  for (const e of staff) {
    // 当日ぶんは、まだ書く時間が残っているので数えない。前の2日で見る
    if (!submitted.has(`${e.user_id}|${d1}`) && !submitted.has(`${e.user_id}|${d2}`)) {
      byUser.get(e.user_id).reasons.push({
        kind: "not_submitted",
        label: "日報未提出2日",
        detail: `${d2}・${d1} の日報がありません`,
      });
    }
  }

  // --- KPIが3営業日続けて未達 ---
  const kpiByDay = new Map();   // user|date -> {hit, of}
  for (const k of kpis) {
    if (!(Number(k.target) > 0)) continue;
    const key = `${k.user_id}|${k.work_date}`;
    const cur = kpiByDay.get(key) || { hit: 0, of: 0 };
    cur.of++;
    if (Number(k.actual) >= Number(k.target)) cur.hit++;
    kpiByDay.set(key, cur);
  }
  for (const e of staff) {
    // 3日とも「目標があって、1つも達成していない」場合だけ出す。
    // 目標が入っていない日は判断材料が無いので、連続とは見ない
    const rows = days.map((d) => kpiByDay.get(`${e.user_id}|${d}`));
    if (rows.every((r) => r && r.of > 0 && r.hit === 0)) {
      byUser.get(e.user_id).reasons.push({
        kind: "kpi_miss",
        label: "3日連続KPI未達",
        detail: `${d2}〜${d0} のKPIがすべて未達です`,
      });
    }
  }

  // --- 相談あり。返事を待っている人を埋もれさせない ---
  for (const n of nippos) {
    if (n.work_date !== d0 || n.no_issues) continue;
    const waiting = (n.issues || []).filter((i) => i.issue && i.consulted);
    if (!waiting.length) continue;
    const u = byUser.get(n.user_id);
    if (!u) continue;
    u.reasons.push({
      kind: "consult",
      label: "相談あり",
      detail: waiting.map((i) => i.issue).join(" / ").slice(0, 200),
    });
  }

  // --- 長く止まっている仕事。外すのが管理職の仕事（§24） ---
  for (const b of blockers) {
    if (b.status !== "open") continue;
    const stuck = daysBetween(b.blocked_since, date);
    if (stuck <= LONG_BLOCKER) continue;
    const u = byUser.get(b.user_id);
    if (!u) continue;
    u.reasons.push({
      kind: "blocker",
      label: `${stuck}日止まっている`,
      detail: `${b.title}（${b.escalation_level > 0 ? "相談済み" : "まだ本人が抱えている"}）`,
    });
  }

  // --- 決めた次の行動が、期限を過ぎて放置されている ---
  const stale = new Map();
  for (const i of items) {
    if (i.status !== "open" || !i.due_date || i.due_date >= d0) continue;
    stale.set(i.user_id, (stale.get(i.user_id) || 0) + 1);
  }
  for (const [uid, n] of stale) {
    if (n < 3) continue;   // 1〜2件は、その日にやれなかっただけのことがある
    const u = byUser.get(uid);
    if (!u) continue;
    u.reasons.push({
      kind: "stale",
      label: "やりかけの放置",
      detail: `期限を過ぎたまま開いている「次にやること」が ${n} 件あります`,
    });
  }

  // --- 行動量が前の週から大きく落ちている ---
  // 量そのものを評価するわけではない。急に止まったことが分かればよい
  const thisWeek = recentWorkdays(date, 5);
  const prevWeek = recentWorkdays(thisWeek[4], 6).slice(1);
  const count = (uid, list) => nippos
    .filter((n) => n.user_id === uid && list.includes(n.work_date))
    .reduce((a, n) => a + (n.work_items || []).length, 0);

  for (const e of staff) {
    const now = count(e.user_id, thisWeek);
    const before = count(e.user_id, prevWeek);
    // 前の週にある程度の量があった人だけ見る。元から少ない人を呼び出さない
    if (before < 5) continue;
    const drop = Math.round((1 - now / before) * 100);
    if (drop < 40) continue;
    byUser.get(e.user_id).reasons.push({
      kind: "slowdown",
      label: "行動量の急な低下",
      detail: `やったことの件数が前週比 ${drop}% 減っています（${before} 件 → ${now} 件）`,
    });
  }

  return [...byUser.values()]
    .filter((u) => u.reasons.length)
    // 上から順に、放っておくと損が大きいもの。
    // 止まっている仕事と相談は人を待たせているので先に出す
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "ja"));
}

/** 長く止まっている、とみなす日数。1〜2日は待っているだけのことがある */
const LONG_BLOCKER = 3;

const daysBetween = (from, to) =>
  Math.max(1, Math.round(
    (new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1);

const ORDER = {
  blocker: 0, consult: 1, kpi_miss: 2, slowdown: 3, stale: 4, not_submitted: 5,
};
const rank = (u) => Math.min(...u.reasons.map((r) => ORDER[r.kind] ?? 9));

/**
 * ランキング。単純な点数順にはしない。
 * 見るのは 成果 / 行動 / 改善 / 成長 / 顧客価値 の5つで、
 * どれも「何を前に進めたか」から出る数字。
 *
 * 残業時間・日報の文字数・AIとの会話量は数えない。
 */
export function rankings({ staff, nippos, kpis, prevNippos = [] }) {
  const per = new Map();
  for (const e of staff) {
    per.set(e.user_id, {
      userId: e.user_id, name: e.display_name,
      results: 0, actions: 0, improves: 0, customer: 0, days: 0,
    });
  }

  for (const n of nippos) {
    const u = per.get(n.user_id);
    if (!u) continue;
    u.days++;
    const items = n.work_items || [];
    // 成果 … 結果まで書けたもの。「やった」だけは数えない
    u.results += items.filter((w) => w.result).length;
    // 行動 … やったことの件数
    u.actions += items.length;
    // 改善 … やり方を変えた日
    if ((n.improve_tags || []).length) u.improves++;
    // 顧客価値 … 顧客・チームのためにしたことを書いた日
    if (n.contribution) u.customer++;
  }

  // KPI達成率
  const kpiPer = new Map();
  for (const k of kpis) {
    if (!(Number(k.target) > 0)) continue;
    const cur = kpiPer.get(k.user_id) || { hit: 0, of: 0 };
    cur.of++;
    if (Number(k.actual) >= Number(k.target)) cur.hit++;
    kpiPer.set(k.user_id, cur);
  }

  // 成長 … 前の期間と比べた「結果まで書けた件数」の差。
  // 絶対値ではなく伸びを見るので、量の多い職種が常に上に来ることがない
  const prevResults = new Map();
  for (const n of prevNippos) {
    const c = prevResults.get(n.user_id) || 0;
    prevResults.set(n.user_id, c + (n.work_items || []).filter((w) => w.result).length);
  }

  const list = [...per.values()].map((u) => {
    const k = kpiPer.get(u.userId);
    const prev = prevResults.get(u.userId) ?? null;
    return {
      ...u,
      kpiRate: k ? Math.round((k.hit / k.of) * 100) : null,
      kpiHit: k?.hit ?? null, kpiOf: k?.of ?? null,
      growth: prev != null ? u.results - prev : null,
    };
  }).filter((u) => u.days > 0);

  const top = (key, n = 5) => [...list]
    .filter((u) => u[key] != null)
    .sort((a, b) => b[key] - a[key])
    .slice(0, n);

  return {
    // §14 の5つ。順位そのものより、どこで前に進んだかを見るための並び
    results: top("results"),
    actions: top("actions"),
    improves: top("improves"),
    growth: top("growth"),
    customer: top("customer"),
    kpi: top("kpiRate"),
  };
}
