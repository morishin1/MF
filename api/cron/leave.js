// GET /api/cron/leave
// 毎日 0:05（日本時間）。退職日（left_on）を過ぎた「退職手続き中（leaving）」の人を、退職（left）に確定する。
//
// ■ なぜ要るか
//   退職日を過ぎた leaving の人は、status が left に書き換わる前でも、サーバーは退職者として扱う
//   （lib/left-gate.js。API の入口と DB 関数が止める）。ただし、無限道場・タイムカードの停止と、
//   会計のメンバーシップの削除は、status が left に変わるときの処理（api/employees/index.js）。
//   退職日が来たら管理者が手で「退職」にし直す運用にすると、必ず忘れられるので、ここで揃える。
//
// ■ やること（1人ずつ。失敗しても他の人は止めない）
//   1. 最後の経営者を退職にしてしまわない（owner-guard）。止まった人は errors に出して、そのまま
//   2. status = left に更新（退職日はそのまま）
//   3. 無限道場・タイムカードを止め、会計のメンバーシップを外す（権限の行は消さない）
//   4. 操作ログ（employee.status。detail.auto = true）
//
// 認証: CRON_SECRET があれば Authorization: Bearer <secret> を要求する。

import { json, methodNotAllowed } from "../../lib/http.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { setAccountsActive, removeAccountingAccess } from "../../lib/accounts.js";
import { guardLastOwner } from "../../lib/owner-guard.js";
import { ymd } from "../../lib/jst.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = req.headers.authorization || "";
    if (given !== `Bearer ${secret}`) return json(res, 401, { error: "unauthorized" });
  }

  const sb = admin();
  const today = ymd();
  const out = { today, due: 0, finalized: 0, skipped: [], errors: [] };

  const { data: due, error } = await sb
    .from("gw_employees")
    .select("id, tenant_id, user_id, display_name, status, left_on")
    .eq("status", "leaving")
    .lt("left_on", today)
    .limit(200);
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  out.due = (due || []).length;

  for (const e of due || []) {
    try {
      const stop = await guardLastOwner(sb, e.tenant_id, e.id, "退職にする");
      if (stop) { out.skipped.push({ id: e.id, reason: "last_owner" }); continue; }

      const { error: ue } = await sb.from("gw_employees")
        .update({ status: "left", updated_at: new Date().toISOString() })
        .eq("id", e.id).eq("status", "leaving");
      if (ue) { out.errors.push({ id: e.id, detail: ue.message }); continue; }

      let systems = null;
      if (e.user_id) {
        systems = await setAccountsActive(sb, e.user_id, false);
        systems.accounting = await removeAccountingAccess(sb, e.tenant_id, e.user_id);
      }
      await gwLog({
        tenantId: e.tenant_id, actorId: null, action: "employee.status",
        target: `employee:${e.id}`, detail: { name: e.display_name, status: "left", auto: true, left_on: e.left_on, systems },
      });
      out.finalized++;
    } catch (err) {
      out.errors.push({ id: e.id, detail: String(err?.message || err).slice(0, 120) });
    }
  }
  return json(res, 200, out);
}
