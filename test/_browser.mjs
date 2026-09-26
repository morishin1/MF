// ブラウザのテストで使う道具。
//
// playwright は、CI では devDependencies から入る。
// 手元（このサンドボックス）では入っていないことがあるので、
// 見つからなければ入っている場所から読む
export async function launch() {
  let pw;
  try {
    pw = await import("playwright");
  } catch {
    pw = await import("/opt/node22/lib/node_modules/playwright/index.mjs");
  }
  const opts = {};
  // 手元には playwright が入れた Chromium がある。CI では自分で入れる
  const local = process.env.TEST_CHROME;
  if (local) opts.executablePath = local;
  else {
    const { globSync } = await import("node:fs");
    const m = globSync("/opt/pw-browsers/chromium-*/chrome-linux/chrome");
    if (m.length) opts.executablePath = m[m.length - 1];
  }
  return pw.chromium.launch(opts);
}

export const BASE = process.env.TEST_BASE || "http://127.0.0.1:8713";

// 「今日」をJST基準で作る共通ヘルパー。
//
// ■ なぜ要るか
//   UIテストのブラウザは timezoneId: "Asia/Tokyo" で開くことが多いが、
//   テストスクリプト自身（Node側）は実行環境のUTC時計で動く。
//   `new Date().toISOString().slice(0, 10)`（UTC基準の日付）と
//   `new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)`
//   （JST基準の日付）を同じテストの中で混ぜて使うと、UTCの15時（=JST 0時）
//   をまたいだ瞬間にだけ「今日」の日付がずれ、フレーク（時間帯依存の失敗）
//   になる。日付を作るときは、必ずこのヘルパーで統一する
export function jstToday(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
}
