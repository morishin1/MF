// インラインの onclick から呼ぶ関数が、window から引けるか（＝function 宣言か）を確かめる。
// 上で const の矢印関数にしていると、押しても何も起きない（この落とし穴を何度か踏んでいる）
import fs from "node:fs";

const GLOBALS = new Set(["KPLayout", "API", "alert", "confirm", "window", "history",
  "location", "URL", "document", "console", "Math", "JSON"]);

let bad = 0;
for (const f of process.argv.slice(2)) {
  const src = fs.readFileSync(f, "utf8");
  const js = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join("\n");
  const declared = new Set(
    [...js.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));

  const called = new Set();
  for (const m of src.matchAll(/\bon(?:click|change|input|submit)="([^"]*)"/g)) {
    // ${...} は生成側のコード。属性に出るのは中身ではなく結果なので飛ばす
    const attr = m[1].replace(/\$\{(?:[^{}]|\{[^}]*\})*\}/g, "X");
    // 直前が . か ) のものはメソッド呼び出し。window から引く必要はない
    for (const c of attr.matchAll(/(^|[^.\w$)])([A-Za-z_$][\w$.]*)\s*\(/g)) called.add(c[2]);
  }

  for (const name of called) {
    if (GLOBALS.has(name.split(".")[0])) continue;
    if (name.includes(".")) continue;                 // KPLayout.xxx など
    if (!declared.has(name)) { console.log("NG", f, "->", name); bad++; }
  }
  console.log(`${f}　インラインから呼ぶ関数 ${called.size} 件`);
}
console.log(bad ? `${bad} 件 失敗` : "すべて window から引ける");
process.exit(bad ? 1 : 0);
