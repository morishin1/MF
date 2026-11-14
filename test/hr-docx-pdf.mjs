// Word→PDF 変換（Google Drive 方式）の口。偽の fetch だけを使う。Google には一切つながない。
import assert from "node:assert/strict";
import { googleDriveConverter, converterFromEnv, isPdf } from "../lib/hr-docx-pdf.js";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(300, 0x20)]);
const FOLDER = "folder_ABCDEFGHIJ", FILE = "file_1234567890";
function fake({ upload = 200, exportStatus = 200, exportBody = PDF, del = 204, throwOn = null } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || "GET"; calls.push({ url: String(url), method, headers: init.headers || {}, body: init.body });
    const kind = method === "POST" ? "upload" : method === "DELETE" ? "delete" : "export";
    if (throwOn === kind) throw new Error("network");
    if (kind === "upload") return { ok: upload === 200, status: upload, json: async () => ({ id: FILE }) };
    if (kind === "export") return { ok: exportStatus === 200, status: exportStatus, arrayBuffer: async () => exportBody.buffer.slice(exportBody.byteOffset, exportBody.byteOffset + exportBody.length) };
    return { ok: del === 204, status: del };
  };
  return { fetch, calls };
}
const make = (f) => googleDriveConverter({ getAccessToken: async () => "token-xyz", folderId: FOLDER, fetch: f.fetch });
const docx = Buffer.from("PK synthetic docx bytes");

// 正常：置く → 書き出す → 消す、の順。共有設定は足さない
{
  const f = fake(); const r = await make(f).convert(docx, { name: "issue-架空 太郎-42" });
  assert.ok(r.pdf.equals(PDF)); assert.equal(r.engine, "google-drive");
  assert.deepEqual(f.calls.map((c) => c.method), ["POST", "GET", "DELETE"]);
  assert.ok(f.calls.every((c) => c.headers.Authorization === "Bearer token-xyz"));
  assert.ok(f.calls.every((c) => c.url.startsWith("https://www.googleapis.com/")), "Google 以外へ送らない");
  assert.ok(!f.calls.some((c) => /permissions/.test(c.url)), "共有設定を足さない");
  assert.match(f.calls[0].url, /uploadType=multipart/); assert.match(f.calls[1].url, new RegExp(`/files/${FILE}/export\\?mimeType=application%2Fpdf`));
  assert.match(f.calls[2].url, new RegExp(`/files/${FILE}\\?`));
  const sent = f.calls[0].body.toString("utf8");
  assert.ok(sent.includes(`"parents":["${FOLDER}"]`), "専用フォルダに置く");
  assert.ok(sent.includes('"mimeType":"application/vnd.google-apps.document"'));
  assert.ok(!sent.includes("架空") && sent.includes('"name":"issue--42"'), "一時ファイル名に氏名を入れない");
  assert.ok(f.calls[0].body.includes(docx));
}
// 書き出しに失敗しても、一時ファイルは消す
for (const opt of [{ exportStatus: 500 }, { exportBody: Buffer.from("<html>not a pdf</html>".padEnd(200)) }, { throwOn: "export" }]) {
  const f = fake(opt);
  await assert.rejects(() => make(f).convert(docx), /converter_export_failed|converter_not_pdf|converter_unreachable/);
  assert.equal(f.calls.at(-1).method, "DELETE", "失敗しても消す");
}
// 消せなかったら、PDF ができていても失敗にする
for (const opt of [{ del: 500 }, { throwOn: "delete" }]) {
  await assert.rejects(() => make(fake(opt)).convert(docx), /converter_cleanup_failed/);
}
{ const f = fake({ del: 404 }); assert.ok((await make(f).convert(docx)).pdf.equals(PDF), "すでに無ければ、消えたものとして扱う"); }
// 置けなかったら、書き出しも削除も呼ばない
{ const f = fake({ upload: 403 }); await assert.rejects(() => make(f).convert(docx), /converter_upload_failed/); assert.equal(f.calls.length, 1); }
// 設定が無ければ動かさない（マイドライブ直下に置かない・別の方法へ勝手に切り替えない）
assert.throws(() => googleDriveConverter({ getAccessToken: async () => "t" }), /converter_not_configured/);
assert.throws(() => googleDriveConverter({ folderId: FOLDER }), /converter_not_configured/);
await assert.rejects(() => googleDriveConverter({ getAccessToken: async () => "", folderId: FOLDER, fetch: fake().fetch }).convert(docx), /converter_not_configured/);
await assert.rejects(() => make(fake()).convert(Buffer.alloc(0)), /docx_invalid/);
assert.equal(converterFromEnv({}, {}), null);
assert.equal(converterFromEnv({ HR_DOCX_PDF_ENGINE: "google-drive" }, { getAccessToken: async () => "t" }), null, "フォルダ未設定なら使わない");
assert.equal(converterFromEnv({ HR_DOCX_PDF_ENGINE: "other", HR_DOCX_PDF_DRIVE_FOLDER: FOLDER }, { getAccessToken: async () => "t" }), null);
assert.equal(converterFromEnv({ HR_DOCX_PDF_ENGINE: "google-drive", HR_DOCX_PDF_DRIVE_FOLDER: FOLDER }, { getAccessToken: async () => "t" }).engine, "google-drive");
assert.equal(isPdf(PDF), true); assert.equal(isPdf(Buffer.from("%PDF-")), false); assert.equal(isPdf("x"), false);
console.log("PASS DOCX to PDF converter (Google Drive, mocked): upload to dedicated folder, export, always delete, no sharing, no personal name in temp file, fail closed");
