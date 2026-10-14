// GET /api/sales/approaches/counts?period=this_week
// GET /api/sales/approaches/counts?period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD
//
// 担当者別フォームアタック数（営業分析）。指定期間に「誰が何件フォームアタックを実行したか」を数える。
//
// ■ 数え方（集計の定義）
//   基準は gw_sales_approaches（1行＝1回のアタック）。数えるのは
//     sent_at IS NOT NULL（送信完了を押したもの）AND channel = 'form'（お問い合わせフォーム）
//   で、sent_at が期間内（日本時間の暦日。lib/sales-period.js）のもの。
//   担当者は gw_sales_approaches.employee_id（実際にアタックした人）。企業の現在の担当（owner_id）ではない
//   （活動量を測るため。担当企業に別の人が送ったら、送った人に付く）。
//   準備だけ（未送信）・送信できなかった（failed_at）は sent_at が無いので数えない。
//
// ■ 0件の人
//   Sales を使える在籍メンバー（経営者、または Sales の利用権限がある人。退職者は除く）は、0件でも出す。
//   利用権限が読めなかったときは、0件の人を出さずに zeroMembers: "unavailable" を返す（黙って全員0件にしない）。
//   期間内にアタックした人は、いまの権限・在籍にかかわらず出す（実際にやったことは消さない）。
//
// ■ 集計用の表は作らない。既存の gw_sales_approaches から、その場で数える
import { json, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { admin, userClient } from "../../../lib/supabase.js";
import { loadAppsMany } from "../../../lib/app-grants.js";
import { isLeftEmployee } from "../../../lib/left-gate.js";
import { resolvePeriod } from "../../../lib/sales-period.js";
import { todayJst } from "../../../lib/sales.js";

const SQL = "db/088_sales.sql・db/096_sales_channels.sql";
// 1回の応答で返る行数には上限がある（PostgREST の max-rows）。それより小さい単位で読み進める
const PAGE = 1000;
// 1回の集計で読む上限（任意期間の長さの上限と合わせて、読みすぎを防ぐ）
const MAX_ROWS = 200000;

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const q = new URL(req.url, "http://localhost").searchParams;
  const period = resolvePeriod(q.get("period"), { from: q.get("from"), to: q.get("to") });
  if (period.error) return json(res, 400, period);

  const sb = userClient(req);
  const counts = new Map();
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const { data, error } = await sb.from("gw_sales_approaches").select("id, employee_id")
      .eq("tenant_id", ctx.tenantId).eq("channel", "form")
      .gte("sent_at", period.sinceIso).lt("sent_at", period.untilIso)
      .order("id", { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 200, { notReady: true, message: hint, period: periodOut(period), rows: [], total: 0 });
      return json(res, 500, { error: "db_query_failed", detail: error.message });
    }
    for (const a of data || []) counts.set(a.employee_id || null, (counts.get(a.employee_id || null) || 0) + 1);
    if (!data || data.length < PAGE) break;
  }

  // 社員の名前・在籍・Sales を使えるか（他の人の権限は本人の権限では読めないので、サーバーの権限でテナント内だけ読む）
  const db = admin();
  const { data: people, error: pe } = await db.from("gw_employees").select("id, display_name, status, left_on")
    .eq("tenant_id", ctx.tenantId).limit(2000);
  if (pe) return json(res, 500, { error: "db_query_failed", detail: pe.message });
  const today = todayJst();
  const current = (people || []).filter((p) => ["active", "invited", "leaving"].includes(p.status) && !isLeftEmployee(p, today));
  let zeroMembers = "listed";
  const sellers = new Set();
  const { data: grants, error: ge } = await db.from("gw_role_grants").select("employee_id, role").eq("tenant_id", ctx.tenantId);
  if (ge) zeroMembers = "unavailable";
  else {
    const rolesById = new Map();
    for (const g of grants || []) rolesById.set(g.employee_id, [...(rolesById.get(g.employee_id) || []), g.role]);
    const { state, byId } = await loadAppsMany(db, current.map((p) => p.id), rolesById);
    if (state === "error") zeroMembers = "unavailable";
    else {
      for (const p of current) {
        if ((rolesById.get(p.id) || []).includes("owner") || (byId.get(p.id) || []).includes("sales")) sellers.add(p.id);
      }
    }
  }

  const byId = new Map((people || []).map((p) => [p.id, p]));
  const ids = new Set([...counts.keys()].filter(Boolean));
  if (zeroMembers === "listed") for (const id of sellers) ids.add(id);
  const rows = [...ids].map((id) => {
    const p = byId.get(id);
    return {
      employeeId: id, name: p?.display_name || "（不明）", count: counts.get(id) || 0,
      // 退職した人・Sales を使えなくなった人の実績も残す（印だけ付ける）
      former: Boolean(p) && !current.some((x) => x.id === id),
    };
  });
  // 送った人が分からない（社員が消えた等）アタック
  if (counts.get(null)) rows.push({ employeeId: null, name: "（不明）", count: counts.get(null), former: false });
  rows.sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name), "ja"));

  return json(res, 200, {
    period: periodOut(period),
    rows,
    total: rows.reduce((n, r) => n + r.count, 0),
    zeroMembers,
  });
}

const periodOut = (p) => ({ key: p.key, label: p.label, from: p.from, to: p.to, days: p.days });
