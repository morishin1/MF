// 評価・キャリア（db/092_career.sql）の、画面にもAPIにも共通する考え方。
//
// ■ 自動で昇給・昇格させない
//   ここで作るのは「材料」と「参考の判定」だけ。
//   Level Up・昇給は、人（owner / admin）が評価を確定したときにだけ起きる。
//   給与は none / keep / raise の結果だけを持ち、新しい金額は契約側で決める。
//
// ■ 数字＝評価結果にしない
//   KPI・日報・タスク・できるようになったこと・自走レベルは「根拠」として並べる。
//   基準ごとの達成/取り組み中/未達は、評価する人が選ぶ。
//
// ■ 自走レベルとキャリアLevelは別物
//   自走レベル … どこまで任せられるか（gw_employees.autonomy_level、1〜4）
//   キャリアLevel … 職種上の役割・期待値・給与レンジ（gw_career_levels）
//   自走レベルは評価基準の1つ（evidence_type = 'autonomy'）として参照できるだけ。

/** 基準ごとの結果。本人画面では ✓ △ ○ で見せる */
export const CRITERION_RESULTS = [
  { key: "achieved",    label: "達成",       mark: "✓" },
  { key: "in_progress", label: "取り組み中", mark: "△" },
  { key: "not_yet",     label: "未達",       mark: "○", memberLabel: "まだ" },
  { key: "na",          label: "対象外",     mark: "－" },
];
export const CRITERION_RESULT_KEYS = CRITERION_RESULTS.map((r) => r.key);

export const REVIEW_RESULTS = [
  { key: "continue", label: "現Level継続" },
  { key: "level_up", label: "Level Up" },
  { key: "hold",     label: "保留" },
];
export const REVIEW_RESULT_KEYS = REVIEW_RESULTS.map((r) => r.key);

export const SALARY_DECISIONS = [
  { key: "none",  label: "判断なし" },
  { key: "keep",  label: "変更なし" },
  { key: "raise", label: "昇給を検討" },
];
export const SALARY_DECISION_KEYS = SALARY_DECISIONS.map((r) => r.key);

export const EVIDENCE_TYPES = [
  { key: "manager",        label: "上長の確認" },
  { key: "kpi",            label: "3か月KPI" },
  { key: "nippo",          label: "日報" },
  { key: "tasks",          label: "タスク実績" },
  { key: "growth_history", label: "できるようになったこと" },
  { key: "autonomy",       label: "自走レベル" },
  { key: "goals",          label: "今週のゴール" },
  { key: "probation",      label: "試用期間" },
];
export const EVIDENCE_TYPE_KEYS = EVIDENCE_TYPES.map((e) => e.key);

/** 画面に必ず添える文言（保証ではないこと・年数は目安であること） */
export const RANGE_NOTE =
  "このレンジは次レベルの目安です。実際の給与は評価・役割・契約条件等を確認して決定します。";
export const RANGE_NOTE_ADMIN =
  "次のレベルの給与レンジです。実際の昇給・昇格は、評価・役割・会社状況等を確認して決定します。";
export const TIMELINE_NOTE =
  "標準的なキャリアの目安です。昇格時期は役割・成果・成長状況により異なります。";

import { canOfficeHr } from "./gw.js";

// ---- 権限 ---------------------------------------------------------------------
const has = (ctx, r) => (ctx?.roles || []).includes(r);

/** 評価・キャリアの画面を使えるか（管理者・経営者・人事・マネージャー） */
// 人事（hr）は Office の中の権限なので、人事・労務の判定（canOfficeHr）を通す（内部ロールを直接見ない）
export const canManageCareer = (ctx) => Boolean(canOfficeHr(ctx) || has(ctx, "manager"));

/** 全員を見られるか。マネージャーだけの人は、自分が上長の社員（manager_id）に限る */
export const careerSeesAll = (ctx) => Boolean(canOfficeHr(ctx));

/** 評価の確定（Level Up・昇給判断）と、Level・給与レンジのマスタ編集。owner / admin だけ */
export const canDecideCareer = (ctx) => Boolean(ctx?.isAdmin || has(ctx, "owner"));

/** この社員を担当しているか */
export function inCareerScope(ctx, employee) {
  if (!employee || employee.tenant_id !== ctx?.tenantId) return false;
  if (careerSeesAll(ctx)) return true;
  return has(ctx, "manager") && Boolean(ctx.employee?.id) && employee.manager_id === ctx.employee.id;
}

// ---- Level の並び ---------------------------------------------------------------
/** そのトラックの有効なLevelを、番号順に */
export const levelsOf = (levels, trackId) =>
  (levels || []).filter((l) => l.track_id === trackId && l.is_active !== false)
    .sort((a, b) => a.level_no - b.level_no);

export function nextLevelOf(levels, current) {
  if (!current) return null;
  return levelsOf(levels, current.track_id).find((l) => l.level_no > current.level_no) || null;
}

/**
 * 1年後・3年後の目安になるLevel。
 * typical_months（入社からの標準的な月数）で選ぶ。無ければ、いまのLevelから1つ・2つ先。
 * 「必ずこの年数で上がる」ものではない（TIMELINE_NOTE を必ず添える）
 */
export function horizonLevel(levels, current, months) {
  const list = levelsOf(levels, current?.track_id);
  if (!list.length || !current) return null;
  const withMonths = list.filter((l) => Number.isFinite(l.typical_months));
  if (withMonths.length) {
    const within = withMonths.filter((l) => l.typical_months <= months && l.level_no >= current.level_no);
    if (within.length) return within[within.length - 1];
  }
  const step = months >= 36 ? 2 : 1;
  const idx = list.findIndex((l) => l.id === current.id);
  return list[Math.min(list.length - 1, Math.max(0, idx) + step)] || null;
}

// ---- 進捗 -----------------------------------------------------------------------
/**
 * 基準と評価結果から、カテゴリーごとの進み具合を作る。
 * @param {object[]} criteria gw_career_criteria（次のLevelのもの）
 * @param {object[]} results  確定済み評価の criterion_results（無ければ空）
 */
export function progressOf(criteria, results = []) {
  const byId = new Map((results || []).map((r) => [r.criterionId, r]));
  const active = (criteria || []).filter((c) => c.is_active !== false)
    .sort((a, b) => (a.sort_order - b.sort_order) || String(a.title).localeCompare(String(b.title)));
  const cats = new Map();
  const items = active.map((c) => {
    const status = byId.get(c.id)?.result || "not_yet";
    const it = {
      id: c.id, category: c.category, title: c.title, description: c.description || null,
      required: c.required !== false, evidenceType: c.evidence_type, status,
    };
    if (!cats.has(c.category)) cats.set(c.category, { category: c.category, achieved: 0, total: 0, items: [] });
    const g = cats.get(c.category);
    g.items.push(it);
    if (status !== "na") {
      g.total++;
      if (status === "achieved") g.achieved++;
    }
    return it;
  });
  const counted = items.filter((i) => i.status !== "na");
  const remaining = counted.filter((i) => i.status !== "achieved")
    // 必須から先に、取り組み中を先に（あと一歩のものを上に）
    .sort((a, b) => (Number(b.required) - Number(a.required))
      || (Number(b.status === "in_progress") - Number(a.status === "in_progress")));
  return {
    categories: [...cats.values()],
    achieved: counted.filter((i) => i.status === "achieved").length,
    total: counted.length,
    remaining,
    items,
  };
}

/**
 * システム判定（参考）。最終判断ではない。
 * 必須がそろい、全体の8割以上 → 概ね満たしている
 */
export function systemJudgement(criteria, results, targetLevel) {
  const p = progressOf(criteria, results);
  const requiredMissing = p.remaining.filter((i) => i.required);
  const ratio = p.total ? p.achieved / p.total : 0;
  const name = targetLevel ? `Level ${targetLevel.level_no}` : "次のLevel";
  let verdict, label;
  if (!p.total) { verdict = "no_criteria"; label = `${name}の評価基準がまだありません`; }
  else if (!requiredMissing.length && p.achieved === p.total) { verdict = "meets"; label = `${name}基準を満たしています`; }
  else if (!requiredMissing.length && ratio >= 0.8) { verdict = "mostly"; label = `${name}基準を概ね満たしています`; }
  else { verdict = "not_yet"; label = `${name}基準にはまだ不足があります`; }
  return {
    verdict, label,
    achieved: p.achieved, total: p.total,
    missing: p.remaining.map((i) => ({ id: i.id, category: i.category, title: i.title, required: i.required })),
    note: "システム判定は参考情報です。最終判断は評価者が行います。",
  };
}

/** 評価の結果を、保存してよい形に整える（知らない基準・値は落とす） */
export function cleanResults(criteria, input) {
  const byId = new Map((criteria || []).map((c) => [c.id, c]));
  const out = [];
  for (const r of Array.isArray(input) ? input : []) {
    const c = byId.get(r?.criterionId);
    if (!c || !CRITERION_RESULT_KEYS.includes(r.result)) continue;
    out.push({
      criterionId: c.id, category: c.category, title: c.title, result: r.result,
      note: r.note ? String(r.note).slice(0, 500) : null,
    });
  }
  return out;
}

// ---- 一覧の NEXT ACTION ----------------------------------------------------------
const addDaysIso = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * 管理者の一覧で「次に何をするか」。rank が小さいほど上に出す。
 * @param {{career?:object|null, draft?:object|null, progress?:{remaining:object[], total:number}|null,
 *          nextLevel?:object|null, today:string}} p
 */
export function nextActionOf({ career, draft, progress, nextLevel, today }) {
  if (!career) return { rank: 0, key: "setup", label: "キャリア設定が必要です" };
  if (draft) return { rank: 1, key: "confirm", label: "評価を確定してください" };
  const due = career.next_review_on;
  if (due && due < today) return { rank: 2, key: "overdue", label: "評価面談の期限を過ぎています" };
  if (due && due <= addDaysIso(today, 14)) return { rank: 3, key: "review", label: "評価面談を実施してください" };
  if (!career.agreed_at) return { rank: 4, key: "interview", label: "初回キャリア面談をしてください" };
  if (!nextLevel) return { rank: 8, key: "top", label: "最上位のLevelです" };
  const left = progress ? progress.remaining.length : null;
  if (progress && progress.total && left === 0) return { rank: 5, key: "ready", label: "評価準備完了" };
  if (!due) return { rank: 6, key: "schedule", label: "次回評価日を決めてください" };
  return { rank: 7, key: "progress", label: `L${nextLevel.level_no}まで${left ?? "-"}項目` };
}

/** 職種から、キャリアトラックの候補を出す（自動では確定しない） */
export function suggestTrack(employee, tracks) {
  const list = (tracks || []).filter((t) => t.is_active !== false);
  const hay = [employee?.job_family_code, employee?.initial_role, employee?.position, employee?.department]
    .filter(Boolean).join(" ");
  const hit = list.find((t) => hay && (hay.includes(t.name) || t.name.split(/[・/／\s]/).some((w) => w && hay.includes(w))));
  return hit || list.find((t) => t.name === "共通") || list[0] || null;
}

/** 金額の見せ方 */
export const yen = (n) => (n === null || n === undefined || n === "" ? null
  : `${Number(n).toLocaleString("ja-JP")}円`);
export const rangeText = (l) => {
  if (!l || (l.salary_min == null && l.salary_max == null)) return null;
  if (l.salary_min != null && l.salary_max != null) return `${yen(l.salary_min)}〜${yen(l.salary_max)}`;
  return l.salary_min != null ? `${yen(l.salary_min)}〜` : `〜${yen(l.salary_max)}`;
};

// ---- 初期の型（§40）。画面の「共通テンプレートを入れる」で、この会社のマスタに書き込む --------
export const STARTER_CATEGORIES = ["業務遂行", "専門スキル", "顧客・品質", "改善・AI活用", "チーム貢献"];

export const STARTER = {
  track: {
    name: "共通",
    description: "職種ごとのキャリアを作るまでの共通の型です。職種ごとに複製・調整してください。",
    one_year_goal: "LEVEL 2：一人で担当業務を完結し、基本的な顧客対応とAI/DX改善を自分で実行する",
    three_year_goal: "LEVEL 3〜4：後輩育成、案件/チームの責任、売上・品質・改善への責任を持つ",
  },
  levels: [
    { level_no: 1, level_name: "基本業務を習得する", role_summary: "指示を受けて実行", typical_months: 0,
      next_level_summary: "一人で担当業務を完結できるようになる" },
    { level_no: 2, level_name: "一人で業務を完結する", role_summary: "一人で業務を完結", typical_months: 12,
      next_level_summary: "改善と他者支援まで行えるようになる" },
    { level_no: 3, level_name: "改善・他者支援まで行う", role_summary: "改善・後輩支援", typical_months: 30,
      next_level_summary: "チーム/領域の成果に責任を持つ" },
    { level_no: 4, level_name: "チーム/領域の成果責任を持つ", role_summary: "チーム責任", typical_months: 48,
      next_level_summary: "事業・専門領域の責任を持つ" },
    { level_no: 5, level_name: "事業・専門領域の責任を持つ", role_summary: "事業・専門領域責任", typical_months: 72,
      next_level_summary: null },
  ],
  // L1 → L2 の基準（§9 の例）。ほかのLevelの基準は、職種ごとに画面から足す
  criteria: {
    2: [
      ["業務遂行", "担当タスクを期限内に完了できる", "tasks"],
      ["業務遂行", "指示された内容を正しく実行できる", "manager"],
      ["専門スキル", "担当業務の基本操作ができる", "kpi"],
      ["専門スキル", "レビュー指摘を修正できる", "manager"],
      ["顧客・品質", "報告・連絡・相談ができる", "nippo"],
      ["顧客・品質", "基本的な品質基準を守れる", "manager"],
      ["改善・AI活用", "AIを日常業務に使える", "nippo"],
      ["改善・AI活用", "小さな改善を1件実行できる", "growth_history"],
      ["チーム貢献", "情報共有ができる", "nippo"],
      ["チーム貢献", "他メンバーへ相談・協力できる", "autonomy"],
    ],
  },
};

// ---- 契約・キャリア面談の進み具合（db/095） ------------------------------------------
//
// 状態は保存しない。既存のデータから毎回計算する（同じ情報を2か所に持たない）。
//   契約 … gw_doc_orders（作成依頼）→ gw_sign_requests（電子署名）→ gw_contracts（active）
//   キャリア … gw_employee_careers → 本人の「確認しました」（employee_confirmed_at）→ gw_career_reviews
// 本人には1つの依頼として見せるが、内部では別々に進む。

/** 画面の色（tone）は意味の補助。必ず label も一緒に出す */
export const FLOW_STATES = [
  { key: "setup",              label: "未設定",       tone: "red" },
  { key: "meeting",            label: "面談準備",     tone: "blue" },
  { key: "contract_preparing", label: "契約準備",     tone: "blue" },
  { key: "employee_review",    label: "本人確認待ち", tone: "yellow" },
  { key: "signing",            label: "署名待ち",     tone: "yellow" },
  { key: "active",             label: "開始",         tone: "green" },
  { key: "review_due",         label: "評価時期",     tone: "blue" },
];
export const FLOW_KEYS = FLOW_STATES.map((s) => s.key);
const flowLabel = (k) => FLOW_STATES.find((s) => s.key === k)?.label || k;

/** 雇用契約として扱う書面の種類（誓約書・貸与品などは契約の進み具合に入れない） */
export const CONTRACT_DOC_KINDS = ["employment"];
/** 作成依頼のうち、まだ本人に届いていないもの */
export const OPEN_ORDER_STATUSES = ["requested", "uploaded"];

/** 本人がキャリアプランの確認を済ませていないか（依頼したあと、まだ押していない） */
export const confirmPending = (career) => Boolean(career?.confirm_requested_at
  && (!career.employee_confirmed_at || career.employee_confirmed_at < career.confirm_requested_at));

const slashDate = (d) => (d ? String(d).slice(0, 10).replace(/-/g, "/") : "");

/**
 * いまの状態と、NEXT ACTION・Primary CTA（1つ）。
 * cta.key … meeting（面談モーダル）/ review（評価モーダル）/ orders（作成依頼）/ signs（署名の状況）/ null
 *
 * @param {{career?:object|null, draft?:object|null, orders?:object[], signs?:object[], today:string}} p
 *   orders … その社員の gw_doc_orders（employment・requested/uploaded）
 *   signs  … その社員の gw_sign_requests（employment・sent）
 */
export function flowOf({ career, draft, orders = [], signs = [], today }) {
  const make = (state, rank, label, extra = {}) => ({
    state, stateLabel: flowLabel(state),
    tone: extra.tone || FLOW_STATES.find((s) => s.key === state)?.tone || "blue",
    rank, label, sub: extra.sub || null, cta: extra.cta || null,
  });
  if (!career) {
    return make("setup", 0, "契約・キャリア面談を設定してください",
      { cta: { key: "meeting", label: "契約・キャリア面談を開始" } });
  }
  if (draft) {
    return make("review_due", 1, "Level判定待ちです",
      { tone: "yellow", sub: "評価の下書きがあります。最終判断は人が確定します", cta: { key: "review", label: "評価する" } });
  }
  // 以前から使っている「初回面談で合意済み」（agreed_at）は、確認済みとして扱う
  if (!career.confirm_requested_at && !career.agreed_at) {
    return make("meeting", 2, "面談準備が必要です",
      { sub: "現在地・1年後/3年後・次のLevelを決めて、本人へ確認依頼を送ります", cta: { key: "meeting", label: "面談を続ける" } });
  }
  if (orders.length) {
    return make("contract_preparing", 3, "契約書作成待ちです",
      { sub: `作成依頼：${slashDate(orders[0].requested_at || orders[0].created_at)}`, cta: { key: "orders", label: "作成依頼を見る" } });
  }
  if (confirmPending(career)) {
    return make("employee_review", 4, "本人の確認待ちです",
      { sub: `送信：${slashDate(career.confirm_requested_at)}` });
  }
  if (signs.length) {
    return make("signing", 5, "契約書の署名待ちです",
      { sub: `送信：${slashDate(signs[0].sent_at)}`, cta: { key: "signs", label: "署名状況を見る" } });
  }
  const due = career.next_review_on;
  if (due && due < today) {
    return make("review_due", 1, "評価面談の期限を過ぎています",
      { tone: "red", sub: `次回評価：${slashDate(due)}`, cta: { key: "review", label: "評価する" } });
  }
  if (due && due <= addDaysIso(today, 14)) {
    return make("review_due", 6, "3か月評価を実施してください",
      { sub: `次回評価：${slashDate(due)}`, cta: { key: "review", label: "評価する" } });
  }
  if (!due) {
    return make("active", 7, "次回評価日を設定してください",
      { tone: "red", cta: { key: "meeting", label: "面談を開く" } });
  }
  return make("active", 8, "育成中です",
    { sub: `次回評価：${slashDate(due)}`, cta: { key: "meeting", label: "契約・キャリア面談を開始" } });
}

// ---- 契約・キャリアの完了状態（共通判定。GW「契約締結×キャリア設定」完了状態 §2・§3・§8・§17） -----
//
// flowOf() は「いま何をすべきか」という運用中の1本の流れ。
// こちらは、それとは別に「いま契約・キャリアの両方が完了しているか」という点検で、
// 契約とキャリアを独立した2本の軸として判定する。5つの状態と、整合性の崩れ（§8）を見る。
//
// 判定はここ1か所（§17）。管理者の画面・本人の画面のどちらも、この3つの関数だけを呼ぶ

export const CONTRACT_STATUS = [
  { key: "no_contract",       label: "契約条件が未確定です",        ok: false, warn: false },
  { key: "pending_signature", label: "本人の署名待ちです",           ok: false, warn: false },
  { key: "unsigned",          label: "締結済み書面が確認できません", ok: false, warn: true },
  { key: "orphan_signed",     label: "現在契約が設定されていません", ok: false, warn: true },
  { key: "signed",            label: "契約締結済み",                 ok: true,  warn: false },
];
const contractStatusOf = (key) => CONTRACT_STATUS.find((s) => s.key === key) || CONTRACT_STATUS[0];

/**
 * 契約の完了状態（§2・§8）。
 *
 *   active な gw_contracts があり、それに対応する signed の署名依頼が確認できて、
 *   初めて「契約締結済み」。active はあるのに signed が確認できない・signed は
 *   あるのに active が無い、は完了扱いにしない（自動修正はしない。人に知らせるだけ）
 *
 * @param {{contract:{id:string}|null, signs:{status:string, contract_id?:string|null}[]}} p
 *   contract … その社員の active な gw_contracts（無ければ null）
 *   signs    … その社員の雇用契約ぶんの gw_sign_requests（doc_kind='employment'。全ステータス）。
 *              contract_id が付いているものは明示的な紐付け（db/112）。無い古いデータは
 *              「この契約の署名」とみなして扱う（後方互換。誤検知より見落とさない方を優先）
 */
export function contractStatus({ contract, signs = [] }) {
  const linkedToThis = (s) => !s.contract_id || (contract && s.contract_id === contract.id);
  const anySigned = signs.some((s) => s.status === "signed");
  const signedForThis = signs.some((s) => s.status === "signed" && linkedToThis(s));
  const sentPending = signs.some((s) => s.status === "sent");

  if (contract) {
    if (signedForThis) return contractStatusOf("signed");
    if (sentPending) return contractStatusOf("pending_signature");
    return contractStatusOf("unsigned");           // active はあるが、締結済み書面が確認できない
  }
  if (anySigned) return contractStatusOf("orphan_signed");   // 署名済み書面はあるが active 契約がない
  if (sentPending) return contractStatusOf("pending_signature");
  return contractStatusOf("no_contract");
}

export const CAREER_STATUS = [
  { key: "not_set",    label: "キャリア未設定",       ok: false },
  { key: "confirming", label: "キャリア本人確認待ち", ok: false },
  { key: "confirmed",  label: "キャリア設定済み",      ok: true },
];
const careerStatusOf = (key, extra = {}) =>
  ({ ...(CAREER_STATUS.find((s) => s.key === key) || CAREER_STATUS[0]), ...extra });

/**
 * キャリアの完了状態（§2）。
 *
 *   track・現在Level・1年後/3年後の目標・次回評価日がそろい、本人が確認して
 *   初めて「キャリア設定済み」。項目がそろっているだけでは確認待ちにもしない
 *   （まだ本人へ送っていない ＝ 設定作業の続き）
 *
 * @param {{career:object|null}} p career … gw_employee_careers の行（無ければ null）
 */
export function careerStatus({ career }) {
  const has = (v) => v !== null && v !== undefined && String(v).trim() !== "";
  const nextReviewOn = career?.next_review_on || null;
  if (!career) return careerStatusOf("not_set", { nextReviewOn });
  const complete = has(career.track_id) && has(career.current_level_id)
    && has(career.one_year_target_note) && has(career.three_year_target_note) && has(nextReviewOn);
  if (!complete) return careerStatusOf("not_set", { nextReviewOn });
  // 「初回面談で合意済み」（agreed_at）は、以前からの確認済み扱い（flowOf と同じ規則）
  if (career.agreed_at && !career.confirm_requested_at) return careerStatusOf("confirmed", { nextReviewOn });
  if (career.employee_confirmed_at && !confirmPending(career)) return careerStatusOf("confirmed", { nextReviewOn });
  if (confirmPending(career)) return careerStatusOf("confirming", { nextReviewOn });
  return careerStatusOf("not_set", { nextReviewOn });   // そろっているが、まだ本人へ送っていない
}

export const OVERALL_STATES = [
  { key: "contract_pending",  label: "契約準備中" },
  { key: "contract_signing",  label: "署名待ち" },
  { key: "career_setup",      label: "キャリア未設定" },
  { key: "career_confirming", label: "キャリア確認待ち" },
  { key: "completed",         label: "契約・キャリア完了" },
];

/**
 * 契約・キャリアをまとめた全体状態（§3・§17）。
 *
 * 管理者・本人・一覧・履歴のどこで出しても、必ずこの関数の結果を使う
 * （別々に判定ロジックを持たない）
 *
 * @param {{contractStatus:object, careerStatus:object}} p contractStatus()/careerStatus() の結果
 * @returns {{key:string, label:string, nextAction:{label:string, dueOn:string|null}}}
 */
export function overallStatus({ contractStatus: cs, careerStatus: ks }) {
  if (!cs.ok) {
    const key = cs.key === "pending_signature" ? "contract_signing" : "contract_pending";
    return {
      key, label: OVERALL_STATES.find((s) => s.key === key).label,
      nextAction: {
        label: cs.key === "pending_signature" ? "本人の署名待ちです" : "契約条件を設定してください",
        dueOn: null,
      },
    };
  }
  if (!ks.ok) {
    const key = ks.key === "confirming" ? "career_confirming" : "career_setup";
    return {
      key, label: OVERALL_STATES.find((s) => s.key === key).label,
      nextAction: {
        label: ks.key === "confirming" ? "本人のキャリア確認待ちです" : "キャリアプランを設定してください",
        dueOn: null,
      },
    };
  }
  return {
    key: "completed", label: OVERALL_STATES.find((s) => s.key === "completed").label,
    nextAction: {
      label: ks.nextReviewOn ? `${slashDate(ks.nextReviewOn)} の次回評価まで待機` : "次回評価日まで待機",
      dueOn: ks.nextReviewOn || null,
    },
  };
}
