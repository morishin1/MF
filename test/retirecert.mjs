// 退職証明書：雛形 → 差し込み → PDF → 証明書用の会社印を合成 → 発行 → 本人公開。
// lib/retire-cert.js・lib/pdf-jp.js（renderCertificatePdf）・api/employees/retire-cert.js
//
// ■ 何を守るテストか
//   1. 差し込み：氏名・雇用区分・入社日・退職日・会社情報が入る。退職理由は「含める」を選んだときだけ（自動では印字しない）。
//      空の項目の行は消え、知らない項目・空の必須項目は「残っている」として発行を止める
//   2. PDF：会社印が、発行元（会社名〜代表者名）の右・本文の下に、ページの中に収まって合成される。印なし（プレビュー）には画像が無い
//   3. 権限：下書き・プレビューは人事・管理者。発行・押印は経営者・管理者だけ。人事だけ・一般メンバー・退職者本人は押せない
//   4. 印鑑：証明書用（certificate）だけを使う。契約書用の印鑑しか無ければ発行できない。画像・パス・ハッシュは応答にも操作ログにも出ない
//   5. 発行：発行番号（RET-年-連番）・発行日・版。再発行は新しい版で、古い版は置き換え済みで残る。公開は管理者が押すまでしない
//   6. 失敗しても、有効な行が無くならない（置き換えた行を元に戻す）。番号が重なったら取り直す
//   7. 本人：公開すると、その PDF だけ取れる。印鑑の画像は、本人のどの経路からも取れない
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
import { PDFDocument, PDFName } from "pdf-lib";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const atRoot = (p) => _join(ROOT, p);

const ymdOffset = (d) => new Date(Date.now() + 9 * 3600000 + d * 86400000).toISOString().slice(0, 10);
const TODAY = ymdOffset(0), YESTERDAY = ymdOffset(-1), TOMORROW = ymdOffset(1);
const YEAR = TODAY.slice(0, 4);

// 本物の PNG（赤い 24x24）。印影の代わり
function makePng(w = 24, h = 24) {
  const crc = (buf) => { let c, crcv = 0xffffffff; for (const b of buf) { c = (crcv ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcv = (crcv >>> 8) ^ c; } return (crcv ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td)); return Buffer.concat([len, td, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 200; raw[o + 1] = 20; raw[o + 2] = 20; } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const SEAL_PNG = makePng();
const sha = async (b) => (await import("node:crypto")).createHash("sha256").update(b).digest("hex");

// ---- 偽の DB と Storage -------------------------------------------------------
const db = { rows: {}, n: 0, failInsert: 0 };
const files = new Map();
const logs = [];
let current = { userId: null };

function table(name) {
  const f = []; let op = null, payload = null, onConflict = "id", one = false, order = null, notNull = null;
  const match = (r) => f.every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v));
  const all = () => (db.rows[name] = db.rows[name] || []);
  const run = () => {
    const list = all();
    if (op === "insert") {
      if (name === "gw_retire_docs" && db.failInsert > 0) { db.failInsert--; return { data: null, error: { code: "23505", message: "dup issued_no" } }; }
      const rows = [].concat(payload).map((r) => ({ id: `${name}-${++db.n}`, ...r }));
      for (const r of rows) {
        if (name === "gw_retire_docs" && r.state !== "superseded" && list.some((x) => x.employee_id === r.employee_id && x.kind === r.kind && x.state !== "superseded")) return { data: null, error: { code: "23505", message: "live" } };
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
    if (op === "update") { const hit = list.filter(match); for (const r of hit) Object.assign(r, payload); return { data: one ? (hit[0] ? { ...hit[0] } : null) : hit.map((r) => ({ ...r })), error: null }; }
    if (op === "delete") { db.rows[name] = list.filter((r) => !match(r)); return { data: null, error: null }; }
    let rows = list.filter(match).map((r) => ({ ...r }));
    if (order) rows.sort((a, b) => (a[order] ?? 0) - (b[order] ?? 0));
    return { data: one ? (rows[0] || null) : rows, error: null };
  };
  const q = {
    select() { return q; }, eq(k, v) { f.push([k, v]); return q; }, in(k, v) { f.push([k, v]); return q; },
    neq() { return q; }, lt() { return q; }, limit() { return q; }, order(k) { order = k; return q; }, not() { return q; },
    insert(v) { op = "insert"; payload = v; return q; }, upsert(v, o = {}) { op = "upsert"; payload = v; onConflict = o.onConflict || "id"; return q; },
    update(v) { op = "update"; payload = v; return q; }, delete() { op = "delete"; return q; },
    maybeSingle() { one = true; return Promise.resolve(run()); }, single() { one = true; return Promise.resolve(run()); },
    then(fn, rej) { return Promise.resolve(run()).then(fn, rej); },
  };
  return q;
}
const signed = [];
const storage = { from: () => ({
  createSignedUrl: async (path, ttl, opt) => { if (!files.has(path)) return { data: null, error: { message: "nf" } }; signed.push({ path, ttl, opt }); return { data: { signedUrl: `https://signed.example/${path}` }, error: null }; },
  createSignedUploadUrl: async (path) => ({ data: { signedUrl: `https://upload.example/${path}`, token: "t" }, error: null }),
  upload: async (path, bytes) => { files.set(path, Buffer.from(bytes)); return { data: { path }, error: null }; },
  download: async (path) => (files.has(path) ? { data: { arrayBuffer: async () => files.get(path) }, error: null } : { data: null, error: { message: "nf" } }),
  remove: async (paths) => { for (const p of paths) files.delete(p); return { data: null, error: null }; },
}) };
mock.module(atRoot("lib/supabase.js"), { namedExports: {
  admin: () => ({ from: table, storage }),
  userClient: () => ({ from: table, storage, auth: { getUser: async () => (current.userId ? { data: { user: { id: current.userId } }, error: null } : { data: null, error: { message: "no" } }) } }),
} });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logs.push(e); } } });
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });

const { resetLeftCache } = await import(atRoot("lib/auth.js"));
const cert = await import(atRoot("lib/retire-cert.js"));
const { renderCertificatePdf } = await import(atRoot("lib/pdf-jp.js"));
const { default: certApi } = await import(atRoot("api/employees/retire-cert.js"));
const { default: retireApi } = await import(atRoot("api/employees/retire.js"));
const { default: portal } = await import(atRoot("api/retiree/index.js"));
const { default: fileApi } = await import(atRoot("api/retiree/file.js"));

const res = () => { const r = { statusCode: 0, body: null, headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } }; return r; };
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, method: "POST", url: "/api/x", ...req }, r); return r; };
const as = (id) => { current = { userId: `u-${id}` }; };
let pass = 0, fail = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); } };

const emp = (id, status, left_on = null, tenant = "t1") => ({ id: `e-${id}`, tenant_id: tenant, user_id: `u-${id}`, display_name: `名前${id}`, email: `${id}@x`, employment_type: "アルバイト", joined_on: "2025-04-01", status, left_on });
async function setup({ seals = true } = {}) {
  resetLeftCache(); logs.length = 0; signed.length = 0; files.clear(); db.n = 0; db.failInsert = 0; current = { userId: null };
  const sealPath = "t1/seal/cert-1.png", contractSealPath = "t1/seal/contract-1.png";
  files.set(sealPath, SEAL_PNG); files.set(contractSealPath, SEAL_PNG);
  db.rows = {
    tenants: [{ id: "t1", name: "株式会社エイト" }],
    gw_employees: [emp("left", "left", YESTERDAY), emp("leaving", "leaving", TOMORROW), emp("noleft", "leaving"), emp("active", "active"), emp("owner", "active"), emp("hr", "active"), emp("member", "active")],
    gw_role_grants: [{ id: "g1", tenant_id: "t1", employee_id: "e-owner", role: "owner" }, { id: "g2", tenant_id: "t1", employee_id: "e-hr", role: "hr" }],
    gw_app_grants: [{ tenant_id: "t1", employee_id: "e-hr", app_key: "office" }, { tenant_id: "t1", employee_id: "e-hr", app_key: "hr" }],
    memberships: [],
    gw_retire_cases: [{ id: "c1", tenant_id: "t1", employee_id: "e-left", reason_code: "contract_end", reason_note: "社内の補足メモ" }],
    gw_retire_company: [{ tenant_id: "t1", representative: "代表取締役 森田 太郎", address: "東京都千代田区1-1-1" }],
    gw_retire_docs: [],
    gw_doc_templates: [{ id: "tpl-1", tenant_id: "t1", name: "退職証明書（標準）", kind: "offboarding", body: "{{氏名}} 様\n退職日 {{退職日}}\n{{退職理由}}" }, { id: "tpl-x", tenant_id: "t2", name: "他社", kind: "offboarding", body: "他社の雛形" }],
    gw_seals: seals ? [
      { id: "seal-cert", tenant_id: "t1", name: "証明書発行用印", seal_type: "certificate", image_path: sealPath, image_mime: "image/png", image_sha256: await sha(SEAL_PNG), is_active: true, sort_order: 1 },
      { id: "seal-rep", tenant_id: "t1", name: "代表者印", seal_type: "representative", image_path: contractSealPath, image_mime: "image/png", image_sha256: await sha(SEAL_PNG), is_active: true, sort_order: 0 },
    ] : [{ id: "seal-rep", tenant_id: "t1", name: "代表者印", seal_type: "representative", image_path: contractSealPath, image_mime: "image/png", image_sha256: await sha(SEAL_PNG), is_active: true, sort_order: 0 }],
  };
}
const certPost = (body) => call(certApi, { body });
const draft = (o = {}) => certPost({ action: "draft", employeeId: "e-left", ...o });
const issue = (o = {}) => certPost({ action: "issue", employeeId: "e-left", body: "名前left 殿\n下記のとおり、証明します。", ...o });

console.log("[1] 差し込み lib/retire-cert.js");
await ok("氏名・雇用区分・入社日・退職日・会社情報が入る。日付は 2026年9月30日 の形", () => {
  const v = cert.certValues({ employee: emp("x", "left", "2026-09-30"), reasonLabel: "自己都合", company: { name: "株式会社エイト", address: "東京", representative: "森田" }, issuedOn: "2026-10-06", issuedNo: "RET-2026-0001", includeReason: false });
  const m = cert.mergeCertificate(cert.DEFAULT_TEMPLATE, v);
  assert.ok(m.text.includes("名前x 殿") && m.text.includes("雇用区分：アルバイト") && m.text.includes("入社日：2025年4月1日") && m.text.includes("退職日：2026年9月30日"));
  assert.deepEqual(m.unresolved, []);
  assert.equal(cert.dateJa("2026-10-06"), "2026年10月6日");
});
await ok("退職理由は、含めないときは行ごと消える（自動では印字しない）／含めると入る", () => {
  const base = { employee: emp("x", "left", "2026-09-30"), reasonLabel: "契約期間満了", company: { name: "会社" } };
  const off = cert.mergeCertificate(cert.DEFAULT_TEMPLATE, cert.certValues({ ...base, includeReason: false }));
  assert.ok(!off.text.includes("退職の事由") && !off.text.includes("契約期間満了"));
  const on = cert.mergeCertificate(cert.DEFAULT_TEMPLATE, cert.certValues({ ...base, includeReason: true }));
  assert.ok(on.text.includes("退職の事由：契約期間満了"));
});
await ok("知らない項目・空の必須項目は、残る（unresolved）", () => {
  const m = cert.mergeCertificate("{{氏名}} {{未知}} {{入社日}}", cert.certValues({ employee: { display_name: "A" } }));
  assert.deepEqual(m.unresolved.sort(), ["{{入社日}}", "{{未知}}"].sort());
  assert.deepEqual(cert.leftoverFields("a {{x}} b {{x}} {{y}}").sort(), ["{{x}}", "{{y}}"]);
});

console.log("[2] PDF と会社印の位置");
const dump = async (bytes) => { const d = await PDFDocument.load(bytes); let images = 0; for (const [, o] of d.context.enumerateIndirectObjects()) { const st = o.dict?.get?.(PDFName.of("Subtype")); if (st && String(st) === "/Image") images++; } return { pages: d.getPageCount(), images, title: d.getTitle() }; };
const PARAMS = { title: "退職証明書", body: "山田 太郎 殿\n\n下記のとおり、当社を退職したことを証明します。\n\n氏名：山田 太郎\n退職日：2026年9月30日", company: "株式会社エイト", address: "東京都千代田区1-1-1", representative: "代表取締役 森田 太郎", issuedOn: "2026年10月6日", issuedNo: "RET-2026-0012" };
await ok("会社印は、発行元の右・本文の下・ページの中に収まる。画像は1つ", async () => {
  const r = await renderCertificatePdf({ ...PARAMS, seal: { bytes: SEAL_PNG, mime: "image/png" } });
  assert.equal(Buffer.from(r.bytes.slice(0, 5)).toString(), "%PDF-");
  const L = r.layout; const s = L.seal;
  assert.ok(s, "印影が合成されている");
  assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= L.page.w && s.y + s.h <= L.page.h, "ページの中");
  assert.ok(s.x >= L.issuer.right - 1, `発行元の文字より右（seal.x=${s.x} issuer.right=${L.issuer.right}）`);
  assert.ok(s.y + s.h <= L.bodyBottom, "本文より下");
  assert.ok(s.y + s.h / 2 <= L.issuer.top && s.y + s.h / 2 >= L.issuer.bottom, "発行元（会社名〜代表者名）の高さの中");
  const d = await dump(r.bytes); assert.equal(d.pages, 1); assert.equal(d.images, 1); assert.equal(d.title, "退職証明書");
});
await ok("印なし（プレビュー）には、画像が無い。透かし入り", async () => {
  const r = await renderCertificatePdf({ ...PARAMS, issuedNo: "（未発行）", seal: null, watermark: "プレビュー（未発行）" });
  assert.equal(r.layout.seal, null); assert.equal((await dump(r.bytes)).images, 0);
});
await ok("長い本文でも、会社印はページの中に収まる（次のページにはみ出さない）", async () => {
  const r = await renderCertificatePdf({ ...PARAMS, body: Array.from({ length: 40 }, (_, i) => `行${i + 1}　退職証明の本文です。`).join("\n"), seal: { bytes: SEAL_PNG, mime: "image/png" } });
  const s = r.layout.seal; assert.ok(s.y >= 0 && s.y + s.h <= r.layout.page.h);
  assert.equal((await dump(r.bytes)).images, 1);
});

console.log("[3] 下書き・プレビュー");
await setup();
await ok("人事は下書きを作れる：差し込み済み・退職理由は既定で入らない・会社情報・雛形・印鑑は名前だけ", async () => {
  as("hr"); const r = await draft();
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.body.includes("名前left 殿") && r.body.body.includes("退職日：" + cert.dateJa(YESTERDAY)));
  assert.ok(!r.body.body.includes("退職の事由") && !r.body.body.includes("契約期間満了"));
  assert.equal(r.body.company.name, "株式会社エイト"); assert.equal(r.body.company.representative, "代表取締役 森田 太郎");
  assert.deepEqual(r.body.templates, [{ id: "tpl-1", name: "退職証明書（標準）" }]);
  assert.deepEqual(r.body.seals, [{ id: "seal-cert", name: "証明書発行用印" }]);      // 契約用印は出ない。画像・パスも出ない
  assert.equal(r.body.canStamp, false);
  const s = JSON.stringify(r.body); for (const bad of ["image_path", "seal/cert", "sha256", "image_sha", "contract-1", "社内の補足メモ"]) assert.ok(!s.includes(bad), `${bad} が出ている`);
});
await ok("退職理由を「含める」にすると、本文に入る（構造化した理由の名前だけ）", async () => {
  as("hr"); const r = await draft({ includeReason: true });
  assert.ok(r.body.body.includes("退職の事由：契約期間満了")); assert.ok(!r.body.body.includes("社内の補足メモ"));
});
await ok("雛形を選ぶと、その雛形で差し込む。他社の雛形は 404", async () => {
  as("hr"); const r = await draft({ templateId: "tpl-1", includeReason: true });
  assert.ok(r.body.body.startsWith("名前left 様")); assert.ok(r.body.body.includes("契約期間満了"));
  assert.equal((await draft({ templateId: "tpl-x" })).statusCode, 404);
});
await ok("経営者の下書きは canStamp = true", async () => { as("owner"); assert.equal((await draft()).body.canStamp, true); });
await ok("プレビュー：印なしの PDF を返す。何も保存しない", async () => {
  as("hr"); const r = await certPost({ action: "preview", employeeId: "e-left", body: "名前left 殿\n本文" });
  assert.equal(r.statusCode, 200); const bytes = Buffer.from(r.body.pdfBase64, "base64");
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-"); assert.equal((await dump(bytes)).images, 0);
  assert.equal(db.rows.gw_retire_docs.length, 0); assert.equal([...files.keys()].filter((k) => k.includes("/retire/")).length, 0);
  assert.ok(!JSON.stringify(logs).includes("本文"));
});
await ok("一般メンバー・他社は下書きも作れない／退職者本人は入れない", async () => {
  as("member"); assert.equal((await draft()).statusCode, 403);
  as("left"); const r = await draft(); assert.equal(r.statusCode, 403); assert.equal(r.body.error, "account_left");
});
await ok("会社の代表者名・住所を保存できる（人事）", async () => {
  as("hr"); assert.equal((await certPost({ action: "company", representative: "代表 次郎", address: "大阪市1-2-3" })).statusCode, 200);
  const c = db.rows.gw_retire_company.find((x) => x.tenant_id === "t1"); assert.equal(c.representative, "代表 次郎");
  c.representative = "代表取締役 森田 太郎"; c.address = "東京都千代田区1-1-1";
});

console.log("[4] 発行・押印");
await setup();
await ok("人事だけでは押せない（seal_forbidden）。一般メンバーも不可", async () => {
  as("hr"); const r = await issue(); assert.equal(r.statusCode, 403); assert.equal(r.body.error, "seal_forbidden");
  as("member"); assert.equal((await issue()).statusCode, 403);
  assert.equal(db.rows.gw_retire_docs.length, 0);
});
await ok("退職手続き中・退職の人だけ／退職日が必要", async () => {
  as("owner");
  assert.equal((await issue({ employeeId: "e-active" })).statusCode, 409);
  const r = await issue({ employeeId: "e-noleft" }); assert.equal(r.statusCode, 400); assert.equal(r.body.error, "no_left_on");
});
await ok("差し込み項目が残っていたら発行できない／会社情報が足りなければ発行できない", async () => {
  as("owner");
  const r = await issue({ body: "{{氏名}} 殿 {{未知}}" }); assert.equal(r.statusCode, 400); assert.equal(r.body.error, "unresolved_fields"); assert.ok(r.body.fields.includes("{{氏名}}"));
  const c = db.rows.gw_retire_company[0]; const keep = c.address; c.address = null;
  const r2 = await issue(); assert.equal(r2.statusCode, 400); assert.equal(r2.body.error, "company_incomplete"); c.address = keep;
});
await ok("契約書用の印鑑しか無いときは、発行できない（証明書用だけを使う）", async () => {
  await setup({ seals: false }); as("owner");
  const r = await issue(); assert.equal(r.statusCode, 409); assert.equal(r.body.error, "no_certificate_seal");
  assert.equal(db.rows.gw_retire_docs.length, 0);
  await setup(); // 戻す
});
await ok("経営者が発行：発行済み・第1版・番号 RET-年-0001・未公開。PDF に印影が入る", async () => {
  as("owner"); const r = await issue({ includeReason: true });
  assert.equal(r.statusCode, 200);
  const d = r.body.document; assert.equal(d.state, "issued"); assert.equal(d.version, 1); assert.equal(d.published, false); assert.equal(d.issuedNo, `RET-${YEAR}-0001`); assert.equal(d.includeReason, true); assert.equal(d.issuedOn, TODAY);
  const row = db.rows.gw_retire_docs.find((x) => x.id === d.id);
  assert.ok(row.storage_path.startsWith("t1/retire/e-left/certificate/") && row.storage_path.endsWith(".pdf"));
  const pdf = files.get(row.storage_path); assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const info = await dump(pdf); assert.equal(info.images, 1, "会社印が合成されている"); assert.equal(info.pages, 1);
  assert.equal(row.sha256, await sha(pdf)); assert.equal(row.file_size, pdf.length); assert.ok(row.body_snapshot.includes("名前left"));
});
await ok("応答・操作ログに、印影・パス・ハッシュ・本文・URL が出ない", async () => {
  const l = logs.find((x) => x.action === "retire.issue");
  assert.ok(l); assert.equal(l.detail.issuedNo, `RET-${YEAR}-0001`); assert.equal(l.detail.sealId, "seal-cert");
  const s = JSON.stringify(logs); for (const bad of ["seal/cert", "t1/retire", "sha256", "名前left 殿", "signed.example", "image"]) assert.ok(!s.includes(bad), `ログに ${bad}`);
  const doc = db.rows.gw_retire_docs[0];
  const as2 = JSON.stringify((await (async () => { as("owner"); return call(retireApi, { method: "GET", url: `/api/employees/retire?employeeId=e-left` }); })()).body);
  for (const bad of ["seal/cert", "t1/retire", "sha256", doc.storage_path, "body_snapshot"]) assert.ok(!as2.includes(bad), `管理側の応答に ${bad}`);
});
await ok("発行しただけでは、本人に見えない。公開すると見える。印鑑の画像は本人のどの経路からも取れない", async () => {
  const id = db.rows.gw_retire_docs[0].id;
  as("left"); assert.equal((await call(fileApi, { method: "GET", url: `/api/retiree/file?id=${id}` })).statusCode, 404);
  assert.equal(JSON.stringify((await call(portal, { method: "GET", url: "/api/retiree" })).body).includes(id), false);
  as("owner"); assert.equal((await call(retireApi, { body: { action: "publish", docId: id } })).statusCode, 200);
  as("left"); const f = await call(fileApi, { method: "GET", url: `/api/retiree/file?id=${id}` });
  assert.equal(f.statusCode, 200); assert.ok(f.body.url.includes("/retire/e-left/certificate/")); assert.ok(!f.body.url.includes("seal"));
  for (const sid of ["seal-cert", "seal-rep", "gw_seals-1", "t1/seal/cert-1.png"]) assert.equal((await call(fileApi, { method: "GET", url: `/api/retiree/file?id=${encodeURIComponent(sid)}` })).statusCode, 404);
  const p = await call(portal, { method: "GET", url: "/api/retiree" }); assert.ok(!JSON.stringify(p.body).includes("seal"));
});
await ok("再発行：第2版・番号は次（0002）。古い版は置き換え済みで残り、公開は外れる。本人には古い版が見えない", async () => {
  as("owner"); const old = db.rows.gw_retire_docs[0]; const oldPath = old.storage_path;
  const r = await issue({ body: "名前left 殿\n修正した本文" });
  assert.equal(r.statusCode, 200); assert.equal(r.body.document.version, 2); assert.equal(r.body.document.issuedNo, `RET-${YEAR}-0002`);
  assert.equal(old.state, "superseded"); assert.equal(old.published, false); assert.ok(files.has(oldPath), "古い PDF は消さない（履歴）");
  assert.ok(logs.some((x) => x.action === "retire.reissue" && x.detail.supersedes === old.id));
  as("left"); assert.equal((await call(fileApi, { method: "GET", url: `/api/retiree/file?id=${old.id}` })).statusCode, 404);
  assert.equal((await call(fileApi, { method: "GET", url: `/api/retiree/file?id=${r.body.document.id}` })).statusCode, 404, "新しい版は、公開するまで見えない");
});
await ok("発行番号が重なったら、取り直す", async () => {
  as("owner"); db.failInsert = 2;
  const r = await issue({ body: "名前left 殿\n三版" });
  assert.equal(r.statusCode, 200); assert.equal(r.body.document.version, 3);
  assert.ok(Number(r.body.document.issuedNo.split("-")[2]) >= 3);
});
await ok("入れるのに失敗しても、有効な行は無くならない（元に戻す）。置いた PDF も残さない", async () => {
  as("owner"); const before = db.rows.gw_retire_docs.filter((x) => x.state !== "superseded").map((x) => ({ id: x.id, state: x.state }));
  const filesBefore = files.size; db.failInsert = 99;
  const r = await issue({ body: "名前left 殿\n失敗する版" });
  assert.equal(r.statusCode, 500); db.failInsert = 0;
  const after = db.rows.gw_retire_docs.filter((x) => x.state !== "superseded").map((x) => ({ id: x.id, state: x.state }));
  assert.deepEqual(after, before, "有効な行が元のまま");
  assert.equal(files.size, filesBefore, "失敗した PDF は残らない");
});
await ok("無効にした印鑑・他社の印鑑は使えない（sealId を指定しても）", async () => {
  as("owner"); db.rows.gw_seals.find((x) => x.id === "seal-cert").is_active = false;
  const r = await issue(); assert.equal(r.statusCode, 409); assert.equal(r.body.error, "no_certificate_seal");
  db.rows.gw_seals.find((x) => x.id === "seal-cert").is_active = true;
  const r2 = await issue({ sealId: "seal-rep" }); assert.equal(r2.statusCode, 409, "契約用の印鑑は、sealId で指定しても使えない");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
