// Word（.docx）→ PDF の変換。変換の方式は差し替えられる（convert の口は1つ）。
//
// ■ 第一候補：Google Drive API（Google Workspace）
//   1. docx を「Google ドキュメントに変換して」専用フォルダ（共有ドライブ）へ置く
//   2. その Google ドキュメントを PDF として書き出す
//   3. 置いたファイルを、成功しても失敗しても必ず消す（ごみ箱に残さない files.delete）
//   共有設定（permissions）は一切足さない。フォルダを見られるのは、変換用のサービスアカウントだけにしておく。
//
// ■ 注意（未検証）
//   Google ドキュメントへの変換は、Word と完全に同じ組版にはならないことがある（改ページ・表の幅・日本語フォント）。
//   実際の雛形で Word と PDF を見比べるまでは、この方式を「確定」にしない。
//   だめな場合に備えて、同じ口（convert）で別の方式（例：LibreOffice を動かす自社の変換サービス）に替えられるようにしてある。
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const GDOC = "application/vnd.google-apps.document";
export const MAX_PDF_BYTES = 5 * 1024 * 1024;

const fail = (code, detail) => { const e = new Error(code); e.code = code; if (detail) e.detail = detail; return e; };
export const isPdf = (buf) => Buffer.isBuffer(buf) && buf.length > 100 && buf.subarray(0, 5).toString("latin1") === "%PDF-" && buf.length <= MAX_PDF_BYTES;

/**
 * Google Drive で変換する変換器を作る。
 * @param {{getAccessToken: () => Promise<string>, folderId: string, fetch?: typeof fetch, timeoutMs?: number}} opts
 *   folderId: 変換用の一時置き場（必須）。指定が無ければ動かさない（マイドライブの直下に置かない）
 */
export function googleDriveConverter({ getAccessToken, folderId, fetch: fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
  if (typeof getAccessToken !== "function" || !/^[A-Za-z0-9_-]{10,}$/.test(String(folderId || ""))) throw fail("converter_not_configured");
  const call = async (url, init = {}) => {
    const token = await getAccessToken();
    if (!token) throw fail("converter_not_configured");
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
    try { return await fetchImpl(url, { ...init, signal: ctl.signal, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } }); }
    catch { throw fail("converter_unreachable"); }
    finally { clearTimeout(timer); }
  };
  return {
    engine: "google-drive",
    /** @param {Buffer} docx @param {{name?: string}} [o] 名前には個人名を入れない（呼び出し側は発行IDなどを渡す） */
    async convert(docx, { name = "hr-doc" } = {}) {
      if (!Buffer.isBuffer(docx) || !docx.length) throw fail("docx_invalid");
      const safeName = String(name).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "hr-doc";
      const boundary = "hrdoc" + Math.random().toString(36).slice(2);
      const meta = JSON.stringify({ name: safeName, mimeType: GDOC, parents: [folderId] });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${DOCX}\r\n\r\n`),
        docx, Buffer.from(`\r\n--${boundary}--`),
      ]);
      const up = await call(`${UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id`, {
        method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
      if (!up.ok) throw fail("converter_upload_failed", up.status);
      const fileId = (await up.json())?.id;
      if (!/^[A-Za-z0-9_-]{10,}$/.test(String(fileId || ""))) throw fail("converter_upload_failed");
      let pdf = null, error = null;
      try {
        const ex = await call(`${DRIVE}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent("application/pdf")}`);
        if (!ex.ok) throw fail("converter_export_failed", ex.status);
        pdf = Buffer.from(await ex.arrayBuffer());
        if (!isPdf(pdf)) throw fail("converter_not_pdf");
      } catch (e) { error = e; }
      // 一時ファイルは必ず消す。消せなかったら、PDF ができていても「失敗」にする（個人情報を外に残したまま進めない）
      let removed = false;
      try { const del = await call(`${DRIVE}/${encodeURIComponent(fileId)}?supportsAllDrives=true`, { method: "DELETE" }); removed = del.ok || del.status === 404; }
      catch { removed = false; }
      if (!removed) throw fail("converter_cleanup_failed", fileId);
      if (error) throw error;
      return { pdf, engine: "google-drive" };
    },
  };
}

/** 環境に合わせて変換器を選ぶ。設定が無ければ null（呼び出し側は「PDF変換は未設定」と伝え、推測で別の方法に切り替えない） */
export function converterFromEnv(env, deps = {}) {
  if (env?.HR_DOCX_PDF_ENGINE !== "google-drive") return null;
  if (typeof deps.getAccessToken !== "function" || !env.HR_DOCX_PDF_DRIVE_FOLDER) return null;
  return googleDriveConverter({ getAccessToken: deps.getAccessToken, folderId: env.HR_DOCX_PDF_DRIVE_FOLDER, fetch: deps.fetch });
}
