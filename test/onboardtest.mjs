// 入社手続きの「ご提出いただく書類」。
//
// ■ 何が起きたか
//
//   6つの書類すべてに
//     「この書類は、いまのチェックリストに結び付いていません」
//   とだけ出て、出す口（アップロード）が1つも出なくなっていた。
//
//   原因は、チェックリストの項目に item_key が入っていなかったこと。
//   鍵だけで突き合わせると、その項目は
//     ・documents では見つからない（itemId が null）
//     ・myItems からも外れる（題名が定義と一致するので、定義側の扱い）
//   のどちらにも入らず、画面から消える。
//
//   item_key は途中から足したものなので、それ以前に作られた人の
//   チェックリストは全部これに当たる。
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- SELECT した列だけ返す（本物の PostgREST と同じ）--------------------------
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
  return out.map((s) => s.trim()).filter(Boolean)
    .map((s) => s.split("(")[0].split(":")[0].trim());
}
function project(row, spec) {
  if (!row) return row;
  const keep = cols(spec);
  if (!keep) return row;
  const out = {};
  for (const k of keep) if (k in row) out[k] = row[k];
  return out;
}

const db = { rows: {}, fail: null };

function table(name) {
  const f = [];
  const q = {
    _cols: null,
    select(spec) { q._cols = spec; return q; },
    eq(k, v) { f.push([k, v]); return q; },
    in(k, vs) { f.push([k, vs]); return q; },
    is() { return q; },
    not() { return q; },
    gte() { return q; }, lte() { return q; }, lt() { return q; },
    order() { return q; },
    limit(n) { q._limit = n; return q; },
    maybeSingle() { return Promise.resolve({ data: project(match(name, f)[0] || null, q._cols), error: null }); },
    single() { return Promise.resolve({ data: project(match(name, f)[0] || null, q._cols), error: null }); },
    then(fn) {
      // 無い列を SELECT したときに本物が返すもの
      if (db.fail === name) {
        return Promise.resolve({ data: null, error: {
          code: "42703", message: `column ${name}.item_key does not exist` } }).then(fn);
      }
      let rows = match(name, f).map((r) => project(r, q._cols));
      if (q._limit) rows = rows.slice(0, q._limit);
      return Promise.resolve({ data: rows, error: null }).then(fn);
    },
    insert(row) {
      const made = { id: `${name}-x`, ...row };
      (db.rows[name] = db.rows[name] || []).push(made);
      const r = { select: () => r, single: () => Promise.resolve({ data: made, error: null }),
                  then: (fn) => Promise.resolve({ data: [made], error: null }).then(fn) };
      return r;
    },
    update() {
      const r = { eq: () => r, is: () => r, select: () => r,
                  then: (fn) => Promise.resolve({ data: [], error: null }).then(fn) };
      return r;
    },
    delete() {
      const r = { eq: () => r, then: (fn) => Promise.resolve({ data: [], error: null }).then(fn) };
      return r;
    },
  };
  return q;
}
const match = (name, filters) => (db.rows[name] || []).filter((r) => filters.every(([k, v]) =>
  (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));

mock.module(atRoot("lib/supabase.js"), {
  namedExports: {
    admin: () => ({ from: table }),
    userClient: () => ({ from: table }),
  },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1", email: "yamauchi@8grp.co.jp" }),
                  getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => ({
      tenantId: "t1", isAdmin: false, isHr: false, memberships: [], roles: [],
      employee: { id: "emp-1", tenant_id: "t1", display_name: "山内 美紀" },
    }),
    canManageHr: () => false,
  },
});
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async () => {} } });
// ドライブは使えない状態にしておく。
// 使えなくても、この画面から直接あげる道は残っていないといけない
mock.module(atRoot("lib/hr-drive.js"), {
  namedExports: {
    linkOf: (id) => `https://drive.google.com/drive/folders/${id}`,
    shareEmployeeFolders: async () => ({ ready: false, note: "会社のドライブがまだ使えません。" }),
    ensureProcedureFolder: async () => null,
    ensureProcedureFolders: async () => null,
    shareAdvisorFolder: async () => null,
    canAutoShare: () => false,
    folderIdFromUrl: () => null,
  },
});
mock.module(atRoot("lib/gdrive.js"), { namedExports: { hrConfigured: () => false } });

const { default: me } = await import(atRoot("api/onboarding/me.js"));
const { DOCS } = await import(atRoot("lib/onboard-docs.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async () => {
  const r = res();
  await me({ method: "GET", url: "/api/onboarding/me", headers: { authorization: "Bearer x" } }, r);
  return r;
};

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

/** その人の手続きを、item_key の有無を変えて作る */
function setup({ withKey }) {
  db.rows = {
    gw_employees: [{ id: "emp-1", tenant_id: "t1", display_name: "山内 美紀",
                     status: "active", joined_on: "2026-09-01" }],
    gw_procedures: [{ id: "pr-1", tenant_id: "t1", employee_id: "emp-1",
                      kind: "onboarding", status: "open", drive_folder_id: null }],
    // 本人が出す書類。鍵が入っている／いないを切り替える
    gw_procedure_items: DOCS.map((d, n) => ({
      id: `it-${n}`, tenant_id: "t1", procedure_id: "pr-1",
      item_key: withKey ? d.key : null,
      title: d.title, category: "document", owner: "employee",
      required: d.required !== false, status: "todo",
      due_on: null, note: null, sort_order: n, document_id: null, submitted_at: null,
    })),
    gw_procedure_files: [],
    gw_contracts: [], gw_employee_profiles: [],
  };
}

console.log("\n=== 入社手続き：出す口がちゃんと出るか ===\n");

console.log("— 鍵が入っているとき（ふつう）—");
await ok("6つとも、出す口につながっている", async () => {
  setup({ withKey: true });
  const r = await call();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  const docs = r.body.documents || [];
  assert.equal(docs.length, DOCS.length, `${docs.length} 件`);
  const dead = docs.filter((d) => !d.itemId);
  assert.equal(dead.length, 0,
    `つながっていない書類がある: ${dead.map((d) => d.title).join("、")}`);
});

console.log("\n— 鍵が入っていないとき（item_key を足す前に作られた人）—");
await ok("題名で引き直して、出す口につながる", async () => {
  setup({ withKey: false });
  const r = await call();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 200));
  const docs = r.body.documents || [];
  const dead = docs.filter((d) => !d.itemId);
  assert.equal(dead.length, 0,
    "鍵が無い人で、出す口が消えています（title で引き直せていません）: "
    + dead.map((d) => d.title).join("、"));
});

await ok("同じ項目を2つの書類に使い回さない", async () => {
  setup({ withKey: false });
  const r = await call();
  const ids = (r.body.documents || []).map((d) => d.itemId);
  assert.equal(new Set(ids).size, ids.length, "同じ itemId が2か所で使われています");
});

await ok("鍵が無くても、余りものとして二重に出さない", async () => {
  setup({ withKey: false });
  const r = await call();
  // 定義にある書類は documents 側だけに出る。myItems にも出ると2回並ぶ
  const extra = (r.body.myItems || []).map((i) => i.title);
  const defined = DOCS.map((d) => d.title);
  const dup = extra.filter((t) => defined.includes(t));
  assert.equal(dup.length, 0, `二重に出ています: ${dup.join("、")}`);
});

console.log("\n— 人が手で足した項目は、これまでどおり別に出る —");
await ok("定義に無い項目は myItems に出る", async () => {
  setup({ withKey: true });
  db.rows.gw_procedure_items.push({
    id: "it-x", tenant_id: "t1", procedure_id: "pr-1", item_key: null,
    title: "健康診断の結果", category: "document", owner: "employee",
    required: true, status: "todo", due_on: null, note: null,
    sort_order: 99, document_id: null, submitted_at: null,
  });
  const r = await call();
  const extra = (r.body.myItems || []).map((i) => i.title);
  assert.ok(extra.includes("健康診断の結果"), `myItems: ${extra.join("、")}`);
});

console.log("\n— ドライブが使えなくても、出す口は残る —");
await ok("ドライブが無くても itemId は付く", async () => {
  setup({ withKey: true });
  const r = await call();
  assert.equal(r.body.drive?.ready, false, "ドライブは使えない状態にしてある");
  assert.ok((r.body.documents || []).every((d) => d.itemId),
    "ドライブが無いときこそ、この画面から出せないと詰む");
});

console.log("\n— 読めなかったときに、黙って空にしない —");
await ok("item_key の列が無ければ、何を流すか言う", async () => {
  setup({ withKey: true });
  db.fail = "gw_procedure_items";
  const r = await call();
  db.fail = null;
  assert.equal(r.statusCode, 503, `いま ${r.statusCode}`);
  assert.ok(/037_onboard_form/.test(r.body.message || ""),
    `何を流せばよいか書いていない: ${r.body.message}`);
});

await ok("読めなかったのに「書類0件」で通さない", async () => {
  setup({ withKey: true });
  db.fail = "gw_procedure_items";
  const r = await call();
  db.fail = null;
  // 200 で空を返すと、画面は「結び付いていません」とだけ出す。
  // 何が起きたのか、誰にも分からない
  assert.notEqual(r.statusCode, 200, "読めていないのに 200 を返している");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
if (fail) { console.log(`${fail} 件 NG`); process.exit(1); }
