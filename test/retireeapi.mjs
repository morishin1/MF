// 退職者ポータルと退職手続き（db/121）。api/retiree/*・api/employees/retire.js・lib/retire.js
//
// ■ 何を守るテストか
//   [退職者ポータル]
//     1. 退職者（left／退職日を過ぎた leaving）だけが入れる。在籍中・退職日前の leaving は 403 not_retired
//     2. 見えるのは、自分の公開中の最新の発行済みだけ。下書き・未公開・置き換え済み・公開停止は「準備中」（id を返さない）
//     3. 社内メモ・保存先・ハッシュ・本文・退職理由は、応答のどこにも出ない
//     4. 他人の書類の id・存在しない id・形のおかしい id は 404（存在も教えない）
//     5. 署名付き URL は短時間。見た・保存したは操作ログに残る（URL は残さない）
//   [管理側 /api/employees/retire]
//     6. 人事・管理者だけ。一般メンバーと他社は触れない。退職者本人も触れない（account_left）
//     7. 退職理由（構造化）。自由記述は操作ログに残さない
//     8. 登録は PDF だけ。置き場所は「その人・その種類」のものだけ。再登録は新しい版（古い版は置き換え済みで残る。公開は外れる）
//     9. 公開できるのは、発行済みの最新の版だけ。公開停止後は本人に見えない
import assert from "node:assert/strict";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const ymdOffset = (d) => new Date(Date.now() + 9 * 3600000 + d * 86400000).toISOString().slice(0, 10);
const TODAY = ymdOffset(0), YESTERDAY = ymdOffset(-1), TOMORROW = ymdOffset(1);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

// ---- 偽の DB と Storage -------------------------------------------------------
const db = { rows: {}, n: 0, absent: new Set() };
const files = new Map();
const logs = [];
const signed = [];
let current = { userId: null };

function table(name) {
  const f = []; let op = null, payload = null, onConflict = "id", sel = false, one = false, order = null;
  const match = (r) => f.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
  const all = () => (db.rows[name] = db.rows[name] || []);
  const run = () => {
    if (db.absent.has(name)) return { data: null, error: { code: "PGRST205", message: "Could not find the table in the schema cache" } };
    const list = all();
    if (op === "insert") {
      const rows = [].concat(payload).map((r) => ({ id: `${name}-${++db.n}`, ...r }));
      for (const r of rows) {
        // 一意（1人・1種類で有効な行は1つ）
        if (name === "gw_retire_docs" && r.state !== "superseded" && list.some((x) => x.employee_id === r.employee_id && x.kind === r.kind && x.state !== "superseded")) return { data: null, error: { code: "23505", message: "dup" } };
        if (name === "gw_retire_docs" && r.published && r.state !== "issued") return { data: null, error: { code: "23514", message: "check" } };
        list.push(r);
      }
      return { data: one ? { ...rows[0] } : rows.map((r) => ({ ...r })), error: null };
    }
    if (op === "upsert") {
      const key = (r) => onConflict.split(",").map((k) => r[k]).join("|");
      const r = payload; const i = list.findIndex((x) => key(x) === key(r));
      if (i >= 0) Object.assign(list[i], r); else list.push({ id: `${name}-${++db.n}`, ...r });
      return { data: { ...(i >= 0 ? list[i] : list[list.length - 1]) }, error: null };
    }
    if (op === "update") {
      const hit = list.filter(match); for (const r of hit) Object.assign(r, payload);
      return { data: one ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r })), error: null };
    }
    if (op === "delete") { db.rows[name] = list.filter((r) => !match(r)); return { data: null, error: null }; }
    let rows = list.filter(match).map((r) => ({ ...r }));
    if (order) rows.sort((a, b) => (b[order] || 0) - (a[order] || 0));
    return { data: one ? (rows[0] || null) : rows, error: null };
  };
  const q = {
    select() { sel = true; return q; },
    eq(k, v) { f.push([k, v]); return q; }, in(k, v) { f.push([k, v]); return q; },
    neq() { return q; }, lt() { return q; }, limit() { return q; },
    order(k) { order = k; return q; },
    insert(v) { op = "insert"; payload = v; return q; },
    upsert(v, o = {}) { op = "upsert"; payload = v; onConflict = o.onConflict || "id"; return q; },
    update(v) { op = "update"; payload = v; return q; },
    delete() { op = "delete"; return q; },
    maybeSingle() { one = true; return Promise.resolve(run()); },
    single() { one = true; return Promise.resolve(run()); },
    then(fn, rej) { return Promise.resolve(run()).then(fn, rej); },
  };
  return q;
}
const storage = { from: () => ({
  createSignedUrl: async (path, ttl, opt) => { if (!files.has(path)) return { data: null, error: { message: "nf" } }; signed.push({ path, ttl, opt }); return { data: { signedUrl: `https://signed.example/${path}?t=1${opt?.download ? "&dl=1" : ""}` }, error: null }; },
  createSignedUploadUrl: async (path) => ({ data: { signedUrl: `https://upload.example/${path}`, token: "tok" }, error: null }),
  download: async (path) => (files.has(path) ? { data: { arrayBuffer: async () => files.get(path) }, error: null } : { data: null, error: { message: "nf" } }),
  remove: async (paths) => { for (const p of paths) files.delete(p); return { data: null, error: null }; },
}) };
mock.module(atRoot("lib/supabase.js"), { namedExports: {
  admin: () => ({ from: table, storage }),
  userClient: () => ({ from: table, storage, auth: { getUser: async () => (current.userId ? { data: { user: { id: current.userId, email: "x@example.com" } }, error: null } : { data: null, error: { message: "no" } }) } }),
} });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logs.push(e); } } });
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });

const { resetLeftCache } = await import(atRoot("lib/auth.js"));
const retire = await import(atRoot("lib/retire.js"));
const { default: portal } = await import(atRoot("api/retiree/index.js"));
const { default: fileApi } = await import(atRoot("api/retiree/file.js"));
const { default: adminApi } = await import(atRoot("api/employees/retire.js"));

const res = () => { const r = { statusCode: 0, body: null, headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } }; return r; };
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, method: "GET", ...req }, r); return r; };
const as = (id) => { current = { userId: `u-${id}` }; };
let pass = 0, fail = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); } };

const emp = (id, status, left_on = null, tenant = "t1") => ({ id: `e-${id}`, tenant_id: tenant, user_id: `u-${id}`, display_name: `名前${id}`, email: `${id}@x`, employment_type: "アルバイト", joined_on: "2025-04-01", status, left_on });
const doc = (employee, kind, o = {}) => ({ tenant_id: "t1", employee_id: `e-${employee}`, kind, version: 1, state: "issued", published: false, issued_on: "2026-10-01",
  storage_path: `t1/retire/e-${employee}/${kind}/f-${employee}-${kind}-${o.version || 1}.pdf`, note: "社内メモ", sha256: "abc", body_snapshot: "本文", ...o });
function setup() {
  resetLeftCache(); db.absent.clear(); logs.length = 0; signed.length = 0; files.clear(); db.n = 0; current = { userId: null };
  db.rows = {
    gw_employees: [emp("left", "left", YESTERDAY), emp("left2", "left", YESTERDAY), emp("past", "leaving", YESTERDAY), emp("future", "leaving", TOMORROW), emp("hr", "active"), emp("member", "active"), emp("other", "active", null, "t2")],
    gw_role_grants: [{ id: "g1", tenant_id: "t1", employee_id: "e-hr", role: "hr" }],
    gw_app_grants: [{ tenant_id: "t1", employee_id: "e-hr", app_key: "office" }, { tenant_id: "t1", employee_id: "e-hr", app_key: "hr" }],
    memberships: [],
    gw_retire_cases: [{ id: "c1", tenant_id: "t1", employee_id: "e-left", reason_code: "personal", reason_note: "家庭の事情（本人の自由記述）" }],
    gw_retire_docs: [],
  };
  const D = db.rows.gw_retire_docs;
  D.push(
    { id: "d-cert", ...doc("left", "certificate", { published: true, issued_no: "RET-2026-0001" }) },
    { id: "d-wh", tenant_id: "t1", employee_id: "e-left", kind: "withholding", version: 1, state: "processing", expected_on: "2026-10-20", note: "社内メモ2" },
    { id: "d-sep", tenant_id: "t1", employee_id: "e-left", kind: "separation", version: 1, state: "draft", note: "下書き" },
    { id: "d-ins", ...doc("left", "insurance_loss", { published: false }) },
    { id: "d-left2", ...doc("left2", "certificate", { published: true }) },       // 別の退職者の書類
  );
  for (const d of D) if (d.storage_path) files.set(d.storage_path, PDF);
}

console.log("[1] lib/retire.js");
setup();
await ok("portalView：公開中の発行済みだけ issued。手続き中は processing。下書き・未公開は preparing", () => {
  const v = retire.portalView(db.rows.gw_retire_docs.filter((d) => d.employee_id === "e-left"));
  const by = Object.fromEntries(v.map((x) => [x.kind, x]));
  assert.equal(by.certificate.state, "issued"); assert.equal(by.certificate.id, "d-cert");
  assert.equal(by.withholding.state, "processing"); assert.equal(by.withholding.expectedOn, "2026-10-20"); assert.equal(by.withholding.id, null);
  assert.equal(by.separation.state, "preparing"); assert.equal(by.separation.id, null);
  assert.equal(by.insurance_loss.state, "preparing"); assert.equal(by.insurance_loss.id, null);
  assert.deepEqual(v.map((x) => x.kind), ["certificate", "withholding", "separation", "insurance_loss"]);
});
await ok("portalView：置き換え済みの古い版は見せない／何も無い人は全部 preparing", () => {
  const v = retire.portalView([{ id: "x1", kind: "certificate", version: 1, state: "superseded", published: false }, { id: "x2", kind: "certificate", version: 2, state: "issued", published: false }]);
  assert.equal(v[0].state, "preparing");
  assert.ok(retire.portalView([]).every((x) => x.state === "preparing"));
});
await ok("progressOf：退職日・システム停止・発行済みの数", () => {
  const p = retire.progressOf({ status: "left", left_on: YESTERDAY }, [{ kind: "certificate", version: 1, state: "issued" }, { kind: "withholding", version: 1, state: "processing" }]);
  assert.equal(p.total, 6); assert.equal(p.done, 3);
  assert.equal(retire.progressOf({ status: "leaving", left_on: null }, []).done, 0);
});
await ok("ownsPath：その人・その種類の置き場所だけ", () => {
  const p = retire.retirePath("t1", "e-a", "certificate", "u1");
  assert.ok(retire.ownsPath(p, "t1", "e-a", "certificate"));
  assert.ok(!retire.ownsPath(p, "t1", "e-b", "certificate")); assert.ok(!retire.ownsPath(p, "t2", "e-a", "certificate"));
  assert.ok(!retire.ownsPath(p, "t1", "e-a", "separation")); assert.ok(!retire.ownsPath("t1/retire/e-a/certificate/../x.pdf", "t1", "e-a", "certificate"));
  assert.ok(!retire.ownsPath("t1/retire/e-a/certificate/a.png", "t1", "e-a", "certificate"));
});
await ok("発行番号・ファイル名", () => {
  assert.equal(retire.issuedNo(2026, 12), "RET-2026-0012");
  assert.equal(retire.downloadName("certificate", "山田 太郎", "2026-10-06"), "退職証明書_山田 太郎_20261006.pdf");
});

console.log("[2] 退職者ポータル GET /api/retiree");
await ok("退職者は、自分の書類の一覧を見られる（公開中の発行済みだけ id つき）", async () => {
  as("left"); const r = await call(portal, { url: "/api/retiree" });
  assert.equal(r.statusCode, 200); assert.equal(r.body.name, "名前left"); assert.equal(r.body.leftOn, YESTERDAY);
  const by = Object.fromEntries(r.body.docs.map((x) => [x.kind, x]));
  assert.equal(by.certificate.state, "issued"); assert.equal(by.certificate.id, "d-cert");
  assert.equal(by.withholding.state, "processing"); assert.equal(by.separation.state, "preparing"); assert.equal(by.insurance_loss.state, "preparing");
  assert.equal(r.headers["Cache-Control"], "no-store");
});
await ok("社内メモ・保存先・ハッシュ・本文・退職理由・他人の書類は、応答のどこにも出ない", async () => {
  as("left"); const r = await call(portal, { url: "/api/retiree" });
  const s = JSON.stringify(r.body);
  for (const bad of ["社内メモ", "下書き", "storage_path", "t1/retire", "sha256", "abc", "本文", "家庭の事情", "reason", "RET-2026", "d-left2", "d-sep", "d-ins", "d-wh", "e-left2", "left2"]) assert.ok(!s.includes(bad), `${bad} が出ている`);
});
await ok("別の退職者には、その人自身の書類だけ", async () => {
  as("left2"); const r = await call(portal, { url: "/api/retiree" });
  assert.equal(r.statusCode, 200); const by = Object.fromEntries(r.body.docs.map((x) => [x.kind, x]));
  assert.equal(by.certificate.id, "d-left2"); assert.equal(by.withholding.state, "preparing");
});
await ok("退職日を過ぎた leaving も入れる", async () => { as("past"); const r = await call(portal, { url: "/api/retiree" }); assert.equal(r.statusCode, 200); assert.ok(r.body.docs.every((d) => d.state === "preparing")); });
for (const id of ["hr", "member", "future"]) {
  await ok(`${id}（在籍中・退職日前）は 403 not_retired`, async () => { as(id); const r = await call(portal, { url: "/api/retiree" }); assert.equal(r.statusCode, 403); assert.equal(r.body.error, "not_retired"); });
}
await ok("ログインしていなければ 401", async () => { current = { userId: null }; const r = await call(portal, { url: "/api/retiree" }); assert.equal(r.statusCode, 401); });
await ok("書き込みはできない（POST は 405）", async () => { as("left"); const r = await call(portal, { url: "/api/retiree", method: "POST" }); assert.equal(r.statusCode, 405); });
await ok("表が無い環境（db/121 未適用）でも、ポータルは開く（すべて準備中）", async () => {
  db.absent.add("gw_retire_docs");
  try {
    as("left"); const r = await call(portal, { url: "/api/retiree" });
    assert.equal(r.statusCode, 200); assert.ok(r.body.docs.every((d) => d.state === "preparing")); assert.equal(r.body.name, "名前left");
  } finally { db.absent.clear(); }
});

console.log("[3] 退職者ポータル GET /api/retiree/file");
const get = (id, extra = "") => call(fileApi, { url: `/api/retiree/file?id=${id}${extra}` });
await ok("自分の公開中の書類は、短時間の署名付き URL を返す", async () => {
  as("left"); const r = await get("d-cert");
  assert.equal(r.statusCode, 200); assert.ok(r.body.url.startsWith("https://signed.example/")); assert.equal(r.body.expiresIn, 300);
  assert.equal(signed[0].ttl, 300); assert.equal(signed[0].opt, undefined);
});
await ok("ダウンロードは、日本語のファイル名つき", async () => {
  as("left"); const r = await get("d-cert", "&download=1");
  assert.equal(r.statusCode, 200); assert.equal(r.body.download, true); assert.match(r.body.filename, /^退職証明書_名前left_\d{8}\.pdf$/);
  assert.equal(signed.at(-1).opt.download, r.body.filename);
});
await ok("見た・保存したは操作ログに残る（URL・保存先は残さない）", async () => {
  const l = logs.filter((x) => x.action === "retire.view" || x.action === "retire.download");
  assert.equal(l.length, 2); assert.ok(l.every((x) => x.actorId === "u-left" && x.detail.docId === "d-cert"));
  assert.ok(!JSON.stringify(l).includes("signed.example") && !JSON.stringify(l).includes("t1/retire"));
});
for (const [label, id] of [["他人（別の退職者）の書類", "d-left2"], ["手続き中の行", "d-wh"], ["下書き", "d-sep"], ["未公開の発行済み", "d-ins"], ["存在しない id", "nope-1234"], ["形のおかしい id", "../etc/passwd"]]) {
  await ok(`${label}は 404（存在も教えない）`, async () => { as("left"); const r = await get(encodeURIComponent(id)); assert.equal(r.statusCode, 404); assert.equal(r.body.error, "not_found"); assert.ok(!JSON.stringify(r.body).includes("signed")); });
}
await ok("在籍中の人は、自分の書類でも取れない（403）", async () => { as("hr"); const r = await get("d-cert"); assert.equal(r.statusCode, 403); });
await ok("公開を止めたら見えない／再公開すると見える", async () => {
  const d = db.rows.gw_retire_docs.find((x) => x.id === "d-cert"); d.published = false;
  as("left"); assert.equal((await get("d-cert")).statusCode, 404); d.published = true; assert.equal((await get("d-cert")).statusCode, 200);
});
await ok("置き換え済みの古い版は取れない（新しい版が最新）", async () => {
  const d = db.rows.gw_retire_docs.find((x) => x.id === "d-cert"); d.state = "superseded"; d.published = false;
  db.rows.gw_retire_docs.push({ id: "d-cert2", ...doc("left", "certificate", { version: 2, published: true }) }); files.set(`t1/retire/e-left/certificate/f-left-certificate-2.pdf`, PDF);
  as("left"); assert.equal((await get("d-cert")).statusCode, 404); assert.equal((await get("d-cert2")).statusCode, 200);
  const list = await call(portal, { url: "/api/retiree" }); assert.equal(list.body.docs[0].id, "d-cert2");
});
await ok("保存先の実体が無ければ 404", async () => { files.delete("t1/retire/e-left/certificate/f-left-certificate-2.pdf"); as("left"); assert.equal((await get("d-cert2")).statusCode, 404); });

console.log("[4] 管理側 /api/employees/retire");
setup();
const adm = (req) => call(adminApi, { url: "/api/employees/retire", ...req });
const post = (body) => adm({ method: "POST", body });
const getA = (qs) => adm({ url: `/api/employees/retire?${qs}` });
await ok("人事は、退職手続きを見られる（退職理由・書類・進み具合）", async () => {
  as("hr"); const r = await getA("employeeId=e-left");
  assert.equal(r.statusCode, 200); assert.equal(r.body.employee.name, "名前left"); assert.equal(r.body.reason.code, "personal");
  assert.equal(r.body.kinds.length, 4); assert.equal(r.body.progress.total, 6);
  const by = Object.fromEntries(r.body.kinds.map((k) => [k.kind, k])); assert.equal(by.certificate.adminState, "published"); assert.equal(by.insurance_loss.adminState, "issued"); assert.equal(by.separation.adminState, "draft"); assert.equal(by.withholding.adminState, "processing");
  const s = JSON.stringify(r.body); assert.ok(!s.includes("t1/retire") && !s.includes("abc") && !s.includes("storage_path"));
});
for (const id of ["member", "other"]) await ok(`${id}（人事ではない・他社）は 403`, async () => { as(id); const r = await getA("employeeId=e-left"); assert.equal(r.statusCode, 403); });
await ok("退職者本人は、管理側に入れない（account_left）", async () => { as("left"); const r = await getA("employeeId=e-left"); assert.equal(r.statusCode, 403); assert.equal(r.body.error, "account_left"); });
await ok("他社の社員は 404", async () => { as("hr"); assert.equal((await getA("employeeId=e-other")).statusCode, 404); });
await ok("退職理由：構造化して保存。不正なコードは 400。ログには自由記述を残さない", async () => {
  as("hr");
  assert.equal((await post({ action: "reason", employeeId: "e-left", reasonCode: "bogus" })).statusCode, 400);
  const r = await post({ action: "reason", employeeId: "e-left2", reasonCode: "contract_end", reasonNote: "自由記述の内容" });
  assert.equal(r.statusCode, 200);
  const c = db.rows.gw_retire_cases.find((x) => x.employee_id === "e-left2"); assert.equal(c.reason_code, "contract_end"); assert.equal(c.reason_note, "自由記述の内容");
  const l = logs.find((x) => x.action === "retire.reason"); assert.equal(l.detail.reasonCode, "contract_end"); assert.ok(!JSON.stringify(l).includes("自由記述"));
});
await ok("手続き中にする／戻す。書類があるときは上書きしない（409）", async () => {
  as("hr");
  assert.equal((await post({ action: "progress", employeeId: "e-left2", kind: "separation", state: "processing", expectedOn: "2026-10-30" })).statusCode, 200);
  assert.equal(db.rows.gw_retire_docs.find((d) => d.employee_id === "e-left2" && d.kind === "separation").state, "processing");
  assert.equal((await post({ action: "progress", employeeId: "e-left2", kind: "separation", state: "none" })).statusCode, 200);
  assert.ok(!db.rows.gw_retire_docs.some((d) => d.employee_id === "e-left2" && d.kind === "separation"));
  assert.equal((await post({ action: "progress", employeeId: "e-left", kind: "certificate", state: "processing" })).statusCode, 409);
  assert.equal((await post({ action: "progress", employeeId: "e-left", kind: "separation", state: "processing", expectedOn: "2026-02-31x" })).statusCode, 400);
});
await ok("upload：PDF 以外・大きすぎるものは 400。置き場所は その人・その種類 のもの", async () => {
  as("hr");
  assert.equal((await post({ action: "upload", employeeId: "e-left", kind: "separation", mimeType: "image/png", sizeBytes: 10 })).statusCode, 400);
  assert.equal((await post({ action: "upload", employeeId: "e-left", kind: "separation", mimeType: "application/pdf", sizeBytes: 11 * 1024 * 1024 })).statusCode, 400);
  const r = await post({ action: "upload", employeeId: "e-left", kind: "separation", mimeType: "application/pdf", sizeBytes: 100 });
  assert.equal(r.statusCode, 200); assert.ok(r.body.path.startsWith("t1/retire/e-left/separation/")); assert.ok(r.body.uploadUrl);
});
await ok("register：置き場所が他人・他の種類なら 403／PDF でなければ 400（実体も消す）", async () => {
  as("hr");
  files.set("t1/retire/e-left2/separation/a1.pdf", PDF);
  assert.equal((await post({ action: "register", employeeId: "e-left", kind: "separation", path: "t1/retire/e-left2/separation/a1.pdf" })).statusCode, 403);
  files.set("t1/retire/e-left/certificate/a2.pdf", PDF);
  assert.equal((await post({ action: "register", employeeId: "e-left", kind: "separation", path: "t1/retire/e-left/certificate/a2.pdf" })).statusCode, 403);
  files.set("t1/retire/e-left/separation/a3.pdf", PNG);
  const r = await post({ action: "register", employeeId: "e-left", kind: "separation", path: "t1/retire/e-left/separation/a3.pdf" });
  assert.equal(r.statusCode, 400); assert.ok(!files.has("t1/retire/e-left/separation/a3.pdf"));
  assert.equal((await post({ action: "register", employeeId: "e-left", kind: "separation", path: "t1/retire/e-left/separation/none.pdf" })).statusCode, 400);
  files.set("t1/retire/e-left/separation/a4.pdf", PDF);
  assert.equal((await post({ action: "register", employeeId: "e-left", kind: "separation", path: "t1/retire/e-left/separation/a4.pdf", issuedOn: "2026-13-45" })).statusCode, 400);
});
await ok("register：PDF なら発行済み（公開はしない）。下書きの行は新しい版に置き換わる", async () => {
  as("hr");
  const r = await post({ action: "register", employeeId: "e-left", kind: "separation", path: "t1/retire/e-left/separation/a4.pdf", filename: "離職票.pdf", issuedOn: "2026-10-05" });
  assert.equal(r.statusCode, 200); assert.equal(r.body.document.state, "issued"); assert.equal(r.body.document.published, false); assert.equal(r.body.document.version, 2);
  const rows = db.rows.gw_retire_docs.filter((d) => d.employee_id === "e-left" && d.kind === "separation");
  assert.equal(rows.find((d) => d.version === 1).state, "superseded"); assert.equal(rows.find((d) => d.version === 2).state, "issued");
  assert.equal(JSON.stringify(r.body).includes("t1/retire"), false);
  assert.ok(logs.some((x) => x.action === "retire.register"));
});
await ok("本人にはまだ見えない（公開前）。公開すると見える", async () => {
  const id = db.rows.gw_retire_docs.find((d) => d.employee_id === "e-left" && d.kind === "separation" && d.state === "issued").id;
  as("left"); assert.equal((await get(id)).statusCode, 404);
  as("hr"); assert.equal((await post({ action: "publish", docId: id })).statusCode, 200);
  assert.ok(logs.some((x) => x.action === "retire.publish" && x.detail.docId === id));
  as("left"); assert.equal((await get(id)).statusCode, 200);
  as("hr"); assert.equal((await post({ action: "unpublish", docId: id })).statusCode, 200);
  as("left"); assert.equal((await get(id)).statusCode, 404);
  assert.ok(logs.some((x) => x.action === "retire.unpublish"));
});
await ok("再登録（再発行）：古い版は置き換え済みで残り、公開は外れる。最新の版だけ公開できる", async () => {
  as("hr");
  const old = db.rows.gw_retire_docs.find((d) => d.employee_id === "e-left" && d.kind === "insurance_loss");
  await post({ action: "publish", docId: old.id });
  files.set("t1/retire/e-left/insurance_loss/b1.pdf", PDF);
  const r = await post({ action: "register", employeeId: "e-left", kind: "insurance_loss", path: "t1/retire/e-left/insurance_loss/b1.pdf" });
  assert.equal(r.statusCode, 200); assert.equal(r.body.document.version, 2); assert.ok(logs.some((x) => x.action === "retire.reissue"));
  assert.equal(old.state, "superseded"); assert.equal(old.published, false);
  assert.equal((await post({ action: "publish", docId: old.id })).statusCode, 409);                  // 古い版は公開できない
  assert.equal(files.has(old.storage_path), true);                                                   // 古い実体は消さない（履歴）
  as("left"); assert.equal((await get(old.id)).statusCode, 404);
});
await ok("下書き・手続き中の行は、公開できない（409）", async () => {
  as("hr"); assert.equal((await post({ action: "publish", docId: "d-sep" })).statusCode, 409); assert.equal((await post({ action: "publish", docId: "d-wh" })).statusCode, 409);
  assert.equal((await post({ action: "publish", docId: "nope" })).statusCode, 404);
});
await ok("管理者の閲覧は URL を返し、操作ログに残る", async () => {
  as("hr"); const r = await getA("docId=d-cert"); assert.equal(r.statusCode, 200); assert.ok(r.body.url);
  assert.ok(logs.some((x) => x.action === "retire.admin_view" && x.detail.docId === "d-cert"));
  assert.equal((await getA("docId=d-wh")).statusCode, 404);                                          // ファイルの無い行
});
await ok("他社・一般メンバーは、書類の公開も登録もできない", async () => {
  as("member"); assert.equal((await post({ action: "publish", docId: "d-cert" })).statusCode, 403);
  as("other"); assert.equal((await post({ action: "register", employeeId: "e-left", kind: "separation", path: "x" })).statusCode, 403);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
