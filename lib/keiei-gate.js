// 経営（/api/keiei*）の入口。経営者（owner）だけ・二段階認証（aal2）つき。
//
// 3層（ヘッダー・画面・API）と同じ条件は lib/gw.js の canKeiei ただ1つ。
// このファイルは、その判定と二段階認証を「API の入口」に置くための小さな部品で、
// /api/keiei（集計）と /api/keiei/onboarding（入社案内の作成・送信）が同じ入口を通る。
// 入口を2か所に書くと、片方だけ緩む（test/accessparity.mjs が見張る）。
//
// 順序: ログイン → 所属（テナント） → 経営者か → 二段階認証。
// 権限のない人には、二段階認証の登録を促さない（403 のみ）。

import { json } from "./http.js";
import { requireUser } from "./auth.js";
import { gwContext, canKeiei } from "./gw.js";
import { requireMfaStrict } from "./mfa.js";

/** @returns {Promise<{user:object, ctx:object}|null>} 通せなければ、応答を書いて null */
export async function requireKeiei(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) { json(res, 403, { error: "no_membership" }); return null; }
  if (!canKeiei(ctx)) { json(res, 403, { error: "forbidden", hint: "経営は、経営者だけが使えます" }); return null; }
  if (!(await requireMfaStrict(req, res, ctx, user))) return null;
  return { user, ctx };
}
