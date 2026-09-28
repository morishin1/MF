// GET  /api/sales/companies/export?q=&status=&owner=&service=&industry=&region=&channel=&visibility=&sort=&order=
//        … いまの検索・絞り込み・並べ替えの結果すべてを CSV で（サーバーで条件を実行し直す。db/097）
// POST /api/sales/companies/export { ids: [...], sort?, order? }
//        … チェックした企業だけを CSV で
//
// ■ 画面に出ている100件から作らない
//   条件はサーバーで実行し直す。選んだ企業も、自テナントに実在するものだけを書く（他テナントのIDは黙って落とす）。
// ■ 日本の Excel で開けるように UTF-8 BOM つき・CRLF。= + - @ で始まる値は ' を付けて式にしない
// ■ 誰が何件ダウンロードしたかを監査ログに残す（営業先の一覧は持ち出しに注意が要る情報なので）

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { parseListQuery, companiesCsv, todayJst, EXPORT_MAX } from "../../../lib/sales.js";
import { exportRows } from "../../../lib/sales-list.js";

const SQL = "db/097_sales_company_list.sql";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });

  const sp = new URL(req.url || "/", "http://localhost").searchParams;
  let ids = null;
  if (req.method === "POST") {
    const body = await readJson(req);
    if (!Array.isArray(body?.ids) || !body.ids.length) {
      return json(res, 400, { error: "invalid_body", required: ["ids"], hint: "ダウンロードする企業を選んでください" });
    }
    ids = body.ids;
    if (body.sort) sp.set("sort", String(body.sort));
    if (body.order) sp.set("order", String(body.order));
    // 選んだ企業は、表示状態に関係なく書く（非表示の一覧から選んだものも）
    sp.set("visibility", "all");
  }
  const f = parseListQuery(sp);
  if (f.error) return json(res, 400, f);

  const sb = userClient(req);
  const r = await exportRows(sb, ctx, f, ids);
  if (r.error) {
    const hint = dbSetupHint(r.error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: r.error.message });
  }
  if (r.tooMany) {
    return json(res, 400, { error: "too_many", total: r.total,
      hint: `一度にダウンロードできるのは${EXPORT_MAX.toLocaleString()}社までです（いま ${Number(r.total).toLocaleString()}社）。絞り込んでください` });
  }

  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id, action: "sales.company_export",
    target: "sales_company:export",
    detail: {
      count: r.total, mode: ids ? "selected" : "filtered",
      filters: ids ? null : Object.fromEntries(Object.entries(f).filter(([k, v]) => v && !["page", "limit"].includes(k))),
    },
  });

  const name = `sales_companies_${todayJst()}.csv`;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader("Cache-Control", "no-store");
  res.end(companiesCsv(r.rows));
}
