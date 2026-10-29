import { readJson, methodNotAllowed, json } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { verifyLeadSignature } from "../../lib/hr-leads.js";
import { verificationConfig, verifyOneLead } from "../../lib/hr-lead-verification.js";

// Separate route: cannot fall through to the normal, email-merging lead intake.
export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const cfg = verificationConfig();
  if (!cfg) return json(res, 503, { ok: false, error: "verification_disabled" });
  try {
    const body = await readJson(req);
    const auth = verifyLeadSignature(req.headers, body, { secret: process.env.MUGENDOJO_LEAD_SECRET });
    if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
    const out = await verifyOneLead(admin(), cfg, body);
    const { status, ...result } = out;
    return json(res, out.ok ? 200 : status || 503, result);
  } catch {
    return json(res, 503, { ok: false, error: "verification_unconfirmed" });
  }
}
