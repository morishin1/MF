// /api/office/close — Office の月次完了
//
//   GET  ?month=YYYY-MM                       … 完了できるか（残っている行）と、完了の記録
//   POST { action: "close",  month, note? }   … 月次完了にする。全部の行が「完了」であること。要確認が残るときは note が要る
//   POST { action: "reopen", month, reason }  … 月次完了を取り消す（記録は残す）
//
// ■ 「完了」の判定は /api/office の一覧と同じ計算（api/office/index.js の monthData・lib/office.js の deriveRow）
//   PP（売上のみ）… 売上請求書の送付まで。BP … 送付・BP請求書の受領・支払済まで（db/117 の支払の記録）。
//   支払の表（db/117）が無いときは、BP の行は完了にならないので、月次完了もできない。
//
// ■ gw_month_closings（打刻ロック）は使わない。完了した月は、仕入請求・支払の書き込みを断る（api/office/payables.js）。
//
// ■ 入れる人：経営者・責任者・経理（canAccessOffice）。完了・取消しは経営者・経理だけ。MFA は要求しない（Office の方針）。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canAccessOffice } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { isBillingMonth } from "../../lib/billing-progress.js";
import { jstDate } from "../../lib/timecard.js";
import { monthData } from "./index.js";
import { canRecordPayment } from "./payables.js";

const SQL = "db/117_office_payables.sql";
const must = async (q) => { const { data, error } = await q; if (error) throw error; return data; };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canAccessOffice(ctx)) return json(res, 403, { error: "forbidden" });

  res.setHeader("Cache-Control", "no-store");
  try {
    const body = req.method === "POST" ? ((await readJson(req)) || {}) : {};
    const month = req.method === "GET" ? new URL(req.url, "http://localhost").searchParams.get("month") : body.month;
    if (!isBillingMonth(month)) return json(res, 400, { error: "invalid_request", detail: "month は YYYY-MM で指定してください" });

    const st = await readiness(req, ctx, month);
    if (st.error) return json(res, st.status, st.error);
    if (req.method === "GET") return json(res, 200, st.view);

    if (!canRecordPayment(ctx)) return json(res, 403, { error: "close_forbidden", hint: "月次完了は、経営者・経理だけができます" });
    if (body.action === "close") return await close(res, ctx, user, month, body, st);
    if (body.action === "reopen") return await reopen(res, ctx, user, month, body, st);
    return json(res, 400, { error: "invalid_action", detail: "close, reopen" });
  } catch (e) {
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    if (e?.code === "23505") return json(res, 409, { error: "already_closed", hint: "この月は、すでに月次完了です" });
    console.error("[office/close]", e?.message || e);
    return json(res, 500, { error: "close_failed" });
  }
}

/** 完了できるか。一覧と同じ計算で、残っている行・要確認の行を数える */
async function readiness(req, ctx, month) {
  const out = await monthData(req, ctx, month, jstDate());
  if (out.status !== 200) return { status: out.status, error: out.body };
  const b = out.body;
  if (b.phase4 && !b.phase4.ready) return { status: 503, error: { error: "not_ready", message: b.phase4.message } };
  const rows = b.rows || [];
  const remaining = rows.filter((r) => r.stage !== "done")
    .map((r) => ({ siteContractId: r.siteContractId, employeeName: r.employeeName, siteCompany: r.siteCompany, stage: r.stage, stageLabel: r.stageLabel }));
  const checked = rows.filter((r) => r.check)
    .map((r) => ({ siteContractId: r.siteContractId, employeeName: r.employeeName, warnings: r.warnings }));
  return {
    rows,
    view: {
      month, close: b.close || { closed: false },
      total: rows.length, done: rows.length - remaining.length,
      canClose: !b.close?.closed && rows.length > 0 && remaining.length === 0,
      remaining, checked,
      notReady: Boolean(b.notReady || b.accessNotReady), message: b.message || null,
    },
  };
}

async function close(res, ctx, user, month, body, st) {
  const v = st.view;
  if (v.close.closed) return json(res, 409, { error: "already_closed", hint: "この月は、すでに月次完了です" });
  if (v.notReady) return json(res, 409, { error: "not_ready", hint: v.message });
  if (!v.total) return json(res, 409, { error: "no_rows", hint: "この月の対象案件がありません" });
  if (v.remaining.length) {
    return json(res, 409, { error: "not_done", remaining: v.remaining, hint: `まだ終わっていない案件が ${v.remaining.length} 件あります` });
  }
  const note = String(body.note || "").trim();
  if (note.length > 500) return json(res, 400, { error: "invalid_request", detail: "メモは 500 字までです" });
  if (v.checked.length && !note) {
    return json(res, 409, { error: "check_note_required", checked: v.checked, hint: `要確認の案件が ${v.checked.length} 件あります。確認した内容を書いてから完了してください` });
  }
  const row = await must(admin().from("gw_office_month_closes").insert({
    tenant_id: ctx.tenantId, billing_month: month, closed_by: user.id, closed_by_name: ctx.employee?.display_name || null,
    rows_total: v.total, rows_checked: v.checked.length, check_note: note || null,
  }).select("id, closed_at").single());
  await event(ctx, user, month, "month.close", { closeId: row.id, rows: v.total, checked: v.checked.length });
  return json(res, 200, { done: "close", closedAt: row.closed_at });
}

async function reopen(res, ctx, user, month, body, st) {
  if (!st.view.close.closed) return json(res, 409, { error: "not_closed", hint: "この月は、月次完了になっていません" });
  const reason = String(body.reason || "").trim();
  if (!reason) return json(res, 400, { error: "reason_required", hint: "取り消す理由を入れてください" });
  if (reason.length > 500) return json(res, 400, { error: "invalid_request", detail: "理由は 500 字までです" });
  const rows = await must(admin().from("gw_office_month_closes").update({
    reopened_at: new Date().toISOString(), reopened_by: user.id, reopen_reason: reason,
  }).eq("tenant_id", ctx.tenantId).eq("billing_month", month).is("reopened_at", null).select("id"));
  await event(ctx, user, month, "month.reopen", { closeId: rows?.[0]?.id || null });
  return json(res, 200, { done: "reopen" });
}

async function event(ctx, user, month, kind, detail) {
  try {
    await must(admin().from("gw_office_events").insert({
      tenant_id: ctx.tenantId, billing_month: month, kind, actor_id: user.id, actor_name: ctx.employee?.display_name || null, detail,
    }));
  } catch (e) { console.error("[office/close] event failed:", e?.message || e); }
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: `office.${kind}`, target: `office_month:${month}`, detail: { month, ...detail } });
}
