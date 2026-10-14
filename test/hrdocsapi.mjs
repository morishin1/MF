// 採用の応募書類（api/hr/documents.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//   1. 採用を扱える人（管理者・経営者・人事・採用担当）だけ。営業だけの人・一般メンバーは 403
//   2. PDF・DOC・DOCX・JPEG・PNG を中身で判定。10MB まで。不正形式は置いた実体も消す
//   3. 置き場所のすり替え（他の応募者・他社・契約書）を受け付けない
//   4. 差し替えても前の版を残す（最新＋履歴）。削除は実体を消し、記録は残す。前の版が最新に戻る
//   5. 見るときは private バケットの短時間 signed URL（公開URLを作らない）
//   6. 応募者一覧に、履歴書・職務経歴書のそろい具合が出る
//   7. Office の人事・労務（採用HRの権限が無い人）は、「Office へ引き渡された人（handoff_at あり）」の書類を見るだけ。
//      同一テナント・引き渡し済み・Office の人事権限・本人の書類だけ（service role で読むので API で確かめる）。登録・差し替え・削除は 403
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
  return (r) => f.every(([op, k, v]) => (op === "eq" ? r[k] === v : op === "neq" ? r[k] !== v : op === "in" ? v.includes(r[k])
    : op === "is" ? (v === null ? r[k] == null : r[k] === v) : op === "notnull" ? r[k] != null : true));
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
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    not(k, op, v) { if (op === "is" && v === null) f.push(["notnull", k, null]); return q; },
    order(col, opts) { if (!order) order = [col, opts?.ascending !== false]; return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    single: () => Promise.resolve({ data: copy(rows()[0]) || null, error: null }),
    then: (fn, rej) => Promise.resolve({ data: rows().map(copy), error: null }).then(fn, rej),
    insert(row) {
      const made = [].concat(row).map((r) => ({ id: r.id || uuid(), ...r }));
      // db.reject：その行を CHECK 違反（23514）で断る（スキルシートの種類を足す db/135 が未適用の環境の再現）
      if (name === "gw_hr_documents" && db.reject && made.some(db.reject)) {
        const e2 = { select: () => e2, single: () => Promise.resolve({ data: null, error: { code: "23514", message: "violates check constraint" } }),
          then: (fn, rej) => Promise.resolve({ data: null, error: { code: "23514", message: "violates check constraint" } }).then(fn, rej) };
        return e2;
      }
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
  namedExports: { gwContext: async () => who, canRecruit: real.canRecruit, canManageHr: real.canManageHr, canSeeSalary: real.canSeeSalary, canOfficeHr: real.canOfficeHr },
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
  db.reject = null;
  db.rows = {
    gw_hr_applicants: [
      { id: "ap1", tenant_id: "t1", name: "山田 太郎", job_title: "エンジニア", source: "Wantedly", stage: "applied", status: "todo", created_at: "2026-09-01" },
      { id: "ap2", tenant_id: "t1", name: "佐藤 花子", job_title: "営業", source: "リファラル", stage: "applied", status: "todo", created_at: "2026-09-02" },
      { id: "ap9", tenant_id: "t2", name: "他社の応募者", job_title: "x", source: "x", stage: "applied", status: "todo", created_at: "2026-09-03" },
    ],
    gw_hr_documents: [], gw_hr_interviews: [], gw_hr_offers: [], gw_employees: [{ user_id: "u-rec", tenant_id: "t1", id: "e-rec", display_name: "採用 担当" }],
  };
}

console.log("— 権限 —");
await ok("採用担当・人事・責任者・経営者は使える（社内権限で決まる）", async () => {
  setup();
  for (const p of [RECRUITER, HR, MANAGER, OWNER]) {
    who = p;
    assert.equal((await get("applicantId=ap1")).statusCode, 200, String(p.roles));
  }
});
await ok("営業・一般メンバー・会計の管理者だけ・IT・管理だけの人には採用書類を見せない（403。引き渡し前の応募者は Office の人事権限でも見せない）", async () => {
  setup();
  await upload("ap1", "resume", PDF, MIME.pdf, "山田太郎_履歴書.pdf");
  const id = db.rows.gw_hr_documents[0].id;
  for (const p of [SALES, MEMBER, ADMIN, IT]) {
    who = p;
    assert.equal((await get("applicantId=ap1")).statusCode, 403, `${p.roles}${p.isAdmin ? "（会計の管理者）" : ""} 一覧`);
    assert.equal((await get(`id=${id}`)).statusCode, 403, `${p.roles} URL`);
    assert.equal((await post({ action: "upload", applicantId: "ap1", docType: "resume", mimeType: MIME.pdf, sizeBytes: 10 })).statusCode, 403);
    assert.equal((await del(id)).statusCode, 403);
  }
  assert.equal(signed.length, 0, "URL は1つも出していない");
});
await ok("責任者は HR を使えるので、採用書類を扱える（経営者・責任者・人事・採用担当）", async () => {
  setup();
  await upload("ap1", "resume", PDF, MIME.pdf, "山田太郎_履歴書.pdf");
  who = MANAGER;
  const r = await get("applicantId=ap1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
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

await ok("別タブのプレビュー：応募者名・書類の種類を返す。違う応募者の組み合わせは 404。見た記録を残す（URL は残さない）", async () => {
  setup();
  await upload("ap1", "resume", PDF, MIME.pdf, "山田太郎_履歴書.pdf");
  const id = db.rows.gw_hr_documents[0].id;
  logged.length = 0;
  const v = await get(`id=${id}&applicantId=ap1`);
  assert.equal(v.statusCode, 200, JSON.stringify(v.body));
  assert.equal(v.body.applicantName, "山田 太郎");
  assert.equal(v.body.docTypeLabel, "履歴書");
  assert.equal(v.body.applicantId, "ap1");
  assert.equal((await get(`id=${id}&applicantId=ap2`)).statusCode, 404, "URL の応募者と書類が食い違えば出さない");
  assert.ok(logged.some((l) => l.action === "hr.document.view" && l.detail.documentId === id));
  await get(`id=${id}&applicantId=ap1&download=1`);
  assert.ok(logged.some((l) => l.action === "hr.document.download"));
  for (const l of logged) assert.equal(/https?:|sign\?token/.test(JSON.stringify(l)), false, "ログに URL を入れない");
  // 採用HRの権限が無い人は、URL を直接叩いても見られない
  for (const p of [SALES, MEMBER, ADMIN, IT]) {
    who = p;
    const r = await get(`id=${id}&applicantId=ap1`);
    assert.equal(r.statusCode, 403, `${p.roles.join(",") || (p.isAdmin ? "admin" : "member")} は 403`);
    assert.equal(r.body.url, undefined);
  }
  who = OTHER;
  assert.equal((await get(`id=${id}&applicantId=ap1`)).statusCode, 404, "他社は 404");
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
  const docId = (ap, t) => db.rows.gw_hr_documents.find((d) => d.applicant_id === ap && d.doc_type === t && !d.deleted_at).id;
  assert.deepEqual(by.get("ap1"), { resume: true, resumeId: docId("ap1", "resume"),
    workHistory: true, workHistoryId: docId("ap1", "work_history") });
  assert.deepEqual(by.get("ap2"), { resume: true, resumeId: docId("ap2", "resume"), workHistory: false, workHistoryId: null });
});

await ok("一覧の書類ID：複数版なら最新版・削除済みは出さない・表示用URLは返さない", async () => {
  setup();
  await upload("ap1", "resume", PDF, MIME.pdf, "old.pdf");
  await upload("ap1", "resume", PDF, MIME.pdf, "new.pdf");
  await upload("ap2", "work_history", PDF, MIME.pdf, "w.pdf");
  const rows = db.rows.gw_hr_documents;
  const oldR = rows.find((d) => d.filename === "old.pdf"), newR = rows.find((d) => d.filename === "new.pdf");
  oldR.created_at = "2026-09-01T00:00:00Z"; newR.created_at = "2026-09-20T00:00:00Z";
  rows.find((d) => d.applicant_id === "ap2").deleted_at = "2026-09-25T00:00:00Z";
  const r = await call(listApi, { method: "GET", url: "/api/hr/applicants" });
  const by = new Map(r.body.applicants.map((a) => [a.id, a.docs]));
  assert.equal(by.get("ap1").resumeId, newR.id, "最新版");
  assert.deepEqual(by.get("ap2"), { resume: false, resumeId: null, workHistory: false, workHistoryId: null }, "削除済みは出さない");
  assert.equal(/sign|token=|https?:/.test(JSON.stringify(r.body.applicants)), false, "一覧に表示用URLを入れない");
  assert.equal(signed.length, 0, "一覧では署名付きURLを作らない");
});

console.log("\n— 応募書類の4種類（スキルシート）—");
await ok("書類の種類は 履歴書・職務経歴書・スキルシート・その他 の順。スキルシートも差し替え・履歴・削除ができる", async () => {
  setup();
  const r0 = await get("applicantId=ap1");
  assert.deepEqual(r0.body.documents.map((d) => [d.docType, d.label]),
    [["resume", "履歴書"], ["work_history", "職務経歴書"], ["skill_sheet", "スキルシート"], ["other", "その他"]]);
  assert.ok(r0.body.documents.every((d) => d.latest === null));
  const a = await upload("ap1", "skill_sheet", PDF, MIME.pdf, "山田太郎_スキルシート_v1.pdf");
  assert.equal(a.statusCode, 200, JSON.stringify(a.body));
  db.rows.gw_hr_documents[0].created_at = "2026-09-20T00:00:00Z";
  await upload("ap1", "skill_sheet", PDF, MIME.pdf, "山田太郎_スキルシート_v2.pdf");
  db.rows.gw_hr_documents[1].created_at = "2026-09-28T00:00:00Z";
  const g = (await get("applicantId=ap1")).body.documents.find((d) => d.docType === "skill_sheet");
  assert.equal(g.latest.filename, "山田太郎_スキルシート_v2.pdf");
  assert.deepEqual(g.history.map((d) => d.filename), ["山田太郎_スキルシート_v1.pdf"]);
  assert.equal(g.latest.docTypeLabel, "スキルシート");
  assert.equal((await del(db.rows.gw_hr_documents[1].id)).statusCode, 200);
  assert.equal((await get("applicantId=ap1")).body.documents.find((d) => d.docType === "skill_sheet").latest.filename, "山田太郎_スキルシート_v1.pdf");
});
await ok("スキルシートは、履歴書・職務経歴書の「そろい具合」（一覧）には数えない", async () => {
  setup();
  await upload("ap1", "skill_sheet", PDF, MIME.pdf, "s.pdf");
  const r = await call(listApi, { method: "GET", url: "/api/hr/applicants" });
  const d = r.body.applicants.find((a) => a.id === "ap1").docs;
  assert.deepEqual(d, { resume: false, resumeId: null, workHistory: false, workHistoryId: null });
});
await ok("db/135 が未適用（CHECK で断られる）：スキルシートだけ 503 と案内。置いた実体は消す。履歴書などは通る", async () => {
  setup();
  db.reject = (r) => r.doc_type === "skill_sheet";
  const u = await post({ action: "upload", applicantId: "ap1", docType: "skill_sheet", mimeType: MIME.pdf, sizeBytes: PDF.length });
  put(u.body.path, PDF);
  const r = await post({ action: "attach", applicantId: "ap1", docType: "skill_sheet", path: u.body.path, filename: "s.pdf" });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, "not_ready");
  assert.match(r.body.message, /db\/135_hr_document_skill_sheet\.sql/);
  assert.equal(store.has(`hr/${u.body.path}`), false, "置いた実体は消す（孤児を残さない）");
  assert.equal(db.rows.gw_hr_documents.length, 0);
  assert.equal((await upload("ap1", "resume", PDF, MIME.pdf, "r.pdf")).statusCode, 200, "ほかの種類はこれまでどおり");
});

console.log("\n— 採用条件書類（内定通知書・労働条件通知書・承諾済みPDF）—");
const OFFER = (over = {}) => ({ id: "of1", tenant_id: "t1", applicant_id: "ap1", version: 1, offer_type: "executive_employee", created_at: "2026-10-01T00:00:00Z",
  sent_at: null, viewed_at: null, accepted_at: null, declined_at: null, revoked_at: null, notice_pdf_path: null, accepted_pdf_path: null,
  notice_title: null, token_hash: "SECRET-HASH", legalsign_url: "https://legalsign.example/secret", ...over });
await ok("オファーが無い：3行とも「未登録」", async () => {
  setup();
  const c = (await get("applicantId=ap1")).body.conditionDocs;
  assert.deepEqual(c.rows.map((r) => [r.key, r.label, r.stateLabel]), [["offer", "内定通知書", "未登録"], ["notice", "労働条件通知書", "未登録"], ["accepted", "承諾済みPDF", "未登録"]]);
  assert.equal(c.offerId, null);
});
await ok("オファーを作った → 登録済み／送った → 送付済み／本人が開いた → 本人確認済み／承諾 → 承諾済み（条件通知書・承諾済みPDFも）", async () => {
  setup();
  const state = async () => (await get("applicantId=ap1")).body.conditionDocs.rows.map((r) => `${r.key}:${r.stateLabel}`).join(" ");
  db.rows.gw_hr_offers = [OFFER()];
  assert.equal(await state(), "offer:登録済み notice:未登録 accepted:未登録", "作っただけ（条件通知書は送るときに作る）");
  Object.assign(db.rows.gw_hr_offers[0], { sent_at: "2026-10-02T00:00:00Z", notice_pdf_path: "t1/notice/of1.pdf", notice_title: "労働条件通知書" });
  assert.equal(await state(), "offer:送付済み notice:送付済み accepted:未登録");
  db.rows.gw_hr_offers[0].viewed_at = "2026-10-03T00:00:00Z";
  assert.equal(await state(), "offer:本人確認済み notice:本人確認済み accepted:未登録");
  Object.assign(db.rows.gw_hr_offers[0], { accepted_at: "2026-10-04T00:00:00Z", accepted_pdf_path: "t1/notice/of1_accepted.pdf" });
  assert.equal(await state(), "offer:承諾済み notice:承諾済み accepted:承諾済み");
  const c = (await get("applicantId=ap1")).body.conditionDocs;
  assert.equal(c.offerId, "of1");
  assert.deepEqual(c.rows.map((r) => r.file), [null, "notice", "accepted"], "PDF を開けるのは、条件通知書と承諾済みPDF");
  assert.equal(c.rows[2].at, "2026-10-04T00:00:00Z");
});
await ok("名前は区分ごと（正社員＝内定通知書・労働条件通知書／業務委託＝業務委託オファー・業務委託条件通知書）", async () => {
  setup();
  db.rows.gw_hr_offers = [OFFER({ offer_type: "contractor", sent_at: "2026-10-02T00:00:00Z", notice_pdf_path: "t1/n.pdf" })];
  const c = (await get("applicantId=ap1")).body.conditionDocs;
  assert.deepEqual(c.rows.map((r) => r.label), ["業務委託オファー", "業務委託条件通知書", "承諾済みPDF"]);
});
await ok("区分の無い従来の合格通知は、条件通知書・承諾済みPDFの行を出さない（applicable=false）", async () => {
  setup();
  db.rows.gw_hr_offers = [OFFER({ offer_type: null, sent_at: "2026-10-02T00:00:00Z" })];
  const c = (await get("applicantId=ap1")).body.conditionDocs;
  assert.deepEqual(c.rows.map((r) => [r.key, r.applicable]), [["offer", true], ["notice", false], ["accepted", false]]);
  assert.equal(c.rows[0].label, "合格通知");
});
await ok("新しい版を送って古い版を無効化した → いまの版。辞退は「辞退」。承諾した版があればそちらを優先", async () => {
  setup();
  db.rows.gw_hr_offers = [OFFER({ id: "o1", version: 1, revoked_at: "2026-10-05T00:00:00Z", sent_at: "2026-10-02T00:00:00Z" }),
    OFFER({ id: "o2", version: 2, sent_at: "2026-10-06T00:00:00Z" })];
  let c = (await get("applicantId=ap1")).body.conditionDocs;
  assert.deepEqual([c.offerId, c.rows[0].stateLabel, c.version], ["o2", "送付済み", 2]);
  db.rows.gw_hr_offers[1].declined_at = "2026-10-07T00:00:00Z";
  c = (await get("applicantId=ap1")).body.conditionDocs;
  assert.equal(c.rows[0].stateLabel, "辞退");
});
await ok("他社のオファーは出さない。トークン・LegalSign の URL・給与は返さない", async () => {
  setup();
  db.rows.gw_hr_offers = [OFFER({ tenant_id: "t2", id: "ox" }), OFFER({ wage_amount: 480000, sent_at: "2026-10-02T00:00:00Z", notice_pdf_path: "t1/n.pdf" })];
  const r = await get("applicantId=ap1");
  assert.equal(r.body.conditionDocs.offerId, "of1");
  const text = JSON.stringify(r.body);
  assert.ok(!/SECRET-HASH|legalsign\.example|480000|token_hash|wage/.test(text), "機微な値を返さない");
});
await ok("条件通知書の列が無い環境（db/132 未適用）でも、応募書類は返る。内定通知書だけ並ぶ", async () => {
  setup();
  const o = OFFER({ sent_at: "2026-10-02T00:00:00Z" });
  delete o.notice_pdf_path; delete o.accepted_pdf_path;
  db.rows.gw_hr_offers = [o];
  const r = await get("applicantId=ap1");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.conditionDocs.docsReady, false);
  assert.equal(r.body.conditionDocs.rows[0].stateLabel, "送付済み");
  assert.equal(r.body.documents.length, 4);
});

console.log("— Office の閲覧専用（引き渡された人の書類だけ。service role で読むので API で確かめる）—");

const HANDED = (o = {}) => ({ id: "ofH", tenant_id: "t1", applicant_id: "ap1", version: 1, offer_type: "contractor", accepted_at: "2026-10-10T01:00:00Z",
  handoff_at: "2026-10-12T06:00:00Z", handoff_by: "u-hr", notice_pdf_path: "t1/notice/ofH.pdf", accepted_pdf_path: "t1/notice/ofH_acc.pdf", notice_title: "業務委託条件通知書", ...o });
async function seedDocs() {
  setup();
  who = RECRUITER;
  await upload("ap1", "resume", PDF, MIME.pdf, "山田_履歴書_v1.pdf");
  await upload("ap1", "resume", PDF, MIME.pdf, "山田_履歴書_v2.pdf");
  await upload("ap1", "skill_sheet", PDF, MIME.pdf, "山田_スキルシート.pdf");
  await upload("ap2", "resume", PDF, MIME.pdf, "佐藤_履歴書.pdf");
  db.rows.gw_hr_applicants.push({ id: "ap10", tenant_id: "t2", name: "他社の引き渡し済み", job_title: "x", source: "x", stage: "applied", status: "todo", created_at: "2026-09-03" });
  who = RECRUITER;
  signed.length = 0; logged.length = 0;
  return Object.fromEntries(db.rows.gw_hr_documents.map((d) => [d.filename, d.id]));
}

await ok("Office の人事権限（会計側の管理者）は、引き渡された人（handoff_at あり）の書類を見られる。読み取り専用・各種類の最新の1つだけ・引き渡した版の条件書類", async () => {
  const ids = await seedDocs();
  db.rows.gw_hr_offers = [HANDED(), { ...HANDED({ id: "ofOld", version: 0, handoff_at: null, accepted_at: null }) }];
  who = ADMIN;
  const r = await get("applicantId=ap1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.readOnly, r.body.offerId, r.body.applicant.id], [true, "ofH", "ap1"]);
  const resume = r.body.documents.find((d) => d.docType === "resume");
  assert.equal(resume.latest.filename, "山田_履歴書_v2.pdf", "最新の1つ");
  assert.deepEqual(resume.history, [], "過去の版は Office に出さない（HR で見る）");
  assert.equal(r.body.documents.find((d) => d.docType === "skill_sheet").latest.filename, "山田_スキルシート.pdf");
  assert.equal(r.body.conditionDocs.offerId, "ofH", "引き渡した版の書類状態");
  assert.deepEqual(r.body.conditionDocs.rows.map((x) => x.file), [null, "notice", "accepted"]);
  assert.equal(typeof r.body.salaryVisible, "boolean");
});

await ok("見るときは短時間の署名付きURL。誰が見たかを監査ログに残す（via: office）。保存（download）もできる", async () => {
  const ids = await seedDocs();
  db.rows.gw_hr_offers = [HANDED()];
  who = ADMIN;
  const r = await get(`id=${ids["山田_履歴書_v2.pdf"]}&applicantId=ap1`);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(/\/sign\/hr\//.test(r.body.url) && signed.length === 1 && signed[0].ttl === 300);
  assert.deepEqual([logged.at(-1).action, logged.at(-1).detail.via, logged.at(-1).actorId], ["hr.document.view", "office", "u-ad"]);
  const d = await get(`id=${ids["山田_履歴書_v2.pdf"]}&download=1`);
  assert.equal(d.statusCode, 200);
  assert.equal(signed.at(-1).download, "山田_履歴書_v2.pdf");
  assert.equal(logged.at(-1).action, "hr.document.download");
});

await ok("引き渡していない応募者の書類は、Office の人事権限でも見られない（承諾しただけ・正式契約の途中・オファーなし・辞退・無効化・育成枠）", async () => {
  const ids = await seedDocs();
  for (const [label, offers] of [
    ["オファーなし", []],
    ["承諾しただけ（handoff_at なし）", [HANDED({ handoff_at: null, handoff_by: null })]],
    ["正式契約の途中", [HANDED({ handoff_at: null, formal_contract_required: true, formal_sent_at: "2026-10-11T00:00:00Z" })]],
    ["辞退", [HANDED({ declined_at: "2026-10-13T00:00:00Z" })]],
    ["無効化", [HANDED({ revoked_at: "2026-10-13T00:00:00Z" })]],
    ["育成枠（handoff_at が入っていても Office へは渡さない）", [HANDED({ offer_type: "training" })]],
  ]) {
    db.rows.gw_hr_offers = offers;
    who = ADMIN;
    const l = await get("applicantId=ap1");
    assert.deepEqual([l.statusCode, l.body.error], [403, "not_handed_off"], `${label}：一覧`);
    const f = await get(`id=${ids["山田_履歴書_v2.pdf"]}`);
    assert.deepEqual([f.statusCode, f.body.error], [403, "not_handed_off"], `${label}：URL`);
  }
  assert.equal(signed.length, 0, "URL は1つも出していない");
});

await ok("別の応募者の書類は見られない：引き渡したのは ap1 だけ。ap1 の引き渡しで ap2 の書類 ID を指しても 403／applicantId とずれた書類は 404", async () => {
  const ids = await seedDocs();
  db.rows.gw_hr_offers = [HANDED()];
  who = ADMIN;
  const other = await get(`id=${ids["佐藤_履歴書.pdf"]}`);
  assert.deepEqual([other.statusCode, other.body.error], [403, "not_handed_off"], "ap2 は引き渡していない");
  const mismatch = await get(`id=${ids["佐藤_履歴書.pdf"]}&applicantId=ap1`);
  assert.equal(mismatch.statusCode, 404, "applicantId と書類の持ち主がずれている");
  const ap2 = await get("applicantId=ap2");
  assert.deepEqual([ap2.statusCode, ap2.body.error], [403, "not_handed_off"]);
  assert.equal(signed.length, 0);
});

await ok("別のテナントは見られない：他社の応募者（引き渡し済みでも）・他社の書類は 404。自社の応募者に他社の引き渡しがあっても出ない", async () => {
  const ids = await seedDocs();
  db.rows.gw_hr_offers = [HANDED({ id: "ofX", tenant_id: "t2", applicant_id: "ap10" }), HANDED({ id: "ofY", tenant_id: "t2", applicant_id: "ap2" })];
  db.rows.gw_hr_documents.push({ id: "dx", tenant_id: "t2", applicant_id: "ap10", doc_type: "resume", filename: "他社.pdf", storage_path: "t2/recruit/ap10/x.pdf", mime_type: "application/pdf", created_at: "2026-10-01" });
  who = ADMIN;   // t1
  assert.equal((await get("applicantId=ap10")).statusCode, 404, "他社の応募者");
  assert.equal((await get("id=dx")).statusCode, 404, "他社の書類");
  const ap2 = await get("applicantId=ap2");
  assert.deepEqual([ap2.statusCode, ap2.body.error], [403, "not_handed_off"], "自社の応募者に、他社のテナントの引き渡しが付いていても引き渡し済みにならない");
  assert.equal(signed.length, 0);
});

await ok("Office からは登録・差し替え・削除ができない（403 read_only）。置き場所の URL も出さず、行も変わらない", async () => {
  const ids = await seedDocs();
  db.rows.gw_hr_offers = [HANDED()];
  who = ADMIN;
  const before = JSON.stringify(db.rows.gw_hr_documents);
  const up = await post({ action: "upload", applicantId: "ap1", docType: "resume", mimeType: MIME.pdf, sizeBytes: 10 });
  assert.deepEqual([up.statusCode, up.body.error], [403, "read_only"]);
  const at = await post({ action: "attach", applicantId: "ap1", docType: "resume", path: "t1/recruit/ap1/x.pdf", filename: "x.pdf" });
  assert.deepEqual([at.statusCode, at.body.error], [403, "read_only"]);
  const rm = await del(ids["山田_履歴書_v2.pdf"]);
  assert.deepEqual([rm.statusCode, rm.body.error], [403, "read_only"]);
  assert.equal(JSON.stringify(db.rows.gw_hr_documents), before, "書類の行は変わらない");
  assert.equal(logged.filter((l) => /upload|delete/.test(l.action)).length, 0, "登録・削除の記録も無い");
  // 採用HRの人は、これまでどおり登録・削除できる
  who = RECRUITER;
  assert.equal((await del(ids["山田_履歴書_v2.pdf"])).statusCode, 200);
});

await ok("Office の人事権限が無い人（営業・IT・責任者・一般メンバー）は、引き渡した人の書類でも 403", async () => {
  const ids = await seedDocs();
  db.rows.gw_hr_offers = [HANDED()];
  for (const p of [SALES, IT, MEMBER]) {
    who = p;
    assert.equal((await get("applicantId=ap1")).statusCode, 403, `${p.roles} 一覧`);
    assert.equal((await get(`id=${ids["山田_履歴書_v2.pdf"]}`)).statusCode, 403, `${p.roles} URL`);
  }
  assert.equal(signed.length, 0);
});

await ok("採用を扱える人（人事・経営者）は、これまでどおり引き渡し前の応募者の書類も見られ、過去の版も見える（Office の制限は掛からない）", async () => {
  await seedDocs();
  db.rows.gw_hr_offers = [];
  for (const p of [RECRUITER, HR, OWNER]) {
    who = p;
    const r = await get("applicantId=ap2");
    assert.equal(r.statusCode, 200, String(p.roles));
    assert.equal(r.body.readOnly, undefined, "HR の画面は読み取り専用にしない");
  }
  who = HR;
  assert.equal((await get("applicantId=ap1")).body.documents.find((d) => d.docType === "resume").history.length, 1, "HR には過去の版が出る");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
