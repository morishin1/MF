// 入社・退職手続きの個人フォルダを Google Drive に用意する。
//
// 保存先は証憑のルート（GDRIVE_ROOT_FOLDER_ID）ではなく、
// 人事専用の GDRIVE_HR_FOLDER_ID の下に作る。
// 証憑のフォルダは税理士事務所と共有していることがあり、マイナンバーや
// 年金手帳の控えを同じ場所に置くと社外から見えてしまうため。
//
// 構成:
//   人事ルート/
//   ├ 入社/                  （退職なら「退職」）
//   │ └ 2026年/              （入社日・退職日の年。未定なら「日付未定」）
//   │   └ 山田 太郎/          ← 個人フォルダ（drive_folder_id）
//   │     ├ 01_採用・履歴書
//   │     ├ 02_労働条件・契約
//   │     ├ 03_入社提出書類
//   │     ├ 04_社会保険・労務  ← 社労士に共有するのはここだけ
//   │     └ 05_その他
//   └ 機微情報/
//     └ 2026年/
//       └ 山田 太郎/          ← マイナンバー等（drive_sensitive_folder_id）
//
// ■ 機微情報を個人フォルダの外に置く理由
//   個人フォルダを誰かに共有すると、その下は全部付いてくる。
//   マイナンバーは「見られる人を最小にする」のが安全管理措置そのものなので、
//   共有の単位（フォルダ）から外に出しておく。
//
// 未設定の環境では何もしない。手続きの作成自体は成功させる。

import { hrConfigured, hrFolderId, ensureFolder, shareWith } from "./gdrive.js";
import { FOLDERS, SENSITIVE_FOLDER, ADVISOR_FOLDER_KEY } from "./onboard-docs.js";

const KIND_FOLDER = { onboarding: "入社", offboarding: "退職" };

const yearOf = (d) => (d ? `${new Date(d).getFullYear()}年` : "日付未定");

/**
 * 個人フォルダ（ルートだけ）。従来の呼び出し互換
 * @returns {Promise<{folderId:string, link:string}|{skipped:string}>}
 */
export async function ensureProcedureFolder({ kind, targetOn, displayName }) {
  if (!hrConfigured()) return { skipped: "not_configured" };
  if (!displayName) return { skipped: "no_name" };

  const kindId = await ensureFolder(KIND_FOLDER[kind] || "その他", hrFolderId());
  const yearId = await ensureFolder(yearOf(targetOn), kindId);
  const personId = await ensureFolder(displayName, yearId);

  return { folderId: personId, link: linkOf(personId) };
}

/**
 * 個人フォルダ一式。ルート ＋ 5つの下位 ＋ 機微情報。
 * 既にあるものはそのまま使う（同じ名前を探して、無ければ作る）ので、
 * 何度呼んでも増えない。
 *
 * @returns {Promise<{folderId, link, folders:{[key]:id}, sensitiveFolderId}|{skipped:string}>}
 */
export async function ensureProcedureFolders({ kind, targetOn, displayName }) {
  const root = await ensureProcedureFolder({ kind, targetOn, displayName });
  if (root.skipped) return root;

  const folders = {};
  for (const f of FOLDERS) folders[f.key] = await ensureFolder(f.name, root.folderId);

  // 機微情報は個人フォルダの外。人事ルート/機微情報/年/氏名
  const sensRoot = await ensureFolder(SENSITIVE_FOLDER, hrFolderId());
  const sensYear = await ensureFolder(yearOf(targetOn), sensRoot);
  const sensitiveFolderId = await ensureFolder(displayName, sensYear);

  return { ...root, folders, sensitiveFolderId };
}

/**
 * 社労士に 04_社会保険・労務 だけを共有する。
 * 他のフォルダは渡さない。個人フォルダのルートを渡すと全部付いてくる
 */
export async function shareAdvisorFolder(folders, email) {
  if (!hrConfigured()) return { skipped: "not_configured" };
  const id = folders?.[ADVISOR_FOLDER_KEY];
  if (!id) return { skipped: "no_folder" };
  return shareWith(id, email, "reader");
}

export const linkOf = (id) => `https://drive.google.com/drive/folders/${id}`;
