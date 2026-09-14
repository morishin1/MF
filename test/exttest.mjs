// ブラウザ拡張だけで、EXE 無しに動くか。
//
// ■ 何を守るテストか
//
//   これまで拡張は、数えた結果をパソコンの中のソフト（EXE）へ渡し、
//   そのソフトがサーバへ送っていた。
//   「拡張を入れるだけ」では何も動かず、EXE を配って、SmartScreen を
//   くぐって、入れてもらう必要があった。入れ直し・更新のたびに同じことをやる。
//
//   これからは、拡張が自分で送る。社員がすることは
//     1. グループウェアにログインする
//     2. 拡張を入れる
//   の2つだけ。ここが崩れたら、方針そのものが元に戻る。
//
// ■ 渡してよいもの・いけないもの
//
//   拡張に渡すのは端末専用の資格情報だけ。
//   社員のログイン（Supabase のトークン）は渡さない。渡ると、
//   拡張を入れた人が社員として何でもできてしまう。
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase ---------------------------------------------------------
const db = { rows: {} };

function table(name) {
  const f = [];
  const wrap = (v) => Promise.resolve(v);
  const rows = () => match(name, f);
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    in(k, v) { f.push([k, v]); return q; },
    is(k, v) { f.push(["is:" + k, v]); return q; },
    not() { return q; }, gte() { return q; }, lte() { return q; }, lt() { return q; },
    order() { return q; },
    limit(n) { q._limit = n; return q; },
    maybeSingle() { return wrap({ data: rows()[0] || null, error: null }); },
    single() { return wrap({ data: rows()[0] || null, error: null }); },
    then(fn) {
      let out = rows();
      if (q._limit) out = out.slice(0, q._limit);
      return wrap({ data: out, error: null, count: out.length }).then(fn);
    },
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`, ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r = { select: () => r, single: () => wrap({ data: made[0], error: null }),
                  then: (fn) => wrap({ data: made, error: null }).then(fn) };
      return r;
    },
    upsert(row) { return q.insert(row); },
    update(patch) {
      const g = [];
      const run = () => {
        const hit = match(name, g);
        for (const r of hit) Object.assign(r, patch);
        return { data: hit, error: null };
      };
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        in: (k, v) => { g.push([k, v]); return r; },
        is: (k, v) => { g.push(["is:" + k, v]); return r; },
        select: () => r,
        single: () => wrap({ data: run().data[0] || null, error: null }),
        maybeSingle: () => wrap({ data: run().data[0] || null, error: null }),
        then: (fn) => wrap(run()).then(fn),
      };
      return r;
    },
    delete() {
      const g = [];
      const r = { eq: (k, v) => { g.push([k, v]); return r; },
                  then: (fn) => wrap({ data: [], error: null }).then(fn) };
      return r;
    },
  };
  return q;
}
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([k, v]) => {
  if (k.startsWith("is:")) { const kk = k.slice(3); return v === null ? r[kk] == null : r[kk] === v; }
  return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
}));

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
let signedIn = { id: "u-1", email: "a@8grp.co.jp" };
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => signedIn, getMemberships: async () => [] },
});
let ctxNow = null;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => ctxNow,
    canManageHr: () => false,
    canWipeDevice: () => false,
  },
});
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async () => ({ created: 0 }), clearNotification: async () => {} },
});

const { default: browser } = await import(atRoot("api/devices/browser.js"));
const { default: ingest } = await import(atRoot("api/devices/ingest.js"));
const { default: manifest } = await import(atRoot("api/devices/manifest.js"));
const { sha256 } = await import(atRoot("lib/devices.js"));

// ---- 呼び出しの道具 --------------------------------------------------------
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => {
  const r = res();
  await h({ headers: {}, ...req }, r);
  return r;
};
const post = (body, headers = {}) => call(browser, {
  method: "POST", url: "/api/devices/browser",
  headers: { authorization: "Bearer x", ...headers }, body,
});

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const UID = "browser-uid-0123456789";
const DEV = "22222222-2222-2222-2222-222222222222";

/** ログインして、合図が1回届いたあとの状態 */
function setup({ confirmed = true, mine = true } = {}) {
  ctxNow = {
    tenantId: "t1", isAdmin: false, isHr: false, roles: [],
    employee: { id: "emp-1", display_name: "山田 太郎" },
  };
  db.rows = {
    gw_devices: [{
      id: DEV, tenant_id: "t1", device_uid: UID,
      employee_id: mine ? "emp-1" : "emp-9",
      source: "browser", label: "Windows 11 の Chrome",
      status: "active",
      notified_at: confirmed ? "2026-09-01T00:00:00Z" : null,
      secret_hash: null, link_code_hash: null, link_expires_at: null,
      installed_at: null, hostname: null, agent_version: null,
      last_seen_at: "2026-09-14T00:00:00Z", retired_at: null,
      revoked_at: null, wipe_requested_at: null, wipe_done_at: null, deleted_at: null,
    }],
    gw_device_browsers: [], gw_device_events: [], gw_device_web_visits: [],
    gw_device_policies: [], gw_device_usage: [], gw_device_app_usage: [],
    gw_device_web_usage: [], gw_device_alerts: [], gw_time_entries: [],
    gw_device_releases: [],
  };
}
const dev = () => db.rows.gw_devices[0];

console.log("\n=== 拡張だけで動くか（EXE 無し）===\n");

// ---------------------------------------------------------------------------
console.log("— つなぐ —");

await ok("画面が、1回きりの合言葉をもらえる", async () => {
  setup();
  const r = await post({ action: "code", deviceUid: UID });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(r.body.code, "合言葉が返っていません");
  assert.equal(dev().link_code_hash, sha256(r.body.code));
  assert.ok(dev().link_expires_at, "期限が入っていません");
});

await ok("拡張が、合言葉を資格情報に換えられる", async () => {
  setup();
  const got = await post({ action: "code", deviceUid: UID });
  // 拡張からはログインを持たずに来る
  const r = await call(browser, {
    method: "POST", url: "/api/devices/browser",
    headers: {},
    body: { action: "pair", code: got.body.code, browser: "chrome", version: "2.0.0" },
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.deviceId, DEV);
  assert.ok(r.body.secret, "資格情報が返っていません");
  assert.equal(dev().secret_hash, sha256(r.body.secret));
});

await ok("合言葉は1回で死ぬ", async () => {
  setup();
  const got = await post({ action: "code", deviceUid: UID });
  await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                        body: { action: "pair", code: got.body.code, browser: "chrome" } });
  const again = await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                                      body: { action: "pair", code: got.body.code } });
  assert.equal(again.statusCode, 400, `いま ${again.statusCode}`);
});

await ok("期限が切れた合言葉は通らない", async () => {
  setup();
  const got = await post({ action: "code", deviceUid: UID });
  dev().link_expires_at = new Date(Date.now() - 1000).toISOString();
  const r = await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                                  body: { action: "pair", code: got.body.code } });
  assert.equal(r.statusCode, 400);
});

await ok("「無い」と「期限切れ」を言い分けない", async () => {
  setup();
  const a = await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                                  body: { action: "pair", code: "でたらめ" } });
  setup();
  const got = await post({ action: "code", deviceUid: UID });
  dev().link_expires_at = new Date(Date.now() - 1000).toISOString();
  const b = await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                                  body: { action: "pair", code: got.body.code } });
  assert.equal(a.body.error, b.body.error, "総当たりの手がかりになります");
});

await ok("他人の端末には合言葉を出さない", async () => {
  setup({ mine: false });
  const r = await post({ action: "code", deviceUid: UID });
  assert.equal(r.statusCode, 404, `いま ${r.statusCode}`);
  assert.equal(dev().link_code_hash, null);
});

await ok("どのブラウザでつないだかが残る", async () => {
  setup();
  const got = await post({ action: "code", deviceUid: UID });
  await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                        body: { action: "pair", code: got.body.code,
                                browser: "edge", version: "2.0.0" } });
  const b = db.rows.gw_device_browsers[0];
  assert.ok(b, "ブラウザの行ができていません");
  assert.equal(b.browser, "edge");
  assert.equal(b.linked, true);
  assert.equal(b.ext_version, "2.0.0");
});

// ---------------------------------------------------------------------------
console.log("\n— 拡張が、自分で送れる —");

const DEV_AUTH = (secret) => ({ authorization: `Device ${DEV}:${secret}` });

await ok("拡張の資格情報で、WEB利用を送れる", async () => {
  setup();
  const got = await post({ action: "code", deviceUid: UID });
  const p = await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                                  body: { action: "pair", code: got.body.code, browser: "chrome" } });

  const r = await call(ingest, {
    method: "POST", url: "/api/devices/ingest", headers: DEV_AUTH(p.body.secret),
    body: {
      sentAt: "2026-09-14T05:00:00Z",
      visits: [{ host: "example.com", path: "/a", startedAt: "2026-09-14T04:00:00Z",
                 endedAt: "2026-09-14T04:10:00Z", activeSec: 600, browser: "chrome" }],
      browsers: [{ browser: "chrome", installed: true, linked: true, extVersion: "2.0.0" }],
    },
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.collect, true);
  assert.equal(db.rows.gw_device_web_visits.length, 1, "WEB利用が入っていません");
  assert.equal(db.rows.gw_device_web_visits[0].host, "example.com");
});

await ok("EXE が1つも無くても入る", async () => {
  setup();
  // エージェント（source='agent'）の行は1つも無い
  assert.ok(!db.rows.gw_devices.some((d) => d.source === "agent"));
  const got = await post({ action: "code", deviceUid: UID });
  const p = await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                                  body: { action: "pair", code: got.body.code, browser: "chrome" } });
  const r = await call(ingest, {
    method: "POST", url: "/api/devices/ingest", headers: DEV_AUTH(p.body.secret),
    body: { visits: [{ host: "docs.google.com", startedAt: "2026-09-14T04:00:00Z",
                       activeSec: 120, browser: "chrome" }] },
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
});

await ok("本人が確認するまでは、受け取らない", async () => {
  setup({ confirmed: false });
  const got = await post({ action: "code", deviceUid: UID });
  const p = await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                                  body: { action: "pair", code: got.body.code, browser: "chrome" } });
  assert.equal(p.body.collect, false, "確認前なのに collect:true と言っています");
  assert.equal(p.body.consentUrl, "device-consent.html", "どこで確認するのか返していません");

  const r = await call(ingest, {
    method: "POST", url: "/api/devices/ingest", headers: DEV_AUTH(p.body.secret),
    body: { visits: [{ host: "example.com", startedAt: "2026-09-14T04:00:00Z", activeSec: 60 }] },
  });
  assert.equal(r.body.collect, false);
  assert.equal(db.rows.gw_device_web_visits.length, 0, "確認前の記録を入れています");
});

// ---------------------------------------------------------------------------
console.log("\n— 拡張にできないこと —");

await ok("EXE の更新は取りに行けない", async () => {
  setup();
  const got = await post({ action: "code", deviceUid: UID });
  const p = await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                                  body: { action: "pair", code: got.body.code, browser: "chrome" } });
  const r = await call(manifest, {
    method: "GET", url: "/api/devices/manifest", headers: DEV_AUTH(p.body.secret),
  });
  assert.equal(r.statusCode, 401,
    `拡張が EXE 用の口を叩けています（いま ${r.statusCode}）`);
});

await ok("でたらめな資格情報では入れない", async () => {
  setup();
  const r = await call(ingest, {
    method: "POST", url: "/api/devices/ingest",
    headers: { authorization: `Device ${DEV}:でたらめ` },
    body: { visits: [] },
  });
  assert.equal(r.statusCode, 401);
});

await ok("つないでいないブラウザは入れない", async () => {
  setup();
  // secret_hash が null のまま
  const r = await call(ingest, {
    method: "POST", url: "/api/devices/ingest",
    headers: { authorization: `Device ${DEV}:なんでも` },
    body: { visits: [] },
  });
  assert.equal(r.statusCode, 401);
});

// ---------------------------------------------------------------------------
console.log("\n— 拡張が読まないもの —");
//
//   読む口をそもそも持たない、を manifest と中身で確かめる。
//   「入れる場所を作らない」のが、いちばん確実な歯止め

await ok("manifest に、読むための権限が1つも無い", async () => {
  const { readFileSync } = await import("node:fs");
  const m = JSON.parse(readFileSync(atRoot("agent/extension/manifest.json"), "utf8"));
  for (const bad of ["cookies", "webRequest", "webNavigation", "history",
                     "downloads", "bookmarks", "clipboardRead", "debugger",
                     "scripting", "declarativeNetRequest"]) {
    assert.ok(!m.permissions.includes(bad), `permissions に ${bad} が入っています`);
  }
  assert.ok(!m.content_scripts, "content_scripts があります（ページの中に入れてしまいます）");
});

await ok("通信先は、会社のグループウェアだけ", async () => {
  const { readFileSync } = await import("node:fs");
  const m = JSON.parse(readFileSync(atRoot("agent/extension/manifest.json"), "utf8"));
  assert.deepEqual(m.host_permissions, ["https://mf.8grp.co.jp/*"],
    `いま ${JSON.stringify(m.host_permissions)}`);
  assert.deepEqual(m.externally_connectable.matches, ["https://mf.8grp.co.jp/*"]);
});

await ok("EXE との継ぎ役は、もう要らない", async () => {
  const { readFileSync } = await import("node:fs");
  const m = JSON.parse(readFileSync(atRoot("agent/extension/manifest.json"), "utf8"));
  assert.ok(!m.permissions.includes("nativeMessaging"),
    "nativeMessaging が残っています（EXE が要る形のままです）");
  const src = readFileSync(atRoot("agent/extension/background.js"), "utf8");
  assert.ok(!/sendNativeMessage/.test(src), "まだ EXE へ渡そうとしています");
});

await ok("ページの題も、URLの全文も送らない", async () => {
  const { readFileSync } = await import("node:fs");
  // コメントを先に落とす。
  //「tab.title に触らない」と書いた説明を、触っていると読んでしまう
  const src = readFileSync(atRoot("agent/extension/background.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/tab\.title/.test(src), "ページの題を読んでいます");
  // 送る中身に入るのは host と path だけ
  const body = src.slice(src.indexOf("pending.push("), src.indexOf("pending.push(") + 400);
  assert.ok(!/\burl\b/.test(body), `送るものに url が入っています: ${body.slice(0, 120)}`);
});

// ---------------------------------------------------------------------------
console.log("\n— 自動ではつながない —");
//
//   画面が勝手につなげば、手順としてはいちばん短い。
//   ところがそれだと、本人は「いつのまにか記録が始まっていた」になる。
//   押すという行為が、管理されていると分かる瞬間になる。
//   だから、つなぐのは画面のボタンからだけ

await ok("画面を開いただけでは、つながない", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(atRoot("js/device.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // start() の中から extPair を呼んでいないこと
  const start = src.slice(src.indexOf("function start("), src.indexOf("function stop("));
  assert.ok(!/extPair/.test(start),
    "画面を開いた時点でつないでいます（本人が押す前に記録が始まります）");
});

await ok("押す前に、何を記録するかが出ている", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(atRoot("mypage.html"), "utf8");
  const box = src.slice(src.indexOf("このパソコンを、会社のパソコンとして登録します"),
                        src.indexOf("doExtPair(this)"));
  assert.ok(box.length > 0, "登録のボタンが見つかりません");
  for (const must of ["見たサイトのドメイン", "記録しません", "詳しく読む"]) {
    assert.ok(box.includes(must), `押す前に「${must}」が出ていません`);
  }
});

await ok("ボタンの文が、読んだことを含んでいる", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(atRoot("mypage.html"), "utf8");
  assert.ok(/読みました。このパソコンを登録する/.test(src),
    "ただの「登録」では、何に同意したのか残らない");
});

// ---------------------------------------------------------------------------
console.log("\n— 登録したら、本人は外せない —");
//
//   本人が自分で外せると、私物や未登録のパソコンで入ったあと
//   行を消して見えなくする、という道ができる。
//   外せるのは管理者だけ（利用停止／紛失／端末を削除 … db/064）

const me = (await import(atRoot("api/devices/me.js"))).default;
const callMe = (body) => call(me, {
  method: "POST", url: "/api/devices/me",
  headers: { authorization: "Bearer x" }, body,
});

await ok("本人は台帳から外せない", async () => {
  setup();
  const r = await callMe({ action: "forget", deviceUid: UID });
  assert.equal(r.statusCode, 403, `いま ${r.statusCode}`);
  assert.ok(/管理者/.test(r.body.hint || ""), `文: ${r.body.hint}`);
});

await ok("知らない操作で外す道を作らない", async () => {
  setup();
  for (const action of ["delete", "remove", "unlink", "unregister", "disconnect", "reset"]) {
    const r = await callMe({ action, deviceUid: UID });
    assert.ok(r.statusCode >= 400, `${action} が通っています（${r.statusCode}）`);
    assert.ok(db.rows.gw_devices.length === 1, `${action} で行が消えました`);
  }
});

await ok("本人が資格情報を消す口は無い", async () => {
  setup();
  const got = await post({ action: "code", deviceUid: UID });
  await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                        body: { action: "pair", code: got.body.code, browser: "chrome" } });
  assert.ok(dev().secret_hash, "つないだ");

  // つなぐ口はあっても、切る口は作っていない
  const r = await call(browser, {
    method: "POST", url: "/api/devices/browser",
    headers: { authorization: "Bearer x" },
    body: { action: "unpair", deviceUid: UID },
  });
  assert.equal(r.statusCode, 400, `いま ${r.statusCode}`);
  assert.ok(dev().secret_hash, "本人が切れています");
});

await ok("拡張を外しても、台帳の行は残る", async () => {
  // ブラウザから拡張を消すことは止められない。
  // 止められないなら、せめて行が消えないようにする
  setup();
  const got = await post({ action: "code", deviceUid: UID });
  await call(browser, { method: "POST", url: "/api/devices/browser", headers: {},
                        body: { action: "pair", code: got.body.code, browser: "chrome" } });
  assert.equal(db.rows.gw_devices.length, 1);
  assert.ok(dev().installed_at, "一度登録したことが残っていません");
});

await ok("拡張に「外す」ボタンを置かない", async () => {
  const { readFileSync } = await import("node:fs");
  const opt = readFileSync(atRoot("agent/extension/options.html"), "utf8");
  assert.ok(!/解除する|登録を外す|切断|unpair/i.test(opt.replace(/外せるのは管理者だけ/g, "")),
    "拡張の画面から外せるようになっています");
  assert.ok(/管理者だけ/.test(opt), "誰が外せるのかが書いていません");
});

await ok("マイページにも、外せるのは管理者だと書く", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(atRoot("mypage.html"), "utf8");
  assert.ok(/この登録を外せるのは管理者だけ/.test(src),
    "押す前に、あとで自分では外せないことを伝えていません");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) { console.log(`${fail} 件 NG`); process.exit(1); }
