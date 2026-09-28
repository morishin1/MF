// 会社の印鑑（api/sign/seals.js）と、署名依頼での押印（api/sign/index.js・api/sign/me.js）を、
// 偽のSupabaseで通す。PDF は本物（lib/pdf-jp.js）で作る。
//
// ■ 何を守るテストか
//   1. PNG・JPEG を登録できる。WebP のまま・不正形式・2MB超は拒否（置いた画像も消す）
//   2. 登録・変更・無効化は owner / admin だけ。人事は有効な印鑑を「選ぶ」だけ。一般・採用・営業は見られない
//   3. 画像は非公開のまま（signed URL だけ。公開URLを作らない）。他社のパスは掴めない
//   4. 送るときに印影を依頼ごとに複製する。無効な印鑑は選べない。印鑑なしでも今までどおり送れる
//   5. 署名時は複製を使う。マスタを差し替えた後でも、送付済みの印影は変わらない
//   6. 署名日時・IP・UA・同意・ハッシュの記録は、印鑑があっても今までどおり残る
//   7. 監査ログ（seal.create / seal.update / seal.disable / esign.seal_selected）に画像やURLを入れない
import assert from "node:assert/strict";
import { mock } from "node:test";
import crypto from "node:crypto";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";
import { png, jpeg, webp } from "./_img.mjs";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ---- 偽の DB ----------------------------------------------------------------
const db = { rows: {} };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const copy = (r) => (r ? { ...r } : null);

function matcher(f) {
  return (r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "neq") return r[k] !== v;
    if (op === "in") return v.includes(r[k]);
    return true;
  });
}

function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter(matcher(f));
    if (order) {
      const [col, asc] = order;
      out = [...out].sort((a, b) => ((a[col] ?? 0) < (b[col] ?? 0) ? (asc ? -1 : 1) : (asc ? 1 : -1)));
    }
    return out;
  };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    order(col, opts) { if (!order) order = [col, opts?.ascending !== false]; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn, rej) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn, rej),
    insert(row) {
      const made = [].concat(row).map((r) => ({ id: r.id || uuid(), created_at: new Date().toISOString(), ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn, rej) => Promise.resolve({ data: made.map(copy), error: null }).then(fn, rej),
      };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        select: () => r2,
        maybeSingle: () => apply(),
        single: () => apply(),
        then: (fn, rej) => apply().then(fn, rej),
      };
      function apply() {
        const hit = (db.rows[name] || []).filter(matcher(g));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve({ data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
  };
  return q;
}

// ---- 偽の Storage（非公開バケット） ---------------------------------------------
const store = new Map();          // "bucket/path" → Buffer
const storageCalls = [];
function storage(bucket) {
  const key = (p) => `${bucket}/${p}`;
  return {
    upload: async (path, bytes, opts) => {
      storageCalls.push(["upload", bucket, path]);
      if (store.has(key(path)) && !opts?.upsert) return { error: { message: "The resource already exists" } };
      store.set(key(path), Buffer.from(bytes));
      return { data: { path }, error: null };
    },
    download: async (path) => {
      const b = store.get(key(path));
      if (!b) return { data: null, error: { message: "not found" } };
      return { data: { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }, error: null };
    },
    remove: async (paths) => { for (const p of paths) store.delete(key(p)); storageCalls.push(["remove", bucket, ...paths]); return { error: null }; },
    createSignedUrl: async (path, ttl) => {
      storageCalls.push(["signedUrl", bucket, path, ttl]);
      return { data: { signedUrl: `https://sb.example/storage/v1/object/sign/${bucket}/${path}?token=t&ttl=${ttl}` }, error: null };
    },
    createSignedUploadUrl: async (path) => ({ data: { signedUrl: `https://sb.example/upload/${bucket}/${path}`, token: "tok" }, error: null }),
    getPublicUrl: () => { throw new Error("公開URLを作ってはいけない"); },
  };
}
// テストから「ブラウザが signed upload URL に PUT した」を再現する
const put = (path, bytes) => store.set(`hr/${path}`, Buffer.from(bytes));

mock.module(atRoot("lib/supabase.js"), {
  namedExports: {
    admin: () => ({ from: table, storage: { from: storage } }),
    userClient: () => ({ from: table, storage: { from: storage } }),
  },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });

const OWNER = { userId: "u-owner", tenantId: "t1", isAdmin: false, isHr: true, roles: ["owner"], employee: { id: "e-owner", display_name: "経営 太郎", email: "o@x.jp" } };
const ADMIN = { userId: "u-admin", tenantId: "t1", isAdmin: true, isHr: false, roles: [], employee: { id: "e-admin", display_name: "管理 花子", email: "a@x.jp" } };
const HR = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], employee: { id: "e-hr", display_name: "人事 次郎", email: "h@x.jp" } };
const MEMBER = { userId: "u-m", tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: { id: "e-m", display_name: "一般 三郎", email: "m@x.jp" } };
const RECRUITER = { ...MEMBER, userId: "u-r", roles: ["recruiter"] };
const SALES = { ...MEMBER, userId: "u-s", roles: ["sales"] };
const OTHER_OWNER = { ...OWNER, userId: "u-o2", tenantId: "t2" };
let who = OWNER;

mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    // lib/gw.js と同じ判定（本物は test/sealtest.mjs で確かめている）
    canManageHr: (c) => Boolean(c.isAdmin || c.isHr),
    canManageSeals: (c) => Boolean(c.isAdmin || (c.roles || []).includes("owner")),
  },
});
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async () => ({ created: 0 }), clearNotification: async () => {} },
});
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async () => {} } });
mock.module(atRoot("lib/onboard-advance.js"), { namedExports: { advanceFor: async () => null } });

const { default: sealsApi } = await import(atRoot("api/sign/seals.js"));
const { default: signApi } = await import(atRoot("api/sign/index.js"));
const { default: meApi } = await import(atRoot("api/sign/me.js"));

// ---- 呼び出しの道具 --------------------------------------------------------
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => {
  const r = res();
  await h({ headers: { authorization: "Bearer x", "x-forwarded-for": "203.0.113.9", "user-agent": "TestUA/1.0", ...(req.headers || {}) }, ...req }, r);
  return r;
};
const list = () => call(sealsApi, { method: "GET", url: "/api/sign/seals" });
const act = (body) => call(sealsApi, { method: "POST", url: "/api/sign/seals", body });

/** 画面と同じ手順：置き場所をもらう → PUT → 登録 */
async function register(bytes, { name = "代表者印", sealType = "representative", mimeType = "image/png", isActive } = {}) {
  const u = await act({ action: "upload", mimeType, sizeBytes: bytes.length });
  if (u.statusCode !== 200) return u;
  put(u.body.path, bytes);
  return act({ action: "create", name, sealType, path: u.body.path, isActive });
}
async function replaceImage(id, bytes) {
  const u = await act({ action: "upload", mimeType: "image/png", sizeBytes: bytes.length });
  put(u.body.path, bytes);
  return act({ action: "update", id, path: u.body.path });
}

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = OWNER;
  logged.length = 0;
  storageCalls.length = 0;
  store.clear();
  db.rows = {
    gw_seals: [], gw_sign_requests: [], gw_sign_events: [], gw_doc_orders: [], gw_role_grants: [],
    gw_onboard_profiles: [], gw_contracts: [],
    gw_employees: [{ id: "e-m", tenant_id: "t1", display_name: "一般 三郎", email: "m@x.jp" }],
    tenants: [{ id: "t1", name: "株式会社エイト" }],
  };
}

const sealImages = async (pdfBytes) => {
  const doc = await PDFDocument.load(pdfBytes);
  const last = doc.getPages()[doc.getPageCount() - 1];
  const xo = last.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
  return xo ? xo.keys().length : 0;
};

/** 送る（adhoc の本文）→ 本人が署名 → 署名済みPDF */
async function sendAndSign({ sealId } = {}) {
  who = HR;
  const s = await call(signApi, { method: "POST", url: "/api/sign", body: {
    title: "雇用契約書", body: "本文です。", employeeIds: ["e-m"], ...(sealId ? { sealId } : {}) } });
  return s;
}
async function signAs(id) {
  who = MEMBER;
  return call(meApi, { method: "POST", url: "/api/sign/me", body: { id, signerName: "一般 三郎", agreed: true } });
}

console.log("— 印鑑の登録（形式・大きさ） —");

await ok("PNG を登録できる（private バケット hr の seals/ に置く）", async () => {
  setup();
  const r = await register(png(40, 40));
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = db.rows.gw_seals[0];
  assert.equal(row.name, "代表者印");
  assert.equal(row.seal_type, "representative");
  assert.equal(row.image_mime, "image/png");
  assert.match(row.image_path, /^t1\/seals\/[\w-]+\.png$/);
  assert.equal(row.image_sha256, sha(png(40, 40)));
  assert.equal(row.is_active, true);
  assert.equal(row.created_by, "u-owner");
});

await ok("JPEG を登録できる", async () => {
  setup();
  const r = await register(jpeg(), { name: "角印", sealType: "square", mimeType: "image/jpeg" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_seals[0].image_mime, "image/jpeg");
  assert.match(db.rows.gw_seals[0].image_path, /\.jpg$/);
});

await ok("WebP のまま届いたら拒否（画面で PNG に変換してから送る）・置いた画像は消す", async () => {
  setup();
  const u = await act({ action: "upload", mimeType: "image/png", sizeBytes: 30 });
  put(u.body.path, webp());
  const r = await act({ action: "create", name: "x", path: u.body.path });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "webp_not_converted");
  assert.equal(store.has(`hr/${u.body.path}`), false);
  assert.equal(db.rows.gw_seals.length, 0);
});

await ok("申告の時点で image/webp・image/gif は置き場所を出さない", async () => {
  setup();
  for (const mimeType of ["image/webp", "image/gif", "application/pdf"]) {
    const r = await act({ action: "upload", mimeType, sizeBytes: 100 });
    assert.equal(r.statusCode, 400, mimeType);
    assert.equal(r.body.error, "unsupported_image");
  }
});

await ok("サイズ超過は拒否（申告でも、中身でも）", async () => {
  setup();
  const r1 = await act({ action: "upload", mimeType: "image/png", sizeBytes: 2 * 1024 * 1024 + 1 });
  assert.equal(r1.statusCode, 400);
  assert.equal(r1.body.error, "file_too_large");
  // 小さいと申告して、大きいものを置いた
  const u = await act({ action: "upload", mimeType: "image/png", sizeBytes: 100 });
  put(u.body.path, Buffer.concat([png(), Buffer.alloc(2 * 1024 * 1024)]));
  const r2 = await act({ action: "create", name: "大きい", path: u.body.path });
  assert.equal(r2.statusCode, 400);
  assert.equal(r2.body.error, "file_too_large");
  assert.equal(store.has(`hr/${u.body.path}`), false);
});

await ok("不正形式（PNG を名乗る PDF）は拒否", async () => {
  setup();
  const u = await act({ action: "upload", mimeType: "image/png", sizeBytes: 100 });
  put(u.body.path, Buffer.from("%PDF-1.4 not an image"));
  const r = await act({ action: "create", name: "偽物", path: u.body.path });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "unsupported_image");
});

await ok("印鑑名が無ければ登録しない", async () => {
  setup();
  const r = await register(png(), { name: "  " });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "no_name");
});

await ok("他社・他の場所のパスは掴めない（契約書PDFなど）", async () => {
  setup();
  put("t1/esign/abc/document.pdf", Buffer.from("%PDF-"));
  for (const path of ["t2/seals/x.png", "t1/esign/abc/document.pdf", "t1/seals/../esign/abc/document.pdf"]) {
    const r = await act({ action: "create", name: "x", path });
    assert.equal(r.statusCode, 403, path);
  }
});

console.log("\n— 権限 —");

await ok("owner / admin だけが登録できる", async () => {
  setup();
  who = ADMIN;
  assert.equal((await register(png())).statusCode, 200);
  who = OWNER;
  assert.equal((await register(png(), { name: "角印" })).statusCode, 200);
});

await ok("人事・一般・採用・営業は登録も変更もできない", async () => {
  setup();
  const made = await register(png());
  const id = made.body.seal.id;
  for (const p of [HR, MEMBER, RECRUITER, SALES]) {
    who = p;
    const u = await act({ action: "upload", mimeType: "image/png", sizeBytes: 10 });
    assert.equal(u.statusCode, 403, `${p.roles} upload`);
    const up = await act({ action: "update", id, isActive: false });
    assert.equal(up.statusCode, 403, `${p.roles} update`);
  }
  assert.equal(db.rows.gw_seals[0].is_active, true);
});

await ok("一般・採用・営業は一覧も見られない", async () => {
  setup();
  await register(png());
  for (const p of [MEMBER, RECRUITER, SALES]) {
    who = p;
    const r = await list();
    assert.equal(r.statusCode, 403, String(p.roles));
  }
});

await ok("人事（署名依頼を出せる人）には有効な印鑑だけを返す", async () => {
  setup();
  await register(png(), { name: "代表者印" });
  await register(png(), { name: "古い角印", sealType: "square", isActive: false });
  who = HR;
  const r = await list();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.seals.map((s) => s.name), ["代表者印"]);
  assert.equal(r.body.canManage, false);
  who = OWNER;
  const r2 = await list();
  assert.deepEqual(r2.body.seals.map((s) => s.name), ["代表者印", "古い角印"]);
  assert.equal(r2.body.canManage, true);
});

await ok("他社の印鑑は見えない・変えられない", async () => {
  setup();
  const made = await register(png());
  who = OTHER_OWNER;
  assert.equal((await list()).body.seals.length, 0);
  const r = await act({ action: "update", id: made.body.seal.id, isActive: false });
  assert.equal(r.statusCode, 404);
});

console.log("\n— 一覧・有効/無効・private URL —");

await ok("一覧の画像は短時間の signed URL（パスや公開URLは返さない）", async () => {
  setup();
  await register(png());
  const r = await list();
  const s = r.body.seals[0];
  assert.match(s.imageUrl, /\/object\/sign\/hr\/t1\/seals\/.+\?token=/);
  assert.equal(s.image_path, undefined);
  assert.equal(JSON.stringify(r.body).includes("/object/public/"), false);
  const signed = storageCalls.filter((c) => c[0] === "signedUrl");
  assert.ok(signed.every((c) => c[1] === "hr" && c[3] <= 600), "hr バケット・10分以内");
});

await ok("無効化・有効化ができ、監査ログに残る（画像・URLは入れない）", async () => {
  setup();
  const made = await register(png());
  const id = made.body.seal.id;
  const off = await act({ action: "update", id, isActive: false });
  assert.equal(off.statusCode, 200);
  assert.equal(db.rows.gw_seals[0].is_active, false);
  const on = await act({ action: "update", id, isActive: true });
  assert.equal(on.statusCode, 200);
  assert.equal(db.rows.gw_seals[0].is_active, true);

  const actions = logged.map((l) => l.action);
  assert.deepEqual(actions, ["seal.create", "seal.disable", "seal.enable"]);
  for (const l of logged) {
    assert.equal(l.detail.sealId, id);
    assert.equal(l.detail.sealName, "代表者印");
    assert.equal(l.actorId, "u-owner");
    const text = JSON.stringify(l);
    assert.equal(/https?:|seals\/|base64|sign\?token/.test(text), false, `ログに画像・URLが入っている: ${text}`);
  }
});

await ok("名前・種類の変更は seal.update", async () => {
  setup();
  const made = await register(png());
  const r = await act({ action: "update", id: made.body.seal.id, name: "代表取締役印", sealType: "contract" });
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows.gw_seals[0].name, "代表取締役印");
  const u = logged.find((l) => l.action === "seal.update");
  assert.deepEqual(u.detail.changed, ["name", "seal_type"]);
  assert.equal(u.detail.previousName, "代表者印");
});

console.log("\n— 電子署名：送付と押印 —");

await ok("印鑑なしで送付できる（今までどおり・印影の列は空）", async () => {
  setup();
  const s = await sendAndSign();
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  assert.equal(s.body.sent.length, 1);
  const req = db.rows.gw_sign_requests[0];
  assert.equal(req.seal_id, undefined);
  assert.equal(req.seal_image_path, undefined);
  const g = await signAs(req.id);
  assert.equal(g.statusCode, 200, JSON.stringify(g.body));
  const pdf = store.get(`hr/${req.signed_pdf_path}`);
  assert.equal(await sealImages(pdf), 0);
  assert.equal(logged.some((l) => l.action === "esign.seal_selected"), false);
});

await ok("代表者印を選んで送付 → 依頼ごとに印影を複製し、署名済PDFに押される", async () => {
  setup();
  const img = png(50, 50, [190, 20, 20, 200]);
  const made = await register(img);
  const sealId = made.body.seal.id;

  const s = await sendAndSign({ sealId });
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  const req = db.rows.gw_sign_requests[0];
  assert.equal(req.seal_id, sealId);
  assert.equal(req.seal_name, "代表者印");
  assert.equal(req.seal_type, "representative");
  assert.equal(req.seal_image_path, `t1/esign/${req.id}/seal.png`);
  assert.equal(req.seal_image_sha256, sha(img));
  assert.deepEqual(store.get(`hr/${req.seal_image_path}`), img, "送付時点の画像をそのまま複製");

  const sel = logged.find((l) => l.action === "esign.seal_selected");
  assert.equal(sel.target, `sign_request:${req.id}`);
  assert.equal(sel.detail.sealId, sealId);
  assert.equal(sel.detail.sealName, "代表者印");
  assert.equal(sel.detail.requestId, req.id);
  assert.equal(/https?:|seals\//.test(JSON.stringify(sel)), false);

  const g = await signAs(req.id);
  assert.equal(g.statusCode, 200, JSON.stringify(g.body));
  const pdf = store.get(`hr/${req.signed_pdf_path}`);
  assert.equal(await sealImages(pdf), 1, "記録ページに印影");
});

await ok("角印（JPEG）を選んで送付・署名できる", async () => {
  setup();
  const made = await register(jpeg(30, 30), { name: "角印", sealType: "square", mimeType: "image/jpeg" });
  const s = await sendAndSign({ sealId: made.body.seal.id });
  assert.equal(s.statusCode, 200, JSON.stringify(s.body));
  const req = db.rows.gw_sign_requests[0];
  assert.match(req.seal_image_path, /seal\.jpg$/);
  const g = await signAs(req.id);
  assert.equal(g.statusCode, 200, JSON.stringify(g.body));
  assert.equal(await sealImages(store.get(`hr/${req.signed_pdf_path}`)), 1);
});

await ok("無効な印鑑・他社の印鑑は選べない（送らない）", async () => {
  setup();
  const made = await register(png(), { isActive: false });
  const s = await sendAndSign({ sealId: made.body.seal.id });
  assert.equal(s.statusCode, 400);
  assert.equal(s.body.error, "seal_not_available");
  assert.equal(db.rows.gw_sign_requests.length, 0);
  const s2 = await sendAndSign({ sealId: "does-not-exist" });
  assert.equal(s2.statusCode, 400);
});

await ok("印鑑マスタを差し替えても、送付済み・締結済みの印影は変わらない", async () => {
  setup();
  const imgA = png(50, 50, [200, 0, 0, 255]);
  const imgB = png(64, 64, [0, 0, 200, 255]);
  const made = await register(imgA);
  const sealId = made.body.seal.id;

  // 1通目：署名まで済ませる
  await sendAndSign({ sealId });
  const done = db.rows.gw_sign_requests[0];
  await signAs(done.id);
  const signedBefore = Buffer.from(store.get(`hr/${done.signed_pdf_path}`));

  // 2通目：送っただけ（未署名）
  await sendAndSign({ sealId });
  const open = db.rows.gw_sign_requests[1];

  // マスタの画像を B に差し替える（古い画像はマスタからは消える）
  who = OWNER;
  const oldMasterPath = db.rows.gw_seals[0].image_path;
  const r = await replaceImage(sealId, imgB);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_seals[0].image_sha256, sha(imgB));
  assert.equal(store.has(`hr/${oldMasterPath}`), false);

  // 締結済み：PDF も記録も変わらない
  assert.deepEqual(store.get(`hr/${done.signed_pdf_path}`), signedBefore);
  assert.equal(db.rows.gw_sign_requests[0].seal_image_sha256, sha(imgA));

  // 送付済み（未署名）：署名すると、送った時点の A が押される
  logged.length = 0;
  const g = await signAs(open.id);
  assert.equal(g.statusCode, 200, JSON.stringify(g.body));
  const ev = db.rows.gw_sign_events.find((e) => e.request_id === open.id && e.action === "signed");
  assert.equal(ev.detail.sealSha256, sha(imgA), "複製（A）を使っている");

  // 3通目：差し替え後に送ると B
  await sendAndSign({ sealId });
  assert.equal(db.rows.gw_sign_requests[2].seal_image_sha256, sha(imgB));
});

await ok("印影の複製が送付後に書き換えられていたら、署名させない", async () => {
  setup();
  const made = await register(png());
  await sendAndSign({ sealId: made.body.seal.id });
  const req = db.rows.gw_sign_requests[0];
  store.set(`hr/${req.seal_image_path}`, png(9, 9, [0, 255, 0, 255]));
  const g = await signAs(req.id);
  assert.equal(g.statusCode, 500);
  assert.equal(g.body.error, "seal_hash_mismatch");
  assert.equal(db.rows.gw_sign_requests[0].status, "sent");
});

await ok("印鑑があっても、署名日時・IP・UA・同意・ハッシュの記録は今までどおり残る", async () => {
  setup();
  const made = await register(png());
  await sendAndSign({ sealId: made.body.seal.id });
  const req = db.rows.gw_sign_requests[0];
  const g = await signAs(req.id);
  assert.equal(g.statusCode, 200);
  const row = db.rows.gw_sign_requests[0];
  assert.equal(row.status, "signed");
  assert.ok(row.signed_at);
  assert.equal(row.signer_name, "一般 三郎");
  assert.equal(row.signer_email, "m@x.jp");
  assert.equal(row.signer_ip, "203.0.113.9");
  assert.equal(row.signer_ua, "TestUA/1.0");
  assert.ok(row.agreed_text && row.agreed_text.length > 5);
  assert.match(row.pdf_sha256, /^[0-9a-f]{64}$/);
  assert.equal(row.signed_pdf_sha256, sha(store.get(`hr/${row.signed_pdf_path}`)));
  assert.equal(g.body.hash, row.pdf_sha256, "文書ハッシュは署名前PDFのまま");
  // 署名前のPDFは書き換えていない
  assert.equal(sha(store.get(`hr/${row.pdf_path}`)), row.pdf_sha256);
});

await ok("署名の状況の一覧に、使った印鑑の名前が出る", async () => {
  setup();
  const made = await register(png());
  await sendAndSign({ sealId: made.body.seal.id });
  who = HR;
  const r = await call(signApi, { method: "GET", url: "/api/sign" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.requests[0].seal_name, "代表者印");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
