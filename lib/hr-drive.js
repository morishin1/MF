// 入社・退職手続きの個人フォルダを Google Drive に用意する。
//
// 保存先は証憑のルート（GDRIVE_ROOT_FOLDER_ID）ではなく、
// 人事専用の GDRIVE_HR_FOLDER_ID の下に作る。
// 証憑のフォルダは税理士事務所と共有していることがあり、マイナンバーや
// 年金手帳の控えを同じ場所に置くと社外から見えてしまうため。
//
// 構成:
//   人事ルート/
//   └ 入社/            （退職なら「退職」）
//     └ 2026年/        （入社日・退職日の年。未定なら「日付未定」）
//       └ 山田 太郎/
//
// 未設定の環境では何もしない。手続きの作成自体は成功させる。

import { hrConfigured, hrFolderId, ensureFolder } from "./gdrive.js";

const KIND_FOLDER = { onboarding: "入社", offboarding: "退職" };

/**
 * @returns {Promise<{folderId:string, link:string}|{skipped:string}>}
 */
export async function ensureProcedureFolder({ kind, targetOn, displayName }) {
  if (!hrConfigured()) return { skipped: "not_configured" };
  if (!displayName) return { skipped: "no_name" };

  const year = targetOn ? `${new Date(targetOn).getFullYear()}年` : "日付未定";

  const kindId = await ensureFolder(KIND_FOLDER[kind] || "その他", hrFolderId());
  const yearId = await ensureFolder(year, kindId);
  const personId = await ensureFolder(displayName, yearId);

  return {
    folderId: personId,
    link: `https://drive.google.com/drive/folders/${personId}`,
  };
}
