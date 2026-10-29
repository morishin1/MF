// Verify the downloadable preview uses the actual implementation, has no
// authentication/network/persistence, and writes only synthetic in-memory data.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Script, runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = mkdtempSync(join(tmpdir(), "calendar-copy-preview-"));
try {
  execFileSync(process.execPath, [join(root, "scripts/build-calendar-duplicate-preview.mjs"), output]);
  const html = readFileSync(join(output, "index.html"), "utf8");
  const manifest = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  const controller = readFileSync(join(root, "js/calendar-duplicate.js"), "utf8");
  const css = readFileSync(join(root, "css/app.css"), "utf8");
  assert(html.includes(controller));
  assert(html.indexOf(css) < html.indexOf(".cal-copy-fields"), "base CSS must precede page-specific CSS as in production");
  assert.equal(manifest.controller.sha256, createHash("sha256").update(controller).digest("hex"));
  assert.equal(manifest.htmlSha256, createHash("sha256").update(html).digest("hex"));
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /form-action 'none'/);
  assert.match(html, /ログイン不要・すべてダミーデータ/);
  assert.match(html, /確認版の保存はこの画面内だけ/);
  assert.doesNotMatch(html, /<(?:script|link)[^>]*(?:src|href)=|\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB)\b/);
  assert.doesNotMatch(html, /<a\b[^>]*href=|<form[^>]*action=|https?:\/\//);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 5);
  scripts.forEach(script => new Script(script));
  const window = {};
  runInNewContext(scripts[0], { window, Date });
  runInNewContext(readFileSync(join(root, "js/calendar-quantity.js"), "utf8"), { window });
  runInNewContext(controller, { window, Date });
  const from = "2020-01-01T00:00:00+09:00", to = "2099-01-01T00:00:00+09:00";
  const before = await window.API.schedule(from, to);
  assert.equal(before.events.length, 3);
  const original = structuredClone(before.events[0]);
  const values = window.CalendarDuplicate.draft(original);
  const payload = window.CalendarDuplicate.payload({ ...values, title: "別日に使う確認用予定", startDate: "2027-01-10", endDate: "2027-01-10" });
  const saved = await window.API.createEvent(payload);
  assert.notEqual(saved.event.id, original.id);
  assert.equal(saved.event.title, "別日に使う確認用予定");
  const after = await window.API.schedule(from, to);
  assert.equal(after.events.length, 4);
  assert.deepEqual(structuredClone(after.events[0]), original);
  const otherWindow = {};
  runInNewContext(scripts[0], { window: otherWindow, Date });
  assert.equal((await otherWindow.API.schedule(from, to)).events.length, 3, "reopening resets all changes");
  console.log("PASS self-contained preview, exact controller/CSS order, no network/storage, synthetic copy/reset");
} finally {
  rmSync(output, { recursive: true, force: true });
}
