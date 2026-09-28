// テスト用の小さな画像を、その場で作る（リポジトリに画像を置かない）。
//   png(w, h)  … 本物のPNG（RGBA・透過あり）。pdf-lib で埋め込める
//   jpeg(w, h) … JPEG の骨組み（SOI・SOF0・EOI）。pdf-lib は見出しの寸法だけ読むので埋め込める
//   webp()     … 先頭が RIFF…WEBP のバイト列（形式の判定用）
import zlib from "node:zlib";

const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
};

export function png(w = 8, h = 8, rgba = [200, 30, 30, 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(w).fill(rgba).flat())]);
  const raw = Buffer.concat(Array(h).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function jpeg(w = 8, h = 8) {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

export function webp() {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(22, 4); b.write("WEBPVP8L", 8, "latin1");
  return b;
}
