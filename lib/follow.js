// 要フォローの抽出と、ランキング。
//
// ■ 何のためか
//   管理者が全員の日報を読まなくて済むようにする。
//   読むのは「異常・相談・停滞」だけにして、あとは数字で見る。
//
// ■ 出す条件（この3つだけ）
//   ・KPIが3営業日続けて未達
//   ・困りごとに相談相手が書かれている（＝返事を待っている）
//   ・日報が2営業日続けて未提出
//
//   条件を増やすと全員が要フォローになり、結局また全部読むことになる。
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
export function findFollowUps({ date, staff, nippos, kpis }) {
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

  return [...byUser.values()]
    .filter((u) => u.reasons.length)
    // 相談は返事を待っているので先に出す。次に停滞、最後に未提出
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "ja"));
}

const ORDER = { consult: 0, kpi_miss: 1, not_submitted: 2 };
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
