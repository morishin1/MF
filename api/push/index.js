// GET    /api/push          … 設定状況・自分の端末・声かけの時刻
// POST   /api/push          … この端末を登録する { endpoint, p256dh, auth, label }
// POST   /api/push {test:1} … 自分に1件送ってみる
// PATCH  /api/push          … 声かけの設定を変える
// DELETE /api/push?endpoint=… … この端末をやめる
//
// ■ 宛先は本人にしか見せない
//   endpoint は、それ自体が「その端末に通知を送れる宛先」。
//   他人のものが読めると、他人の画面に通知を出せてしまう。
//   RLS でも自分の行しか読めないようにしてある（db/040）。
//
// ■ 時刻は勤務時間から決まる
//   本人が決めていなければ、gw_contracts.work_hours から自動で出す。
//   9時〜18時で固定すると、短時間勤務の人に合わない（lib/reminders.js）。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { pushConfigured, vapidPublicKey, sendToDevices } from "../../lib/webpush.js";
import { slotTimes, SLOTS, toMin, fromMin } from "../../lib/reminders.js";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, { error: "no_employee", hint: "社員名簿にあなたの行がありません" });
  }

  if (req.method === "GET") return read(res, user, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    if (body?.test) return test(res, ctx);
    return subscribe(res, user, ctx, body);
  }
  if (req.method === "PATCH") return savePrefs(res, req, ctx);
  if (req.method === "DELETE") return unsubscribe(req, res, ctx);
  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

// その人の勤務時間。契約が無ければ null（既定の時刻になる）
async function workHoursOf(sb, employeeId) {
  const { data } = await sb.from("gw_contracts")
    .select("work_hours").eq("employee_id", employeeId).eq("status", "active")
    .order("created_at", { ascending: false }).limit(1);
  return data?.[0]?.work_hours || null;
}

async function read(res, user, ctx) {
  const sb = admin();
  const [{ data: prefs }, { data: devices }, hours] = await Promise.all([
    sb.from("gw_reminder_prefs").select("*").eq("employee_id", ctx.employee.id).maybeSingle(),
    sb.from("gw_push_subs").select("id, label, created_at, last_ok_at")
      .eq("employee_id", ctx.employee.id).order("created_at"),
    workHoursOf(sb, ctx.employee.id),
  ]);

  const t = slotTimes(prefs, hours);
  return json(res, 200, {
    configured: pushConfigured(),
    publicKey: vapidPublicKey(),
    devices: devices || [],
    workHours: hours,
    prefs: {
      enabled: prefs?.enabled !== false,
      morningOn: prefs?.morning_on !== false,
      middayOn: prefs?.midday_on !== false,
      eveningOn: prefs?.evening_on !== false,
      // 本人が決めた時刻。null なら勤務時間から自動
      morningAt: prefs?.morning_at || null,
      middayAt: prefs?.midday_at || null,
      eveningAt: prefs?.evening_at || null,
      workdays: prefs?.workdays || [1, 2, 3, 4, 5],
    },
    // 実際に送られる時刻。source: work_hours / manual / default
    times: t,
    slots: SLOTS.map((s) => ({ key: s.key, title: s.title, body: s.body })),
  });
}

async function subscribe(res, user, ctx, body) {
  const { endpoint, p256dh, auth, label } = body || {};
  if (!endpoint || !p256dh || !auth) {
    return json(res, 400, { error: "invalid_body", required: ["endpoint", "p256dh", "auth"] });
  }
  if (!/^https:\/\//.test(endpoint)) return json(res, 400, { error: "invalid_endpoint" });

  const sb = admin();
  const { error } = await sb.from("gw_push_subs").upsert({
    tenant_id: ctx.tenantId,
    employee_id: ctx.employee.id,
    user_id: user.id,
    endpoint,
    p256dh,
    auth,
    label: String(label || "").slice(0, 60) || null,
    fail_count: 0,
  }, { onConflict: "endpoint" });
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  // 設定の行が無ければ作る。既定は平日の3回
  await sb.from("gw_reminder_prefs").upsert({
    employee_id: ctx.employee.id, tenant_id: ctx.tenantId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "employee_id", ignoreDuplicates: true });

  return json(res, 200, { ok: true });
}

async function unsubscribe(req, res, ctx) {
  const endpoint = new URL(req.url, "http://localhost").searchParams.get("endpoint");
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!endpoint && !id) return json(res, 400, { error: "invalid_query", required: ["endpoint | id"] });

  const sb = admin();
  // 自分の端末しか消せない
  let q = sb.from("gw_push_subs").delete().eq("employee_id", ctx.employee.id);
  q = endpoint ? q.eq("endpoint", endpoint) : q.eq("id", id);
  const { error } = await q;
  if (error) return json(res, 500, { error: "db_delete_failed", detail: error.message });
  return json(res, 200, { ok: true });
}

async function savePrefs(res, req, ctx) {
  const body = await readJson(req);

  // 時刻は 15分刻みにそろえる。cron が15分おきに見るため、
  // 09:07 と入れられると永久に一致しない
  const time = (v) => {
    if (v === null || v === "") return null;
    const m = toMin(v);
    return m === null ? undefined : fromMin(m);   // undefined = 直さない
  };

  const patch = {
    employee_id: ctx.employee.id,
    tenant_id: ctx.tenantId,
    updated_at: new Date().toISOString(),
  };
  if (body?.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body?.morningOn !== undefined) patch.morning_on = !!body.morningOn;
  if (body?.middayOn !== undefined) patch.midday_on = !!body.middayOn;
  if (body?.eveningOn !== undefined) patch.evening_on = !!body.eveningOn;

  for (const [k, col] of [["morningAt", "morning_at"], ["middayAt", "midday_at"], ["eveningAt", "evening_at"]]) {
    if (body?.[k] === undefined) continue;
    const v = time(body[k]);
    if (v === undefined) return json(res, 400, { error: "invalid_time", hint: "HH:MM の形で入れてください" });
    patch[col] = v;
  }

  if (Array.isArray(body?.workdays)) {
    const days = [...new Set(body.workdays.map(Number))].filter((d) => d >= 1 && d <= 7).sort();
    patch.workdays = days;
  }

  const sb = admin();
  const { error } = await sb.from("gw_reminder_prefs").upsert(patch, { onConflict: "employee_id" });
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  return read(res, { id: null }, ctx);
}

// 自分に1件送ってみる。届くかどうかは、送ってみないと分からない
async function test(res, ctx) {
  if (!pushConfigured()) {
    return json(res, 400, {
      error: "not_configured",
      hint: "Vercel に VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY を設定してください",
    });
  }
  const sb = admin();
  const { data: subs } = await sb.from("gw_push_subs").select("*").eq("employee_id", ctx.employee.id);
  if (!subs?.length) return json(res, 400, { error: "no_device", hint: "先に「通知を受け取る」を押してください" });

  const r = await sendToDevices(sb, subs, {
    title: "通知のテスト",
    body: "これが出れば準備完了です。9時・お昼・終業前に声をかけます。",
    url: "/nippo.html",
    tag: "kp-test",
  });
  return json(res, 200, { ok: r.sent > 0, ...r });
}
