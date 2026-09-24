// POST /api/messages/admin-contact … ［管理サイドへ連絡］の入口。
//
// 相手（管理者個人）を選ばせない。本人専用の窓口を1本だけ開き、
// 管理者・経営者・人事/事務側の「共通受信箱」（db/079）へ届く状態にする。
// 既にあれば作り直さず、いまの管理サイドの顔ぶれに参加者を揃えてから返す。

import { json, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { openAdminContactThread } from "../../lib/messages-admin.js";
import { gwLog } from "../../lib/gw-audit.js";

const SQL = "db/079_admin_contact.sql";

export default async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) {
    return json(res, 403, { error: "not_enrolled", hint: "社員名簿に登録されていません" });
  }

  const sb = admin();
  let result;
  try {
    result = await openAdminContactThread(sb, ctx.tenantId, ctx.employee, user.id);
  } catch (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 200, { notReady: true, message: hint });
    return json(res, 500, { error: "db_error", detail: error.message });
  }

  if (!result.existed) {
    await gwLog({
      tenantId: ctx.tenantId, actorId: user.id, action: "message.admin_contact_open",
      target: result.threadId, detail: { by: ctx.employee.display_name },
    });
  }

  return json(res, 200, result);
}
