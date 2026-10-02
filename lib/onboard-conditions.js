// 本人に見せる「あなたの契約条件」。
//
// ■ 別DB・別入力にしない
//   元は gw_contracts（status=active の1件）と gw_employees だけ。管理側で登録した契約条件を、
//   入社準備（/onboarding/）・入社手続き（onboarding.html・/api/onboarding/me）・マイページが
//   同じこの関数で読む。HR・Office・本人画面で同じ内容を手入力しない。
//
// ■ 未登録は「エラー」にしない
//   契約条件がまだ無い（draft のまま・まだ作られていない）ときは、値を null で返し、
//   画面は「会社で準備中です」と出す。本人が「入力し忘れた」と思わないための文言。
//   契約は有効（ready）なのに、ある項目だけ空のときは、画面は「現在確認中」と出す。
//
// ■ 契約の状態（既存の gw_contracts.status）
//   draft = 未確定 / active = 有効 / superseded = 更新済み。
//   本人に出すのは active だけ。draft は「準備中」、superseded は履歴。

const slash = (d) => (d ? String(d).slice(0, 10).replace(/-/g, "/") : null);

export const CONTRACT_STATUS_LABEL = { draft: "未確定", active: "有効", superseded: "更新済み" };
export const PENDING_TEXT = "会社で準備中です";

/**
 * 会社が把握している労働条件（読み取り専用）。/api/onboarding/me の known と同じ形。
 * 給与は本人にも出す（自分のことなので）。
 *
 * @param {object} employee gw_employees の行
 * @param {object|null} c   gw_contracts の active な1件
 * @param {string|null} managerName 相談先（上長）の表示名
 */
export function knownOf(employee, c, managerName = null) {
  const e = employee || {};
  return {
    name: e.display_name,
    email: e.email,
    joinedOn: e.joined_on,
    role: c?.job_content || e.initial_role,
    workScope: Array.isArray(c?.work_scope) ? c.work_scope : [],
    workStyle: c?.work_style || e.work_style,
    weeklyHours: c?.weekly_hours ?? null,
    contract: c?.fixed_term
      ? `有期（${c.period_from} 〜 ${c.period_to || "—"}）`
      : c ? "無期" : null,
    probation: c?.probation_months ? `${c.probation_months}か月` : null,
    wage: c?.wage_amount
      ? `${c.wage_type || ""} ${Number(c.wage_amount).toLocaleString("ja-JP")}円`
        + (c.wage_note ? `（${c.wage_note}）` : "")
      : null,
    manager: managerName || null,
  };
}

/**
 * 「あなたの契約条件」カードの行。値が無い行は value:null（画面は「会社で準備中です」）。
 * 契約が有効（active）なときだけ ready:true。
 *
 * @param {object} employee gw_employees の行
 * @param {object|null} c   gw_contracts の active な1件
 * @param {string|null} managerName
 */
export function conditionRows(employee, c, managerName = null) {
  const k = knownOf(employee, c, managerName);
  const e = employee || {};
  const termLabel = !c ? null : c.fixed_term ? "有期契約" : "期間の定めなし";
  const period = !c ? null
    : c.fixed_term
      ? [slash(c.period_from), c.period_to ? slash(c.period_to) : null].every(Boolean)
        ? `${slash(c.period_from)} ～ ${slash(c.period_to)}`
        : (c.period_from ? `${slash(c.period_from)} ～` : null)
      : (c.period_from ? `${slash(c.period_from)} ～（期間の定めなし）` : null);
  const hours = k.weeklyHours != null ? `週${k.weeklyHours}時間` : null;
  const style = [k.workStyle, c?.work_hours].filter(Boolean).join("　") || null;
  const rows = [
    { key: "joinedOn",  label: "入社日",     value: slash(k.joinedOn) },
    { key: "contract",  label: "雇用形態",   value: termLabel ? [c.contract_type, termLabel].filter(Boolean).join("・") : null },
    { key: "period",    label: "契約期間",   value: period },
    { key: "probation", label: "試用期間",   value: k.probation || (c ? "なし" : null) },
    { key: "hours",     label: "勤務時間",   value: hours },
    { key: "workStyle", label: "勤務形態",   value: style },
    { key: "role",      label: "担当",       value: k.role || e.department || null },
    { key: "workScope", label: "業務範囲",   value: k.workScope.length ? k.workScope.join("、") : null },
    { key: "wage",      label: "給与",       value: k.wage },
    { key: "manager",   label: "相談先",     value: k.manager },
  ];
  return {
    ready: Boolean(c),
    status: c ? "active" : "draft",
    statusLabel: c ? CONTRACT_STATUS_LABEL.active : CONTRACT_STATUS_LABEL.draft,
    rows,
  };
}

const addDays = (ymd, n) => {
  const d = new Date(`${String(ymd).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const periodText = (c) => {
  const from = slash(c.period_from), to = slash(c.period_to);
  if (c.fixed_term) return from && to ? `${from} ～ ${to}` : from ? `${from} ～` : null;
  return from ? `${from} ～（期間の定めなし）` : "期間の定めなし";
};

/**
 * 契約の更新後も、いまの契約が分かる形に。既存の契約の状態（draft/active/superseded）をそのまま使う。
 *
 *   current          … 有効（active）な契約。無ければ null
 *   nextRenewalOn    … 有期契約の「更新の確認」日（満了の renewal_notice_days 日前。既定30日）
 *   past             … 更新済み（superseded）の契約。新しい順
 *
 * 古い契約と現在有効な契約を混ぜない（past に有効なものは入らない）。
 *
 * @param {object[]} rows 本人の gw_contracts（どの状態でもよい）
 */
export function contractHistory(rows) {
  const list = (rows || []).slice().sort((a, b) =>
    String(b.period_from || "").localeCompare(String(a.period_from || "")) || String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const act = list.find((r) => r.status === "active") || null;
  const view = (c) => ({
    id: c.id, status: c.status, statusLabel: CONTRACT_STATUS_LABEL[c.status] || c.status,
    kind: c.fixed_term ? "有期契約" : "期間の定めなし",
    contractType: c.contract_type || null,
    period: periodText(c),
  });
  return {
    current: act ? view(act) : null,
    nextRenewalOn: act?.fixed_term && act.period_to
      ? slash(addDays(act.period_to, -(Number(act.renewal_notice_days) || 30))) : null,
    past: list.filter((r) => r.status === "superseded").map(view),
  };
}
