import { json, readJson, dbSetupHint } from "./http.js";
import { userClient } from "./supabase.js";
import { SQL_FILE, normalizeSalesRequest, normalizeOfficeUpdate, shapeRequestEnvelope } from "./sales-contract-requests.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requestError(res, e) {
  if (e?.code === "invalid_response") return json(res, 503, { ready: false, error: "invalid_response",
    hint: "最新の依頼データを確認できません。空の一覧として扱わず、管理者へ確認してください" });
  const setup = dbSetupHint(e, SQL_FILE);
  if (setup || e?.code === "PGRST202") return json(res, 503, { ready: false, error: "not_ready", hint: setup || `管理者に ${SQL_FILE} の実行を依頼してください` });
  const msg = String(e?.message || "");
  if (e?.code === "PT409") return json(res, 409, { error: "version_conflict", hint: "別の人が更新しました。詳細を読み直してから操作してください" });
  if (e?.code === "42501") return json(res, 403, { error: "forbidden", hint: "この依頼を操作できる権限がありません" });
  if (["23514", "22023", "22P02", "22007", "22008"].includes(e?.code)) return json(res, 409, {
    error: "request_blocked", hint: ({ pass_required: "現在のENGER合格記録が確認できないため依頼できません", proposal_inactive: "終了・連絡停止・アーカイブされた提案は依頼できません",
      draft_required: "作成完了には、契約種別・Office担当者・作成した書類の保管場所/管理番号（10文字以上）が必要です",
      invalid_transition: "この状態には変更できません。取消・完了の依頼は再開してください", invalid_document_link: "同じ会社・対象者の既存書類/現場契約を指定してください",
      invalid_assignee: "Officeを利用できる在籍中の担当者を選んでください", reason_required: "理由を記入してください" })[msg] || "入力内容・状態・対象者の紐付けを確認してください",
  });
  console.error("[sales-contract-requests]", e?.code || "unknown");
  return json(res, 500, { error: "request_failed", hint: "依頼を読み書きできませんでした。時間をおいて読み直してください" });
}

export async function runContractRequests(req, res, ctx, office = false) {
    res.setHeader("Cache-Control", "no-store");
    const sb = userClient(req); // JWTをDBのRPCまで保つ。service_roleで権限を迂回しない。
    let proposalId = null, actionResult = null;
    try {
      if (req.method === "GET") {
        proposalId = new URL(req.url, "http://localhost").searchParams.get("proposalId");
        if (proposalId && !UUID.test(proposalId)) return json(res, 400, { error: "invalid_query" });
      } else {
        const parsed = (office ? normalizeOfficeUpdate : normalizeSalesRequest)(await readJson(req));
        if (parsed.error) return json(res, 400, parsed);
        const v = parsed.value;
        proposalId = v.proposalId;
        const { data: applied, error } = await sb.rpc("gw_sales_contract_request_action", {
          p_tenant: ctx.tenantId, p_proposal: proposalId, p_mode: office ? "office" : "sales",
          p_action: v.action, p_expected_version: v.expectedVersion, p_payload: v.payload,
        });
        if (error) return requestError(res, error);
        if (!applied || !UUID.test(String(applied.id || "")) || !Number.isSafeInteger(applied.version)
            || applied.version < 1 || typeof applied.replayed !== "boolean") return json(res, 503, {
          ready: false, error: "outcome_unconfirmed", outcomeUnconfirmed: true,
          hint: "保存処理の応答を確認できません。保存された可能性があるため、再送せず最新の依頼を読み直してください",
        });
        actionResult = applied;
      }
      const { data, error } = await sb.rpc("gw_sales_contract_requests_read", {
        p_tenant: ctx.tenantId, p_mode: office ? "office" : "sales", p_proposal: proposalId,
      });
      if (error) {
        if (actionResult) return json(res, 200, { ok: true, ready: false, refreshFailed: true, actionResult,
          hint: "保存しましたが、最新表示を取得できませんでした。再送せず一覧を読み直してください" });
        return requestError(res, error);
      }
      return json(res, 200, { ...(req.method === "POST" ? { ok: true } : {}), ...shapeRequestEnvelope(data, office) });
    } catch (e) {
      if (actionResult) return json(res, 200, { ok: true, ready: false, refreshFailed: true, actionResult,
        hint: "保存しましたが、最新表示を取得できませんでした。再送せず一覧を読み直してください" });
      return requestError(res, e);
    }
}
