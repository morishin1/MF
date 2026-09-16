// 社労士の「確認 → 修正 → 承認・発行」。
//
// ■ 何を守るか
//   1. 社労士に見えるのは労働条件の依頼だけ。取り消したものは出さない
//   2. 社労士ができるのは 確認・修正・プレビュー・承認 だけ（作る・取り消すは会社）
//   3. 承認・発行の1回で、署名依頼までできる（会社が「送る」を押さなくてよい）
//   4. 空欄のままでは発行できない
//   5. 発行したら、本人と会社の両方に届く
//   6. 発行済みは二度と発行できない
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, files: {}, storage: [] };
const DEFAULTS = {
  gw_doc_orders: { status: "requested", doc_kind: "employment", conditions: {} },
  gw_sign_requests: { status: "sent", source: "generated" },
};

function table(name) {
  const f = [];
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    neq(k, v) { f.push(["!" + k, v]); return q; },
    in(k, v) { f.push([k, v]); return q; },
    is() { return q; }, not() { return q; }, gte() { return q; }, lte() { return q; },
    order() { return q; }, limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: copy(pick(name, f)), error: null }),
    single: () => Promise.resolve({ data: copy(pick(name, f)), error: null }),
    then: (fn) => Promise.resolve({ data: match(name, f).map(copy), error: null }).then(fn),
    update(row) {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        is: () => r, select: () => r,
        single: () => {
          const cur = pick(name, g);
          if (cur) Object.assign(cur, row);
          return Promise.resolve({ data: cur ? { ...cur } : { ...row }, error: null });
        },
        then: (fn) => {
          for (const cur of match(name, g)) Object.assign(cur, row);
          return Promise.resolve({ data: [row], error: null }).then(fn);
        },
      };
      return r;
    },
    insert(row) {
      const made = { ...(DEFAULTS[name] || {}), id: row.id || `${name}-${(db.rows[name] || []).length + 1}`, ...row };
      (db.rows[name] = db.rows[name] || []).push(made);
      const r = {
        select: () => r,
        single: () => Promise.resolve({ data: made, error: null }),
        then: (fn) => Promise.resolve({ data: [made], error: null }).then(fn),
      };
      return r;
    },
    upsert(row) { return q.insert(row); },
  };
  return q;
}
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([k, v]) => {
  if (k.startsWith("!")) return r[k.slice(1)] !== v;
  return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
}));
const pick = (name, filters) => match(name, filters)[0] || null;
// PostgREST の埋め込み（employee:gw_employees(...)）のかわり。
// 依頼の行には、いつも本人が付いてくる
const copy = (r) => {
  if (!r) return r;
  const out = { ...r };
  if (r.employee_id && r.doc_kind) {
    const e = (db.rows.gw_employees || []).find((x) => x.id === r.employee_id);
    if (e) out.employee = { ...e };
  }
  return out;
};

const storage = {
  from: () => ({
    createSignedUploadUrl: async (path) => ({ data: { signedUrl: `https://x/up/${path}`, token: "t" }, error: null }),
    createSignedUrl: async (path) => (db.files[path]
      ? { data: { signedUrl: `https://x/get/${path}` }, error: null }
      : { data: null, error: { message: "not found" } }),
    download: async (path) => (db.files[path]
      ? { data: { arrayBuffer: async () => db.files[path] }, error: null }
      : { data: null, error: { message: "not found" } }),
    upload: async (path, bytes) => {
      db.files[path] = Buffer.from(bytes);
      db.storage.push({ op: "upload", path });
      return { data: { path }, error: null };
    },
    remove: async (paths) => { for (const p of paths) delete db.files[p]; return { data: null, error: null }; },
  }),
};

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table, storage }), userClient: () => ({ from: table, storage }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-sr", email: "sr@example.jp" }),
                  getMemberships: async () => [] },
});
// 呼ぶ人を差し替える。ふだんは社労士
const ADVISOR = { tenantId: "t1", isAdmin: false, isHr: false, isAdvisor: true,
                  roles: ["labor_advisor"], employee: { id: "emp-sr", display_name: "社労士" } };
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: true, isAdvisor: false,
                roles: ["owner"], employee: { id: "emp-hr", display_name: "事務" } };
let who = ADVISOR;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr),
  },
});
const notified = [];
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async (n) => { notified.push(...n); return { created: n.length }; },
                  clearNotification: async () => {} },
});
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async () => {} } });
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
const advanced = [];
mock.module(atRoot("lib/onboard-advance.js"), {
  namedExports: {
    advanceFor: async (sb, ctx, id) => { advanced.push(id); return null; },
    advance: async () => null, gatherFacts: async () => ({}), gatherFactsBulk: async () => new Map(),
  },
});
const signEvents = [];
mock.module(atRoot("lib/sign-audit.js"), {
  namedExports: {
    signEvent: async (ctx, id, action) => { signEvents.push({ id, action }); },
    ipOf: () => null, uaOf: () => null,
  },
});
// PDF は本物を作らない（フォントの読み込みで重い）。中身だけ見る
const rendered = [];
mock.module(atRoot("lib/pdf-jp.js"), {
  namedExports: {
    renderContractPdf: async (p) => { rendered.push(p); return Buffer.from(`%PDF-1.4\n${p.body}`); },
    sha256: (b) => `sha-${Buffer.from(b).length}`,
    appendSignaturePage: async () => Buffer.from("%PDF-"),
    shortHash: (h) => h,
  },
});

const { default: orders } = await import(atRoot("api/sign/orders.js"));
const { ORDER_FIELDS } = await import(atRoot("lib/esign.js"));

// ---- 呼び出しの道具 --------------------------------------------------------
const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => {
  const r = res();
  await orders({ headers: { authorization: "Bearer x" }, ...req }, r);
  return r;
};
const get = (qs = "") => call({ method: "GET", url: `/api/sign/orders${qs}` });
const post = (body) => call({ method: "POST", url: "/api/sign/orders", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const FULL = Object.fromEntries(ORDER_FIELDS.map((f) => [f.key, `${f.key}の内容`]));
// 社労士が置いた書面のかわり
const SR_PDF = Buffer.from("%PDF-1.4\n社労士が作った通知書");

function setup({ conditions = FULL, status = "requested", file = false } = {}) {
  notified.length = 0; logged.length = 0; advanced.length = 0;
  signEvents.length = 0; rendered.length = 0; db.storage.length = 0;
  db.files = {};
  db.rows = {
    tenants: [{ id: "t1", name: "株式会社エイト" }],
    gw_employees: [
      { id: "emp-new", tenant_id: "t1", display_name: "山田 太郎", user_id: "u-new",
        joined_on: "2026-10-01", employment_type: "正社員", department: "営業", email: "y@8grp.co.jp" },
      { id: "emp-hr", tenant_id: "t1", display_name: "事務 花子", user_id: "u-admin" },
    ],
    gw_role_grants: [{ tenant_id: "t1", employee_id: "emp-hr", role: "hr" }],
    gw_doc_orders: [{
      id: "o1", tenant_id: "t1", employee_id: "emp-new", doc_kind: "employment",
      title: "労働条件通知書 兼 雇用契約書", conditions, status,
      note: "4月入社の方です",
      ...(file ? { file_path: "t1/doc-order/o1/x.pdf", file_name: "joken.pdf",
                   // 偽の sha256 は長さで作る（lib/pdf-jp.js を差し替えてある）
                   file_sha256: `sha-${SR_PDF.length}` } : {}),
    }],
    gw_sign_requests: [],
  };
  if (file) db.files["t1/doc-order/o1/x.pdf"] = SR_PDF;
}
const order = () => db.rows.gw_doc_orders[0];

console.log("\n=== 社労士：確認 → 修正 → 承認・発行 ===\n");
console.log("— 見えるもの —");

await ok("労働条件の依頼が見える。条件も、空欄の一覧も付いてくる", async () => {
  setup({ conditions: { 賃金: "月給30万円" } });
  const r = await get();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.orders.length, 1);
  assert.equal(r.body.orders[0].conditions["賃金"], "月給30万円");
  assert.ok(r.body.orders[0].missing.length, "空欄の一覧が無い");
  assert.equal(r.body.advisor, true);
});

await ok("入力の欄の定義も返る（画面はこれで作る）", async () => {
  setup();
  const r = await get();
  assert.equal(r.body.fields.length, ORDER_FIELDS.length);
});

await ok("社労士には、本人のメールアドレスを渡さない", async () => {
  setup();
  const r = await get();
  const e = r.body.orders[0].employee;
  assert.equal(e.display_name, "山田 太郎");
  assert.equal(e.email, undefined, "メールが混ざっています");
  assert.equal(e.joined_on, "2026-10-01");
});

await ok("労働条件以外の依頼は見せない", async () => {
  setup();
  db.rows.gw_doc_orders.push({ id: "o2", tenant_id: "t1", employee_id: "emp-new",
                               doc_kind: "equipment", title: "貸与契約", status: "requested" });
  const r = await get();
  assert.deepEqual(r.body.orders.map((o) => o.id), ["o1"]);
});

await ok("取り消した依頼も見せない", async () => {
  setup({ status: "cancelled" });
  const r = await get();
  assert.equal(r.body.orders.length, 0);
});

console.log("— できること・できないこと —");

await ok("作る・取り消す・送るは、社労士にはできない", async () => {
  setup();
  for (const action of ["create", "cancel", "send"]) {
    const r = await post({ action, id: "o1", employeeId: "emp-new" });
    assert.equal(r.statusCode, 403, action);
  }
});

await ok("条件を直せる。直したことが記録に残る", async () => {
  setup();
  const r = await post({ action: "update", id: "o1",
                         conditions: { ...FULL, 賃金: "月給 320,000円" },
                         advisorNote: "固定残業代を明記しました" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changed, ["賃金"]);
  assert.equal(order().conditions["賃金"], "月給 320,000円");
  assert.equal(order().advisor_note, "固定残業代を明記しました");
  assert.ok(order().conditions_edited_at, "直した時刻が残っていない");
  assert.ok(logged.some((l) => l.action === "doc_order.edit"));
});

await ok("社労士は、題名も期限も依頼先も変えられない", async () => {
  setup();
  await post({ action: "update", id: "o1", title: "べつの書類", dueOn: "2026-12-31",
               assigneeName: "だれか", note: "書きかえ" });
  assert.equal(order().title, "労働条件通知書 兼 雇用契約書");
  assert.equal(order().due_on, undefined);
  assert.equal(order().note, "4月入社の方です");
});

console.log("— プレビュー —");

await ok("いまの条件で、通知書の本文とPDFが出る（保存しない）", async () => {
  setup();
  const r = await post({ action: "preview", id: "o1", conditions: { ...FULL, 賃金: "月給 400,000円" } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(r.body.pdfBase64, "PDFが無い");
  assert.match(r.body.text, /月給 400,000円/);
  assert.match(r.body.text, /株式会社エイト/);
  assert.match(r.body.text, /山田 太郎/);
  assert.match(r.body.text, /2026年10月1日/, "雇入れ日が入っていない");
  // 保存はしない
  assert.equal(order().conditions["賃金"], "賃金の内容");
  assert.equal(order().status, "requested");
});

await ok("空欄は【未記入】として残る。どこが空かも返る", async () => {
  setup({ conditions: { 賃金: "月給30万円" } });
  const r = await post({ action: "preview", id: "o1" });
  assert.match(r.body.text, /【未記入：就業場所】/);
  assert.ok(r.body.missing.includes("就業場所"));
});

console.log("— 承認・発行 —");

await ok("承認・発行で、条件から通知書ができて署名依頼まで進む", async () => {
  setup();
  const r = await post({ action: "approve", id: "o1",
                         conditions: { ...FULL, 賃金: "月給 320,000円" } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.source, "advisor");

  // 依頼は発行済みになり、承認の記録が残る
  assert.equal(order().status, "sent");
  assert.ok(order().approved_at, "承認の時刻が無い");
  assert.equal(order().approved_by, "u-sr");
  assert.equal(order().conditions["賃金"], "月給 320,000円", "直した条件が保存されていない");

  // 署名依頼ができている。本文は通知書そのもの
  const sign = db.rows.gw_sign_requests[0];
  assert.ok(sign, "署名依頼ができていない");
  assert.equal(sign.employee_id, "emp-new");
  assert.equal(sign.source, "advisor");
  assert.equal(sign.order_id, "o1");
  assert.match(sign.body_snapshot, /月給 320,000円/);
  assert.ok(sign.pdf_path, "PDFの置き場所が無い");
  assert.equal(order().sign_request_id, sign.id);
  assert.ok(signEvents.some((e) => e.action === "sent"));
});

await ok("発行すると、本人と会社の両方に届く", async () => {
  setup();
  await post({ action: "approve", id: "o1" });
  const toEmployee = notified.filter((n) => n.employeeId === "emp-new");
  const toAdmin = notified.filter((n) => n.employeeId === "emp-hr");
  assert.ok(toEmployee.length, "本人に届いていない");
  assert.match(toEmployee[0].title, /署名/);
  assert.equal(toEmployee[0].link, "contracts.html");
  assert.ok(toAdmin.length, "会社に届いていない");
  assert.match(toAdmin[0].title, /社労士が/);
});

await ok("発行したら、段階を進め直す", async () => {
  setup();
  await post({ action: "approve", id: "o1" });
  assert.deepEqual(advanced, ["emp-new"]);
});

await ok("期限を省くと7日後。指定もできる", async () => {
  setup();
  const r1 = await post({ action: "approve", id: "o1" });
  assert.match(r1.body.dueOn, /^\d{4}-\d{2}-\d{2}$/);
  setup();
  const r2 = await post({ action: "approve", id: "o1", dueOn: "2026-11-30" });
  assert.equal(r2.body.dueOn, "2026-11-30");
});

await ok("空欄が残っていると発行できない", async () => {
  setup({ conditions: { 賃金: "月給30万円" } });
  const r = await post({ action: "approve", id: "o1" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "missing_conditions");
  assert.ok(r.body.missing.includes("就業場所"));
  assert.equal(order().status, "requested", "発行してしまっています");
  assert.equal(db.rows.gw_sign_requests.length, 0);
});

await ok("承知のうえなら、空欄のままでも発行できる（force）", async () => {
  setup({ conditions: { 賃金: "月給30万円" } });
  const r = await post({ action: "approve", id: "o1", force: true });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.match(db.rows.gw_sign_requests[0].body_snapshot, /【未記入：就業場所】/);
});

await ok("社労士が自分のPDFを置いていたら、その書面のまま発行する", async () => {
  setup({ status: "uploaded", file: true });
  const r = await post({ action: "approve", id: "o1" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.source, "uploaded");
  assert.equal(rendered.length, 0, "PDFを作り直してはいけない");
  assert.match(db.rows.gw_sign_requests[0].body_snapshot, /PDFで届いています/);
  assert.equal(db.rows.gw_sign_requests[0].file_name, "joken.pdf");
});

await ok("置いた書面が途中で入れ替わっていたら発行しない", async () => {
  setup({ status: "uploaded", file: true });
  order().file_sha256 = "sha-999";
  const r = await post({ action: "approve", id: "o1" });
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.error, "hash_mismatch");
  assert.equal(db.rows.gw_sign_requests.length, 0);
});

await ok("ログインできない人には発行しない", async () => {
  setup();
  db.rows.gw_employees[0].user_id = null;
  const r = await post({ action: "approve", id: "o1" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "no_account");
});

await ok("二度は発行できない", async () => {
  setup();
  await post({ action: "approve", id: "o1" });
  const r = await post({ action: "approve", id: "o1" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "already_sent");
  assert.equal(db.rows.gw_sign_requests.length, 1);
});

await ok("発行したあとは、条件を直せない", async () => {
  setup();
  await post({ action: "approve", id: "o1" });
  const r = await post({ action: "update", id: "o1", conditions: { ...FULL, 賃金: "あとから" } });
  assert.equal(r.statusCode, 409);
});

await ok("取り消した依頼は発行できない", async () => {
  setup({ status: "cancelled" });
  const r = await post({ action: "approve", id: "o1" });
  // 社労士には取り消したものが見えない（load が弾く）
  assert.ok(r.statusCode === 404 || r.statusCode === 409, String(r.statusCode));
});

console.log("— 管理者の側 —");

await ok("管理者も、自分で承認・発行できる", async () => {
  setup();
  who = ADMIN;
  try {
    const r = await post({ action: "approve", id: "o1" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(order().status, "sent");
    // 会社が自分で押したときは、会社あての「社労士が発行しました」は出さない
    assert.equal(notified.filter((n) => n.employeeId === "emp-hr").length, 0);
  } finally { who = ADVISOR; }
});

await ok("管理者は、届いたPDFのまま送ることもできる（これまでどおり）", async () => {
  setup({ status: "uploaded", file: true });
  who = ADMIN;
  try {
    const r = await post({ action: "send", id: "o1" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(db.rows.gw_sign_requests[0].source, "uploaded");
    assert.ok(logged.some((l) => l.action === "doc_order.send"));
  } finally { who = ADVISOR; }
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
