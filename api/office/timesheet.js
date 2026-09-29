// /api/office/timesheet — 勤務表の受領・AI読取・確認・確定（稼働時間の確定）
//
//   GET  ?contract=<現場契約id>&month=YYYY-MM
//        … 提出状態・届いたファイル（同じファイルの印つき）・日別データ・合計・確定の条件・契約条件
//   POST { action, siteContractId, month, … }
//        upload   … 置き場所（署名付きアップロードURL）を出す
//        attach   … 置いたファイルを確かめて登録する（形式・大きさ・sha256・同じファイルの検知）
//        read     … AI読取 → 下書き（draft）を作る。確定にはならない
//        blank    … ファイル無しで、手入力の下書きを始める
//        save     … 日別の値を直す（直した日は「確認済み」になる）
//        bulk     … まとめて直す（人が押したときだけ）
//        confirm  … 確定する（条件を満たしたときだけ。合計の不一致は承知のうえで）
//        reopen   … 確定を取り消して、下書きに戻す（請求書を作成済みなら断る）
//        return   … 提出物に問題があるとして、差し戻す（再提出の依頼。メールは送らない）
//
// ■ 入れる人（画面・API・DB を同じ条件にする）
//   経営者 OR 責任者 OR 経理（canAccessOffice）。二段階認証は最初から必須（strict）。
//   権限の判定を先にする。api/office/index.js と同じ。
//
// ■ 読むのは、ログインした人の権限（RLS）で。書くのは、権限を確かめたあとの service_role で
//   新しい表（gw_timesheets・gw_timesheet_days・gw_site_contract_terms・gw_office_events）は、
//   RLS で Office 権限の読み取りだけを許している。書き込みはここだけ（確認の手順を飛ばせないように）。
//   氏名だけ、名簿（人事の機微が載っている）から service_role で読む。
//
// ■ AI の結果は、確認済み・確定にならない
//   read は下書きを作るだけ。confirm は、不明な日が0・要確認の日が確認済み・全日の行がある、を満たしたときだけ。
//
// ■ 既存の5つの印との同期（月初作業管理を壊さない）
//   届いた（attach）      → 勤務表受領 を立てる
//   確定（confirm）       → 稼働確認 を立てる（受領も立てる）
//   確定の取消し（reopen）→ 稼働確認 を外す。請求書の作成・送付の印があるときは断る
//   差し戻し（return）    → 勤務表受領 を外す（再提出を待つ）
//   印を手で直す既存の画面（月初作業管理）は、そのまま使える。
//
// ■ 操作は gw_office_events（履歴）に残す。金額・単価・個人情報は入れない。

import crypto from "node:crypto";
import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canAccessOffice } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { detectDoc } from "../../lib/hr-docs.js";
import { ymAdd } from "../../lib/holidays.js";
import { isBillingMonth, STAGE_KEYS } from "../../lib/billing-progress.js";
import { MAX_BYTES } from "../../lib/billing-submission.js";
import { normalizeTerms, termsForMonth, settle, describeTerms } from "../../lib/office-calc.js";
import { readTimesheet } from "../../lib/office-timesheet-ai.js";
import {
  normalizeDayRow, evaluateSheet, canConfirm, ACK_LABEL, blankDays, parseDayInput, applyPatch,
  bulkPatches, sheetState, SHEET_STATE, classifyFiles, latestSubmission, nameMatches, FILE_STATE_LABEL,
} from "../../lib/office-timesheet.js";

const BUCKET = "billing-submissions";
const SQL = "db/101_office_timesheet_base.sql・db/102_office_contract_terms.sql・db/103_office_timesheets.sql";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT = { pdf: "pdf", jpeg: "jpg", png: "png" };
const MIME_EXT = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" };
const MAX_REVIEW_SECONDS_PER_CALL = 1800;

const CONTRACT_FIELDS = "id, employee_id, engagement_kind, site_company, prime_company, period_from, period_to";
const SUB_FIELDS = "id, employee_id, site_contract_id, target_month, kind, file_name, mime_type, size_bytes, "
  + "storage_path, submitted_at, sha256, verified_at, source";
const SHEET_FIELDS = "id, employee_id, site_contract_id, target_month, submission_id, status, read_state, ai_model, "
  + "ai_read_at, ai_message, sheet_employee_name, read_warnings, sheet_total_min, raw_minutes, total_minutes, "
  + "work_days, unresolved_count, flagged_count, spill_minutes, carry_in_minutes, terms_id, rounding_unit, "
  + "rounding_mode, rounding_scope, confirmed_at, return_reason, returned_at, review_seconds, edit_count, "
  + "created_at, updated_at";
const DAY_FIELDS = "timesheet_id, work_date, kind, start_min, end_min, break_min, sheet_worked_min, note, source, "
  + "ai_confidence, ai_flags, edited, reviewed_at";
const TERMS_FIELDS = "id, site_contract_id, valid_from, valid_to, pricing_type, sales_unit_price, "
  + "purchase_unit_price, settlement_mode, settle_min_minutes, settle_max_minutes, settle_unit_minutes, "
  + "rounding_mode, rounding_scope, over_rate_per_hour, under_rate_per_hour, prorate, amount_rounding";

class Reply extends Error {
  constructor(status, body) { super(body?.error || "reply"); this.status = status; this.body = body; }
}
const stop = (status, body) => { throw new Reply(status, body); };
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canAccessOffice(ctx)) return json(res, 403, { error: "forbidden" });
  if (!(await requireMfa(req, res, ctx, user, { strict: true }))) return;

  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const q = new URL(req.url, "http://localhost").searchParams;
      const k = await keyOf(req, ctx, { siteContractId: q.get("contract"), month: q.get("month") });
      return json(res, 200, await payload(req, ctx, k));
    }
    const body = (await readJson(req)) || {};
    const k = await keyOf(req, ctx, body);
    const actions = { upload, attach, read, blank, save, bulk, confirm, reopen, return: giveBack };
    const fn = actions[body.action];
    if (!fn) return json(res, 400, { error: "invalid_action", detail: Object.keys(actions).join(", ") });
    return await fn({ req, res, ctx, user, k, body });
  } catch (e) {
    if (e instanceof Reply) return json(res, e.status, e.body);
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[office/timesheet]", e?.message || e);
    return json(res, 500, { error: "timesheet_failed" });
  }
}

// ---------------------------------------------------------------------------
// 対象（現場契約 × 月）を決める。契約は、ログインした人の権限（RLS）で読む
// ---------------------------------------------------------------------------
async function keyOf(req, ctx, { siteContractId, month }) {
  if (!siteContractId || !UUID.test(String(siteContractId))) stop(400, { error: "invalid_request", detail: "現場契約（siteContractId）を指定してください" });
  if (!isBillingMonth(month)) stop(400, { error: "invalid_request", detail: "month は YYYY-MM で指定してください" });
  const contract = await must(userClient(req).from("gw_site_contracts").select(CONTRACT_FIELDS)
    .eq("id", siteContractId).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!contract) stop(404, { error: "contract_not_found" });
  const emp = await must(admin().from("gw_employees").select("id, display_name")
    .eq("id", contract.employee_id).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (!emp) stop(404, { error: "employee_not_found" });
  return { contract, employee: emp, month, siteContractId: contract.id, employeeId: contract.employee_id };
}

// ---------------------------------------------------------------------------
// 読む（RLS）
// ---------------------------------------------------------------------------
async function loadState(req, ctx, k) {
  const sb = userClient(req);
  const [subs, sheet, termsRows] = await Promise.all([
    must(sb.from("gw_submissions").select(SUB_FIELDS)
      .eq("tenant_id", ctx.tenantId).eq("employee_id", k.employeeId).eq("site_contract_id", k.siteContractId)
      .eq("target_month", k.month).eq("kind", "timesheet").order("submitted_at").limit(200)),
    must(sb.from("gw_timesheets").select(SHEET_FIELDS)
      .eq("tenant_id", ctx.tenantId).eq("employee_id", k.employeeId).eq("site_contract_id", k.siteContractId)
      .eq("target_month", k.month).maybeSingle()),
    must(sb.from("gw_site_contract_terms").select(TERMS_FIELDS)
      .eq("tenant_id", ctx.tenantId).eq("site_contract_id", k.siteContractId).limit(200)),
  ]);
  const days = sheet
    ? await must(sb.from("gw_timesheet_days").select(DAY_FIELDS).eq("tenant_id", ctx.tenantId).eq("timesheet_id", sheet.id).limit(400))
    : [];

  // 同じファイルが、別の月・別の人にも出ていないか（中身の sha256 で）
  const hashes = [...new Set((subs || []).map((s) => s.sha256).filter(Boolean))].slice(0, 50);
  const same = hashes.length
    ? await must(sb.from("gw_submissions").select(SUB_FIELDS)
      .eq("tenant_id", ctx.tenantId).eq("kind", "timesheet").in("sha256", hashes).limit(500))
    : [];
  const dup = classifyFiles(dedupeById([...(subs || []), ...(same || [])]));

  // 前月の月末から入ってくるぶん（前月の勤務表があれば、その日別から計算する）
  const prevMonth = ymAdd(k.month, -1);
  const prev = await must(sb.from("gw_timesheets").select("id")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", k.employeeId).eq("site_contract_id", k.siteContractId)
    .eq("target_month", prevMonth).maybeSingle());
  let carryIn = 0;
  if (prev) {
    const pd = await must(sb.from("gw_timesheet_days").select(DAY_FIELDS).eq("tenant_id", ctx.tenantId).eq("timesheet_id", prev.id).limit(400));
    carryIn = evaluateSheet((pd || []).map(normalizeDayRow), { month: prevMonth }).summary.spillMinutes;
  }
  return { subs: subs || [], sheet, days: days || [], termsRows: termsRows || [], dup, carryIn };
}

const dedupeById = (rows) => [...new Map(rows.map((r) => [r.id, r])).values()];

const roundingOf = (t) => (t?.settleUnitMinutes
  ? { unit: t.settleUnitMinutes, mode: t.roundingMode || "floor", scope: t.roundingScope || "day" } : null);

/** 画面に返す形。GET も、書いたあとの応答も、これ */
async function payload(req, ctx, k, preloaded = null) {
  const st = preloaded || await loadState(req, ctx, k);
  const terms = termsForMonth(st.termsRows.map(normalizeTerms), k.month);
  const rounding = terms.status === "ok" ? roundingOf(terms.terms) : null;
  const ev = st.sheet
    ? evaluateSheet(st.days.map(normalizeDayRow), {
      month: k.month, rounding, carryInMinutes: st.carryIn, sheetTotalMin: st.sheet.sheet_total_min ?? null,
    })
    : null;

  const latest = latestSubmission(st.subs);
  const state = sheetState({ submissions: st.subs, timesheet: st.sheet });
  const newerFile = st.sheet?.submission_id && latest && latest.id !== st.sheet.submission_id
    ? { id: latest.id, fileName: latest.file_name, submittedAt: latest.submitted_at } : null;

  const confirm = ev ? canConfirm(st.sheet.status, ev) : null;
  const t = terms.terms;
  const confirmed = st.sheet?.status === "confirmed";
  const termsChanged = confirmed && (
    (st.sheet.terms_id || null) !== (t?.id || null)
    || (st.sheet.rounding_unit || null) !== (rounding?.unit || null)
    || (st.sheet.rounding_mode || null) !== (rounding?.mode || null)
    || (st.sheet.rounding_scope || null) !== (rounding?.scope || null));

  return {
    month: k.month,
    contract: {
      id: k.contract.id, employeeId: k.employeeId, employeeName: k.employee.display_name,
      engagementKind: k.contract.engagement_kind, siteCompany: k.contract.site_company,
      primeCompany: k.contract.prime_company || null, periodFrom: k.contract.period_from, periodTo: k.contract.period_to || null,
    },
    state, stateLabel: SHEET_STATE[state].label, stateTone: SHEET_STATE[state].tone,
    files: st.subs.map((s) => {
      const d = st.dup.get(s.id) || { state: "unchecked", sameKey: [], cross: [] };
      return {
        id: s.id, fileName: s.file_name, mimeType: s.mime_type, sizeBytes: s.size_bytes, submittedAt: s.submitted_at,
        source: s.source || "form", verified: Boolean(s.verified_at),
        dup: {
          state: d.state, label: FILE_STATE_LABEL[d.state] || "",
          sameEmployeeOtherMonth: d.cross.some((c) => c.employeeId === k.employeeId),
          crossCount: d.cross.length,
        },
        isSource: st.sheet?.submission_id === s.id, isLatest: latest?.id === s.id,
      };
    }),
    newerFile,
    timesheet: st.sheet ? {
      id: st.sheet.id, status: st.sheet.status, readState: st.sheet.read_state, aiModel: st.sheet.ai_model,
      aiReadAt: st.sheet.ai_read_at, aiMessage: st.sheet.ai_message,
      sheetEmployeeName: st.sheet.sheet_employee_name,
      nameMatch: nameMatches(st.sheet.sheet_employee_name, k.employee.display_name),
      readWarnings: Array.isArray(st.sheet.read_warnings) ? st.sheet.read_warnings : [],
      sheetTotalMin: st.sheet.sheet_total_min, submissionId: st.sheet.submission_id,
      confirmedAt: st.sheet.confirmed_at, returnReason: st.sheet.return_reason, returnedAt: st.sheet.returned_at,
      reviewSeconds: st.sheet.review_seconds, editCount: st.sheet.edit_count,
      confirmed: confirmed ? {
        totalMinutes: st.sheet.total_minutes, rawMinutes: st.sheet.raw_minutes, workDays: st.sheet.work_days,
        spillMinutes: st.sheet.spill_minutes, carryInMinutes: st.sheet.carry_in_minutes,
      } : null,
    } : null,
    days: ev ? ev.days.map(dayView) : [],
    summary: ev ? ev.summary : null,
    missingDates: ev ? ev.missingDates : [],
    confirm: confirm ? { ...confirm, ackLabels: Object.fromEntries(confirm.acks.map((a) => [a, ACK_LABEL[a]])) } : null,
    terms: {
      status: terms.status, partial: terms.partial, description: t ? describeTerms(t) : "",
      range: t && t.settlementMode === "range" ? { minMinutes: t.settleMinMinutes, maxMinutes: t.settleMaxMinutes } : null,
      rounding,
      candidates: terms.candidates.map((c) => ({ id: c.id, validFrom: c.validFrom, validTo: c.validTo, description: describeTerms(c) })),
      changedAfterConfirm: termsChanged,
    },
    settlement: confirmed ? settle({ terms, minutes: st.sheet.total_minutes }) : null,
    carryInMinutes: st.carryIn,
  };
}

const dayView = (d) => ({
  workDate: d.workDate, kind: d.kind, startMin: d.startMin, endMin: d.endMin, breakMin: d.breakMin,
  sheetWorkedMin: d.sheetWorkedMin, note: d.note, source: d.source, confidence: d.confidence,
  edited: d.edited, reviewed: Boolean(d.reviewedAt), worked: d.worked, counted: d.counted ?? null,
  flags: d.flags.map((f) => ({ code: f.code, text: f.text, blocking: f.blocking, origin: f.origin })),
  blocking: d.blocking, needsReview: d.needsReview,
});

// ---------------------------------------------------------------------------
// 書く（権限を確かめたあとの service_role）
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();

async function logEvent(ctx, user, k, kind, detail = {}) {
  try {
    await must(admin().from("gw_office_events").insert({
      tenant_id: ctx.tenantId, billing_month: k.month, employee_id: k.employeeId, site_contract_id: k.siteContractId,
      kind, actor_id: user.id, actor_name: ctx.employee?.display_name || null, detail,
    }));
  } catch (e) {
    // 履歴の失敗で、確定などの本処理を止めない（gwLog と同じ考え方）
    console.error("[office/timesheet] event failed:", e?.message || e);
  }
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: `office.${kind}`,
    target: `site_contract:${k.siteContractId}`, detail: { month: k.month, employeeId: k.employeeId, ...detail },
  });
}

/** 既存の5つの印を、勤務表の状態に合わせる。変えた印の名前を返す */
async function syncMarks(ctx, k, want) {
  const sb = admin();
  const p = await must(sb.from("gw_billing_progress").select(`id, ${STAGE_KEYS.join(", ")}`)
    .eq("tenant_id", ctx.tenantId).eq("employee_id", k.employeeId).eq("site_contract_id", k.siteContractId)
    .eq("billing_month", k.month).maybeSingle());
  const now = nowIso();
  const patch = {};
  const changed = [];
  for (const [key, val] of Object.entries(want)) {
    if (!STAGE_KEYS.includes(key)) continue;
    if (Boolean(p?.[key]) === val) continue;
    patch[key] = val;
    patch[`${key}_at`] = val ? now : null;
    changed.push(key);
  }
  if (!changed.length) return [];
  if (p) await must(sb.from("gw_billing_progress").update({ ...patch, updated_at: now }).eq("id", p.id).eq("tenant_id", ctx.tenantId));
  else {
    await must(sb.from("gw_billing_progress").insert({
      tenant_id: ctx.tenantId, employee_id: k.employeeId, site_contract_id: k.siteContractId, billing_month: k.month, ...patch,
    }));
  }
  return changed;
}

const aggColumns = (ev, carryIn) => ({
  raw_minutes: ev.summary.rawMinutes, total_minutes: ev.summary.totalMinutes, work_days: ev.summary.workDays,
  unresolved_count: ev.summary.unresolvedCount, flagged_count: ev.summary.reviewCount,
  spill_minutes: ev.summary.spillMinutes, carry_in_minutes: carryIn,
});

/** 日別から、月の集計を作り直して保存する。保存のたびに呼ぶ */
async function recompute(ctx, k, st, dayRows, extra = {}) {
  const terms = termsForMonth(st.termsRows.map(normalizeTerms), k.month);
  const rounding = terms.status === "ok" ? roundingOf(terms.terms) : null;
  const sheet = st.sheet;
  const ev = evaluateSheet(dayRows.map(normalizeDayRow), {
    month: k.month, rounding, carryInMinutes: st.carryIn, sheetTotalMin: sheet.sheet_total_min ?? null,
  });
  await must(admin().from("gw_timesheets").update({ ...aggColumns(ev, st.carryIn), ...extra, updated_at: nowIso() })
    .eq("id", sheet.id).eq("tenant_id", ctx.tenantId));
  return { ev, terms, rounding };
}

const sec = (v) => Math.min(MAX_REVIEW_SECONDS_PER_CALL, Math.max(0, Math.floor(Number(v) || 0)));

function requireDraft(st) {
  if (!st.sheet) stop(404, { error: "no_timesheet", hint: "AI読取または手入力で、下書きを作ってください" });
  if (st.sheet.status === "confirmed") stop(409, { error: "already_confirmed", hint: "確定済みです。直すには、確定を取り消してください" });
  if (st.sheet.status === "returned") stop(409, { error: "returned", hint: "差し戻し中です。新しい勤務表を受け取って、読み取ってください" });
}

// ---- upload / attach --------------------------------------------------------
async function upload({ res, ctx, k, body }) {
  const mimeType = String(body.mimeType || "");
  const ext = MIME_EXT[mimeType];
  if (!ext) return json(res, 400, { error: "unsupported_mime", hint: "PDF・JPEG・PNG のいずれかにしてください" });
  const size = Number(body.sizeBytes);
  if (!Number.isFinite(size) || size <= 0) return json(res, 400, { error: "invalid_request", detail: "sizeBytes が不正です" });
  if (size > MAX_BYTES) return json(res, 400, { error: "file_too_large", hint: "10MBまでです", max: MAX_BYTES });
  const submissionId = crypto.randomUUID();
  const path = `${ctx.tenantId}/${k.employeeId}/${submissionId}.${ext}`;
  const { data, error } = await admin().storage.from(BUCKET).createSignedUploadUrl(path);
  if (error) return json(res, 500, { error: "sign_failed", detail: error.message });
  return json(res, 200, { submissionId, path, uploadUrl: data.signedUrl, token: data.token });
}

async function attach({ req, res, ctx, user, k, body }) {
  const submissionId = String(body.submissionId || "");
  if (!UUID.test(submissionId)) return json(res, 400, { error: "invalid_request", detail: "submissionId が正しくありません" });
  const sb = admin();

  // すでに登録済みなら、そのまま返す（アップロード直後の再送・「それでも登録」の再試行に強くする）
  const done = await must(sb.from("gw_submissions").select("id").eq("id", submissionId).eq("tenant_id", ctx.tenantId).maybeSingle());
  if (done) return json(res, 200, { ...(await payload(req, ctx, k)), attached: submissionId, already: true });

  // 置き場所は、この人のこの提出のものだけ。自分で指定させると、他人・他社のファイルを掴める
  const found = await findUploaded(sb, ctx, k, submissionId);
  if (!found) return json(res, 400, { error: "no_file", hint: "置いたファイルを読めませんでした。もう一度アップロードしてください" });
  const { path, bytes } = found;

  if (bytes.length > MAX_BYTES) { await sb.storage.from(BUCKET).remove([path]); return json(res, 400, { error: "file_too_large", hint: "10MBまでです", max: MAX_BYTES }); }
  const fmt = detectDoc(bytes);
  if (!EXT[fmt]) {
    await sb.storage.from(BUCKET).remove([path]);
    return json(res, 400, { error: "unsupported_file", hint: "PDF・JPEG・PNG を選んでください" });
  }
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");

  // 同じファイルの検知。同じ人・月・契約の二重提出は登録しない。別の月・人に出ていたら、承知のうえで登録する
  const same = await must(sb.from("gw_submissions").select("id, employee_id, site_contract_id, target_month, submitted_at")
    .eq("tenant_id", ctx.tenantId).eq("kind", "timesheet").eq("sha256", sha).limit(50));
  const sameKey = (same || []).filter((r) => r.employee_id === k.employeeId && r.site_contract_id === k.siteContractId && r.target_month === k.month);
  if (sameKey.length) {
    await sb.storage.from(BUCKET).remove([path]);
    return json(res, 409, {
      error: "duplicate", existingId: sameKey[0].id,
      hint: "同じファイルが、この月の勤務表としてすでに届いています。登録しませんでした",
    });
  }
  const other = (same || []).filter((r) => !sameKey.includes(r));
  if (other.length && body.allowDuplicate !== true) {
    // ファイルは残す（「それでも登録」で、アップロードし直さずに続けられる）
    return json(res, 409, {
      error: "duplicate_other", count: other.length, submissionId,
      hint: "同じファイルが、別の月・別の人の勤務表としても提出されています。別のファイルではありませんか？",
    });
  }

  const filename = String(body.filename || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 160) || `timesheet.${EXT[fmt]}`;
  const mime = fmt === "pdf" ? "application/pdf" : fmt === "jpeg" ? "image/jpeg" : "image/png";
  const now = nowIso();
  await must(sb.from("gw_submissions").insert({
    id: submissionId, tenant_id: ctx.tenantId, employee_id: k.employeeId, site_contract_id: k.siteContractId,
    target_month: k.month, kind: "timesheet", file_name: filename, mime_type: mime, size_bytes: bytes.length,
    storage_path: path, submitted_at: now, sha256: sha, verified_at: now, uploaded_by: user.id, source: "office",
  }));
  const marks = await syncMarks(ctx, k, { timesheet_received: true });
  await logEvent(ctx, user, k, "timesheet.upload", { submissionId, fileName: filename, sizeBytes: bytes.length, marks, duplicateOther: other.length });
  return json(res, 200, { ...(await payload(req, ctx, k)), attached: submissionId });
}

/** 置かれたファイルを読む。パスは、こちらが決めた形のものだけ */
async function findUploaded(sb, ctx, k, submissionId) {
  for (const ext of Object.values(EXT)) {
    const path = `${ctx.tenantId}/${k.employeeId}/${submissionId}.${ext}`;
    const dl = await sb.storage.from(BUCKET).download(path);
    if (!dl.error && dl.data) return { path, bytes: Buffer.from(await dl.data.arrayBuffer()) };
  }
  return null;
}

// ---- read（AI読取）-----------------------------------------------------------
async function read({ req, res, ctx, user, k, body }) {
  const sb = admin();
  const st = await loadState(req, ctx, k);
  if (st.sheet?.status === "confirmed") return json(res, 409, { error: "already_confirmed", hint: "確定済みです。読み取り直すには、確定を取り消してください" });

  const sub = body.submissionId
    ? st.subs.find((s) => s.id === body.submissionId)
    : latestSubmission(st.subs);
  if (!sub) return json(res, 404, { error: "no_file", hint: "この月の勤務表のファイルがありません。先にアップロードしてください" });

  // 人が直した下書きを、AI の読み取りで黙って上書きしない
  const edited = st.sheet && (st.sheet.edit_count > 0 || st.days.some((d) => d.reviewed_at));
  if (edited && body.overwrite !== true) {
    return json(res, 409, { error: "has_edits", hint: "人が確認・入力した内容があります。読み取り直すと、その内容は消えます" });
  }

  // ファイルの実体を確かめる（外部フォームの行は、ここで初めて中身を見る）
  const dl = await sb.storage.from(BUCKET).download(sub.storage_path);
  if (dl.error || !dl.data) {
    return json(res, 404, { error: "file_missing", hint: "ファイルが見つかりません（アップロードが完了していない可能性があります）" });
  }
  const bytes = Buffer.from(await dl.data.arrayBuffer());
  const fmt = detectDoc(bytes);
  if (!EXT[fmt] || bytes.length > MAX_BYTES) return json(res, 400, { error: "unsupported_file", hint: "PDF・JPEG・PNG（10MBまで）だけ読み取れます。手入力してください" });
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sub.sha256 && sub.sha256 !== sha) return json(res, 409, { error: "file_changed", hint: "ファイルの内容が、登録したときと違います" });
  if (!sub.sha256 || !sub.verified_at) {
    await must(sb.from("gw_submissions").update({ sha256: sha, verified_at: nowIso() }).eq("id", sub.id).eq("tenant_id", ctx.tenantId));
  }

  const r = await readTimesheet({ buffer: bytes, month: k.month });
  const now = nowIso();

  if (!r.ok) {
    if (r.detail) console.error("[office/timesheet] AI read failed:", r.code, r.detail);
    // 読み取れなかったことを残す（手入力や再試行に進めるように）。すでに日別の値があれば、触らない
    if (!st.sheet) {
      await must(sb.from("gw_timesheets").insert({
        tenant_id: ctx.tenantId, employee_id: k.employeeId, site_contract_id: k.siteContractId, target_month: k.month,
        submission_id: sub.id, status: "draft", read_state: "failed", ai_message: r.message, ai_read_at: now, created_by: user.id,
      }));
    } else if (!st.days.length) {
      await must(sb.from("gw_timesheets").update({ read_state: "failed", ai_message: r.message, ai_read_at: now, updated_at: now })
        .eq("id", st.sheet.id).eq("tenant_id", ctx.tenantId));
    }
    await logEvent(ctx, user, k, "timesheet.read", { ok: false, code: r.code, submissionId: sub.id });
    return json(res, 422, { error: "read_failed", code: r.code, message: r.message });
  }

  const warnings = [...r.warnings];
  const nm = nameMatches(r.sheet.employeeName, k.employee.display_name);
  if (nm === false) warnings.push({ code: "name_mismatch", text: `勤務表の氏名（${r.sheet.employeeName}）が、登録の氏名（${k.employee.display_name}）と一致しません。別の人の勤務表ではありませんか？` });

  const sheetCols = {
    submission_id: sub.id, status: "draft", read_state: "ok", ai_model: r.model, ai_read_at: now, ai_message: null,
    sheet_employee_name: r.sheet.employeeName, read_warnings: warnings, sheet_total_min: r.sheet.totalWorkedMin,
    edit_count: 0, return_reason: null, returned_at: null, returned_by: null, updated_at: now,
  };
  let sheet;
  if (st.sheet) {
    sheet = await must(sb.from("gw_timesheets").update(sheetCols).eq("id", st.sheet.id).eq("tenant_id", ctx.tenantId).select(SHEET_FIELDS).single());
  } else {
    sheet = await must(sb.from("gw_timesheets").insert({
      tenant_id: ctx.tenantId, employee_id: k.employeeId, site_contract_id: k.siteContractId, target_month: k.month,
      created_by: user.id, ...sheetCols,
    }).select(SHEET_FIELDS).single());
  }

  // 日別を、AI の下書きで置き換える（全日ぶんの行。読めなかった日も not_read の印つきで入る）
  const rows = r.days.map((d) => ({
    tenant_id: ctx.tenantId, timesheet_id: sheet.id, work_date: d.workDate, kind: d.kind, start_min: d.startMin,
    end_min: d.endMin, break_min: d.breakMin, sheet_worked_min: d.sheetWorkedMin, note: d.note, source: "ai",
    ai_confidence: d.confidence, ai_flags: d.flags, ai_snapshot: d.snapshot, edited: false, reviewed_at: null, updated_at: now,
  }));
  await must(sb.from("gw_timesheet_days").upsert(rows, { onConflict: "timesheet_id,work_date" }));

  const st2 = { ...st, sheet };
  const { ev } = await recompute(ctx, k, st2, rows.map(toDayRow));
  await logEvent(ctx, user, k, "timesheet.read", {
    ok: true, submissionId: sub.id, model: r.model, days: r.days.length, flagged: ev.summary.reviewCount,
    unresolved: ev.summary.unresolvedCount, inputTokens: r.usage?.inputTokens ?? null, outputTokens: r.usage?.outputTokens ?? null,
  });
  return json(res, 200, { ...(await payload(req, ctx, k)), done: "read" });
}

/** insert する行 → 評価で読む形（DB から読んだ行と同じ列名） */
const toDayRow = (r) => ({
  work_date: r.work_date, kind: r.kind, start_min: r.start_min, end_min: r.end_min, break_min: r.break_min,
  sheet_worked_min: r.sheet_worked_min, note: r.note, source: r.source, ai_confidence: r.ai_confidence,
  ai_flags: r.ai_flags, edited: r.edited, reviewed_at: r.reviewed_at,
});

// ---- blank（手入力で始める）---------------------------------------------------
async function blank({ req, res, ctx, user, k }) {
  const sb = admin();
  const st = await loadState(req, ctx, k);
  if (st.sheet && (st.sheet.status === "confirmed" || st.days.length)) {
    return json(res, 409, { error: "already_exists", hint: "この月の勤務表は、すでに始まっています" });
  }
  const now = nowIso();
  const sub = latestSubmission(st.subs);
  let sheet = st.sheet;
  if (!sheet) {
    sheet = await must(sb.from("gw_timesheets").insert({
      tenant_id: ctx.tenantId, employee_id: k.employeeId, site_contract_id: k.siteContractId, target_month: k.month,
      submission_id: sub?.id || null, status: "draft", read_state: "none", created_by: user.id,
    }).select(SHEET_FIELDS).single());
  } else {
    sheet = await must(sb.from("gw_timesheets").update({ status: "draft", read_state: "none", ai_message: null, return_reason: null, updated_at: now })
      .eq("id", sheet.id).eq("tenant_id", ctx.tenantId).select(SHEET_FIELDS).single());
  }
  const rows = blankDays(k.month).map((d) => ({
    tenant_id: ctx.tenantId, timesheet_id: sheet.id, work_date: d.workDate, kind: null, source: "manual",
    ai_flags: [], edited: false, reviewed_at: null, updated_at: now,
  }));
  await must(sb.from("gw_timesheet_days").upsert(rows, { onConflict: "timesheet_id,work_date" }));
  await recompute(ctx, k, { ...st, sheet }, rows.map(toDayRow));
  await logEvent(ctx, user, k, "timesheet.save", { op: "blank", days: rows.length });
  return json(res, 200, { ...(await payload(req, ctx, k)), done: "blank" });
}

// ---- save / bulk ----------------------------------------------------------------
async function applyTargets({ req, ctx, user, k, st, targets, extraCols = {}, op }) {
  const sb = admin();
  const byDate = new Map(st.days.map((r) => [r.work_date, r]));
  const now = nowIso();
  let fields = 0;
  let touched = 0;
  const writes = [];
  const after = new Map(st.days.map((r) => [r.work_date, r]));

  for (const t of targets) {
    const cur = byDate.get(t.workDate);
    if (!cur) stop(400, { error: "invalid_request", detail: `対象月にない日、または行がありません：${t.workDate}` });
    const day = normalizeDayRow(cur);
    const { row, changed } = applyPatch(day, t.patch || {}, now);
    const cols = {};
    for (const c of changed) cols[c] = t.patch[c];
    if (changed.length) { cols.edited = true; cols.reviewed_at = now; }
    if (t.review && !row.reviewedAt) { cols.reviewed_at = now; }
    if (!Object.keys(cols).length) continue;
    fields += changed.length;
    touched += 1;
    writes.push(must(sb.from("gw_timesheet_days").update({ ...cols, updated_at: now })
      .eq("tenant_id", ctx.tenantId).eq("timesheet_id", st.sheet.id).eq("work_date", t.workDate)));
    after.set(t.workDate, { ...cur, ...cols });
  }
  await Promise.all(writes);
  const sheetExtra = { edit_count: (st.sheet.edit_count || 0) + fields, review_seconds: (st.sheet.review_seconds || 0) + sec(extraCols.reviewSeconds) };
  await recompute(ctx, k, st, [...after.values()], sheetExtra);
  if (touched) await logEvent(ctx, user, k, "timesheet.save", { op: op || "edit", days: touched, fields });
  return { touched, fields };
}

async function save({ req, res, ctx, user, k, body }) {
  const st = await loadState(req, ctx, k);
  requireDraft(st);
  const list = Array.isArray(body.days) ? body.days : null;
  if (!list || !list.length) return json(res, 400, { error: "invalid_request", detail: "days（日ごとの入力）を指定してください" });
  if (list.length > 62) return json(res, 400, { error: "invalid_request", detail: "一度に直せるのは 62 件までです" });

  // 全部検査してから書く（1つでも読めなければ、何も保存しない）
  const errors = {};
  const targets = [];
  for (const d of list) {
    const workDate = String(d?.workDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate) || workDate.slice(0, 7) !== k.month) {
      errors[workDate || "?"] = ["対象月の日付ではありません"];
      continue;
    }
    const p = parseDayInput(d);
    if (!p.ok) { errors[workDate] = p.errors; continue; }
    targets.push({ workDate, patch: p.patch, review: d.reviewed === true });
  }
  if (Object.keys(errors).length) return json(res, 400, { error: "invalid_input", errors });

  await applyTargets({ req, ctx, user, k, st, targets, extraCols: { reviewSeconds: body.reviewSeconds } });
  return json(res, 200, { ...(await payload(req, ctx, k)), done: "save" });
}

async function bulk({ req, res, ctx, user, k, body }) {
  const st = await loadState(req, ctx, k);
  requireDraft(st);
  const terms = termsForMonth(st.termsRows.map(normalizeTerms), k.month);
  const ev = evaluateSheet(st.days.map(normalizeDayRow), { month: k.month, rounding: terms.status === "ok" ? roundingOf(terms.terms) : null, carryInMinutes: st.carryIn });
  const r = bulkPatches(body.op, { ...body, month: k.month }, ev.days);
  if (!r.ok) return json(res, 400, { error: "invalid_request", detail: r.error });
  const out = await applyTargets({ req, ctx, user, k, st, targets: r.targets, extraCols: { reviewSeconds: body.reviewSeconds }, op: body.op });
  return json(res, 200, { ...(await payload(req, ctx, k)), done: "bulk", changedDays: out.touched });
}

// ---- confirm / reopen / return ---------------------------------------------------
async function confirm({ req, res, ctx, user, k, body }) {
  const st = await loadState(req, ctx, k);
  requireDraft(st);
  const terms = termsForMonth(st.termsRows.map(normalizeTerms), k.month);
  const rounding = terms.status === "ok" ? roundingOf(terms.terms) : null;
  const ev = evaluateSheet(st.days.map(normalizeDayRow), {
    month: k.month, rounding, carryInMinutes: st.carryIn, sheetTotalMin: st.sheet.sheet_total_min ?? null,
  });
  const c = canConfirm(st.sheet.status, ev);
  if (!c.ok) return json(res, 409, { error: "not_ready", blockers: c.blockers });
  const acked = new Set(Array.isArray(body.ack) ? body.ack : []);
  const missing = c.acks.filter((a) => !acked.has(a));
  if (missing.length) return json(res, 409, { error: "ack_required", acks: missing, ackLabels: Object.fromEntries(missing.map((a) => [a, ACK_LABEL[a]])) });

  const now = nowIso();
  // 下書きのときだけ確定する（同時に別の人が確定・差し戻ししていたら、断る）
  const updated = await must(admin().from("gw_timesheets").update({
    ...aggColumns(ev, st.carryIn), status: "confirmed", confirmed_at: now, confirmed_by: user.id,
    terms_id: terms.terms?.id || null, rounding_unit: rounding?.unit || null, rounding_mode: rounding?.mode || null,
    rounding_scope: rounding?.scope || null, review_seconds: (st.sheet.review_seconds || 0) + sec(body.reviewSeconds),
    return_reason: null, updated_at: now,
  }).eq("id", st.sheet.id).eq("tenant_id", ctx.tenantId).eq("status", "draft").select("id"));
  if (!updated?.length) return json(res, 409, { error: "state_changed", hint: "他の操作で状態が変わりました。開き直してください" });

  const marks = await syncMarks(ctx, k, { timesheet_received: true, work_confirmed: true });
  await logEvent(ctx, user, k, "timesheet.confirm", {
    totalMinutes: ev.summary.totalMinutes, workDays: ev.summary.workDays, acks: [...acked].filter((a) => c.acks.includes(a)),
    reviewSeconds: (st.sheet.review_seconds || 0) + sec(body.reviewSeconds), editCount: st.sheet.edit_count || 0,
    flaggedDays: ev.days.filter((d) => d.flags.length).length, marks,
  });
  return json(res, 200, { ...(await payload(req, ctx, k)), done: "confirm" });
}

async function reopen({ req, res, ctx, user, k, body }) {
  const st = await loadState(req, ctx, k);
  if (st.sheet?.status !== "confirmed") return json(res, 409, { error: "not_confirmed", hint: "確定していません" });
  const reason = String(body.reason || "").trim();
  if (!reason) return json(res, 400, { error: "reason_required", hint: "確定を取り消す理由を入れてください" });
  if (reason.length > 200) return json(res, 400, { error: "invalid_request", detail: "理由は 200 字までです" });

  // 請求書を作成・送付済みなら、その稼働時間で請求している。ここでは取り消せない
  const p = await must(userClient(req).from("gw_billing_progress").select("board_created, sent")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", k.employeeId).eq("site_contract_id", k.siteContractId)
    .eq("billing_month", k.month).maybeSingle());
  if (p?.board_created || p?.sent) {
    return json(res, 409, { error: "invoiced", hint: "請求書を作成・送付済みのため、確定を取り消せません。先に請求側の対応が必要です" });
  }

  const now = nowIso();
  const updated = await must(admin().from("gw_timesheets").update({
    status: "draft", confirmed_at: null, confirmed_by: null, terms_id: null, rounding_unit: null,
    rounding_mode: null, rounding_scope: null, updated_at: now,
  }).eq("id", st.sheet.id).eq("tenant_id", ctx.tenantId).eq("status", "confirmed").select("id"));
  if (!updated?.length) return json(res, 409, { error: "state_changed", hint: "他の操作で状態が変わりました。開き直してください" });
  const marks = await syncMarks(ctx, k, { work_confirmed: false });
  await logEvent(ctx, user, k, "timesheet.reopen", { reason, marks });
  return json(res, 200, { ...(await payload(req, ctx, k)), done: "reopen" });
}

async function giveBack({ req, res, ctx, user, k, body }) {
  const st = await loadState(req, ctx, k);
  if (st.sheet?.status === "confirmed") return json(res, 409, { error: "already_confirmed", hint: "確定済みです。先に確定を取り消してください" });
  const reason = String(body.reason || "").trim();
  if (!reason) return json(res, 400, { error: "reason_required", hint: "差し戻す理由（再提出をお願いする内容）を入れてください" });
  if (reason.length > 200) return json(res, 400, { error: "invalid_request", detail: "理由は 200 字までです" });
  if (!st.sheet && !st.subs.length) return json(res, 409, { error: "no_file", hint: "勤務表がまだ届いていません" });

  const sb = admin();
  const now = nowIso();
  const cols = { status: "returned", return_reason: reason, returned_at: now, returned_by: user.id, updated_at: now };
  if (st.sheet) {
    await must(sb.from("gw_timesheets").update(cols).eq("id", st.sheet.id).eq("tenant_id", ctx.tenantId));
  } else {
    await must(sb.from("gw_timesheets").insert({
      tenant_id: ctx.tenantId, employee_id: k.employeeId, site_contract_id: k.siteContractId, target_month: k.month,
      submission_id: latestSubmission(st.subs)?.id || null, read_state: "none", created_by: user.id, ...cols,
    }));
  }
  // 再提出を待つ。届いたことにはしない（メールは送らない。連絡は人が、これまでの方法で）
  const marks = await syncMarks(ctx, k, { timesheet_received: false });
  await logEvent(ctx, user, k, "timesheet.return", { reason, marks });
  return json(res, 200, { ...(await payload(req, ctx, k)), done: "return" });
}
