// AI営業の予算：呼ぶ前に予約し、呼んだあとに実費で確定する（db/131 の gw_sales_ai_reserve / gw_sales_ai_settle）。
//
//   予約 … 設定行をロックしてから「確定済み＋予約中＋今回の最大額 ≤ 上限」を確かめる。並列で呼ばれても上限を超えない
//   確定 … 実際のトークン・費用で確定。上限に達した・失敗が続いたら、DB 側で自動停止する
//   失敗 … 費用 0 で確定（outcome に理由）。応答が無いまま落ちた予約は、10分たつと次の予約で解放される
//
// 関数は service_role だけが呼べる（db/131 で anon・authenticated から外してある）。必ず admin() で呼ぶ。

import { costOf } from "./config.js";

export async function reserve(sb, { tenantId, estimate, purpose, model, companyId = null, employeeId = null }) {
  const { data, error } = await sb.rpc("gw_sales_ai_reserve", {
    p_tenant: tenantId, p_estimate: estimate, p_purpose: purpose, p_model: model,
    p_company: companyId, p_employee: employeeId,
  });
  if (error) throw Object.assign(new Error(error.message), { code: "budget_db", detail: error });
  const row = Array.isArray(data) ? data[0] : data;
  if (row?.reservation_id) return { id: row.reservation_id };
  return { reason: row?.reason || "disabled" };
}

export async function settle(sb, id, { model, usage = {}, outcome, error = null, latencyMs = null }) {
  const { data, error: e } = await sb.rpc("gw_sales_ai_settle", {
    p_id: id, p_input: usage.input_tokens || 0, p_output: usage.output_tokens || 0,
    p_cost: outcome === "ok" || usage.output_tokens ? costOf(model, usage) : 0,
    p_outcome: outcome, p_error: error, p_latency: latencyMs,
  });
  if (e) throw Object.assign(new Error(e.message), { code: "budget_db", detail: e });
  return data || null;   // 自動停止したときの理由（monthly_cap / errors）
}
