// Office 入社書類の機微情報分離：ソース／ポリシーの退行チェック。
// 本番 DB・個人情報へのアクセスはしない。ロール別の実機確認は運用手順で行う。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

test("本人への Drive 自動共有に機微情報フォルダを含めない", () => {
  const drive = read("lib/hr-drive.js");
  const start = drive.indexOf("export async function shareEmployeeFolders");
  const end = drive.indexOf("export async function shareAdvisorFolder", start);
  const share = drive.slice(start, end);
  assert.match(share, /const targets = EMPLOYEE_FOLDER_KEYS\.map/);
  assert.doesNotMatch(share, /targets\s*=\s*\[[\s\S]*drive\?\.sensitiveFolderId/);
});

test("本人APIから機微情報フォルダの識別子を返さない", () => {
  const self = read("api/onboarding/me.js");
  assert.doesNotMatch(self, /async function employeeDrive\(/);
  assert.doesNotMatch(self, /drive\.sensitiveId/);
  assert.match(self, /driveLink: null/);
  assert.match(self, /driveSynced: Boolean\(f\.drive_file_id\)/);
  const list = read("api/onboarding/index.js");
  assert.match(list, /drive_sensitive_folder_id,[\s\S]*\.\.\.safeProcedure/);
  assert.match(list, /\.\.\.managementDrive/);
});

test("提出URLの発行・確定は個人番号書類を拒否し、実体を検証する", () => {
  const upload = read("api/onboarding/upload.js");
  assert.match(upload, /if \(isMyNumberFilename\(filename\)\)/);
  assert.match(upload, /if \(isMyNumberFilename\(file\.filename\)\)/);
  assert.match(upload, /Number\.isSafeInteger\(sizeBytes\)/);
  assert.match(upload, /\.info\(file\.storage_path\)/);
  assert.match(upload, /file_size_mismatch/);
  assert.match(upload, /file\.uploaded_by !== user\.id/);
});

test("短期閲覧URLは本人・HR・共有社労士だけで、正しい操作者IDを監査記録する", () => {
  const upload = read("api/onboarding/upload.js");
  assert.match(upload, /!canManageHr\(ctx\) && !isMine && !isSharedAdvisor/);
  assert.match(upload, /doc\?\.sensitive \|\| doc\?\.collect === false/);
  assert.match(upload, /Cache-Control", "private, no-store"/);
  assert.match(upload, /actor: \{ id: user\.id,/);
});

test("DBでも社労士に個人番号書類を読ませない", () => {
  const sql = read("db/157_onboarding_file_read_scope.sql");
  assert.match(sql, /i\.share_with_advisor = true/);
  assert.match(sql, /i\.item_key, ''\) <> 'doc_mynumber'/);
  assert.match(sql, /i\.title, ''\) !~\*/);
  assert.doesNotMatch(sql, /storage\.buckets.*set\s+public\s*=\s*true/i);
});

test("本人画面には個人番号をOfficeに提出しない旨を明記", () => {
  const html = read("onboarding.html");
  assert.match(html, /個人番号の提出方法は社労士から別途ご案内します/);
  assert.match(html, /マイナンバー関連書類はこの画面にアップロードしないでください/);
});

test("個人フォルダは手続きIDで区別し、同姓同名の社員でも混在しない", () => {
  const drive = read("lib/hr-drive.js");
  const onboarding = read("api/onboarding/index.js");
  const upload = read("api/onboarding/upload.js");
  assert.match(drive, /const folderName = procedureId/);
  assert.match(drive, /displayName}__\${procedureId}/);
  assert.match(onboarding, /procedureId: proc\.id/);
  assert.match(upload, /procedureId: item\.procedureId/);
});

test("Officeのアップロードが標準経路で、Driveへ再同期可能", () => {
  const html = read("onboarding.html");
  const upload = read("api/onboarding/upload.js");
  const gdrive = read("lib/gdrive.js");
  assert.match(html, /この画面から書類をアップロードしてください/);
  assert.match(html, /Drive同期待ち/);
  assert.match(html, /syncOnly: true/);
  assert.doesNotMatch(html, /ドライブに入れました/);
  assert.match(upload, /uploadFileOnce/);
  assert.match(upload, /driveStatus: driveSynced \? "synced" : "pending"/);
  assert.match(gdrive, /export async function uploadFileOnce/);
});

test("再同期は提出済み以外を再提出扱いにせず、UUID名で複製を防止", () => {
  const upload = read("api/onboarding/upload.js");
  assert.match(upload, /if \(syncOnly && !\["submitted", "done"\]\.includes\(item\.status\)\)/);
  assert.match(upload, /const name = `\${file\.id}_\${baseName}`/);
  assert.match(upload, /if \(file\.drive_file_id\) return \{ skipped: "already" \}/);
});
