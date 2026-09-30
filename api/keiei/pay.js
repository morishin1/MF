// GET  /api/keiei/pay?view=list                       … 社員ごとの、いまの給与（一覧）
// GET  /api/keiei/pay?view=detail&employeeId=…        … 1人の、いまの給与・履歴・契約などとの突き合わせ・監査ログ
// GET  /api/keiei/pay?view=audit[&employeeId=…][&before=…]  … 給与管理の監査ログ（新しい順）
// GET  /api/keiei/pay?view=candidates                 … 初回給与の候補（未登録の人ごとに、契約・内定・届出から作る。登録はしない）
// POST /api/keiei/pay {action, employeeId, …}         … 給与を記録する（追記だけ）
//
//   preview_record  {…fields}   記録したらどうなるか（種別・版・変更前後・注意）を返す。書かない
//   record          {…fields, basisId?}   記録する。変更（新しい適用開始日）か、訂正（correct:true）
//
//   fields: effectiveFrom, wageType, baseAmount, allowances[{name,amount}], commuteAmount, commuteNote,
//           reason（必須）, source（owner / contract_import / offer_import）, correct,
//           candidate（true … 初回給与の「候補」から入れた。サーバが基準を作り直して basis に残す）
//
// ■ 権限
//   経営者（owner）だけ・二段階認証つき（lib/keiei-gate.js）。人事・管理者・責任者・採用担当・経理などは 403。
//   DB も同じ（db/105: gw_is_owner ＋ 本人は自分の行だけ）。この API は service_role で読むので、入口が関門。
//   既存のHR側の給与の権限（gw_can_see_salary）は、この工程では変えない（給与の段階2は別工程）。
//
// ■ 履歴が必ず残る（db/105 のトリガが止める）
//   この API には、更新・削除の入口が無い。給与を変える＝新しい適用開始日の行を足す。
//   入力の誤りを直す＝同じ適用開始日の「次の版」を足す（前の版も残る）。理由は必須。
//
// ■ 監査
//   記録の追加は、DB のトリガが gw_pay_audit に自動で書く。開いた（一覧・個人・監査）は、ここで書く。
//   書けなければ、給与は返さない（「見せたのに、残っていない」を作らない）。
//   gw_activity_log には書かない（あちらは管理者も読める）。
//
// ■ 既存の表へは書かない（Single Source of Truth）
//   契約（gw_contracts）・内定（gw_hr_pay 等）・入社情報の届出は「参照」だけ。読んで、食い違いを見せる。
//   給与の額を直す場所は、この画面ひとつ。契約の賃金は、契約書のほうで更新する。
//
// ■ 初回給与の「候補」（自動登録はしない）
//   契約・内定・本人の届出から、候補を作って見せるだけ（lib/compensation-candidate.js）。経営者が
//   確認 → 修正 → 理由入力 → 登録 する。登録のとき、どのデータを基準にしたか・どの項目を直したかを basis に残す。
//   候補は最初の記録にだけ使える（すでに記録がある人には使えない）。適用開始日は決めない。
//
// ■ unit_price は扱わない
//   PP・BP の現場単価は、給与ではない。BP（employee_kind=bp）は対象外にする。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireKeiei } from "../../lib/keiei-gate.js";
import { admin } from "../../lib/supabase.js";
import { readAll, readIn } from "../../lib/pg-read.js";
import { paySplit } from "../../lib/hr-pay.js";
import { buildCandidate, basisOf, sourceOf, describeBasis } from "../../lib/compensation-candidate.js";
import {
  normalizeRecordInput, planRecord, viewOf, snapshotOf, diffSnapshots, currentAt, upcomingAfter, historyGroups,
  contractCheck, statusFlags, auditView, todayJst, WAGE_TYPES, KIND_LABEL, SOURCE_LABEL,
  ALLOWANCE_PRESETS, LIMITS,
} from "../../lib/compensation.js";

const SQL = "db/105_compensation.sql";
const VIEWS = ["list", "detail", "audit", "candidates"];
const ACTIONS = ["preview_record", "record"];
const CURRENT = ["active", "leaving"];
const REC_COLS = "id, employee_id, effective_from, revision, kind, source, wage_type, base_amount, allowances, commute_amount, "
  + "commute_note, contract_id, contract_wage_type, contract_wage_amount, reason, before, basis, created_by_name, created_at";
const AUDIT_COLS = "id, ts, action, actor_name, employee_id, record_id, detail";
const AUDIT_PAGE = 200;

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const gate = await requireKeiei(req, res);
  if (!gate) return;
  const { user, ctx } = gate;

  try {
    const sb = admin();
    const probe = await tablesReady(sb, ctx);
    if (probe.error) return json(res, 500, { error: "db_read_failed", detail: probe.error.message });
    if (probe.missing) {
      // 表がまだ無い。給与は空のまま「未連携」と伝える（0 円とは言わない）
      if (req.method === "GET") return json(res, 200, { linked: false, hint: probe.hint });
      return json(res, 503, { error: "not_ready", message: probe.hint });
    }

    if (req.method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const view = q.get("view") || "list";
      if (!VIEWS.includes(view)) return json(res, 400, { error: "invalid_view", views: VIEWS });
      if (view === "list") return await listView({ sb, res, ctx, user });
      if (view === "candidates") return await candidatesView({ sb, res, ctx, user });
      if (view === "audit") return await auditPage({ sb, res, ctx, user, employeeId: q.get("employeeId") || null, before: q.get("before") || null });
      const employeeId = String(q.get("employeeId") || "");
      if (!employeeId) return json(res, 400, { error: "invalid_query", required: ["employeeId"] });
      return await detailView({ sb, res, ctx, user, employeeId });
    }

    const body = (await readJson(req)) || {};
    const action = String(body.action || "");
    if (!ACTIONS.includes(action)) return json(res, 400, { error: "invalid_action", actions: ACTIONS });
    const employeeId = String(body.employeeId || "");
    if (!employeeId) return json(res, 400, { error: "invalid_body", required: ["employeeId"] });
    return await recordAction({ sb, res, ctx, user, body, employeeId, dry: action === "preview_record" });
  } catch (e) {
    console.error("[keiei/pay]", e?.message || e);
    return json(res, 500, { error: "keiei_pay_failed", detail: String(e?.message || e) });
  }
}

// ---- 下ごしらえ -----------------------------------------------------------------

/** 給与の履歴の表と監査ログの表が使えるか。どちらか1つでも無ければ「未連携」 */
async function tablesReady(sb, ctx) {
  for (const t of ["gw_compensations", "gw_pay_audit"]) {
    let r;
    try { r = await sb.from(t).select("id").eq("tenant_id", ctx.tenantId).limit(1); } catch (e) { return { error: e }; }
    if (r?.error) {
      const hint = dbSetupHint(r.error, SQL);
      return hint ? { missing: true, hint } : { error: r.error };
    }
  }
  return {};
}

const soft = async (q) => { try { const { data, error } = await q; return error ? null : data; } catch { return null; } };
const num = (v) => (v == null || v === "" ? null : Number(v));

async function loadEmployee(sb, ctx, employeeId) {
  // employee_kind は 075（BP）の列。未適用でも読めるように、無ければ外して読み直す
  for (const cols of ["id, display_name, email, department, position, employment_type, employee_kind, status, joined_on",
    "id, display_name, email, department, position, employment_type, status, joined_on"]) {
    const { data, error } = await sb.from("gw_employees").select(cols).eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!error) return data || null;
  }
  return null;
}

const empView = (e) => ({
  id: e.id, name: e.display_name, department: e.department || null, position: e.position || null,
  employmentType: e.employment_type || null, status: e.status, joinedOn: e.joined_on || null, isBp: e.employee_kind === "bp",
});

/** その人の全記録（viewOf 済み）。読み切れなければ null（一部だけで「いまの給与」を決めない） */
const recordsOf = async (sb, ctx, employeeId) => {
  const rows = await readAll(() => sb.from("gw_compensations").select(REC_COLS)
    .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId).order("effective_from").order("revision"));
  return rows ? rows.map(viewOf) : null;
};

/**
 * 有効な契約（社員ごとに、いちばん新しい1件と、有効な契約の件数。人件費・給与CSVと同じ選び方）。
 * 読み切れなければ null（一部だけで「契約が無い」と言わない）
 */
async function contractsOf(sb, ctx, ids) {
  const rows = await readIn((part) => sb.from("gw_contracts")
    .select("id, employee_id, contract_type, period_from, period_to, wage_type, wage_amount, wage_note, created_at")
    .eq("tenant_id", ctx.tenantId).eq("status", "active").in("employee_id", part)
    .order("created_at", { ascending: false }).order("id"), ids);
  if (rows === null) return null;
  const out = new Map();
  for (const r of rows) {
    const cur = out.get(r.employee_id);
    if (!cur) out.set(r.employee_id, { row: r, count: 1 }); else cur.count += 1;   // 新しい順なので、最初の1件がいちばん新しい
  }
  return out;
}

async function contractOf(sb, ctx, employeeId) {
  const m = await contractsOf(sb, ctx, [employeeId]);
  if (m === null) return { unknown: true, row: null, count: 0 };
  const e = m.get(employeeId);
  return { unknown: false, row: e?.row || null, count: e?.count || 0 };
}

/** 本人が届け出た定期代（社員ごと）。読み切れなければ null */
async function declaredCommutes(sb, ctx, ids) {
  const rows = await readIn((part) => sb.from("gw_onboard_profiles").select("employee_id, commute_cost")
    .eq("tenant_id", ctx.tenantId).in("employee_id", part).order("employee_id"), ids);
  if (rows === null) return null;
  return new Map(rows.map((r) => [r.employee_id, num(r.commute_cost)]));
}

/**
 * 内定時の給与（社員ごと。参照のみ）。分離の設定（HR_PAY_SPLIT）に合わせて、元の列か gw_hr_pay から読む。
 * オファー単位の給与を優先し、無ければ応募者の条件。読めなかった社員は、載せない（参照は補助なので、止めない）
 */
async function offerRefsOf(sb, ctx, ids) {
  const out = new Map();
  const split = paySplit();
  const wageCols = split ? "" : ", wage_type, wage_amount";
  const apps = await readIn((part) => sb.from("gw_hr_applicants").select(`id, employee_id${wageCols}`)
    .eq("tenant_id", ctx.tenantId).in("employee_id", part).order("id"), ids);
  if (!apps || !apps.length) return out;
  const appIds = apps.map((a) => a.id);
  const offers = (await readIn((part) => sb.from("gw_hr_offers").select(`id, applicant_id, version${wageCols}`)
    .eq("tenant_id", ctx.tenantId).in("applicant_id", part).order("id"), appIds)) || [];
  const newest = new Map();
  for (const o of offers) { const cur = newest.get(o.applicant_id); if (!cur || o.version > cur.version) newest.set(o.applicant_id, o); }
  let pays = null;
  if (split) {
    pays = await readIn((part) => sb.from("gw_hr_pay").select("applicant_id, offer_id, wage_type, wage_amount")
      .eq("tenant_id", ctx.tenantId).in("applicant_id", part).order("id"), appIds);
    if (pays === null) return out;
  }
  for (const a of apps) {
    const offer = newest.get(a.id) || null;
    let pay = null;
    if (split) {
      const mine = pays.filter((p) => p.applicant_id === a.id);
      const hit = (offer && mine.find((p) => p.offer_id === offer.id)) || null;
      pay = hit || mine.find((p) => !p.offer_id) || null;
      if (pay && !hit) pay = { ...pay, from: "applicant" };
    } else {
      pay = offer && (offer.wage_type || offer.wage_amount != null) ? offer : (a.wage_type || a.wage_amount != null ? { ...a, from: "applicant" } : null);
    }
    if (!pay || (pay.wage_type == null && pay.wage_amount == null)) continue;
    out.set(a.employee_id, { wageType: pay.wage_type ?? null, wageAmount: num(pay.wage_amount), from: pay.from === "applicant" ? "応募者の条件" : "内定（合格通知）" });
  }
  return out;
}

const offerRefOf = async (sb, ctx, employeeId) => (await offerRefsOf(sb, ctx, [employeeId])).get(employeeId) || null;
const declaredCommute = async (sb, ctx, employeeId) => {
  const m = await declaredCommutes(sb, ctx, [employeeId]);
  return m ? m.get(employeeId) ?? null : null;
};

const contractView = (c) => (c ? {
  id: c.id, type: c.contract_type || null, periodFrom: c.period_from || null, periodTo: c.period_to || null,
  wageType: c.wage_type || null, wageAmount: num(c.wage_amount), wageNote: c.wage_note || null,
} : null);

// ---- 監査 -----------------------------------------------------------------------

const actorName = (ctx, user) => ctx.employee?.display_name || user?.email || null;

/** 開いた記録を残す。書けなければ ok:false（呼び出し側は給与を返さない） */
async function audit(sb, ctx, user, { action, employeeId = null, detail = null }) {
  try {
    const { error } = await sb.from("gw_pay_audit").insert({
      tenant_id: ctx.tenantId, actor_id: user.id, actor_name: actorName(ctx, user), action, employee_id: employeeId, detail });
    return error ? { ok: false, error } : { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}

const auditRefused = (res, error) => {
  console.error("[keiei/pay] 監査ログを残せませんでした:", error?.message || error);
  return json(res, 503, { error: "audit_unavailable",
    hint: "監査ログを残せないため、給与は表示しません。しばらくしてからもう一度お試しください（続く場合は管理者へ）" });
};

// ---- 一覧 -----------------------------------------------------------------------

async function listView({ sb, res, ctx, user }) {
  const employees = await readAll(() => sb.from("gw_employees").select("id, display_name, department, position, employment_type, employee_kind, status, joined_on")
    .eq("tenant_id", ctx.tenantId).order("id"))
    ?? await readAll(() => sb.from("gw_employees").select("id, display_name, department, position, employment_type, status, joined_on")
      .eq("tenant_id", ctx.tenantId).order("id"));
  const records = await readAll(() => sb.from("gw_compensations").select(REC_COLS).eq("tenant_id", ctx.tenantId).order("id"));
  if (!employees || !records) return json(res, 500, { error: "db_read_failed", hint: "社員名簿または給与の履歴を読み切れませんでした。件数が合わないまま表示しないため、いったん止めています" });
  const contracts = await readAll(() => sb.from("gw_contracts").select("id, employee_id, wage_type, wage_amount, created_at")
    .eq("tenant_id", ctx.tenantId).eq("status", "active").order("created_at", { ascending: false }).order("id"));

  const today = todayJst();
  const recBy = new Map();
  for (const r of records.map(viewOf)) {
    if (!recBy.has(r.employeeId)) recBy.set(r.employeeId, []);
    recBy.get(r.employeeId).push(r);
  }
  const contractBy = new Map();
  for (const c of contracts || []) if (!contractBy.has(c.employee_id)) contractBy.set(c.employee_id, c);

  const rows = [];
  let bpExcluded = 0;
  for (const e of employees) {
    if (e.employee_kind === "bp") { bpExcluded += 1; continue; }
    const recs = recBy.get(e.id) || [];
    const contract = contracts ? contractBy.get(e.id) || null : null;
    const cur = currentAt(recs, today);
    const next = upcomingAfter(recs, today)[0] || null;
    const chk = contracts ? contractCheck(cur, contract) : null;
    rows.push({
      ...empView(e), recordCount: recs.length, current: cur, next,
      flags: contracts ? statusFlags(recs, contract, today) : statusFlags(recs, null, today),
      contract: chk && chk.contract ? { wageType: chk.contract.wageType, wageAmount: chk.contract.wageAmount, state: chk.state } : null,
    });
  }
  const rank = (r) => (CURRENT.includes(r.status) ? 0 : r.status === "invited" ? 1 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || String(a.name || "").localeCompare(String(b.name || ""), "ja"));

  const inService = rows.filter((r) => CURRENT.includes(r.status));
  const totals = inService.map((r) => r.current?.monthly?.total).filter((n) => n != null);
  const summary = {
    inService: inService.length,
    registered: inService.filter((r) => r.current).length,
    unregistered: inService.filter((r) => r.flags.includes("unregistered") || r.flags.includes("future_only")).length,
    upcoming: inService.filter((r) => r.flags.includes("upcoming")).length,
    mismatch: inService.filter((r) => r.flags.includes("mismatch")).length,
    monthlyTotal: totals.reduce((s, n) => s + n, 0), monthlyCounted: totals.length,
    hourlyLike: inService.filter((r) => r.current && r.current.monthly.total == null).length,
    bpExcluded, contractsLinked: contracts !== null,
  };

  const a = await audit(sb, ctx, user, { action: "view_list", detail: { rows: rows.length } });
  if (!a.ok) return auditRefused(res, a.error);
  return json(res, 200, { linked: true, today, summary, rows, meta: meta() });
}

/** 画面が使う固定の一覧（選択肢・言い方・上限）。金額は含まない */
const meta = () => ({ wageTypes: WAGE_TYPES, allowancePresets: ALLOWANCE_PRESETS, kindLabel: KIND_LABEL, sourceLabel: SOURCE_LABEL, limits: LIMITS });

// ---- 個人 -----------------------------------------------------------------------

async function detailData(sb, ctx, emp) {
  const today = todayJst();
  const recs = await recordsOf(sb, ctx, emp.id);
  if (recs === null) return { error: "履歴を読み切れませんでした" };
  const [contract, offer, commuteDeclared] = await Promise.all([contractOf(sb, ctx, emp.id), offerRefOf(sb, ctx, emp.id), declaredCommute(sb, ctx, emp.id)]);

  const cur = currentAt(recs, today);
  const chk = contract.unknown ? null : contractCheck(cur, contract.row);
  const groups = historyGroups(recs).map((g) => ({
    effectiveFrom: g.effectiveFrom, latestRevision: g.latest.revision,
    revisions: g.revisions.map((r) => ({ ...r, changes: diffSnapshots(r.before, snapshotOf(r)), basisText: describeBasis(r.basis) })),
  }));
  // 初回給与の候補（記録がまだ無い人だけ。見せるだけで、登録はしない）
  let candidate = null;
  let candidateWhy = [];
  if (!recs.length) {
    if (contract.unknown) candidateWhy = ["契約を読めなかったため、候補を作れません"];
    else {
      const b = buildCandidate({ contract: contractView(contract.row), contractCount: contract.count, offer, commuteDeclared, employee: { joinedOn: emp.joined_on } });
      candidate = b.candidate ? { ...b.candidate, warnings: b.warnings, dateHints: b.dateHints } : null;
      candidateWhy = b.why;
    }
  }
  const auditRows = await soft(sb.from("gw_pay_audit").select(AUDIT_COLS)
    .eq("tenant_id", ctx.tenantId).eq("employee_id", emp.id).order("id", { ascending: false }).limit(50));

  return {
    today, employee: empView(emp),
    current: cur, upcoming: upcomingAfter(recs, today),
    groups, recordCount: recs.length,
    flags: statusFlags(recs, contract.unknown ? null : contract.row, today),
    // 参照（この画面では書き換えない）。給与の額の「正」は current
    references: {
      contract: contract.unknown ? { unavailable: true } : { view: contractView(contract.row), check: chk ? chk.state : "none" },
      offer: offer || null,
      commuteDeclared,
    },
    candidate, candidateWhy,
    audit: (auditRows || []).map(auditView),
    auditUnavailable: auditRows === null,
    meta: meta(),
  };
}

async function detailView({ sb, res, ctx, user, employeeId }) {
  const emp = await loadEmployee(sb, ctx, employeeId);
  if (!emp) return json(res, 404, { error: "not_found", hint: "この方の情報を開けません" });
  const d = await detailData(sb, ctx, emp);
  if (d.error) return json(res, 500, { error: "db_read_failed", hint: d.error });
  const a = await audit(sb, ctx, user, { action: "view_detail", employeeId: emp.id });
  if (!a.ok) return auditRefused(res, a.error);
  return json(res, 200, { linked: true, ...d });
}

// ---- 初回給与の候補（一覧）---------------------------------------------------------------

const CANDIDATE_STATUS = ["active", "leaving", "invited"];

async function candidatesView({ sb, res, ctx, user }) {
  const employees = await readAll(() => sb.from("gw_employees").select("id, display_name, department, position, employment_type, employee_kind, status, joined_on")
    .eq("tenant_id", ctx.tenantId).order("id"))
    ?? await readAll(() => sb.from("gw_employees").select("id, display_name, department, position, employment_type, status, joined_on")
      .eq("tenant_id", ctx.tenantId).order("id"));
  const records = await readAll(() => sb.from("gw_compensations").select("id, employee_id").eq("tenant_id", ctx.tenantId).order("id"));
  if (!employees || !records) return json(res, 500, { error: "db_read_failed", hint: "社員名簿または給与の履歴を読み切れませんでした。件数が合わないまま表示しないため、いったん止めています" });

  const has = new Set(records.map((r) => r.employee_id));
  const targets = employees.filter((e) => CANDIDATE_STATUS.includes(e.status) && e.employee_kind !== "bp" && !has.has(e.id));
  const ids = targets.map((e) => e.id);
  const [contracts, declared, offers] = ids.length
    ? await Promise.all([contractsOf(sb, ctx, ids), declaredCommutes(sb, ctx, ids), offerRefsOf(sb, ctx, ids)])
    : [new Map(), new Map(), new Map()];
  // 契約や届出を読み切れないまま「候補なし」と言わない（参照が読めないだけなのに、手入力へ誘導しない）
  if (contracts === null || declared === null) {
    return json(res, 500, { error: "db_read_failed", hint: "契約または入社情報の届出を読み切れませんでした。候補を作れないため、いったん止めています" });
  }

  const rows = targets.map((e) => {
    const c = contracts.get(e.id);
    const b = buildCandidate({ contract: c ? contractView(c.row) : null, contractCount: c?.count || 0, offer: offers.get(e.id) || null,
      commuteDeclared: declared.get(e.id) ?? null, employee: { joinedOn: e.joined_on } });
    return { ...empView(e), candidate: b.candidate, warnings: b.warnings, why: b.why, dateHints: b.dateHints };
  }).sort((a, b) => Number(Boolean(b.candidate)) - Number(Boolean(a.candidate)) || String(a.name || "").localeCompare(String(b.name || ""), "ja"));

  const a = await audit(sb, ctx, user, { action: "view_list", detail: { via: "candidates", rows: rows.length } });
  if (!a.ok) return auditRefused(res, a.error);
  return json(res, 200, { linked: true, rows, summary: { total: rows.length, withCandidate: rows.filter((r) => r.candidate).length,
    withoutCandidate: rows.filter((r) => !r.candidate).length }, meta: meta() });
}

// ---- 監査ログ ---------------------------------------------------------------------

async function auditPage({ sb, res, ctx, user, employeeId, before }) {
  let q = sb.from("gw_pay_audit").select(AUDIT_COLS).eq("tenant_id", ctx.tenantId);
  if (employeeId) q = q.eq("employee_id", employeeId);
  if (before && /^\d{1,18}$/.test(before)) q = q.lt("id", Number(before));
  const { data, error } = await q.order("id", { ascending: false }).limit(AUDIT_PAGE + 1);
  if (error) return json(res, 500, { error: "db_read_failed", detail: error.message });
  const rows = data || [];
  const more = rows.length > AUDIT_PAGE;
  const page = more ? rows.slice(0, AUDIT_PAGE) : rows;

  // 社員の名前（名簿から）。消えた社員でも、ログの行は残る
  const ids = [...new Set(page.map((r) => r.employee_id).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    const emps = await readIn((part) => sb.from("gw_employees").select("id, display_name").eq("tenant_id", ctx.tenantId).in("id", part).order("id"), ids);
    for (const e of emps || []) names.set(e.id, e.display_name);
  }
  const a = await audit(sb, ctx, user, { action: "view_audit", employeeId: employeeId || null });
  if (!a.ok) return auditRefused(res, a.error);
  return json(res, 200, {
    linked: true,
    rows: page.map((r) => ({ ...auditView(r), employeeName: r.employee_id ? names.get(r.employee_id) || null : null })),
    nextBefore: more ? String(page[page.length - 1].id) : null,
  });
}

// ---- 記録 -----------------------------------------------------------------------

const CONFLICT = { nothing_to_correct: 409, exists_at_date: 409, no_change: 409 };

async function recordAction({ sb, res, ctx, user, body, employeeId, dry }) {
  const emp = await loadEmployee(sb, ctx, employeeId);
  if (!emp) return json(res, 404, { error: "not_found", hint: "この方の情報を開けません" });
  if (emp.employee_kind === "bp") {
    return json(res, 409, { error: "bp_not_supported", hint: "BP（外部パートナー）は、給与の管理の対象外です（現場単価は、給与とは別に扱います）" });
  }

  const norm = normalizeRecordInput(body);
  if (norm.error) return json(res, 400, { error: norm.error, field: norm.field || null, hint: norm.hint });
  const input = norm.value;

  const recs = await recordsOf(sb, ctx, emp.id);
  if (recs === null) return json(res, 500, { error: "db_read_failed", hint: "履歴を読み切れませんでした。もう一度お試しください" });
  const contract = await contractOf(sb, ctx, emp.id);

  // 初回給与の「候補」から入れたとき: 基準はサーバが作り直す（画面の申告を信じない）。最初の記録にだけ使える。
  // 取り込み元（source）も、サーバが決める（基本給と種別が候補のままなら候補の元、直していれば経営者の入力）
  let candidate = null;
  if (body.candidate === true) {
    if (recs.length) return json(res, 409, { error: "candidate_not_initial", hint: "候補は、最初の記録にだけ使えます。この人には、すでに記録があります" });
    if (contract.unknown) return json(res, 500, { error: "db_read_failed", hint: "契約を読み切れませんでした。もう一度お試しください" });
    const built = buildCandidate({ contract: contractView(contract.row), contractCount: contract.count, offer: await offerRefOf(sb, ctx, emp.id),
      commuteDeclared: await declaredCommute(sb, ctx, emp.id), employee: { joinedOn: emp.joined_on } });
    if (!built.candidate) return json(res, 409, { error: "no_candidate", hint: built.why.join("／") || "候補を作れるデータがありません" });
    candidate = built.candidate;
    input.source = sourceOf(candidate, input);
  }
  const basis = candidate ? basisOf(candidate, input) : null;

  // 「契約から」「内定から」と名乗るなら、元が実在すること
  if (input.source === "contract_import" && (contract.unknown || !contract.row || contract.row.wage_amount == null)) {
    return json(res, 409, { error: "no_contract_wage", hint: "取り込める契約の賃金がありません" });
  }
  if (input.source === "offer_import" && !(await offerRefOf(sb, ctx, emp.id))) {
    return json(res, 409, { error: "no_offer_wage", hint: "取り込める内定時の給与がありません" });
  }

  const planned = planRecord(recs, input, { today: todayJst(), contract: contract.unknown ? null : contract.row });
  if (planned.error) return json(res, CONFLICT[planned.error] || 400, { error: planned.error, hint: planned.hint });
  const plan = planned.plan;

  if (dry) return json(res, 200, { preview: publicPlan(plan, input, contract, basis) });

  // 画面が見ていた「いまの記録」と違う（別の人が先に記録した）。変更前が食い違うので、記録しない
  if (body.basisId !== undefined && (body.basisId || null) !== plan.basisId) {
    return json(res, 409, { error: "stale_basis", hint: "画面を開いたあとに、この人の給与が更新されました。開き直して、内容を確かめてから記録してください" });
  }

  const row = {
    tenant_id: ctx.tenantId, employee_id: emp.id, effective_from: input.effectiveFrom, revision: plan.revision,
    wage_type: input.wageType, base_amount: input.baseAmount, allowances: input.allowances,
    commute_amount: input.commuteAmount, commute_note: input.commuteNote,
    contract_id: contract.row?.id ?? null, contract_wage_type: contract.row?.wage_type ?? null,
    contract_wage_amount: contract.row?.wage_amount ?? null,
    kind: plan.kind, source: input.source, reason: input.reason, before: plan.before, basis,
    created_by: user.id, created_by_name: actorName(ctx, user),
  };
  const { data, error } = await sb.from("gw_compensations").insert(row).select("id").single();
  if (error) {
    if (error.code === "23505") return json(res, 409, { error: "conflict", hint: "同じ適用開始日の記録が、たった今ほかで作られました。開き直して確かめてください" });
    return json(res, 500, { error: "db_insert_failed", detail: error.message });
  }
  // 監査ログは、この INSERT のトリガが書いている（db/105 gw_comp_audit_trg）

  const out = await detailData(sb, ctx, emp);
  return json(res, 200, { linked: true, ...(out.error ? {} : out), result: { recordId: data.id, kind: plan.kind, revision: plan.revision, effectiveFrom: input.effectiveFrom } });
}

const publicPlan = (plan, input, contract, basis = null) => ({
  basis: basis ? { text: describeBasis(basis), edited: basis.edited, sources: basis.sources.map((x) => x.type) } : null,
  kind: plan.kind, kindLabel: KIND_LABEL[plan.kind], revision: plan.revision, effectiveFrom: plan.after.effectiveFrom,
  before: plan.before, after: plan.after, changes: plan.changes, warnings: plan.warnings, basisId: plan.basisId,
  monthly: viewOf({ wage_type: input.wageType, base_amount: input.baseAmount, allowances: input.allowances, commute_amount: input.commuteAmount }).monthly,
  contractCheck: contract.unknown ? null : (() => { const c = contractCheck({ wageType: input.wageType, baseAmount: input.baseAmount }, contract.row); return { state: c.state, contract: c.contract }; })(),
});
