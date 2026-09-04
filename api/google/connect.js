// GET    /api/google/connect  … 連携の状態と、同意画面へのURLを返す
// DELETE /api/google/connect  … 連携を切る（Google 側でも失効させる）
//
// 同意画面へ直接リダイレクトせず URL を返しているのは、この呼び出しに
// ログインのトークンが要るため。画面側で受け取って location を変える。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { buildAuthorizeUrl, signState, isConfigured, revoke } from "../../lib/google-oauth.js";
import { linkStatus, removeLink } from "../../lib/google-link.js";
import { gwLog } from "../../lib/gw-audit.js";

// 同意を終えて戻ってくるまでの猶予。取り違えの窓を小さくするため短くする
const STATE_TTL_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "not_enrolled" });

  if (req.method === "GET") {
    const status = await linkStatus(ctx.employee.id);
    if (!isConfigured()) {
      return json(res, 200, {
        ...status,
        configured: false,
        hint: "Googleカレンダー連携が未設定です。管理者に設定を依頼してください",
      });
    }
    const state = signState({
      e: ctx.employee.id,
      t: ctx.tenantId,
      exp: Date.now() + STATE_TTL_MS,
    });
    return json(res, 200, {
      ...status,
      configured: true,
      // 会社のアドレスを先に入れておく。個人のアカウントを選んでしまう事故を減らす
      authUrl: buildAuthorizeUrl(state, ctx.employee.email || user.email || ""),
    });
  }

  if (req.method === "DELETE") {
    const refreshToken = await removeLink(ctx.employee.id);
    // 行を消してから Google 側も失効させる。順番が逆だと、失効に失敗したときに
    // 「ポータルからは切れているのに鍵は生きている」状態が残る
    if (refreshToken) await revoke(refreshToken);
    await gwLog({
      tenantId: ctx.tenantId, actorId: ctx.employee.id,
      action: "google.disconnected", target: ctx.employee.id,
    });
    return json(res, 200, { ok: true, connected: false });
  }

  return methodNotAllowed(res, ["GET", "DELETE"]);
}
