// GET /api/devices/people            … 社員ごとの一覧（今日）
// GET /api/devices/people?date=…     … 日付を指定して見る
//
// ■ 見る単位を、端末から人に変えた
//
//   これまでの一覧は端末が1行だった。同じ人のPCとブラウザが別々に並び、
//   管理者は「この行とこの行が同じ人」を頭の中でつないでいた。
//
//   知りたいのは端末の調子ではなく、その人がちゃんと働けているか。
//   だから1行＝1人にする。
//
//     氏名 / 勤務状況 / ブラウザ連携 / 最終通信 / WEB利用 / 要確認
//
// ■ 正常な人は、細かく見ない
//
//   ○ が並んでいる人の中身を毎日開く運用は続かない。
//   問題があるときだけ △ を出して、そこだけ開く。
//
// ■ 判定のしかたは返さない
//
//   「何分から」「何%から」は社内の管理基準（lib/watch.js の LIMITS）。
//   返すのは「何が」と「次にどうするか」だけ。
//   避け方を配ることになるので、数字は外に出さない。

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { isDate, jstDate, sinceLabel, browserLabel } from "../../lib/devices.js";
import { workState, extState, issuesOf, mark, clock, OFF_TOPIC, LIMITS } from "../../lib/watch.js";
import { dayTotals } from "../../lib/timecard.js";

const SQL = "db/053_devices.sql → 054_device_agent.sql → 057_device_one_pc.sql";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const q = new URL(req.url, "http://localhost").searchParams;
  const date = isDate(q.get("date")) ? q.get("date") : jstDate();
  const sb = admin();
  const now = Date.now();

  // ---- 名簿 ----
  const { data: people, error } = await sb.from("gw_employees")
    .select("id, display_name, department, position, status")
    .eq("tenant_id", ctx.tenantId)
    .in("status", ["active", "invited"])
    .order("display_name")
    .limit(500);
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  // ---- 端末 ----
  const { data: devices } = await sb.from("gw_devices")
    .select("id, employee_id, source, label, hostname, browser, status, "
          + "notified_at, ownership, last_seen_at, secret_hash, linked_device_id")
    .eq("tenant_id", ctx.tenantId).limit(1000);

  // 拡張がつながっているか。gw_device_browsers の linked が正
  const linked = new Map();
  {
    const { data: brs } = await sb.from("gw_device_browsers")
      .select("device_id, browser, installed, linked, ext_version, last_seen_at")
      .eq("tenant_id", ctx.tenantId).limit(2000);
    for (const b of brs || []) {
      if (!linked.has(b.device_id)) linked.set(b.device_id, []);
      linked.get(b.device_id).push(b);
    }
  }

  const byEmp = new Map();
  for (const d of devices || []) {
    if (!d.employee_id) continue;
    if (!byEmp.has(d.employee_id)) byEmp.set(d.employee_id, []);
    const brs = linked.get(d.id) || [];
    byEmp.get(d.employee_id).push({
      id: d.id, source: d.source,
      label: d.hostname || d.label,
      browser: d.browser,
      confirmed: Boolean(d.notified_at),
      ownership: d.ownership || "unknown",
      lastSeenAt: d.last_seen_at,
      // 拡張がつながっているか。
      // 資格情報を持っているか（secret_hash）と、拡張から届いているか。
      // 片方だけでは「入れたが動いていない」を見逃す
      extLinked: Boolean(d.secret_hash) && brs.some((b) => b.linked),
      browsers: brs.map((b) => ({ browser: b.browser, label: browserLabel(b.browser),
                                  linked: b.linked, extVersion: b.ext_version })),
    });
  }

  // ---- 打刻 ----
  const clocks = new Map();
  {
    const { data: te } = await sb.from("gw_time_entries")
      // breaks を落とさないこと。労働時間はここから引く。
      // 取り忘れると、休憩を引かない時間で打刻と突き合わせることになり、
      // 全員が「打刻より短い」に見える
      .select("employee_id, work_date, status, clock_in, clock_out, breaks")
      .eq("tenant_id", ctx.tenantId).eq("work_date", date).limit(500);
    for (const t of te || []) clocks.set(t.employee_id, t);
  }

  // ---- WEB利用（その日） ----
  const web = new Map();
  {
    const { data: vs } = await sb.from("gw_device_web_visits")
      .select("employee_id, category, active_sec, in_work_hours, started_at")
      .eq("tenant_id", ctx.tenantId).eq("work_date", date).limit(20000);
    for (const v of vs || []) {
      if (!v.employee_id) continue;
      const cur = web.get(v.employee_id)
        || { sec: 0, offSec: 0, lastAt: 0, byCat: {} };
      cur.sec += v.active_sec || 0;
      cur.byCat[v.category] = (cur.byCat[v.category] || 0) + (v.active_sec || 0);
      // 業務外は、勤務時間の中のぶんだけ数える。
      // 昼休みや終業後まで数えると、ただの私生活の記録になる
      if (v.in_work_hours && OFF_TOPIC.includes(v.category)) cur.offSec += v.active_sec || 0;
      const at = v.started_at ? Date.parse(v.started_at) : 0;
      if (at > cur.lastAt) cur.lastAt = at;
      web.set(v.employee_id, cur);
    }
  }

  const rows = (people || []).map((e) => {
    const mine = byEmp.get(e.id) || [];
    const t = clocks.get(e.id) || null;
    const w = web.get(e.id) || { sec: 0, offSec: 0, lastAt: 0, byCat: {} };

    // 最後に何か届いた時刻。合図と WEB利用の、新しいほう
    const lastSeenAt = [...mine.map((d) => d.lastSeenAt), w.lastAt ? new Date(w.lastAt).toISOString() : null]
      .filter(Boolean).sort().pop() || null;

    const work = workState({
      lastSeenAt, clockIn: t?.clock_in, clockOut: t?.clock_out, now,
    });

    // 打刻からの労働時間。数え方はタイムカードと同じものを使う。
    // ここで別に数えると、勤怠の画面と違う数字が出る
    const clockMin = t?.clock_in ? dayTotals(t, new Date(now)).workMinutes : null;

    // 実際に動いていた時間の目安。いまは WEB利用の合計で見る
    const activeMin = Math.round(w.sec / 60);

    // 勤務中に、何も届いていない時間
    const quietMin = work.key === "away" ? work.mins : 0;

    const issues = issuesOf({
      name: e.display_name, devices: mine, work,
      webMin: activeMin,
      offTopicMin: Math.round(w.offSec / 60),
      activeMin, clockMin, quietMin,
    });

    const ext = extState(mine);
    return {
      employeeId: e.id,
      name: e.display_name,
      department: e.department || null,
      work: { key: work.key, label: work.label },
      ext: { key: ext.key, mark: ext.mark, label: ext.label },
      lastSeen: sinceLabel(lastSeenAt, now, "なし"),
      lastSeenAt,
      web: {
        min: activeMin, label: clock(activeMin),
        offMin: Math.round(w.offSec / 60),
        // 種類ごとの内訳。多い順に3つだけ。全部出すと一覧が読めなくなる
        top: Object.entries(w.byCat)
          .sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([k, sec]) => ({ category: k, min: Math.round(sec / 60) })),
      },
      clockMin,
      devices: mine.map((d) => ({
        id: d.id, source: d.source, label: d.label,
        confirmed: d.confirmed, ownership: d.ownership,
        extLinked: d.extLinked, browsers: d.browsers,
        lastSeen: sinceLabel(d.lastSeenAt, now, "なし"),
      })),
      // 「何が」と「次にどうするか」だけ。数字は返さない
      issues,
      mark: mark(issues, work),
    };
  });

  const check = rows.filter((r) => r.issues.length);
  return json(res, 200, {
    date,
    // 通常はここだけ見る。問題があるときだけ下に出る
    people: rows.filter((r) => !r.issues.length),
    check,
    summary: {
      total: rows.length,
      working: rows.filter((r) => r.work.key === "working").length,
      check: check.length,
      extOff: rows.filter((r) => r.ext.key === "off").length,
    },
    // 社員には出さない。管理画面の中だけ（避け方を配らない）
    limits: LIMITS,
  });
}
