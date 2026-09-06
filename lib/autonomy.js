// 自走レベル。
//
// ■ これは何か
//   「自主的に動いてください」と一律に言わない。
//   自分で仕事を組み立てられる度合いに合わせて、裁量を段階的に増やす。
//
//     L1 指示実行型 … まず実行する。手順まで出す
//     L2 選択実行型 … 選択肢から選ぶ。AIは候補を出す
//     L3 自律実行型 … KPIから自分で次の行動を作る。AIは問いかけに回る
//     L4 自主経営型 … 目的・予算・KGIから事業を運営する。AIは口を出さない
//
// ■ 人の評価ではない
//   L1 は能力が低いという意味ではない。
//   新しく入った人は「まだ会社の仕事の進め方を知らない」だけなので、
//   全員 L1 から始まる。だから画面でも「レベルが低い」ではなく
//   「次のレベルまであと何項目」という出し方にする。
//
// ■ AIは上げ下げを決めない
//   システムは「条件を満たしたか」を数えるところまで。
//   上げる・下げるは人が押す。押した人と時刻を残す。
//   日報のAI評価・試用期間・契約更新と同じ扱い。
//
// ■ レベルはAIの話し方を変える
//   ここが一番効く。同じ日報でも、L1には手順を出し、
//   L3には「原因はどこだと思いますか」と聞く。
//   L3に手順を出すと、いつまでも自分で考えなくなる。

export const LEVELS = [
  {
    level: 1, key: "directed", label: "指示実行型",
    summary: "まず実行する",
    detail: "何をするかはシステムが具体的に出します。手順どおりに実行して、結果を記録するところまでが役割です。",
  },
  {
    level: 2, key: "selective", label: "選択実行型",
    summary: "選んで動く",
    detail: "複数のやり方から自分で選びます。AIは候補を出しますが、どれにするかは自分で決めます。",
  },
  {
    level: 3, key: "autonomous", label: "自律実行型",
    summary: "自分で考えて動く",
    detail: "KPIと期限を見て、原因と打ち手を自分で決めます。AIは答えではなく問いを返します。",
  },
  {
    level: 4, key: "managing", label: "自主経営型",
    summary: "事業を運営する",
    detail: "目的・予算・KGIから、KPI設計・役割設計・優先順位まで自分で決めます。",
  },
];

export const levelOf = (n) => LEVELS.find((l) => l.level === Number(n)) || LEVELS[0];

/**
 * 次のレベルに上がる条件（§7）。
 *
 * 期間は直近20営業日（およそ1か月）で見る。
 * 1週間だと、たまたま良かった週で上がってしまう。
 *
 * need は「その数字がいくつ以上なら条件を満たすか」。
 * 全部そろっても自動では上がらない。上げるのは人。
 */
export const CRITERIA = {
  // L1 → L2 … 決まったことを、決まったとおりに、続けられる
  2: [
    { key: "submitRate",   label: "日報を出し続けている",           need: 90, unit: "%" },
    { key: "kpiFilled",    label: "KPIの実績を入れている",           need: 90, unit: "%" },
    { key: "actionDone",   label: "決まった次の行動をやり切っている", need: 80, unit: "%" },
    { key: "consultRate",  label: "困ったときに相談できている",       need: 50, unit: "%" },
    { key: "stale",        label: "やりかけを放置していない",         need: 0,  unit: "件", max: true },
  ],
  // L2 → L3 … 自分で選び、指摘を次に反映できる
  3: [
    { key: "selfAction",   label: "次の行動を自分で決めている",       need: 60, unit: "%" },
    { key: "improveRate",  label: "やり方を変えた日がある",           need: 40, unit: "%" },
    { key: "kpiRate",      label: "KPIが達成できている",              need: 70, unit: "%" },
    { key: "issueWithPlan", label: "相談に自分の案を添えている",      need: 70, unit: "%" },
  ],
  // L3 → L4 … 人と仕組みを動かせる
  4: [
    { key: "kpiRate",      label: "KPIが安定して達成できている",      need: 85, unit: "%" },
    { key: "resultRate",   label: "やったことを成果まで書けている",   need: 80, unit: "%" },
    { key: "customerRate", label: "顧客・チームの価値から考えている", need: 60, unit: "%" },
    { key: "blockerHelp",  label: "他の人のBlockerを外している",      need: 1,  unit: "件" },
  ],
};

/**
 * 判定に使う数字を出す。全部プログラムで数える（AIには数えさせない）。
 *
 * @param {object} p
 * @param {string[]} p.workdays  対象の営業日（新しい順でも古い順でもよい）
 * @param {Array} p.nippos       その期間の日報
 * @param {Array} p.kpis         その期間の gw_daily_kpis
 * @param {Array} p.items        その期間の gw_action_items（due_date がこの期間）
 * @param {Array} p.blockers     その人が外した Blocker
 */
export function computeMetrics({ workdays, nippos, kpis, items, blockers }) {
  const days = workdays.length;
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);

  const submitted = new Set(nippos.map((n) => n.work_date));

  // KPI。目標が入っている日だけを分母にする
  const kpiDays = new Map();
  for (const k of kpis) {
    if (!(Number(k.target) > 0)) continue;
    const cur = kpiDays.get(k.work_date) || { hit: 0, of: 0, filled: 0 };
    cur.of++;
    if (k.actual != null) cur.filled++;
    if (Number(k.actual) >= Number(k.target)) cur.hit++;
    kpiDays.set(k.work_date, cur);
  }
  const kpiRows = [...kpiDays.values()];
  const kpiTotal = kpiRows.reduce((a, r) => a + r.of, 0);

  // 次にやること。期限が来たものだけを分母にする（まだ先のものは未完了ではない）
  const due = items.filter((i) => i.due_date && i.due_date <= (workdays[0] > workdays[days - 1] ? workdays[0] : workdays[days - 1]));
  const closed = due.filter((i) => i.status === "done" || i.status === "dropped");
  const selfMade = items.filter((i) => i.source === "self");

  // 困りごと。相談したか、自分の案を添えたか
  const issues = nippos.flatMap((n) => (n.no_issues ? [] : (n.issues || []).filter((i) => i.issue)));
  const consulted = issues.filter((i) => i.consulted);
  const withPlan = issues.filter((i) => i.next_action);

  const results = nippos.reduce((a, n) => a + (n.work_items || []).filter((w) => w.result).length, 0);
  const works = nippos.reduce((a, n) => a + (n.work_items || []).length, 0);

  return {
    days,
    submitted: submitted.size,
    submitRate: pct(submitted.size, days),

    kpiDays: kpiDays.size,
    kpiTotal,
    kpiFilled: pct(kpiRows.reduce((a, r) => a + r.filled, 0), kpiTotal),
    kpiRate: pct(kpiRows.reduce((a, r) => a + r.hit, 0), kpiTotal),

    actionDue: due.length,
    actionDone: pct(closed.length, due.length),
    // やりかけの放置。期限を過ぎてまだ開いているもの
    stale: due.filter((i) => i.status === "open").length,
    selfAction: pct(selfMade.length, items.length),

    issueCount: issues.length,
    consultRate: pct(consulted.length, issues.length),
    issueWithPlan: pct(withPlan.length, issues.length),

    improveRate: pct(nippos.filter((n) => (n.improve_tags || []).length).length, submitted.size),
    resultRate: pct(results, works),
    customerRate: pct(nippos.filter((n) => n.contribution).length, submitted.size),

    blockerHelp: blockers.length,
  };
}

/**
 * 次のレベルの条件を、いま満たしているかを見る。
 *
 * 材料が無い項目（null）は「まだ分からない」にする。未達にはしない。
 * 未達にすると、KPIをまだ使っていない人が永久に上がれなくなる。
 *
 * @returns {{target:number|null, checks:Array, met:number, of:number, ready:boolean}}
 */
export function checkNext(level, metrics) {
  const target = Number(level) + 1;
  const list = CRITERIA[target];
  if (!list) return { target: null, checks: [], met: 0, of: 0, ready: false };

  const checks = list.map((c) => {
    const v = metrics[c.key];
    // max:true は「これ以下ならよい」（放置件数など）
    const ok = v == null ? null : (c.max ? v <= c.need : v >= c.need);
    return { ...c, value: v, ok };
  });

  const judged = checks.filter((c) => c.ok !== null);
  const met = judged.filter((c) => c.ok).length;

  return {
    target,
    checks,
    met,
    of: checks.length,
    // 材料が全部そろっていて、全部満たしている場合だけ ready。
    // ready でも自動では上がらない。人が押す
    ready: judged.length === checks.length && met === checks.length,
  };
}

// -----------------------------------------------------------------------------
// AIの話し方（§17 §18）
// -----------------------------------------------------------------------------

/**
 * レベルごとに、AIへ渡す指示を変える。
 *
 * ここが自走レベルの一番の効きどころ。
 * L3の人に手順を出すと、いつまでも自分で考えなくなる。
 * L1の人に「原因はどこだと思いますか」と聞いても、答えようがない。
 */
export function coachingRule(level) {
  switch (Number(level)) {
    case 1:
      return [
        "【この人への返し方：LEVEL 1（指示実行型）】",
        "・明日やることは、手順まで具体的に書く（1. 2. 3. の形にしてよい）",
        "・どのファイル・どの一覧を開くか、どこに結果を書くかまで書く",
        "・できていたことを必ず1つは具体的に挙げる（何を続ければよいかが分かるように）",
        "・「自分で考えてみましょう」とは書かない。まだ判断の材料を持っていない",
      ].join("\n");
    case 2:
      return [
        "【この人への返し方：LEVEL 2（選択実行型）】",
        "・明日やることは、選べる形で2〜3個出す（例：A 対象を変える / B 文面を直す / C 件数を増やす）",
        "・それぞれ、どういうときにそれを選ぶかを一言添える",
        "・「どれか1つを選んで実行してください」で終える。答えを1つに決めない",
        "・選んだ理由を日報に書いてもらうよう促す",
      ].join("\n");
    case 3:
      return [
        "【この人への返し方：LEVEL 3（自律実行型）】",
        "・答えを全部は出さない。まず問いを返す",
        "・原因の候補を挙げるところまでにして、「どこに原因があると思いますか」で終える",
        "・数字は出す（達成率・前週比）。解釈は本人に任せる",
        "・本人が日報の中で原因まで書けているときは、その筋がどの数字と合うかだけ返す",
      ].join("\n");
    case 4:
      return [
        "【この人への返し方：LEVEL 4（自主経営型）】",
        "・行動の指示はしない。数字と、その数字から読めることだけを書く",
        "・気づいた点があれば、判断材料として短く出す。やり方は指定しない",
        "・KPIそのものが妥当かどうか、疑わしければその点だけを挙げてよい",
      ].join("\n");
    default:
      return "";
  }
}
