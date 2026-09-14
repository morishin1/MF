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
