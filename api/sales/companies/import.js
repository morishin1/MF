// /sales 企業の CSV 取込
//
// POST /api/sales/companies/import { fileName, rows: [{ row, name, siteUrl, ... }], commit: false }
//        … 確認（プレビュー）。DB には書かない。行ごとに 登録できる／重複／要修正 を返す（最大5,000行）
// POST /api/sales/companies/import { fileName, rows, commit: true }
//        … 登録。画面は確認で「登録できる」だった行を50行ずつ送る（1回100行まで）。
//          サーバはもう一度判定し直してから入れる（画面の判定を信じない・途中で別の人が同じ会社を足した場合も飛ばす）
//
// ■ CSV の読み込み（文字コード・区切り）は画面で行い、ここには行のデータだけが来る。ファイルは保存しない
// ■ 担当は取り込んだ人（企業追加・URLまとめて追加と同じ）
// ■ 監査ログ：確認のとき sales.company_csv_preview、登録のとき sales.company_csv_import
//   （実行者・日時・ファイル名・読込件数・登録件数・重複件数・エラー件数）

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../../lib/http.js";
import { requireUser } from "../../../lib/auth.js";
import { gwContext, canSell } from "../../../lib/gw.js";
import { userClient } from "../../../lib/supabase.js";
import { gwLog } from "../../../lib/gw-audit.js";
import { checkImportRows, countResults, CSV_PREVIEW_MAX, CSV_COMMIT_MAX } from "../../../lib/sales-csv-import.js";

const SQL = "db/088_sales.sql";

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canSell(ctx)) return json(res, 403, { error: "forbidden" });
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const sb = userClient(req);
  const body = await readJson(req);
  const rows = Array.isArray(body.rows) ? body.rows : null;
  const fileName = String(body.fileName || "").slice(0, 200) || null;
  const commit = body.commit === true;
  if (!rows || !rows.length) return json(res, 400, { error: "empty", hint: "取り込む行がありません" });
  const max = commit ? CSV_COMMIT_MAX : CSV_PREVIEW_MAX;
  if (rows.length > max) {
    return json(res, 400, { error: "too_many", hint: commit ? `1回に登録できるのは${max}行までです` : `1つのCSVで読めるのは${max}行までです` });
  }

  // 既存の会社（このCSVに出てくるドメインだけ、100件ずつ）。非表示の会社も重複に数える
  const pre = checkImportRows(rows, new Map());
  const domains = [...new Set(pre.map((r) => r.value?.domain).filter(Boolean))];
  const existing = new Map();
  for (let i = 0; i < domains.length; i += 100) {
    const { data, error } = await sb.from("gw_sales_companies").select("domain, name")
      .eq("tenant_id", ctx.tenantId).in("domain", domains.slice(i, i + 100));
    if (error) {
      const hint = dbSetupHint(error, SQL);
      if (hint) return json(res, 503, { error: "not_ready", message: hint });
      return json(res, 500, { error: "db_query_failed", detail: error.message });
    }
    for (const c of data || []) existing.set(c.domain, c.name);
  }
  const results = checkImportRows(rows, existing);

  if (!commit) {
    const counts = countResults(results);
    await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.company_csv_preview",
      target: "sales_company:csv", detail: { fileName, ...counts } });
    return json(res, 200, { results: results.map(publicResult), counts });
  }

  // 登録：判定が ok の行だけ。まとめて入れて、失敗したら1行ずつ入れ直して、どの行が駄目だったかを返す
  const ok = results.filter((r) => r.status === "ok");
  const toRow = (r) => ({ ...r.value, owner_id: ctx.employee?.id || null, tenant_id: ctx.tenantId, created_by: user.id });
  if (ok.length) {
    const { error } = await sb.from("gw_sales_companies").insert(ok.map(toRow));
    if (error) {
      for (const r of ok) {
        const { error: e1 } = await sb.from("gw_sales_companies").insert(toRow(r));
        if (e1) {
          r.status = e1.code === "23505" ? "duplicate" : "error";
          r.reasons = [e1.code === "23505" ? "登録済みのためスキップ（同時に登録されました）" : `登録できませんでした：${e1.message}`];
        } else r.status = "created";
      }
    } else for (const r of ok) r.status = "created";
  }
  const counts = { read: results.length, created: 0, duplicate: 0, error: 0 };
  for (const r of results) counts[r.status === "ok" ? "created" : r.status] += 1;
  const rowNos = results.map((r) => r.row);
  await gwLog({ tenantId: ctx.tenantId, actorId: user.id, action: "sales.company_csv_import", target: "sales_company:csv",
    detail: { fileName, ...counts, firstRow: Math.min(...rowNos), lastRow: Math.max(...rowNos) } });
  return json(res, 200, { results: results.map(publicResult), counts });
}

function publicResult(r) {
  return { row: r.row, status: r.status, reasons: r.reasons, ...r.show };
}
