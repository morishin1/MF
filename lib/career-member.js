// 本人に見せる「あなたの契約・キャリア」を組み立てる。
//
// api/career/me.js（本人）と、api/career?preview=…（管理者の「本人画面をプレビュー」）の
// 両方がこれを使う。だからプレビューは本人の画面と同じものになる。
//
// ■ 本人に見せるもの・見せないもの（§32）
//   見せる   … 現在の契約条件（active 契約）・現在のLevel・次Levelの条件と給与レンジ・進捗・
//              次回評価日・1年後/3年後・できるようになったこと・確定済みの評価・確認依頼
//   見せない … 管理者メモ（manager_note）・給与の調整メモ（salary_note）・下書きの評価・
//              システム判定・他の社員
//   進捗は「確定済み」の評価だけから作る。
//
// ■ 契約とキャリアは別
//   契約書は電子署名（gw_sign_requests）。キャリアプランは「確認しました」だけ（法的な署名ではない）。
// ■ 給与レンジは「目安」。必ず RANGE_NOTE を添える（保証ではない）。

import {
  nextLevelOf, horizonLevel, progressOf, rangeText, confirmPending,
  CRITERION_RESULTS, REVIEW_RESULTS, RANGE_NOTE, TIMELINE_NOTE, CONTRACT_DOC_KINDS,
} from "./career.js";

const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
const soft = async (q) => { try { const { data, error } = await q; return error ? null : data; } catch { return null; } };

/** 本人に見せる Level の形。役割と、給与レンジ（目安）だけ */
export const memberLevelView = (l) => (l ? {
  id: l.id, levelNo: l.level_no, levelName: l.level_name, roleSummary: l.role_summary,
  expectedRole: l.expected_role, nextLevelSummary: l.next_level_summary, typicalMonths: l.typical_months,
  salaryRange: rangeText(l),
} : null);

/** 本人に見せる契約の形（active）。給与は常にここから読む */
export const memberContractView = (c) => (c ? {
  contractType: c.contract_type || null, wageType: c.wage_type || null, wageAmount: c.wage_amount ?? null,
  periodFrom: c.period_from || null, periodTo: c.period_to || null, fixedTerm: c.fixed_term ?? null,
  probationMonths: c.probation_months ?? null, probationEnd: c.probation_end || null,
  workHours: c.work_hours || null,
} : null);

export async function careerOf(sb, tenantId, employeeId) {
  const careers = await must(sb.from("gw_employee_careers").select("*").eq("tenant_id", tenantId)
    .eq("employee_id", employeeId).eq("is_active", true));
  const c = careers?.[0] || null;
  if (!c) return { c: null };
  const [track, levels] = await Promise.all([
    must(sb.from("gw_career_tracks").select("*").eq("id", c.track_id).eq("tenant_id", tenantId).maybeSingle()),
    must(sb.from("gw_career_levels").select("*").eq("tenant_id", tenantId).eq("track_id", c.track_id)
      .order("level_no", { ascending: true })),
  ]);
  const byId = new Map((levels || []).map((l) => [l.id, l]));
  const cur = byId.get(c.current_level_id) || null;
  const next = byId.get(c.target_level_id) || nextLevelOf(levels, cur);
  const criteria = next ? (await must(sb.from("gw_career_criteria").select("*").eq("tenant_id", tenantId)
    .eq("level_id", next.id).order("sort_order", { ascending: true }))).filter((x) => x.is_active !== false) : [];
  return { c, track, levels: levels || [], cur, next, criteria };
}

/** active 契約（新しいもの1つ） */
export async function activeContract(sb, tenantId, employeeId) {
  const rows = await soft(sb.from("gw_contracts").select("*")
    .eq("tenant_id", tenantId).eq("employee_id", employeeId).eq("status", "active")
    .order("created_at", { ascending: false }).limit(1));
  return rows?.[0] || null;
}

/** 本人の署名待ちの契約書（雇用契約だけ）。中身は contracts.html で読む */
export async function pendingContractSigns(sb, tenantId, employeeId) {
  const rows = await soft(sb.from("gw_sign_requests").select("id, title, doc_kind, status, due_on, sent_at")
    .eq("tenant_id", tenantId).eq("employee_id", employeeId).eq("status", "sent")
    .order("sent_at", { ascending: false }).limit(20));
  return (rows || []).filter((r) => CONTRACT_DOC_KINDS.includes(r.doc_kind));
}

/**
 * @param {object} sb   service_role のクライアント
 * @param {{tenantId:string, employee:{id:string}, userId:string|null}} who
 */
export async function memberCareerView(sb, { tenantId, employee, userId }) {
  const { c, track, levels, cur, next, criteria } = await careerOf(sb, tenantId, employee.id);
  // できるようになったことは auth.users.id で持っている（db/031）。本人のものだけ
  const history = userId ? await soft(sb.from("gw_growth_history").select("happened_on, title, source")
    .eq("user_id", userId).order("happened_on", { ascending: false }).limit(30)) : [];
  const growthHistory = (history || []).map((h) => ({ on: h.happened_on, title: h.title }));
  const [contract, signs] = await Promise.all([
    activeContract(sb, tenantId, employee.id),
    pendingContractSigns(sb, tenantId, employee.id),
  ]);
  const contractSign = {
    pending: signs.map((s) => ({ id: s.id, title: s.title, dueOn: s.due_on, sentAt: s.sent_at })),
    link: "contracts.html",
  };

  if (!c) {
    return {
      career: null,
      message: "キャリアはまだ設定されていません。上長との初回キャリア面談のあとで表示されます。",
      contract: memberContractView(contract),
      currentWage: contract ? { wageType: contract.wage_type, wageAmount: contract.wage_amount } : null,
      contractSign,
      confirm: { pending: false, requestedAt: null, confirmedAt: null },
      growthHistory,
    };
  }

  // 確定済みの評価だけ（下書きは本人に見せない）
  const reviews = await must(sb.from("gw_career_reviews")
    .select("id, status, result, target_level_id, from_level_id, criterion_results, manager_comment, employee_comment, review_period_from, review_period_to, decided_at")
    .eq("tenant_id", tenantId).eq("employee_id", employee.id).eq("status", "confirmed")
    .order("decided_at", { ascending: false }).limit(10));
  const last = (reviews || [])[0] || null;
  const results = last && next && last.target_level_id === next.id ? last.criterion_results : [];
  const progress = next ? progressOf(criteria, results) : null;

  const oneYear = horizonLevel(levels, cur, 12);
  const threeYear = horizonLevel(levels, cur, 36);
  const levelById = new Map(levels.map((l) => [l.id, l]));

  return {
    career: {
      trackName: track?.name || null,
      nextReviewOn: c.next_review_on,
      oneYearTargetNote: c.one_year_target_note,
      threeYearTargetNote: c.three_year_target_note,
      employeeWish: c.employee_wish,
      agreed: Boolean(c.agreed_at),
    },
    currentLevel: memberLevelView(cur),
    nextLevel: memberLevelView(next),
    contract: memberContractView(contract),
    currentWage: contract ? { wageType: contract.wage_type, wageAmount: contract.wage_amount } : null,
    contractSign,
    confirm: {
      pending: confirmPending(c),
      requestedAt: c.confirm_requested_at || null,
      confirmedAt: c.employee_confirmed_at || null,
    },
    rangeNote: RANGE_NOTE,
    progress: progress ? {
      achieved: progress.achieved, total: progress.total,
      categories: progress.categories.map((g) => ({ category: g.category, achieved: g.achieved, total: g.total,
        items: g.items.map((i) => ({ id: i.id, title: i.title, status: i.status, required: i.required })) })),
      // 次のLevelまで、あと何をすればよいか（最優先で見せる）
      remaining: progress.remaining.map((i) => ({ id: i.id, category: i.category, title: i.title,
        description: i.description, status: i.status, required: i.required })),
    } : null,
    horizon: {
      oneYear: { level: memberLevelView(oneYear), goal: track?.one_year_goal || null },
      threeYear: { level: memberLevelView(threeYear), goal: track?.three_year_goal || null },
      note: TIMELINE_NOTE,
    },
    growthHistory,
    lastReview: last ? {
      decidedAt: last.decided_at, result: last.result,
      periodFrom: last.review_period_from, periodTo: last.review_period_to,
      managerComment: last.manager_comment, employeeComment: last.employee_comment,
      fromLevel: memberLevelView(levelById.get(last.from_level_id)),
      targetLevel: memberLevelView(levelById.get(last.target_level_id)),
      achieved: (last.criterion_results || []).filter((x) => x.result === "achieved").length,
      total: (last.criterion_results || []).filter((x) => x.result !== "na").length,
    } : null,
    labels: { criterionResults: CRITERION_RESULTS, reviewResults: REVIEW_RESULTS },
  };
}
