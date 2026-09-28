// 会社の印鑑：形式・大きさの判定、権限、署名済みPDFへの押印を、本物のコードで通す
import { detectImage, checkSealImage, checkDeclared, SEAL_MAX_BYTES, SEAL_TYPE_KEYS } from "../lib/seal.js";
import { canManageSeals, canManageHr } from "../lib/gw.js";
import { renderContractPdf, appendSignaturePage, sha256 } from "../lib/pdf-jp.js";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";
import { png, jpeg, webp } from "./_img.mjs";

let bad = 0;
const ok = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

console.log("— 形式・大きさ —");
ok(detectImage(png()) === "png", "PNG を中身で見分ける");
ok(detectImage(jpeg()) === "jpeg", "JPEG を中身で見分ける");
ok(detectImage(webp()) === "webp", "WebP を中身で見分ける");
ok(detectImage(Buffer.from("GIF89a....")) === null, "GIF は知らない形式");
ok(checkSealImage(png()).ok && checkSealImage(png()).mime === "image/png", "PNG は保存できる");
ok(checkSealImage(jpeg()).ok && checkSealImage(jpeg()).mime === "image/jpeg", "JPEG は保存できる");
ok(checkSealImage(webp()).error === "webp_not_converted", "WebP のままは受け付けない（画面で PNG にする）");
ok(checkSealImage(Buffer.from("<svg></svg>")).error === "unsupported_image", "SVG など不正形式は拒否");
ok(checkSealImage(Buffer.from("%PDF-1.4 fake png")).error === "unsupported_image", "拡張子だけ png の PDF は拒否");
const big = Buffer.concat([png(), Buffer.alloc(SEAL_MAX_BYTES)]);
ok(checkSealImage(big).error === "file_too_large", "2MB 超は拒否");
ok(checkSealImage(Buffer.alloc(0)).error === "no_file", "空は拒否");
ok(checkDeclared({ mimeType: "image/png", sizeBytes: 1000 }).ext === "png", "申告 PNG");
ok(checkDeclared({ mimeType: "image/jpeg", sizeBytes: 1000 }).ext === "jpg", "申告 JPEG");
ok(checkDeclared({ mimeType: "image/gif", sizeBytes: 1000 }).error === "unsupported_image", "申告 GIF は拒否");
ok(checkDeclared({ mimeType: "image/png", sizeBytes: SEAL_MAX_BYTES + 1 }).error === "file_too_large", "申告 2MB 超は拒否");
ok(["representative", "square", "contract", "other"].every((k) => SEAL_TYPE_KEYS.includes(k)), "種類 4つ");

console.log("\n— 権限（lib/gw.js）—");
ok(canManageSeals({ isAdmin: true, roles: [] }), "admin は印鑑を管理できる");
ok(canManageSeals({ isAdmin: false, roles: ["owner"] }), "owner は印鑑を管理できる");
for (const r of ["hr", "recruiter", "sales", "manager", "member"]) {
  ok(!canManageSeals({ isAdmin: false, roles: [r] }), `${r} は印鑑を管理できない`);
}
ok(canManageHr({ isAdmin: false, isHr: true }) && !canManageSeals({ isAdmin: false, isHr: true, roles: ["hr"] }),
  "人事は署名依頼は出せるが、印鑑マスタは触れない");

console.log("\n— 署名済みPDFへの押印 —");
const base = await renderContractPdf({ title: "雇用契約書", body: "本文です。", docId: "doc-1" });
const h = sha256(base);
const sig = {
  signerName: "今福 太郎", signerEmail: "t@example.jp", employeeCode: "e1",
  signedAt: "2026年9月27日 10:00:00（日本時間）", docId: "doc-1", docHash: h,
  title: "雇用契約書", agreedText: "同意します", ip: "203.0.113.1", userAgent: "UA/1.0",
};
const imagesOf = async (bytes) => {
  const doc = await PDFDocument.load(bytes);
  const last = doc.getPages()[doc.getPageCount() - 1];
  const xo = last.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
  return xo ? xo.keys().length : 0;
};
const noSeal = await appendSignaturePage(base, sig);
ok(await imagesOf(noSeal) === 0, "印鑑なし：記録ページに画像は無い");

const withPng = await appendSignaturePage(base, { ...sig, seal: { name: "代表者印", bytes: png(60, 60, [200, 0, 0, 120]), mime: "image/png", sha256: "abc" } });
ok(await imagesOf(withPng) === 1, "代表者印（PNG・透過）が記録ページに描かれる");
const withJpg = await appendSignaturePage(base, { ...sig, seal: { name: "角印", bytes: jpeg(40, 40), mime: "image/jpeg" } });
ok(await imagesOf(withJpg) === 1, "角印（JPEG）が記録ページに描かれる");

// 印影を足しても、本文（署名前PDF）は変えない。ページが1枚増えるだけ
const pages = async (b) => (await PDFDocument.load(b)).getPageCount();
ok(await pages(withPng) === (await pages(base)) + 1, "足すのは記録の1ページだけ");
ok(await pages(withPng) === await pages(noSeal), "印鑑の有無でページ数は同じ");
ok(sha256(base) === h, "元のPDFは書き換えない（文書ハッシュの前提）");

// 印影があっても、記録の項目（署名者・日時・IP・UA・同意・ハッシュ）は残る。
// 文字は埋め込みフォントの字形番号になるので、ASCII の値（IP・UA・ハッシュの一部）を
// 記録ページの描画命令から直接探すことはできない。代わりに、印鑑なしのPDFより
// 大きいこと（＝項目を削って画像に置き換えていない）と、同じ関数で両方作れることを見る
ok(withPng.length > noSeal.length, "印影は記録に足されている（置き換えではない）");

console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
