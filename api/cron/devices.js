// GET /api/cron/devices
//   1日1回まわす。端末管理の後始末。
//     ① 止まったエージェントと、しばらく使われていない端末を知らせる
//     ② 保存期間を過ぎた記録を消す
//     ③ 使用終了から90日を過ぎた端末を、記録ごと消す
//
// ■ 消すほうも仕組みでやる
//   「いつまでも取ってある」状態にしないと決めたなら、
//   人が思い出して消すのではなく、期限が来たら消えるようにしておく。
//   保存期間はテナントごとに gw_device_policies で変えられる。
//
// ■ 使われていない端末を出すのは、台帳を掃除するため
//   退職した人のPC、買い替えて使わなくなったPCが台帳に残り続けると、
//   「見慣れない端末」を見つける役に立たなくなる。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { jstDate } from "../../lib/devices.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const sb = admin();
  const out = { stale: 0, silent: 0, events: 0, daily: 0, purged: 0, skipped: null };

  // 表がまだ無い環境（053 未適用）でも、cron 全体を落とさない
  const { error: probe } = await sb.from("gw_devices").select("id").limit(1);
  if (probe) {
    out.skipped = "gw_devices がまだありません（db/053_devices.sql が未適用）";
    return json(res, 200, out);
  }

  const { data: policies } = await sb.from("gw_device_policies")
    .select("tenant_id, keep_events_days, keep_daily_months, stale_days");
  const byTenant = new Map((policies || []).map((p) => [p.tenant_id, p]));

  // ---- ① しばらく使われていない端末 ----
  const { data: devices } = await sb.from("gw_devices")
    .select("id, tenant_id, label, hostname, source, last_seen_at, notified_at, status")
    .in("status", ["active", "unconfirmed"])
    .limit(2000);

  const today = jstDate();
  const seeds = [];
  for (const d of devices || []) {
    const seen = d.last_seen_at ? Date.parse(d.last_seen_at) : 0;

    // エージェントは5分ごとに送ってくるはずのもの。1日届かなければ止まっている。
    // 会社のソフトが消されたのか、PCが起動していないだけなのかは分からない。
    // 分からないから、気づけるようにしておく
    if (d.source === "agent") {
      if (d.notified_at && (!seen || Date.now() - seen > 24 * 3600000)) {
        seeds.push({
          tenant_id: d.tenant_id, device_id: d.id,
          severity: "warn", rule: "agent_silent",
          title: `${d.hostname || d.label} から24時間以上、記録が届いていません`,
          detail: { lastSeenAt: d.last_seen_at },
          occurred_at: new Date().toISOString(),
          // 1日1件まで。止まっているあいだ毎日1件出る
          dedupe_key: `silent:${today}`,
        });
      }
      continue;
    }

    // ブラウザは使ったときだけ。しばらく空くのはふつうなので、日数で見る
    const days = Number(byTenant.get(d.tenant_id)?.stale_days) || 60;
    if (seen && seen < Date.now() - days * 86400000) {
      seeds.push({
        tenant_id: d.tenant_id, device_id: d.id,
        severity: "info", rule: "no_access",
        title: `${d.label} は ${days}日以上使われていません`,
        detail: { lastSeenAt: d.last_seen_at, days },
        occurred_at: new Date().toISOString(),
        // 1台につき1回だけ。使われないまま毎日出しても意味がない
        dedupe_key: `stale:${d.id}`,
      });
    }
  }
  if (seeds.length) {
    const { error } = await sb.from("gw_device_alerts")
      .upsert(seeds, { onConflict: "device_id,dedupe_key", ignoreDuplicates: true });
    if (!error) {
      out.stale = seeds.filter((s) => s.rule === "no_access").length;
      out.silent = seeds.filter((s) => s.rule === "agent_silent").length;
    }
  }

  // ---- ② 保存期間 ----
  // テナントごとに違うので、まとめて1回では消せない。数は多くない
  const tenants = [...new Set([
    ...(devices || []).map((d) => d.tenant_id),
    ...byTenant.keys(),
  ])];
  for (const t of tenants) {
    const p = byTenant.get(t) || {};
    const keepEvents = Number(p.keep_events_days) || 400;
    const keepMonths = Number(p.keep_daily_months) || 13;

    const { count: ec } = await sb.from("gw_device_events")
      .delete({ count: "exact" }).eq("tenant_id", t).lt("work_date", day(-keepEvents));
    out.events += ec || 0;

    const dayCut = day(-Math.round(keepMonths * 30.4));
    for (const table of ["gw_device_usage", "gw_device_app_usage", "gw_device_web_usage"]) {
      const { count, error } = await sb.from(table)
        .delete({ count: "exact" }).eq("tenant_id", t).lt("work_date", dayCut);
      // アプリ別・サイト別は 054 を流していない環境には無い。落とさない
      if (!error) out.daily += count || 0;
    }
  }

  // ---- ③ 使用終了から90日 ----
  // 台帳ごと消す。外部キーが cascade なので、記録も一緒に消える。
  // 返却済み・使わなくなったPCの記録を、いつまでも持っている理由がない
  const retireCut = new Date(Date.now() - 90 * 86400000).toISOString();
  const { data: gone, count } = await sb.from("gw_devices")
    .delete({ count: "exact" })
    .eq("status", "retired")
    .not("retired_at", "is", null)
    .lt("retired_at", retireCut)
    .select("id");
  out.purged = count ?? (gone || []).length;
  out.today = today;

  return json(res, 200, out);
}

/** 今日から n 日ずらした日付（日本時間） */
function day(n) {
  return new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);
}
