// 即時取込と一覧再読込を実ブラウザで区別。APIは全て架空の応答で、実Gmail/DBへは接続しない。
import assert from "node:assert/strict";
import { launch, BASE } from "../_browser.mjs";
import { accessOf } from "../../lib/gw.js";

const browser = await launch();
const contexts = [];
let passed = 0;
const ok = (condition, label) => { assert.ok(condition, label); passed++; };
const gate = () => { let release; const promise = new Promise((done) => { release = done; }); return { promise, release }; };
function fixture(overrides = {}) {
  return { ready: true, failList: false, listGate: null, syncGate: null,
    gets: 0, posts: [], unexpectedWrites: [], errors: [],
    syncStatus: 200, result: { ok: true, inserted: 2, duplicates: 1, processed: 3 }, ...overrides };
}
async function open(fx) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Tokyo" });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on("pageerror", (error) => fx.errors.push(String(error)));
  await page.addInitScript(() => localStorage.setItem("kp_session", JSON.stringify({
    access_token: "synthetic-session", email: "recruit@example.com",
  })));
  // フォント等の外部アクセスも不要。ローカル静的ファイルだけを許可する。
  await page.route("**/*", (route) => new URL(route.request().url()).origin === new URL(BASE).origin
    ? route.continue() : route.abort());
  await page.route("**/api/**", async (route) => {
    const req = route.request(), url = new URL(req.url());
    const send = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/hr/inbox-sync-now") {
      assert.equal(req.method(), "POST");
      fx.posts.push(JSON.parse(req.postData() || "{}"));
      if (fx.syncGate) await fx.syncGate.promise;
      return send(fx.result, fx.syncStatus);
    }
    if (req.method() !== "GET") {
      fx.unexpectedWrites.push(url.pathname);
      return send({ error: "unexpected_test_write" }, 500);
    }
    if (url.pathname === "/api/me") return send({ email: "recruit@example.com", appRole: "member",
      gw: { employee: { id: "e1", display_name: "架空採用担当" }, roles: ["recruiter"], tenantId: "t1" },
      access: accessOf({ roles: ["recruiter"] }) });
    if (url.pathname === "/api/hr/applicants") return send({ applicants: [] });
    if (url.pathname === "/api/hr/inbox") {
      if (url.searchParams.has("count")) return send({ newCount: 1, openCount: 1, unreadCount: 1 });
      const version = ++fx.gets;
      if (fx.listGate) await fx.listGate.promise;
      if (fx.failList) return send({ error: "db_failed", hint: "架空の一覧読み込みエラー" }, 500);
      return send({ readsReady: true, syncConfigured: true, manualSyncReady: fx.ready, capped: false,
        mails: [{ id: "11111111-1111-4111-8111-111111111111", provider: "gmail", status: "new",
          received_at: "2026-10-28T00:00:00Z", subject: "架空受信一覧 " + version,
          sender_address: "synthetic@example.com", read: false }] });
    }
    return send({});
  });
  await page.goto(BASE + "/hr/inbox.html", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hr-bar");
  return page;
}
const loaded = (page, version) => page.waitForFunction((n) =>
  document.querySelector("#inList")?.textContent.includes("架空受信一覧 " + n), version);
const finished = (page) => page.waitForFunction(() =>
  document.querySelector("#syncNow")?.textContent === "最新メールを取り込む");
async function refresh(page, fx) {
  const version = fx.gets + 1;
  await page.locator("#refresh").click();
  if (fx.failList) await page.waitForFunction(() => document.querySelector("#inList")?.textContent.includes("0件ではありません"));
  else await loaded(page, version);
}
async function sync(page) {
  await page.locator("#syncNow").click();
  await finished(page);
}

try {
  const initialGate = gate(), setup = fixture({ ready: false, listGate: initialGate });
  const setupPage = await open(setup);
  ok(await setupPage.locator("#syncNow").isDisabled(), "設定確認が終わるまで初期状態は無効");
  await setupPage.locator("#syncNow").dispatchEvent("click");
  ok(setup.posts.length === 0, "設定確認前は取込を起動しない");
  setup.listGate = null; initialGate.release();
  await loaded(setupPage, 1);
  ok(await setupPage.locator("#syncNow").isDisabled(), "追加設定未完了では無効のまま");
  ok((await setupPage.locator("#inSyncState").innerText()).includes("初期設定待ち"), "未設定の理由を表示");
  setup.failList = true;
  await refresh(setupPage, setup);
  ok(await setupPage.locator("#syncNow").isDisabled(), "一覧読込失敗でも取込ボタンを有効にしない");
  ok(setup.posts.length === 0, "一覧更新はGASを起動しない");

  const fx = fixture(), page = await open(fx);
  await loaded(page, 1);
  ok(await page.locator("#syncNow").isEnabled(), "設定済みの一覧応答で取込が有効になる");
  await refresh(page, fx);
  ok(fx.gets === 2 && fx.posts.length === 0, "一覧を更新はGETのみ");
  const pending = gate(); fx.syncGate = pending;
  await page.locator("#syncNow").click();
  await page.waitForFunction(() => document.querySelector("#syncNow")?.textContent.includes("取り込み中"));
  ok(await page.locator("#syncNow").isDisabled(), "取込中はボタン無効");
  await page.locator("#syncNow").dispatchEvent("click");
  await refresh(page, fx);
  ok(await page.locator("#syncNow").isDisabled(), "取込中の一覧更新で取込ボタンを再有効化しない");
  ok((await page.locator("#inStatus").innerText()).includes("最新メールを確認しています"), "並行一覧更新でも処理中表示を保つ");
  await page.locator("#syncNow").dispatchEvent("click");
  ok(fx.posts.length === 1, "連打・並行一覧更新でもPOSTは1回");
  assert.deepEqual(fx.posts[0], {});
  fx.syncGate = null; pending.release();
  await finished(page);
  ok((await page.locator("#inStatus").innerText()).includes("新規取り込み：2件／登録済み（重複）：1件"), "成功件数を表示");
  ok((await page.locator("#inStatus").innerText()).includes("応募者への登録・メール送信は行っていません"), "自動応募者化・送信と誤解させない");
  ok(await page.locator("#syncNow").isEnabled(), "成功した再読込後に取込ボタンを戻す");

  for (const [result, status, message] of [
    [{ ok: true, dryRun: true }, 200, "テストモードのため取り込みは実行していません"],
    [{ error: "busy", hint: "別の取込が実行中です。完了後に一覧を更新してください" }, 409, "別の取込が実行中"],
    [{ error: "sync_result_unknown", hint: "取り込み結果を確認できませんでした。メール一覧を更新してください" }, 502, "取り込み結果を確認できませんでした"],
  ]) {
    fx.result = result; fx.syncStatus = status;
    const before = fx.posts.length;
    await sync(page);
    ok((await page.locator("#inStatus").innerText()).includes(message), "応答別の説明: " + message);
    ok(fx.posts.length === before + 1, "エラー・テストモードでも自動再試行しない");
  }

  fx.result = { ok: true, inserted: 1, duplicates: 0 }; fx.syncStatus = 200; fx.failList = true;
  await sync(page);
  const failedText = await page.locator("#inStatus").innerText();
  ok(failedText.includes("応答は受け取りましたが、一覧を確認できませんでした"), "取込応答後の一覧障害を成功件数で上書きしない");
  ok((await page.locator("#inList").innerText()).includes("0件ではありません"), "取得不能を空一覧扱いしない");
  ok((await page.locator("#openCount").innerText()) === "—", "取得不能の件数をゼロ扱いしない");
  ok(await page.locator("#syncNow").isDisabled(), "再読込失敗後は取込無効");
  const before = fx.posts.length;
  await page.locator("#syncNow").dispatchEvent("click");
  await refresh(page, fx);
  ok(await page.locator("#syncNow").isDisabled() && fx.posts.length === before, "読込エラー中の連打・再更新でも取込を起動しない");
  fx.failList = false;
  await refresh(page, fx);
  ok(await page.locator("#syncNow").isEnabled(), "一覧更新の成功を確認してから取込を再有効化");
  ok(fx.posts.length === before, "復旧の一覧更新もGETのみ");
  for (const state of [setup, fx]) {
    assert.deepEqual(state.errors, [], "ブラウザ例外なし");
    assert.deepEqual(state.unexpectedWrites, [], "応募者登録・メール送信・本番書込なし");
  }
  console.log(`HR inbox instant sync UI: ${passed} checks PASS`);
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser.close();
}
