// 採用の応募書類（api/hr/documents.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//   1. 採用を扱える人（管理者・経営者・人事・採用担当）だけ。営業だけの人・一般メンバーは 403
//   2. PDF・DOC・DOCX・JPEG・PNG を中身で判定。10MB まで。不正形式は置いた実体も消す
//   3. 置き場所のすり替え（他の応募者・他社・契約書）を受け付けない
//   4. 差し替えても前の版を残す（最新＋履歴）。削除は実体を消し、記録は残す。前の版が最新に戻る
//   5. 見るときは private バケットの短時間 signed URL（公開URLを作らない）
//   6. 応募者一覧に、履歴書・職務経歴書のそろい具合が出る
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { png, jpeg } from "./_img.mjs";

const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の DB ----------------------------------------------------------------
const db = { rows: {} };
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const copy = (r) => (r ? { ...r } : null);
function matcher(f) {
  return (r) => f.every(([op, k, v]) => (op === "eq" ? r[k] === v : op === "in" ? v.includes(r[k]) : true));
}
function table(name) {
  const f = [];
  let order = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter(matcher(f));
    if (order) {
      const [col, asc] = order;
      out = [...out].sort((a, b) => ((a[col] ?? "") < (b[col] ?? "") ? (asc ? -1 : 1) : (a[col] ?? "") > (b[col] ?? "") ? (asc ? 1 : -1) : 0));
    }
    return out;
  };
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    order(col, opts) { if (!order) order = [col, opts?.ascending !== false]; return q; },
    limit() { return q; },
    not() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn, rej) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn, rej),
    insert(row) {
      const made = [].concat(row).map((r) => ({ id: r.id || uuid(), ...r }));
      (db.rows[name] = db.rows[name] || []).push(...made);
      const r2 = { select: () => r2, single: () => Promise.resolve({ data: copy(made[0]), error: null }),
        then: (fn, rej) => Promise.resolve({ data: made.map(copy), error: null }).then(fn, rej) };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; }, select: () => r2,
        maybeSingle: () => apply(), then: (fn, rej) => apply().then(fn, rej),
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

// ---- 偽の Storage（private バケット） -----------------------------------------
const store = new Map();
const signed = [];
function storage(bucket) {
  const key = (p) => `${bucket}/${p}`;
  return {
    download: async (p) => {
      const b = store.get(key(p));
      return b ? { data: { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) }, error: null }
        : { data: null, error: { message: "not found" } };
    },
    remove: async (paths) => { for (const p of paths) store.delete(key(p)); return { error: null }; },
    createSignedUrl: async (p, ttl, opts) => {
      signed.push({ bucket, path: p, ttl, download: opts?.download || null });
      return { data: { signedUrl: `https://sb.example/storage/v1/object/sign/${bucket}/${p}?token=t` }, error: null };
    },
    createSignedUploadUrl: async (p) => ({ data: { signedUrl: `https://sb.example/upload/${bucket}/${p}`, token: "t" }, error: null }),
    getPublicUrl: () => { throw new Error("公開URLを作ってはいけない"); },
  };
}
const put = (path, bytes) => store.set(`hr/${path}`, Buffer.from(bytes));

mock.module(atRoot("lib/supabase.js"), {
  namedExports: {
    admin: () => ({ from: table, storage: { from: storage } }),
    userClient: () => ({ from: table, storage: { from: storage } }),
  },
});
mock.module(atRoot("lib/auth.js"), { namedExports: { requireUser: async () => ({ id: who.userId }), getMemberships: async () => [] } });
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });

const RECRUITER = { userId: "u-rec", tenantId: "t1", isAdmin: false, isHr: false, roles: ["recruiter"], employee: { id: "e-rec" } };
const HR = { userId: "u-hr", tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], employee: { id: "e-hr" } };
// 会計側の管理者だけ（社内権限なし）。採用書類は見られない
const ADMIN = { userId: "u-ad", tenantId: "t1", isAdmin: true, isHr: true, roles: [], employee: { id: "e-ad" } };
const OWNER = { userId: "u-ow", tenantId: "t1", isAdmin: false, isHr: true, roles: ["owner"], employee: { id: "e-ow" } };
const IT = { userId: "u-it", tenantId: "t1", isAdmin: false, isHr: false, roles: ["it"], employee: { id: "e-it" } };
const SALES = { userId: "u-s", tenantId: "t1", isAdmin: false, isHr: false, roles: ["sales"], employee: { id: "e-s" } };
const MANAGER = { userId: "u-m", tenantId: "t1", isAdmin: false, isHr: false, roles: ["manager"], employee: { id: "e-m" } };
const MEMBER = { userId: "u-x", tenantId: "t1", isAdmin: false, isHr: false, roles: [], employee: { id: "e-x" } };
const OTHER = { userId: "u-o", tenantId: "t2", isAdmin: true, isHr: true, roles: ["owner"], employee: { id: "e-o" } };
let who = RECRUITER;
const real = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), {
  namedExports: { gwContext: async () => who, canRecruit: real.canRecruit, canManageHr: real.canManageHr },
});

const { default: docsApi } = await import(atRoot("api/hr/documents.js"));
const { default: listApi } = await import(atRoot("api/hr/applicants/index.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const get = (qs) => call(docsApi, { method: "GET", url: `/api/hr/documents?${qs}` });
const post = (body) => call(docsApi, { method: "POST", url: "/api/hr/documents", body });
const del = (id) => call(docsApi, { method: "DELETE", url: `/api/hr/documents?id=${id}` });

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");
const DOC = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from("word/document.xml")]);
const XLSX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from("xl/workbook.xml")]);
const MIME = {
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  jpg: "image/jpeg", png: "image/png",
};

/** 画面と同じ手順：置き場所 → PUT → 登録 */
async function upload(applicantId, docType, bytes, mimeType, filename) {
  const u = await post({ action: "upload", applicantId, docType, mimeType, sizeBytes: bytes.length });
  if (u.statusCode !== 200) return u;
  put(u.body.path, bytes);
  return post({ action: "attach", applicantId, docType, path: u.body.path, filename });
}

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = RECRUITER;
  store.clear(); signed.length = 0; logged.length = 0;
  db.rows = {
    gw_hr_applicants: [
      { id: "ap1", tenant_id: "t1", name: "山田 太郎", job_title: "エンジニア", source: "Wantedly", stage: "applied", status: "todo", created_at: "2026-09-01" },
      { id: "ap2", tenant_id: "t1", name: "佐藤 花子", job_title: "営業", source: "リファラル", stage: "applied", status: "todo", created_at: "2026-09-02" },
      { id: "ap9", tenant_id: "t2", name: "他社の応募者", job_title: "x", source: "x", stage: "applied", status: "todo", created_at: "2026-09-03" },
    ],
    gw_hr_documents: [], gw_hr_interviews: [], gw_employees: [{ user_id: "u-rec", tenant_id: "t1", id: "e-rec", display_name: "採用 担当" }],
  };
}

console.log("— 権限 —");
await ok("採用担当・人事・経営者は使える（社内権限で決まる）", async () => {
  setup();
  for (const p of [RECRUITER, HR, OWNER]) {
    who = p;
    assert.equal((await get("applicantId=ap1")).statusCode, 200, String(p.roles));
  }
});
await ok("営業・責任者・一般メンバー・会計の管理者だけ・IT・管理だけの人には採用書類を見せない（403）", async () => {
  setup();
  await upload("ap1", "resume", PDF, MIME.pdf, "山田太郎_履歴書.pdf");
  const id = db.rows.gw_hr_documents[0].id;
  for (const p of [SALES, MANAGER, MEMBER, ADMIN, IT]) {
    who = p;
    assert.equal((await get("applicantId=ap1")).statusCode, 403, `${p.roles}${p.isAdmin ? "（会計の管理者）" : ""} 一覧`);
    assert.equal((await get(`id=${id}`)).statusCode, 403, `${p.roles} URL`);
    assert.equal((await post({ action: "upload", applicantId: "ap1", docType: "resume", mimeType: MIME.pdf, sizeBytes: 10 })).statusCode, 403);
    assert.equal((await del(id)).statusCode, 403);
  }
  assert.equal(signed.length, 0, "URL は1つも出していない");
});
await ok("他社の応募者・書類には触れない", async () => {
  setup();
  await upload("ap1", "resume", PDF, MIME.pdf, "a.pdf");
  const id = db.rows.gw_hr_documents[0].id;
  who = OTHER;
  assert.equal((await get("applicantId=ap1")).statusCode, 404);
  assert.equal((await get(`id=${id}`)).statusCode, 404);
  assert.equal((await del(id)).statusCode, 404);
  who = RECRUITER;
  assert.equal((await get("applicantId=ap9")).statusCode, 404, "他社の応募者は見えない");
});

console.log("\n— 形式・大きさ —");
await ok("PDF・DOC・DOCX・JPG・PNG を登録できる", async () => {
  setup();
  for (const [bytes, mime, name] of [[PDF, MIME.pdf, "a.pdf"], [DOC, MIME.doc, "b.doc"], [DOCX, MIME.docx, "c.docx"],
    [jpeg(), MIME.jpg, "d.jpg"], [png(), MIME.png, "e.png"]]) {
    const r = await upload("ap1", "other", bytes, mime, name);
    assert.equal(r.statusCode, 200, `${name}: ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual(db.rows.gw_hr_documents.map((d) => d.mime_type), [MIME.pdf, MIME.doc, MIME.docx, MIME.jpg, MIME.png]);
  assert.ok(db.rows.gw_hr_documents.every((d) => d.storage_path.startsWith("t1/recruit/ap1/")), "private バケット hr の recruit/ に置く");
});
await ok("10MB 超は拒否（申告でも中身でも）", async () => {
  setup();
  const r1 = await post({ action: "upload", applicantId: "ap1", docType: "resume", mimeType: MIME.pdf, sizeBytes: 10 * 1024 * 1024 + 1 });
  assert.equal(r1.body.error, "file_too_large");
  const u = await post({ action: "upload", applicantId: "ap1", docType: "resume", mimeType: MIME.pdf, sizeBytes: 100 });
  put(u.body.path, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]));
  const r2 = await post({ action: "attach", applicantId: "ap1", docType: "resume", path: u.body.path, filename: "big.pdf" });
  assert.equal(r2.body.error, "file_too_large");
  assert.equal(store.has(`hr/${u.body.path}`), false, "置いた実体は消す");
});
await ok("不正形式は拒否（GIF の申告・PDF を名乗る exe・Excel を名乗る docx）", async () => {
  setup();
  assert.equal((await post({ action: "upload", applicantId: "ap1", docType: "resume", mimeType: "image/gif", sizeBytes: 10 })).body.error, "unsupported_file");
  for (const [bytes, mime] of [[Buffer.from("MZ\x90\x00 exe"), MIME.pdf], [XLSX, MIME.docx]]) {
    const u = await post({ action: "upload", applicantId: "ap1", docType: "resume", mimeType: mime, sizeBytes: bytes.length });
    put(u.body.path, bytes);
    const r = await post({ action: "attach", applicantId: "ap1", docType: "resume", path: u.body.path, filename: "x" });
    assert.equal(r.body.error, "unsupported_file");
    assert.equal(store.has(`hr/${u.body.path}`), false);
  }
  assert.equal(db.rows.gw_hr_documents.length, 0);
});
await ok("置き場所のすり替えを受け付けない（別の応募者・他社・契約書）", async () => {
  setup();
  put("t1/esign/r1/document.pdf", PDF);
  put("t1/recruit/ap2/x.pdf", PDF);
  for (const path of ["t1/esign/r1/document.pdf", "t1/recruit/ap2/x.pdf", "t2/recruit/ap1/x.pdf", "t1/recruit/ap1/../../esign/r1/document.pdf"]) {
    const r = await post({ action: "attach", applicantId: "ap1", docType: "resume", path, filename: "x.pdf" });
    assert.equal(r.statusCode, 403, path);
  }
});
await ok("書類の種類が無いものは受け付けない", async () => {
  setup();
  const r = await post({ action: "upload", applicantId: "ap1", docType: "photo", mimeType: MIME.pdf, sizeBytes: 10 });
  assert.equal(r.body.error, "invalid_doc_type");
});

console.log("\n— 差し替え・履歴・削除 —");
await ok("差し替えても前の版を残す（最新＋履歴）。未登録は null", async () => {
  setup();
  await upload("ap1", "resume", PDF, MIME.pdf, "山田太郎_履歴書_v1.pdf");
  db.rows.gw_hr_documents[0].created_at = "2026-09-20T00:00:00Z";
  await upload("ap1", "resume", PDF, MIME.pdf, "山田太郎_履歴書_v2.pdf");
  db.rows.gw_hr_documents[1].created_at = "2026-09-28T00:00:00Z";
  const r = await get("applicantId=ap1");
  const resume = r.body.documents.find((d) => d.docType === "resume");
  assert.equal(resume.label, "履歴書");
  assert.equal(resume.latest.filename, "山田太郎_履歴書_v2.pdf");
  assert.deepEqual(resume.history.map((d) => d.filename), ["山田太郎_履歴書_v1.pdf"]);
  const wh = r.body.documents.find((d) => d.docType === "work_history");
  assert.equal(wh.label, "職務経歴書", "「経歴書」ではなく「職務経歴書」");
  assert.equal(wh.latest, null);
  assert.equal(resume.latest.uploadedByName, "採用 担当");
});
await ok("削除は実体を消し、記録は残す。前の版がいまの版に戻る", async () => {
  setup();
  await upload("ap1", "resume", PDF, MIME.pdf, "v1.pdf");
  db.rows.gw_hr_documents[0].created_at = "2026-09-20T00:00:00Z";
  await upload("ap1", "resume", PDF, MIME.pdf, "v2.pdf");
  db.rows.gw_hr_documents[1].created_at = "2026-09-28T00:00:00Z";
  const latest = db.rows.gw_hr_documents[1];
  const r = await del(latest.id);
  assert.equal(r.statusCode, 200);
  assert.equal(store.has(`hr/${latest.storage_path}`), false, "実体は消えた");
  assert.ok(db.rows.gw_hr_documents[1].deleted_at, "行は deleted_at 付きで残る");
  assert.equal(db.rows.gw_hr_documents[1].deleted_by, "u-rec");
  const g = (await get("applicantId=ap1")).body.documents.find((d) => d.docType === "resume");
  assert.equal(g.latest.filename, "v1.pdf");
  assert.equal(g.history.length, 0);
  assert.equal((await del(latest.id)).statusCode, 404, "二度は消せない");
  assert.equal((await get(`id=${latest.id}`)).statusCode, 404, "消した版の URL は出さない");
  assert.ok(logged.some((l) => l.action === "hr.document.delete"));
});

console.log("\n— 見るとき —");
await ok("private バケットの短時間 signed URL。保存はファイル名付き", async () => {
  setup();
  await upload("ap1", "work_history", PDF, MIME.pdf, "山田太郎_職務経歴書.pdf");
  const id = db.rows.gw_hr_documents[0].id;
  const v = await get(`id=${id}`);
  assert.equal(v.statusCode, 200);
  assert.match(v.body.url, /\/object\/sign\/hr\/t1\/recruit\/ap1\//);
  assert.equal(v.body.mimeType, MIME.pdf);
  const d = await get(`id=${id}&download=1`);
  assert.equal(signed[1].download, "山田太郎_職務経歴書.pdf");
  assert.ok(signed.every((s) => s.bucket === "hr" && s.ttl <= 600));
  assert.equal(d.body.download, true);
  for (const l of logged) assert.equal(/https?:|sign\?token/.test(JSON.stringify(l)), false, "ログに URL を入れない");
});

console.log("\n— 応募者一覧 —");
await ok("履歴書・職務経歴書のそろい具合が一覧に出る", async () => {
  setup();
  await upload("ap1", "resume", PDF, MIME.pdf, "r.pdf");
  await upload("ap1", "work_history", PDF, MIME.pdf, "w.pdf");
  await upload("ap2", "resume", PDF, MIME.pdf, "r.pdf");
  const r = await call(listApi, { method: "GET", url: "/api/hr/applicants" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const by = new Map(r.body.applicants.map((a) => [a.id, a.docs]));
  assert.deepEqual(by.get("ap1"), { resume: true, workHistory: true });
  assert.deepEqual(by.get("ap2"), { resume: true, workHistory: false });
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
