// GET /api/cron/devices
//   1日1回まわす。端末管理の後始末。
//     ① 24時間以上受信の無い端末をアラートにする
//     ② 保存期間を過ぎた記録を消す
//     ③ 使用終了から90日を過ぎた端末を、記録ごと消す
//
// ■ 消すほうも仕組みでやる
//   「いつまでも取ってある」状態にしないと決めたなら、
//   人が思い出して消すのではなく、期限が来たら消えるようにしておく。
//   保存期間はテナントごとに gw_device_policies で変えられる。
//
// ■ 受信が止まったことに気づけるようにする
//   エージェントを止められたのか、PCを使っていないだけなのかは分からない。
//   分からないから、気づけるようにしておく。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const sb = admin();
  const out = { silent: 0, events: 0, daily: 0, purged: 0, skipped: null };

  // 表がまだ無い環境（053 未適用）でも、cron 全体を落とさない
  const { error: probe } = await sb.from("gw_devices").select("id").limit(1);
  if (probe) {
    out.skipped = "gw_devices がまだありません（db/053_devices.sql が未適用）";
    return json(res, 200, out);
  }

  const { data: policies } = await sb.from("gw_device_policies")
    .select("tenant_id, keep_events_days, keep_daily_months");
  const byTenant = new Map((policies || []).map((p) => [p.tenant_id, p]));

  // ---- ① 受信が止まっている端末 ----
  const cut = new Date(Date.now() - 24 * 3600000).toISOString();
  const { data: devices } = await sb.from("gw_devices")
    .select("id, tenant_id, hostname, last_seen_at, notified_at, status, retired_at")
    .eq("status", "active")
    .not("notified_at", "is", null)
    .limit(1000);

  const quiet = (devices || []).filter((d) => !d.last_seen_at || d.last_seen_at < cut);
  if (quiet.length) {
    const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    const { error } = await sb.from("gw_device_alerts").upsert(
      quiet.map((d) => ({
        tenant_id: d.tenant_id, device_id: d.id,
        severity: "warn", rule: "no_heartbeat",
        title: `${d.hostname} から24時間以上、記録が届いていません`,
        detail: { lastSeenAt: d.last_seen_at },
        occurred_at: new Date().toISOString(),
        // 1日1件まで。止まっているあいだ毎日1件出る
        dedupe_key: `silent:${today}`,
      })),
      { onConflict: "device_id,dedupe_key", ignoreDuplicates: true },
    );
    if (!error) out.silent = quiet.length;
  }

  // ---- ② 保存期間 ----
  // テナントごとに違うので、まとめて1回では消せない。台数は多くない
  const tenants = [...new Set((devices || []).map((d) => d.tenant_id))];
  const allTenants = tenants.length ? tenants : [...byTenant.keys()];
  for (const t of allTenants) {
    const p = byTenant.get(t) || {};
    const keepEvents = Number(p.keep_events_days) || 90;
    const keepMonths = Number(p.keep_daily_months) || 13;

    const evCut = day(-keepEvents);
    const { count: ec } = await sb.from("gw_device_events")
      .delete({ count: "exact" }).eq("tenant_id", t).lt("work_date", evCut);
    out.events += ec || 0;

    const dayCut = day(-Math.round(keepMonths * 30.4));
    for (const table of ["gw_device_usage", "gw_device_app_usage", "gw_device_web_usage"]) {
      const { count } = await sb.from(table)
        .delete({ count: "exact" }).eq("tenant_id", t).lt("work_date", dayCut);
      out.daily += count || 0;
    }
  }

  // ---- ③ 使用終了から90日 ----
  // 台帳ごと消す。外部キーが cascade なので、記録も一緒に消える。
  // アラートと閲覧履歴だけは残らないが、それでよい。
  // 返却済みのPCの利用記録を、いつまでも持っている理由がない
  const retireCut = new Date(Date.now() - 90 * 86400000).toISOString();
  const { data: gone, count } = await sb.from("gw_devices")
    .delete({ count: "exact" })
    .eq("status", "retired")
    .not("retired_at", "is", null)
    .lt("retired_at", retireCut)
    .select("id");
  out.purged = count ?? (gone || []).length;

  return json(res, 200, out);
}

/** 今日から n 日ずらした日付（日本時間） */
function day(n) {
  return new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);
}
