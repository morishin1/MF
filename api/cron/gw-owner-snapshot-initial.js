// A temporary native Vercel cron can invoke this once without exporting CRON_SECRET.
// Existing handler still enforces exact approved date, fixed recipient, and once-per-consent claim.
import { handleSnapshot } from "./gw-owner-snapshot.js";
export default function handler(req, res) { return handleSnapshot(req, res, "initial"); }
