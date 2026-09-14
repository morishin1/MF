// 配布（api/devices/release.js）と、拡張の口（api/ext.js）を、偽のSupabaseで通す。
//
// ここが緩むと、
//   ・合言葉なしで版を差し替えられる
//   ・配った版を黙って上書きできる
//   ・確かめていないものが published になる
// のどれかが起きる。全部、入れた先で静かに壊れる類なので、ここで押さえる。
import assert from "node:assert/strict";
import { mock } from "node:test";
import crypto from "node:crypto";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const R = (p) => _join(ROOT, p);


// ---- 偽の Supabase ----------------------------------------------------------
const db = { rows: {}, writes: [], insertError: null };

function table(name) {
  const f = [];
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    limit(n) { q._limit = n; return q; },
    order() { return q; },
    maybeSingle() { return Promise.resolve({ data: match(name, f)[0] || null, error: null }); },
    single() { return Promise.resolve({ data: match(name, f)[0] || null, error: null }); },
    then(fn) {
      let rows = match(name, f);
      if (q._limit) rows = rows.slice(0, q._limit);
      return Promise.resolve({ data: rows, error: null }).then(fn);
    },
    insert(row) {
      db.writes.push({ op: "insert", table: name, row });
      if (db.insertError) {
        const e = db.insertError;
        const r = { select: () => r, single: () => Promise.resolve({ data: null, error: e }) };
        return r;
      }
      const made = { id: `new-${db.writes.length}`, created_at: "2026-09-14T00:00:00Z", ...row };
      (db.rows[name] = db.rows[name] || []).push(made);
      const r = { select: () => r, single: () => Promise.resolve({ data: made, error: null }) };
      return r;
    },
  };
  return q;
}
const match = (name, filters) =>
  (db.rows[name] || []).filter((r) => filters.every(([k, v]) => r[k] === v));

// ---- 偽の Storage -----------------------------------------------------------
const st = { objects: {}, calls: [], signUploadError: null, listError: null };

const fakeStorage = {
  from(bucket) {
    return {
      list(dir, opts) {
        st.calls.push({ op: "list", bucket, dir, search: opts?.search });
        if (st.listError) return Promise.resolve({ data: null, error: st.listError });
        const prefix = dir ? `${dir}/` : "";
        const out = Object.entries(st.objects)
          .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
          .map(([p, size]) => ({ name: p.slice(prefix.length), metadata: { size } }));
        return Promise.resolve({ data: out, error: null });
      },
      createSignedUploadUrl(path) {
        st.calls.push({ op: "signUpload", bucket, path });
        if (st.signUploadError) return Promise.resolve({ data: null, error: st.signUploadError });
        if (st.objects[path] !== undefined && !st.allowOverwrite) {
          return Promise.resolve({ data: null, error: new Error("The resource already exists") });
        }
        return Promise.resolve({
          data: { signedUrl: `/object/upload/sign/${bucket}/${path}?token=upl`, token: "upl", path },
          error: null,
        });
      },
      createSignedUrl(path, sec) {
        st.calls.push({ op: "sign", bucket, path, sec });
        return Promise.resolve({
          data: { signedUrl: `https://xyz.supabase.co/storage/v1/object/sign/${bucket}/${path}?t=r` },
          error: null,
        });
      },
      remove(paths) {
        st.calls.push({ op: "remove", bucket, paths });
        for (const p of paths) delete st.objects[p];
        return Promise.resolve({ data: null, error: null });
      },
      download(path) {
        st.calls.push({ op: "download", bucket, path });
        if (st.objects[path] === undefined) {
          return Promise.resolve({ data: null, error: new Error("Object not found") });
        }
        const body = st.bodies?.[path] ?? "x".repeat(st.objects[path]);
        return Promise.resolve({
          data: { arrayBuffer: async () => Buffer.from(body) }, error: null,
        });
      },
    };
  },
};

mock.module(R("lib/supabase.js"), {
  namedExports: {
    admin: () => ({ from: table, storage: fakeStorage }),
    userClient: () => ({ from: table, storage: fakeStorage }),
  },
});

const audit = [];
mock.module(R("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { audit.push(e); } },
});

const { default: release } = await import(R("api/devices/release.js"));
const { default: ext } = await import(R("api/ext.js"));

// ---- 偽の req/res -----------------------------------------------------------
const res = () => {
  const r = { statusCode: 0, body: null, raw: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { r.raw = b; try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};

const TOKEN = "release-token-0123456789abcdef";

const post = (body, token = TOKEN) => ({
  method: "POST", url: "/api/devices/release",
  headers: token === null ? {} : { authorization: `Bearer ${token}` },
  body,
});

async function call(body, token) {
  const r = res();
  await release(post(body, token), r);
  return r;
}

// ---- 下ごしらえ --------------------------------------------------------------
function reset() {
  db.rows = { tenants: [{ id: "t1" }] };
  db.writes = [];
  db.insertError = null;
  st.objects = {};
  st.bodies = {};
  st.calls = [];
  st.signUploadError = null;
  st.listError = null;
  st.allowOverwrite = false;
  audit.length = 0;
  process.env.DEVICE_RELEASE_TOKEN = TOKEN;
  process.env.SUPABASE_URL = "https://xyz.supabase.co";
  delete process.env.DEVICE_RELEASE_TENANT_ID;
}

const SHA = "a".repeat(64);
const SIZE = 20941312;
const SIG = "s".repeat(86);
const KID = "M3ooKpFO";

const goodPublish = (over = {}) => ({
  action: "publish", version: "0.3.1",
  sha256: SHA, size_bytes: SIZE, signature: SIG, key_id: KID, ...over,
});

// ---- 走らせる ----------------------------------------------------------------
let pass = 0, fail = 0;
const it = async (name, fn) => {
  reset();
  try { await fn(); pass++; }
  catch (e) { fail++; console.log("NG:", name, "\n   ", e.message); }
};
const group = (s) => console.log(`\n— ${s} —`);

// =============================================================================
group("合言葉");

await it("合言葉が無ければ通さない", async () => {
  const r = await call({ action: "begin", version: "0.3.1" }, null);
  assert.equal(r.statusCode, 401);
});

await it("違う合言葉は通さない", async () => {
  const r = await call({ action: "begin", version: "0.3.1" }, "wrong-token-0123456789abcdef");
  assert.equal(r.statusCode, 401);
});

await it("長さが違っても落ちずに弾く", async () => {
  for (const t of ["", "x", "x".repeat(500), TOKEN + "x", TOKEN.slice(0, -1)]) {
    const r = await call({ action: "begin", version: "0.3.1" }, t);
    assert.equal(r.statusCode, 401, `token=${t.slice(0, 8)}`);
  }
});

// 「まだ決めていない」を「誰でも通れる」にしない。
// 環境変数を入れ忘れたまま口が開くのが、いちばん危ない
await it("合言葉が設定されていなければ、口ごと閉じる", async () => {
  delete process.env.DEVICE_RELEASE_TOKEN;
  const r = await call({ action: "begin", version: "0.3.1" });
  assert.equal(r.statusCode, 401);
});

await it("短すぎる合言葉は設定されていないものとして扱う", async () => {
  process.env.DEVICE_RELEASE_TOKEN = "short";
  const r = await call({ action: "begin", version: "0.3.1" }, "short");
  assert.equal(r.statusCode, 401);
});

await it("GET では何もしない", async () => {
  const r = res();
  await release({ method: "GET", url: "/api/devices/release", headers: {} }, r);
  assert.equal(r.statusCode, 405);
});

// =============================================================================
group("版の形");

await it("版の形が違えば止める", async () => {
  for (const v of ["", "0.3", "v0.3.1", "0.3.1/../x", "../../etc", "0.3.1 0.4.0",
                   "latest", "0.3.1;drop", "０.３.１"]) {
    const r = await call({ action: "begin", version: v });
    assert.equal(r.statusCode, 400, `version=${JSON.stringify(v)}`);
  }
});

await it("ふつうの版は通る", async () => {
  for (const v of ["0.3.1", "1.0.0", "0.3.1-rc1", "10.20.30"]) {
    const r = await call({ action: "begin", version: v });
    assert.equal(r.statusCode, 200, `version=${v}: ${JSON.stringify(r.body)}`);
  }
});

// =============================================================================
group("同じ版を黙って上書きしない");

await it("表にあれば止める", async () => {
  db.rows.gw_device_releases = [{ id: "r1", tenant_id: "t1", version: "0.3.1", published: true }];
  const r = await call({ action: "begin", version: "0.3.1" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "version_exists");
  assert.equal(r.body.where, "gw_device_releases");
});

// まだ published でなくても、行があるなら止める。
// 途中で失敗した版を上書きすると、何が配られているのか分からなくなる
await it("表にあれば、published でなくても止める", async () => {
  db.rows.gw_device_releases = [{ id: "r1", tenant_id: "t1", version: "0.3.1", published: false }];
  const r = await call({ action: "begin", version: "0.3.1" });
  assert.equal(r.statusCode, 409);
});

await it("Storage にあれば止める", async () => {
  st.objects["0.3.1/EIGHT-Agent-Setup.exe"] = SIZE;
  const r = await call({ action: "begin", version: "0.3.1" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.where, "storage");
});

// Storage 側が「あるものにも上書きURLを出す」ようになっても、
// こちらで見ているので止まること。
// 向こうの言い回しに頼った判定だけだと、版が黙って差し替わる
await it("Storage が上書きを許しても、こちらで止める", async () => {
  st.allowOverwrite = true;
  st.objects["0.3.1/EIGHT-Agent-Setup.exe"] = SIZE;
  const r = await call({ action: "begin", version: "0.3.1" });
  assert.equal(r.statusCode, 409, JSON.stringify(r.body));
  assert.equal(r.body.where, "storage");
});

// 上の2つを抜けても、Storage 側が最後に止める
await it("Storage が「もうある」と言えば止める", async () => {
  st.signUploadError = new Error("The resource already exists");
  const r = await call({ action: "begin", version: "0.3.1" });
  assert.equal(r.statusCode, 409);
});

await it("別のテナントの同じ版は、じゃまをしない", async () => {
  db.rows.gw_device_releases = [{ id: "r1", tenant_id: "t2", version: "0.3.1" }];
  const r = await call({ action: "begin", version: "0.3.1" });
  assert.equal(r.statusCode, 200);
});

await it("上げる先は 版/EIGHT-Agent-Setup.exe", async () => {
  const r = await call({ action: "begin", version: "0.3.1" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.bucket, "agent");
  assert.equal(r.body.objectPath, "0.3.1/EIGHT-Agent-Setup.exe");
  // 相対で返ってくるものを、そのまま渡さない
  assert.ok(r.body.uploadUrl.startsWith("https://xyz.supabase.co/storage/v1/object/upload/sign/"),
    r.body.uploadUrl);
});

// =============================================================================
group("上げたものを確かめる");

await it("上がっていなければ止める", async () => {
  const r = await call({ action: "verify", version: "0.3.1", size_bytes: SIZE });
  assert.equal(r.statusCode, 404);
});

await it("大きさが違えば止める", async () => {
  st.objects["0.3.1/EIGHT-Agent-Setup.exe"] = 12345;
  const r = await call({ action: "verify", version: "0.3.1", size_bytes: SIZE });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.uploaded, 12345);
});

await it("合っていれば、読み直すURLを返す", async () => {
  st.objects["0.3.1/EIGHT-Agent-Setup.exe"] = SIZE;
  const r = await call({ action: "verify", version: "0.3.1", size_bytes: SIZE });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.size, SIZE);
  assert.ok(r.body.url.includes("0.3.1/EIGHT-Agent-Setup.exe"));
  // 読み直すだけ。長く生かさない
  const signed = st.calls.find((c) => c.op === "sign");
  assert.ok(signed.sec <= 600, `TTL=${signed.sec}`);
});

// =============================================================================
group("表に入れる");

await it("そろっていないものは入れない", async () => {
  st.objects["0.3.1/EIGHT-Agent-Setup.exe"] = SIZE;
  const bad = [
    { sha256: "" }, { sha256: "zz" }, { sha256: "a".repeat(63) }, { sha256: "g".repeat(64) },
    { size_bytes: 0 }, { size_bytes: 100 }, { size_bytes: 999999999 },
    { size_bytes: 1.5 }, { signature: "" }, { signature: "s" },
    { signature: "s".repeat(500) }, { key_id: "" },
  ];
  for (const over of bad) {
    const r = await call(goodPublish(over));
    assert.equal(r.statusCode, 400, `${JSON.stringify(over)} → ${r.statusCode}`);
  }
  assert.equal(db.writes.length, 0, "1件も入れていない");
});

// 大文字で書いた16進は、同じハッシュ。小文字に均して入れる
// （エージェントは小文字で突き合わせる）
await it("大文字のハッシュは小文字に均す", async () => {
  st.objects["0.3.1/EIGHT-Agent-Setup.exe"] = SIZE;
  const r = await call(goodPublish({ sha256: SHA.toUpperCase() }));
  assert.equal(r.statusCode, 200);
  assert.equal(db.writes[0].row.sha256, SHA);
});

await it("上がっていないものは入れない", async () => {
  const r = await call(goodPublish());
  assert.equal(r.statusCode, 404);
  assert.equal(db.writes.length, 0);
});

// verify のあとで差し替えられていないか、入れる直前にもう一度見る
await it("大きさが合わなければ入れない", async () => {
  st.objects["0.3.1/EIGHT-Agent-Setup.exe"] = SIZE + 1;
  const r = await call(goodPublish());
  assert.equal(r.statusCode, 409);
  assert.equal(db.writes.length, 0);
});

await it("そろっていれば入れて、配れる状態にする", async () => {
  st.objects["0.3.1/EIGHT-Agent-Setup.exe"] = SIZE;
  const r = await call(goodPublish());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));

  const w = db.writes.find((x) => x.table === "gw_device_releases");
  assert.ok(w, "表に入れている");
  assert.equal(w.row.tenant_id, "t1");
  assert.equal(w.row.version, "0.3.1");
  assert.equal(w.row.bucket, "agent");
  assert.equal(w.row.object_path, "0.3.1/EIGHT-Agent-Setup.exe");
  assert.equal(w.row.sha256, SHA);
  assert.equal(w.row.size_bytes, SIZE);
  assert.equal(w.row.signature, SIG);
  assert.equal(w.row.key_id, KID);
  assert.equal(w.row.published, true);
  // 長く生きるURLは持たない。落とすときに、そのつど短いのを作る
  assert.equal(w.row.url, null);
});

await it("入れたことを記録に残す", async () => {
  st.objects["0.3.1/EIGHT-Agent-Setup.exe"] = SIZE;
  await call(goodPublish());
  const log = audit.find((a) => a.action === "device_release_published");
  assert.ok(log, "監査に残っている");
  assert.equal(log.detail.version, "0.3.1");
  assert.equal(log.detail.by, "github-actions");
});

await it("同時に2つ来たら、後のほうは弾く", async () => {
  st.objects["0.3.1/EIGHT-Agent-Setup.exe"] = SIZE;
  db.insertError = { message: 'duplicate key value violates unique constraint "gw_device_releases_version"' };
  const r = await call(goodPublish());
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "version_exists");
});

// =============================================================================
group("どのテナントのものか");

await it("env があればそれを使う", async () => {
  process.env.DEVICE_RELEASE_TENANT_ID = "t-fixed";
  st.objects["0.3.1/EIGHT-Agent-Setup.exe"] = SIZE;
  await call(goodPublish());
  assert.equal(db.writes[0].row.tenant_id, "t-fixed");
});

// 勝手に1社目を選ぶと、別の会社の台帳に版が入る
await it("会社が複数あれば、選ばずに止める", async () => {
  db.rows.tenants = [{ id: "t1" }, { id: "t2" }];
  const r = await call({ action: "begin", version: "0.3.1" });
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.error, "tenant_unresolved");
  assert.ok(/DEVICE_RELEASE_TENANT_ID/.test(r.body.hint));
});

await it("会社が1つも無ければ止める", async () => {
  db.rows.tenants = [];
  const r = await call({ action: "begin", version: "0.3.1" });
  assert.equal(r.statusCode, 500);
});

// =============================================================================
group("ブラウザ拡張の置き場所");

await it("決めた2つしか置かせない", async () => {
  for (const f of ["", "x.exe", "../../secret", "ext/updates.xml", "UPDATES.XML",
                   "eight-ext.crx "]) {
    const r = await call({ action: "ext", file: f });
    assert.equal(r.statusCode, 400, `file=${JSON.stringify(f)}`);
  }
});

await it("拡張は同じ場所に置き直す", async () => {
  st.objects["ext/eight-ext.crx"] = 10;
  const r = await call({ action: "ext", file: "eight-ext.crx" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.objectPath, "ext/eight-ext.crx");
  assert.equal(r.body.contentType, "application/x-chrome-extension");
  // 先にあるものを消してから。createSignedUploadUrl は、あるものには出ない
  assert.ok(st.calls.some((c) => c.op === "remove"), "先に消している");
});

await it("updates.xml も置ける", async () => {
  const r = await call({ action: "ext", file: "updates.xml" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.objectPath, "ext/updates.xml");
  assert.ok(/xml/.test(r.body.contentType));
});

await it("知らない action は断る", async () => {
  const r = await call({ action: "drop_everything" });
  assert.equal(r.statusCode, 400);
});

// =============================================================================
group("ブラウザが取りにくる口（/ext/）");

const getExt = async (f, method = "GET") => {
  const r = res();
  await ext({ method, url: `/api/ext${f === null ? "" : `?f=${encodeURIComponent(f)}`}`,
              headers: {} }, r);
  return r;
};

await it("決めた2つしか出さない", async () => {
  reset();
  st.objects["ext/updates.xml"] = 10;
  for (const f of ["", "secret.txt", "../0.3.1/EIGHT-Agent-Setup.exe",
                   "ext/updates.xml", "updates.xml/../../x"]) {
    const r = await getExt(f);
    assert.equal(r.statusCode, 404, `f=${JSON.stringify(f)}`);
  }
  const none = await getExt(null);
  assert.equal(none.statusCode, 404);
});

await it("updates.xml を XML として返す", async () => {
  reset();
  const xml = "<?xml version='1.0'?><gupdate><app appid='x'/></gupdate>";
  st.objects["ext/updates.xml"] = xml.length;
  st.bodies["ext/updates.xml"] = xml;
  const r = await getExt("updates.xml");
  assert.equal(r.statusCode, 200);
  assert.ok(/application\/xml/.test(r.headers["content-type"]), r.headers["content-type"]);
  assert.equal(r.raw.toString(), xml);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
});

await it("crx をそのまま返す", async () => {
  reset();
  const body = "Cr24" + " ".repeat(20);
  st.objects["ext/eight-ext.crx"] = body.length;
  st.bodies["ext/eight-ext.crx"] = body;
  const r = await getExt("eight-ext.crx");
  assert.equal(r.statusCode, 200);
  assert.ok(/chrome-extension/.test(r.headers["content-type"]));
  assert.equal(r.raw.slice(0, 4).toString(), "Cr24");
});

// まだ置いていないのは、ふつうに起きる。何が足りないか分かる形で返す
await it("まだ置いていなければ、何をすればよいか返す", async () => {
  reset();
  const r = await getExt("updates.xml");
  assert.equal(r.statusCode, 404);
  assert.ok(/組み立てる/.test(String(r.raw)), String(r.raw));
});

await it("HEAD には中身を返さない", async () => {
  reset();
  st.objects["ext/updates.xml"] = 5;
  st.bodies["ext/updates.xml"] = "<x/>";
  const r = await getExt("updates.xml", "HEAD");
  assert.equal(r.statusCode, 200);
  assert.ok(!r.raw, "中身は返さない");
});

await it("POST は受けない", async () => {
  reset();
  const r = await getExt("updates.xml", "POST");
  assert.equal(r.statusCode, 405);
});

// 合言葉を持っていない人でも読める（ブラウザが取りにくるので）
await it("合言葉なしで読める", async () => {
  reset();
  delete process.env.DEVICE_RELEASE_TOKEN;
  st.objects["ext/updates.xml"] = 4;
  st.bodies["ext/updates.xml"] = "<x/>";
  const r = await getExt("updates.xml");
  assert.equal(r.statusCode, 200);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) { console.log(`${fail} 件 NG`); process.exit(1); }
