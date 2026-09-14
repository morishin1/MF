// GET /ext/updates.xml , GET /ext/eight-ext.crx
//   Chrome / Edge が、会社の拡張を取りにくる口。
//
// ■ なぜ口を開けるのか
//
//   会社のポリシー（ExtensionInstallForcelist）には
//   「32文字のID」と「更新を見にいくURL」を書く。
//   ブラウザは**ログインしていない状態で**そこへ取りにくる。
//   だからここだけは、合言葉なしで読めないといけない。
//
// ■ 中身は秘密ではない
//
//   .crx は、会社貸与PC全部に入るもの。社内の鍵で署名してあり、
//   署名が合わなければブラウザが受け取らない。
//   updates.xml に載るのは、拡張のIDと版だけ。
//
//   置き場所（agent バケット）は非公開のままにして、
//   ここを通したものだけを外に出す。バケットごと公開にしない。
//
// ■ 中身はどこから来るか
//
//   「EIGHT Agent を組み立てる」が、組んだものを
//   agent/ext/ に上げる（api/devices/release.js の ext）。
//   ここはそれを読んで返すだけ。

import { admin } from "../lib/supabase.js";

const BUCKET = "agent";

const FILES = {
  "updates.xml": {
    path: "ext/updates.xml",
    type: "application/xml; charset=utf-8",
    // 更新に気づくのが遅れすぎない程度に。取りにくるのは1日に数回
    cache: "public, max-age=300",
  },
  "eight-ext.crx": {
    path: "ext/eight-ext.crx",
    type: "application/x-chrome-extension",
    cache: "public, max-age=300",
  },
};

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    res.statusCode = 405;
    return res.end("method not allowed");
  }

  // 出せるのはこの2つだけ。名前をそのまま Storage のパスにしない
  const want = new URL(req.url, "http://localhost").searchParams.get("f") || "";
  const file = Object.prototype.hasOwnProperty.call(FILES, want) ? FILES[want] : null;
  if (!file) {
    res.statusCode = 404;
    return res.end("not found");
  }

  let body;
  try {
    const { data, error } = await admin().storage.from(BUCKET).download(file.path);
    if (error || !data) {
      // まだ上げていない、が普通に起きる（拡張を初期化する前など）。
      // 何が足りないのかが分かる形で返す
      console.error("[ext]", want, error?.message || "no data");
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      return res.end(
        `${want} はまだ置かれていません。\n` +
        `GitHub Actions の「EIGHT Agent を組み立てる」を実行してください。\n`
      );
    }
    body = Buffer.from(await data.arrayBuffer());
  } catch (e) {
    console.error("[ext]", e?.message || e);
    res.statusCode = 500;
    return res.end("server error");
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", file.type);
  res.setHeader("Content-Length", String(body.length));
  res.setHeader("Cache-Control", file.cache);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method === "HEAD") return res.end();
  return res.end(body);
}
