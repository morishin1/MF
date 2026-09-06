// GET /api/drive/hr-check
//   人事フォルダ（GDRIVE_HR_FOLDER_ID）の設定を見る。人事・管理者だけ。
//
// ■ なぜ要るのか
//   フォルダIDを環境変数に入れただけでは動かない。
//   そのフォルダを、サービスアカウントに「編集者」で共有する必要がある。
//   共有していないと、画面には「フォルダを作れませんでした」としか出ず、
//   IDが違うのか、共有していないのか、鍵が古いのかが分からない。
//
//   ここで実際に Drive を見に行って、
//     ・サービスアカウントのアドレス（共有する相手）
//     ・そのフォルダが見えているか
//     ・書き込めるか
//     ・誰に共有されているか（社内全体に開いていないか）
//   を返す。設定を1回で終わらせるため。
//
// ■ サービスアカウントのアドレスを返すことについて
//   これは鍵ではない。共有相手として画面に貼るためのもの。
//   それでも人事・管理者だけに返す（/api/health には出さない）。

import { json, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext, canManageHr } from "../../lib/gw.js";
import { hrFolderId, hasCredentials, serviceAccountEmail, folderCheck } from "../../lib/gdrive.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManageHr(ctx)) return json(res, 403, { error: "forbidden" });

  const hasKey = hasCredentials();
  const folderId = hrFolderId();
  const serviceAccount = serviceAccountEmail();

  const steps = [];
  steps.push({
    key: "key",
    label: "サービスアカウントの鍵",
    ok: hasKey,
    detail: hasKey ? serviceAccount : "GOOGLE_SERVICE_ACCOUNT_JSON を Vercel に設定してください",
  });
  steps.push({
    key: "folderId",
    label: "人事フォルダのID",
    ok: !!folderId,
    detail: folderId || "GDRIVE_HR_FOLDER_ID を Vercel に設定してください",
  });

  let folder = null;
  if (hasKey && folderId) {
    folder = await folderCheck(folderId);
    steps.push({
      key: "access",
      label: "そのフォルダに書き込めるか",
      ok: folder.ok,
      detail: folder.ok
        ? `${folder.name}（所有者 ${folder.owner || "不明"}）`
        : `${folder.error}　→ Google ドライブでこのフォルダを ${serviceAccount} に「編集者」で共有してください`,
    });

    // 社内全体・リンクを知っている全員に開いていないか。
    // 人事フォルダには履歴書・マイナンバー・労働条件が入る
    const open = (folder.sharedWith || []).filter((p) => p.type === "domain" || p.type === "anyone");
    if (folder.sharedWith) {
      steps.push({
        key: "scope",
        label: "共有の範囲",
        ok: open.length === 0,
        detail: open.length === 0
          ? "個別に共有した相手だけが見られます"
          : `${open.map((p) => p.type === "anyone" ? "リンクを知っている全員" : `${p.domain} の全員`).join("・")}`
            + `が閲覧できます。履歴書・マイナンバー・労働条件が入る場所なので、この共有は外してください`,
      });
    }
  }

  return json(res, 200, {
    serviceAccount,
    folderId: folderId || null,
    folderUrl: folderId ? `https://drive.google.com/drive/folders/${folderId}` : null,
    folder,
    steps,
    ok: steps.every((s) => s.ok),
    // 本人に自動でフォルダを渡すドメイン（lib/hr-drive.js）
    shareDomains: String(process.env.GDRIVE_SHARE_DOMAINS || "gw.8grp.co.jp,8grp.co.jp")
      .split(",").map((s) => s.trim()).filter(Boolean),
  });
}
