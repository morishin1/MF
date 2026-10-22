// 日報コーチ：朝 08:00（と 17:30 暫定・月曜の週次）の定時確認。
//
// ■ 何をするか
//   名簿の全員（社員・アルバイト・委託を含む）について、前の勤務日の日報と、次の勤務日の計画を照合し、
//   1人1行の確認結果（gw_coach_checks）を作る。提出イベントでは拾えない「出していない人」もここで見つかる。
//   提出済みの日報には、ルールで作った下書き（AI なし）を代表レビュー用に付ける（gw_coach_reviews）。
//   最後に、代表向け報告とチーム向け助言の送信候補（gw_coach_outbox）を作る。送信はしない。
//
// ■ 守ること（docs/behavior-coach.md）
//   ・分類は 順調 / 要確認 / 要対応 / 未確認 / 対象外。読めない・勤務日か決められない・期限前・不明は「未確認」か「対象外」。
//     「未提出違反」とは言わない（提出を確認できない、とだけ言う）
//   ・勤務日は本人の勤務曜日・会社休日・承認済み休暇から決める。勤務曜日が無ければ決めない（月〜金を補わない）
//   ・同じ版を読み直しても、新しい候補を作らない。変わったときだけ再レビュー（旧承認は SQL 側で失効）
//   ・日報・予定の本文は確認結果に写さない（ID・版・時刻・理由コードだけ）。予定は本文（body）もタイトルも読まない
//   ・新しい cron は作らない。既存の 08:00 の定期確認が POST /api/nippo/coach {action:"morning"} を呼ぶ
import { readAll, readIn } from "./pg-read.js";
import { digest, readCoachSources, validateAdvice, rpc, verifiedRoute } from "./behavior-coach.js";
import { addDays, isYmd, previousWorkday, nextWorkday, workdayStatus, rosterScope, REPORT_EXPECTED_TYPES, validWorkdays } from "./behavior-coach-days.js";
import { goalReviewsFromSources } from "./behavior-coach-goals.js";

export const MODES = ["morning", "provisional", "weekly"];
export const STATUS_LABEL = { ok: "順調", check: "要確認", action: "要対応", unconfirmed: "未確認", excluded: "対象外" };
const RANK = { excluded: 5, unconfirmed: 4, action: 3, check: 2, ok: 1 };
export const REASON_LABEL = {
  left_confirmed: "退職を確認済み", before_join: "入社前（入社後の勤務日なし）", after_left: "退職日以降",
  no_login_mapping: "ログインと社員の対応がない", invited_not_confirmed: "招待中（稼働を確認できない）",
  status_unknown: "在籍状態が不明", member_unavailable: "社員情報を読めない",
  ambiguous_report_owner: "日報の本人対応が複数ある（照合を停止）",
  workdays_unknown: "勤務曜日が未設定", leave_pending: "休暇申請が承認待ち", holiday_table_not_covered: "休日表の範囲外",
  not_found_within_search: "2週間以内に勤務日がない", not_workday: "本日は勤務日ではない", company_holiday: "会社休日", leave: "休暇",
  source_unavailable: "記録を読めない（取得失敗）", before_deadline: "提出期限前（暫定確認）",
  report_not_submitted: "日報の提出を確認できない（理由は未確認）", morning_only: "朝の入力のみ（夜の提出なし）",
  submission_scope_unknown: "雇用形態上、日報提出が契約範囲か未確認",
  no_plan_for_next_workday: "次勤務日の計画を確認できない", undone_without_reason: "未完了の理由が未記入",
  overdue_tasks: "期限超過のタスクがある", contract_period_outside: "有効な契約期間外の可能性",
  next_workday_unknown: "次の勤務日を決められない", latest_report_basis: "勤務曜日が未設定のため直近の提出日報で確認",
  weekly_missing_reports: "勤務日のうち提出を確認できない日がある", weekly_unknown_days: "勤務日か決められない日がある",
};
export const COACH_FLAGS = Object.freeze({ productionReady: false, semanticEvidenceVerified: false, sendEnabled: false });
const LOOKBACK = 16;
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const submitted = (n) => Boolean(n && n.submitted_at);

/**
 * 名簿と材料をまとめて読む（1表1回。.in は 100件ずつ）。読めない表は null にして、該当者を「未確認」にする。
 * 予定は ID・時刻・版だけ（title も body も読まない）。休暇は日付・種類・状態だけ。契約は種類・期間だけ。
 */
export async function readCheckInputs(sb, { tenantId, checkDate }) {
  const from = addDays(checkDate, -LOOKBACK), to = addDays(checkDate, 15);
  const employees = await readAll(() => sb.from("gw_employees")
    .select("id, tenant_id, user_id, display_name, status, employment_type, joined_on, left_on, updated_at")
    .eq("tenant_id", tenantId).order("id"));
  if (!employees) return { employees: null };
  const userIds = employees.map((e) => e.user_id).filter(Boolean);
  const [mapping, prefs, leaves, contracts, nippos, focus, events, tasks] = await Promise.all([
    // user → 社員 は全テナントで数える（tc_nippo に tenant 列が無い。2件以上なら照合しない）
    userIds.length ? readIn((part) => sb.from("gw_employees").select("id, tenant_id, user_id").in("user_id", part).order("id"), userIds) : [],
    readAll(() => sb.from("gw_reminder_prefs").select("employee_id, workdays, updated_at").eq("tenant_id", tenantId).order("employee_id")),
    readAll(() => sb.from("gw_requests").select("id, employee_id, leave_type, starts_on, ends_on, status, updated_at")
      .eq("tenant_id", tenantId).eq("kind", "leave").in("status", ["approved", "pending", "pending_owner"])
      .gte("ends_on", from).lte("starts_on", to).order("id")),
    readAll(() => sb.from("gw_contracts").select("id, employee_id, contract_type, period_from, period_to, updated_at")
      .eq("tenant_id", tenantId).eq("status", "active").order("id")),
    userIds.length ? readIn((part) => sb.from("tc_nippo").select("id, user_id, work_date, submitted_at, updated_at, top_priority, work_items, tomorrow_plan")
      .in("user_id", part).gte("work_date", from).lte("work_date", checkDate).order("id"), userIds) : [],
    readAll(() => sb.from("gw_tasks").select("id, assignee_id, focus_date, status, done_condition, updated_at")
      .eq("tenant_id", tenantId).gte("focus_date", from).lte("focus_date", to).neq("status", "cancelled").order("id")),
    readAll(() => sb.from("gw_calendar_events").select("id, employee_id, starts_at, updated_at")
      .eq("tenant_id", tenantId).eq("source", "self").neq("category", "private")
      .gte("starts_at", from + "T00:00:00+09:00").lt("starts_at", to + "T00:00:00+09:00").order("id")),
    readAll(() => sb.from("gw_tasks").select("id, assignee_id, due_on, status, updated_at")
      .eq("tenant_id", tenantId).in("status", ["todo", "doing"]).lt("due_on", checkDate).order("id")),
  ]);
  return { employees, mapping, prefs, leaves, contracts, nippos, focus, events, tasks };
}

const byKey = (rows, key) => {
  const m = new Map();
  for (const r of rows || []) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); }
  return m;
};
const jstDate = (ts) => new Date(Date.parse(ts) + 9 * 3600000).toISOString().slice(0, 10);

/**
 * 1人を分類する（純粋関数）。DB に書く前の形を返す。
 * @returns {{employeeId, name, status, reasons:string[], reportDate, nextWorkday, reviewable, refs:object[], workdayBasis, weekly?, bulkHash}}
 */
export function classifyPerson(emp, inputs, { checkDate, mode }) {
  const p = { employeeId: emp.id, name: emp.display_name || "", status: "ok", reasons: [], reportDate: null, nextWorkday: null,
    reviewable: false, refs: [{ id: "roster:" + emp.id, source: "gw_employees", version: emp.updated_at || null }],
    workdayBasis: null, employmentType: emp.employment_type || null };
  const set = (status, reason) => { if (RANK[status] > RANK[p.status]) p.status = status; if (reason && !p.reasons.includes(reason)) p.reasons.push(reason); };
  const done = () => ({ ...p, bulkHash: digest({ mode, status: p.status, reasons: p.reasons, reportDate: p.reportDate, nextWorkday: p.nextWorkday, refs: p.refs, weekly: p.weekly || null, content: p.content || null }) });

  const scope = rosterScope(emp, checkDate);
  if (scope.scope === "out") { set("excluded", scope.reason); return done(); }
  if (scope.scope === "unknown") { set("unconfirmed", scope.reason); return done(); }
  if (!inputs.mapping) { set("unconfirmed", "source_unavailable"); return done(); }
  const links = inputs.mapping.filter((m) => m.user_id === emp.user_id);
  if (links.length !== 1 || links[0].id !== emp.id || links[0].tenant_id !== emp.tenant_id) { set("unconfirmed", "ambiguous_report_owner"); return done(); }
  if (!inputs.prefs || !inputs.leaves || !inputs.nippos || !inputs.contracts) { set("unconfirmed", "source_unavailable"); return done(); }

  const pref = inputs.prefs.find((x) => x.employee_id === emp.id) || null;
  const leaves = inputs.leaves.filter((x) => x.employee_id === emp.id);
  const mine = inputs.nippos.filter((n) => n.user_id === emp.user_id);
  const nippoOn = new Map(mine.map((n) => [n.work_date, n]));
  const submittedDates = new Set(mine.filter(submitted).map((n) => n.work_date));
  const ctx = { workdays: pref?.workdays ?? null, leaves, submittedDates, joinedOn: emp.joined_on || null, leftOn: emp.left_on || null };
  p.refs.push({ id: "workdays:" + emp.id, source: "gw_reminder_prefs", value: validWorkdays(pref?.workdays), version: pref?.updated_at || null });
  for (const l of leaves) p.refs.push({ id: "leave:" + l.id, source: "gw_requests", status: l.status, from: l.starts_on, to: l.ends_on, version: l.updated_at || null });
  const contract = inputs.contracts.filter((c) => c.employee_id === emp.id);
  for (const c of contract) p.refs.push({ id: "contract:" + c.id, source: "gw_contracts", type: c.contract_type || null, from: c.period_from || null, to: c.period_to || null, version: c.updated_at || null });
  const reportRef = (d) => {
    const n = nippoOn.get(d);
    p.refs.push({ id: "report:" + d, source: "tc_nippo", targetDate: d, nippoId: n?.id || null, submittedAt: n?.submitted_at || null, updatedAt: n?.updated_at || null, version: n?.updated_at || null });
    return n;
  };
  if (inputs.tasks) {
    const overdue = inputs.tasks.filter((t) => t.assignee_id === emp.id);
    for (const t of overdue) p.refs.push({ id: "task:" + t.id, source: "gw_tasks", due: t.due_on, version: t.updated_at || null });
    if (overdue.length) set("action", "overdue_tasks");
  } else set("unconfirmed", "source_unavailable");

  // ---- 週次：先週7日の勤務日と提出 ----
  if (mode === "weekly") {
    const w = { workdays: 0, submitted: 0, missing: 0, unknown: 0 };
    for (let i = 7; i >= 1; i--) {
      const d = addDays(checkDate, -i), s = workdayStatus(d, ctx);
      if (s.work === true) { w.workdays++; if (submittedDates.has(d)) w.submitted++; else w.missing++; }
      else if (s.work === null) w.unknown++;
    }
    p.weekly = w;
    for (const d of submittedDates) if (d >= addDays(checkDate, -7) && d < checkDate) reportRef(d);
    if (w.missing) set(REPORT_EXPECTED_TYPES.has(emp.employment_type) ? "check" : "unconfirmed", REPORT_EXPECTED_TYPES.has(emp.employment_type) ? "weekly_missing_reports" : "submission_scope_unknown");
    if (w.unknown) set(w.missing ? "check" : "unconfirmed", "weekly_unknown_days");
    return done();
  }

  // ---- 対象の日報の日（R）を決める ----
  let R = null;
  if (mode === "provisional") {
    const s = workdayStatus(checkDate, ctx);
    if (s.work === false) { set("excluded", s.reason); return done(); }
    if (s.work === null) { set("unconfirmed", s.reason); return done(); }
    R = checkDate;
  } else {
    const prev = previousWorkday(checkDate, ctx);
    if (prev.date) R = prev.date;
    else if (prev.reason === "before_join") { set("excluded", "before_join"); return done(); }
    else if (prev.reason === "workdays_unknown") {
      // 勤務曜日が無い人：出していない日を「勤務日」と決められない。直近7日の提出済み日報だけを確認する
      const latest = [...submittedDates].filter((d) => d < checkDate && d >= addDays(checkDate, -7)).sort().pop();
      if (!latest) { set("unconfirmed", "workdays_unknown"); return done(); }
      R = latest; p.workdayBasis = "latest_submitted_report"; set("check", "latest_report_basis");
    } else { set("unconfirmed", prev.reason); return done(); }
  }
  p.reportDate = R;
  const n = reportRef(R);
  for (const c of contract) if (c.period_to && c.period_to < R) set("check", "contract_period_outside");

  if (submitted(n)) {
    p.reviewable = true;
    p.content = digest({ top: n.top_priority || null, items: n.work_items || null, plan: n.tomorrow_plan || null });
    const items = Array.isArray(n.work_items) ? n.work_items : [];
    if (items.some((w) => w && clip(w.task, 500) && !(w.done === true || clip(w.result, 500)) && !clip(w.undone_reason, 500))) set("check", "undone_without_reason");
  } else if (mode === "provisional") { set("unconfirmed", "before_deadline"); }
  else if (!REPORT_EXPECTED_TYPES.has(emp.employment_type)) { set("unconfirmed", "submission_scope_unknown"); }
  else { set("check", "report_not_submitted"); if (n) p.reasons.push("morning_only"); }

  // ---- 次の勤務日（P）と、その計画があるか ----
  const next = nextWorkday(R, ctx);
  p.nextWorkday = next.date;
  if (!next.date) { set("check", "next_workday_unknown"); return done(); }
  const P = next.date;
  const focus = (inputs.focus || []).filter((t) => t.assignee_id === emp.id && t.focus_date === P);
  const events = (inputs.events || []).filter((e) => e.employee_id === emp.id && jstDate(e.starts_at) === P);
  for (const t of focus) p.refs.push({ id: "focus:" + t.id, source: "gw_tasks", targetDate: P, version: t.updated_at || null });
  for (const e of events) p.refs.push({ id: "schedule:" + e.id, source: "gw_calendar_events", targetDate: P, version: e.updated_at || null });
  const morningP = P <= checkDate ? nippoOn.get(P) : null;
  if (morningP) p.refs.push({ id: "plan-entry:" + P, source: "tc_nippo", targetDate: P, nippoId: morningP.id, version: morningP.updated_at || null });
  const hasPlan = Boolean(clip(n?.tomorrow_plan, 2000)) || focus.length > 0 || events.length > 0
    || Boolean(morningP && (clip(morningP.top_priority, 300) || (morningP.work_items || []).length));
  if (inputs.focus === null || inputs.events === null) set("unconfirmed", "source_unavailable");
  else if (!hasPlan && p.reviewable) set("check", "no_plan_for_next_workday");
  return done();
}

/** ルールだけで作る、代表レビュー用の下書き（AI なし）。根拠は readCoachSources の facts の ID だけを使う */
export function buildRulesDraft(person, sources, { epoch, checkedAt }) {
  const reportId = "report:" + sources.reportDate;
  const { goals, results, skipped } = goalReviewsFromSources(sources, { checkedAt, scopeConfirmed: false });
  const facts = new Set(sources.facts.map((f) => f.id));
  const points = [];
  const doneItem = results.find((r) => r.done);
  if (doneItem) points.push({ kind: "good", refs: [reportId],
    text: `前勤務日に「${clip(doneItem.task, 40)}」を完了と報告しています。${doneItem.target != null && doneItem.unit ? `件数（${doneItem.target}${doneItem.unit}）を決めてから進めた点` : "計画に書いた作業を進めた点"}を次も続けましょう。` });
  // 期限超過は、定時確認が数えたタスク（確認日より前が期限の未完了）のうち、下書きの根拠に入っているものだけ
  const overdue = person.refs.filter((r) => r.id.startsWith("task:") && facts.has(r.id));
  const focusNoCond = sources.facts.find((f) => f.id.startsWith("focus:") && !clip(f.value?.done_condition, 500));
  const undone = results.find((r) => !r.done && !r.undoneReasonGiven);
  const noUnit = results.find((r) => r.unitMissing);
  const noCompletion = goals.find((g) => g.source === "previous_workday_report" && !g.review.goal.completionCriteria);
  let change = null;
  if (person.reasons.includes("overdue_tasks") && overdue.length) change = { refs: overdue.slice(0, 3).map((f) => f.id), text: "期限を過ぎたタスクの扱い（完了・期限の見直し・相談）を、次勤務日の最初に決めましょう。" };
  else if (person.reasons.includes("no_plan_for_next_workday")) change = { refs: [reportId], text: "次勤務日の最優先を1つ決め、「何を完了するか」を1行で書いてから始めましょう。" };
  else if (focusNoCond) change = { refs: [focusNoCond.id], text: `「${clip(focusNoCond.value.title, 40)}」の完了条件（どこまでできたら完了か）を1行で決めてから着手しましょう。` };
  else if (undone) change = { refs: [reportId], text: `未完了の「${clip(undone.task, 40)}」に、理由と次の一手を一言残しましょう。` };
  else if (noUnit) change = { refs: [reportId], text: `「${clip(noUnit.task, 40)}」の件数に単位（件・社など）を添えましょう。` };
  else if (noCompletion) change = { refs: [reportId], text: `「${clip(noCompletion.review.goal.task, 40)}」に完了条件を1行添えましょう。` };
  if (change && change.refs.every((id) => facts.has(id))) points.push({ kind: "change", ...change });
  if (facts.has(reportId)) points.push({ kind: "review", refs: [reportId], text: "次の日報で、計画に対する実績と変更理由を一言で振り返りましょう。" });
  const needsContact = person.status !== "ok" && points.some((x) => x.kind === "change");
  const reason = person.reasons.map((r) => REASON_LABEL[r] || r).join(" / ") || "確認事項なし";
  const advice = validateAdvice({ points: points.slice(0, 3), needsContact, reason: reason.slice(0, 800) }, sources);
  const KIND = { good: "良かった行動", change: "次勤務日に変える1つ", review: "次回振り返り" };
  const draft = { classification: STATUS_LABEL[person.status], status: person.status, model: "rules-only", points: advice.points, reason: advice.reason,
    missing: sources.missing, needsContact, ownerReviewRequired: person.status !== "ok",
    text: "【EIGHT秘書P・下書き（ルール作成／代表確認前）】\n" + advice.points.map((x) => `${KIND[x.kind]}：${x.text}`).join("\n"),
    sourceHash: sources.sourceHash, epoch, checkedAt, sources: sources.facts.map(({ id, kind }) => ({ id, kind })),
    goals: goals.map((g) => ({ source: g.source, ref: g.ref, review: g.review })), results, goalSkipped: skipped, ...COACH_FLAGS };
  return draft;
}

/** チーム向け助言に、個人が分かる情報が入っていないか。名前・メール・ID・メンション・数字を拒む */
export function assertTeamSafe(text, names = []) {
  const t = String(text || "");
  const bad = /[0-9０-９]|@|<@|[0-9a-f]{8}-[0-9a-f]{4}/i.test(t) || names.some((n) => n && n.trim().length >= 2 && t.includes(n.trim()));
  if (bad || !t.trim() || t.length > 1500) throw new Error("team_text_unsafe");
  return t;
}

/**
 * チーム向け（承認済みの日報チャンネル）の助言。個人名・件数・本文は入れない。
 * 2人以上に共通する傾向だけを、決まった文から選ぶ（1人だけの事情を全体に出さない）。
 */
export function buildTeamAdvice(people) {
  const counted = people.filter((x) => ["ok", "check", "action"].includes(x.status));
  const n = (code) => counted.filter((x) => x.reasons.includes(code)).length;
  const tips = [];
  if (n("no_plan_for_next_workday") >= 2) tips.push("次勤務日の最優先をひとつ決め、「何を完了するか」を一行で書いてから始めましょう。");
  if (n("undone_without_reason") >= 2) tips.push("未完了の項目には、理由と次の一手を一言残しましょう（責めるためではなく、次の計画に活かすためです）。");
  if (n("overdue_tasks") >= 2) tips.push("期限を過ぎたタスクは、完了・期限の見直し・相談のどれにするかを朝のうちに決めましょう。");
  if (!tips.length) return null;
  return "【日報コーチ・チーム向けのヒント（代表承認済みのみ送信）】\n" + tips.slice(0, 3).map((t) => "・" + t).join("\n")
    + "\n※個人の評価ではありません。予定は計画であり、変更そのものは問題ではありません。";
}

/** 代表向け報告（代表の Slack DM）。名前と分類・理由の定型文だけ。日報・予定の本文は入れない */
export function buildOwnerReport(summary, people, { checkDate, mode, appPath = "/admin-nippo-coach.html" }) {
  const modeLabel = { morning: "朝の確認", provisional: "17:30 暫定確認", weekly: "週次確認" }[mode];
  const lines = [`【日報コーチ ${modeLabel}】${checkDate}`,
    `名簿 ${summary.total}名：順調 ${summary.ok} / 要確認 ${summary.check} / 要対応 ${summary.action} / 未確認 ${summary.unconfirmed} / 対象外 ${summary.excluded}`];
  for (const st of ["action", "check", "unconfirmed"]) {
    const list = people.filter((x) => x.status === st);
    if (!list.length) continue;
    lines.push(`${STATUS_LABEL[st]}：` + list.slice(0, 15).map((x) => `${x.name}（${x.reasons.slice(0, 2).map((r) => REASON_LABEL[r] || r).join("・")}）`).join("、") + (list.length > 15 ? `ほか${list.length - 15}名` : ""));
  }
  lines.push(`詳細・下書きの確認と承認：${appPath}`, "※未確認は本人の問題ではありません。AIや自動判定だけを評価の根拠にしません。本人への連絡は代表の個別承認後です。");
  return lines.join("\n").slice(0, 3000);
}

export function summarize(people) {
  const s = { total: people.length, ok: 0, check: 0, action: 0, unconfirmed: 0, excluded: 0 };
  for (const x of people) s[x.status]++;
  s.checked = s.ok + s.check + s.action;
  s.consistent = s.checked + s.unconfirmed + s.excluded === s.total;
  return s;
}

/** 宛先（config の値だけ。コードに ID を書かない）。未設定なら null＝送信候補は blocked のまま */
export function outboxTarget(kind, config) {
  if (!config?.slack_team_id) return null;
  // 代表 DM は「この bot と代表の 1:1」の ID（owner_dm_channel_id）。別 App の bot の DM には送れないので、
  // 送信前に Slack の preflight で、その DM が代表1人との 1:1 であることを確かめる（lib/behavior-coach-delivery.js）
  if (kind === "owner_report") return config.owner_slack_user_id && config.owner_dm_channel_id
    ? { kind: "owner_dm", teamId: config.slack_team_id, userId: config.owner_slack_user_id, channelId: config.owner_dm_channel_id } : null;
  if (kind === "team_advice") return config.team_channel_id ? { kind: "team_channel", teamId: config.slack_team_id, channelId: config.team_channel_id } : null;
  return null;
}

/**
 * 定時確認の本体。名簿全員の確認行・下書き・送信候補を、冪等に作る／更新する。送信はしない。
 * @param {{tenantId:string, checkDate:string, mode?:string, config:object, force?:boolean, now?:()=>Date}} opts
 */
export async function runCoachCheck(sb, { tenantId, checkDate, mode = "morning", config, force = false, dryRun = false, now = () => new Date() }) {
  if (!isYmd(checkDate) || !MODES.includes(mode)) throw new Error("invalid_check");
  const inputs = await readCheckInputs(sb, { tenantId, checkDate });
  if (!inputs.employees) throw new Error("roster_unreadable");
  const prior = await readAll(() => sb.from("gw_coach_checks").select("employee_id, source_hash, detail")
    .eq("tenant_id", tenantId).eq("check_date", checkDate).eq("mode", mode).order("employee_id"));
  const priorBy = new Map((prior || []).map((r) => [r.employee_id, r]));
  const people = inputs.employees.map((e) => classifyPerson(e, inputs, { checkDate, mode }));
  const counts = { created: 0, changed: 0, unchanged: 0, reviewsWritten: 0, reviewsUnchanged: 0, reviewErrors: 0 };
  const checkedAt = now().toISOString();
  const persons = [];
  const view = (person, res = null) => ({ employeeId: person.employeeId, name: person.name, status: person.status, statusLabel: STATUS_LABEL[person.status],
    reasons: person.reasons.map((code) => ({ code, label: REASON_LABEL[code] || code })), reportDate: person.reportDate, nextWorkday: person.nextWorkday,
    workdayBasis: person.workdayBasis, weekly: person.weekly || null, refs: person.refs,
    check: res?.check || null, review: res?.review || null, reviewId: res?.review_id || null });
  if (dryRun) {
    // 読むだけ。確認行・下書き・送信候補は作らない（lease も取らない）
    return { checkDate, mode, dryRun: true, summary: summarize(people), persons: people.map((x) => view(x)), deliveryEnabled: false, ...COACH_FLAGS };
  }
  for (const person of people) {
    const old = priorBy.get(person.employeeId);
    let hash = person.bulkHash, review = null, goals = null;
    if (!force && old && old.detail?.bulkHash === person.bulkHash) {
      hash = old.source_hash;   // 同じ版：確認時刻だけ進める（候補は作らない）
    } else if (person.reviewable && mode !== "weekly") {
      try {
        const row = { tenant_id: tenantId, employee_id: person.employeeId, report_date: person.reportDate };
        const sources = await readCoachSources(sb, row);
        const epoch = (mode === "provisional" ? "provisional:" : "final:") + person.reportDate;
        const draft = buildRulesDraft(person, sources, { epoch, checkedAt });
        try {
          const { data: route, error } = await sb.from("gw_coach_recipients").select("*").eq("tenant_id", tenantId).eq("employee_id", person.employeeId).maybeSingle();
          if (error) throw new Error("recipient_unverified");
          draft.target = verifiedRoute(route, row); draft.targetHash = digest(draft.target);
        } catch { draft.target = null; draft.targetHash = null; draft.routeIssue = "recipient_unverified"; }
        draft.id = digest({ ...draft, id: undefined });
        review = { state: draft.needsContact ? "owner_review" : "no_action", epoch, draft };
        goals = draft.goals.length;
        hash = digest({ bulk: person.bulkHash, review: sources.sourceHash });
      } catch {
        // 読めなければ「未確認」。本人の問題にしない
        person.status = "unconfirmed"; person.reasons.push("source_unavailable"); person.reviewable = false;
        hash = digest({ bulk: person.bulkHash, unavailable: true });
        counts.reviewErrors++;
      }
    }
    const detail = { bulkHash: person.bulkHash, reasons: person.reasons, refs: person.refs, workdayBasis: person.workdayBasis,
      employmentType: person.employmentType, weekly: person.weekly || null, goals, checkedAt, ...COACH_FLAGS };
    const res = await rpc(sb, "gw_coach_record_check", { p_tenant_id: tenantId, p_employee_id: person.employeeId, p_check_date: checkDate, p_mode: mode,
      p_status: person.status, p_report_date: person.reportDate, p_next_workday: person.nextWorkday, p_source_hash: hash, p_detail: detail, p_review: review });
    if (res?.check === "disabled") throw new Error("coach_disabled");
    if (res?.check in counts) counts[res.check]++;
    if (res?.review === "written") counts.reviewsWritten++;
    if (res?.review === "unchanged") counts.reviewsUnchanged++;
    persons.push(view(person, res));
  }
  const summary = summarize(people);
  const sourceHash = digest(people.map((x) => [x.employeeId, x.status, x.reasons]));
  const outbox = {};
  const drafts = [["owner_report", buildOwnerReport(summary, people, { checkDate, mode })]];
  if (mode === "morning") {
    const team = buildTeamAdvice(people);
    if (team) drafts.push(["team_advice", assertTeamSafe(team, inputs.employees.map((e) => e.display_name))]);
  }
  for (const [kind, body] of drafts) {
    const target = outboxTarget(kind, config);
    const r = await rpc(sb, "gw_coach_outbox_upsert", { p_tenant_id: tenantId, p_kind: kind, p_check_date: checkDate, p_mode: mode, p_body: body,
      p_body_hash: digest(body), p_target: target, p_target_hash: target ? digest(target) : null, p_source_hash: sourceHash });
    outbox[kind] = r?.outbox || null;
  }
  return { checkDate, mode, dryRun: false, summary, ...counts, outbox, persons, deliveryEnabled: false, ...COACH_FLAGS };
}
