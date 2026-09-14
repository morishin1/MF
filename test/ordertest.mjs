// 書類の作成依頼のAPIを、偽のSupabaseで通す。
// いちばん守りたいのは
//   ・宛先は最初に決まっていて、送るときに人が打ち直さない
//   ・届いた書面と、送った書面が同じ（ハッシュが合う）
//   ・送ったあとは差し替えられない
import assert from "node:assert/strict";
import { mock } from "node:test";
import crypto from "node:crypto";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, writes: [], files: {}, storage: [] };

// db/056 と db/046 の default（本物のPostgresが入れるもの）
const DEFAULTS = {
  gw_doc_orders: { status: "requested", doc_kind: "employment", conditions: {},
                   requested_at: new Date().toISOString() },
  gw_sign_requests: { status: "sent", source: "generated", resent_count: 0,
                      sent_at: new Date().toISOString() },
};

function table(name) {
  const f = [];
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq(k, v) { f.push(["!" + k, v]); return q; },
    is() { return q; },
    in(k, vs) { f.push([k, vs]); return q; },
    order() { return q; },
    limit() { return q; },
    // 本物は写しを返す。ここで元の行をそのまま渡すと、
    // あとで update したときに読んだ側まで書き換わってしまう
    maybeSingle() { return Promise.resolve({ data: copy(pick(name, f)), error: err(name) }); },
    single() { return Promise.resolve({ data: copy(pick(name, f)), error: err(name) }); },
    then(fn) {
      return Promise.resolve({ data: match(name, f).map(copy), error: err(name) }).then(fn);
    },
    update(row) {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        is: () => r,
        select: () => r,
        single: () => {
          const cur = pick(name, g);
          if (cur) Object.assign(cur, row);
          db.writes.push({ op: "update", table: name, row, where: g });
          return Promise.resolve({ data: cur ? { ...cur } : { ...row }, error: err(name) });
        },
        then: (fn) => {
          for (const cur of match(name, g)) Object.assign(cur, row);
          db.writes.push({ op: "update", table: name, row, where: g });
          return Promise.resolve({ data: [row], error: err(name) }).then(fn);
        },
      };
      return r;
    },
    insert(row) {
      // 本物は列の default を入れて返す。ここも同じにしないと、
      // 「APIが status を返していない」ように見えてしまう
      const made = { ...(DEFAULTS[name] || {}), id: row.id || `new-${db.writes.length + 1}`, ...row };
      db.writes.push({ op: "insert", table: name, row: made });
      (db.rows[name] = db.rows[name] || []).push(made);
      const r = {
        select: () => r,
        single: () => Promise.resolve({ data: err(name) ? null : made, error: err(name) }),
        then: (fn) => Promise.resolve({ data: [made], error: err(name) }).then(fn),
      };
      return r;
    },
  };
  return q;
}
const err = (name) => (db.missing === name
  ? { code: "PGRST205", message: "Could not find the table" } : null);
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([k, v]) => {
  if (k.startsWith("!")) return r[k.slice(1)] !== v;
  return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
}));
const pick = (name, filters) => match(name, filters)[0] || null;
const copy = (r) => (r ? { ...r } : r);

const storage = {
  from: () => ({
    createSignedUploadUrl: async (path) => ({ data: { signedUrl: `https://x/up/${path}`, token: "t" }, error: null }),
    createSignedUrl: async (path, ttl, opts) => {
      db.storage.push({ op: "signed", path, ttl, opts });
      return db.files[path]
        ? { data: { signedUrl: `https://x/get/${path}` }, error: null }
        : { data: null, error: { message: "not found" } };
    },
    download: async (path) => (db.files[path]
      ? { data: { arrayBuffer: async () => db.files[path] }, error: null }
      : { data: null, error: { message: "not found" } }),
    upload: async (path, bytes) => {
      if (db.files[path]) return { data: null, error: { message: "exists" } };
      db.files[path] = Buffer.from(bytes);
      db.storage.push({ op: "upload", path });
      return { data: { path }, error: null };
    },
    remove: async (paths) => {
      for (const p of paths) delete db.files[p];
      db.storage.push({ op: "remove", paths });
      return { data: null, error: null };
    },
  }),
};

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table, storage }), userClient: () => ({ from: table, storage }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1", email: "hr@8grp.co.jp" }),
                  getMemberships: async () => [] },
});
let isHr = true;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => ({
      tenantId: "t1", isAdmin: true, roles: ["hr"],
      employee: { id: "emp-hr", display_name: "人事 太郎" },
    }),
    canManageHr: () => isHr,
  },
});
const notified = [];
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async (n) => { notified.push(...n); }, clearNotification: async () => {} },
});
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async () => {} } });
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
const signEvents = [];
mock.module(atRoot("lib/sign-audit.js"), {
  namedExports: {
    signEvent: async (ctx, id, action, req, actor, detail) => { signEvents.push({ id, action, detail }); },
    ipOf: () => "1.2.3.4", uaOf: () => "test",
  },
});

const { default: orders } = await import(atRoot("api/sign/orders.js"));
const { default: file } = await import(atRoot("api/sign/file.js"));
const { ORDER_FIELDS, missingConditions, normalizeConditions } =
  await import(atRoot("lib/esign.js"));

// ---- 偽の req/res ---------------------------------------------------------
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const post = (body) => ({ method: "POST", url: "/api/sign/orders", body,
                          headers: { authorization: "Bearer x" } });
const get = (qs = "") => ({ method: "GET", url: `/api/sign/orders${qs}`,
                            headers: { authorization: "Bearer x" } });

const call = async (handler, req) => { const r = res(); await handler(req, r); return r; };

// 本物のPDFの先頭。isPdf を通すため
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("x".repeat(200))]);
const NOT_PDF = Buffer.from("これはPDFではありません");

const FULL = Object.fromEntries(ORDER_FIELDS.filter((f) => f.required).map((f) => [f.key, "あり"]));

const reset = () => {
  db.rows = {
    gw_employees: [{ id: "emp-1", tenant_id: "t1", display_name: "山田 太郎",
                     department: "制作部", user_id: "u-9" }],
    gw_doc_orders: [],
    gw_sign_requests: [],
  };
  db.writes = []; db.files = {}; db.storage = []; db.missing = null;
  notified.length = 0; logged.length = 0; signEvents.length = 0;
  isHr = true;
};

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log("  ok", name); };

console.log("\n== lib/esign.js の条件 ==");
await ok("必須が空なら、どれが空か返る", () => {
  const m = missingConditions({});
  assert.ok(m.includes("賃金"));
  assert.ok(m.length >= 5);
});
await ok("知らない項目は落とす", () => {
  const c = normalizeConditions({ 賃金: "月給30万", こっそり: "入れた" });
  assert.deepEqual(Object.keys(c), ["賃金"]);
});
await ok("空文字は入れない", () => {
  assert.deepEqual(normalizeConditions({ 賃金: "   " }), {});
});

console.log("\n== 依頼を作る ==");
await ok("誰あてか無ければ断る", async () => {
  reset();
  const r = await call(orders, post({ action: "create", conditions: FULL }));
  assert.equal(r.statusCode, 400);
});
await ok("名簿に無い人には作らせない", async () => {
  reset();
  const r = await call(orders, post({ action: "create", employeeId: "emp-x", conditions: FULL }));
  assert.equal(r.statusCode, 404);
});
await ok("必須が空なら止める", async () => {
  reset();
  const r = await call(orders, post({ action: "create", employeeId: "emp-1", conditions: {} }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "missing_conditions");
  assert.ok(r.body.missing.includes("賃金"));
});
await ok("force なら空のままでも作る", async () => {
  reset();
  const r = await call(orders, post({ action: "create", employeeId: "emp-1", conditions: {}, force: true }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.order.status, "requested");
  assert.ok(r.body.missing.length > 0, "空のまま作ったことは返す");
});
await ok("宛先は作るときに決まる", async () => {
  reset();
  const r = await call(orders, post({
    action: "create", employeeId: "emp-1", conditions: FULL,
    title: "労働条件通知書 兼 雇用契約書", assigneeName: "○○社労士事務所",
  }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.order.employeeId, "emp-1");
  assert.equal(r.body.order.title, "労働条件通知書 兼 雇用契約書");
  assert.ok(logged.some((l) => l.action === "doc_order.create"));
});
await ok("名前を省くと種類の名前が入る", async () => {
  reset();
  const r = await call(orders, post({ action: "create", employeeId: "emp-1", conditions: FULL }));
  assert.equal(r.body.order.title, "労働条件通知書・雇用契約書");
});
await ok("人事でなければ触れない", async () => {
  reset(); isHr = false;
  const r = await call(orders, post({ action: "create", employeeId: "emp-1", conditions: FULL }));
  assert.equal(r.statusCode, 403);
});

// ---- ここから、依頼が1件ある状態で回す ----
const seed = async (over = {}) => {
  reset();
  const r = await call(orders, post({
    action: "create", employeeId: "emp-1", conditions: FULL, title: "労働条件通知書",
  }));
  const o = db.rows.gw_doc_orders[0];
  Object.assign(o, over);
  return o;
};

console.log("\n== 書面を取り込む ==");
await ok("他の依頼の置き場所は掴ませない", async () => {
  const o = await seed();
  const r = await call(orders, post({
    action: "attach", id: o.id, path: `t1/doc-order/ほかの依頼/x.pdf`, filename: "x.pdf",
  }));
  assert.equal(r.statusCode, 403);
});
await ok("他社の置き場所も掴ませない", async () => {
  const o = await seed();
  const r = await call(orders, post({
    action: "attach", id: o.id, path: `t2/doc-order/${o.id}/x.pdf`, filename: "x.pdf",
  }));
  assert.equal(r.statusCode, 403);
});
await ok("PDFでないものは受け取らず、置いたものも消す", async () => {
  const o = await seed();
  const p = `t1/doc-order/${o.id}/a.pdf`;
  db.files[p] = NOT_PDF;
  const r = await call(orders, post({ action: "attach", id: o.id, path: p, filename: "a.pdf" }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "not_pdf");
  assert.ok(!db.files[p], "受け取らなかったものは残さない");
});
await ok("取り込むと『確認待ち』になり、ハッシュが残る", async () => {
  const o = await seed();
  const p = `t1/doc-order/${o.id}/a.pdf`;
  db.files[p] = PDF;
  const r = await call(orders, post({ action: "attach", id: o.id, path: p, filename: "通知書.pdf" }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.order.status, "uploaded");
  assert.equal(r.body.order.fileName, "通知書.pdf");
  assert.equal(r.body.order.fileHash, crypto.createHash("sha256").update(PDF).digest("hex"));
});
await ok("差し替えると、前の版は残さない", async () => {
  const o = await seed();
  const p1 = `t1/doc-order/${o.id}/a.pdf`;
  const p2 = `t1/doc-order/${o.id}/b.pdf`;
  db.files[p1] = PDF;
  await call(orders, post({ action: "attach", id: o.id, path: p1, filename: "a.pdf" }));
  db.files[p2] = Buffer.concat([PDF, Buffer.from("2")]);
  await call(orders, post({ action: "attach", id: o.id, path: p2, filename: "b.pdf" }));
  assert.ok(!db.files[p1], "古い版が残っている");
  assert.ok(db.files[p2]);
});

console.log("\n== そのまま署名依頼を出す ==");
const withFile = async (over = {}) => {
  const o = await seed();
  const p = `t1/doc-order/${o.id}/a.pdf`;
  db.files[p] = PDF;
  await call(orders, post({ action: "attach", id: o.id, path: p, filename: "通知書.pdf" }));
  Object.assign(db.rows.gw_doc_orders[0], over);
  return db.rows.gw_doc_orders[0];
};

await ok("書面が無ければ送らない", async () => {
  const o = await seed();
  const r = await call(orders, post({ action: "send", id: o.id }));
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "no_file");
});
await ok("ログインできない人には送らない", async () => {
  const o = await withFile();
  db.rows.gw_employees[0].user_id = null;
  const r = await call(orders, post({ action: "send", id: o.id }));
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "no_account");
});
await ok("取り込んだあとに中身が変わっていたら送らない", async () => {
  const o = await withFile();
  db.files[o.file_path] = Buffer.concat([PDF, Buffer.from("すりかえ")]);
  const r = await call(orders, post({ action: "send", id: o.id }));
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.error, "hash_mismatch");
});
await ok("送ると、受け取ったPDFのまま署名依頼ができる", async () => {
  const o = await withFile();
  const r = await call(orders, post({ action: "send", id: o.id, dueOn: "2026-10-01" }));
  assert.equal(r.statusCode, 200);

  const sr = db.rows.gw_sign_requests[0];
  assert.equal(sr.source, "uploaded", "受け取った書面だと分かるようにする");
  assert.equal(sr.employee_id, "emp-1", "宛先は依頼で決まっている");
  assert.equal(sr.due_on, "2026-10-01");
  assert.equal(sr.file_name, "通知書.pdf");
  assert.equal(sr.pdf_sha256, crypto.createHash("sha256").update(PDF).digest("hex"));
  assert.ok(sr.body_snapshot.includes("通知書.pdf"), "本人の画面に出す案内が入る");

  // 依頼の書面とは別のパスに写す。あとから差し替わらないように
  assert.notEqual(sr.pdf_path, o.file_path);
  assert.ok(db.files[sr.pdf_path], "署名用のPDFが置かれていない");

  assert.equal(db.rows.gw_doc_orders[0].status, "sent");
  assert.equal(db.rows.gw_doc_orders[0].sign_request_id, sr.id);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].employeeId, "emp-1");
  assert.ok(signEvents.some((e) => e.action === "sent"));
});
await ok("期限を省くと7日後が入る", async () => {
  const o = await withFile();
  await call(orders, post({ action: "send", id: o.id }));
  const want = new Date(Date.now() + 9 * 3600000 + 7 * 86400000).toISOString().slice(0, 10);
  assert.equal(db.rows.gw_sign_requests[0].due_on, want);
});
await ok("2回目は送らない", async () => {
  const o = await withFile();
  await call(orders, post({ action: "send", id: o.id }));
  const r = await call(orders, post({ action: "send", id: o.id }));
  assert.equal(r.statusCode, 409);
  assert.equal(db.rows.gw_sign_requests.length, 1);
});
await ok("取り消した依頼からは送らない", async () => {
  const o = await withFile({ status: "cancelled" });
  const r = await call(orders, post({ action: "send", id: o.id }));
  assert.equal(r.statusCode, 409);
});

console.log("\n== 送ったあと ==");
await ok("送ったあとは条件を直せない", async () => {
  const o = await withFile();
  await call(orders, post({ action: "send", id: o.id }));
  const r = await call(orders, post({ action: "update", id: o.id, note: "あとから足す" }));
  assert.equal(r.statusCode, 409);
});
await ok("送ったあとは差し替えられない", async () => {
  const o = await withFile();
  await call(orders, post({ action: "send", id: o.id }));
  const r = await call(orders, post({ action: "upload", id: o.id, sizeBytes: 100 }));
  assert.equal(r.statusCode, 409);
});
await ok("締結ずみは取り消せない", async () => {
  const o = await withFile({ status: "signed" });
  const r = await call(orders, post({ action: "cancel", id: o.id }));
  assert.equal(r.statusCode, 409);
});
await ok("届く前なら取り消せる", async () => {
  const o = await seed();
  const r = await call(orders, post({ action: "cancel", id: o.id }));
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows.gw_doc_orders[0].status, "cancelled");
});

console.log("\n== 一覧と閲覧 ==");
await ok("一覧は、状態の数も返す", async () => {
  await withFile();
  const r = await call(orders, get());
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.counts.uploaded, 1);
  assert.ok(r.body.fields.length >= 8, "画面が使う項目の定義も返す");
});
await ok("表が無ければ、どのSQLを流すか言う", async () => {
  reset();
  db.missing = "gw_doc_orders";
  const r = await call(orders, get());
  assert.equal(r.statusCode, 503);
  assert.match(r.body.message, /056_doc_orders\.sql/);
});
await ok("届いた書面を開くと、監査ログに残る", async () => {
  const o = await withFile();
  const r = await call(orders, get(`?file=${o.id}`));
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.url.includes(o.file_path));
  assert.ok(logged.some((l) => l.action === "doc_order.view"));
});
await ok("書面が無い依頼は開けない", async () => {
  const o = await seed();
  const r = await call(orders, get(`?file=${o.id}`));
  assert.equal(r.statusCode, 404);
});

console.log("\n== 保存できること（労基則5条） ==");
const fileReq = (qs) => ({ method: "GET", url: `/api/sign/file${qs}`,
                           headers: { authorization: "Bearer x" } });
await ok("download=1 なら、保存になるURLを返す", async () => {
  const o = await withFile();
  await call(orders, post({ action: "send", id: o.id }));
  const sr = db.rows.gw_sign_requests[0];
  sr.signed_pdf_path = null;

  const r = await call(file, fileReq(`?id=${sr.id}&download=1`));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.download, true);
  assert.equal(r.body.filename, "労働条件通知書.pdf");
  const last = db.storage.filter((s) => s.op === "signed").pop();
  assert.equal(last.opts.download, "労働条件通知書.pdf", "保存の指示が付いていない");
});
await ok("download を付けなければ、今までどおり開く", async () => {
  const o = await withFile();
  await call(orders, post({ action: "send", id: o.id }));
  const sr = db.rows.gw_sign_requests[0];
  const r = await call(file, fileReq(`?id=${sr.id}`));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.download, false);
  const last = db.storage.filter((s) => s.op === "signed").pop();
  assert.equal(last.opts, undefined);
});
await ok("ファイル名に区切り文字が入っても落とす", async () => {
  const o = await withFile();
  db.rows.gw_doc_orders[0].title = "労働条件/通知書:2026";
  await call(orders, post({ action: "send", id: o.id }));
  const sr = db.rows.gw_sign_requests[0];
  sr.signed_pdf_path = null;
  const r = await call(file, fileReq(`?id=${sr.id}&download=1`));
  assert.ok(!r.body.filename.includes("/"));
  assert.ok(!r.body.filename.includes(":"));
});

console.log(`\n合計 ${n} 件 通過`);
