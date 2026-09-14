// ページ内 <style> で display を指定したクラスが、
// あとで .hidden と一緒に使われていないかを見る。
// app.css の .hidden より後ろに書いた display は .hidden に勝ってしまい、
// 「隠したのに出たまま」になる（同じ詳細度なら、後に書いたほうが勝つ）
import fs from "node:fs";

let bad = 0;
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, "utf8");
  const styles = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  if (!styles) continue;

  // 「.foo { … display: … }」のクラス名を拾う（最後のクラスが対象）
  const withDisplay = new Set();
  for (const m of styles.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/(^|[;{\s])display\s*:/.test(m[2])) continue;
    for (const sel of m[1].split(",")) {
      if (/\.hidden/.test(sel)) continue;          // 自分で打ち消しているものは対象外
      // display が効くのは、いちばん最後の要素。
      // 「.np-sec > h3」の display は .np-sec ではなく h3 に付くので、
      // 最後の区切りより後ろだけを見る（ここを間違えると誤検知だらけになる）
      const last = sel.trim().split(/[\s>+~]+/).pop() || "";
      if (/^[a-zA-Z]/.test(last)) continue;         // 最後が要素名なら、クラスの話ではない
      for (const c of last.matchAll(/\.([A-Za-z0-9_-]+)/g)) withDisplay.add(c[1]);
    }
  }
  if (!withDisplay.size) continue;

  // 打ち消しを書いてあるクラス
  const guarded = new Set();
  for (const m of styles.matchAll(/\.([A-Za-z0-9_-]+)\.hidden\b/g)) guarded.add(m[1]);

  // class 属性で hidden と一緒に使われているか
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    const list = m[1].split(/\s+/);
    if (!list.includes("hidden")) continue;
    for (const c of list) {
      if (c === "hidden" || !withDisplay.has(c) || guarded.has(c)) continue;
      const line = src.slice(0, m.index).split("\n").length;
      console.log(`NG ${f}:${line}  .${c} は display を指定していて .hidden が効かない`);
      bad++;
    }
  }
  // 後から classList.add("hidden") するぶんは、ここでは見ない。
  // 近くにある別のクラスを拾って誤検知するだけで、当たらなかった
}
console.log(bad ? `${bad} 件` : ".hidden が効かない指定はなし");
process.exit(bad ? 1 : 0);
