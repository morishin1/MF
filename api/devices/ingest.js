// POST /api/devices/ingest
//   エージェントが5分ごとに、溜めたぶんをまとめて送る。
//
// ■ 何度送られても同じ結果になる
//   オフラインで溜めて、復帰してから送る作りなので、同じものが2回届く。
//   イベントは (device_id, seq) の一意制約に任せて捨てる。
//   日別の集計は上書き（端末が持っている合計が正）。
//
// ■ 判定はサーバでやる
//   何をアラートにするかは会社が決める。端末側で決めさせない。
//   端末は改ざんできるし、ポリシーを変えたときに全台へ配り直すことになる。
//
// ■ 送られてきた中身は、そのまま入れない
//   lib/devices.js の normalize* を通す。detail に入れてよい鍵も、そこで絞る。
//   端末が何を送ってきても、ファイル名やURLが紛れ込む道を作らない。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { requireDevice } from "../../lib/device-auth.js";
import {
  normalizeUsage, normalizeApps, normalizeWeb, normalizeEvents,
  alertsFrom, isWeekend,
} from "../../lib/devices.js";

// 053 → 054 → 055 の順で流す。列が足りないときも同じ案内を出す
const SQL = "db/053_devices.sql → 054_device_agent.sql → 055_device_admin.sql";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const dev = await requireDevice(req, res);
  if (!dev) return;

  // 本人が告知を読むまでは受け取らない。
  // 200 で返すのは、エージェントに「壊れている」と思わせて
  // 再送させ続けないため
  if (!dev.notified_at || dev.status === "suspended") {
    return json(res, 200, {
      accepted: 0, collect: false,
      reason: dev.status === "suspended" ? "suspended" : "not_notified",
    });
  }

  const body = await readJson(req);
  const sb = admin();
  const now = new Date().toISOString();

  const events = normalizeEvents(body.events);
  const usages = (Array.isArray(body.usage) ? body.usage : [body.usage])
    .map(normalizeUsage).filter(Boolean).slice(0, 40);
  const apps = normalizeApps(body.apps);
  const web = normalizeWeb(body.web);

  const base = { tenant_id: dev.tenant_id, device_id: dev.id };
  const fail = (where, error) => {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    console.error(`[devices/ingest] ${where}`, error);
    return json(res, 500, { error: "server_error" });
  };

  // ---- イベント。同じ seq が2度来ても1行 ----
  if (events.length) {
    const { error } = await sb.from("gw_device_events").upsert(
      events.map((e) => ({
        ...base, work_date: e.workDate, at: e.at, kind: e.kind,
        detail: e.detail, seq: e.seq,
      })),
      { onConflict: "device_id,seq", ignoreDuplicates: true },
    );
    if (error) return fail("events", error);
  }

  // ---- 日別の集計。その日の値で上書き ----
  for (const u of usages) {
    // 休日ぶんはサーバで確かめる。端末の時計や設定に任せない
    const weekend = isWeekend(u.workDate);
    const holiday = weekend ? Math.max(u.holidayMin, u.activeMin) : 0;
    const { error } = await sb.from("gw_device_usage").upsert({
      ...base,
      employee_id: dev.employee_id,
      work_date: u.workDate,
      active_min: u.activeMin, idle_min: u.idleMin, locked_min: u.lockedMin,
      night_min: u.nightMin, holiday_min: holiday,
      first_at: u.firstAt, last_at: u.lastAt,
      updated_at: now,
    }, { onConflict: "device_id,work_date" });
    if (error) return fail("usage", error);
    u.holidayMin = holiday;
  }

  if (apps.length) {
    const { error } = await sb.from("gw_device_app_usage").upsert(
      apps.map((a) => ({ ...base, work_date: a.workDate, exe_name: a.exeName,
                         product: a.product, minutes: a.minutes })),
      { onConflict: "device_id,work_date,exe_name" },
    );
    if (error) return fail("apps", error);
  }

  if (web.length) {
    const { error } = await sb.from("gw_device_web_usage").upsert(
      web.map((w) => ({ ...base, work_date: w.workDate,
                        category: w.category, minutes: w.minutes })),
      { onConflict: "device_id,work_date,category" },
    );
    if (error) return fail("web", error);
  }

  // ---- 受け取った印 ----
  const seen = { last_seen_at: now, updated_at: now };
  if (body.agentVersion) seen.agent_version = String(body.agentVersion).slice(0, 40);
  // ホスト名は変わることがある（PCの名前を変えた）。device_uid は変わらない
  if (body.hostname) seen.hostname = String(body.hostname).slice(0, 100);
  await sb.from("gw_devices").update(seen).eq("id", dev.id);

  // ---- アラートの判定（サーバ側） ----
  const alerts = await raise(sb, dev, { events, usages });

  return json(res, 200, {
    collect: true,
    accepted: { events: events.length, usage: usages.length, apps: apps.length, web: web.length },
    alerts: alerts.length,
  });
}

/**
 * アラートを立てる。
 * 同じ端末の同じ理由で同じ日に何度も作らない（dedupe_key の一意制約に任せる）。
 * ここで落ちても取り込みは成功にする。記録が入らないことのほうが困る。
 */
async function raise(sb, dev, { events, usages }) {
  try {
    const { data: policy } = await sb
      .from("gw_device_policies")
      .select("blocked_software, usb_alert, night_alert, night_min_minutes, holiday_min_minutes")
      .eq("tenant_id", dev.tenant_id)
      .maybeSingle();

    const seeds = [
      ...alertsFrom({ events, policy: policy || {} }),
      ...usages.flatMap((u) => alertsFrom({ usage: u, policy: policy || {} })),
    ];
    if (!seeds.length) return [];

    // イベントから出たものは、元のイベントに紐づける。
    // 画面から「そのとき何があったか」へ辿れるように
    const seqs = seeds.map((a) => a.seq).filter((s) => s != null);
    const bySeq = new Map();
    if (seqs.length) {
      const { data } = await sb.from("gw_device_events")
        .select("id, seq").eq("device_id", dev.id).in("seq", seqs);
      for (const r of data || []) bySeq.set(Number(r.seq), r.id);
    }

    const rows = seeds.map((a) => ({
      tenant_id: dev.tenant_id,
      device_id: dev.id,
      event_id: a.seq != null ? bySeq.get(a.seq) || null : null,
      severity: a.severity, rule: a.rule, title: a.title,
      detail: a.detail || {},
      occurred_at: a.occurredAt,
      dedupe_key: a.dedupeKey,
    }));

    await sb.from("gw_device_alerts")
      .upsert(rows, { onConflict: "device_id,dedupe_key", ignoreDuplicates: true });
    return rows;
  } catch (e) {
    console.error("[devices/ingest] alerts", e?.message || e);
    return [];
  }
}
