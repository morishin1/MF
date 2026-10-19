// GET /api/sales/member-performance?month=YYYY-MM
// Salesホームの月間実績。Officeのカレンダーと同じJST日付で集計。
// 管理者はチーム全体、それ以外は自分だけ。集計元の顧客情報・個人情報は返さない。
// 集計表を新設しない：既存のアタック / 提案 / 行動 / 引継ぎの確定履歴が正本。
import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { canManageProposals, settingsOf } from "../../lib/sales-proposals.js";
import { salesMembers } from "../../lib/sales-proposals-db.js";
import { monthBounds, summarizePerformance } from "../../lib/sales-member-performance.js";

const PAGE = 500;
// 行数が上限に達したときは0件扱いにせず、APIエラーにして過少集計を防ぐ
const MAX_ROWS = 20000;
const SQL = "db/088_sales.sql・db/096_sales_channels.sql・db/138_sales_proposals.sql・db/140_sales_proposal_matching.sql・db/141_sales_cs_closing_handoff.sql";
async function readAll(build) {
  const rows = [];
  for (let offset = 0; offset <= MAX_ROWS; offset += PAGE) {
    const { data, error } = await build().order("id", { ascending: true }).range(offset, offset + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (rows.length > MAX_ROWS) throw new Error("too_many_rows");
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });
  const q = new URL(req.url, "http://localhost").searchParams;
  const current = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 7);
  const month = q.get("month") || current;
  const bounds = monthBounds(month);
  if (!bounds) return json(res, 400, { error: "invalid_month", hint: "月は YYYY-MM で指定してください" });
  // 過去24か月〜未来1か月まで（意図しない大量照会を抑える）
  const offset = (Number(month.slice(0, 4)) - Number(current.slice(0, 4))) * 12
    + Number(month.slice(5, 7)) - Number(current.slice(5, 7));
  if (offset < -24 || offset > 1) return json(res, 400, { error: "month_out_of_range", hint: "過去24か月〜翌月を指定してください" });

  const manager = canManageProposals(ctx);
  const viewerId = ctx.employee?.id || null;
  if (!manager && !viewerId) return json(res, 200, {
    ...summarizePerformance({ month, manager: false, viewerId: null }),
    notice: "社員アカウントが見つからないため、個人の集計を表示できません",
  });
  const sb = admin();
  const since = bounds.sinceIso, until = bounds.untilIso, tenant = ctx.tenantId;
  try {
    const [approaches, matched, sent, activities, handoffs, peopleResult, settingsResult] = await Promise.all([
      readAll(() => sb.from("gw_sales_approaches").select("id, employee_id, channel, sent_at")
        .eq("tenant_id", tenant).eq("channel", "form").gte("sent_at", since).lt("sent_at", until)),
      readAll(() => sb.from("gw_sales_proposals").select("id, matched_at, sent_at, matching_owner_email")
        .eq("tenant_id", tenant).gte("matched_at", since).lt("matched_at", until)),
      readAll(() => sb.from("gw_sales_proposals").select("id, matched_at, sent_at, matching_owner_email")
        .eq("tenant_id", tenant).gte("sent_at", since).lt("sent_at", until)),
      readAll(() => sb.from("gw_sales_proposal_activities")
        .select("id, proposal_id, kind, result, employee_id, occurred_at")
        .eq("tenant_id", tenant)
        .in("kind", ["sent", "call", "reply", "cs_decision", "meeting", "result"])
        .gte("occurred_at", since).lt("occurred_at", until)),
      readAll(() => sb.from("gw_sales_proposal_handoffs")
        .select("id, from_owner_id, actor_employee_id, to_stage, created_at")
        .eq("tenant_id", tenant).eq("to_stage", "closing")
        .gte("created_at", since).lt("created_at", until)),
      sb.from("gw_employees").select("id, display_name, email, status")
        .eq("tenant_id", tenant).limit(2000),
      sb.from("gw_sales_proposal_settings").select("cs_members, closing_members")
        .eq("tenant_id", tenant).maybeSingle(),
    ]);
    if (peopleResult.error) throw peopleResult.error;
    if (settingsResult.error) throw settingsResult.error;
    const employees = peopleResult.data || [];
    const settings = settingsOf(settingsResult.data);
    // 提案がmatched/sent両方の期間条件に一致するときも1提案として統合する
    const proposals = [...new Map([...matched, ...sent].map((p) => [p.id, p])).values()];
    const active = await salesMembers(tenant, employees);
    const currentSales = new Set(active.map((m) => m.id));
    // 配置変更・退職前の実績を消さない。チーム設定だけに載る人も0件から表示する
    const teamIds = [...settings.csMembers, ...settings.closingMembers]
      .filter((id) => employees.some((e) => e.id === id && e.status !== "left"));
    const memberIds = [...new Set([...currentSales, ...teamIds])];
    const report = summarizePerformance({
      month, employees, memberIds, settings, approaches, proposals, activities, handoffs, manager, viewerId,
    });
    return json(res, 200, {
      ...report,
      generatedAt: new Date().toISOString(),
      note: manager ? "日時は日本時間。実績は操作履歴ベース・担当変更後も過去の実施者に計上します。"
        : "自分が実施した活動だけを表示しています。担当変更後の活動も操作履歴から計上します。",
    });
  } catch (e) {
    if (String(e?.message || "").includes("too_many_rows")) {
      return json(res, 413, { error: "too_many_rows", hint: "月間の実績が集計上限を超えました。管理者にお知らせください" });
    }
    const hint = dbSetupHint(e, SQL);
    if (hint) return json(res, 503, { error: "not_ready", hint });
    console.error("[sales-member-performance] query failed", e?.code || e?.message || "unknown");
    return json(res, 500, { error: "db_failed", hint: "実績を取得できませんでした。時間をおいて再度お試しください" });
  }
}
