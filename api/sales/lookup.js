// GET /api/sales/lookup?url=https://example.co.jp
//   … 企業サイトの URL から、企業名・問い合わせフォーム URL などの候補を返す（クイック登録用）。
//     あわせて、同じドメインの企業がもう登録されていないかも返す。
//
// ■ 取れなくても 200 で返す（要件 §4「取得できない項目があっても登録を止めない」）
//   ok:false と理由（reason）を返し、画面は URL だけで登録を進められる。
// ■ 外のサイトへの取得は lib/sales-lookup.js（社内アドレスには行かない・6秒で打ち切り）

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canSell } from "../../lib/gw.js";
import { userClient } from "../../lib/supabase.js";
import { lookupCompany, normalizeSiteUrl } from "../../lib/sales-lookup.js";
import { domainOf } from "../../lib/sales.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const raw = new URL(req.url, "http://localhost").searchParams.get("url");
  const url = normalizeSiteUrl(raw);
  if (!url) return json(res, 400, { error: "bad_url", hint: "企業サイトのURLを入れてください（https://…）" });

  const domain = domainOf(url);
  const sb = userClient(req);
  const [{ data: dup }, found] = await Promise.all([
    domain
      ? sb.from("gw_sales_companies").select("id, name").eq("tenant_id", ctx.tenantId).eq("domain", domain).limit(1)
      : Promise.resolve({ data: [] }),
    lookupCompany(url),
  ]);

  return json(res, 200, {
    url, domain,
    duplicate: dup?.[0] ? { id: dup[0].id, name: dup[0].name } : null,
    ok: found.ok, reason: found.ok ? null : found.reason,
    name: found.name || null, formUrl: found.formUrl || null, phone: found.phone || null,
    address: found.address || null, description: found.description || null,
  });
}
