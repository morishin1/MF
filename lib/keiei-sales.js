// 経営ハブ（/keiei ホーム）の「10月の目標と実績」「営業ファネル」「担当者別」「停滞案件」。
//
// ■ 正本は Sales（gw_sales_*）と Tasks（gw_tasks）。ここは読むだけ
//   書き込み・写しの保存はしない（毎回数える）。目標は lib/keiei-targets.js（コード内の一時設定）。
//
// ■ 推測で数えない
//   ・有効企業・診断・本命案件・粗利・副担当は、Sales に定義・記録が無い → 「未計測／定義未決」（0 にしない）
//   ・案件（gw_sales_deals, db/116）を読めない環境では、商談・提案・契約・停滞を「取得できません」にする
//     （会社の状態から、今月の商談数を推し量らない）
//   ・案件金額は「受注額（案件金額）」。会計上の売上・粗利とは混ぜない
//
// ■ 今月の数え方（日付は日本時間）
//   接触     … 今月送信したアタック（gw_sales_approaches.sent_at が今月。送れなかったもの failed_at は除く）
//   商談     … 今月作った案件（案件は商談から始まる）
//   提案     … 今月、提案・最終調整・成約に進んだ案件（gw_sales_deal_history の段階の記録。1案件1回）
//   有料契約 … 今月の成約（won_on が今月）。受注額（案件金額）の合計も
//   停滞     … いま提案・最終調整の段階で、最後の更新（updated_at）から7日以上たっている案件

import { readAll } from "./pg-read.js";
import { UNMEASURED, UNMEASURED_SHORT } from "./keiei-targets.js";

export const STALL_DAYS = 7;
const OPEN_LATE = ["proposal", "negotiation"];
const PROPOSED = ["proposal", "negotiation", "won"];
const COMPANY_STATUS = [
  ["attacked", "アタック済"], ["clicked", "クリックあり"], ["replied", "返信あり"],
  ["meeting", "商談"], ["proposal", "提案"], ["won", "成約"], ["lost", "失注"],
];
export const SALES_LINKS = { home: "/sales/", companies: "/sales/companies.html", company: (id) => `/sales/companies.html?id=${encodeURIComponent(id)}`, tasks: "/admin-tasks.html" };

const jstDate = (ts) => (ts ? new Date(new Date(ts).getTime() + 9 * 3600000).toISOString().slice(0, 10) : null);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/** 表が無い（未適用）か。読めなかっただけ（障害）と分ける */
async function probe(sb, table) {
  try {
    const { error } = await sb.from(table).select("id").limit(1);
    if (!error) return "ok";
    return error.code === "PGRST205" || error.code === "42P01" ? "absent" : "error";
  } catch { return "error"; }
}

/**
 * Sales・Tasks の事実を読む。読めなかったものは null（0・空にしない）。
 * 案件の表が無い環境（db/116 未適用）は deals: "absent"。
 */
export async function readSalesFacts(sb, ctx, { today }) {
  const t = ctx.tenantId;
  const monthStart = `${today.slice(0, 7)}-01`;
  // 月初（日本時間 0:00）＝前日 15:00（UTC）。境目の行は、あとで日本時間の日付で月を確かめる
  const sinceUtc = new Date(Date.parse(`${monthStart}T00:00:00Z`) - 9 * 3600000).toISOString();

  const dealState = await probe(sb, "gw_sales_deals");
  const [companies, approaches, deals, history, tasks] = await Promise.all([
    // 会社：状態・担当だけ（連絡先・メモは読まない）
    readAll(() => sb.from("gw_sales_companies").select("id, name, status, owner_id, hidden_at").eq("tenant_id", t).order("id"))
      .then((r) => r || readAll(() => sb.from("gw_sales_companies").select("id, name, status, owner_id").eq("tenant_id", t).order("id"))),
    // アタック：今月送ったもの（本文・送信先は読まない）
    readAll(() => sb.from("gw_sales_approaches").select("id, employee_id, sent_at, failed_at")
      .eq("tenant_id", t).gte("sent_at", sinceUtc).order("id"))
      .then((r) => r || readAll(() => sb.from("gw_sales_approaches").select("id, employee_id, sent_at")
        .eq("tenant_id", t).gte("sent_at", sinceUtc).order("id"))),
    dealState === "ok"
      ? readAll(() => sb.from("gw_sales_deals").select("id, company_id, owner_id, title, stage, amount, won_on, created_at, updated_at")
        .eq("tenant_id", t).order("id"))
      : Promise.resolve(null),
    dealState === "ok"
      ? readAll(() => sb.from("gw_sales_deal_history").select("id, deal_id, stage, changed_at")
        .eq("tenant_id", t).gte("changed_at", sinceUtc).order("id"))
      : Promise.resolve(null),
    // タスク：終わっていないものの期限・担当だけ（題名・本文は読まない）
    readAll(() => sb.from("gw_tasks").select("id, assignee_id, due_on, status").eq("tenant_id", t).in("status", ["todo", "doing"]).order("id")),
  ]);
  return {
    companies,
    approaches,
    dealState: dealState === "ok" ? (deals ? "ok" : "error") : dealState,
    deals,
    history,
    tasks,
  };
}

/**
 * 画面に出す形にする（純粋関数）。
 * @param {{today:string, facts:object, targets:object|null, people:Array|null}} p
 *   people … 社員名簿（id・表示名・在籍）。担当者の特定に使う
 */
export function buildSales({ today, facts, targets, people }) {
  const month = today.slice(0, 7);
  const inMonth = (ts) => { const d = jstDate(ts); return Boolean(d) && d.slice(0, 7) === month; };
  const dealsOk = facts.dealState === "ok" && Array.isArray(facts.deals);
  const dealsWhy = facts.dealState === "absent" ? "案件の機能（Sales の案件・金額）が、この環境ではまだ使えません"
    : "案件を読み込めませんでした";

  // ---- 今月の実績（全社）
  const sent = facts.approaches ? facts.approaches.filter((a) => a.sent_at && !a.failed_at && inMonth(a.sent_at)) : null;
  const deals = dealsOk ? facts.deals : null;
  const created = deals ? deals.filter((d) => inMonth(d.created_at)) : null;
  const proposedIds = deals && facts.history
    ? new Set(facts.history.filter((h) => PROPOSED.includes(h.stage) && inMonth(h.changed_at)).map((h) => h.deal_id)) : null;
  const won = deals ? deals.filter((d) => d.stage === "won" && d.won_on && d.won_on.slice(0, 7) === month) : null;
  const stalled = deals ? deals.filter((d) => OPEN_LATE.includes(d.stage))
    .map((d) => ({ ...d, idle: daysBetween(jstDate(d.updated_at || d.created_at), today) }))
    .filter((d) => d.idle >= STALL_DAYS).sort((a, b) => b.idle - a.idle) : null;

  const actual = {
    contact: sent ? sent.length : null,
    meeting: created ? created.length : null,
    proposal: proposedIds ? proposedIds.size : null,
    won: won ? won.length : null,
  };
  const why = {
    contact: facts.approaches ? null : "アタックの記録を読み込めませんでした",
    meeting: deals ? null : dealsWhy,
    proposal: deals ? (facts.history ? null : "案件の段階の記録を読み込めませんでした") : dealsWhy,
    won: deals ? null : dealsWhy,
    effective: UNMEASURED.effective,
    key: UNMEASURED.key,
  };

  // ---- 目標との比較（今日時点の目安 = 目標 × 経過日数 / 月の日数）
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dayNo = Number(today.slice(8, 10));
  const paceOf = (target) => (target == null ? null : Math.round((target * dayNo) / daysInMonth));
  const funnel = (targets?.funnel || [
    { key: "contact", label: "接触", unit: "件" }, { key: "meeting", label: "商談", unit: "件" },
    { key: "proposal", label: "提案", unit: "件" }, { key: "won", label: "有料契約", unit: "件" },
  ]).map((s) => {
    const v = actual[s.key];
    const measured = v !== undefined && v !== null;
    return {
      key: s.key, label: s.label, unit: s.unit, target: s.target ?? null, pace: paceOf(s.target),
      value: measured ? v : null,
      status: measured ? "exact" : (["effective", "key"].includes(s.key) ? "undefined" : "missing"),
      reason: measured ? null : (why[s.key] || "未計測"),
      pct: measured && s.target ? Math.round((v / s.target) * 100) : null,
    };
  });
  // 転換率（となりの段階どうし。どちらかが測れなければ出さない）。計画値と並べる
  const rates = funnel.slice(1).map((cur, i) => {
    const prev = funnel[i];
    const value = cur.value != null && prev.value != null && prev.value > 0 ? Math.round((cur.value / prev.value) * 1000) / 10 : null;
    return { from: prev.label, to: cur.label, plan: targets?.plannedRates?.[cur.key] ?? null, value };
  });
  const wonAmount = won ? won.reduce((s, d) => s + (Number(d.amount) || 0), 0) : null;

  // ---- いまの会社の状態（今月分ではない。Sales の企業一覧の今の状態）
  const visible = facts.companies ? facts.companies.filter((c) => !c.hidden_at) : null;
  const snapshot = visible ? COMPANY_STATUS.map(([k, label]) => ({ key: k, label, count: visible.filter((c) => c.status === k).length })) : null;

  // ---- 担当者別（名簿の表示名に姓が含まれる、在籍中の1人だけを特定する）
  const active = (people || []).filter((p) => !["left"].includes(p.status));
  const personOf = (name) => {
    const hit = active.filter((p) => String(p.display_name || "").includes(name));
    return hit.length === 1 ? hit[0] : null;
  };
  const tasksOk = Array.isArray(facts.tasks);
  const overdue = tasksOk ? facts.tasks.filter((x) => x.due_on && x.due_on < today).length : null;
  const unassigned = tasksOk ? facts.tasks.filter((x) => !x.assignee_id).length : null;
  const mine = (rows, key, id) => (rows ? rows.filter((r) => r[key] === id) : null);
  const measureFor = (kpi, emp) => {
    const need = (v, missing) => (v == null ? { value: null, reason: missing } : { value: v });
    switch (kpi.measure) {
      case "contact": return emp ? need(mine(sent, "employee_id", emp.id)?.length, why.contact) : null;
      case "meeting": return emp ? need(mine(created, "owner_id", emp.id)?.length, dealsWhy) : null;
      case "proposal": return emp ? need(deals && proposedIds ? deals.filter((d) => d.owner_id === emp.id && proposedIds.has(d.id)).length : null, why.proposal || dealsWhy) : null;
      case "proposal_rate": {
        if (!emp) return null;
        if (!deals || !proposedIds) return { value: null, reason: why.proposal || dealsWhy };
        const m0 = created.filter((d) => d.owner_id === emp.id).length;
        const p0 = deals.filter((d) => d.owner_id === emp.id && proposedIds.has(d.id)).length;
        return m0 ? { value: Math.round((p0 / m0) * 100), note: `提案${p0}／商談${m0}` } : { value: null, reason: "今月の商談がまだありません" };
      }
      case "won": return emp ? need(mine(won, "owner_id", emp.id)?.length, dealsWhy) : null;
      case "won_all": return need(won?.length, dealsWhy);
      case "stalled_all": return need(stalled?.length, dealsWhy);
      case "tasks_overdue": return need(overdue, "タスクを読み込めませんでした");
      case "tasks_unassigned": return need(unassigned, "タスクを読み込めませんでした");
      default: return { value: null, reason: UNMEASURED[kpi.reason] || UNMEASURED.ops, short: UNMEASURED_SHORT[kpi.reason] || "未計測", unmeasured: true };
    }
  };
  const perPerson = (targets?.people || []).map((p) => {
    const emp = personOf(p.name);
    const companyWide = (k) => ["won_all", "stalled_all", "tasks_overdue", "tasks_unassigned"].includes(k);
    return {
      name: emp ? emp.display_name : p.name,
      linked: Boolean(emp),
      role: p.role,
      kpis: p.kpis.map((k) => {
        let r = measureFor(k, emp);
        if (r === null) r = { value: null, reason: "名簿で、この人を1人に特定できません（表示名を確認してください）" };
        const done = r.value != null && k.target != null
          ? (k.lowerIsBetter ? r.value <= k.target : r.value >= k.target) : null;
        return { label: k.label, unit: k.unit, target: k.target, value: r.value, reason: r.reason || null, note: r.note || null, short: r.short || null,
          unmeasured: Boolean(r.unmeasured), lowerIsBetter: Boolean(k.lowerIsBetter), done,
          pct: r.value != null && k.target && !k.lowerIsBetter && k.unit !== "%" ? Math.round((r.value / k.target) * 100) : null,
          companyWide: companyWide(k.measure) };
      }),
    };
  });

  const nameOfCompany = new Map((facts.companies || []).map((c) => [c.id, c.name]));
  const nameOfEmp = new Map((people || []).map((p) => [p.id, p.display_name]));
  return {
    month,
    label: targets?.label || `${y}年${m}月`,
    note: targets?.note || null,
    hasTargets: Boolean(targets),
    dayNo, daysInMonth,
    funnel,
    rates,
    won: won ? { count: won.length, amount: wonAmount } : null,
    wonReason: won ? null : dealsWhy,
    snapshot,
    perPerson,
    stalled: stalled ? {
      days: STALL_DAYS,
      count: stalled.length,
      rows: stalled.slice(0, 5).map((d) => ({
        id: d.id, title: d.title, company: nameOfCompany.get(d.company_id) || "（会社名なし）",
        owner: nameOfEmp.get(d.owner_id) || "担当なし", stage: d.stage === "negotiation" ? "最終調整" : "提案", idle: d.idle,
        href: SALES_LINKS.company(d.company_id),
      })),
    } : null,
    stalledReason: stalled ? null : dealsWhy,
    pc: targets?.pc ? { label: targets.pc.label, target: targets.pc.target, value: null, reason: UNMEASURED.pc } : null,
    // まだつながっていない正本（数字は出さない。1行ずつ）
    unconnected: [
      { key: "ec", label: "EC・PC販売（売上・粗利・販売台数）" },
      { key: "space", label: "Space（予約の売上）" },
      { key: "board", label: "Board（売上・請求・入金）" },
    ],
    links: SALES_LINKS,
  };
}

/** 停滞案件を「今日の確認」に出す項目（無ければ null） */
export function stalledItem(sales) {
  if (!sales?.stalled || !sales.stalled.count) return null;
  return {
    key: "sales_stalled", block: "today", severity: "mid", label: "提案後に止まっている案件",
    detail: `${sales.stalled.count}件が、提案・最終調整のまま${sales.stalled.days}日以上更新されていません（最長${sales.stalled.rows[0].idle}日）`,
    count: sales.stalled.count, href: SALES_LINKS.home, linkLabel: "Salesで案件を確認する",
  };
}
