// 1台のPCにまとめる／WEB利用の履歴／組み立ての札 を、偽のSupabaseで通す。
//
// いちばん厚く見るのは **URLをどこまで削るか**。
// ここが緩むと、検索語・一度きりの鍵・メールアドレスがそのまま会社に届く。
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, writes: [] };
const DEFAULTS = {
  gw_device_pairings: { browsers: [] },
  gw_devices: { status: "unconfirmed", source: "agent" },
};

// ---- SELECT した列だけを返す ------------------------------------------------
//
// ■ なぜ、わざわざ削るのか
//
//   本物の PostgREST は、.select() に書いた列しか返さない。
//   偽物が行を丸ごと返していると、**書いてあるのに取り忘れている**
//   という間違いが、テストでは通ってしまう。
//
//   実際にそれで壊れた。api/devices/pair.js が enrollment_id を
//   取り忘れていて、インストーラが永久に ready:false を受け取っていた。
//   テストは全部通っていた。
//
//   だからここで、本物と同じだけ削る。
function cols(spec) {
  if (!spec || spec === "*") return null;
  const out = [];
  let depth = 0, cur = "";
  for (const ch of String(spec)) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean).map((s) => {
    const paren = s.indexOf("(");
    if (paren >= 0) s = s.slice(0, paren);        // 埋め込み（rel(...)）
    const colon = s.indexOf(":");
    if (colon >= 0) s = s.slice(0, colon);        // 別名（alias:col）
    return s.trim();
  });
}

function project(row, spec) {
  if (!row) return row;
  const keep = cols(spec);
  if (!keep) return row;
  const out = {};
  for (const k of keep) if (k in row) out[k] = row[k];
  return out;
}

function table(name) {
  const f = [];
  const q = {
    select(spec) { q._cols = spec; return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq(k, v) { f.push(["!" + k, v]); return q; },
    is(k, v) { f.push([k, v]); return q; },
    not() { return q; },
    in(k, vs) { f.push([k, vs]); return q; },
    gte() { return q; },
    lte() { return q; },
    lt() { return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle() { return Promise.resolve({ data: copy(pick(name, f)), error: err(name) }); },
    single() { return Promise.resolve({ data: copy(pick(name, f)), error: err(name) }); },
    then(fn) {
      return Promise.resolve({ data: match(name, f).map(copy), error: err(name) }).then(fn);
    },
    upsert(rows, opts) {
      const list = [].concat(rows);
      db.writes.push({ op: "upsert", table: name, rows: list, opts });
      (db.rows[name] = db.rows[name] || []).push(...list);
      const r = { select: () => r, single: () => Promise.resolve({ data: list[0], error: err(name) }),
                  then: (fn) => Promise.resolve({ data: list, error: err(name) }).then(fn) };
      return r;
    },
    insert(row) {
      const list = [].concat(row).map((x) => ({ ...(DEFAULTS[name] || {}), id: `x${++seq}`, ...x }));
      db.writes.push({ op: "insert", table: name, row: list.length === 1 ? list[0] : list });
      (db.rows[name] = db.rows[name] || []).push(...list);
      const r = { select: () => r, single: () => Promise.resolve({ data: list[0], error: err(name) }),
                  then: (fn) => Promise.resolve({ data: list, error: err(name) }).then(fn) };
      return r;
    },
    update(row) {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        is: (k, v) => { g.push([k, v]); return r; },
        not: () => r,
        select: () => r,
        single: () => {
          const cur = pick(name, g);
          if (cur) Object.assign(cur, row);
          db.writes.push({ op: "update", table: name, row, where: g });
          return Promise.resolve({ data: cur ? { ...cur } : null, error: err(name) });
        },
        then: (fn) => {
          const hit = match(name, g);
          for (const cur of hit) Object.assign(cur, row);
          db.writes.push({ op: "update", table: name, row, where: g });
          return Promise.resolve({ data: hit.map(copy), error: err(name) }).then(fn);
        },
      };
      return r;
    },
    delete() {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        // lt を無視すると「期限切れを片付ける」が全件削除になる。
        // 本物と同じように、比べてから消す
        lt: (k, v) => { g.push(["<" + k, v]); return r; },
        // is も無視できない。無視すると「使っていない札だけ消す」が
        // 「使い終わった記録まで消す」になる
        is: (k, v) => { g.push(["is:" + k, v]); return r; },
        in: (k, v) => { g.push([k, v]); return r; },
        not: () => r, select: () => r,
        then: (fn) => {
          const hit = match(name, g);
          db.rows[name] = (db.rows[name] || []).filter((x) => !hit.includes(x));
          db.writes.push({ op: "delete", table: name, where: g });
          return Promise.resolve({ data: hit.map(copy), error: err(name) }).then(fn);
        },
      };
      return r;
    },
  };
  return q;
}
let seq = 0;
const err = (name) => (db.missing === name
  ? { code: "PGRST205", message: "Could not find the table" } : null);
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([k, v]) => {
  if (k.startsWith("!")) return r[k.slice(1)] !== v;
  if (k.startsWith("<")) return String(r[k.slice(1)] ?? "") < String(v);
  // 本物の列は NULL。偽の行では「その鍵が無い」になるので、同じ扱いにする。
  // ここがずれると .is("used_at", null) が1行も拾わない
  if (v === null) return r[k] == null;
  return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
}));
const pick = (name, filters) => match(name, filters)[0] || null;
const copy = (r) => (r ? { ...r } : r);

// Storage の偽物。署名つきURLは、押すたびに違うものが返る
const storage = { calls: [] };
const fakeStorage = {
  from(bucket) {
    return {
      createSignedUrl(path, sec, opts) {
        storage.calls.push({ bucket, path, sec, download: opts?.download || null });
        if (storage.fail) return Promise.resolve({ data: null, error: new Error("no") });
        return Promise.resolve({
          data: { signedUrl: `https://xyz.supabase.co/storage/v1/object/sign/${bucket}/${path}`
                             + `?token=sig${storage.calls.length}` },
          error: null,
        });
      },
    };
  },
};
mock.module(atRoot("lib/supabase.js"), {
  namedExports: {
    admin: () => ({ from: table, storage: fakeStorage }),
    userClient: () => ({ from: table, storage: fakeStorage }),
  },
});
let signedIn = { id: "u-1", email: "yamada@8grp.co.jp" };
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async (req, res) => signedIn, getMemberships: async () => [] },
});
let ctxNow = null;
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => ctxNow, canManageHr: () => ctxNow.isHr },
});
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async () => {}, clearNotification: async () => {} },
});
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async () => {} } });

const { default: pair } = await import(atRoot("api/devices/pair.js"));
const { default: setup } = await import(atRoot("api/devices/setup.js"));
const { default: web } = await import(atRoot("api/devices/web.js"));
const { default: ingest } = await import(atRoot("api/devices/ingest.js"));
const D = await import(atRoot("lib/devices.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const o = res(); await h(req, o); return o; };
const get = (path, qs = "") => ({ method: "GET", url: `${path}${qs}`, headers: { authorization: "Bearer x" } });
const post = (path, body) => ({ method: "POST", url: path, body, headers: { authorization: "Bearer x" } });

const HR = { tenantId: "t1", isAdmin: true, isHr: true, roles: ["hr"],
             employee: { id: "emp-hr", display_name: "事務" } };
const ME = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
             employee: { id: "emp-1", display_name: "山田 太郎", email: "y@x" } };

const TODAY = D.jstDate();
const reset = () => {
  db.rows = { gw_devices: [], gw_device_pairings: [], gw_device_enrollments: [],
              gw_device_releases: [],
              gw_device_browsers: [], gw_device_web_visits: [], gw_device_usage: [],
              gw_device_app_usage: [], gw_device_policies: [], gw_time_entries: [],
              gw_device_views: [], gw_device_events: [], gw_employees: [] };
  db.writes = []; db.missing = null; logged.length = 0; seq = 0;
  storage.calls = []; storage.fail = false;
  ctxNow = HR;
};

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log("  ok", name); };

// =============================================================================
console.log("\n== URL をどこまで残すか ==");
// =============================================================================
await ok("? から後ろは必ず捨てる", () => {
  assert.equal(D.cleanPath("https://www.google.com/search?q=転職 エージェント"), "/search");
  assert.equal(D.cleanPath("https://x.jp/a?token=abc&mail=a@b.jp"), "/a");
});
await ok("# から後ろも捨てる", () => {
  assert.equal(D.cleanPath("https://mail.google.com/mail/u/0/#inbox/FMfcgzABC"), "/mail/u/0");
});
await ok("一度きりのリンクに見える区切りは伏せる", () => {
  assert.equal(D.cleanPath("https://x.jp/reset/9f3c8a2bd41e77aa"), "/reset/…");
  assert.equal(D.cleanPath("https://x.jp/i/aGVsbG8td29ybGQxMjM0NQ"), "/i/…");
});
await ok("何のページかは残す（伏せすぎない）", () => {
  assert.equal(D.cleanPath("https://x.jp/recruit/apply"), "/recruit/apply");
  assert.equal(D.cleanPath("https://x.jp/news/2026/09"), "/news/2026/09");
});
await ok("区切りの数と長さに上限がある", () => {
  const p = D.cleanPath("https://x.jp/" + "seg/".repeat(30));
  assert.ok(p.split("/").length - 1 <= 6, p);
  assert.ok(p.length <= 120);
});
await ok("エージェント側（Go）と同じ形に削っていること", () => {
  // agent/internal/collect/category.go の PathOnly と揃えてある。
  // 片方だけ緩いと、緩いほうから入る
  for (const [a, b] of [
    ["https://x.jp/a/b?q=1", "/a/b"],
    ["https://x.jp/reset/9f3c8a2bd41e77aa", "/reset/…"],
    ["https://x.jp/", null],
  ]) assert.equal(D.cleanPath(a), b, a);
});
await ok("パスに空白を残さない（検索語がそのまま残る道を塞ぐ）", () => {
  // 本物のURLのパスに生の空白は入らない（%20 になる）。
  // 空白が残るのは、打ちかけの検索語を読んでしまったときだけ
  assert.equal(D.cleanPath("https://x.jp/新宿 ランチ おすすめ"), "/新宿ランチおすすめ");
  assert.equal(D.cleanPath("https://x.jp/my page/a"), "/mypage/a");
  assert.equal(D.cleanPath("https://x.jp/新宿　ランチ"), "/新宿ランチ");
  // 手順書の確認（path like '% %' が0件）が成り立つこと
  for (const s of ["/a b", "/a\tb", "/a　b"]) {
    assert.ok(!/\s/.test(D.cleanPath(`https://x.jp${s}`) || ""), s);
  }
});
await ok("ホスト名は、検索語を弾く", () => {
  assert.equal(D.cleanHost("転職 エージェント"), "");
  assert.equal(D.cleanHost("localhost"), "");
  assert.equal(D.cleanHost("WWW.Example.COM"), "example.com");
});

console.log("\n== 滞在の形 ==");
await ok("実際に見ていた秒数は、滞在の長さを超えない", () => {
  const v = D.normalizeVisits([{ host: "x.jp", startedAt: "2026-09-13T00:00:00Z",
    endedAt: "2026-09-13T00:05:00Z", activeSec: 99999 }]);
  assert.equal(v[0].activeSec, 300);
});
await ok("0秒のものは入れない（開いていただけは数えない）", () => {
  assert.equal(D.normalizeVisits([{ host: "x.jp", startedAt: "2026-09-13T00:00:00Z", activeSec: 0 }]).length, 0);
});
await ok("ホストが読めないものは丸ごと捨てる", () => {
  assert.equal(D.normalizeVisits([{ host: "検索 ことば", startedAt: "2026-09-13T00:00:00Z", activeSec: 60 }]).length, 0);
});
await ok("カテゴリが無ければドメインから引く", () => {
  const v = D.normalizeVisits([{ host: "chatgpt.com", startedAt: "2026-09-13T00:00:00Z", activeSec: 60 }]);
  assert.equal(v[0].category, "ai");
});

console.log("\n== 勤務時間の内か外か ==");
await ok("打刻があれば、それを使う", () => {
  const entry = { clock_in: "2026-09-13T00:00:00Z", clock_out: "2026-09-13T09:00:00Z" };
  assert.equal(D.inWorkHours("2026-09-13T03:00:00Z", { entry }), true);
  assert.equal(D.inWorkHours("2026-09-13T12:00:00Z", { entry }), false);
});
await ok("打刻が無ければ、会社の既定（9:00〜18:00）", () => {
  // 日本時間の 10:00 と 22:00
  assert.equal(D.inWorkHours("2026-09-13T01:00:00Z", { policy: {} }), true);
  assert.equal(D.inWorkHours("2026-09-13T13:00:00Z", { policy: {} }), false);
});
await ok("夜勤のように日をまたぐ設定でも読める", () => {
  const policy = { work_from: "22:00", work_to: "05:00" };
  assert.equal(D.inWorkHours("2026-09-13T14:00:00Z", { policy }), true);   // JST 23:00
  assert.equal(D.inWorkHours("2026-09-13T03:00:00Z", { policy }), false);  // JST 12:00
});

console.log("\n== 一覧は ○ △ × だけ ==");
await ok("ふつうの日は ○", () => {
  assert.equal(D.dayVerdict({ usage: { active_min: 300 }, workedMin: 480 }).mark, "○");
});
await ok("勤務中に長く続けば △（× にはしない）", () => {
  const v = D.dayVerdict({ usage: { active_min: 300 }, distractSec: 120 * 60, workedMin: 480 });
  assert.equal(v.mark, "△");
  assert.equal(v.label, "要確認");
});
await ok("届いていない日が ×（人の行いを × とはしない）", () => {
  const v = D.dayVerdict({ silent: true });
  assert.equal(v.mark, "×");
  assert.match(v.note, /届いていません/);
});

console.log("\n== 1台のPCの中のブラウザ ==");
await ok("届いていれば「連携済」", () => {
  const s = D.browserState({ installed: true, linked: true, last_seen_at: new Date().toISOString() });
  assert.equal(s.key, "linked");
});
await ok("入っているが届いていなければ「未連携」", () => {
  assert.equal(D.browserState({ installed: true, linked: false }).key, "installed");
});
await ok("届いていたのに止まれば「未通信」", () => {
  const old = new Date(Date.now() - 5 * 3600000).toISOString();
  const s = D.browserState({ installed: true, linked: true, last_seen_at: old });
  assert.equal(s.key, "silent");
  assert.match(s.note, /止まっている/);
});
await ok("知らないブラウザは受け取らない", () => {
  assert.equal(D.normalizeBrowsers([{ browser: "netscape", installed: true }]).length, 0);
  assert.equal(D.normalizeBrowsers([{ browser: "chrome", installed: true }])[0].browser, "chrome");
});

// =============================================================================
console.log("\n== 組み立て（社員にコードを打たせない） ==");
// =============================================================================
const TOKEN = "t".repeat(43);

await ok("インストーラが札を預けられる（ログイン不要）", async () => {
  reset();
  const r = await call(pair, post("/api/devices/pair", {
    token: TOKEN, hostname: "DESKTOP-A123", os: "Windows 11",
    browsers: [{ browser: "chrome", installed: true }, { browser: "edge", installed: true }],
  }));
  assert.equal(r.statusCode, 200);
  const row = db.rows.gw_device_pairings[0];
  assert.deepEqual(row.browsers, ["chrome", "edge"]);
  assert.ok(row.token_hash && row.token_hash !== TOKEN, "札そのものは保存しない");
});
await ok("短い札は受け取らない（当てられるため）", async () => {
  reset();
  const r = await call(pair, post("/api/devices/pair", { token: "abc" }));
  assert.equal(r.statusCode, 400);
});
await ok("本人の画面に、何を登録するのか出る", async () => {
  reset(); ctxNow = ME;
  await call(pair, post("/api/devices/pair", {
    token: TOKEN, hostname: "DESKTOP-A123", os: "Windows 11",
    browsers: [{ browser: "chrome", installed: true }],
  }));
  const r = await call(pair, get("/api/devices/pair", `?token=${TOKEN}`));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.pc.hostname, "DESKTOP-A123");
  assert.equal(r.body.pc.browsers[0].label, "Chrome");
});
await ok("押すと登録コードが出て、押した人のものになる", async () => {
  reset(); ctxNow = ME;
  await call(pair, post("/api/devices/pair", { token: TOKEN, hostname: "PC1" }));
  const r = await call(pair, post("/api/devices/pair", {
    token: TOKEN, claim: true, deviceUid: "browser-uid-1",
  }));
  assert.equal(r.statusCode, 200);

  const p = db.rows.gw_device_pairings[0];
  assert.ok(p.used_at, "使った印が付く");
  assert.equal(p.employee_id, "emp-1", "押した人が持ち主");
  assert.equal(p.device_uid, "browser-uid-1", "押したブラウザも覚える");
  assert.ok(p.code_once, "引き取り待ちのコードが入る");
  assert.equal(db.rows.gw_device_enrollments.length, 1);
  assert.equal(db.rows.gw_device_enrollments[0].employee_id, "emp-1");
});
// 商用のコード署名証明書を使わないので、初回だけ Windows の警告が出る。
// 社員に「警告を無視してよい」と覚えさせないため、初回は管理者が対象PCで入れる。
// そのとき押すのは管理者なので、誰のPCかを選べないと困る
console.log("\n== 管理者が代わりに設定する ==");

await ok("人事権があれば、名簿が出る（選べるようにするため）", async () => {
  reset(); ctxNow = HR;
  db.rows.gw_employees = [
    { id: "emp-1", tenant_id: "t1", display_name: "山田 太郎", department: "営業", status: "active" },
    { id: "emp-2", tenant_id: "t1", display_name: "佐藤 花子", department: "開発", status: "invited" },
    { id: "emp-x", tenant_id: "t2", display_name: "よその人", status: "active" },
  ];
  await call(pair, post("/api/devices/pair", { token: TOKEN, hostname: "PC1" }));
  const r = await call(pair, get("/api/devices/pair", `?token=${TOKEN}`));
  assert.equal(r.statusCode, 200);
  const ids = (r.body.members || []).map((m) => m.id);
  assert.ok(ids.includes("emp-1"), "在籍が出る");
  assert.ok(ids.includes("emp-2"), "内定者も出る（入社前にPCを用意するため）");
  assert.ok(!ids.includes("emp-x"), "よその会社の人は出ない");
});

await ok("人事権が無ければ、名簿は出ない", async () => {
  reset(); ctxNow = ME;
  db.rows.gw_employees = [
    { id: "emp-1", tenant_id: "t1", display_name: "山田 太郎", status: "active" },
  ];
  await call(pair, post("/api/devices/pair", { token: TOKEN, hostname: "PC1" }));
  const r = await call(pair, get("/api/devices/pair", `?token=${TOKEN}`));
  assert.equal(r.body.members, null, "選ばせないだけでなく、名簿そのものを返さない");
});

await ok("管理者は、ほかの社員のPCとして設定できる", async () => {
  reset(); ctxNow = HR;
  db.rows.gw_employees = [
    { id: "emp-1", tenant_id: "t1", display_name: "山田 太郎", status: "active" },
  ];
  await call(pair, post("/api/devices/pair", { token: TOKEN, hostname: "PC1" }));
  const r = await call(pair, post("/api/devices/pair", {
    token: TOKEN, claim: true, employeeId: "emp-1", deviceUid: "admin-browser",
  }));
  assert.equal(r.statusCode, 200);

  const p = db.rows.gw_device_pairings[0];
  assert.equal(p.employee_id, "emp-1", "選んだ人の持ち物になる");
  assert.equal(db.rows.gw_device_enrollments[0].employee_id, "emp-1");
  assert.equal(p.device_uid, null,
    "管理者のブラウザは束ねない（社員の持ち物として台帳に載ってしまう）");

  const log = logged.find((e) => e.action === "device.pair_claimed");
  assert.equal(log.detail.onBehalf, true, "代わりに設定したことを監査に残す");
  assert.equal(log.detail.employeeId, "emp-1");
});

await ok("人事権が無ければ、ほかの人のPCにはできない", async () => {
  reset(); ctxNow = ME;
  db.rows.gw_employees = [
    { id: "emp-2", tenant_id: "t1", display_name: "佐藤 花子", status: "active" },
  ];
  await call(pair, post("/api/devices/pair", { token: TOKEN, hostname: "PC1" }));
  const r = await call(pair, post("/api/devices/pair", {
    token: TOKEN, claim: true, employeeId: "emp-2",
  }));
  assert.equal(r.statusCode, 403);
  assert.equal(db.rows.gw_device_enrollments.length, 0, "コードも出ない");
});

await ok("よその会社の社員は選べない", async () => {
  reset(); ctxNow = HR;
  db.rows.gw_employees = [
    { id: "emp-x", tenant_id: "t2", display_name: "よその人", status: "active" },
  ];
  await call(pair, post("/api/devices/pair", { token: TOKEN, hostname: "PC1" }));
  const r = await call(pair, post("/api/devices/pair", {
    token: TOKEN, claim: true, employeeId: "emp-x",
  }));
  assert.equal(r.statusCode, 400);
  assert.equal(db.rows.gw_device_enrollments.length, 0);
});

await ok("自分を選んだときは、これまでどおりブラウザも束ねる", async () => {
  reset(); ctxNow = HR;
  await call(pair, post("/api/devices/pair", { token: TOKEN, hostname: "PC1" }));
  const r = await call(pair, post("/api/devices/pair", {
    token: TOKEN, claim: true, employeeId: "emp-hr", deviceUid: "my-browser",
  }));
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows.gw_device_pairings[0].device_uid, "my-browser");
});

await ok("2回押しても、コードは1本だけ", async () => {
  reset(); ctxNow = ME;
  await call(pair, post("/api/devices/pair", { token: TOKEN, hostname: "PC1" }));
  await call(pair, post("/api/devices/pair", { token: TOKEN, claim: true }));
  const r = await call(pair, post("/api/devices/pair", { token: TOKEN, claim: true }));
  assert.equal(r.statusCode, 409);
});
await ok("インストーラは、押されるまで何も受け取れない", async () => {
  reset(); ctxNow = ME;
  await call(pair, post("/api/devices/pair", { token: TOKEN, hostname: "PC1" }));
  const r = await call(pair, get("/api/devices/pair", `?token=${TOKEN}&code=1`));
  assert.equal(r.body.ready, false);
  assert.ok(!r.body.enrollToken);
});
await ok("引き取れるのは1回だけ", async () => {
  reset(); ctxNow = ME;
  await call(pair, post("/api/devices/pair", { token: TOKEN, hostname: "PC1" }));
  await call(pair, post("/api/devices/pair", { token: TOKEN, claim: true }));

  const a = await call(pair, get("/api/devices/pair", `?token=${TOKEN}&code=1`));
  assert.equal(a.body.ready, true);
  assert.ok(a.body.enrollToken);

  const b = await call(pair, get("/api/devices/pair", `?token=${TOKEN}&code=1`));
  assert.equal(b.body.ready, false, "2回目は空振りする");
});
await ok("名簿に載っていない人は押せない", async () => {
  reset();
  ctxNow = { tenantId: "t1", isHr: false, roles: [], employee: null };
  await call(pair, post("/api/devices/pair", { token: TOKEN, hostname: "PC1" }));
  const r = await call(pair, post("/api/devices/pair", { token: TOKEN, claim: true }));
  assert.equal(r.statusCode, 403);
});
await ok("知らない札は、理由を言い分けない", async () => {
  reset(); ctxNow = ME;
  const r = await call(pair, get("/api/devices/pair", `?token=${"z".repeat(43)}`));
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error, "expired");
});

// =============================================================================
console.log("\n== WEB利用 ==");
// =============================================================================
const seedVisits = () => {
  reset();
  db.rows.gw_devices = [{ id: "d1", tenant_id: "t1", employee_id: "emp-1", source: "agent" }];
  db.rows.gw_device_usage = [{ device_id: "d1", work_date: TODAY, active_min: 300,
    idle_min: 43, locked_min: 0, night_min: 0,
    first_at: `${TODAY}T08:57:00+09:00`, last_at: `${TODAY}T18:12:00+09:00` }];
  db.rows.gw_device_app_usage = [{ device_id: "d1", work_date: TODAY, minutes: 123 }];
  db.rows.gw_time_entries = [{ tenant_id: "t1", employee_id: "emp-1", work_date: TODAY,
    clock_in: `${TODAY}T09:00:00+09:00`, clock_out: `${TODAY}T18:00:00+09:00` }];
  db.rows.gw_device_web_visits = [
    { id: 1, tenant_id: "t1", employee_id: "emp-1", device_id: "d1", work_date: TODAY,
      started_at: `${TODAY}T09:02:00+09:00`, active_sec: 18 * 60,
      host: "mf.8grp.co.jp", path: "/home.html", category: "internal",
      browser: "chrome", in_work_hours: true },
    { id: 2, tenant_id: "t1", employee_id: "emp-1", device_id: "d1", work_date: TODAY,
      started_at: `${TODAY}T09:25:00+09:00`, active_sec: 32 * 60,
      host: "chatgpt.com", path: null, category: "ai",
      browser: "chrome", in_work_hours: true },
    { id: 3, tenant_id: "t1", employee_id: "emp-1", device_id: "d1", work_date: TODAY,
      started_at: `${TODAY}T10:20:00+09:00`, active_sec: 24 * 60,
      host: "youtube.com", path: null, category: "video",
      browser: "edge", in_work_hours: true },
    { id: 4, tenant_id: "t1", employee_id: "emp-1", device_id: "d1", work_date: TODAY,
      started_at: `${TODAY}T22:30:00+09:00`, active_sec: 40 * 60,
      host: "x.com", path: null, category: "sns",
      browser: "chrome", in_work_hours: false },
  ];
};

await ok("カテゴリごとの合計と、全体が出る", async () => {
  seedVisits(); ctxNow = HR;
  const r = await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today"));
  assert.equal(r.statusCode, 200);
  // 既定は勤務時間内だけ。18+32+24 = 74分
  assert.equal(r.body.total.seconds, (18 + 32 + 24) * 60);
  assert.equal(r.body.total.label, "1:14");
  const cats = Object.fromEntries(r.body.byCategory.map((c) => [c.key, c.seconds / 60]));
  assert.deepEqual(cats, { internal: 18, ai: 32, video: 24 });
});
await ok("既定は勤務時間内だけ（時間外は入らない）", async () => {
  seedVisits(); ctxNow = HR;
  const r = await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today"));
  assert.ok(!r.body.visits.some((v) => v.host === "x.com"), "時間外が混ざっている");
});
await ok("時間外も含めて見られる（そのときは scope で分かる）", async () => {
  seedVisits(); ctxNow = HR;
  const r = await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today&scope=all"));
  assert.equal(r.body.scope, "all");
  assert.ok(r.body.visits.some((v) => v.host === "x.com"));
  assert.equal(r.body.total.seconds, (18 + 32 + 24 + 40) * 60);
});
await ok("カテゴリで絞れる。合計は絞り込みで動かない", async () => {
  seedVisits(); ctxNow = HR;
  const r = await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today&category=ai"));
  assert.equal(r.body.visits.length, 1);
  assert.equal(r.body.visits[0].host, "chatgpt.com");
  assert.equal(r.body.total.seconds, (18 + 32 + 24) * 60, "絞っても合計は変わらない");
});
await ok("1日の様子が、勤務・PC稼働・WEB・アプリ・離席で出る", async () => {
  seedVisits(); ctxNow = HR;
  const r = await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today"));
  const d = r.body.day;
  assert.equal(d.work.text, "9:00");
  assert.equal(d.usage.activeText, "5:00");
  assert.equal(d.usage.idleText, "0:43");
  assert.equal(d.appText, "2:03");
  assert.ok(d.verdict.mark);
});
// 端末を1台も持たない人を開いても、画面が落ちないこと。
//
//   前はここだけ { entry, usage: null } という別の形を返していて、
//   受け取る画面は usage がある前提で書いてあったので、
//   その人を開いた瞬間に画面ごと落ちていた（usage の firstAt を読む）。
//   「データが無い」と「形が違う」は別のこと
await ok("端末が1台も無い人でも、同じ形で返す", async () => {
  seedVisits(); ctxNow = HR;
  db.rows.gw_devices = [];
  db.rows.gw_device_usage = [];
  db.rows.gw_device_app_usage = [];
  const r = await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today"));
  assert.equal(r.statusCode, 200);
  const d = r.body.day;
  assert.ok(d.usage, "usage を null にしない（画面がここを読む）");
  assert.equal(d.usage.firstAt, null);
  assert.equal(d.usage.activeText, "0:00");
  assert.equal(d.usage.idleText, "0:00");
  assert.equal(d.appText, "0:00");
  assert.ok(d.verdict.mark);
  // 打刻は端末と関係ない。あるなら出す
  assert.equal(d.work.text, "9:00");
  assert.equal(d.entry, undefined, "使わない名前を混ぜない");
});

await ok("端末が無い人と、止まっている人を、同じ文で片づけない", async () => {
  seedVisits(); ctxNow = HR;
  db.rows.gw_devices = [];
  db.rows.gw_device_usage = [];
  const none = await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today"));
  assert.ok(/登録されていません/.test(none.body.day.verdict.note), none.body.day.verdict.note);

  seedVisits(); ctxNow = HR;
  db.rows.gw_device_usage = [];      // 端末はある。届いていないだけ
  const dead = await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today"));
  assert.ok(/届いていません/.test(dead.body.day.verdict.note), dead.body.day.verdict.note);
});

await ok("履歴には、ドメインとパスと時刻と時間が出る", async () => {
  seedVisits(); ctxNow = HR;
  const r = await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today"));
  const v = r.body.visits.find((x) => x.host === "mf.8grp.co.jp");
  assert.equal(v.path, "/home.html");
  assert.equal(v.categoryLabel, "社内システム");
  assert.equal(v.text, "0:18");
  assert.equal(v.browser, "chrome");
});
await ok("管理者が開くと、本人に残る", async () => {
  seedVisits(); ctxNow = HR;
  await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today"));
  const v = db.rows.gw_device_views[0];
  assert.ok(v, "見た記録が無い");
  assert.equal(v.employee_id, "emp-1");
  assert.equal(v.scope, "web");
  assert.ok(logged.some((l) => l.action === "device.view_web"));
});
await ok("本人が自分のを見ても、見た記録は残さない", async () => {
  seedVisits(); ctxNow = ME;
  await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today"));
  assert.equal(db.rows.gw_device_views.length, 0);
});
await ok("他人の履歴は、人事でなければ見られない", async () => {
  seedVisits(); ctxNow = ME;
  const r = await call(web, get("/api/devices/web", "?employeeId=emp-9&range=today"));
  assert.equal(r.statusCode, 403);
});
await ok("勤務中に長く続いたら「確認して」と出す（不正とは言わない）", async () => {
  seedVisits(); ctxNow = HR;
  // 勤務中の動画を100分にする
  db.rows.gw_device_web_visits[2].active_sec = 100 * 60;
  const r = await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today"));
  const a = r.body.alerts.find((x) => x.rule === "distract_in_work");
  assert.ok(a, "アラートが出ていない");
  assert.equal(a.severity, "warn", "critical にはしない");
});
await ok("表が無ければ、どのSQLを流すか言う", async () => {
  seedVisits(); ctxNow = HR;
  db.missing = "gw_device_web_visits";
  const r = await call(web, get("/api/devices/web", "?employeeId=emp-1&range=today"));
  assert.equal(r.statusCode, 503);
  assert.match(r.body.message, /057_device_one_pc\.sql/);
});

// =============================================================================
console.log("\n== 受け取るとき ==");
// =============================================================================
const AGENT = "Device 8f2c1d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f:s3cret";

// 端末の状態は、この1つを差し替えて変える。
// mock.module は同じ道を2回は包めないので、返す中身のほうを動かす
let deviceNow = {
  id: "d1", tenant_id: "t1", employee_id: "emp-1",
  notified_at: "2026-09-01T00:00:00Z", status: "active",
};
mock.module(atRoot("lib/device-auth.js"), {
  namedExports: { requireDevice: async () => deviceNow },
});
const { default: ingest2 } = await import(atRoot("api/devices/ingest.js?v=2"));

await ok("滞在が入り、勤務時間の内か外かが決まる", async () => {
  reset();
  db.rows.gw_time_entries = [{ tenant_id: "t1", employee_id: "emp-1", work_date: TODAY,
    clock_in: `${TODAY}T09:00:00+09:00`, clock_out: `${TODAY}T18:00:00+09:00` }];

  const r = await call(ingest2, { method: "POST", url: "/api/devices/ingest",
    headers: { authorization: AGENT },
    body: {
      visits: [
        { host: "chatgpt.com", url: "https://chatgpt.com/c/68c1f0a9b2d34e5f?x=1",
          startedAt: `${TODAY}T10:00:00+09:00`, endedAt: `${TODAY}T10:30:00+09:00`,
          activeSec: 1800, browser: "chrome", workDate: TODAY },
        { host: "x.com", startedAt: `${TODAY}T23:00:00+09:00`,
          activeSec: 600, browser: "chrome", workDate: TODAY },
      ],
      browsers: [{ browser: "chrome", installed: true, linked: true, extVersion: "1.0.0" }],
    } });
  assert.equal(r.statusCode, 200);

  const w = db.writes.filter((x) => x.table === "gw_device_web_visits");
  assert.equal(w.length, 1);
  const rows = w[0].rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].in_work_hours, true, "10:00 は勤務中");
  assert.equal(rows[1].in_work_hours, false, "23:00 は勤務外");
  assert.equal(rows[0].path, "/c/…", "一度きりに見える区切りを伏せていない");
  assert.ok(!JSON.stringify(rows).includes("x=1"), "問い合わせが残っている");
  assert.equal(rows[0].employee_id, "emp-1");

  const b = db.writes.filter((x) => x.table === "gw_device_browsers");
  assert.equal(b.length, 1);
  assert.equal(b[0].rows[0].linked, true);
});
await ok("本人が確認するまでは、1件も入らない", async () => {
  reset();
  deviceNow = { ...deviceNow, notified_at: null, status: "unconfirmed" };
  const r = await call(ingest2, { method: "POST", url: "/api/devices/ingest",
    headers: { authorization: AGENT },
    body: { visits: [{ host: "x.jp", startedAt: `${TODAY}T10:00:00+09:00`, activeSec: 60 }] } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.collect, false);
  assert.equal(r.body.reason, "not_notified");
  assert.equal(db.writes.filter((x) => x.table === "gw_device_web_visits").length, 0,
    "確認前なのに入っている");
});

// 管理者が登録コードを配る運用はやめた。
// 社員はログインしているので、誰なのかはもう分かっている。
// コードを配って打たせるのは、手間と打ち間違いを足しているだけ
console.log("\n== 本人がマイページから登録する ==");

// 落とす先を返すので、res は end しないことがある。リダイレクトも見る
const res2 = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call2 = async (h, req) => { const o = res2(); await h(req, o); return o; };

await ok("札を作れる。持ち主は最初から決まっている", async () => {
  reset(); ctxNow = ME;
  const r = await call2(setup, post("/api/devices/setup", {}));
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.token && r.body.token.length >= 32, "札が返る");
  assert.match(r.body.fileName, /^EIGHT-Agent-Setup-.+\.exe$/, "ファイル名に札が入る");
  assert.ok(r.body.downloadUrl.includes(encodeURIComponent(r.body.token)));

  const row = db.rows.gw_device_pairings[0];
  assert.equal(row.kind, "selfserve");
  assert.equal(row.employee_id, "emp-1", "作った時点で持ち主が決まる");
  assert.ok(row.token_hash && row.token_hash !== r.body.token, "平文は保存しない");
  assert.ok(logged.find((e) => e.action === "device.setup_started"));
});

await ok("札は1人1本。作り直すと前のは消える", async () => {
  reset(); ctxNow = ME;
  await call2(setup, post("/api/devices/setup", {}));
  await call2(setup, post("/api/devices/setup", {}));
  const live = db.rows.gw_device_pairings.filter((p) => p.kind === "selfserve");
  assert.equal(live.length, 1, "生きた札が溜まらない");
});

await ok("名簿に載っていない人は札を作れない", async () => {
  reset();
  ctxNow = { tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: null };
  const r = await call2(setup, post("/api/devices/setup", {}));
  assert.equal(r.statusCode, 403);
});

await ok("自分の札の進み具合だけ見られる", async () => {
  reset(); ctxNow = ME;
  const made = await call2(setup, post("/api/devices/setup", {}));
  const tk = made.body.token;

  let r = await call2(setup, get("/api/devices/setup", `?token=${encodeURIComponent(tk)}`));
  assert.equal(r.body.state, "waiting", "まだ実行されていない");

  // インストーラが札を預けた
  await call(pair, post("/api/devices/pair", {
    token: tk, hostname: "DESKTOP-A123", os: "Windows 11",
    browsers: [{ browser: "chrome", installed: true }],
  }));
  r = await call2(setup, get("/api/devices/setup", `?token=${encodeURIComponent(tk)}`));
  assert.equal(r.body.state, "installing");
  assert.equal(r.body.pc.hostname, "DESKTOP-A123");
});

await ok("他人の札は見られない", async () => {
  reset(); ctxNow = ME;
  const made = await call2(setup, post("/api/devices/setup", {}));
  ctxNow = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
             employee: { id: "emp-9", display_name: "別の人" } };
  const r = await call2(setup, get("/api/devices/setup", `?token=${encodeURIComponent(made.body.token)}`));
  assert.equal(r.statusCode, 404, "「無い」と「他人の」を言い分けない");
});

await ok("インストーラが札を預けても、持ち主は変わらない", async () => {
  reset(); ctxNow = ME;
  const made = await call2(setup, post("/api/devices/setup", {}));
  const r = await call(pair, post("/api/devices/pair", {
    token: made.body.token, hostname: "PC1", os: "Windows 11",
    browsers: [{ browser: "chrome", installed: true }],
  }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.bound, true, "もう持ち主が決まっている札だと分かる");

  const row = db.rows.gw_device_pairings[0];
  assert.equal(row.employee_id, "emp-1");
  assert.equal(row.hostname, "PC1", "PCの情報だけ足される");
  assert.equal(db.rows.gw_device_pairings.length, 1, "行は増えない");
});

await ok("本人が開くと、押さずに進めてよいと返る", async () => {
  reset(); ctxNow = ME;
  const made = await call2(setup, post("/api/devices/setup", {}));
  await call(pair, post("/api/devices/pair", { token: made.body.token, hostname: "PC1" }));
  const r = await call(pair, get("/api/devices/pair", `?token=${made.body.token}`));
  assert.equal(r.body.kind, "selfserve");
  assert.equal(r.body.auto, true, "誰のPCか聞き直さない");
  assert.equal(r.body.members, null, "名簿は出さない（選び直せることにしない）");
});

await ok("別の人がログインしているブラウザで開いても、結びつけない", async () => {
  reset(); ctxNow = ME;
  const made = await call2(setup, post("/api/devices/setup", {}));
  await call(pair, post("/api/devices/pair", { token: made.body.token, hostname: "PC1" }));

  ctxNow = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
             employee: { id: "emp-9", display_name: "別の人" } };
  const info = await call(pair, get("/api/devices/pair", `?token=${made.body.token}`));
  assert.equal(info.body.auto, false);
  assert.equal(info.body.otherPerson, true, "画面が止められるように伝える");

  const r = await call(pair, post("/api/devices/pair", { token: made.body.token, claim: true }));
  assert.equal(r.statusCode, 403, "共用PCで前の人がログインしたままでも、奪われない");
  assert.equal(db.rows.gw_device_enrollments.length, 0);
});

await ok("人事でも、本人の札に別の社員をあてられない", async () => {
  reset(); ctxNow = ME;
  const made = await call2(setup, post("/api/devices/setup", {}));
  ctxNow = HR;
  db.rows.gw_employees = [{ id: "emp-2", tenant_id: "t1", display_name: "佐藤", status: "active" }];
  const r = await call(pair, post("/api/devices/pair", {
    token: made.body.token, claim: true, employeeId: "emp-2",
  }));
  assert.ok(r.statusCode === 400 || r.statusCode === 403,
    "誰のパソコンかは、札を作った時点で決まっている");
});

await ok("インストーラが自分で作った札は、これまでどおり", async () => {
  reset(); ctxNow = ME;
  await call(pair, post("/api/devices/pair", {
    token: TOKEN, hostname: "PC9", os: "Windows 11",
  }));
  const row = db.rows.gw_device_pairings[0];
  assert.equal(row.kind, "installer");
  assert.equal(row.employee_id, undefined, "押されるまで持ち主は決まらない");
  const r = await call(pair, get("/api/devices/pair", `?token=${TOKEN}`));
  assert.equal(r.body.auto, false, "押してもらう");
});

await ok("使い終わった札は、もう受け取らない", async () => {
  reset(); ctxNow = ME;
  const made = await call2(setup, post("/api/devices/setup", {}));
  await call(pair, post("/api/devices/pair", { token: made.body.token, hostname: "PC1" }));
  await call(pair, post("/api/devices/pair", { token: made.body.token, claim: true }));

  const again = await call(pair, post("/api/devices/pair", {
    token: made.body.token, hostname: "PC1",
  }));
  assert.equal(again.statusCode, 404, "使用後は再利用不可");
});

await ok("配布物が無ければ、落とさせない", async () => {
  reset(); ctxNow = ME;
  const made = await call2(setup, post("/api/devices/setup", {}));
  const r = await call2(setup,
    get("/api/devices/setup", `?download=${encodeURIComponent(made.body.token)}`));
  assert.equal(r.statusCode, 503);
  assert.match(r.body.hint, /管理部/);
});

await ok("置き場所から、短時間だけ有効なURLを作って送る", async () => {
  reset(); ctxNow = ME;
  db.rows.gw_device_releases = [{
    id: "r1", tenant_id: "t1", published: true,
    bucket: "agent", object_path: "0.3.0/EIGHT-Agent-Setup.exe", url: null,
  }];
  const made = await call2(setup, post("/api/devices/setup", {}));
  const r = await call2(setup,
    get("/api/devices/setup", `?download=${encodeURIComponent(made.body.token)}`));
  assert.equal(r.statusCode, 302);
  assert.match(r.headers.Location, /^https:\/\//);

  const c = storage.calls[0];
  assert.equal(c.bucket, "agent");
  assert.equal(c.path, "0.3.0/EIGHT-Agent-Setup.exe");
  assert.ok(c.sec <= 600, `URLは短命であること（${c.sec}秒）`);
  assert.equal(c.download, `EIGHT-Agent-Setup-${made.body.token}.exe`,
    "ファイル名に札を入れる（打ち込ませないため）");
  assert.equal(r.headers["Cache-Control"], "no-store, private",
    "短命のURLを途中に残さない");
});

await ok("押すたびに違うURLになる", async () => {
  reset(); ctxNow = ME;
  db.rows.gw_device_releases = [{
    id: "r1", tenant_id: "t1", published: true,
    bucket: "agent", object_path: "0.3.0/EIGHT-Agent-Setup.exe",
  }];
  const made = await call2(setup, post("/api/devices/setup", {}));
  const q = `?download=${encodeURIComponent(made.body.token)}`;
  const a = await call2(setup, get("/api/devices/setup", q));
  const b = await call2(setup, get("/api/devices/setup", q));
  assert.notEqual(a.headers.Location, b.headers.Location,
    "長く生きるURLを持ち回さない");
});

await ok("URLを作れなければ、落とさせない", async () => {
  reset(); ctxNow = ME;
  storage.fail = true;
  db.rows.gw_device_releases = [{
    id: "r1", tenant_id: "t1", published: true,
    bucket: "agent", object_path: "0.3.0/EIGHT-Agent-Setup.exe",
  }];
  const made = await call2(setup, post("/api/devices/setup", {}));
  const r = await call2(setup,
    get("/api/devices/setup", `?download=${encodeURIComponent(made.body.token)}`));
  assert.equal(r.statusCode, 503);
});

await ok("外に置いた版は、そのURLへ送る", async () => {
  reset(); ctxNow = ME;
  db.rows.gw_device_releases = [{
    id: "r1", tenant_id: "t1", published: true,
    url: "https://mf.8grp.co.jp/agent/EIGHT-Agent-Setup.exe",
  }];
  const made = await call2(setup, post("/api/devices/setup", {}));
  const r = await call2(setup,
    get("/api/devices/setup", `?download=${encodeURIComponent(made.body.token)}`));
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.Location, "https://mf.8grp.co.jp/agent/EIGHT-Agent-Setup.exe");
  assert.equal(storage.calls.length, 0, "Storage は使わない");
});

console.log("\n== 誰がインストーラを実行するか ==");

// 商用のコード署名証明書を使わないので、初回に Windows の警告が出る。
// 「警告が出たら詳細情報→実行」を社員に覚えさせない
await ok("既定は管理者・IT担当", async () => {
  reset(); ctxNow = ME;
  const r = await call2(setup, get("/api/devices/setup", "?policy=1"));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.selfInstall, false);
});

await ok("設定1つで、社員が自分で入れる形に切り替えられる", async () => {
  reset(); ctxNow = ME;
  db.rows.gw_device_policies = [{ tenant_id: "t1", self_install: true }];
  const r = await call2(setup, get("/api/devices/setup", "?policy=1"));
  assert.equal(r.body.selfInstall, true);
});

await ok("設定が読めなければ、安全側（管理者が入れる）", async () => {
  reset(); ctxNow = ME;
  db.missing = "gw_device_policies";
  const r = await call2(setup, get("/api/devices/setup", "?policy=1"));
  assert.equal(r.body.selfInstall, false);
});

await ok("https でない配布先へは送らない", async () => {
  reset(); ctxNow = ME;
  db.rows.gw_device_releases = [{
    id: "r1", tenant_id: "t1", published: true,
    url: "http://mf.8grp.co.jp/agent/EIGHT-Agent-Setup.exe",
  }];
  const made = await call2(setup, post("/api/devices/setup", {}));
  const r = await call2(setup,
    get("/api/devices/setup", `?download=${encodeURIComponent(made.body.token)}`));
  assert.equal(r.statusCode, 503);
});

await ok("他人の札では落とせない", async () => {
  reset(); ctxNow = ME;
  const made = await call2(setup, post("/api/devices/setup", {}));
  ctxNow = { tenantId: "t1", isAdmin: false, isHr: false, roles: [],
             employee: { id: "emp-9", display_name: "別の人" } };
  const r = await call2(setup,
    get("/api/devices/setup", `?download=${encodeURIComponent(made.body.token)}`));
  assert.equal(r.statusCode, 404);
});

console.log(`\n合計 ${n} 件 通過`);
