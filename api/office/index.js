// GET /api/office?month=YYYY-MM
//   … 月末月初業務の一覧。「今月、何が止まっているか」を、既存の印から導いて返す（lib/office.js）
//
// ■ 入れる人（画面・API・DB を同じ条件にする）
//
//   経営者 OR 責任者 OR 経理（lib/gw.js canAccessOffice。DB は gw_is_office、db/099・100）。
//   会計側の管理者・人事・IT・営業・一般メンバーは入れない（403）。
//   単価・請求額・支払を扱うので、二段階認証は強制日を待たず最初から必須（requireMfa の strict）。
//   権限の判定を先にする（権限のない人を、二段階認証の登録画面へ誘導しない）。
//
// ■ ログインした人の権限（RLS）で読む
//
//   現場契約・進捗・提出・BP会社は userClient で読む。DB（gw_is_office、db/100）が、
//   Office 権限のない人には返さない。API の入口を抜けても、DB が同じ条件で止める。
//   氏名・区分・所属だけは、名簿（gw_employees）に人事の機微が載っているので RLS を開けず、
//   判定のあとに、必要な列だけを service_role で読む。
//
// ■ 読まないもの
//
//   単価（unit_price）と精算条件（settlement_condition）。単価は売上か仕入かがまだ確認できておらず、
//   Phase 2 の「何が止まっているか」には要らない。
//
// ■ Phase 2 は読むだけ
//
//   印の更新は、当面これまでどおり月初作業管理（admin-month-start.html）で行う。

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canAccessOffice } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient, admin } from "../../lib/supabase.js";
import { isBillingMonth, STAGE_KEYS } from "../../lib/billing-progress.js";
import { monthRange, jstDate } from "../../lib/timecard.js";
import {
  deriveRow, sortRows, summarize, timesheetDeadline, STAGES, FILTERS,
} from "../../lib/office.js";
import { normalizeTerms, termsForMonth, settle } from "../../lib/office-calc.js";
import { sheetState, classifyFiles, latestSubmission } from "../../lib/office-timesheet.js";

// 読む列。単価・精算条件・メモは入れない
const CONTRACT_FIELDS = "id, employee_id, engagement_kind, site_company, prime_company, "
  + "period_from, period_to, renewal_status";
const PROGRESS_FIELDS = "id, employee_id, site_contract_id, "
  + STAGE_KEYS.map((k) => `${k}, ${k}_at`).join(", ");
const SUBMISSION_FIELDS = "id, employee_id, site_contract_id, kind, file_name, submitted_at";
const EMPLOYEE_FIELDS = "id, display_name, department, employee_kind, partner_company_id, status";

// Phase 3（db/101〜103）。未適用でも、Phase 2 の一覧は出す
const SHEET_FIELDS = "id, employee_id, site_contract_id, submission_id, status, read_state, read_warnings, "
  + "work_days, unresolved_count, flagged_count, total_minutes";
const SHEET_FILE_FIELDS = "id, employee_id, site_contract_id, target_month, submitted_at, sha256";
const TERMS_FIELDS = "id, site_contract_id, valid_from, valid_to, pricing_type, sales_unit_price, purchase_unit_price, "
  + "settlement_mode, settle_min_minutes, settle_max_minutes, settle_unit_minutes, rounding_mode, rounding_scope, "
  + "over_rate_per_hour, under_rate_per_hour, prorate, amount_rounding";
const PHASE3_SQL = "db/101_office_timesheet_base.sql・db/102_office_contract_terms.sql・db/103_office_timesheets.sql";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canAccessOffice(ctx)) return json(res, 403, { error: "forbidden" });
  if (!(await requireMfa(req, res, ctx, user, { strict: true }))) return;

  const today = jstDate();
  const month = new URL(req.url, "http://localhost").searchParams.get("month") || today.slice(0, 7);
  if (!isBillingMonth(month)) {
    return json(res, 400, { error: "invalid_query", detail: "month は YYYY-MM で指定してください" });
  }

  res.setHeader("Cache-Control", "no-store");
  const sb = userClient(req);
  const range = monthRange(month);

  // 今月動いている現場契約。「月末」を `${month}-31` と書かない（30日までの月・2月で DB が落ちる）
  const [contractsRes, progressRes, submissionsRes] = await Promise.all([
    sb.from("gw_site_contracts").select(CONTRACT_FIELDS)
      .eq("tenant_id", ctx.tenantId).lt("period_from", range.to).limit(2000),
    sb.from("gw_billing_progress").select(PROGRESS_FIELDS)
      .eq("tenant_id", ctx.tenantId).eq("billing_month", month).limit(2000),
    sb.from("gw_submissions").select(SUBMISSION_FIELDS)
      .eq("tenant_id", ctx.tenantId).eq("target_month", month).order("submitted_at").limit(5000),
  ]);

  for (const [r, sql] of [
    [contractsRes, "db/076_site_contracts.sql"],
    [progressRes, "db/077_billing_progress.sql"],
    [submissionsRes, "db/080_billing_submission.sql"],
  ]) {
    if (!r.error) continue;
    const hint = dbSetupHint(r.error, sql);
    if (hint) return json(res, 200, { ...payload(month, today, []), notReady: true, message: hint });
    return json(res, 500, { error: "db_query_failed", detail: r.error.message });
  }

  const active = (contractsRes.data || []).filter((c) => !c.period_to || c.period_to >= range.from);

  // RLS（db/100）が未適用だと、権限があっても 0 件に見える。「今月は何も無い」と見間違えないよう、
  // 本当に0件かを、権限を通さずに数えて確かめる
  if (!(contractsRes.data || []).length) {
    const { count } = await admin().from("gw_site_contracts").select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId).lt("period_from", range.to);
    if (count > 0) {
      // 空の一覧と同じ形（summary など）で返す。画面は、その上に理由を出すだけでよい
      return json(res, 200, {
        ...payload(month, today, []), accessNotReady: true,
        message: "現場契約が登録されていますが、権限の設定が未適用のため表示できません。"
          + "管理者に db/099_access_hr_office.sql と db/100_office_access.sql の実行を依頼してください",
      });
    }
  }
  if (!active.length) return json(res, 200, payload(month, today, []));

  // 氏名・区分・所属・BP会社。判定のあとに、必要な列だけを読む
  const empIds = [...new Set(active.map((c) => c.employee_id))];
  const { data: emps, error: ee } = await admin().from("gw_employees")
    .select(EMPLOYEE_FIELDS).eq("tenant_id", ctx.tenantId).in("id", empIds).limit(2000);
  if (ee) return json(res, 500, { error: "db_query_failed", detail: ee.message });
  const empById = new Map((emps || []).map((e) => [e.id, e]));

  const partnerIds = [...new Set((emps || []).map((e) => e.partner_company_id).filter(Boolean))];
  const partnerById = new Map();
  if (partnerIds.length) {
    const { data: ps } = await sb.from("gw_partner_companies")
      .select("id, company_name").eq("tenant_id", ctx.tenantId).in("id", partnerIds).limit(2000);
    for (const p of ps || []) partnerById.set(p.id, p.company_name);
  }

  const progressByKey = new Map((progressRes.data || []).map((p) => [`${p.employee_id}:${p.site_contract_id}`, p]));
  const filesByKey = new Map();
  for (const s of submissionsRes.data || []) {
    const k = `${s.employee_id}:${s.site_contract_id}`;
    if (!filesByKey.has(k)) filesByKey.set(k, []);
    filesByKey.get(k).push({ id: s.id, kind: s.kind, fileName: s.file_name, submittedAt: s.submitted_at });
  }

  // Phase 3：勤務表の状態・確定した稼働時間・契約条件。表が未作成なら、この部分だけ省く
  const p3 = await loadPhase3(sb, ctx, month, range);
  if (p3.error) return json(res, 500, { error: "db_query_failed", detail: p3.error });
  const sheetByKey = new Map((p3.sheets || []).map((t) => [`${t.employee_id}:${t.site_contract_id}`, t]));
  const termsByContract = new Map();
  for (const t of p3.terms || []) {
    if (!termsByContract.has(t.site_contract_id)) termsByContract.set(t.site_contract_id, []);
    termsByContract.get(t.site_contract_id).push(normalizeTerms(t));
  }
  // 同じファイルの検知は、この月に届いたものの中だけ（別の月にまたがる照合は、勤務表の画面で行う）
  const dup = classifyFiles((p3.files || []).map((f) => ({ ...f, target_month: month })));
  const sheetFilesByKey = new Map();
  for (const f of p3.files || []) {
    const k = `${f.employee_id}:${f.site_contract_id}`;
    if (!sheetFilesByKey.has(k)) sheetFilesByKey.set(k, []);
    sheetFilesByKey.get(k).push(f);
  }

  const deadline = timesheetDeadline(month);
  const rows = active
    .filter((c) => empById.has(c.employee_id))       // 名簿に無い契約は、その行だけ出さない（全体は止めない）
    .map((c) => {
      const e = empById.get(c.employee_id);
      const key = `${c.employee_id}:${c.id}`;
      const p = progressByKey.get(key) || null;
      const marks = {};
      for (const k of STAGE_KEYS) { marks[k] = !!p?.[k]; marks[`${k}_at`] = p?.[`${k}_at`] || null; }
      const extra = p3.ready ? phase3Of(c, key, { sheetByKey, sheetFilesByKey, dup, termsByContract, month }) : {};
      return deriveRow({
        ...extra,
        siteContractId: c.id, progressId: p?.id || null, employeeId: c.employee_id,
        employeeName: e.display_name, department: e.department || null,
        employeeKind: e.employee_kind || "proper", employeeStatus: e.status || null,
        partnerName: e.partner_company_id ? (partnerById.get(e.partner_company_id) || null) : null,
        engagementKind: c.engagement_kind, siteCompany: c.site_company, primeCompany: c.prime_company || null,
        periodFrom: c.period_from, periodTo: c.period_to || null, renewalStatus: c.renewal_status,
        marks, submissions: filesByKey.get(key) || [],
      }, { today, deadline });
    });

  return json(res, 200, { ...payload(month, today, rows, deadline), phase3: p3.ready ? { ready: true } : { ready: false, message: p3.message } });
}

function payload(month, today, rows, deadline = timesheetDeadline(month)) {
  return {
    month, today, deadline,
    rows: sortRows(rows),
    summary: summarize(rows),
    stages: STAGES, filters: FILTERS,
  };
}

/** Phase 3 の表を読む（RLS）。表・列が無ければ ready:false（一覧そのものは止めない） */
async function loadPhase3(sb, ctx, month, range) {
  const [sheets, terms, files] = await Promise.all([
    sb.from("gw_timesheets").select(SHEET_FIELDS).eq("tenant_id", ctx.tenantId).eq("target_month", month).limit(2000),
    // この月にかかる条件は、開始が翌月より前のもの。終了日の絞り込みは、月の判定（termsForMonth）に任せる
    sb.from("gw_site_contract_terms").select(TERMS_FIELDS).eq("tenant_id", ctx.tenantId).lt("valid_from", range.to).limit(5000),
    sb.from("gw_submissions").select(SHEET_FILE_FIELDS).eq("tenant_id", ctx.tenantId).eq("target_month", month)
      .eq("kind", "timesheet").limit(5000),
  ]);
  for (const r of [sheets, terms, files]) {
    if (!r.error) continue;
    const hint = dbSetupHint(r.error, PHASE3_SQL);
    if (hint) return { ready: false, message: hint };
    return { ready: false, error: r.error.message };
  }
  return { ready: true, sheets: sheets.data || [], terms: terms.data || [], files: files.data || [] };
}

/** 1行ぶんの Phase 3 の材料（deriveRow が、印と合わせて状態を導く） */
function phase3Of(c, key, { sheetByKey, sheetFilesByKey, dup, termsByContract, month }) {
  const ts = sheetByKey.get(key) || null;
  const files = sheetFilesByKey.get(key) || [];
  const state = sheetState({ submissions: files, timesheet: ts });
  const warnings = [];
  if (files.some((f) => dup.get(f.id)?.state === "cross")) {
    warnings.push("同じファイルが、別の人・別の契約の勤務表としても提出されています");
  }
  const latest = latestSubmission(files);
  if (ts?.submission_id && latest && latest.id !== ts.submission_id) warnings.push("読み取り後に、新しい勤務表のファイルが届いています");
  if (Array.isArray(ts?.read_warnings) && ts.read_warnings.some((w) => w?.code === "name_mismatch")) {
    warnings.push("勤務表の氏名が、登録の氏名と一致しません（別の人の勤務表の可能性）");
  }
  const confirmed = ts?.status === "confirmed";
  const terms = termsForMonth(termsByContract.get(c.id) || [], month);
  const st = confirmed ? settle({ terms, minutes: ts.total_minutes }) : null;
  return {
    sheet: {
      state, totalMinutes: confirmed ? ts.total_minutes : null, workDays: ts ? ts.work_days : null,
      unresolved: ts ? ts.unresolved_count : 0, review: ts ? ts.flagged_count : 0,
      readState: ts?.read_state || null, warnings,
    },
    terms: { status: terms.status, partial: terms.partial },
    settle: st ? { status: st.status, amount: st.amount, band: st.band, reasons: st.reasons } : null,
  };
}
