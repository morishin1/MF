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
// ■ 今月の数え方（日付は日本時間。月の境目は日本時間の 1日 0:00）
//   ファネルは「会社（企業ID）」で数える。同じ会社に2回アタック・2件の案件があっても1社
//   接触     … 今月アタックを送った会社（送れなかったもの failed_at は除く）。送信の件数は別に添える
//   商談     … 今月、案件ができた会社（案件は商談から始まる。案件の作成日。いまの段階・失注でも消えない）
//   提案     … 今月、提案・最終調整・成約に進んだ会社（gw_sales_deal_history の記録。いまの段階では数えない）
//   有料契約 … 今月成約した会社（段階の記録の「成約」、または won_on が今月）。受注額＝その案件の金額の合計
//   停滞     … いま提案・最終調整の案件で、最後の動き（段階の記録・案件の更新・その会社の営業履歴の、いちばん新しいもの）から7日以上
//   担当者別 … 担当（owner_id・送った人 employee_id）の社員IDで数える。氏名では数えない
//   金額は受注額（案件金額）だけ。粗利は持っていない（出さない・作らない）

import { readAll, readIn } from "./pg-read.js";
import { UNMEASURED, UNMEASURED_SHORT } from "./keiei-targets.js";

export const STALL_DAYS = 7;
const OPEN_LATE = ["proposal", "negotiation"];
const PROPOSED = ["proposal", "negotiation", "won"];
const COMPANY_STATUS = [
  ["attacked", "アタック済"], ["clicked", "クリックあり"], ["replied", "返信あり"],
  ["meeting", "商談"], ["proposal", "提案"], ["won", "成約"], ["lost", "失注"],
];
export const SALES_LINKS = { home: "/sales/", companies: "/sales/companies.html", company: (id) => `/sales/companies.html?id=${encodeURIComponent(id)}`, tasks: "/admin-tasks.html" };

const num = (n) => Number(n || 0).toLocaleString("ja-JP");
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
    readAll(() => sb.from("gw_sales_approaches").select("id, company_id, employee_id, sent_at, failed_at")
      .eq("tenant_id", t).gte("sent_at", sinceUtc).order("id"))
      .then((r) => r || readAll(() => sb.from("gw_sales_approaches").select("id, company_id, employee_id, sent_at")
        .eq("tenant_id", t).gte("sent_at", sinceUtc).order("id"))),
    dealState === "ok"
      ? readAll(() => sb.from("gw_sales_deals").select("id, company_id, owner_id, title, stage, amount, won_on, created_at, updated_at")
        .eq("tenant_id", t).order("id"))
      : Promise.resolve(null),
    // 段階の記録：今月分（提案・成約に進んだ会社を、いまの段階に関係なく数える）
    dealState === "ok"
      ? readAll(() => sb.from("gw_sales_deal_history").select("id, deal_id, company_id, stage, changed_at")
        .eq("tenant_id", t).gte("changed_at", sinceUtc).order("id"))
      : Promise.resolve(null),
    // タスク：終わっていないものの期限・担当だけ（題名・本文は読まない）
    readAll(() => sb.from("gw_tasks").select("id, assignee_id, due_on, status").eq("tenant_id", t).in("status", ["todo", "doing"]).order("id")),
  ]);

  // 停滞の判定に使う「最後の動き」：いま提案・最終調整の案件の、すべての段階の記録と、その会社の営業履歴の日時
  let lastStage = null;
  let lastEvent = null;
  const late = (deals || []).filter((d) => OPEN_LATE.includes(d.stage));
  if (late.length) {
    [lastStage, lastEvent] = await Promise.all([
      readIn((part) => sb.from("gw_sales_deal_history").select("id, deal_id, changed_at").eq("tenant_id", t).in("deal_id", part).order("id"),
        late.map((d) => d.id)),
      // 営業履歴は日時と会社だけ（中身は読まない）
      readIn((part) => sb.from("gw_sales_events").select("id, company_id, occurred_at").eq("tenant_id", t).in("company_id", part).order("id"),
        late.map((d) => d.company_id)),
    ]);
  } else if (deals) { lastStage = []; lastEvent = []; }
  return {
    companies,
    approaches,
    dealState: dealState === "ok" ? (deals ? "ok" : "error") : dealState,
    deals,
    history,
    lastStage,
    lastEvent,
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

  // ---- 今月の実績（全社）。ファネルは会社（企業ID）で数える
  const companiesOf = (rows) => new Set(rows.map((r) => r.company_id).filter(Boolean));
  const sent = facts.approaches ? facts.approaches.filter((a) => a.sent_at && !a.failed_at && inMonth(a.sent_at)) : null;
  const deals = dealsOk ? facts.deals : null;
  const created = deals ? deals.filter((d) => inMonth(d.created_at)) : null;
  const hist = deals && facts.history ? facts.history.filter((h) => inMonth(h.changed_at)) : null;
  const proposedRows = hist ? hist.filter((h) => PROPOSED.includes(h.stage)) : null;
  // 成約：段階の記録の「成約」か、won_on が今月の案件（どちらかで。会社で重複を除く）
  const wonDeals = deals ? deals.filter((d) => d.stage === "won" && d.won_on && d.won_on.slice(0, 7) === month) : null;
  const wonCompanies = deals ? new Set([...companiesOf(wonDeals), ...(hist ? companiesOf(hist.filter((h) => h.stage === "won")) : [])]) : null;

  // 停滞：最後の動き（段階の記録・案件の更新・その会社の営業履歴のうち、いちばん新しいもの）から7日以上
  const lastOf = new Map();
  const bump = (key, ts) => { if (ts && (!lastOf.has(key) || ts > lastOf.get(key))) lastOf.set(key, ts); };
  const stallReadable = Boolean(deals) && Array.isArray(facts.lastStage) && Array.isArray(facts.lastEvent);
  if (stallReadable) {
    const byDeal = new Map(deals.map((d) => [d.id, d]));
    for (const h of facts.lastStage) bump(`d:${h.deal_id}`, h.changed_at);
    for (const e of facts.lastEvent) bump(`c:${e.company_id}`, e.occurred_at);
    for (const d of byDeal.values()) bump(`d:${d.id}`, d.updated_at || d.created_at);
  }
  const lastActivity = (d) => [lastOf.get(`d:${d.id}`), lastOf.get(`c:${d.company_id}`)].filter(Boolean).sort().pop() || d.updated_at || d.created_at;
  const stalled = stallReadable ? deals.filter((d) => OPEN_LATE.includes(d.stage))
    .map((d) => ({ ...d, last: lastActivity(d), idle: daysBetween(jstDate(lastActivity(d)), today) }))
    .filter((d) => d.idle >= STALL_DAYS).sort((a, b) => b.idle - a.idle) : null;

  const actual = {
    contact: sent ? companiesOf(sent).size : null,
    meeting: created ? companiesOf(created).size : null,
    proposal: proposedRows ? companiesOf(proposedRows).size : null,
    won: wonCompanies ? wonCompanies.size : null,
  };
  const units = { contact: "社", meeting: "社", proposal: "社", won: "社" };
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
      key: s.key, label: s.label, unit: units[s.key] || s.unit, target: s.target ?? null, pace: paceOf(s.target),
      value: measured ? v : null,
      status: measured ? "exact" : (["effective", "key"].includes(s.key) ? "undefined" : "missing"),
      reason: measured ? null : (why[s.key] || "未計測"),
      pct: measured && s.target ? Math.round((v / s.target) * 100) : null,
      // 接触は、会社の数に加えて送信の件数を添える（同じ会社への2回目も1件）
      sends: s.key === "contact" && sent ? sent.length : null,
    };
  });
  // 転換率（となりの段階どうし。どちらかが測れなければ出さない）。計画値と並べる
  const rates = funnel.slice(1).map((cur, i) => {
    const prev = funnel[i];
    const value = cur.value != null && prev.value != null && prev.value > 0 ? Math.round((cur.value / prev.value) * 1000) / 10 : null;
    return { from: prev.label, to: cur.label, plan: targets?.plannedRates?.[cur.key] ?? null, value };
  });
  // 営業の流れ（接触 → 商談 → 提案 → 有料契約）。となりの段階どうしの転換率と、目標どうしの比（計画）
  const FLOW = ["contact", "meeting", "proposal", "won"];
  const flowSteps = FLOW.map((k) => funnel.find((f) => f.key === k)).filter(Boolean);
  const flow = flowSteps.slice(1).map((cur, i) => {
    const prev = flowSteps[i];
    const value = cur.value != null && prev.value != null && prev.value > 0 ? Math.round((cur.value / prev.value) * 1000) / 10 : null;
    const plan = cur.target && prev.target ? Math.round((cur.target / prev.target) * 1000) / 10 : null;
    return { from: prev.label, to: cur.label, fromKey: prev.key, toKey: cur.key, value, plan };
  });
  // 受注額＝今月成約した案件の金額（案件金額）の合計。粗利ではない
  const wonAmount = wonDeals ? wonDeals.reduce((s, d) => s + (Number(d.amount) || 0), 0) : null;

  // ---- いまの会社の状態（今月分ではない。Sales の企業一覧の今の状態）
  const visible = facts.companies ? facts.companies.filter((c) => !c.hidden_at) : null;
  const snapshot = visible ? COMPANY_STATUS.map(([k, label]) => ({ key: k, label, count: visible.filter((c) => c.status === k).length })) : null;

  // ---- 担当者別（名簿の表示名に姓が含まれる、在籍中の1人だけを特定する）
  const active = (people || []).filter((p) => !["left"].includes(p.status));
  // 社員ID（employeeId）があればそれで、無ければ表示名の姓で在籍中の1人に特定できたときだけ。数えるのは、いつも社員ID
  const personOf = (t) => {
    if (t.employeeId) return active.find((p) => p.id === t.employeeId) || null;
    const hit = active.filter((p) => String(p.display_name || "").includes(t.name));
    return hit.length === 1 ? hit[0] : null;
  };
  const tasksOk = Array.isArray(facts.tasks);
  const overdue = tasksOk ? facts.tasks.filter((x) => x.due_on && x.due_on < today).length : null;
  const unassigned = tasksOk ? facts.tasks.filter((x) => !x.assignee_id).length : null;
  // 担当者の行だけ（社員IDで絞る。氏名では数えない）。会社で重複を除く
  const mine = (rows, key, id) => (rows ? rows.filter((r) => r[key] === id) : null);
  const ownerOfDeal = new Map((deals || []).map((d) => [d.id, d.owner_id]));
  const measureFor = (kpi, emp) => {
    const need = (v, missing) => (v == null ? { value: null, reason: missing } : { value: v });
    const myProposed = (id) => (proposedRows ? companiesOf(proposedRows.filter((h) => ownerOfDeal.get(h.deal_id) === id)) : null);
    switch (kpi.measure) {
      case "contact": {
        if (!emp) return null;
        if (!sent) return { value: null, reason: why.contact };
        const mineSent = mine(sent, "employee_id", emp.id);
        return { value: companiesOf(mineSent).size, note: `送信${mineSent.length}件` };
      }
      case "meeting": return emp ? need(created ? companiesOf(mine(created, "owner_id", emp.id)).size : null, dealsWhy) : null;
      case "proposal": return emp ? need(myProposed(emp.id)?.size ?? null, why.proposal || dealsWhy) : null;
      case "proposal_rate": {
        if (!emp) return null;
        if (!created || !proposedRows) return { value: null, reason: why.proposal || dealsWhy };
        const m0 = companiesOf(mine(created, "owner_id", emp.id)).size;
        const p0 = myProposed(emp.id).size;
        return m0 ? { value: Math.round((p0 / m0) * 100), note: `提案${p0}社／商談${m0}社` } : { value: null, reason: "今月の商談がまだありません" };
      }
      case "won": return emp ? need(wonDeals ? companiesOf(wonDeals.filter((d) => d.owner_id === emp.id)).size : null, dealsWhy) : null;
      case "won_all": return need(wonCompanies?.size ?? null, dealsWhy);
      case "stalled_all": return need(stalled?.length ?? null, stallReadable ? null : (deals ? "停滞の判定に使う記録を読み込めませんでした" : dealsWhy));
      case "tasks_overdue": return need(overdue, "タスクを読み込めませんでした");
      case "tasks_unassigned": return need(unassigned, "タスクを読み込めませんでした");
      default: return { value: null, reason: UNMEASURED[kpi.reason] || UNMEASURED.ops, short: UNMEASURED_SHORT[kpi.reason] || "未計測", unmeasured: true };
    }
  };
  const perPerson = (targets?.people || []).map((p) => {
    const emp = personOf(p);
    const companyWide = (k) => ["won_all", "stalled_all", "tasks_overdue", "tasks_unassigned"].includes(k);
    return {
      name: emp ? emp.display_name : p.name,
      employeeId: emp ? emp.id : null,
      linked: Boolean(emp),
      linkedBy: emp ? (p.employeeId ? "id" : "name") : null,
      role: p.role,
      kpis: p.kpis.map((k) => {
        let r = measureFor(k, emp);
        if (r === null) r = { value: null, reason: "名簿で、この人を1人に特定できません（表示名を確認してください）" };
        const done = r.value != null && k.target != null
          ? (k.lowerIsBetter ? r.value <= k.target : r.value >= k.target) : null;
        // 今日時点の目安（件数・金額は目標 × 経過日数 / 月の日数。%・少ないほどよいものは目安を持たず、目標そのものと比べる）
        const pace = k.target != null && !k.lowerIsBetter && k.unit !== "%" ? paceOf(k.target) : null;
        // 目安に届いているか（測れていないものは null。0 件の目標は比べない）
        const onPace = r.value == null || k.target == null ? null
          : k.lowerIsBetter ? r.value <= k.target
          : k.unit === "%" ? r.value >= k.target
          : r.value >= (k.target * dayNo) / daysInMonth;
        return { label: k.label, unit: k.unit, target: k.target, value: r.value, reason: r.reason || null, note: r.note || null, short: r.short || null,
          unmeasured: Boolean(r.unmeasured), lowerIsBetter: Boolean(k.lowerIsBetter), done, pace, onPace,
          pct: r.value != null && k.target && !k.lowerIsBetter && k.unit !== "%" ? Math.round((r.value / k.target) * 100) : null,
          companyWide: companyWide(k.measure) };
      }),
    };
  }).map((p) => {
    // 状態：測れている項目がひとつもなければ「未計測」。ひとつでも目安に届いていなければ「遅れ」。すべて届いていれば「順調」
    const measured = p.kpis.filter((k) => k.onPace !== null);
    const behind = measured.filter((k) => k.onPace === false);
    const state = !measured.length ? { key: "unmeasured", label: "未計測" }
      : behind.length ? { key: "behind", label: "遅れ" } : { key: "ontrack", label: "順調" };
    // 次に見るもの：遅れている項目を先に。無ければ、まだ測れていない項目（理由つき）。それも無ければ null
    const first = behind[0];
    const unm = p.kpis.find((k) => k.value == null);
    const next = first
      ? { kind: "behind", label: first.label, text: `${first.label} ${num(first.value)}${first.unit}／${first.pace != null ? `目安 ${num(first.pace)}${first.unit}` : `目標 ${num(first.target)}${first.unit}${first.lowerIsBetter ? "以下" : ""}`}` }
      : unm ? { kind: "unmeasured", label: unm.label, text: `${unm.label}：${unm.short || "取得できません"}` } : null;
    return { ...p, state, next };
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
    flow,
    rates,
    // 期限を過ぎた未完了のタスク（全社）。読めなければ null（0 にしない）
    overdueTasks: overdue,
    won: wonDeals ? { companies: wonCompanies.size, deals: wonDeals.length, amount: wonAmount } : null,
    wonReason: wonDeals ? null : dealsWhy,
    snapshot,
    perPerson,
    stalled: stalled ? {
      days: STALL_DAYS,
      count: stalled.length,
      rows: stalled.slice(0, 5).map((d) => ({
        id: d.id, title: d.title, company: nameOfCompany.get(d.company_id) || "（会社名なし）",
        owner: nameOfEmp.get(d.owner_id) || "担当なし", stage: d.stage === "negotiation" ? "最終調整" : "提案", idle: d.idle, last: jstDate(d.last),
        href: SALES_LINKS.company(d.company_id),
      })),
    } : null,
    stalledReason: stalled ? null : (deals ? "停滞の判定に使う記録を読み込めませんでした" : dealsWhy),
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

/** 期限を過ぎたタスクを「今日の確認」に出す項目（無ければ null） */
export function overdueItem(sales) {
  if (!sales?.overdueTasks) return null;
  return {
    key: "tasks_overdue", block: "today", severity: "mid", label: "期限を過ぎたタスク",
    detail: `${sales.overdueTasks}件のタスクが、期限を過ぎたまま終わっていません`,
    count: sales.overdueTasks, href: SALES_LINKS.tasks, linkLabel: "全員のタスクを確認する",
  };
}
