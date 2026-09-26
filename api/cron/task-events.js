// GET /api/cron/task-events
// 毎朝1回。「業務イベント → 共通タスク」をまとめて数え直す。
//
// ■ ここに増やしていく
//
//   新しいイベントを足すときは、新しいAPIや新しいチェックリストを作らない。
//   このファイルに1つ関数を足し、buildTask() で gw_tasks の行にして、
//   最後の runEventTasks() に渡すだけにする（lib/task-events.js）。
//   タスクの置き場所・見る場所（一覧・ホーム・ドロワー）を増やさないのが目的。
//
// ■ いまの4つ
//
//   ① 端末未登録 … 入社から数日経っても、会社の端末が1台も無い人
//   ② 雇用契約の更新確認 … 有期の雇用契約（gw_contracts）が45日以内に終わる
//   ③ 現場契約の更新確認 … SES現場契約（gw_site_contracts）が45日以内に終わる
//      （db/076。まだ更新確認していない＝renewal_status が pending/ending のものだけ）
//   ④ 月初のBP勤務表回収 … 月初、BP区分の在籍者ぶん
//
//   「入社決定 → 入社準備（PC・Slack・勤怠）」は、ここではなく
//   手続きを作った瞬間（api/onboarding/index.js）で作る。
//   月初・45日前のように「日々数え直す」ものはここ、
//   「事が起きた瞬間に決まる」ものは事が起きた場所、という使い分け。
//
// 認証: CRON_SECRET があれば Authorization: Bearer <secret> を要求する。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { jstDate } from "../../lib/devices.js";
import { buildTask, runEventTasks } from "../../lib/task-events.js";

const DEVICE_GRACE_DAYS = 3;     // 入社から、これだけ経っても端末が無ければ知らせる
const CONTRACT_LEAD_DAYS = 45;   // 契約終了の、これだけ前から知らせる
const CONTRACT_DUE_LEAD_DAYS = 14; // タスクの期限は、契約終了のこれだけ前

// カレンダーの足し引きだけをする。実行機のタイムゾーンに引きずられないよう、
// 常に UTC のメソッドで計算する（日付文字列そのものはJSTのつもりで扱う）
const addDays = (ymd, n) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const sb = admin();
  const today = jstDate();
  const out = { today, deviceMissing: 0, contractExpiry: 0, siteContractExpiry: 0,
                monthStartBp: 0, billingProgressMade: 0, made: 0, skipped: 0, notes: [] };

  const rows = [];

  const dm = await deviceMissingEvents(sb, today);
  if (dm.error) out.notes.push(`端末未登録: ${dm.error.message}`);
  out.deviceMissing = dm.rows.length;
  rows.push(...dm.rows);

  const ce = await contractExpiryEvents(sb, today);
  if (ce.error) out.notes.push(`雇用契約の更新確認: ${ce.error.message}`);
  out.contractExpiry = ce.rows.length;
  rows.push(...ce.rows);

  const sce = await siteContractExpiryEvents(sb, today);
  if (sce.error) out.notes.push(`現場契約の更新確認: ${sce.error.message}`);
  out.siteContractExpiry = sce.rows.length;
  rows.push(...sce.rows);

  const mb = await monthStartBpEvents(sb, today);
  if (mb.error) out.notes.push(`月初BP勤務表: ${mb.error.message}`);
  out.monthStartBp = mb.rows.length;
  out.billingProgressMade = mb.billingRowsMade || 0;
  rows.push(...mb.rows);

  const r = await runEventTasks(sb, rows);
  out.made = r.made;
  out.skipped = r.skipped;
  return json(res, 200, out);
}

// ---- ① 端末未登録 --------------------------------------------------------------
export async function deviceMissingEvents(sb, today) {
  const cutoff = addDays(today, -DEVICE_GRACE_DAYS);
  const { data: emps, error } = await sb.from("gw_employees")
    .select("id, tenant_id, display_name, joined_on")
    .in("status", ["active", "invited"])
    .not("joined_on", "is", null).lte("joined_on", cutoff)
    .limit(2000);
  if (error) return { rows: [], error };
  if (!emps?.length) return { rows: [] };

  const { data: devices, error: de } = await sb.from("gw_devices")
    .select("employee_id").in("employee_id", emps.map((e) => e.id)).limit(5000);
  // 053 未適用の環境では、端末そのものを数えられない。無理に「全員未登録」にはしない
  if (de) return { rows: [], error: de };
  const have = new Set((devices || []).map((d) => d.employee_id).filter(Boolean));

  const rows = emps.filter((e) => !have.has(e.id)).map((e) => buildTask({
    tenantId: e.tenant_id, eventKey: "device_missing", entityId: e.id,
    title: `${e.display_name}さんの端末登録を進めてください`,
    body: "入社から時間が経っていますが、会社の端末（PC／ブラウザ）がまだ登録されていません。"
        + "本人に /pc の案内を送るか、進み具合を確認してください。",
    category: "端末管理",
    link: "admin-devices.html",
  }));
  return { rows };
}

// ---- ② 契約更新の確認（45日前）--------------------------------------------------
export async function contractExpiryEvents(sb, today) {
  const until = addDays(today, CONTRACT_LEAD_DAYS);
  const { data, error } = await sb.from("gw_contracts")
    .select("id, tenant_id, employee_id, period_to, employee:gw_employees(display_name)")
    .eq("status", "active").eq("fixed_term", true)
    .not("period_to", "is", null)
    .gte("period_to", today).lte("period_to", until)
    .limit(1000);
  if (error) return { rows: [], error };

  const rows = (data || []).map((c) => buildTask({
    tenantId: c.tenant_id, eventKey: "contract_expiry", entityId: `${c.id}:${c.period_to}`,
    title: `${c.employee?.display_name || "対象者"}さんの契約更新を確認してください`,
    body: `契約終了日：${c.period_to}（${CONTRACT_LEAD_DAYS}日以内）。`
        + "更新する／しないを決めて、必要な手続きを進めてください。",
    dueOn: addDays(c.period_to, -CONTRACT_DUE_LEAD_DAYS),
    category: "契約更新",
    link: "admin-members.html",
  }));
  return { rows };
}

// ---- ③ 現場契約（SES）の更新確認（45日前）----------------------------------------
export async function siteContractExpiryEvents(sb, today) {
  const until = addDays(today, CONTRACT_LEAD_DAYS);
  const { data, error } = await sb.from("gw_site_contracts")
    .select("id, tenant_id, employee_id, site_company, period_to, renewal_status, "
          + "employee:gw_employees(display_name)")
    .in("renewal_status", ["pending", "ending"])
    .not("period_to", "is", null)
    .gte("period_to", today).lte("period_to", until)
    .limit(1000);
  // 076 未適用の環境では表が無い。cron は落とさない
  if (error) return { rows: [], error };

  const rows = (data || []).map((c) => buildTask({
    tenantId: c.tenant_id, eventKey: "site_contract_expiry", entityId: `${c.id}:${c.period_to}`,
    title: `${c.employee?.display_name || "対象者"}さんの現場契約（${c.site_company}）の更新を確認してください`,
    body: `契約終了日：${c.period_to}（${CONTRACT_LEAD_DAYS}日以内）。`
        + "客先・パートナー企業と更新の可否を確認し、現場契約の状態を更新してください。",
    dueOn: addDays(c.period_to, -CONTRACT_DUE_LEAD_DAYS),
    category: "契約更新",
    link: "admin-members.html",
  }));
  return { rows };
}

// ---- ④ 月初、BP区分ぶんの勤務表回収 ----------------------------------------------
export async function monthStartBpEvents(sb, today) {
  // 月の頭の数日だけ対象にする。月の途中に流しても、
  // 月末に入った・辞めたBPさんまで毎日対象になってしまう
  if (Number(today.slice(8, 10)) > 5) return { rows: [] };
  const ym = today.slice(0, 7);

  const { data: emps, error } = await sb.from("gw_employees")
    .select("id, tenant_id, display_name, partner_company_id")
    .eq("employee_kind", "bp").eq("status", "active")
    .not("partner_company_id", "is", null)
    .limit(2000);
  // 075 未適用の環境では employee_kind 列が無い。cron は落とさない
  if (error) return { rows: [], error };
  if (!emps?.length) return { rows: [] };

  const rows = emps.map((e) => buildTask({
    tenantId: e.tenant_id, eventKey: "month_start_bp_timesheet", entityId: `${e.id}:${ym}`,
    title: `${e.display_name}さんの${ym}分の勤務表を回収してください`,
    body: "月次請求の進行に使います。受け取ったら、稼働確認・Board作成へ進めてください。",
    dueOn: `${ym}-05`,
    category: "月次請求",
    link: "admin-members.html",
  }));

  // 優先5（月次請求進捗）の行も、ここで一緒に用意する。
  // 「今月の請求が動いている現場契約」ごとに1行。
  // 対象月×メンバー×契約で一意（db/077）なので、毎月・何度cronが走っても増えない
  const monthStart = `${ym}-01`;
  const { data: contracts, error: sce } = await sb.from("gw_site_contracts")
    .select("id, tenant_id, employee_id, period_from, period_to")
    .in("employee_id", emps.map((e) => e.id))
    .lte("period_from", `${ym}-31`)
    .limit(2000);
  let billingRowsMade = 0;
  if (!sce) {
    // 終了日が無い（継続中）か、今月に入ってから終わる契約だけを対象にする
    const active = (contracts || []).filter((c) => !c.period_to || c.period_to >= monthStart);
    if (active.length) {
      const brows = active.map((c) => ({
        tenant_id: c.tenant_id, employee_id: c.employee_id,
        site_contract_id: c.id, billing_month: ym,
      }));
      const { count } = await sb.from("gw_billing_progress")
        .upsert(brows, { onConflict: "employee_id,billing_month,site_contract_id",
                         ignoreDuplicates: true, count: "exact" });
      billingRowsMade = count || 0;
    }
  }

  return { rows, billingRowsMade };
}
