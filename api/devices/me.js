// GET  /api/devices/me                            … 自分の端末・自分の記録・自分を見た履歴
// POST /api/devices/me {action:"acknowledge", deviceId}  … 告知を読んだ記録
//
// ■ 本人が読むまで、記録は取らない
//   acknowledge が来て初めて notified_at が入り、
//   そこから先だけエージェントが送りはじめる。
//   読ませてから始めるのではなく、読むまで始まらない。
//
// ■ 自分を見た履歴を、本人が読める
//   これが無いと、この機能は片側だけが透明な仕組みになる。
//   誰がいつ自分の記録を開いたかが、本人の画面に出る。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  isDate, jstDate, clock, sinceLabel, deviceState,
  CATEGORY_LABEL, EVENT_LABEL,
} from "../../lib/devices.js";

const SQL = "db/053_devices.sql";

// 本人の画面に出す文。ここが本文で、就業規則の写しではない。
// 就業規則に書いてあることを、読める言葉にして見せる
export const NOTICE = {
  title: "会社のパソコンで記録していること",
  takes: [
    "起動・終了・ロック・スリープの時刻",
    "1日の稼働時間、離席していた時間",
    "使ったソフトの名前と、その合計時間",
    "見たサイトの種類（業務・調べもの・SNS など）と合計時間",
    "USBメモリをつないだこと、ソフトを入れたこと",
  ],
  never: [
    "キーボードで打った内容",
    "パスワード",
    "メールやチャットの本文",
    "画面の録画・スクリーンショット",
    "開いていた画面のタイトル",
    "見たページのURL（種類だけにして送ります）",
    "ファイルの中身",
  ],
  why: "会社のパソコンから、お客様の情報が外に出ていないかを確かめるためのものです。"
     + "働きぶりを点数にしたり、評価に使ったりはしません。"
     + "深夜や休日の稼働を見ているのは、働きすぎに気づくためです。",
  yours: "自分の記録は、いつでもこの画面で見られます。"
       + "管理者があなたの記録を開いたときは、それもこの画面に残ります。",
};

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId || !ctx.employee) return json(res, 403, { error: "no_membership" });

  if (req.method === "GET") return read(req, res, ctx);
  if (req.method === "POST") return ack(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST"]);
}

async function read(req, res, ctx) {
  const sb = admin();
  const q = new URL(req.url, "http://localhost").searchParams;

  const { data: devices, error } = await sb.from("gw_devices")
    .select("id, hostname, os_version, agent_version, status, notified_at, last_seen_at, enrolled_at")
    .eq("tenant_id", ctx.tenantId)
    .eq("employee_id", ctx.employee.id)
    .neq("status", "retired")
    .order("hostname", { ascending: true });

  if (error) {
    const hint = dbSetupHint(error, SQL);
    // 本人の画面では、SQLを流せとは言わない。管理者に出す話
    if (hint) return json(res, 200, { devices: [], notice: NOTICE, notReady: true });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const ids = (devices || []).map((d) => d.id);
  const to = isDate(q.get("to")) ? q.get("to") : jstDate();
  const from = isDate(q.get("from")) ? q.get("from") : back(to, 13);

  let usage = [], apps = [], web = [], events = [];
  if (ids.length) {
    const [u, a, w, e] = await Promise.all([
      sb.from("gw_device_usage")
        .select("work_date, active_min, idle_min, night_min, holiday_min, first_at, last_at")
        .in("device_id", ids).gte("work_date", from).lte("work_date", to)
        .order("work_date", { ascending: false }).limit(60),
      sb.from("gw_device_app_usage").select("exe_name, product, minutes")
        .in("device_id", ids).gte("work_date", from).lte("work_date", to)
        .order("minutes", { ascending: false }).limit(60),
      sb.from("gw_device_web_usage").select("category, minutes")
        .in("device_id", ids).gte("work_date", from).lte("work_date", to).limit(200),
      sb.from("gw_device_events").select("at, kind")
        .in("device_id", ids).gte("work_date", from).lte("work_date", to)
        .order("at", { ascending: false }).limit(40),
    ]);
    usage = u.data || []; apps = a.data || []; web = w.data || []; events = e.data || [];
  }

  const appTotal = new Map();
  for (const a of apps) {
    const cur = appTotal.get(a.exe_name) || { exeName: a.exe_name, product: a.product, minutes: 0 };
    cur.minutes += a.minutes;
    appTotal.set(a.exe_name, cur);
  }
  const webTotal = new Map();
  for (const w of web) webTotal.set(w.category, (webTotal.get(w.category) || 0) + w.minutes);

  // 誰が自分の記録を見たか
  const { data: views } = await sb.from("gw_device_views")
    .select("at, viewer_name, scope, work_date")
    .eq("employee_id", ctx.employee.id)
    .order("at", { ascending: false })
    .limit(30);

  return json(res, 200, {
    notice: NOTICE,
    range: { from, to },
    devices: (devices || []).map((d) => ({
      id: d.id, hostname: d.hostname, os: d.os_version,
      agentVersion: d.agent_version, status: d.status,
      acknowledged: Boolean(d.notified_at), notifiedAt: d.notified_at,
      lastSeen: sinceLabel(d.last_seen_at),
      enrolledAt: d.enrolled_at,
      state: deviceState(d, {}),
    })),
    usage: usage.map((u) => ({
      date: u.work_date,
      activeMin: u.active_min, nightMin: u.night_min, holidayMin: u.holiday_min,
      active: clock(u.active_min), idle: clock(u.idle_min),
      firstAt: u.first_at, lastAt: u.last_at,
    })),
    apps: [...appTotal.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 10)
      .map((a) => ({ ...a, label: clock(a.minutes) })),
    web: [...webTotal.entries()].sort((a, b) => b[1] - a[1])
      .map(([category, minutes]) => ({
        category, label: CATEGORY_LABEL[category] || category, minutes, time: clock(minutes),
      })),
    events: events.map((e) => ({ at: e.at, kind: e.kind, label: EVENT_LABEL[e.kind] || e.kind })),
    views: (views || []).map((v) => ({
      at: v.at, who: v.viewer_name || "管理者",
      what: v.scope === "csv" ? "書き出し" : v.scope === "device" ? "端末の記録" : "一覧",
    })),
  });
}

async function ack(req, res, ctx, user) {
  const body = await readJson(req);
  if (String(body.action || "") !== "acknowledge") return json(res, 400, { error: "bad_action" });

  const sb = admin();
  const { data: dev } = await sb.from("gw_devices")
    .select("id, tenant_id, employee_id, hostname, notified_at")
    .eq("id", body.deviceId).maybeSingle();

  // 自分の端末しか承認できない。他人のぶんを既読にはできない
  if (!dev || dev.tenant_id !== ctx.tenantId || dev.employee_id !== ctx.employee.id) {
    return json(res, 404, { error: "not_found" });
  }
  if (dev.notified_at) return json(res, 200, { ok: true, notifiedAt: dev.notified_at });

  const now = new Date().toISOString();
  const { error } = await sb.from("gw_devices")
    .update({ notified_at: now, updated_at: now }).eq("id", dev.id);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });

  await gwLog({ tenantId: ctx.tenantId, actorId: user.id,
                action: "device.acknowledged", target: dev.id,
                detail: { hostname: dev.hostname } });
  return json(res, 200, { ok: true, notifiedAt: now });
}

function back(dateStr, n) {
  return new Date(Date.parse(`${dateStr}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}
