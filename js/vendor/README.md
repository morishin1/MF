# js/vendor — 外部ライブラリ（そのまま同梱・無改変）

## qrcode-generator.js

- 用途: 二段階認証（TOTP）の QR コードを、**ブラウザの中だけで**作る（`js/qr.js` が使う）。
  秘密の情報（セットアップキー・`otpauth://` の URI）を、外部の QR 生成サービスへ送らないため、外部 API ではなくローカルで生成する。
- 出どころ: npm `qrcode-generator` **2.0.4** の `dist/qrcode.js`（QR Code Generator for JavaScript, Kazuhiko Arase）
- ライセンス: **MIT**（下記）。ファイルの先頭にも著作権表示がある。
- 改変: なし（配布物のまま）。SHA-256 = `79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c`
- 更新するとき: 新しい版の `dist/qrcode.js` に差し替え、この版数と SHA-256 を直し、`node test/qrcode.mjs` と `node test/ui/mfaenrollui.mjs` を通す。
- 注意: この配布物の既定の文字列変換は **ISO-8859-1 で日本語を壊す**。UTF-8 にするのは `js/qr.js` の役目（`stringToBytesFuncs['UTF-8']` を選ぶ）。ここを外すと、日本語を含む URI の QR が読めなくなる（`test/qrcode.mjs` が見張る）。

```
The MIT License (MIT)

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
