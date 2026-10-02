// POST /api/office/contracts — 案件（現場契約）の、複数件まとめての更新・削除
//
//   { action: "preview", ids: [<現場契約id>…], month }   … 削除の確認用。件数と、削除できない理由を返す（何も書かない）
//   { action: "update",  ids, month, fields: { renewalStatus?, periodTo?, periodFrom? } }
//   { action: "delete",  ids, month, confirm: true, confirmCount: <idsの件数> }
//
// ■ 入れる人：Office の権限（経営者 OR 責任者 OR 経理）。api/office/index.js と同じ。二段階認証（MFA）は要求しない。
//   HR・Sales など、ほかの系統の API・判定には依存しない
//
// ■ 一括で変えてよいのは、複数の案件に共通して安全なものだけ
//     renewalStatus … 更新確認状況（pending／confirmed／ending／renewed）
//     periodTo      … 契約終了予定（日付。null で「未定」に戻す）
//     periodFrom    … 契約開始日（契約期間の開始）
//   単価・精算条件・勤務時間・勤務表は、案件ごとに違うので、ここでは変えられない（ほかの項目は 400）
//   期間を変えるとき：終了 ≥ 開始。その契約に、新しい期間の外の月の記録（月次進捗・勤務表）があれば、断る
//   どれか1件でも条件に合わなければ、何も変えない（全部か、ゼロか）
//
// ■ 削除
//   消すのは現場契約（案件）の行。外部キー（on delete cascade）で、その契約の
//   月次進捗・提出ファイルの記録・契約条件・勤務表・日別データも、一緒に消える。要員（社員名簿）は消さない。
//   ・即削除は禁止：confirm: true と、confirmCount（= 選んだ件数）の両方が要る
//   ・Storage の勤務表ファイルが、DB の行だけ消えて孤児にならないように、先にファイルを消す。
//     ファイルの削除に失敗したら、DB は触らない（行が残るので、もう一度やり直せる）
//   ・請求書の作成・送付の印、BP請求書の受領の印が付いている案件は、消せない（請求の記録を、一緒に消さないため）
//
// ■ 履歴：gw_office_events（contract.update／contract.delete。案件ごとに1行）と、操作ログ（gw_activity_log）。
//   削除した契約の id は、履歴の外部キー（on delete set null）では残らないので、detail に入れる。
//   detail に、金額・単価・氏名は入れない（件数と、案件の客先名・期間・状態まで）
//
// ■ 読むのはログインした人の権限（RLS）、書くのは権限を確かめたあとの service_role

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canAccessOffice } from "../../lib/gw.js";
import { userClient, admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { isBillingMonth } from "../../lib/billing-progress.js";
import { jstDate } from "../../lib/timecard.js";

const SQL = "db/105_office_timesheet_base.sql・db/106_office_contract_terms.sql・db/107_office_timesheets.sql";
const BUCKET = "billing-submissions";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 100;
const RENEWAL = ["pending", "confirmed", "ending", "renewed"];
const FIELD_KEYS = ["renewalStatus", "periodTo", "periodFrom"];
const COLS = "id, employee_id, engagement_kind, site_company, period_from, period_to, renewal_status";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canAccessOffice(ctx)) return json(res, 403, { error: "forbidden" });

  res.setHeader("Cache-Control", "no-store");
  try {
    const body = (await readJson(req)) || {};
    const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
    if (!ids.length || ids.length > MAX_IDS || !ids.every((i) => UUID.test(i))) {
      return json(res, 400, { error: "invalid_request", detail: `ids は、現場契約の id を 1〜${MAX_IDS} 件` });
    }
    const month = isBillingMonth(body.month) ? body.month : jstDate().slice(0, 7);

    const contracts = await must(userClient(req).from("gw_site_contracts").select(COLS)
      .eq("tenant_id", ctx.tenantId).in("id", ids).limit(MAX_IDS));
    const byId = new Map((contracts || []).map((c) => [c.id, c]));
    const missing = ids.filter((i) => !byId.has(i));
    if (missing.length) return json(res, 404, { error: "contract_not_found", missing });

    const emps = await must(admin().from("gw_employees").select("id, display_name")
      .eq("tenant_id", ctx.tenantId).in("id", [...new Set(contracts.map((c) => c.employee_id))]).limit(MAX_IDS));
    const nameOf = new Map((emps || []).map((e) => [e.id, e.display_name]));
    const list = ids.map((i) => byId.get(i));
    const args = { req, res, ctx, user, body, month, list, nameOf };

    if (body.action === "preview") return await preview(args);
    if (body.action === "update") return await update(args);
    if (body.action === "delete") return await remove(args);
    return json(res, 400, { error: "invalid_request", detail: "action は preview・update・delete" });
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error("[office/contracts]", e?.message || e);
    return json(res, 500, { error: "contracts_failed" });
  }
}

const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };
// Phase 3 の表（db/105〜107）が無い環境では、その表は「0件」として扱う（ほかの表は、そのまま失敗にする）
const optional = async (q) => {
  const { data, error } = await q;
  if (error) { if (dbSetupHint(error, SQL)) return []; throw error; }
  return data || [];
};
const isDate = (v) => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;     // 2026-02-30・2026-13-01 は実在しない
};

/** 契約ごとの、関連する記録の件数と、削除できない理由 */
async function related(ctx, ids) {
  const sb = admin();
  const [files, sheets, terms, progress] = await Promise.all([
    must(sb.from("gw_submissions").select("id, site_contract_id, storage_path").eq("tenant_id", ctx.tenantId).in("site_contract_id", ids).limit(5000)),
    optional(sb.from("gw_timesheets").select("id, site_contract_id, status, target_month").eq("tenant_id", ctx.tenantId).in("site_contract_id", ids).limit(5000)),
    optional(sb.from("gw_site_contract_terms").select("id, site_contract_id").eq("tenant_id", ctx.tenantId).in("site_contract_id", ids).limit(5000)),
    must(sb.from("gw_billing_progress").select("id, site_contract_id, billing_month, board_created, sent, bp_invoice_received")
      .eq("tenant_id", ctx.tenantId).in("site_contract_id", ids).limit(5000)),
  ]);
  const of = (rows, id) => (rows || []).filter((r) => r.site_contract_id === id);
  const out = new Map();
  for (const id of ids) {
    const p = of(progress, id), s = of(sheets, id), f = of(files, id);
    out.set(id, {
      counts: { files: f.length, sheets: s.length, confirmedSheets: s.filter((x) => x.status === "confirmed").length, terms: of(terms, id).length, progress: p.length },
      paths: f.map((x) => x.storage_path).filter(Boolean),
      months: [...p.map((x) => x.billing_month), ...s.map((x) => x.target_month)].filter(Boolean).sort(),
      billed: p.some((x) => x.board_created || x.sent || x.bp_invoice_received),
    });
  }
  return out;
}

const view = (c, nameOf, rel) => ({
  id: c.id, employeeName: nameOf.get(c.employee_id) || "", siteCompany: c.site_company, engagementKind: c.engagement_kind,
  periodFrom: c.period_from, periodTo: c.period_to || null, renewalStatus: c.renewal_status,
  ...(rel ? { counts: rel.counts, blocked: rel.billed ? "billed" : null } : {}),
});

async function preview({ res, ctx, list, nameOf }) {
  const rel = await related(ctx, list.map((c) => c.id));
  const contracts = list.map((c) => view(c, nameOf, rel.get(c.id)));
  const sum = (k) => contracts.reduce((a, c) => a + c.counts[k], 0);
  return json(res, 200, {
    count: contracts.length, contracts,
    totals: { files: sum("files"), sheets: sum("sheets"), confirmedSheets: sum("confirmedSheets"), terms: sum("terms"), progress: sum("progress") },
    blocked: contracts.filter((c) => c.blocked).map((c) => ({ id: c.id, reason: "billed" })),
    note: "消すのは案件（現場契約）と、その月次進捗・提出ファイル・契約条件・勤務表です。要員（社員名簿）は消えません",
  });
}

async function event(ctx, user, c, month, kind, detail, { keepContract = true } = {}) {
  try {
    await must(admin().from("gw_office_events").insert({
      tenant_id: ctx.tenantId, billing_month: month, employee_id: c.employee_id, site_contract_id: keepContract ? c.id : null, kind,
      actor_id: user.id, actor_name: ctx.employee?.display_name || null, detail,
    }));
  } catch (e) { console.error("[office/contracts] event failed:", e?.message || e); }
}

async function update({ res, ctx, user, body, month, list, nameOf }) {
  const f = body.fields && typeof body.fields === "object" ? body.fields : null;
  if (!f) return json(res, 400, { error: "invalid_request", detail: "fields が要ります" });
  const unknown = Object.keys(f).filter((k) => !FIELD_KEYS.includes(k));
  if (unknown.length) {
    return json(res, 400, { error: "field_not_allowed", fields: unknown,
      hint: "一括で変えられるのは、更新確認状況・契約終了予定・契約開始日だけです。単価・精算条件・勤務時間は、案件ごとに変えてください" });
  }
  const has = (k) => Object.hasOwn(f, k);
  if (!FIELD_KEYS.some(has)) return json(res, 400, { error: "invalid_request", detail: "変える項目がありません" });
  const errors = [];
  if (has("renewalStatus") && !RENEWAL.includes(f.renewalStatus)) errors.push("更新確認状況が正しくありません");
  if (has("periodFrom") && !isDate(f.periodFrom)) errors.push("契約開始日は、正しい日付（YYYY-MM-DD）で入れてください");
  if (has("periodTo") && f.periodTo !== null && !isDate(f.periodTo)) errors.push("契約終了予定は、正しい日付（YYYY-MM-DD）か、未定（空）にしてください");
  if (errors.length) return json(res, 400, { error: "invalid_input", errors });

  // 期間：案件ごとに、新しい期間を作って確かめる。1件でも合わなければ、何も変えない
  const patch = {};
  if (has("renewalStatus")) patch.renewal_status = f.renewalStatus;
  if (has("periodFrom")) patch.period_from = f.periodFrom;
  if (has("periodTo")) patch.period_to = f.periodTo;
  const conflicts = [];
  if (has("periodFrom") || has("periodTo")) {
    const rel = await related(ctx, list.map((c) => c.id));
    for (const c of list) {
      const from = has("periodFrom") ? f.periodFrom : c.period_from;
      const to = has("periodTo") ? f.periodTo : c.period_to;
      const who = { id: c.id, employeeName: nameOf.get(c.employee_id) || "", siteCompany: c.site_company };
      if (to && to < from) { conflicts.push({ ...who, reason: `終了予定（${to}）が、開始日（${from}）より前になります` }); continue; }
      const months = rel.get(c.id).months;
      if (months.length && from.slice(0, 7) > months[0]) conflicts.push({ ...who, reason: `${months[0]}分の記録があるため、開始日を ${from} にできません` });
      else if (months.length && to && to.slice(0, 7) < months[months.length - 1]) conflicts.push({ ...who, reason: `${months[months.length - 1]}分の記録があるため、終了予定を ${to} にできません` });
    }
  }
  if (conflicts.length) return json(res, 409, { error: "period_conflict", conflicts });

  const now = new Date().toISOString();
  const ids = list.map((c) => c.id);
  await must(admin().from("gw_site_contracts").update({ ...patch, updated_at: now }).eq("tenant_id", ctx.tenantId).in("id", ids));
  const changed = Object.keys(f);
  const after = { ...(has("renewalStatus") ? { renewalStatus: f.renewalStatus } : {}), ...(has("periodFrom") ? { periodFrom: f.periodFrom } : {}), ...(has("periodTo") ? { periodTo: f.periodTo } : {}) };
  for (const c of list) {
    await event(ctx, user, c, month, "contract.update", {
      changed, after, count: list.length,
      before: { ...(has("renewalStatus") ? { renewalStatus: c.renewal_status } : {}), ...(has("periodFrom") ? { periodFrom: c.period_from } : {}), ...(has("periodTo") ? { periodTo: c.period_to || null } : {}) },
    });
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "office.contract.update", target: `site_contracts:${ids.length}`, detail: { ids, changed, after } });
  return json(res, 200, { updated: ids.length, contracts: list.map((c) => ({ id: c.id, siteCompany: c.site_company, ...after })) });
}

async function remove({ res, ctx, user, body, month, list, nameOf }) {
  // 即削除は禁止：明示の確認と、件数の一致が要る
  if (body.confirm !== true || body.confirmCount !== list.length) {
    return json(res, 400, { error: "confirm_required", hint: `削除するには、確認（confirm: true）と、件数（${list.length}）の一致が要ります` });
  }
  const ids = list.map((c) => c.id);
  const rel = await related(ctx, ids);
  const blocked = list.filter((c) => rel.get(c.id).billed);
  if (blocked.length) {
    return json(res, 409, {
      error: "has_billing",
      hint: "請求書の作成・送付、BP請求書の受領の印が付いている案件は、削除できません（請求の記録を、一緒に消さないため）",
      contracts: blocked.map((c) => ({ id: c.id, employeeName: nameOf.get(c.employee_id) || "", siteCompany: c.site_company })),
    });
  }

  // 1) Storage の勤務表ファイルを先に消す。失敗したら、DB は触らない（行が残るので、やり直せる）
  const paths = [...new Set(ids.flatMap((id) => rel.get(id).paths))];
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await admin().storage.from(BUCKET).remove(paths.slice(i, i + 100));
    if (error) {
      console.error("[office/contracts] storage remove failed:", error.message);
      return json(res, 502, { error: "storage_failed", hint: "勤務表のファイルを消せなかったため、何も削除していません。しばらくしてから、もう一度お試しください" });
    }
  }

  // 2) DB：現場契約を消す（月次進捗・提出ファイルの記録・契約条件・勤務表・日別は、外部キーで一緒に消える。履歴は、契約の id だけ外れて残る）
  let deleted;
  try {
    deleted = await must(admin().from("gw_site_contracts").delete().eq("tenant_id", ctx.tenantId).in("id", ids).select("id"));
  } catch (e) {
    console.error("[office/contracts] delete failed:", e?.message || e);
    return json(res, 500, { error: "delete_failed", hint: "ファイルは削除済みですが、案件の削除に失敗しました。もう一度、削除を実行してください（やり直して問題ありません）" });
  }
  for (const c of list) {
    const r = rel.get(c.id);
    await event(ctx, user, c, month, "contract.delete", {
      contractId: c.id, siteCompany: c.site_company, engagementKind: c.engagement_kind, periodFrom: c.period_from, periodTo: c.period_to || null,
      deleted: r.counts, storageRemoved: r.paths.length, count: list.length,
    }, { keepContract: false });
  }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "office.contract.delete", target: `site_contracts:${ids.length}`,
    detail: { ids, storageRemoved: paths.length } });
  return json(res, 200, { deleted: (deleted || []).length, storageRemoved: paths.length });
}
