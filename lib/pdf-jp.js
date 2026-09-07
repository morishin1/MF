// 日本語のPDFを作る。
//
// ■ なぜフォントを同梱しているのか
//   PDFの標準14フォントは日本語を持っていない。サーバ側で日本語を描くには、
//   フォントの実体を読み込んで埋め込むしかない。
//   同梱したのは IPA Pゴシック（assets/fonts/ipagp.ttf）。
//   IPAフォントライセンス v1.0 で、そのままの再頒布とPDFへの埋め込みが
//   認められている。詳細は assets/fonts/README.md に書いた。
//
//   出来上がるPDFには、使った文字ぶんだけを切り出して埋め込む（subset）。
//   6MBのフォントを持っていても、PDF自体は数十KBで済む。
//
// ■ 契約書に凝ったレイアウトを入れない
//   表組みも段組みも使わず、見出しと本文だけで組む。
//   凝るほど、あとで「PDFと画面で文字送りが違う」が起きる。
//   ここで作るのは、あとから読み返して内容が同じだと分かる紙であって、
//   デザインされた印刷物ではない。
//
// ■ 署名の記録は最後のページに、必ず別ページで足す
//   本文の途中に混ぜると、本文が1行増えるだけで位置が変わる。
//   別ページなら、本文のバイト列（＝ハッシュ）と署名の記録を
//   はっきり分けて扱える。

import fs from "node:fs";
import crypto from "node:crypto";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

// A4（ポイント）。1pt = 1/72 inch
const PAGE = { w: 595.28, h: 841.89 };
const MARGIN = { top: 64, bottom: 64, left: 56, right: 56 };

const SIZE = { title: 15, h2: 12, body: 10.5, small: 8.5 };
const LINE = 1.75;            // 行送り（フォントサイズに対する倍率）

const INK = rgb(0.09, 0.11, 0.14);
const MUTED = rgb(0.42, 0.47, 0.53);
const RULE = rgb(0.80, 0.84, 0.88);

// フォントは1回読んで使い回す。1リクエストで2回読む必要はない
let fontBytes = null;
function loadFont() {
  if (!fontBytes) {
    // new URL(..., import.meta.url) にしているのは、Vercel が
    // 同梱するファイルを静的に見つけられるようにするため
    fontBytes = fs.readFileSync(new URL("../assets/fonts/ipagp.ttf", import.meta.url));
  }
  return fontBytes;
}

export const sha256 = (bytes) =>
  crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");

/** 見せるときのハッシュ。64桁は読み合わせに向かないので、頭だけ4桁ずつ区切る */
export const shortHash = (hex) =>
  String(hex || "").slice(0, 16).replace(/(.{4})(?=.)/g, "$1 ").toUpperCase();

// ---- 文字を折り返す -----------------------------------------------------------
//
// 日本語には単語の区切りが無いので、空白では折れない。
// 1文字ずつ幅を測って、入らなくなったら折る。
// 行頭に来てはいけない文字（。、）」など）は、前の行に持っていく。
const NO_LINE_START = "。、）」』】〕〉》’”ぁぃぅぇぉっゃゅょゎヵヶァィゥェォッャュョヮ・ー！？：；,.)]}";
const NO_LINE_END = "（「『【〔〈《‘“([{";

function wrap(text, font, size, maxWidth) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const ch of para) {
      const next = line + ch;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) { line = next; continue; }

      // 入らない。折る位置を決める
      if (NO_LINE_START.includes(ch) && line) {
        // ぶら下げる。1文字ぶんは枠からはみ出すが、行頭に句点が来るよりよい
        out.push(line + ch);
        line = "";
        continue;
      }
      if (line && NO_LINE_END.includes(line[line.length - 1])) {
        // 開き括弧が行末に残らないよう、1文字ぶん次の行へ送る
        out.push(line.slice(0, -1));
        line = line[line.length - 1] + ch;
        continue;
      }
      out.push(line);
      line = ch;
    }
    out.push(line);
  }
  return out;
}

// ---- 組み版 -------------------------------------------------------------------
class Sheet {
  constructor(doc, font) {
    this.doc = doc;
    this.font = font;
    this.page = null;
    this.y = 0;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage([PAGE.w, PAGE.h]);
    this.y = PAGE.h - MARGIN.top;
  }

  get width() { return PAGE.w - MARGIN.left - MARGIN.right; }

  /** 残りが足りなければ改ページする */
  need(h) {
    if (this.y - h < MARGIN.bottom) this.newPage();
  }

  text(str, { size = SIZE.body, color = INK, gap = 0, align = "left", indent = 0 } = {}) {
    const w = this.width - indent;
    for (const line of wrap(str, this.font, size, w)) {
      const h = size * LINE;
      this.need(h);
      if (line) {
        const lw = this.font.widthOfTextAtSize(line, size);
        const x = align === "center" ? MARGIN.left + (this.width - lw) / 2
          : align === "right" ? PAGE.w - MARGIN.right - lw
            : MARGIN.left + indent;
        this.page.drawText(line, { x, y: this.y - size, size, font: this.font, color });
      }
      this.y -= h;
    }
    this.y -= gap;
  }

  rule(gap = 10) {
    this.need(gap * 2);
    this.y -= gap;
    this.page.drawLine({
      start: { x: MARGIN.left, y: this.y },
      end: { x: PAGE.w - MARGIN.right, y: this.y },
      thickness: 0.6, color: RULE,
    });
    this.y -= gap;
  }

  /** 「項目：値」の並び。項目の幅をそろえる */
  rows(pairs, { labelWidth = 96, size = SIZE.body } = {}) {
    for (const [k, v] of pairs) {
      if (v === null || v === undefined || v === "") continue;
      const lines = wrap(String(v), this.font, size, this.width - labelWidth);
      this.need(size * LINE * lines.length);
      this.page.drawText(String(k), {
        x: MARGIN.left, y: this.y - size, size, font: this.font, color: MUTED,
      });
      for (const line of lines) {
        this.need(size * LINE);
        this.page.drawText(line, {
          x: MARGIN.left + labelWidth, y: this.y - size, size, font: this.font, color: INK,
        });
        this.y -= size * LINE;
      }
    }
  }
}

/** ページ番号を、全ページの下に入れる */
function paginate(doc, font) {
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const label = `${i + 1} / ${pages.length}`;
    const w = font.widthOfTextAtSize(label, SIZE.small);
    p.drawText(label, {
      x: (PAGE.w - w) / 2, y: MARGIN.bottom - 26,
      size: SIZE.small, font, color: MUTED,
    });
  });
}

async function newDoc() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(loadFont(), { subset: true });
  return { doc, font };
}

/**
 * 契約書のPDF（署名前）。
 *
 * @param {{title:string, body:string, docId:string, company?:string,
 *          issuedOn?:string, employeeName?:string, version?:number}} p
 * @returns {Promise<Uint8Array>}
 */
export async function renderContractPdf(p) {
  const { doc, font } = await newDoc();
  doc.setTitle(p.title || "契約書");
  doc.setProducer("mf.8grp.co.jp");
  doc.setCreationDate(new Date());

  const s = new Sheet(doc, font);
  s.text(p.title || "契約書", { size: SIZE.title, align: "center", gap: 6 });
  if (p.company) s.text(p.company, { size: SIZE.small, align: "center", color: MUTED });
  s.rule(12);

  s.rows([
    ["交付日", p.issuedOn || null],
    ["宛先", p.employeeName || null],
    ["文書ID", p.docId || null],
    ["版", p.version ? `第${p.version}版` : null],
  ], { size: SIZE.small, labelWidth: 60 });

  s.y -= 14;
  s.text(p.body || "", { gap: 4 });

  paginate(doc, font);
  return doc.save();
}

/**
 * 署名済みPDF。署名前のPDFの最後に「電子署名記録」のページを足す。
 *
 * 本文には一切手を入れない。足すのは1ページだけ。
 * こうしておくと、署名前のハッシュと署名済みのハッシュが両方成り立ち、
 * 「この署名は、このハッシュの文書に対するものだ」と後から突き合わせられる。
 *
 * @param {Uint8Array|Buffer} basePdf 署名前のPDF
 * @param {{signerName:string, signerEmail?:string, employeeCode?:string,
 *          signedAt:string, docId:string, docHash:string, title?:string,
 *          agreedText?:string, ip?:string, userAgent?:string}} sig
 * @returns {Promise<Uint8Array>}
 */
export async function appendSignaturePage(basePdf, sig) {
  const doc = await PDFDocument.load(basePdf);
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(loadFont(), { subset: true });

  const page = doc.addPage([PAGE.w, PAGE.h]);
  const s = new Sheet(doc, font);
  // Sheet は自分でページを足してしまうので、いま足したページに差し替える
  doc.removePage(doc.getPageCount() - 1);
  s.page = page;
  s.y = PAGE.h - MARGIN.top;

  s.text("電子署名記録", { size: SIZE.title, align: "center", gap: 4 });
  s.text("この記録は、上記の文書に対して行われた電子署名の内容です。",
    { size: SIZE.small, align: "center", color: MUTED });
  s.rule(14);

  s.rows([
    ["署名者", sig.signerName || ""],
    ["署名日時", sig.signedAt || ""],
    ["文書ID", sig.docId || ""],
    ["文書ハッシュ", sig.docHash || ""],
  ], { labelWidth: 96 });

  s.y -= 16;
  s.text("記録の内訳", { size: SIZE.h2, gap: 6 });
  s.rows([
    ["文書名", sig.title || ""],
    ["メールアドレス", sig.signerEmail || ""],
    ["社員ID", sig.employeeCode || ""],
    ["IPアドレス", sig.ip || ""],
    ["利用環境", sig.userAgent || ""],
    ["同意した文言", sig.agreedText || ""],
    ["ハッシュ方式", "SHA-256"],
  ], { size: SIZE.small, labelWidth: 96 });

  s.y -= 18;
  s.rule(8);
  s.text(
    "文書ハッシュは、この記録のページを足す前のPDFから計算しています。"
    + "同じPDFから計算した値が一致すれば、署名した時点から中身が変わっていないことを確認できます。"
    + "署名はこのシステム（mf.8grp.co.jp）の記録によるもので、電子署名法上の認定認証業務によるものではありません。",
    { size: SIZE.small, color: MUTED });

  paginate(doc, font);
  return doc.save();
}
