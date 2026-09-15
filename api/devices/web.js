// GET /api/devices/web?employeeId=…&range=today|yesterday|week|month|date&date=YYYY-MM-DD
//   &category=sns&scope=work|all
//
// 「勤務時間中にどのWEBサイトを使っていたか」を見る画面のもと。
//
// ■ 開くのは、その人を開いたときだけ
//   一覧には出さない（一覧は ○ △ × だけ）。
//   毎日目に入る場所に細かい履歴を置くと、見る用が無いのに読むことになる。
//
// ■ 開いたことは本人に残る
//   管理者がここを開くと gw_device_views に記録され、本人の画面に出る。
//   見られる側から見えない記録にしない。この機能で守っているのはそこ。
//
// ■ 既定は勤務時間内だけ
//   目的が「勤務中の様子を見る」なので、既定を勤務時間内にする。
//   時間外も見られるが、そのときは画面にもそう出す。
//
// ■ ここに無いもの
//   問い合わせ（?q=…）・断片（#…）・ページの中身・フォーム・Cookie・トークン。
//   表に列が無いので、この口からも出ない。

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { requireMfa } from "../../lib/mfa.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import {
  CATEGORIES, CATEGORY_LABEL, DISTRACT_CATEGORIES, jstDate, clock, dayVerdict, webAlerts,
} from "../../lib/devices.js";

const SQL = "db/053_devices.sql → 054 → 055 → 057_device_one_pc.sql";
const RANGES = ["today", "yesterday", "week", "month", "date"];
const MAX_ROWS = 1000;

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  // 個人情報を返す。対象の人は二段階認証（強制日以降）
  if (!(await requireMfa(req, res, ctx, user))) return;
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  const q = new URL(req.url, "http://localhost").searchParams;
  const employeeId = q.get("employeeId") || ctx.employee?.id || null;
  if (!employeeId) return json(res, 400, { error: "invalid_query", required: ["employeeId"] });

  // 自分の記録か、人事・管理者か。それ以外は他人の履歴を見られない
  const mine = ctx.employee && employeeId === ctx.employee.id;
  if (!mine && !canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const { from, to, label } = rangeOf(q.get("range"), q.get("date"));
  const scope = q.get("scope") === "all" ? "all" : "work";
  const category = CATEGORIES.includes(q.get("category")) ? q.get("category") : null;

  const sb = admin();
  const { data: policy } = await sb.from("gw_device_policies")
    .select("*").eq("tenant_id", ctx.tenantId).maybeSingle();

  // ---- 履歴 ----
  let vq = sb.from("gw_device_web_visits")
    .select("id, work_date, started_at, ended_at, active_sec, host, path, category, browser, in_work_hours, device_id")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId)
    .gte("work_date", from).lte("work_date", to)
    .order("started_at", { ascending: false })
    .limit(MAX_ROWS);
  if (scope === "work") vq = vq.eq("in_work_hours", true);
  if (category) vq = vq.eq("category", category);

  const { data: visits, error } = await vq;
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  // ---- まとめ ----
  //
  // 絞り込みで消えたぶんを合計に入れると「4時間32分」が動いてしまう。
  // まとめは、カテゴリの絞り込みを外した数で出す
  let sq = sb.from("gw_device_web_visits")
    .select("category, active_sec, in_work_hours, host")
    .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId)
    .gte("work_date", from).lte("work_date", to)
    .limit(20000);
  if (scope === "work") sq = sq.eq("in_work_hours", true);
  const { data: all } = await sq;

  const byCat = new Map();
  const byHost = new Map();
  let totalSec = 0;
  let distractSec = 0;
  for (const v of all || []) {
    const s = Number(v.active_sec) || 0;
    totalSec += s;
    byCat.set(v.category, (byCat.get(v.category) || 0) + s);
    byHost.set(v.host, (byHost.get(v.host) || 0) + s);
    if (DISTRACT_CATEGORIES.includes(v.category) && v.in_work_hours) distractSec += s;
  }

  // ---- 1日の様子（その人の、その日） ----
  const day = await dayShape(sb, ctx, employeeId, from, to, { policy, distractSec });

  // ---- 見たことを残す ----
  if (!mine) {
    // 見た本人に出すための記録。これが残らない仕組みは監視になる
    await sb.from("gw_device_views").insert({
      tenant_id: ctx.tenantId, viewer_id: user.id,
      viewer_name: ctx.employee?.display_name || null,
      employee_id: employeeId, scope: "web",
      work_date: from === to ? from : null,
    });
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "device.view_web",
      target: `employee:${employeeId}`, detail: { range: label, from, to, scope },
    });
  }

  return json(res, 200, {
    range: { key: q.get("range") || "today", label, from, to },
    scope,
    category,
    total: { seconds: totalSec, label: clock(Math.round(totalSec / 60)) },
    byCategory: CATEGORIES
      .map((c) => ({
        key: c, label: CATEGORY_LABEL[c], seconds: byCat.get(c) || 0,
        text: clock(Math.round((byCat.get(c) || 0) / 60)),
      }))
      .filter((c) => c.seconds > 0),
    topHosts: [...byHost.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([host, sec]) => ({ host, seconds: sec, text: clock(Math.round(sec / 60)) })),
    visits: (visits || []).map((v) => ({
      id: v.id,
      at: v.started_at, endedAt: v.ended_at,
      workDate: v.work_date,
      seconds: v.active_sec, text: clock(Math.round(v.active_sec / 60)),
      host: v.host, path: v.path,
      category: v.category, categoryLabel: CATEGORY_LABEL[v.category] || v.category,
      browser: v.browser,
      inWorkHours: v.in_work_hours,
    })),
    truncated: (visits || []).length >= MAX_ROWS,
    day,
    alerts: webAlerts({
      date: to, distractSec, nightSec: day?.nightSec || 0,
      policy: policy || {},
    }),
    categories: CATEGORIES.map((c) => ({ key: c, label: CATEGORY_LABEL[c] })),
  });
}

/**
 * 1日の活動をならべる。
 *   勤務 9:00〜18:00 ／ PC稼働 8:57〜18:12 ／ WEB 5:14 ／ アプリ 2:03 ／ 離席 43分
 * 期間が1日のときだけ出す。1か月ぶんを1行にしても読めない
 */
async function dayShape(sb, ctx, employeeId, from, to, { policy, distractSec }) {
  if (from !== to) return null;

  const [{ data: entry }, { data: devs }] = await Promise.all([
    sb.from("gw_time_entries")
      .select("clock_in, clock_out, breaks, status")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId)
      .eq("work_date", from).maybeSingle(),
    sb.from("gw_devices").select("id, source, last_seen_at")
      .eq("tenant_id", ctx.tenantId).eq("employee_id", employeeId),
  ]);

  const workedMin = entry?.clock_in
    ? Math.max(0, Math.round(
        ((entry.clock_out ? Date.parse(entry.clock_out) : Date.now()) - Date.parse(entry.clock_in)) / 60000))
    : 0;
  const work = entry?.clock_in
    ? { from: entry.clock_in, to: entry.clock_out, minutes: workedMin, text: clock(workedMin) }
    : null;

  const ids = (devs || []).map((d) => d.id);

  // 端末が1台も無い人。
  //
  // ■ ここで形を変えない
  //
  //   前はここだけ { entry, usage: null } という別の形を返していた。
  //   受け取る画面は usage がある前提で書いてあるので、
  //   端末を持たない人を開いた瞬間に画面ごと落ちていた。
  //   「データが無い」と「形が違う」は別のこと。中身を空にして、形はそろえる
  if (!ids.length) {
    return {
      date: from, work,
      usage: { firstAt: null, lastAt: null,
               activeMin: 0, activeText: clock(0),
               idleMin: 0, idleText: clock(0), lockedMin: 0, nightMin: 0 },
      appMin: 0, appText: clock(0), nightSec: 0,
      verdict: dayVerdict({ noDevice: true }),
    };
  }

  const [{ data: usage }, { data: apps }] = await Promise.all([
    sb.from("gw_device_usage")
      .select("active_min, idle_min, locked_min, night_min, first_at, last_at")
      .in("device_id", ids).eq("work_date", from),
    sb.from("gw_device_app_usage").select("minutes").in("device_id", ids).eq("work_date", from),
  ]);

  // 同じ人が2台使っていることがある。足して1日として見る
  const u = (usage || []).reduce((a, r) => ({
    active_min: a.active_min + (r.active_min || 0),
    idle_min: a.idle_min + (r.idle_min || 0),
    locked_min: a.locked_min + (r.locked_min || 0),
    night_min: a.night_min + (r.night_min || 0),
    first_at: !a.first_at || (r.first_at && r.first_at < a.first_at) ? r.first_at : a.first_at,
    last_at: !a.last_at || (r.last_at && r.last_at > a.last_at) ? r.last_at : a.last_at,
  }), { active_min: 0, idle_min: 0, locked_min: 0, night_min: 0, first_at: null, last_at: null });

  const appMin = (apps || []).reduce((a, r) => a + (r.minutes || 0), 0);

  // その日ぶんの記録が1件も無ければ「届いていない」
  const silent = !(usage || []).length;

  return {
    date: from,
    work,
    usage: {
      firstAt: u.first_at, lastAt: u.last_at,
      activeMin: u.active_min, activeText: clock(u.active_min),
      idleMin: u.idle_min, idleText: clock(u.idle_min),
      lockedMin: u.locked_min, nightMin: u.night_min,
    },
    appMin, appText: clock(appMin),
    nightSec: u.night_min * 60,
    verdict: dayVerdict({ usage: u, distractSec, silent, workedMin, policy: policy || {} }),
  };
}

/** 期間。today / yesterday / week / month / date */
function rangeOf(key, date) {
  const today = jstDate();
  const day = (n) => jstDate(Date.now() + n * 86400000);

  if (key === "yesterday") return { from: day(-1), to: day(-1), label: "昨日" };
  if (key === "week") return { from: day(-6), to: today, label: "今週（7日）" };
  if (key === "month") return { from: day(-29), to: today, label: "今月（30日）" };
  if (key === "date" && /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    return { from: date, to: date, label: date };
  }
  if (!RANGES.includes(key) && /^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    return { from: date, to: date, label: date };
  }
  return { from: today, to: today, label: "今日" };
}
