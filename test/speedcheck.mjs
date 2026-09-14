// 画面が出るまでを、遅くしない約束。
//
// ■ なぜテストにするのか
//
//   速くする直しは、あとから1行足すだけで簡単に元へ戻る。
//   しかも戻ったことに誰も気づかない（動いてはいるので）。
//   気づけるのは「なんか遅い」と言われたときで、そこから探すのは高い。
//
//   ここで守るのは3つ。
//
//     ① アイコンの字を、丸ごと配らない
//        可変フォントを範囲で頼むと 4MB 近く落ちてくる。
//        使っているのは1本（opsz 20 / wght 400 / FILL 0 / GRAD 0）だけなので、
//        それだけ頼めば 330KB。全ページで効く。
//
//     ② js/css は、版を付けて長く持たせる
//        no-cache だと、画面を移るたびに毎回サーバへ聞きにいく。
//        ?v= を付けてあるので、中身が変われば URL が変わる。
//
//     ③ ②を効かせるために、版は1つにそろえる
//        長く持たせるということは、上げ忘れたら古いままになるということ。
//        HTML の ?v= と /api/health の assetVersion を、必ず同じにする。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const at = (p) => join(ROOT, p);
const read = (p) => readFileSync(at(p), "utf8");

const pages = [
  ...readdirSync(ROOT).filter((f) => f.endsWith(".html")).map((f) => f),
  ...readdirSync(at("biz")).filter((f) => f.endsWith(".html")).map((f) => `biz/${f}`),
];

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("— アイコンの字を、丸ごと配らない —");

ok("可変フォントを範囲で頼んでいるページは無い", () => {
  // 「@20..48,100..700,0..1,-50..200」のような範囲指定。
  // 4MB 近い可変フォントがそのまま落ちてくる
  const bad = pages.filter((f) => /css2\?family=Material\+Symbols[^"']*\d\.\.\d/.test(read(f)));
  assert.equal(bad.length, 0,
    `範囲で頼んでいます（4MB落ちてきます）: ${bad.join(", ")}`);
});

ok("アイコンの字は、使う1本だけ頼む", () => {
  const want = "opsz,wght,FILL,GRAD@20,400,0,0";
  const bad = pages.filter((f) => {
    const s = read(f);
    return s.includes("Material+Symbols") && !s.includes(want);
  });
  assert.equal(bad.length, 0, bad.join(", "));
});

ok("配る字と、CSS で指している字がそろっている", () => {
  // 配っていない太さ・大きさを CSS で指しても効かない。
  // 効かない指定が残っていると、次に見た人が「効くはず」と思って直しにくる
  for (const css of ["css/app.css", "css/style.css"]) {
    const s = read(css);
    const m = s.match(/font-variation-settings:[^;}]*/g) || [];
    for (const line of m) {
      const opsz = line.match(/'opsz'\s*(\d+)/);
      if (opsz) assert.equal(opsz[1], "20", `${css}: ${line.trim()}`);
      const wght = line.match(/'wght'\s*(\d+)/);
      if (wght) assert.equal(wght[1], "400", `${css}: ${line.trim()}`);
    }
  }
});

ok("font は preconnect してある", () => {
  // つなぎ直し（DNS→TLS）で1往復ぶん遅れる。先に開いておく
  const bad = pages.filter((f) => {
    const s = read(f);
    return s.includes("fonts.googleapis.com")
      && !s.includes('rel="preconnect" href="https://fonts.gstatic.com"');
  });
  assert.equal(bad.length, 0, bad.join(", "));
});

console.log("\n— 版は1つにそろえる —");

const VER = (() => {
  const m = read("api/health.js").match(/assetVersion:\s*"([^"]+)"/);
  return m?.[1] || null;
})();

ok("/api/health に版がある", () => {
  assert.ok(VER, "assetVersion が読めません");
});

ok("HTML の ?v= は、全部その版と同じ", () => {
  const seen = new Map();
  for (const f of pages) {
    for (const m of read(f).matchAll(/(?:src|href)="(?:js|css)\/[^"]*\?v=([^"&]+)"/g)) {
      if (!seen.has(m[1])) seen.set(m[1], []);
      seen.get(m[1]).push(f);
    }
  }
  const wrong = [...seen.entries()].filter(([v]) => v !== VER);
  assert.equal(wrong.length, 0,
    "版がそろっていません（immutable なので、古いものが残り続けます）: "
    + wrong.map(([v, fs]) => `${v}←${fs.slice(0, 3).join(",")}`).join(" / ")
    + `（正しくは ${VER}）`);
});

console.log("\n— js/css は長く持たせる —");

const vercel = JSON.parse(read("vercel.json"));
const headers = vercel.headers || [];
const ruleFor = (src, q) => headers.find((h) => h.source === src
  && (q === "has" ? h.has : q === "missing" ? h.missing : true));

ok("版付きの js/css は immutable", () => {
  const r = ruleFor("/(js|css)/(.*)", "has");
  assert.ok(r, "版付きの決まりがありません");
  const cc = r.headers.find((h) => h.key === "Cache-Control")?.value || "";
  assert.match(cc, /immutable/, cc);
  assert.match(cc, /max-age=\d{7,}/, cc);
  assert.deepEqual(r.has, [{ type: "query", key: "v" }]);
});

ok("版の無い js/css は、これまでどおり毎回確かめる", () => {
  // 古い会計画面は ?v= を付けていない。そこまで固めると直せなくなる
  const r = ruleFor("/(js|css)/(.*)", "missing");
  assert.ok(r, "版無しの決まりがありません");
  const cc = r.headers.find((h) => h.key === "Cache-Control")?.value || "";
  assert.match(cc, /no-cache/, cc);
});

ok("HTML は固めない", () => {
  // HTML を固めると、?v= を上げても新しい HTML が届かず、何も変わらなくなる
  const r = headers.find((h) => h.source === "/(.*).html");
  assert.ok(r, "HTML の決まりがありません");
  const cc = r.headers.find((h) => h.key === "Cache-Control")?.value || "";
  assert.match(cc, /no-cache/, cc);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
