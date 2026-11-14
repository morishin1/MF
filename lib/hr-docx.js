// Word（.docx）の雛形に、値を差し込む。純粋な関数だけ（保存・送信・DBは触らない）。
//
// ■ 何を守るか
//   契約書の条項・文章・表・書式は、雛形のまま 1 バイトも変えない。変えるのは {{項目名}} と書かれた場所の文字だけ。
//   雛形に無い文言を足さない。値が無い項目を推測で埋めない（埋まらなければ、作らずに「足りない項目」を返す）。
//
// ■ なぜ自前で zip を読むのか
//   .docx は zip。依存を増やさず、Node の zlib だけで読み書きする（本文 word/document.xml などの XML だけを書き換え、
//   画像・スタイル・番号付けなど、ほかの部品は受け取ったバイト列をそのまま書き戻す）。
import zlib from "node:zlib";
import crypto from "node:crypto";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const MAX_DOCX_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 2000, MAX_UNPACKED = 60 * 1024 * 1024;
const PLACEHOLDER = /\{\{([^{}<>&]{1,40})\}\}/g;

export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

const fail = (code) => { const e = new Error(code); e.code = code; return e; };

/** zip を読む。[{name, data(Buffer), method, raw…}]。壊れた・大きすぎる・暗号化された zip は読まない */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.length > MAX_DOCX_BYTES) throw fail("docx_invalid");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw fail("docx_invalid");
  const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES || cdOffset + cdSize > buf.length) throw fail("docx_invalid");
  const entries = []; let at = cdOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw fail("docx_invalid");
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10), crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20), usize = buf.readUInt32LE(at + 24);
    const nlen = buf.readUInt16LE(at + 28), elen = buf.readUInt16LE(at + 30), clen = buf.readUInt16LE(at + 32);
    const lho = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nlen).toString("utf8");
    at += 46 + nlen + elen + clen;
    if (flags & 0x1) throw fail("docx_encrypted");
    if (name.includes("..") || name.startsWith("/") || name.includes("\\")) throw fail("docx_invalid");
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw fail("docx_invalid");
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw fail("docx_invalid");
    const packed = buf.subarray(start, start + csize);
    total += usize; if (total > MAX_UNPACKED) throw fail("docx_too_large");
    let data;
    if (method === 0) data = Buffer.from(packed);
    else if (method === 8) { try { data = zlib.inflateRawSync(packed, { maxOutputLength: MAX_UNPACKED }); } catch { throw fail("docx_invalid"); } }
    else throw fail("docx_invalid");
    if (data.length !== usize || crc32(data) !== crc) throw fail("docx_invalid");
    entries.push({ name, data, method });
  }
  return entries;
}

/** zip を書く。並び順・名前は受け取ったまま。日時は固定（同じ入力なら、同じバイト列になる） */
export function writeZip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8"), data = e.data;
    const stored = e.method === 0;
    const packed = stored ? data : zlib.deflateRawSync(data, { level: 9 });
    const method = stored ? 0 : 8, crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(method, 8);
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12);   // 1980-01-01 固定
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(packed.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x21, 14); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(head, name, packed); central.push(cd, name);
    offset += 30 + name.length + packed.length;
  }
  const cdBuf = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

// 差し込みの対象にする部品（本文・ヘッダー・フッター・脚注）。ほかは触らない
const isTextPart = (name) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name);
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const xmlUnesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * 1つの段落（<w:p>…</w:p>）の中の文字（<w:t>）を、順に並べて読む。
 * Word は 1 つの語を複数の <w:t> に分けて保存することがある（{{氏 / 名}} のように）。段落の中でつなげて探す。
 */
function paragraphTexts(xml) {
  const nodes = []; const re = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g; let m;
  while ((m = re.exec(xml))) nodes.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] || "", text: xmlUnesc(m[2]) });
  return nodes;
}
function eachParagraph(xml, fn) {
  // <w:p> は入れ子にならない（表の中の段落も、それぞれ独立した <w:p>）。<w:pPr> などと取り違えないよう、直後の文字を見る
  return xml.replace(/<w:p(?=[\s>])[^>]*>[\s\S]*?<\/w:p>/g, (p) => fn(p));
}

/** 雛形に書かれている {{項目名}} を、出てくる順に重複なく返す */
export function listPlaceholders(docx) {
  const seen = new Set(), out = [];
  for (const e of readZip(docx)) {
    if (!isTextPart(e.name)) continue;
    eachParagraph(e.data.toString("utf8"), (p) => {
      const joined = paragraphTexts(p).map((n) => n.text).join("");
      for (const m of joined.matchAll(PLACEHOLDER)) { const k = m[1].trim(); if (!seen.has(k)) { seen.add(k); out.push(k); } }
      return p;
    });
  }
  return out;
}

/** Word の雛形として受け付けられるか（本文があり、マクロ・外部への埋め込みが無い） */
export function inspectTemplate(docx) {
  const entries = readZip(docx);
  const names = new Set(entries.map((e) => e.name));
  if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) throw fail("docx_not_word");
  if ([...names].some((n) => /vbaProject|\.bin$|^word\/embeddings\//i.test(n))) throw fail("docx_macro");
  const types = entries.find((e) => e.name === "[Content_Types].xml").data.toString("utf8");
  if (/macroEnabled/i.test(types)) throw fail("docx_macro");
  return { placeholders: listPlaceholders(docx), sha256: sha256(docx), size: docx.length };
}

/**
 * 雛形に値を差し込む。
 * @param {Buffer} docx 雛形
 * @param {Record<string,string>} values 項目名 → 値（文字列）
 * @returns {{docx: Buffer|null, missing: string[], used: string[]}}
 *   1つでも値が無ければ docx は null（途中まで埋めた文書は作らない）。missing に足りない項目名を返す
 */
export function fillTemplate(docx, values) {
  const need = listPlaceholders(docx);
  const clean = {};
  for (const k of need) {
    const v = values?.[k];
    if (typeof v === "string" && v.trim() && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v) && v.length <= 2000) clean[k] = v.trim();
  }
  const missing = need.filter((k) => !(k in clean));
  if (missing.length) return { docx: null, missing, used: need };
  const entries = readZip(docx).map((e) => {
    if (!isTextPart(e.name)) return e;
    const xml = eachParagraph(e.data.toString("utf8"), (p) => {
      const nodes = paragraphTexts(p);
      const joined = nodes.map((n) => n.text).join("");
      if (!joined.includes("{{")) return p;                      // 差し込みの無い段落は、1文字も変えない
      // 段落内の文字位置 → どの <w:t> か
      const texts = nodes.map((n) => n.text);
      const spans = []; let pos = 0;
      for (const n of nodes) { spans.push([pos, pos + n.text.length]); pos += n.text.length; }
      const matches = [...joined.matchAll(PLACEHOLDER)].reverse();   // 後ろから置き換える（前の位置がずれない）
      for (const m of matches) {
        const from = m.index, to = m.index + m[0].length, value = clean[m[1].trim()];
        const first = spans.findIndex(([a, b]) => from >= a && from < b);
        const last = spans.findIndex(([a, b]) => to > a && to <= b);
        if (first < 0 || last < 0) continue;
        const head = texts[first].slice(0, from - spans[first][0]);
        const tail = texts[last].slice(to - spans[last][0]);
        // 値は最初の <w:t>（その書式）に入れ、途中の <w:t> は空にする。書式（<w:rPr>）や段落の構造は触らない
        if (first === last) texts[first] = head + value + tail;
        else { texts[first] = head + value; for (let i = first + 1; i < last; i++) texts[i] = ""; texts[last] = tail; }
      }
      let out = "", cursor = 0;
      nodes.forEach((n, i) => {
        out += p.slice(cursor, n.start);
        const changed = texts[i] !== n.text;
        // 改行は Word の改行（<w:br/>）にする。前後の空白が消えないよう xml:space を付ける
        const body = texts[i].split("\n").map(xmlEsc).join('</w:t><w:br/><w:t xml:space="preserve">');
        const attrs = changed && !/xml:space=/.test(n.attrs) ? n.attrs + ' xml:space="preserve"' : n.attrs;
        out += changed ? `<w:t${attrs}>${body}</w:t>` : p.slice(n.start, n.end);
        cursor = n.end;
      });
      return out + p.slice(cursor);
    });
    return { ...e, data: Buffer.from(xml, "utf8") };
  });
  const out = writeZip(entries);
  if (listPlaceholders(out).length) throw fail("docx_fill_incomplete");   // 差し込み残しがあれば、出さない
  return { docx: out, missing: [], used: need };
}

/** 文書の中の文字だけを、部品ごとに取り出す（雛形と発行物の「条項が変わっていないこと」の照合に使う） */
export function extractText(docx) {
  const out = {};
  for (const e of readZip(docx)) {
    if (!isTextPart(e.name)) continue;
    const paras = [];
    eachParagraph(e.data.toString("utf8"), (p) => { paras.push(paragraphTexts(p).map((n) => n.text).join("")); return p; });
    out[e.name] = paras;
  }
  return out;
}
