// GET /api/onboarding/brief?employeeId=... … 社労士連絡用テキストと Slack投稿文
//
// ■ 転記させないためだけの口
//   住所も生年月日も基礎年金番号も、本人が入社フォームで1回入れている。
//   それを人事がもう一度メールに打ち直すから、間違いが混ざるし時間がかかる。
//   集まっている情報から文面を組み立てて、そのままコピーできるようにする。
//
// ■ AIには書かせない
//   材料はすべて構造化されている。文章をなめらかにする代わりに
//   生年月日や口座番号が書き換わる可能性を作る意味がない（lib/onboard-brief.js）。
//
// ■ 送信はしない
//   ここは文面を作るだけ。実際に送るのは人。
//   何を渡すかを画面で見てから渡せるようにする。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { advisorBrief, slackPost } from "../../lib/onboard-brief.js";
import { progressOf } from "../../lib/onboard-form.js";

const canManage = (ctx) => ctx.isAdmin || ctx.roles.includes("owner") || canManageHr(ctx);

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  // 個人情報を1画面に並べる。人事以外には出さない
  if (!canManage(ctx)) return json(res, 403, { error: "forbidden" });

  const q = new URL(req.url, "http://localhost").searchParams;
  const employeeId = q.get("employeeId");
  if (!employeeId) return json(res, 400, { error: "invalid_query", required: ["employeeId"] });

  const sb = admin();
  const { data: employee } = await sb.from("gw_employees")
    .select("*").eq("id", employeeId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!employee) return json(res, 404, { error: "employee_not_found" });

  const [profile, contract, proc, manager] = await Promise.all([
    sb.from("gw_onboard_profiles").select("*").eq("employee_id", employeeId).maybeSingle(),
    sb.from("gw_contracts").select("*")
      .eq("employee_id", employeeId).eq("status", "active")
      .order("created_at", { ascending: false }).limit(1),
    sb.from("gw_procedures").select("id, status, target_on")
      .eq("employee_id", employeeId).eq("kind", "onboarding").maybeSingle(),
    employee.manager_id
      ? sb.from("gw_employees").select("display_name").eq("id", employee.manager_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  let items = [];
  if (proc.data) {
    const { data } = await sb.from("gw_procedure_items")
      .select("id, item_key, title, owner, required, status")
      .eq("procedure_id", proc.data.id).order("sort_order").limit(200);
    items = data || [];
  }

  const c = contract.data?.[0] || null;
  const advisor = advisorBrief({ employee, contract: c, profile: profile.data });

  return json(res, 200, {
    employee: { id: employee.id, name: employee.display_name, joinedOn: employee.joined_on },
    profileStatus: profile.data?.status || null,
    progress: progressOf(items),
    advisor,
    slack: slackPost({
      employee, contract: c, profile: profile.data,
      manager: manager.data?.display_name || null,
    }),
  });
}
