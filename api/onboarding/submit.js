// POST /api/onboarding/submit  { itemId, documentId?, undo? }
//
// 本人が「提出しました」を付ける唯一の口。
//
// なぜ API なのか:
//   RLS では列単位の制限が書けない。本人に UPDATE を許すと、社労士への共有可否
//   （share_with_advisor）まで書き換えられてしまう。そこで DB 側では本人の書き込みを
//   全面的に塞ぎ、ここで「自分の項目の status だけ」に絞って service_role で書く。
//
// 変えられるのは status（todo ⇄ submitted）と document_id だけ。
// 完了（done）にできるのは人事側だけで、ここでは扱わない。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const body = await readJson(req);
  const itemId = body?.itemId;
  if (!itemId) return json(res, 400, { error: "invalid_body", required: ["itemId"] });

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません" });

  const sb = admin();

  // 自分の手続きの項目かを確かめる。ここが唯一の認可判定なので必ず両方を見る
  const { data: item, error } = await sb
    .from("gw_procedure_items")
    .select("id, status, owner, procedure_id, gw_procedures!inner(id, employee_id, tenant_id)")
    .eq("id", itemId)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();
  if (error) return json(res, 500, { error: "db_query_failed", detail: error.message });
  if (!item) return json(res, 404, { error: "item_not_found" });
  if (item.gw_procedures?.employee_id !== ctx.employee.id) return json(res, 403, { error: "forbidden" });
  if (item.owner !== "employee") return json(res, 403, { error: "not_your_item", hint: "会社側で対応する項目です" });

  // 人事が完了にした項目を本人が戻せてしまわないようにする
  if (item.status === "done" || item.status === "na") {
    return json(res, 409, { error: "already_completed", hint: "会社側で確認済みの項目です" });
  }

  const patch = {
    status: body.undo ? "todo" : "submitted",
    updated_at: new Date().toISOString(),
  };
  if (body.documentId !== undefined) patch.document_id = body.documentId || null;
  if (body.undo) patch.document_id = null;

  const { data: updated, error: ue } = await sb
    .from("gw_procedure_items")
    .update(patch)
    .eq("id", itemId)
    .select("id, status, document_id")
    .single();
  if (ue) return json(res, 500, { error: "db_update_failed", detail: ue.message });

  return json(res, 200, { ok: true, item: updated });
}
