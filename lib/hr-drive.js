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

// ---- 本人にフォルダを開いてもらう ------------------------------------------
//
// ■ 何を渡すか
//   本人が出すフォルダ（01・03・04・05）と、機微情報の自分のぶんだけ。
//   02_労働条件・契約 は渡さない。契約書や条件通知書は会社が置くもので、
//   本人が消したり差し替えたりできる場所に置くものではない。
//   個人フォルダのルートを渡すと 02 も付いてくるので、ルートは渡さない。
//
// ■ 自動で共有する相手を、会社のドメインに限る理由
//   共有はいちど渡すと外から取り消しにくい。
//   登録フォームのメールを1文字打ち間違えただけで、
//   他人のGoogleアカウントに人事フォルダが渡ってしまう。
//   自社ドメイン宛なら、間違えても社内に留まる。
//   社外のアドレス（入社前で会社アカウントがまだ無い等）は自動では渡さず、
//   管理者が中身を見て手で共有する。
const EMPLOYEE_FOLDER_KEYS = ["01", "03", "04", "05"];

/** 自動で共有してよいドメイン。GDRIVE_SHARE_DOMAINS で変えられる */
const shareDomains = () =>
  String(process.env.GDRIVE_SHARE_DOMAINS || "8grp.co.jp")
    .split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);

/** このアドレスに自動で共有してよいか */
export function canAutoShare(email) {
  const at = String(email || "").toLowerCase().split("@");
  if (at.length !== 2 || !at[1]) return false;
  return shareDomains().includes(at[1]);
}

/**
 * 本人が自分のフォルダへ直接アップロードできるようにする。
 *
 * @param {{folders:object, sensitiveFolderId:string}} drive gw_procedures に入っている値
 * @param {string} email 本人のメール
 * @param {{force?:boolean}} opts force:true でドメインの制限を外す。
 *   管理者が相手を見て「この人に渡す」と決めたときだけ使う
 * @returns {Promise<{shared:string[], skipped?:string}>}
 */
export async function shareEmployeeFolders(drive, email, opts = {}) {
  if (!hrConfigured()) return { shared: [], skipped: "not_configured" };
  if (!email) return { shared: [], skipped: "no_email" };
  if (!opts.force && !canAutoShare(email)) return { shared: [], skipped: "domain_not_allowed" };

  const targets = [
    ...EMPLOYEE_FOLDER_KEYS.map((k) => drive?.folders?.[k]).filter(Boolean),
    drive?.sensitiveFolderId,
  ].filter(Boolean);
  if (!targets.length) return { shared: [], skipped: "no_folder" };

  const shared = [];
  for (const id of targets) {
    try {
      await shareWith(id, email, "writer");
      shared.push(id);
    } catch (e) {
      // すでに権限がある場合もここに来る。1つ失敗しても残りは続ける
      console.error("[hr-drive] 共有できませんでした:", id, e?.message || e);
    }
  }
  return { shared };
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
