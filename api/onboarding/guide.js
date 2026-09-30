// GET /api/onboarding/guide?t=<案内URLのトークン>
//   ログイン前の本人が、自分あての入社案内（発行済みの最新版）を読む。
//   ログイン不要。gwContext() は使わない（api/hr/offers/public.js と同じ作り）。
//
// ■ 開くだけ
//   案内URLは、案内を読むためのもの。確認（「確認しました」）・契約・入力・書類は、ログインしてから
//   （/api/onboarding/start）。URL を知っている人が、本人になりすませないようにする。
//   パスワードの代わりにもならない。
//
// ■ 返すのは、案内の許した項目だけ
//   名簿の値（氏名・入社日・所属・役割）と、経営者が書いた項目。金額・メール・社員ID・社内メモは含めない
//   （lib/onboard-guide.js guideView）。無効・失効・案内が無い、は理由を問わず「開けません」で統一。
//   期限切れだけは、本人が担当者へ連絡できるよう区別する（410）。
//
// ■ 開いた記録
//   初回に開いた時刻・最後に開いた時刻・開いた回数を、URL ごとに残す（経営者の画面で見える）。

import { json, dbSetupHint } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { sha256, TOKEN_RE } from "../../lib/hr.js";
import { guideView, GUIDE_FIELDS } from "../../lib/onboard-guide.js";

const SQL = "db/104_onboarding_guide.sql";
const CANT_OPEN = { error: "invalid_token", hint: "このURLは開けません。担当者までお問い合わせください。" };
const EXPIRED = { error: "expired", hint: "このURLの有効期限を過ぎています。恐れ入りますが、担当者までお問い合わせください。" };

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
  res.setHeader?.("Cache-Control", "no-store");

  const token = String(new URL(req.url, "http://localhost").searchParams.get("t") || "");
  if (!TOKEN_RE.test(token)) return json(res, 404, CANT_OPEN);

  const sb = admin();
  const { data: inv, error } = await sb.from("gw_onboarding_invites")
    .select("id, tenant_id, employee_id, guide_id, expires_at, revoked_at, first_opened_at, open_count")
    .eq("token_hash", sha256(token)).maybeSingle();
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed" });
  }
  if (!inv || inv.revoked_at || !inv.guide_id) return json(res, 404, CANT_OPEN);
  if (Date.parse(inv.expires_at) < Date.now()) return json(res, 410, EXPIRED);

  // 入社が取り消された（退職済みになった）方のURLは、期限内でも開けない
  const { data: emp } = await sb.from("gw_employees").select("status").eq("id", inv.employee_id).eq("tenant_id", inv.tenant_id).maybeSingle();
  if (!emp || emp.status === "left") return json(res, 404, CANT_OPEN);

  const { data: guide } = await sb.from("gw_onboarding_guides").select("id, version")
    .eq("id", inv.guide_id).eq("tenant_id", inv.tenant_id).maybeSingle();
  if (!guide || !(guide.version > 0)) return json(res, 404, CANT_OPEN);
  const { data: issue } = await sb.from("gw_onboarding_guide_issues").select("snapshot, version")
    .eq("guide_id", guide.id).eq("version", guide.version).maybeSingle();
  if (!issue) return json(res, 404, CANT_OPEN);

  const now = new Date().toISOString();
  await sb.from("gw_onboarding_invites").update({
    first_opened_at: inv.first_opened_at || now, last_opened_at: now, open_count: (inv.open_count || 0) + 1,
  }).eq("id", inv.id).then(() => {}, () => {});

  const { data: tenant } = await sb.from("tenants").select("name").eq("id", inv.tenant_id).maybeSingle();
  return json(res, 200, {
    companyName: tenant?.name || null,
    guide: guideView(issue.snapshot),
    fields: GUIDE_FIELDS.map((f) => ({ key: f.key, label: f.label })),
    version: issue.version,
    expiresAt: inv.expires_at,
  });
}
