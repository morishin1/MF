// 経営（/api/keiei*）の入口。経営者（owner）だけ。
//
// 3層（ヘッダー・画面・API）と同じ条件は lib/gw.js の canKeiei ただ1つ。
// このファイルは、その判定を「API の入口」に置くための小さな部品で、
// /api/keiei（集計）と /api/keiei/onboarding（入社案内の作成・送信）が同じ入口を通る。
// 入口を2か所に書くと、片方だけ緩む（test/accessparity.mjs が見張る）。
//
// 二段階認証（aal2）は要らない（2026-10-01 の方針変更。二段階認証は任意のセキュリティ設定）。
// 給与・個人情報を守るのは、経営者（owner）というロールの判定。
//
// 順序: ログイン → 所属（テナント） → 経営者か。

import { json } from "./http.js";
import { requireUser } from "./auth.js";
import { gwContext, canKeiei } from "./gw.js";

/** @returns {Promise<{user:object, ctx:object}|null>} 通せなければ、応答を書いて null */
export async function requireKeiei(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) { json(res, 403, { error: "no_membership" }); return null; }
  if (!canKeiei(ctx)) { json(res, 403, { error: "forbidden", hint: "経営は、経営者だけが使えます" }); return null; }
  return { user, ctx };
}
