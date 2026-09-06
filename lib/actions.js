// 「次にやること」と KPI。ダッシュボードと日報をつなぐところ。
//
// ■ 何を解決するための仕組みか
//   日報を書いて終わりにしない。
//     日報の困りごと・AIの改善提案
//       → 次にやること（gw_action_items）ができる
//       → 翌日のダッシュボードの一番上に出る
//       → 本人が実行する
//       → 翌日の日報で「実施済み」にする
//       → 閉じる
//   この循環が回らないなら、AIに評価させる意味がない。
//
// ■ 一番上に出すのはひとつだけ
//   「今日やること」が5つ並んでいる画面は、結局どれもやらない。
//   priority = 1 のものだけを大きく出し、残りはその下に小さく並べる。
//   DBにも「1人1日ひとつ」の制約を置いてある（db/030）。
//
// ■ 目標は本人が毎朝決めない
//   KPI の target は事前に決めておき、本人は実績（actual）だけ入れる。
//   毎朝本人が目標も決める形にすると、日報が目標設定の場になり、
//   数字が後から都合よく動く。
//
// ■ 消さない
//   やらないと決めたもの（dropped）も残す。判断も記録のうちで、
//   「AIの提案がどれくらい実行されたか」を後から見るのに要る。

import { kpiProgress, dailyShare } from "./growth.js";

const TITLE_MAX = 200;
const DETAIL_MAX = 2000;

export const SOURCE_LABEL = { ai: "AIの提案", self: "自分で決めた", manager: "上司から" };
export const STATUS_LABEL = { open: "未着手", done: "実施済み", dropped: "やらない" };

const cut = (v, n) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, n) : null;
};

/** 土日を飛ばした翌営業日。金曜の日報から生まれた宿題を土曜に出さない */
export function nextWorkday(date) {
  const d = new Date(`${date}T00:00:00Z`);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/**
 * 日報とそのAI評価から、翌営業日の「次にやること」を作る。
 *
 * 優先順位の考え方
 *   1 … 本人が「明日の最優先」に書いたもの。本人が決めたことを一番上にする
 *   3 … AIの明日のアドバイス
 *   5 … AIの改善点（最大2件まで。並べすぎると全部やらなくなる）
 *
 * 同じ日に同じ題のものは作らない。再採点のたびに増えていくため。
 *
 * @returns {Array} insert する行の配列（呼び出し側で入れる）
 */
export function planFromNippo({ nippo, evaluation, dueDate }) {
  const due = dueDate || nextWorkday(nippo.work_date);
  const rows = [];
  const seen = new Set();

  const add = (title, opts) => {
    const t = cut(title, TITLE_MAX);
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    rows.push({
      user_id: nippo.user_id,
      title: t,
      due_date: due,
      from_nippo_id: nippo.id,
      ...opts,
    });
  };

  // 本人が書いた「明日の最優先」。期限や完了条件があれば detail に添える
  if (nippo.tomorrow_plan) {
    add(nippo.tomorrow_plan, {
      source: "self",
      priority: 1,
      detail: cut([nippo.tomorrow_deadline, nippo.tomorrow_target].filter(Boolean).join(" / "), DETAIL_MAX),
      created_by: nippo.user_id,
    });
  }

  if (evaluation) {
    if (evaluation.tomorrow_advice) {
      add(evaluation.tomorrow_advice, {
        source: "ai",
        // 本人が最優先を書いていなければ、AIの提案を一番上にする
        priority: nippo.tomorrow_plan ? 3 : 1,
        from_eval_id: evaluation.id,
      });
    }
    for (const p of (evaluation.improvement_points || []).slice(0, 2)) {
      add(p, { source: "ai", priority: 5, from_eval_id: evaluation.id });
    }
  }

  return rows;
}

/**
 * 作った「次にやること」を入れる。
 *
 * 二度作らない。日報は提出のときに1回、AI評価が終わったときにもう1回通るし、
 * 再採点すればまた通る。そのたびに宿題が増えると、画面が埋まって
 * 本来の最優先が埋もれる。
 *
 * 出どころ（self / ai）ごとに見る。提出時に本人ぶんを入れ、
 * 評価が終わってからAIぶんを足す、という順番で通るため。
 * 題が同じものも作らない。
 */
export async function savePlan(sb, rows, nippoId) {
  if (!rows.length) return { created: 0, skipped: 0 };

  const { data: exists } = await sb
    .from("gw_action_items").select("source, title").eq("from_nippo_id", nippoId);

  const doneSources = new Set((exists || []).map((e) => e.source));
  const doneTitles = new Set((exists || []).map((e) => String(e.title).toLowerCase()));

  const fresh = rows.filter((r) =>
    !doneSources.has(r.source) && !doneTitles.has(String(r.title).toLowerCase()));
  if (!fresh.length) return { created: 0, skipped: rows.length };

  // priority = 1 はその日ひとつだけ（DBの一意制約）。
  // 別の日報から既に入っていれば、こちらは2番手に落とす
  const top = fresh.find((r) => r.priority === 1);
  if (top) {
    const { data: taken } = await sb
      .from("gw_action_items").select("id")
      .eq("user_id", top.user_id).eq("due_date", top.due_date)
      .eq("priority", 1).eq("status", "open").limit(1);
    if (taken?.length) top.priority = 2;
  }

  const { data, error } = await sb.from("gw_action_items").insert(fresh).select("id");
  if (error) throw new Error(error.message);
  return { created: data?.length || 0, skipped: rows.length - fresh.length };
}

/**
 * 日報を出したときに、前日ぶんの宿題を閉じる。
 *
 * 本人が日報の中で「やった」を選んだものだけ閉じる。
 * 文章から自動で判定はしない。読み違えて勝手に閉じるほうが害が大きい。
 */
export async function closeItems(sb, { userId, ids, nippoId, note }) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return 0;

  const { data, error } = await sb.from("gw_action_items")
    .update({
      status: "done",
      done_nippo_id: nippoId || null,
      done_note: cut(note, DETAIL_MAX),
      done_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    // 他人のものを閉じられないよう、user_id でも絞る。
    // tc_* と違いこの表は API しか書けないが、id は画面から来る値なので確認する
    .eq("user_id", userId).eq("status", "open").in("id", list)
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length || 0;
}

// -----------------------------------------------------------------------------
// KPI
// -----------------------------------------------------------------------------

/**
 * その日のKPIが無ければ、雛形（gw_kpi_templates）から作る。
 * 無ければ前営業日ぶんを写す。
 *
 * 目標だけ作り、実績は空のままにする。実績は本人が日報で入れる。
 */
export async function ensureKpis(sb, userId, date) {
  const { data: today } = await sb
    .from("gw_daily_kpis").select("*")
    .eq("user_id", userId).eq("work_date", date).order("sort_order");
  if (today?.length) return today;

  // 3か月育成計画があるなら、そこから降ろす。
  // 月の目標を残りの営業日で割った数が、その日の目標になる。
  // 計画がある人に、別に決めた雛形のKPIを出すと二重管理になる
  const fromPlan = await kpisFromPlan(sb, userId, date);
  if (fromPlan.length) {
    const { data, error } = await sb.from("gw_daily_kpis")
      .upsert(fromPlan, { onConflict: "user_id,work_date,label" }).select("*");
    if (error) throw new Error(error.message);
    return (data || []).sort((a, b) => a.sort_order - b.sort_order);
  }

  const { data: tpl } = await sb
    .from("gw_kpi_templates").select("*")
    .eq("user_id", userId).eq("active", true).order("sort_order");

  let rows = (tpl || []).map((t) => ({
    user_id: userId, work_date: date, sort_order: t.sort_order,
    label: t.label, unit: t.unit, target: t.target, source: "template",
  }));

  if (!rows.length) {
    // 雛形が無ければ、直近に設定のあった日を写す
    const { data: prev } = await sb
      .from("gw_daily_kpis").select("*")
      .eq("user_id", userId).lt("work_date", date)
      .order("work_date", { ascending: false }).limit(10);
    const lastDate = prev?.[0]?.work_date;
    rows = (prev || []).filter((p) => p.work_date === lastDate).map((p) => ({
      user_id: userId, work_date: date, sort_order: p.sort_order,
      label: p.label, unit: p.unit, target: p.target, source: "continued",
    }));
  }

  if (!rows.length) return [];

  // 画面に出すのは3〜5個まで。並べすぎるとどれも追わなくなる
  const { data, error } = await sb.from("gw_daily_kpis")
    .upsert(rows.slice(0, 5), { onConflict: "user_id,work_date,label" }).select("*");
  if (error) throw new Error(error.message);
  return (data || []).sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * 3か月育成計画の、その月のKPIから今日のぶんを作る。
 *
 * 「月に20件」を毎日20件と出しても意味がないので、
 * 残りの目標を残りの営業日で割る。ずれたぶんは翌日に自動で乗る。
 *
 * 日割りできない型（達成率・評価点・ON/OFF）は、月の目標をそのまま出す。
 * その日どこまで来ているかを見せるのが目的で、日々の割り当てではない。
 *
 * 確定していない計画（status = 'draft'）は降ろさない。
 * 相談中の目標が本人の画面に出ると、決まったものとして受け取られる。
 */
async function kpisFromPlan(sb, userId, date) {
  const month = `${String(date).slice(0, 7)}-01`;

  // maybeSingle は2件返ると例外になる。ここが落ちるとホーム画面ごと開かなくなるので、
  // 「同じ月に有効な計画が2つある」ような状態でも、先頭を使って動かす
  const { data: rows } = await sb.from("gw_growth_months")
    .select("id, gw_growth_plans!inner(id, status, user_id)")
    .eq("user_id", userId).eq("month", month)
    .eq("gw_growth_plans.status", "active").limit(1);
  const m = rows?.[0];
  if (!m) return [];

  const { data: kpis } = await sb.from("gw_growth_kpis").select("*")
    .eq("month_id", m.id).eq("from_daily", true).order("sort_order");
  if (!kpis?.length) return [];

  // その月にすでに積み上がっているぶん
  const ids = kpis.map((k) => k.id);
  const { data: done } = await sb.from("gw_daily_kpis")
    .select("kpi_id, work_date, actual")
    .in("kpi_id", ids).gte("work_date", month).lt("work_date", date).limit(2000);

  // 同じ名前のKPIが2つあると、upsert が
  // 「1回の文で同じ行を2度は触れない」で落ちる。先に名前で重複を落とす
  const seen = new Set();
  const uniq = kpis.filter((k) => {
    const key = String(k.name).trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return uniq.slice(0, 5).map((k, i) => {
    const p = kpiProgress(k, (done || []).filter((d) => d.kpi_id === k.id));
    const share = dailyShare(k, p, date);
    return {
      user_id: userId,
      work_date: date,
      sort_order: i,
      label: k.name,
      unit: k.unit,
      // 日割りできない型は、月の目標をそのまま出す
      target: share == null ? k.target_value : share,
      kpi_id: k.id,
      source: "plan",
    };
  });
}

/** 達成率。目標が入っていないものは分母に入れない */
export function kpiRate(kpis) {
  const withTarget = (kpis || []).filter((k) => Number(k.target) > 0);
  if (!withTarget.length) return null;
  const hit = withTarget.filter((k) => Number(k.actual) >= Number(k.target)).length;
  return { hit, of: withTarget.length, rate: Math.round((hit / withTarget.length) * 100) };
}

export const shapeKpi = (k) => ({
  id: k.id, label: k.label, unit: k.unit,
  // 3か月計画から降りてきたものは、目標を本人が変えられない
  kpiId: k.kpi_id || null,
  target: k.target == null ? null : Number(k.target),
  actual: k.actual == null ? null : Number(k.actual),
  sortOrder: k.sort_order, source: k.source,
});

export const shapeItem = (a) => ({
  id: a.id, title: a.title, detail: a.detail,
  source: a.source, sourceLabel: SOURCE_LABEL[a.source] || a.source,
  status: a.status, priority: a.priority, dueDate: a.due_date,
  fromNippoId: a.from_nippo_id, doneAt: a.done_at, doneNote: a.done_note,
  createdAt: a.created_at,
});
