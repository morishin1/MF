// 採用HR Stage 10：応募〜試用期間までを、実際のAPIハンドラーを1本につないで通す。
//
// ■ 何を守るテストか（指示書§2・§24の全体E2E）
//
//   応募 → 面談（カジュアル）→ 評価（ランクA）→ 社長推薦 → CEO REVIEW →
//   社長面談 → 内定（決定） → 合格通知作成 → 確定 → URL発行 → 送付 →
//   候補者閲覧 → 承諾 → 本採用へ進める(claim) → 事前入力(prefill) →
//   社員登録の確定(complete) → 契約書作成依頼 → accepted offerとの整合確認 →
//   社労士が承認・発行（署名依頼） → 入社手続きの段階(computeStage)が進む
//
//   途中で人が同じ情報を手入力し直す箇所が無いこと（applicantId/employeeIdの
//   受け渡しだけで、名前・メール・給与などを再入力しない）も併せて確認する。
//
// ■ このテストの範囲（意図的にやらないこと）
//
//   社員登録そのもの（api/employees/onboard.js → lib/onboard.js の
//   onboardOne／バリデーション／育成計画生成）は test/onboardtest.mjs 等で
//   別途カバー済みのため、ここでは「本採用が完了した結果」として
//   gw_employees・gw_contracts・gw_procedures をそのまま用意し、
//   advance.js の complete → sign/orders.js → onboard-stage の
//   “つなぎ目” に集中する。
//
// ■ 分岐E2E（指示書§3）
//   Bランク／Dランク／CEO保留／候補者辞退／回答期限切れ／契約条件差分
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, files: {} };
const logged = [];
const notified = [];

const DEFAULTS = {
  gw_doc_orders: { status: "requested", doc_kind: "employment", conditions: {},
    requested_at: () => new Date().toISOString() },
  gw_sign_requests: { status: "sent", source: "generated", resent_count: 0,
    sent_at: () => new Date().toISOString() },
};
const withDefaults = (name, row) => {
  const d = DEFAULTS[name] || {};
  const out = { ...row };
  for (const [k, v] of Object.entries(d)) if (out[k] === undefined) out[k] = typeof v === "function" ? v() : v;
  return out;
};

function table(name) {
  const f = [];
  let order = null;
  let asc = true;
  let lim = null;
  const rows = () => {
    let out = (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
      if (op === "eq") return r[k] === v;
      if (op === "neq") return r[k] !== v;
      if (op === "in") return Array.isArray(v) && v.includes(r[k]);
      if (op === "is") return v === null ? (r[k] === null || r[k] === undefined) : r[k] === v;
      return true;
    }));
    if (order) out = [...out].sort((a, b) => (a[order] < b[order] ? (asc ? -1 : 1) : a[order] > b[order] ? (asc ? 1 : -1) : 0));
    if (lim != null) out = out.slice(0, lim);
    return out;
  };
  const e = () => (db.missing === name ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    is(k, v) { f.push(["is", k, v]); return q; },
    order(col, opts) { order = col; asc = !(opts && opts.ascending === false); return q; },
    limit(n) { lim = n; return q; },
    maybeSingle: () => Promise.resolve({ data: e() ? null : copy(rows()[0]) || null, error: e() }),
    single: () => Promise.resolve({ data: e() ? null : copy(rows()[0]) || null, error: e() }),
    then: (fn) => Promise.resolve({ data: e() ? null : rows().map(copy), error: e() }).then(fn),
    insert(row) {
      const list = [].concat(row).map((r, n) => withDefaults(name, {
        id: r.id || `${name}-${(db.rows[name] || []).length + n + 1}`,
        created_at: r.created_at || new Date().toISOString(), ...r,
      }));
      if (!e()) (db.rows[name] = db.rows[name] || []).push(...list);
      const r2 = {
        select: () => r2,
        single: () => Promise.resolve({ data: e() ? null : copy(list[0]), error: e() }),
        then: (fn) => Promise.resolve({ data: e() ? null : list.map(copy), error: e() }).then(fn),
      };
      return r2;
    },
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push(["eq", k, v]); return r2; },
        is: (k, v) => { g.push(["is", k, v]); return r2; },
        select: () => r2,
        single: () => apply(false),
        maybeSingle: () => apply(false),
        then: (fn) => apply(true).then(fn),
      };
      function apply(asList) {
        const hit = (db.rows[name] || []).filter((x) => g.every(([op, k, v]) => (
          op === "is" ? (v === null ? (x[k] === null || x[k] === undefined) : x[k] === v) : x[k] === v
        )));
        for (const x of hit) Object.assign(x, patch);
        return Promise.resolve(asList
          ? { data: hit.map(copy), error: e() }
          : { data: e() ? null : (copy(hit[0]) || null), error: e() });
      }
      return r2;
    },
  };
  return q;
}
const copy = (r) => (r ? { ...r } : null);

const storage = {
  from: () => ({
    createSignedUploadUrl: async (path) => ({ data: { signedUrl: `https://x/up/${path}`, token: "t" }, error: null }),
    createSignedUrl: async (path) => (db.files[path]
      ? { data: { signedUrl: `https://x/get/${path}` }, error: null }
      : { data: null, error: { message: "not found" } }),
    download: async (path) => (db.files[path]
      ? { data: { arrayBuffer: async () => db.files[path] }, error: null }
      : { data: null, error: { message: "not found" } }),
    upload: async (path, bytes) => { db.files[path] = Buffer.from(bytes); return { data: { path }, error: null }; },
    remove: async (paths) => { for (const p of paths) delete db.files[p]; return { data: null, error: null }; },
  }),
};

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table, storage }), userClient: () => ({ from: table, storage }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1" }), getMemberships: async () => [] },
});
mock.module(atRoot("lib/mfa.js"), { namedExports: { requireMfa: async () => true } });
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (ev) => { logged.push(ev); } },
});
mock.module(atRoot("lib/notify.js"), {
  namedExports: { notify: async (n) => { notified.push(...(n || [])); } },
});
mock.module(atRoot("lib/slack.js"), { namedExports: { notifySlack: async () => {} } });
mock.module(atRoot("lib/sign-audit.js"), {
  namedExports: { signEvent: async () => {}, ipOf: () => "1.2.3.4", uaOf: () => "test" },
});
mock.module(atRoot("lib/pdf-jp.js"), {
  namedExports: { renderContractPdf: async () => Buffer.from("pdf"), sha256: (b) => "hash-" + String(b).length },
});

const OWNER = { tenantId: "t1", isAdmin: false, isHr: true, isAdvisor: false, roles: ["owner"], employee: { id: "emp-o1", display_name: "社長" } };
const RECRUITER = { tenantId: "t1", isAdmin: false, isHr: false, isAdvisor: false, roles: ["recruiter"], employee: { id: "emp-r1", display_name: "採用 花子" } };
const HR = { tenantId: "t1", isAdmin: false, isHr: true, isAdvisor: false, roles: ["hr"], employee: { id: "emp-hr", display_name: "人事 太郎" } };
const ADVISOR = { tenantId: "t1", isAdmin: false, isHr: false, isAdvisor: true, roles: ["labor_advisor"], employee: { id: "emp-adv", display_name: "社労士" } };
let who = RECRUITER;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => who,
    canRecruit: (c) => Boolean(c?.isAdmin || c?.isHr || (c?.roles || []).includes("recruiter")),
    canDecideHire: (c) => Boolean(c?.isAdmin || (c?.roles || []).includes("owner")),
    canManageHr: (c) => Boolean(c?.isAdmin || c?.isHr),
  },
});

const { default: applicants } = await import(atRoot("api/hr/applicants/index.js"));
const { default: applicantDetail } = await import(atRoot("api/hr/applicants/detail.js"));
const { default: interviews } = await import(atRoot("api/hr/interviews/index.js"));
const { default: ceoReview } = await import(atRoot("api/hr/ceo-review.js"));
const { default: offers } = await import(atRoot("api/hr/offers/index.js"));
const { default: offersPublic } = await import(atRoot("api/hr/offers/public.js"));
const { default: advance } = await import(atRoot("api/hr/applicants/advance.js"));
const { default: signOrders } = await import(atRoot("api/sign/orders.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (h, req) => { const r = res(); await h({ headers: { authorization: "Bearer x" }, ...req }, r); return r; };
const post = (h, url, body) => call(h, { method: "POST", url, body });
const patch = (h, url, body) => call(h, { method: "PATCH", url, body });
const get = (h, url) => call(h, { method: "GET", url });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

function reset() {
  who = RECRUITER;
  db.rows = {};
  db.files = {};
  db.missing = null;
  logged.length = 0;
  notified.length = 0;
}

// 「本採用が完了した」ところまでを、実ハンドラー呼び出しで作る。
// 戻り値のapplicantIdを使って、以降の分岐（差分あり/なし等）を各シナリオで足す
async function runToAccepted({ wageAmount = 300000 } = {}) {
  who = RECRUITER;
  const created = await post(applicants, "/api/hr/applicants", {
    name: "山田 太郎", jobTitle: "エンジニア", source: "リファラル", email: "yamada@example.com",
  });
  const applicantId = created.body.applicant.id;

  const iv1 = await post(interviews, "/api/hr/interviews", { applicantId, kind: "casual" });
  const iv1Id = iv1.body.interview.id;
  await patch(interviews, "/api/hr/interviews", { id: iv1Id, action: "conduct" });
  await patch(interviews, "/api/hr/interviews", {
    id: iv1Id, action: "evaluate", rank: "A", recommendReason: "即戦力",
  });

  await patch(applicantDetail, "/api/hr/applicants/detail", {
    id: applicantId, stage: "ceo_recommend", status: "ceo_interview_pending", recommendNote: "即戦力です",
  });

  who = RECRUITER;
  const iv2 = await post(interviews, "/api/hr/interviews", { applicantId, kind: "ceo" });
  const iv2Id = iv2.body.interview.id;
  await patch(interviews, "/api/hr/interviews", { id: iv2Id, action: "conduct" });

  who = OWNER;
  await patch(applicantDetail, "/api/hr/applicants/detail", {
    id: applicantId, decision: "hired", stage: "offer", status: "offer_draft_pending",
  });

  who = RECRUITER;
  const offer = await post(offers, "/api/hr/offers", {
    applicantId, respondBy: "2026-10-15",
    employmentType: "正社員", jobTitle: "エンジニア", contractType: "無期",
    joinDate: "2026-11-01", probationMonths: 3, wageType: "月給", wageAmount,
    weeklyHours: 40, workLocation: "本社",
  });
  const offerId = offer.body.offer.id;
  await patch(offers, "/api/hr/offers", { id: offerId, action: "confirm" });
  const issued = await patch(offers, "/api/hr/offers", { id: offerId, action: "issueLink" });
  const token = issued.body.token;
  await patch(offers, "/api/hr/offers", { id: offerId, action: "markSent" });

  return { applicantId, offerId, token };
}

console.log("\n=== 全体E2E：応募 → … → 承諾まで（実ハンドラーを1本でつなぐ） ===\n");

let e2eIds = null;
await ok("応募者を作ると、応募イベントが記録される", async () => {
  reset();
  e2eIds = await runToAccepted();
  const a = db.rows.gw_hr_applicants[0];
  assert.equal(a.status, "offer_sent");
  assert.ok(db.rows.gw_hr_timeline.some((t) => t.event_key === "applied"));
});

await ok("ランクAの評価で、社長推薦待ちに進む（手入力し直しなし）", () => {
  const iv = db.rows.gw_hr_interviews[0];
  assert.equal(iv.rank, "A");
  assert.ok(db.rows.gw_hr_timeline.some((t) => t.event_key === "rank_A"));
});

await ok("CEO REVIEWのdecisionPendingに、社長面談ずみの候補者が出る", async () => {
  who = OWNER;
  // runToAcceptedの中で既にhired決定まで進めているので、ここでは
  // 決定前の状態を別途作って確認する
  reset();
  who = RECRUITER;
  const created = await post(applicants, "/api/hr/applicants", { name: "確認 太郎", jobTitle: "PM", source: "紹介" });
  const aid = created.body.applicant.id;
  const iv1 = await post(interviews, "/api/hr/interviews", { applicantId: aid, kind: "casual" });
  await patch(interviews, "/api/hr/interviews", { id: iv1.body.interview.id, action: "conduct" });
  await patch(interviews, "/api/hr/interviews", { id: iv1.body.interview.id, action: "evaluate", rank: "A" });
  await patch(applicantDetail, "/api/hr/applicants/detail", { id: aid, stage: "ceo_recommend", status: "ceo_interview_pending" });
  const iv2 = await post(interviews, "/api/hr/interviews", { applicantId: aid, kind: "ceo" });
  await patch(interviews, "/api/hr/interviews", { id: iv2.body.interview.id, action: "conduct" });

  who = OWNER;
  const review = await get(ceoReview, "/api/hr/ceo-review");
  assert.ok(review.body.decisionPending.some((c) => c.id === aid), "社長判断待ちに出る");

  await patch(applicantDetail, "/api/hr/applicants/detail", {
    id: aid, decision: "hired", stage: "offer", status: "offer_draft_pending",
  });
  const review2 = await get(ceoReview, "/api/hr/ceo-review");
  assert.ok(!review2.body.decisionPending.some((c) => c.id === aid), "決定すれば判断待ちから消える");
});

await ok("候補者本人が公開URLで閲覧・承諾できる（ランク・社内メモ等は返らない）", async () => {
  reset();
  e2eIds = await runToAccepted();
  const view = await get(offersPublic, `/api/hr/offers/public?token=${e2eIds.token}`);
  assert.equal(view.statusCode, 200, JSON.stringify(view.body));
  const o = view.body;
  for (const leaked of ["rank", "employeeId", "employee_id", "tenantId", "tenant_id", "recommendNote", "concerns"]) {
    assert.equal(o[leaked], undefined, `${leaked} が公開APIに出ていない`);
  }
  assert.equal(o.wageAmount, 300000, "本人には合格通知どおりの条件が見える");

  const accept = await post(offersPublic, "/api/hr/offers/public", { token: e2eIds.token, action: "accept" });
  assert.equal(accept.body.responseStatus, "accepted");
  const a = db.rows.gw_hr_applicants.find((x) => x.id === e2eIds.applicantId);
  assert.equal(a.status, "accepted", "HR側は「承諾済み」になる");
  assert.ok(!a.employee_id, "承諾しただけでは gw_employees は作らない");
});

console.log("\n=== 本採用へ進める → 契約書作成依頼 → 社労士承認（条件が一致） ===\n");

// 「本採用が完了した」状態（employees/onboard.js は別テストで担保済みのため、
// その結果としてできる行だけをここで用意する）
function seedOnboardedEmployee({ employeeId = "emp-new1", wageAmount = 300000, procStage = "conditions" } = {}) {
  db.rows.gw_employees = [{
    id: employeeId, tenant_id: "t1", display_name: "山田 太郎", employment_type: "正社員",
    joined_on: "2026-11-01", position: "エンジニア", user_id: "user-new1", status: "active",
  }];
  db.rows.gw_contracts = [{
    id: "c1", tenant_id: "t1", employee_id: employeeId, status: "active",
    fixed_term: false, period_from: "2026-11-01", period_to: null,
    probation_months: 3, weekly_hours: 40, job_content: "エンジニア",
    wage_type: "月給", wage_amount: wageAmount,
  }];
  db.rows.gw_procedures = [{
    id: "proc1", tenant_id: "t1", employee_id: employeeId, kind: "onboarding",
    status: "open", stage: procStage,
  }];
  db.rows.gw_procedure_items = [];
}

await ok("本採用へ進める（claim）→ 事前入力（prefill）→ 完了（complete）", async () => {
  who = OWNER;
  const claimed = await post(advance, "/api/hr/applicants/advance", { applicantId: e2eIds.applicantId });
  assert.equal(claimed.body.resumed, false);

  const prefill = await get(advance, `/api/hr/applicants/advance?applicantId=${e2eIds.applicantId}`);
  assert.equal(prefill.body.prefill.name, "山田 太郎", "applicantIdだけで、名前を再入力せず引き継げる");
  assert.equal(prefill.body.prefill.email, "yamada@example.com");

  seedOnboardedEmployee({ employeeId: "emp-new1" });
  const done = await patch(advance, "/api/hr/applicants/advance", {
    applicantId: e2eIds.applicantId, action: "complete", employeeId: "emp-new1",
  });
  assert.equal(done.body.status, "done");
  const a = db.rows.gw_hr_applicants.find((x) => x.id === e2eIds.applicantId);
  assert.equal(a.employee_id, "emp-new1", "応募者とgw_employeesが紐づく");
});

await ok("契約書作成依頼：accepted offerと一致 → そのまま作成できる", async () => {
  who = HR;
  const recon = await get(signOrders, "/api/sign/orders?employeeId=emp-new1&reconcile=1");
  assert.equal(recon.body.linked, true);
  assert.equal(recon.body.hasAcceptedOffer, true);
  assert.deepEqual(recon.body.mismatches, [], "承諾時と現在の契約条件が一致");

  const created = await post(signOrders, "/api/sign/orders", {
    action: "create", employeeId: "emp-new1",
    conditions: {
      "雇用区分": "正社員", "契約期間": "期間の定めなし", "就業場所": "本社",
      "業務内容": "エンジニア", "就業時間": "9:00〜18:00", "休日・休暇": "土日祝",
      "賃金": "月給300,000円", "賃金の支払": "月末締め翌月25日払い",
    },
  });
  assert.equal(created.statusCode, 200, JSON.stringify(created.body));
  assert.equal(created.body.order.status, "requested");

  const orderId = created.body.order.id;

  who = ADVISOR;
  const approved = await post(signOrders, "/api/sign/orders", {
    action: "approve", id: orderId,
    conditions: { "雇用区分": "正社員", "契約期間": "期間の定めなし", "就業場所": "本社",
      "業務内容": "エンジニア", "就業時間": "9:00〜18:00", "休日・休暇": "土日祝",
      "賃金": "月給300,000円", "賃金の支払": "月末締め翌月25日払い" },
  });
  assert.equal(approved.statusCode, 200, JSON.stringify(approved.body));
  assert.ok(approved.body.signRequestId, "電子署名依頼が作られる");
  assert.equal(db.rows.gw_sign_requests[0].status, "sent");
});

await ok("社労士の承認・発行で、入社手続きの段階が「社労士確認」から先へ進む", async () => {
  // approve() 内で advanceFor が呼ばれ、gw_procedures.stage が計算し直される
  const proc = db.rows.gw_procedures.find((p) => p.employee_id === "emp-new1");
  assert.notEqual(proc.stage, "conditions", "作成依頼だけの段階からは進んでいる");
});

await ok("既存の5段階トラッカー・タスク・監査ログは、この一連の操作で壊れていない", () => {
  assert.ok(logged.some((l) => l.action === "hr.applicant_create"));
  assert.ok(logged.some((l) => l.action === "hr.offer_create"));
  assert.ok(logged.some((l) => l.action === "hr.applicant_advance_complete"));
  assert.ok(logged.some((l) => l.action === "doc_order.create"));
  assert.ok(logged.some((l) => l.action === "doc_order.approve"));
});

console.log("\n=== 分岐E2E：Bランク（追加確認・次回面談） ===\n");

await ok("Bランクは社長推薦待ちに進む（Aと同じ経路。次回面談を組み直せる）", async () => {
  reset();
  who = RECRUITER;
  const created = await post(applicants, "/api/hr/applicants", { name: "B候補", jobTitle: "デザイナー", source: "SNS" });
  const aid = created.body.applicant.id;
  const iv = await post(interviews, "/api/hr/interviews", { applicantId: aid, kind: "casual" });
  await patch(interviews, "/api/hr/interviews", { id: iv.body.interview.id, action: "conduct" });
  const evaled = await patch(interviews, "/api/hr/interviews", { id: iv.body.interview.id, action: "evaluate", rank: "B" });
  assert.equal(evaled.body.status, "ceo_recommend_pending");
});

console.log("\n=== 分岐E2E：Dランク（見送り） ===\n");

await ok("Dランクは自動で「見送り」になり、社長判断まで進めない", async () => {
  reset();
  who = RECRUITER;
  const created = await post(applicants, "/api/hr/applicants", { name: "D候補", jobTitle: "営業", source: "求人媒体" });
  const aid = created.body.applicant.id;
  const iv = await post(interviews, "/api/hr/interviews", { applicantId: aid, kind: "casual" });
  await patch(interviews, "/api/hr/interviews", { id: iv.body.interview.id, action: "conduct" });
  const evaled = await patch(interviews, "/api/hr/interviews", { id: iv.body.interview.id, action: "evaluate", rank: "D" });
  assert.equal(evaled.body.status, "passed");

  who = OWNER;
  const review = await get(ceoReview, "/api/hr/ceo-review");
  assert.ok(!review.body.recommended.some((c) => c.id === aid));
  assert.ok(!review.body.decisionPending.some((c) => c.id === aid));
});

console.log("\n=== 分岐E2E：CEO保留（再確認事項→再判断） ===\n");

await ok("社長は「保留」にでき、理由と次に確認することを残せる。あとで判断し直せる", async () => {
  reset();
  who = RECRUITER;
  const created = await post(applicants, "/api/hr/applicants", { name: "保留 太郎", jobTitle: "エンジニア", source: "リファラル" });
  const aid = created.body.applicant.id;
  const iv1 = await post(interviews, "/api/hr/interviews", { applicantId: aid, kind: "casual" });
  await patch(interviews, "/api/hr/interviews", { id: iv1.body.interview.id, action: "conduct" });
  await patch(interviews, "/api/hr/interviews", { id: iv1.body.interview.id, action: "evaluate", rank: "A" });
  await patch(applicantDetail, "/api/hr/applicants/detail", { id: aid, stage: "ceo_recommend", status: "ceo_interview_pending" });
  const iv2 = await post(interviews, "/api/hr/interviews", { applicantId: aid, kind: "ceo" });
  await patch(interviews, "/api/hr/interviews", { id: iv2.body.interview.id, action: "conduct" });

  who = OWNER;
  const held = await patch(applicantDetail, "/api/hr/applicants/detail", {
    id: aid, decision: "hold", holdReason: "他部署と調整中", holdNextStep: "配属先が決まり次第、再面談",
    decisionDueOn: "2026-10-05",
  });
  assert.equal(held.statusCode, 200, JSON.stringify(held.body));
  assert.equal(held.body.applicant.decision, "hold");
  assert.ok(logged.some((l) => l.action === "hr.applicant_update"));

  // 再判断：保留を解いて内定にできる
  const decided = await patch(applicantDetail, "/api/hr/applicants/detail", {
    id: aid, decision: "hired", stage: "offer", status: "offer_draft_pending",
  });
  assert.equal(decided.body.applicant.decision, "hired");
});

console.log("\n=== 分岐E2E：候補者辞退 ===\n");

await ok("候補者が公開URLから辞退すると、HR側も「辞退」になる", async () => {
  reset();
  const ids = await runToAccepted();
  const decline = await post(offersPublic, "/api/hr/offers/public", {
    token: ids.token, action: "decline", declineReason: "他社に決めました",
  });
  assert.equal(decline.body.responseStatus, "declined");
  const a = db.rows.gw_hr_applicants.find((x) => x.id === ids.applicantId);
  assert.equal(a.status, "declined");

  // 辞退後は、承諾/辞退のどちらの操作ももう一度は通らない
  const again = await post(offersPublic, "/api/hr/offers/public", { token: ids.token, action: "accept" });
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.error, "already_responded");
});

console.log("\n=== 分岐E2E：回答期限切れ ===\n");

await ok("回答期限切れのURLは開けない（410 expired）。HR側の状態には触れない", async () => {
  reset();
  const ids = await runToAccepted();
  const offer = db.rows.gw_hr_offers.find((o) => o.id === ids.offerId);
  offer.expires_at = "2000-01-01T00:00:00Z"; // 期限切れにする

  const view = await get(offersPublic, `/api/hr/offers/public?token=${ids.token}`);
  assert.equal(view.statusCode, 410);
  assert.equal(view.body.error, "expired");

  const a = db.rows.gw_hr_applicants.find((x) => x.id === ids.applicantId);
  assert.equal(a.status, "offer_sent", "期限切れの閲覧失敗では状態を進めない");
});

console.log("\n=== 分岐E2E：契約条件差分（月給300,000円 → 320,000円） ===\n");

await ok("accepted offerと現在の契約条件が食い違うと、契約書作成依頼を止める", async () => {
  reset();
  const ids = await runToAccepted({ wageAmount: 300000 });
  await post(offersPublic, "/api/hr/offers/public", { token: ids.token, action: "accept" });
  who = OWNER;
  await post(advance, "/api/hr/applicants/advance", { applicantId: ids.applicantId });
  seedOnboardedEmployee({ employeeId: "emp-new2", wageAmount: 320000 }); // 現在の契約は320,000円
  await patch(advance, "/api/hr/applicants/advance", {
    applicantId: ids.applicantId, action: "complete", employeeId: "emp-new2",
  });

  who = HR;
  const recon = await get(signOrders, "/api/sign/orders?employeeId=emp-new2&reconcile=1");
  assert.equal(recon.body.mismatches.length, 1);
  assert.equal(recon.body.mismatches[0].key, "wage");
  assert.equal(recon.body.mismatches[0].offerValue, "月給 300,000円");
  assert.equal(recon.body.mismatches[0].currentValue, "月給 320,000円");

  const blocked = await post(signOrders, "/api/sign/orders", {
    action: "create", employeeId: "emp-new2", conditions: {},
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.body.error, "offer_mismatch");
  assert.equal(db.rows.gw_doc_orders?.length ?? 0, 0, "差分があるあいだは契約書作成依頼を作らない");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
