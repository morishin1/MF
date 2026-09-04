// GET   /api/expenses/settings          … ワークフロー設定
// PATCH /api/expenses/settings          … 承認しきい値・勘定科目の変更（管理部のみ）
//
// 承認経路をコードに埋めず設定に置いているのは、運用しながら
// 「いくらから代表承認にするか」を変えたくなるため。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { loadWorkflowSettings } from "../../lib/expenses.js";
import { gwLog } from "../../lib/gw-audit.js";

const MAX_THRESHOLD = 100_000_000;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });

  if (req.method === "GET") {
    return json(res, 200, { settings: await loadWorkflowSettings(ctx.tenantId) });
  }

  if (req.method === "PATCH") {
    if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

    const body = await readJson(req);
    const patch = { tenant_id: ctx.tenantId, updated_at: new Date().toISOString() };

    if (body?.ownerThreshold !== undefined) {
      const n = Number(body.ownerThreshold);
      if (!Number.isInteger(n) || n < 0 || n > MAX_THRESHOLD) {
        return json(res, 400, { error: "invalid_threshold", hint: "0以上の整数で入れてください（0で代表承認なし）" });
      }
      patch.expense_owner_threshold = n;
    }

    if (body?.categories !== undefined) {
      const list = (Array.isArray(body.categories) ? body.categories : [])
        .map((c) => String(c).trim())
        .filter(Boolean)
        .slice(0, 40);
      if (!list.length) return json(res, 400, { error: "no_categories", hint: "勘定科目を1つ以上残してください" });
      patch.expense_categories = [...new Set(list)];
    }

    const { data, error } = await admin()
      .from("gw_workflow_settings")
      .upsert(patch, { onConflict: "tenant_id" })
      .select("expense_owner_threshold, expense_categories")
      .single();
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

    await gwLog({
      tenantId: ctx.tenantId, actorId: ctx.employee?.id || null,
      action: "workflow.settings_updated", target: ctx.tenantId,
      detail: { threshold: data.expense_owner_threshold },
    });
    return json(res, 200, { settings: data });
  }

  return methodNotAllowed(res, ["GET", "PATCH"]);
}
