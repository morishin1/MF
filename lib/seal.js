// 会社の印鑑（印影画像）。
//
// ■ 印影は「視覚的な押印」であって、電子署名の証跡ではない
//   署名の正式な記録は、これまでどおり
//     ログイン中のアカウント・署名者名・署名日時・IP・User-Agent・
//     同意した文言・署名前PDFの SHA-256
//   の組み合わせ（api/sign/me.js・lib/pdf-jp.js）。
//   印影は、その「電子署名記録」ページに会社印として描き足すだけ。
//   印影が無くても、差し替えられても、署名の記録の意味は変わらない。
//
// ■ 形式は PNG と JPEG だけを受け付ける（サーバ側）
//   PDF に埋め込めるのが PNG と JPEG だけだから（pdf-lib）。
//   WebP は画面側（admin-esign.html）でブラウザに PNG へ描き直させてから
//   送る。透過はそのまま残る。サーバには変換の道具を置かない。
//
// ■ 中身で見る
//   拡張子も Content-Type も名乗るだけなので、先頭のバイト列で形式を決める。

import { gwLog } from "./gw-audit.js";

export const SEAL_TYPES = [
  { key: "representative", label: "代表者印" },
  { key: "square",         label: "角印" },
  { key: "contract",       label: "契約用印" },
  { key: "other",          label: "その他" },
];
export const SEAL_TYPE_KEYS = SEAL_TYPES.map((t) => t.key);
export const sealTypeLabel = (k) => SEAL_TYPES.find((t) => t.key === k)?.label || "その他";

/** 1枚の上限。印影は小さい画像で足りる。大きいとPDFが重くなる */
export const SEAL_MAX_BYTES = 2 * 1024 * 1024;

/** 画面側が受け付ける形式（WebP はブラウザで PNG にしてから送る） */
export const SEAL_ACCEPT = ["image/png", "image/jpeg", "image/webp"];

/**
 * 先頭のバイト列から形式を決める。
 * @param {Uint8Array|Buffer} bytes
 * @returns {"png"|"jpeg"|"webp"|null}
 */
export function detectImage(bytes) {
  const b = Buffer.from(bytes || []);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF"
      && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export const MIME_OF = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * 保存してよい印影画像か。
 * @returns {{ok:true, format:"png"|"jpeg", mime:string} | {ok:false, error:string, hint:string}}
 */
export function checkSealImage(bytes) {
  const size = bytes?.length || 0;
  if (!size) return { ok: false, error: "no_file", hint: "画像を選んでください" };
  if (size > SEAL_MAX_BYTES) {
    return { ok: false, error: "file_too_large", hint: "画像は2MBまでにしてください" };
  }
  const format = detectImage(bytes);
  if (format === "webp") {
    // 画面からなら PNG になって届く。ここへ WebP のまま来るのは、画面を通っていないとき
    return { ok: false, error: "webp_not_converted",
             hint: "WebP は画面から登録してください（自動で PNG に変換します）" };
  }
  if (format !== "png" && format !== "jpeg") {
    return { ok: false, error: "unsupported_image", hint: "PNG・JPEG・WebP の画像を選んでください" };
  }
  return { ok: true, format, mime: MIME_OF[format] };
}

/** 申告された形式（アップロード前）の確認。中身の確認は保存時に checkSealImage で行う */
export function checkDeclared({ mimeType, sizeBytes }) {
  const mime = String(mimeType || "");
  // WebP は画面で PNG にしてから送るので、アップロードされるのは PNG か JPEG
  if (!["image/png", "image/jpeg"].includes(mime)) {
    return { ok: false, error: "unsupported_image", hint: "PNG・JPEG・WebP の画像を選んでください" };
  }
  if (Number(sizeBytes) > SEAL_MAX_BYTES) {
    return { ok: false, error: "file_too_large", hint: "画像は2MBまでにしてください" };
  }
  return { ok: true, ext: mime === "image/png" ? "png" : "jpg" };
}

/**
 * 印鑑の操作ログ。画像そのものや署名付きURLは入れない（id・名前・種類だけ）。
 * @param {object} ctx gwContext
 * @param {string} actorId
 * @param {"seal.create"|"seal.update"|"seal.disable"|"seal.enable"|"esign.seal_selected"} action
 * @param {{id:string, name:string, seal_type?:string}} seal
 * @param {object} [extra] 追加の手がかり（署名依頼の id など）
 */
export function sealLog(ctx, actorId, action, seal, extra = {}) {
  return gwLog({
    tenantId: ctx.tenantId, actorId, action,
    target: extra.requestId ? `sign_request:${extra.requestId}` : `seal:${seal.id}`,
    detail: {
      sealId: seal.id, sealName: seal.name, sealType: seal.seal_type || null,
      actorName: ctx.employee?.display_name || null,
      ...extra,
    },
  });
}
