// Disabled until separate owner approval + production binding. Not a P-readable data API.
import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { authorized, snapshotConfig, slotFor, deliverSnapshot } from "../../lib/gw-owner-snapshot.js";

export async function handleSnapshot(req, res, forcedSlot = null) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!authorized(req.headers.authorization, process.env.CRON_SECRET)) return json(res, 401, { error: "unauthorized" });
  const now = new Date(), cfg = snapshotConfig(process.env, now);
  if (!cfg.ok) return json(res, 503, { error: cfg.reason });
  const params = new URL(req.url, "https://gw.8grp.co.jp").searchParams;
  if ([...params.keys()].some(k => k !== "slot") || params.getAll("slot").length > 1) return json(res, 400, { error: "fixed_scope_only" });
  if (forcedSlot && params.has("slot")) return json(res, 400, { error: "fixed_scope_only" });
  const slot = slotFor(now, forcedSlot || params.get("slot"), cfg);
  if (!slot) return json(res, 409, { error: "outside_approved_window" });
  try {
    const result = await deliverSnapshot({ sb: admin(), cfg, now, slot });
    return json(res, result.status === "unknown" ? 502 : 200, result);
  } catch (e) {
    // No database error, email body, names, addresses, or credentials in response/logs.
    const reasons = new Set(["roster_unavailable", "owner_inactive", "owner_forbidden", "owner_authorization_unavailable",
      "recipient_binding_mismatch", "empty_roster", "snapshot_size_exceeded", "dispatch_claim_failed"]);
    const reason = reasons.has(e?.message) ? e.message : "snapshot_unavailable";
    return json(res, 503, { error: reason, sendAttempted: false });
  }
}

export default function handler(req, res) { return handleSnapshot(req, res); }
