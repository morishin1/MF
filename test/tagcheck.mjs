// 閉じ忘れた開始タグ（`>` を落としたもの）を探す。
// ブラウザは黙って直してしまうので、見た目では気づけない
import fs from "node:fs";

let bad = 0;
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, "utf8");
  // <tag ... のあと、`>` が来る前に次の `<` が来たら、閉じ忘れ。
  // 属性値の中の < > は無視するため、クォートを飛ばしながら見る
  let i = 0;
  const line = (n) => src.slice(0, n).split("\n").length;
  while ((i = src.indexOf("<", i)) >= 0) {
    if (!/[A-Za-z/!]/.test(src[i + 1] || "")) { i++; continue; }
    if (src.startsWith("<!--", i)) { i = src.indexOf("-->", i) + 3 || src.length; continue; }
    // script / style の中身は素通しする（JS の < と > を拾ってしまう）
    const tag = /^<\s*(script|style)\b/i.exec(src.slice(i, i + 20));
    let j = i + 1, q = null, closed = false;
    for (; j < src.length; j++) {
      const c = src[j];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === ">") { closed = true; break; }
      if (c === "<") break;
    }
    if (!closed) {
      console.log(`NG ${f}:${line(i)}  ${src.slice(i, i + 60).split("\n")[0]}`);
      bad++;
    }
    if (tag && closed) {
      const end = src.toLowerCase().indexOf(`</${tag[1].toLowerCase()}`, j);
      i = end > 0 ? end : j + 1;
      continue;
    }
    i = j + 1;
  }
}
console.log(bad ? `${bad} 件` : "閉じ忘れなし");
process.exit(bad ? 1 : 0);
