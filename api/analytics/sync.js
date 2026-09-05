// POST /api/analytics/sync   … Vercel からプロジェクト一覧と数値を取り込む
//
// 2通りで呼ばれる:
//   ・cron（vercel.json の crons）… Authorization: Bearer ${CRON_SECRET}
//   ・管理画面の「いま取り込む」   … ログイン中の管理者・経営者
//
// プロジェクト一覧は正式なAPIなので確実に取れる。数値のほうは事情が違い、
// 取れないことのほうが多い（理由は lib/vercel.js の頭に書いた）。
// 取れなかったサイトは sync_error に理由を残し、画面で見分けられるようにする。
// 一覧の取り込みだけでも先に済ませておけば、あとは計測タグを貼るだけで数字が入る。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { listProjects, fetchAnalytics, isConfigured } from "../../lib/vercel.js";
import crypto from "node:crypto";

const DAYS = 30;   // さかのぼって取り直す日数

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const tenantId = await authorize(req, res);
  if (!tenantId) return;

  if (!isConfigured()) {
    return json(res, 200, {
      ok: true, skipped: "no_token",
      hint: "VERCEL_API_TOKEN が未設定です。サイトは手で追加し、計測タグを貼れば数字は入ります",
    });
  }

  const sb = admin();
  let projects;
  try {
    projects = await listProjects();
  } catch (e) {
    return json(res, 502, { error: "vercel_failed", detail: String(e?.message || e) });
  }

  // 1) 一覧を反映。名前は運用側で変えられるようにしたいので、
  //    すでにある行の name は上書きしない（project_name だけ更新する）
  const seen = [];
  for (const p of projects) {
    const { data: existing } = await sb
      .from("gw_web_projects")
      .select("id, name")
      .eq("tenant_id", tenantId).eq("provider", "vercel").eq("provider_id", p.id)
      .maybeSingle();

    if (existing) {
      await sb.from("gw_web_projects").update({
        project_name: p.name, domain: p.domain, updated_at: new Date().toISOString(),
      }).eq("id", existing.id);
      seen.push({ id: existing.id, providerId: p.id, name: existing.name });
    } else {
      const { data: created } = await sb.from("gw_web_projects").insert({
        tenant_id: tenantId,
        provider: "vercel", provider_id: p.id,
        name: p.name, project_name: p.name, domain: p.domain,
        beacon_key: crypto.randomBytes(16).toString("base64url"),
      }).select("id, name").single();
      if (created) seen.push({ id: created.id, providerId: p.id, name: created.name });
    }
  }

  // 2) 数値。取れたものだけ入れ、取れなければ理由を残す
  const to = new Date();
  const from = new Date(Date.now() - DAYS * 86400000);
  let withData = 0;
  const unavailable = [];

  for (const s of seen) {
    const r = await fetchAnalytics(s.providerId, { from, to });
    if (r.unavailable) {
      unavailable.push({ name: s.name, reason: r.unavailable });
      await sb.from("gw_web_projects").update({
        last_synced_at: new Date().toISOString(),
        sync_source: "vercel",
        sync_error: r.unavailable === "not_available"
          ? "VercelのAnalyticsをこの経路では取得できません（計測タグをご利用ください）"
          : r.unavailable,
      }).eq("id", s.id);
      continue;
    }

    if (r.days.length) {
      await sb.from("gw_web_daily").upsert(r.days.map((d) => ({
        project_id: s.id, date: d.date, source: "vercel",
        pageviews: d.pageviews, visitors: d.visitors,
        updated_at: new Date().toISOString(),
      })), { onConflict: "project_id,date,source" });
      withData++;
    }
    await sb.from("gw_web_projects").update({
      last_synced_at: new Date().toISOString(), sync_source: "vercel", sync_error: null,
    }).eq("id", s.id);
  }

  return json(res, 200, {
    ok: true,
    projects: seen.length,
    withData,
    unavailable: unavailable.length,
    // どのサイトがなぜ取れなかったかを返す。画面で理由を出せるように
    details: unavailable.slice(0, 30),
  });
}

/**
 * cron からの呼び出しか、管理者本人か。
 * @returns {Promise<string|null>} 取り込み先のテナントID
 */
async function authorize(req, res) {
  const secret = (process.env.CRON_SECRET || "").trim();
  const auth = req.headers["authorization"] || "";

  if (secret && auth === `Bearer ${secret}`) {
    // cron には利用者がいない。グループウェアを使っているテナントを対象にする
    const { data } = await admin()
      .from("gw_employees").select("tenant_id").limit(1).maybeSingle();
    if (!data) { json(res, 200, { ok: true, skipped: "no_tenant" }); return null; }
    return data.tenant_id;
  }

  const user = await requireUser(req, res);
  if (!user) return null;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) { json(res, 403, { error: "no_membership" }); return null; }
  if (!ctx.isAdmin && !ctx.roles.includes("owner")) { json(res, 403, { error: "forbidden" }); return null; }
  return ctx.tenantId;
}
