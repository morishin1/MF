// 採用HR Stage 8：本採用へ進める（api/hr/applicants/advance.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. admin-onboard.html?applicantId=… が、採用条件の事前入力をサーバ側
//      から取得できる（GET）。admin-onboard.htmlの項目名（camelCase）で返す。
//      給与・勤務条件はここでしか渡さない（URLには載せない）
//   2. 承諾済み（accepted）の応募者だけ、手続きを始められる（POST claim）。
//      二重に進まないよう advance_claimed_at を確保する
//   3. すでに手続き中（有効なクレームあり）でも、同じ人がやり直せる（resumed）
//   4. クレームが古ければ（1時間超）、やり直しとして再取得できる
//   5. 手続きをやめられる（release）
//   6. 社員ができたら、応募者側を確定できる（complete）。employee_id は
//      1応募者につき1回だけ埋まる（二重確定を防ぐ）
//   7. 社長・管理者だけができる。recruiter・hrだけの人は使えない
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };
const logged = [];

function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "is") return v === null ? r[k] == null : r[k] != null;
    return true;
  }));
  const e = () => (db.missing === name ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle: () => Promise.resolve({ data: e() ? null : copy(rows()[0]) || null, error: e() }),
    then: (fn) => Promise.resolve({ data: e() ? null : rows().map(copy), error: e() }).then(fn),
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        is: (k, v) => { g.push(["is", k, v]); return r2; },
        select: () => r2,
        maybeSingle: () => apply(),
        then: (fn) => apply({ asList: true }).then(fn),
      };
      function apply(opts) {
        const hit = (db.rows[name] || []).filter((x) => g.every(([op, k, v]) => {
          if (op === "is") return v === null ? x[k] == null : x[k] != null;
          return x[k] === v;
        }));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve(opts?.asList ? { data: hit.map(copy), error: null } : { data: copy(hit[0]) || null, error: null });
      }
      return r2;
    },
    insert(row) {
      const made = [].concat(row).map((r, n) => ({
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: r.created_at || new Date().toISOString(), ...r,
      }));
      if (!e()) (db.rows[name] = db.rows[name] || []).push(...made);
      return { then: (fn) => Promise.resolve({ data: e() ? null : made.map(copy), error: e() }).then(fn) };
    },
  };
  return q;
}
const copy = (r) => (r ? { ...r } : null);

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
const OWNER = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["owner"], employee: { id: "emp-o1", display_name: "社長" } };
const RECRUITER = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["recruiter"], employee: { id: "emp-r1", display_name: "採用 花子" } };
// 人事（hr。HR と Office に入れる）。社長・管理者と同じ流れを最後まで実行できる
const HR = { tenantId: "t1", isAdmin: false, isHr: true, roles: ["hr"], apps: ["hr", "office"], employee: { id: "emp-h1", display_name: "人事 次郎" } };
const ADMIN = { tenantId: "t1", isAdmin: true, isHr: false, roles: [], employee: { id: "emp-a1", display_name: "管理 三郎" } };
const MANAGER = { tenantId: "t1", isAdmin: false, isHr: false, roles: ["manager"], apps: ["hr", "sales", "office"], employee: { id: "emp-m1", display_name: "責任 四郎" } };
let who = OWNER;
// 判定は本物（lib/gw.js）を使う。テストで条件を書き直すと、本番とずれても気づけない
const REAL_GW = await import(atRoot("lib/gw.js"));
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canDecideHire: REAL_GW.canDecideHire,
    canAdvanceHire: REAL_GW.canAdvanceHire,
    canSeeSalary: REAL_GW.canSeeSalary,
  },
});

const { default: advance } = await import(atRoot("api/hr/applicants/advance.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => { const r = res(); await advance({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const getPrefill = (applicantId) =>
  call({ method: "GET", url: `/api/hr/applicants/advance?applicantId=${encodeURIComponent(applicantId || "")}` });
const claim = (applicantId) => call({ method: "POST", url: "/api/hr/applicants/advance", body: { applicantId } });
const act = (body) => call({ method: "PATCH", url: "/api/hr/applicants/advance", body });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function setup() {
  who = OWNER;
  db.missing = null;
  logged.length = 0;
  db.rows = {
    gw_hr_applicants: [{
      id: "a1", tenant_id: "t1", name: "山田 太郎", email: "yamada@example.com", status: "accepted",
      employment_type: "正社員", contract_type: "無期", contract_end_date: null, join_date: "2026-11-01",
      probation_months: 3, wage_type: "月給", wage_amount: 400000, weekly_hours: 40,
      employee_id: null, advance_claimed_at: null, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z",
    }],
    gw_hr_timeline: [],
    gw_employees: [
      { id: "emp-new1", tenant_id: "t1", display_name: "山田 太郎" },
      { id: "emp-new2", tenant_id: "t1", display_name: "山田 太郎（2）" },
      { id: "emp-other", tenant_id: "t2", display_name: "別の会社の人" },
    ],
  };
}

console.log("\n=== 採用条件の事前入力を取得する（GET） ===\n");

await ok("承諾済みなら、admin-onboard.htmlの項目名で採用条件が返る", async () => {
  setup();
  const r = await getPrefill("a1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.applicantId, "a1");
  assert.equal(r.body.prefill.name, "山田 太郎");
  assert.equal(r.body.prefill.joinDate, "2026-11-01");
  assert.equal(r.body.prefill.contractType, "無期");
  assert.equal(r.body.prefill.wageAmount, 400000);
});

await ok("applicantIdが無ければ断る", async () => {
  setup();
  const r = await getPrefill(null);
  assert.equal(r.statusCode, 400);
});

await ok("応募者がいなければ404", async () => {
  setup();
  const r = await getPrefill("not-exists");
  assert.equal(r.statusCode, 404);
});

await ok("承諾済みでなければ取得できない", async () => {
  setup();
  db.rows.gw_hr_applicants[0].status = "offer_response_pending";
  const r = await getPrefill("a1");
  assert.equal(r.statusCode, 409);
});

await ok("すでに本採用済みなら取得できない", async () => {
  setup();
  db.rows.gw_hr_applicants[0].employee_id = "emp-x";
  const r = await getPrefill("a1");
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "already_advanced");
});

await ok("採用担当（recruiter）・責任者（manager）は取得できない", async () => {
  setup();
  for (const w of [RECRUITER, MANAGER]) {
    who = w;
    const r = await getPrefill("a1");
    assert.equal(r.statusCode, 403, w.roles.join(","));
    assert.match(r.body.hint, /社長・管理者・人事/);
  }
});

console.log("\n=== 本採用の手続きを始める（POST claim） ===\n");

await ok("承諾済みなら、クレームできる（事前入力はGETで別途取得する）", async () => {
  setup();
  const r = await claim("a1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(db.rows.gw_hr_applicants[0].advance_claimed_at, "advance_claimed_atが立つ");
  assert.equal(r.body.applicantId, "a1");
  assert.equal(r.body.resumed, false);
  assert.equal("prefill" in r.body, false, "POSTのレスポンスには事前入力を含めない");
});

await ok("監査ログに残る", async () => {
  setup();
  await claim("a1");
  assert.ok(logged.some((l) => l.action === "hr.applicant_advance_claim"));
});

await ok("承諾済みでなければ始められない", async () => {
  setup();
  db.rows.gw_hr_applicants[0].status = "offer_viewed";
  const r = await claim("a1");
  assert.equal(r.statusCode, 409);
});

await ok("すでに本採用済み（employee_idあり）なら始められない", async () => {
  setup();
  db.rows.gw_hr_applicants[0].employee_id = "emp-x";
  const r = await claim("a1");
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "already_advanced");
});

await ok("有効なクレームがあれば、同じ人がやり直せる（resumed）", async () => {
  setup();
  await claim("a1");
  const before = db.rows.gw_hr_applicants[0].advance_claimed_at;
  const r = await claim("a1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.resumed, true);
  assert.equal(db.rows.gw_hr_applicants[0].advance_claimed_at, before, "クレーム時刻は上書きしない");
});

await ok("クレームが古ければ（1時間超）、新しくクレームし直せる", async () => {
  setup();
  db.rows.gw_hr_applicants[0].advance_claimed_at = new Date(Date.now() - 2 * 3600000).toISOString();
  const r = await claim("a1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.resumed, false);
});

await ok("応募者がいなければ404", async () => {
  setup();
  const r = await claim("not-exists");
  assert.equal(r.statusCode, 404);
});

console.log("\n=== 手続きをやめる（PATCH release） ===\n");

await ok("クレームを外せる", async () => {
  setup();
  await claim("a1");
  const r = await act({ applicantId: "a1", action: "release" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_hr_applicants[0].advance_claimed_at, null);
});

console.log("\n=== 社員ができたら、応募者側を確定する（PATCH complete） ===\n");

await ok("employee_id・statusが確定し、クレームも外れる", async () => {
  setup();
  await claim("a1");
  const r = await act({ applicantId: "a1", action: "complete", employeeId: "emp-new1" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "done");
  assert.equal(db.rows.gw_hr_applicants[0].employee_id, "emp-new1");
  assert.equal(db.rows.gw_hr_applicants[0].status, "done");
  assert.equal(db.rows.gw_hr_applicants[0].advance_claimed_at, null);
});

await ok("選考タイムライン・監査ログに残る", async () => {
  setup();
  await act({ applicantId: "a1", action: "complete", employeeId: "emp-new1" });
  assert.ok(db.rows.gw_hr_timeline.some((t) => t.event_key === "advanced"));
  assert.ok(logged.some((l) => l.action === "hr.applicant_advance_complete"));
});

await ok("employee_idは1応募者につき1回だけ埋まる（二重確定を防ぐ）", async () => {
  setup();
  await act({ applicantId: "a1", action: "complete", employeeId: "emp-new1" });
  const r = await act({ applicantId: "a1", action: "complete", employeeId: "emp-new2" });
  assert.equal(r.statusCode, 409);
  assert.equal(db.rows.gw_hr_applicants[0].employee_id, "emp-new1", "最初のemployeeIdのまま");
});

await ok("別の会社の社員・存在しない社員とは結ばない", async () => {
  setup();
  for (const employeeId of ["emp-other", "emp-none"]) {
    const r = await act({ applicantId: "a1", action: "complete", employeeId });
    assert.equal(r.statusCode, 404, employeeId);
    assert.equal(r.body.error, "employee_not_found");
  }
  assert.equal(db.rows.gw_hr_applicants[0].employee_id, null);
  assert.equal(db.rows.gw_hr_applicants[0].status, "accepted");
});

await ok("Office へ引き渡されたオファーの版から事前入力する（区分 → 雇用区分・入社手続きの範囲。業務委託は試用期間なし）", async () => {
  setup();
  db.rows.gw_hr_offers = [
    { id: "o-old", tenant_id: "t1", applicant_id: "a1", version: 1, offer_type: "contractor", revoked_at: "2026-10-01T00:00:00Z", join_date: "2026-10-01" },
    { id: "o2", tenant_id: "t1", applicant_id: "a1", version: 2, offer_type: "contractor", join_date: "2026-12-01", wage_type: "月額", wage_amount: 250000,
      probation_months: 3, accepted_at: "2026-10-10T00:00:00Z", formal_contract_required: false, handoff_at: "2026-10-11T00:00:00Z" },
  ];
  const r = await getPrefill("a1");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const p = r.body.prefill;
  assert.deepEqual([p.joinDate, p.employmentType, p.onboardingProfile, p.wageType, p.wageAmount], ["2026-12-01", "業務委託", "contractor", "月給", 250000]);
  assert.equal(p.probationMonths, undefined, "業務委託に試用期間を持ち込まない");
  assert.deepEqual([p.offerType, p.offerTypeLabel, p.formalRequired, p.handoffAt], ["contractor", "業務委託", false, "2026-10-11T00:00:00Z"]);
  // パート・アルバイトは、オファーの区分のまま（正社員に丸めない）
  db.rows.gw_hr_offers = [{ id: "o3", tenant_id: "t1", applicant_id: "a1", version: 1, offer_type: "part_time", employment_type: "アルバイト",
    join_date: "2026-11-15", wage_type: "時給", wage_amount: 1300, weekly_hours: 20, accepted_at: "2026-10-10T00:00:00Z" }];
  const q = (await getPrefill("a1")).body.prefill;
  assert.deepEqual([q.employmentType, q.onboardingProfile, q.weeklyHours, q.wageType], ["アルバイト", "full", 20, "時給"]);
  // スポット：案件単価は給与区分に当てはめず、備考へ
  db.rows.gw_hr_offers = [{ id: "o4", tenant_id: "t1", applicant_id: "a1", version: 1, offer_type: "spot", join_date: "2026-11-20",
    wage_type: "案件単価", wage_amount: 50000, accepted_at: "2026-10-10T00:00:00Z" }];
  const sp = (await getPrefill("a1")).body.prefill;
  assert.deepEqual([sp.employmentType, sp.onboardingProfile, sp.wageType, sp.wageAmount], ["業務委託", "spot", undefined, undefined]);
  assert.match(sp.wageNote, /案件単価 50,000円/);
});

await ok("employeeIdが無ければ断る", async () => {
  setup();
  const r = await act({ applicantId: "a1", action: "complete" });
  assert.equal(r.statusCode, 400);
});

console.log("\n=== 誰が触れるか ===\n");

await ok("採用担当（recruiter）・責任者（manager）は使えない", async () => {
  for (const w of [RECRUITER, MANAGER]) {
    setup();
    who = w;
    assert.equal((await claim("a1")).statusCode, 403);
    assert.equal((await act({ applicantId: "a1", action: "complete", employeeId: "emp-new1" })).statusCode, 403);
    assert.equal(db.rows.gw_hr_applicants[0].employee_id, null);
  }
});

await ok("人事（hr）・管理者も、社長と同じ流れを最後まで実行できる（事前入力 → 手続き開始 → 完了）", async () => {
  for (const w of [HR, ADMIN]) {
    setup();
    who = w;
    const p = await getPrefill("a1");
    assert.equal(p.statusCode, 200, JSON.stringify(p.body));
    assert.equal(p.body.prefill.name, "山田 太郎");
    assert.equal((await claim("a1")).statusCode, 200);
    const r = await act({ applicantId: "a1", action: "complete", employeeId: "emp-new1" });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(db.rows.gw_hr_applicants[0].status, "done");
  }
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
