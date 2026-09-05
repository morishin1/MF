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
import { fetchAll as fetchGa4, isConfigured as ga4Configured } from "../../lib/ga4.js";
import crypto from "node:crypto";

const DAYS = 30;   // さかのぼって取り直す日数

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const tenantId = await authorize(req, res);
  if (!tenantId) return;

  const sb = admin();

  // GA4 は Vercel と関係なく回す。トークンが無くても GA4 の数字は取り込める
  const ga4 = await syncGa4(sb, tenantId);

  if (!isConfigured()) {
    return json(res, 200, {
      ok: true, skipped: "no_token", ga4,
      hint: "VERCEL_API_TOKEN が未設定です。サイト一覧の自動取得は使えませんが、GA4と計測タグの数字は入ります",
    });
  }

  let projects;
  try {
    projects = await listProjects();
  } catch (e) {
    return json(res, 502, { error: "vercel_failed", detail: String(e?.message || e), ga4 });
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
    ga4,
  });
}

/**
 * GA4 のプロパティIDが入っているサイトを回して取り込む。
 * 1件失敗しても他は続ける。原因はサイトごとに違う（権限、ID違い）ので、
 * まとめて止めると直すべき相手が分からなくなる。
 */
async function syncGa4(sb, tenantId) {
  if (!ga4Configured()) return { skipped: "no_service_account", synced: 0 };

  const { data: targets } = await sb
    .from("gw_web_projects")
    .select("id, name, ga4_property_id")
    .eq("tenant_id", tenantId)
    .not("ga4_property_id", "is", null)
    .limit(100);
  if (!targets?.length) return { skipped: "no_property", synced: 0 };

  const to = dayString(0);
  const from = dayString(-(DAYS - 1));
  let synced = 0;
  const failed = [];

  for (const t of targets) {
    const r = await fetchGa4(t.ga4_property_id, { from, to });
    if (r.unavailable) {
      failed.push({ name: t.name, reason: r.unavailable });
      await sb.from("gw_web_projects").update({
        last_synced_at: new Date().toISOString(), sync_source: "ga4", sync_error: r.unavailable,
      }).eq("id", t.id);
      continue;
    }

    const now = new Date().toISOString();
    if (r.days.length) {
      await sb.from("gw_web_daily").upsert(r.days.map((d) => ({
        project_id: t.id, date: d.date, source: "ga4",
        pageviews: d.pageviews, visitors: d.visitors, updated_at: now,
      })), { onConflict: "project_id,date,source" });
    }
    // ページと流入元は期間まとめの数字しか返らないので、期間の最終日に寄せて入れる。
    // 日別に割り戻すと、実際には無い日の数字を作ってしまう
    if (r.pages.length) {
      await sb.from("gw_web_pages").upsert(r.pages.map((p) => ({
        project_id: t.id, date: to, source: "ga4", path: p.path, pageviews: p.pageviews,
      })), { onConflict: "project_id,date,source,path" });
    }
    if (r.referrers.length) {
      await sb.from("gw_web_referrers").upsert(r.referrers.map((x) => ({
        project_id: t.id, date: to, source: "ga4", referrer: x.referrer, pageviews: x.pageviews,
      })), { onConflict: "project_id,date,source,referrer" });
    }

    await sb.from("gw_web_projects").update({
      last_synced_at: now, sync_source: "ga4", sync_error: null,
    }).eq("id", t.id);
    synced++;
  }

  return { synced, failed: failed.length, details: failed.slice(0, 20) };
}

// 日本時間での「n日前」
function dayString(offset) {
  return new Date(Date.now() + 9 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
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
