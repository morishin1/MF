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
const keys = new Set([...groups.matchAll(/\{ key: "([a-z]+)",/g)].map((m) => m[1]));

let bad = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("admin-") && x.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(dir, f), "utf8");
  const m = /KPLayout\.init\(\{\s*active:\s*"([a-z]+)"/.exec(html);
  if (!m) { console.log("active が読めない:", f); bad++; continue; }
  if (!keys.has(m[1])) { console.log("NG メニューに無い鍵:", f, "->", m[1]); bad++; }
}
// messages.html は管理者も同じ画面を使う
const msg = /KPLayout\.init\(\{\s*active:\s*"([a-z]+)"/.exec(fs.readFileSync(path.join(dir, "messages.html"), "utf8"));
if (!keys.has(msg[1])) { console.log("NG messages.html ->", msg[1]); bad++; }

console.log(bad ? `${bad} 件 失敗` : `すべての管理画面がメニューに紐づいている（鍵 ${keys.size} 個）`);
process.exit(bad ? 1 : 0);
