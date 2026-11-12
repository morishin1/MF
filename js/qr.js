// 二段階認証（TOTP）の QR コードを、ブラウザの中だけで作る。
//
// ■ なぜここで作るのか
//   Supabase Auth（GoTrue）の登録の応答（qr_code）は、`<?xml…><svg…>` の生の SVG 文字列。
//   公式クライアント（@supabase/auth-js）は、その先頭に `data:image/svg+xml;utf-8,` を付け足してから返す。
//   このアプリは REST を直接呼ぶので付かず、`<img src="<?xml…">` になって画像欠落アイコンになっていた。
//   （data URL に直すこともできるが、GoTrue の出力の形に頼る。ここでは URI から自分で作って、形に依存しない）
//
// ■ 守ること
//   ・QR は、この端末の中だけで作る。**外部の QR 生成サービス（Google Chart API など）へ、秘密の情報を送らない**
//   ・画面には、`<img>` ではなく**インライン SVG** で出す（外部の画像や data: の画像が CSP で止まっても影響しない）
//   ・URI・秘密の情報を、ログに出さない・エラーメッセージに入れない（ここが投げる例外は、固定の短い文字列だけ）
//   ・日本語や記号を含む URI（issuer・アカウント名）でも壊れないよう、UTF-8 で符号化する
//     （同梱の qrcode-generator の既定は ISO-8859-1 で、日本語を壊す）
//
// 使い方:  const svg = KPQr.svg(uri, { label: "二段階認証のQRコード" });   // 作れなければ例外
//         KPQr.otpauthSecret(uri) === secret                              // QR の中身と手入力キーが同じか
//
// 読み込み順: js/vendor/qrcode-generator.js → js/qr.js
(function (root) {
  "use strict";

  const lib = () => {
    const q = root.qrcode;
    if (typeof q !== "function") throw new Error("qr_lib_missing");
    // 既定は ISO-8859-1（日本語が壊れる）。UTF-8 に固定する
    q.stringToBytes = q.stringToBytesFuncs["UTF-8"];
    return q;
  };

  /** 誤り訂正レベル M（約15%）。otpauth の URI（100〜200 文字）なら、読み取りやすい大きさに収まる */
  const ECC = "M";
  /** 周りの余白（モジュール数）。QR の規格は 4 */
  const QUIET = 4;

  /** @returns {{size:number, dark:(r:number,c:number)=>boolean}} */
  function matrix(text, ecc = ECC) {
    if (typeof text !== "string" || !text) throw new Error("qr_empty");
    const q = lib()(0, ecc);          // 0 = 大きさは自動
    q.addData(text, "Byte");
    q.make();
    return { size: q.getModuleCount(), dark: (r, c) => q.isDark(r, c) };
  }

  const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  /**
   * QR の SVG（文字列）。横に並んだ黒いマスを1本の path にまとめる。数字だけで組み立てるので、外から来た文字は入らない
   * （label は、呼ぶ側が決めた固定の文字）。大きさは CSS で決める（viewBox だけ持つ）
   */
  function svg(text, { label = "QRコード", ecc = ECC, margin = QUIET } = {}) {
    const m = matrix(text, ecc);
    const total = m.size + margin * 2;
    let d = "";
    for (let r = 0; r < m.size; r++) {
      let c = 0;
      while (c < m.size) {
        if (!m.dark(r, c)) { c++; continue; }
        const start = c;
        while (c < m.size && m.dark(r, c)) c++;
        d += `M${start + margin} ${r + margin}h${c - start}v1h-${c - start}z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" role="img" aria-label="${escAttr(label)}" `
      + `shape-rendering="crispEdges" style="display:block;width:100%;height:auto">`
      + `<rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  /**
   * otpauth://totp/… の URI から、secret を取り出す。形が違えば null。
   * QR の中身と、画面に出す手入力キーが同じであることの確認に使う（食い違うと、QR で登録しても 6 桁が合わない）
   */
  function otpauthSecret(uri) {
    if (typeof uri !== "string" || !/^otpauth:\/\/totp\//i.test(uri)) return null;
    const q = uri.indexOf("?");
    if (q < 0) return null;
    const s = new URLSearchParams(uri.slice(q + 1)).get("secret");
    return s ? s.replace(/\s+/g, "").toUpperCase() : null;
  }

  root.KPQr = { svg, matrix, otpauthSecret };
})(typeof window !== "undefined" ? window : globalThis);
