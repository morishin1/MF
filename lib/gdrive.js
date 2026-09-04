// Google Drive 連携（サービスアカウント / JWT Bearer フロー）
//
// 役割:
//   - 取引先 / 対象月 / 種別 のフォルダを「無ければ作る」で解決し、証憑ファイルを保存する
//   - 月次の仕訳一覧CSVを同名で上書き保存する
//
// 必要な環境変数:
//   GOOGLE_SERVICE_ACCOUNT_JSON … サービスアカウントのJSONキー全文（推奨）
//     （代替）GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY
//   GDRIVE_ROOT_FOLDER_ID       … 保存先ルートフォルダのID
//   GOOGLE_IMPERSONATE_USER     … （任意）なりすます社内ユーザーのメールアドレス
//
// 保存先の選び方は2通り:
//   1) 共有ドライブ（推奨）
//      サービスアカウントを「コンテンツ管理者」でメンバー追加する。
//      GOOGLE_IMPERSONATE_USER は不要。
//   2) マイドライブ + なりすまし
//      共有ドライブが使えない場合。Workspace管理コンソールで
//      「ドメイン全体の委任」を設定し、GOOGLE_IMPERSONATE_USER にそのユーザーを入れる。
//      ファイルの所有者がそのユーザーになり、その人の容量を使う。
//
// なりすましを使わずにマイドライブへ保存しようとすると、サービスアカウントには
// 保存容量が無いため storageQuotaExceeded で失敗する。

import crypto from "node:crypto";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

// 書類種別 → フォルダ名
export const DOC_TYPE_FOLDER = {
  invoice: "請求書", receipt: "領収書", bank: "通帳・銀行", card: "カード明細",
  salary: "給与明細", contract: "契約書", quote: "見積書", tax: "納付書・税金",
  certificate: "証明書", namecard: "名刺", other: "その他", unknown: "未判定",
};

function creds() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (raw) {
    let j;
    try { j = JSON.parse(raw); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON が正しいJSONではありません"); }
    if (j.client_email && j.private_key) return { email: j.client_email, key: j.private_key };
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON に client_email / private_key がありません");
  }
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (email && key) return { email, key: key.replace(/\\n/g, "\n") };
  return null;
}

export function rootFolderId() { return process.env.GDRIVE_ROOT_FOLDER_ID || ""; }

// 人事書類の保存先。証憑のルートとは意図的に分けている。
// 証憑のフォルダは税理士事務所など社外と共有していることがあり、
// マイナンバーや年金手帳の控えを同じ場所に置くと見えてしまうため、
// 別フォルダを明示的に設定したときだけ人事フォルダを作る。
export function hrFolderId() { return process.env.GDRIVE_HR_FOLDER_ID || ""; }
export function hrConfigured() {
  try { return Boolean(creds() && hrFolderId()); } catch { return false; }
}

export function isConfigured() {
  try { return Boolean(creds() && rootFolderId()); } catch { return false; }
}

// ---- アクセストークン（インスタンス内でキャッシュ） ----
let cachedToken = null; // { token, exp }

export async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const c = creds();
  if (!c) throw new Error("Googleサービスアカウントが未設定です（GOOGLE_SERVICE_ACCOUNT_JSON）");

  // GOOGLE_IMPERSONATE_USER を入れると、そのユーザーになりすまして動く
  // （ドメイン全体の委任が必要）。共有ドライブを作れない場合の逃げ道で、
  // ファイルの所有者がそのユーザーになるため、マイドライブにも保存できる。
  const subject = (process.env.GOOGLE_IMPERSONATE_USER || "").trim();

  const b64 = (s) => Buffer.from(s).toString("base64url");
  const header = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({
    iss: c.email,
    ...(subject ? { sub: subject } : {}),
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const sig = crypto.createSign("RSA-SHA256").update(`${header}.${claim}`).sign(c.key).toString("base64url");

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${sig}`,
    }).toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("google_token_failed: " + (data.error_description || data.error || r.status));

  cachedToken = { token: data.access_token, exp: now + (Number(data.expires_in) || 3600) };
  return cachedToken.token;
}

// ---- ユーティリティ ----
export function sanitizeName(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "未設定";
}
const escapeQ = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function driveFetch(url, opts = {}) {
  const token = await getAccessToken();
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("drive_api_failed: " + (data.error?.message || `HTTP ${r.status}`));
  return data;
}

// 親フォルダ内の同名ファイル/フォルダを1件検索
async function findChild(name, parentId, mimeType) {
  const clauses = [
    `name='${escapeQ(name)}'`,
    `'${escapeQ(parentId)}' in parents`,
    "trashed=false",
    mimeType ? `mimeType='${mimeType}'` : null,
  ].filter(Boolean).join(" and ");
  const url = `${API}/files?q=${encodeURIComponent(clauses)}` +
    `&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name)&pageSize=1`;
  const d = await driveFetch(url);
  return d.files?.[0] || null;
}

// ---- フォルダ解決（無ければ作成） ----
const folderCache = new Map();

export async function ensureFolder(name, parentId) {
  const safe = sanitizeName(name);
  const key = `${parentId}/${safe}`;
  if (folderCache.has(key)) return folderCache.get(key);

  let hit = await findChild(safe, parentId, FOLDER_MIME);
  if (!hit) {
    hit = await driveFetch(`${API}/files?supportsAllDrives=true&fields=id,name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: safe, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
  }
  folderCache.set(key, hit.id);
  return hit.id;
}

// ['エイト','2026-06','領収書'] → 末端フォルダID
export async function ensureFolderPath(parts, rootId = rootFolderId()) {
  if (!rootId) throw new Error("GDRIVE_ROOT_FOLDER_ID が未設定です");
  let parent = rootId;
  for (const p of parts.filter(Boolean)) parent = await ensureFolder(p, parent);
  return parent;
}

// ---- アップロード ----
export async function uploadFile({ name, mimeType, buffer, parentId }) {
  const token = await getAccessToken();
  const boundary = "kp" + crypto.randomBytes(12).toString("hex");
  const meta = JSON.stringify({ name: sanitizeName(name), parents: [parentId] });
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

  const r = await fetch(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: Buffer.concat([head, buffer, tail]),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("drive_upload_failed: " + (data.error?.message || `HTTP ${r.status}`));
  return data; // { id, name, webViewLink }
}

// 同名があれば中身を差し替え、無ければ新規作成（月次CSVなどの再生成用）
export async function upsertTextFile({ name, mimeType = "text/csv", text, parentId }) {
  const token = await getAccessToken();
  const safe = sanitizeName(name);
  const existing = await findChild(safe, parentId, null);
  const body = Buffer.from(text, "utf8");

  if (existing) {
    const r = await fetch(`${UPLOAD}/files/${existing.id}?uploadType=media&supportsAllDrives=true&fields=id,name,webViewLink`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": mimeType },
      body,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("drive_update_failed: " + (data.error?.message || `HTTP ${r.status}`));
    return data;
  }
  return uploadFile({ name: safe, mimeType, buffer: body, parentId });
}

// ---- 削除（ゴミ箱へ移動） ----
// 完全削除ではなくゴミ箱に入れる。誤操作からの復元余地を残すため。
export async function trashFile(fileId) {
  if (!fileId) return { skipped: "no_file_id" };
  await driveFetch(`${API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,trashed`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
  return { trashed: true };
}

// ---- 保存先パスの組み立て（取引先 / YYYY-MM / 種別） ----
export function documentFolderParts({ clientName, period, docType }) {
  return [sanitizeName(clientName), period || "未分類", DOC_TYPE_FOLDER[docType] || "未判定"];
}
