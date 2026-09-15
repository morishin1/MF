// 入社手続きの情報を、外部の AI に送らない。
//
// ■ なぜテストにするのか
//
//   履歴書・口座・本人確認書類・マイナンバー確認書類は、
//   AI に渡してよいと決めたものではない。
//   いまは渡していない（人が読んで確かめた）。
//   ただ、便利な関数（lib/ai.js の呼び出し）は同じリポジトリの中にあり、
//   あとから1行 import すれば渡せてしまう。
//
//   「渡していないこと」を、人の記憶ではなく、ここで毎回確かめる。
//   将来 AI 解析を足すなら、対象・目的・送る範囲を別に決めてから、
//   このテストの許可リストを変える（変えた理由が commit に残る）。
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 個人情報を扱う側。ここから AI を呼んではいけない */
const GUARDED = [
  "api/onboarding", "api/sign", "api/hr",
  "lib/onboard-kit.js", "lib/onboard-form.js", "lib/onboard-docs.js",
  "lib/onboard-brief.js", "lib/onboard-stage.js", "lib/onboard-advance.js",
  "lib/consent-docs.js", "lib/esign.js", "lib/sign-audit.js",
  "lib/hr-flow.js", "lib/hr-run.js", "lib/hr-drive.js",
];

/** AI を呼ぶ入口。これを import していたら渡している */
const AI_MODULES = ["lib/ai.js", "lib/claude.js", "lib/ai-json.js", "lib/extract.js",
                    "lib/growth-ai.js", "lib/nippo-eval.js"];
const AI_WORDS = /anthropic|openai|api\.openai\.com|ANTHROPIC_API_KEY|OPENAI_API_KEY/;

const files = [];
for (const g of GUARDED) {
  const p = join(ROOT, g);
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p)) if (f.endsWith(".js")) files.push(join(g, f));
  } else files.push(g);
}

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

// コメントは外して見る。「AIに書かせない」と書いたコメントで引っかからないように
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("— 入社手続きの側から、AI を呼んでいないこと —");
for (const f of files) {
  const src = strip(readFileSync(join(ROOT, f), "utf8"));
  ok(f, () => {
    for (const m of AI_MODULES) {
      const name = m.replace(/^lib\//, "");
      assert.ok(!new RegExp(`from\\s+["'][./]*(lib/)?${name.replace(".", "\\.")}["']`).test(src),
        `${m} を import しています`);
    }
    assert.ok(!AI_WORDS.test(src), "AI の API を直接呼んでいる形跡があります");
  });
}

// lib/contracts.js は契約書 PDF を AI で読む（readContract）。
// これは会社が作った契約書の中身を構造化するもので、本人の届出や口座ではない。
// ただし、入社手続きの側からこの関数を呼ぶ形にはしない
ok("契約書の AI 読み取りを、入社手続きの側から呼んでいない", () => {
  for (const f of files) {
    const src = strip(readFileSync(join(ROOT, f), "utf8"));
    assert.ok(!/readContract\s*\(/.test(src), `${f} が readContract を呼んでいます`);
  }
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
