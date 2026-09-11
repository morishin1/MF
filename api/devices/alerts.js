// GET   /api/devices/alerts?status=open   … 対応が要るもの
// PATCH /api/devices/alerts {id, action: ack|resolve|ignore, note}
//
// ■ イベントは消せない記録、アラートは人が対応するもの
//   だから分けてある。イベントは触れない。アラートは状態が変わる。
//
// ■ 「無視」も記録に残す
//   消すのではなく ignored にして、誰がいつ無視したかを残す。
//   あとで問題になったとき、見ていなかったのか、見て判断したのかが分かれる。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { SEVERITY_LABEL, RULE_LABEL } from "../../lib/devices.js";

// 053 → 054 → 055 の順で流す。列が足りないときも同じ案内を出す
const SQL = "db/053_devices.sql → 054_device_agent.sql → 055_device_admin.sql";
const STATUS = ["open", "ack", "resolved", "ignored"];
const ACTION = { ack: "ack", resolve: "resolved", ignore: "ignored", reopen: "open" };

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const sb = admin();

  if (req.method === "GET") {
    const q = new URL(req.url, "http://localhost").searchParams;
    const status = STATUS.includes(q.get("status")) ? q.get("status") : null;

    let query = sb.from("gw_device_alerts")
      .select("id, device_id, severity, rule, title, detail, status, occurred_at, "
            + "decided_at, decided_note, device:gw_devices(label, employee_id)")
      .eq("tenant_id", ctx.tenantId)
      .order("occurred_at", { ascending: false })
      .limit(200);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, 500, { error: "db_query_failed", detail: error.message });
    }

    const ids = [...new Set((data || []).map((a) => a.device?.employee_id).filter(Boolean))];
    const names = new Map();
    if (ids.length) {
      const { data: emp } = await sb.from("gw_employees")
        .select("id, display_name, department").in("id", ids);
      for (const e of emp || []) names.set(e.id, { name: e.display_name, department: e.department });
    }

    return json(res, 200, {
      alerts: (data || []).map((a) => ({
        id: a.id, deviceId: a.device_id,
        severity: a.severity, severityLabel: SEVERITY_LABEL[a.severity] || a.severity,
        rule: a.rule, ruleLabel: RULE_LABEL[a.rule] || a.rule,
        title: a.title, detail: a.detail, status: a.status,
        occurredAt: a.occurred_at, decidedAt: a.decided_at, decidedNote: a.decided_note,
        label: a.device?.label || "",
        employee: names.get(a.device?.employee_id) || null,
      })),
    });
  }

  if (req.method === "PATCH") {
    const body = await readJson(req);
    const next = ACTION[String(body.action || "")];
    if (!body.id || !next) return json(res, 400, { error: "bad_request" });

    const { data: cur } = await sb.from("gw_device_alerts")
      .select("id, tenant_id, rule, title").eq("id", body.id).maybeSingle();
    if (!cur || cur.tenant_id !== ctx.tenantId) return json(res, 404, { error: "not_found" });

    const { error } = await sb.from("gw_device_alerts").update({
      status: next,
      decided_by: user.id,
      decided_at: new Date().toISOString(),
      decided_note: body.note ? String(body.note).slice(0, 1000) : null,
    }).eq("id", body.id);
    if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

    await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
                  action: `device.alert_${body.action}`, target: body.id,
                  detail: { rule: cur.rule } });
    return json(res, 200, { ok: true, status: next });
  }

  return methodNotAllowed(res, ["GET", "PATCH"]);
}
