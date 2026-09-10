// GET   /api/devices/policy   … 会社ごとの設定
// PATCH /api/devices/policy   … 更新
//
// ■ 何をアラートにするかは会社が決める
//   ブラウザ側で決めさせない。
//
// ■ 保存期間もここ
//   日別は13か月が既定。「いつまでも取ってある」状態にしないための設定で、
//   短くする方向にしか使わない想定。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";

const SQL = "db/053_devices.sql";

const DEFAULTS = {
  night_from: "22:00", night_to: "05:00",
  unknown_alert: true, night_alert: true,
  night_min_minutes: 60, holiday_min_minutes: 120,
  stale_days: 60,
  keep_events_days: 400, keep_daily_months: 13,
};

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = admin();

  if (req.method === "GET") {
    const { data, error } = await sb.from("gw_device_policies")
      .select("*").eq("tenant_id", ctx.tenantId).maybeSingle();
    if (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, 500, { error: "db_query_failed", detail: error.message });
    }
    return json(res, 200, { policy: { ...DEFAULTS, ...(data || {}) } });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    const row = { tenant_id: ctx.tenantId, updated_by: user.id, updated_at: new Date().toISOString() };

    const num = (v, lo, hi) => Math.min(Math.max(Math.round(Number(v) || 0), lo), hi);
    if (body.nightMinMinutes !== undefined) row.night_min_minutes = num(body.nightMinMinutes, 5, 720);
    if (body.holidayMinMinutes !== undefined) row.holiday_min_minutes = num(body.holidayMinMinutes, 5, 720);
    if (body.staleDays !== undefined) row.stale_days = num(body.staleDays, 7, 365);
    if (body.keepEventsDays !== undefined) row.keep_events_days = num(body.keepEventsDays, 30, 1000);
    if (body.keepDailyMonths !== undefined) row.keep_daily_months = num(body.keepDailyMonths, 1, 60);
    if (body.unknownAlert !== undefined) row.unknown_alert = Boolean(body.unknownAlert);
    if (body.nightAlert !== undefined) row.night_alert = Boolean(body.nightAlert);
    const hhmm = (v) => (/^\d{2}:\d{2}$/.test(String(v)) ? String(v) : null);
    if (hhmm(body.nightFrom)) row.night_from = hhmm(body.nightFrom);
    if (hhmm(body.nightTo)) row.night_to = hhmm(body.nightTo);

    const { data, error } = await sb.from("gw_device_policies")
      .upsert(row, { onConflict: "tenant_id" }).select("*").single();
    if (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, 500, { error: "db_query_failed", detail: error.message });
    }

    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "device.policy_updated" });
    return json(res, 200, { policy: { ...DEFAULTS, ...data } });
  }

  return methodNotAllowed(res, ["GET", "PATCH"]);
}
