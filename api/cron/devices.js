// GET /api/cron/devices
//   1日1回まわす。端末管理の後始末。
//     ① 止まったエージェントと、しばらく使われていない端末を知らせる
//     ② 保存期間を過ぎた記録を消す（WEB履歴は90日）
//     ③ 使用終了から90日を過ぎた端末を、記録ごと消す
//     ④ 昨日の「△ 要確認」を、確認する先のあるアラートにする
//     ⑤ 「本人の確認待ち」のまま置かれている端末を知らせる
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
import {
  jstDate, webAlerts, confirmWaitingAlert, DISTRACT_CATEGORIES,
} from "../../lib/devices.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const sb = admin();
  const out = {
    stale: 0, silent: 0, events: 0, daily: 0, visits: 0,
    purged: 0, checks: 0, waiting: 0, skipped: null,
  };

  // 表がまだ無い環境（053 未適用）でも、cron 全体を落とさない
  const { error: probe } = await sb.from("gw_devices").select("id").limit(1);
  if (probe) {
    out.skipped = "gw_devices がまだありません（db/053_devices.sql が未適用）";
    return json(res, 200, out);
  }

  const { data: policies } = await sb.from("gw_device_policies")
    .select("tenant_id, keep_events_days, keep_daily_months, stale_days, "
          + "keep_visits_days, confirm_wait_days, distract_min_minutes");
  const byTenant = new Map((policies || []).map((p) => [p.tenant_id, p]));

  // ---- ① しばらく使われていない端末 ----
  const { data: devices } = await sb.from("gw_devices")
    .select("id, tenant_id, label, hostname, source, last_seen_at, notified_at, status, "
          + "first_seen_at, created_at")
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

    // WEB履歴（1件ずつ）は、合計より短く持つ。既定90日。
    //
    // 「90日で消えます」と社員に言うなら、消す仕組みが要る。
    // 人が思い出して消すのではなく、期限が来たら消える形にしておく
    const keepVisits = Number(p.keep_visits_days) || 90;
    const { count: vc, error: ve } = await sb.from("gw_device_web_visits")
      .delete({ count: "exact" }).eq("tenant_id", t).lt("work_date", day(-keepVisits));
    // 057 を流していない環境には無い。落とさない
    if (!ve) out.visits += vc || 0;
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

  // ---- ④ 昨日の「△ 要確認」 ----
  out.checks = await raiseDayChecks(sb, tenants, byTenant, yesterday(today));

  // ---- ⑤ 本人の確認待ちのまま ----
  out.waiting = await raiseWaiting(sb, devices || [], byTenant);

  out.today = today;
  out.checked = yesterday(today);

  return json(res, 200, out);
}

/**
 * 昨日の「△ 要確認」を、アラートにする。
 *
 * ■ なぜ毎晩立てるのか
 *   これまで △ は、管理画面を開いたときに計算して出すだけだった。
 *   誰も開かなければ無かったことになり、開いても「確認した」を押す先が無かった。
 *   行にしておけば、open → ack の流れに乗る。
 *   「未確認が何件あるか」も数えられる。
 *
 * ■ 判定は lib/devices.js の webAlerts に任せる
 *   画面の △ と条件を1か所にまとめてある。
 *   ここに条件を書き足すと、見えているものと残るものがずれる。
 */
async function raiseDayChecks(sb, tenants, byTenant, date) {
  let made = 0;

  for (const t of tenants) {
    const policy = byTenant.get(t) || {};

    // その日、記録のある人だけを見る。
    // 休んだ人・PCを使わなかった人に「確認して」を出しても、確かめようがない
    const { data: visits, error } = await sb.from("gw_device_web_visits")
      .select("employee_id, device_id, category, active_sec, in_work_hours")
      .eq("tenant_id", t).eq("work_date", date).limit(50000);
    if (error) continue;   // 057 を流していない環境

    const { data: usages } = await sb.from("gw_device_usage")
      .select("device_id, active_min, night_min")
      .eq("tenant_id", t).eq("work_date", date).limit(5000);
    const { data: devs } = await sb.from("gw_devices")
      .select("id, employee_id, label, hostname, source")
      .eq("tenant_id", t).limit(5000);
    const { data: entries } = await sb.from("gw_time_entries")
      .select("employee_id, clock_in, clock_out")
      .eq("tenant_id", t).eq("work_date", date).limit(5000);

    const devById = new Map((devs || []).map((d) => [d.id, d]));
    // 退勤を押していない日は数えない。
    // 押し忘れを「長時間の勤務」として扱うと、毎回そこで引っかかる
    const worked = new Map((entries || [])
      .filter((e) => e.clock_in && e.clock_out)
      .map((e) => [e.employee_id, Math.max(0, Math.round(
        (Date.parse(e.clock_out) - Date.parse(e.clock_in)) / 60000))]));

    // その人の1日ぶんにまとめる。
    // 1台1行で見せているので、アラートも人ごとに1本にする
    const byEmp = new Map();
    const take = (empId) => {
      if (!byEmp.has(empId)) {
        byEmp.set(empId, { distractSec: 0, activeMin: 0, nightMin: 0, deviceId: null, label: "" });
      }
      return byEmp.get(empId);
    };

    for (const v of visits || []) {
      if (!v.employee_id) continue;
      const e = take(v.employee_id);
      if (DISTRACT_CATEGORIES.includes(v.category) && v.in_work_hours) {
        e.distractSec += Number(v.active_sec) || 0;
      }
      if (!e.deviceId) e.deviceId = v.device_id;
    }
    for (const u of usages || []) {
      const d = devById.get(u.device_id);
      if (!d?.employee_id) continue;
      const e = take(d.employee_id);
      e.activeMin += Number(u.active_min) || 0;
      e.nightMin += Number(u.night_min) || 0;
      // アラートは端末にぶら下がる。その人のエージェントを優先して選ぶ
      if (!e.deviceId || d.source === "agent") e.deviceId = d.id;
      if (!e.label) e.label = d.hostname || d.label || "";
    }

    const rows = [];
    for (const [empId, e] of byEmp) {
      if (!e.deviceId) continue;
      const seeds = webAlerts({
        date,
        distractSec: e.distractSec,
        nightSec: e.nightMin * 60,
        workedMin: worked.get(empId) || 0,
        // 記録が1件も無い日を「操作がない」と言わない。
        // エージェントが止まっていただけ、というのを混ぜたくない
        activeMin: usages?.length ? e.activeMin : null,
        label: e.label,
        policy,
      });
      for (const a of seeds) {
        rows.push({
          tenant_id: t, device_id: e.deviceId,
          severity: a.severity, rule: a.rule, title: a.title,
          detail: { ...a.detail, employeeId: empId },
          occurred_at: a.occurredAt, dedupe_key: a.dedupeKey,
        });
      }
    }
    if (!rows.length) continue;

    const { error: ie } = await sb.from("gw_device_alerts")
      .upsert(rows, { onConflict: "device_id,dedupe_key", ignoreDuplicates: true });
    if (!ie) made += rows.length;
  }
  return made;
}

/**
 * 「本人の確認待ち」のまま置かれている端末を知らせる。
 *
 * 押すまで、利用時間は1分も数えない。
 * つまり押されない端末は、台帳に載っているのに中身が空のまま溜まる。
 * 週1回ゼロにするなら、溜まっていることが見えないと回らない。
 */
async function raiseWaiting(sb, devices, byTenant) {
  const rows = [];
  for (const d of devices) {
    // 押したかどうかだけを見る。confirmWaitingAlert が、
    // 押してあるもの・まだ日が浅いものを弾く
    const a = confirmWaitingAlert(d, { policy: byTenant.get(d.tenant_id) || {} });
    if (!a) continue;
    rows.push({
      tenant_id: d.tenant_id, device_id: d.id,
      severity: a.severity, rule: a.rule, title: a.title,
      detail: a.detail, occurred_at: a.occurredAt, dedupe_key: a.dedupeKey,
    });
  }
  if (!rows.length) return 0;

  const { error } = await sb.from("gw_device_alerts")
    .upsert(rows, { onConflict: "device_id,dedupe_key", ignoreDuplicates: true });
  return error ? 0 : rows.length;
}

/** 前の日（日本時間の YYYY-MM-DD） */
function yesterday(today) {
  return new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

/** 今日から n 日ずらした日付（日本時間） */
function day(n) {
  return new Date(Date.now() + 9 * 3600000 + n * 86400000).toISOString().slice(0, 10);
}
