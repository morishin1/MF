// 管理画面が渡している active の鍵が、すべてどこかのグループに入っているか。
// 入っていない画面は、開いてもメニューのどこも光らない
import fs from "node:fs";
import path from "node:path";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const dir = ROOT;
const src = fs.readFileSync(path.join(dir, "js/layout.js"), "utf8");
const groups = src.slice(src.indexOf("const ADMIN_GROUPS = ["), src.indexOf("// 社労士は社外の人"));
const keys = new Set([...groups.matchAll(/\{ key: "([a-z_]+)",/g)].map((m) => m[1]));
// match: [...] に書かれた鍵も、選ばれた状態になる正規の鍵（tabsの帯は出ないだけ）
for (const m of groups.matchAll(/match:\s*\[([^\]]*)\]/g)) {
  for (const k of m[1].matchAll(/"([a-z_]+)"/g)) keys.add(k[1]);
}

// 単純な「active: "esign"」か、「active: 何か ? "esign_order" : "esign"」の
// どちらか。後者は三項演算の左右（実際にactiveへ入る側）だけを拾う
function activeKeysOf(html) {
  const plain = /KPLayout\.init\(\{\s*active:\s*"([a-z_]+)"/.exec(html);
  if (plain) return [plain[1]];
  const ternary = /KPLayout\.init\(\{\s*active:[\s\S]*?\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"/.exec(html);
  return ternary ? [ternary[1], ternary[2]] : null;
}

let bad = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("admin-") && x.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(dir, f), "utf8");
  const m = activeKeysOf(html);
  if (!m) { console.log("active が読めない:", f); bad++; continue; }
  for (const k of m) if (!keys.has(k)) { console.log("NG メニューに無い鍵:", f, "->", k); bad++; }
}
// messages.html は管理者も同じ画面を使う
const msg = activeKeysOf(fs.readFileSync(path.join(dir, "messages.html"), "utf8"));
for (const k of msg || []) if (!keys.has(k)) { console.log("NG messages.html ->", k); bad++; }

console.log(bad ? `${bad} 件 失敗` : `すべての管理画面がメニューに紐づいている（鍵 ${keys.size} 個）`);
process.exit(bad ? 1 : 0);
