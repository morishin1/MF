// 本人用：経営者が確認・公開済みの週次PREPフィードバックだけを読む。
// URL/リクエストから社員IDを受け取らず、認証済み ctx.employee.id を使用する。
import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  res.setHeader("Cache-Control", "private, no-store");
  if (!ctx.employee?.id) return json(res, 200, { latest: null, history: [] });
  const { data, error } = await admin().from("gw_weekly_prep_feedback")
    .select("id,period_start,period_end,conclusion,reason,evidence,recommendation,good_points,improvement_points,next_actions,published_at")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", ctx.employee.id)
    .eq("status", "published").not("published_at", "is", null)
    .order("period_end", { ascending: false }).order("published_at", { ascending: false }).limit(8);
  if (error) return json(res, 503, { error: "feedback_unavailable", hint: "週次の振り返りを取得できませんでした" });
  const map = (r) => ({
    periodStart: r.period_start, periodEnd: r.period_end,
    conclusion: r.conclusion || "", reason: r.reason || "",
    evidence: r.evidence || "", recommendation: r.recommendation || "",
    goodPoints: r.good_points || "", improvementPoints: r.improvement_points || "",
    nextActions: r.next_actions || "", publishedAt: r.published_at,
  });
  const history = (data || []).map(map);
  return json(res, 200, { latest: history[0] || null, history });
}
