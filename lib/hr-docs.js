// 採用の応募書類（db/093_hr_documents.sql）の、形式・大きさ・並べ方。
//
// ■ 中身で見る
//   拡張子も Content-Type も名乗るだけなので、先頭のバイト列で形式を決める。
//   PDF・Word（.doc / .docx）・JPEG・PNG だけを受け付ける。
//
// ■ 呼び方をそろえる
//   「経歴書」ではなく「職務経歴書」。画面・API・一覧で同じ言葉を使う。

export const DOC_TYPES = [
  { key: "resume",       label: "履歴書",     icon: "description" },
  { key: "work_history", label: "職務経歴書", icon: "work_history" },
  { key: "other",        label: "その他",     icon: "attach_file" },
];
export const DOC_TYPE_KEYS = DOC_TYPES.map((t) => t.key);
export const docTypeLabel = (k) => DOC_TYPES.find((t) => t.key === k)?.label || "その他";

/** 1ファイルの上限。履歴書・職務経歴書は数MBあれば足りる */
export const DOC_MAX_BYTES = 10 * 1024 * 1024;

export const DOC_FORMATS = {
  pdf:  { mime: "application/pdf", ext: "pdf" },
  doc:  { mime: "application/msword", ext: "doc" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  png:  { mime: "image/png", ext: "png" },
};
export const DOC_ACCEPT = ".pdf,.doc,.docx,.jpg,.jpeg,.png";
const DECLARED = new Set(Object.values(DOC_FORMATS).map((f) => f.mime));

/**
 * 先頭のバイト列から形式を決める。
 * docx は zip（PK）の中に word/ があるかで見る（xlsx・pptx などを通さない）
 * @returns {"pdf"|"doc"|"docx"|"jpeg"|"png"|null}
 */
export function detectDoc(bytes) {
  const b = Buffer.from(bytes || []);
  if (b.length >= 5 && b.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return "doc";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    return b.includes(Buffer.from("word/", "latin1")) ? "docx" : null;
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  return null;
}

const BAD_TYPE = { ok: false, error: "unsupported_file", hint: "PDF・Word（.doc / .docx）・JPEG・PNG を選んでください" };
const TOO_BIG = { ok: false, error: "file_too_large", hint: "ファイルは10MBまでにしてください" };

/** アップロード前の申告（置き場所を出す前に弾く） */
export function checkDeclaredDoc({ mimeType, sizeBytes }) {
  if (!DECLARED.has(String(mimeType || ""))) return BAD_TYPE;
  if (!(Number(sizeBytes) > 0)) return { ok: false, error: "no_file", hint: "ファイルを選んでください" };
  if (Number(sizeBytes) > DOC_MAX_BYTES) return TOO_BIG;
  const fmt = Object.values(DOC_FORMATS).find((f) => f.mime === mimeType);
  return { ok: true, ext: fmt.ext };
}

/** 置かれた実体の確認 */
export function checkDocBytes(bytes) {
  const size = bytes?.length || 0;
  if (!size) return { ok: false, error: "no_file", hint: "ファイルを選んでください" };
  if (size > DOC_MAX_BYTES) return TOO_BIG;
  const fmt = detectDoc(bytes);
  if (!fmt) return BAD_TYPE;
  return { ok: true, format: fmt, mime: DOC_FORMATS[fmt].mime };
}

/** ファイル名を安全な長さ・文字に（表示とダウンロード名に使う） */
export const cleanFilename = (s) =>
  String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 160) || "document";

/**
 * 行を「種類ごとの最新＋過去の版」にまとめる（削除済みは除く）。
 * @param {object[]} rows gw_hr_documents（新しい順でなくてもよい）
 */
export function groupDocs(rows) {
  const live = (rows || []).filter((r) => !r.deleted_at)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const byType = {};
  for (const t of DOC_TYPE_KEYS) {
    const list = live.filter((r) => r.doc_type === t);
    byType[t] = { latest: list[0] || null, history: list.slice(1) };
  }
  return byType;
}

/**
 * 一覧に出す、書類のそろい具合と、最新版の書類ID（一覧のアイコンから直接プレビューを開くため）。
 * 削除済みは除き、同じ種類が複数あれば最新版だけ。表示用の URL（署名付き）はここでは作らない
 * （hr/document.html が開いたときに、権限を確かめてから短時間の URL を取りにいく）。
 */
export const docStatusOf = (rows) => {
  const g = groupDocs(rows);
  return {
    resume: Boolean(g.resume.latest), resumeId: g.resume.latest?.id || null,
    workHistory: Boolean(g.work_history.latest), workHistoryId: g.work_history.latest?.id || null,
  };
};
