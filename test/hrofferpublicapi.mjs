// 採用HR Stage 6：候補者向け公開API（api/hr/offers/public.js）を、偽のSupabaseで通す。
//
// ■ 何を守るテストか
//
//   1. 有効なtokenなら、そのtokenに紐づくoffer versionのスナップショットだけを返す
//      （gw_hr_applicantsの最新値ではない。社内向け情報は一切含まない）
//   2. 初回閲覧でviewed_atが記録され、応募者の状態が「本人が閲覧済み」へ進む。
//      2回目に開いても、初回の閲覧日時は変わらない
//   3. token無し・不正token・存在しないtoken・revoked・期限切れは、すべて開けない
//   4. 別offerのtokenでは、他応募者の情報を取得できない
//   5. ログイン（gwContext）は前提にしない
import assert from "node:assert/strict";
import { mock } from "node:test";
import crypto from "node:crypto";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

const db = { rows: {} };
const logged = [];
const sha256 = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

function table(name) {
  const f = [];
  const rows = () => (db.rows[name] || []).filter((r) => f.every(([op, k, v]) => {
    if (op === "eq") return r[k] === v;
    if (op === "neq") return r[k] !== v;
    if (op === "in") return Array.isArray(v) ? v.includes(r[k]) : r[k] === v;
    return true;
  }));
  const e = () => (db.missing === name ? { code: "PGRST205", message: `Could not find the table '${name}'` } : null);
  const q = {
    select() { return q; },
    eq(k, v) { f.push(["eq", k, v]); return q; },
    neq(k, v) { f.push(["neq", k, v]); return q; },
    in(k, v) { f.push(["in", k, v]); return q; },
    maybeSingle: () => Promise.resolve({ data: e() ? null : copy(rows()[0]) || null, error: e() }),
    then: (fn) => Promise.resolve({ data: e() ? null : rows().map(copy), error: e() }).then(fn),
    update(patch) {
      const g = [];
      const r2 = {
        eq: (k, v) => { g.push([k, v]); return r2; },
        then: (fn) => {
          const hit = (db.rows[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
          for (const x of hit) Object.assign(x, patch);
          return Promise.resolve({ data: hit.map(copy), error: null }).then(fn);
        },
      };
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
    upsert(rowsIn, opts = {}) {
      const list = [].concat(rowsIn);
      const keyOf = (r) => (opts.onConflict || "id").split(",").map((k) => r[k]).join("|");
      const made = [];
      for (const r of list) {
        const k = keyOf(r);
        const idx = (db.rows[name] || []).findIndex((x) => keyOf(x) === k);
        if (idx >= 0) {
          if (opts.ignoreDuplicates) continue;
          Object.assign(db.rows[name][idx], r);
          made.push(db.rows[name][idx]);
        } else {
          const row = { id: r.id || `${name}-${(db.rows[name] || []).length + 1}`, ...r };
          (db.rows[name] = db.rows[name] || []).push(row);
          made.push(row);
        }
      }
      const r2 = { select: () => r2, then: (fn) => Promise.resolve({ data: made.map(copy), error: null }).then(fn) };
      return r2;
    },
  };
  return q;
}
const copy = (r) => (r ? { ...r } : null);

mock.module(atRoot("lib/supabase.js"), { namedExports: { admin: () => ({ from: table }) } });
mock.module(atRoot("lib/gw-audit.js"), { namedExports: { gwLog: async (e) => { logged.push(e); } } });

const { default: publicOffer } = await import(atRoot("api/hr/offers/public.js"));

const res = () => {
  const r = { statusCode: 0, body: null };
  r.setHeader = () => {};
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const call = async (req) => { const r = res(); await publicOffer({ method: "GET", ...req }, r); return r; };
const get = (token) => call({ url: `/api/hr/offers/public?token=${encodeURIComponent(token || "")}` });
const respond = (token, action, extra = {}) =>
  call({ method: "POST", url: "/api/hr/offers/public", body: { token, action, ...extra } });

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const TOKEN = "a".repeat(43); // TOKEN_RE: 32〜200文字のURL-safe文字列
const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString();
const PAST = new Date(Date.now() - 86400000).toISOString();

function setup() {
  db.missing = null;
  logged.length = 0;
  db.rows = {
    gw_hr_offers: [{
      id: "of1", tenant_id: "t1", applicant_id: "a1", version: 1,
      job_title: "エンジニア", employment_type: "正社員", contract_type: "無期", contract_end_date: null,
      join_date: "2026-11-01", probation_months: 3, wage_type: "月給", wage_amount: 400000, weekly_hours: 40,
      work_location: "東京", message_to_candidate: "ご一緒できることを楽しみにしています。", respond_by: "2026-10-15",
      token_hash: sha256(TOKEN), expires_at: FUTURE, revoked_at: null, sent_at: "2026-09-25T06:00:00Z",
      viewed_at: null, accepted_at: null, declined_at: null,
    }],
    gw_hr_applicants: [
      { id: "a1", tenant_id: "t1", name: "山田 太郎", status: "offer_sent", rank: "A",
        recommend_note: "社内向けの推薦理由", decision: "hired", recruiter_id: "e1" },
      { id: "a2", tenant_id: "t1", name: "鈴木 花子", status: "offer_sent", rank: "B" },
    ],
    tenants: [{ id: "t1", name: "株式会社エイト" }],
    gw_employees: [{ id: "e1", tenant_id: "t1", display_name: "採用 花子", email: "recruit@example.com" }],
    gw_hr_timeline: [], gw_notifications: [],
  };
}

console.log("\n=== 有効なtokenで、合格通知のスナップショットが返る ===\n");

await ok("offer versionの内容が返る（応募者の最新値ではなくoffer側の値）", async () => {
  setup();
  const r = await get(TOKEN);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.candidateName, "山田 太郎");
  assert.equal(r.body.tenantName, "株式会社エイト");
  assert.equal(r.body.jobTitle, "エンジニア");
  assert.equal(r.body.wageAmount, 400000);
  assert.equal(r.body.respondBy, "2026-10-15");
});

await ok("応募者側の最新値が変わっていても、offerのスナップショットが優先される", async () => {
  setup();
  db.rows.gw_hr_applicants[0].name = "山田　太郎（改名後）"; // 参照していない列だが、念のため
  db.rows.gw_hr_offers[0].wage_amount = 400000; // offer側は据え置き
  const r = await get(TOKEN);
  assert.equal(r.body.wageAmount, 400000, "offerのスナップショットの値のまま");
});

await ok("社内向け情報は一切含まれない（ランク・推薦理由・employee_id・tenant内部ID等）", async () => {
  setup();
  const r = await get(TOKEN);
  const json = JSON.stringify(r.body);
  for (const leak of ["rank", "recommend_note", "推薦理由", "employee_id", "tenantId", "t1", "hired"]) {
    assert.ok(!json.includes(leak), `${leak} が含まれていない`);
  }
});

console.log("\n=== 初回閲覧の記録 ===\n");

await ok("初めて開くと、viewed_atが記録され、応募者の状態が「本人の回答を待っています（承諾待ち）」へ進む", async () => {
  setup();
  await get(TOKEN);
  assert.ok(db.rows.gw_hr_offers[0].viewed_at, "viewed_atが立つ");
  assert.equal(db.rows.gw_hr_applicants[0].status, "offer_response_pending");
});

await ok("選考タイムライン・監査ログには「閲覧した」事実として残る", async () => {
  setup();
  await get(TOKEN);
  assert.ok(db.rows.gw_hr_timeline.some((t) => t.event_key === "offer_viewed"));
  assert.ok(logged.some((l) => l.action === "hr.offer_viewed"));
});

await ok("2回目に開いても、初回の閲覧日時は変わらない", async () => {
  setup();
  await get(TOKEN);
  const first = db.rows.gw_hr_offers[0].viewed_at;
  await new Promise((r) => setTimeout(r, 5));
  await get(TOKEN);
  assert.equal(db.rows.gw_hr_offers[0].viewed_at, first);
});

await ok("HRが送付済みにするのを忘れていても、閲覧できればsent_atが埋まる", async () => {
  setup();
  db.rows.gw_hr_offers[0].sent_at = null;
  await get(TOKEN);
  assert.ok(db.rows.gw_hr_offers[0].sent_at, "閲覧時点でsent_atが補われる");
});

console.log("\n=== 開けないケース ===\n");

await ok("tokenが無ければ開けない", async () => {
  setup();
  const r = await get("");
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error, "invalid_token");
});

await ok("形式が不正なtokenは開けない", async () => {
  setup();
  const r = await get("short");
  assert.equal(r.statusCode, 404);
});

await ok("存在しないtokenは開けない", async () => {
  setup();
  const r = await get("b".repeat(43));
  assert.equal(r.statusCode, 404);
});

await ok("無効化（再発行済み）されたtokenは開けない", async () => {
  setup();
  db.rows.gw_hr_offers[0].revoked_at = "2026-09-25T00:00:00Z";
  const r = await get(TOKEN);
  assert.equal(r.statusCode, 404);
});

await ok("期限切れは、内容を返さず、期限切れの案内になる", async () => {
  setup();
  db.rows.gw_hr_offers[0].expires_at = PAST;
  const r = await get(TOKEN);
  assert.equal(r.statusCode, 410);
  assert.equal(r.body.error, "expired");
  assert.ok(!r.body.wageAmount, "内容は返さない");
});

console.log("\n=== 他応募者の情報が漏れない ===\n");

await ok("別offerのtokenでは、その応募者自身の情報しか返らない", async () => {
  setup();
  const TOKEN2 = "c".repeat(43);
  db.rows.gw_hr_offers.push({
    id: "of2", tenant_id: "t1", applicant_id: "a2", version: 1,
    job_title: "デザイナー", employment_type: "正社員", join_date: "2026-11-01",
    respond_by: "2026-10-20", token_hash: sha256(TOKEN2), expires_at: FUTURE, revoked_at: null,
    sent_at: "2026-09-25T06:00:00Z", viewed_at: null,
  });
  const r1 = await get(TOKEN);
  const r2 = await get(TOKEN2);
  assert.equal(r1.body.candidateName, "山田 太郎");
  assert.equal(r2.body.candidateName, "鈴木 花子");
  assert.notEqual(r1.body.jobTitle, r2.body.jobTitle);
});

console.log("\n=== 採用担当の連絡先（質問がある本人が連絡できるように） ===\n");

await ok("採用担当の氏名・メールアドレスが返る", async () => {
  setup();
  const r = await get(TOKEN);
  assert.equal(r.body.recruiterName, "採用 花子");
  assert.equal(r.body.recruiterEmail, "recruit@example.com");
});

await ok("採用担当が未定なら、連絡先はnull（ボタンを出さない判断に使う）", async () => {
  setup();
  db.rows.gw_hr_applicants[0].recruiter_id = null;
  const r = await get(TOKEN);
  assert.equal(r.body.recruiterEmail, null);
});

await ok("回答状況（responseStatus）が返る", async () => {
  setup();
  const r = await get(TOKEN);
  assert.equal(r.body.responseStatus, "pending");
});

console.log("\n=== 本人が承諾・辞退する（POST） ===\n");

await ok("承諾できる。応募者の状態が「承諾済み」へ進む", async () => {
  setup();
  await get(TOKEN); // 先に開いておく（閲覧記録は必須ではないが、通常の流れ）
  const r = await respond(TOKEN, "accept");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.responseStatus, "accepted");
  assert.ok(db.rows.gw_hr_offers[0].accepted_at, "accepted_atが立つ");
  assert.equal(db.rows.gw_hr_applicants[0].status, "accepted");
});

await ok("承諾しただけでは gw_employees は作られない（本採用は別ステージ）", async () => {
  setup();
  await respond(TOKEN, "accept");
  assert.equal((db.rows.gw_employees || []).length, 1, "元からいたrecruiterの1人だけ。増えない");
});

await ok("選考タイムライン・監査ログに残る", async () => {
  setup();
  await respond(TOKEN, "accept");
  assert.ok(db.rows.gw_hr_timeline.some((t) => t.event_key === "offer_accepted"));
  assert.ok(logged.some((l) => l.action === "hr.offer_accepted"));
});

await ok("採用担当（recruiter_id）へ通知される", async () => {
  setup();
  await respond(TOKEN, "accept");
  assert.ok(db.rows.gw_notifications.some((n) => n.employee_id === "e1" && n.kind === "hr"));
});

await ok("辞退できる。理由つきで記録される", async () => {
  setup();
  const r = await respond(TOKEN, "decline", { declineReason: "他社の内定を承諾したため" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.responseStatus, "declined");
  assert.ok(db.rows.gw_hr_offers[0].declined_at, "declined_atが立つ");
  assert.equal(db.rows.gw_hr_offers[0].decline_reason, "他社の内定を承諾したため");
  assert.equal(db.rows.gw_hr_applicants[0].status, "declined");
});

await ok("辞退理由は任意（空でもよい）", async () => {
  setup();
  const r = await respond(TOKEN, "decline");
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(db.rows.gw_hr_offers[0].decline_reason, null);
});

await ok("辞退も選考タイムライン・監査ログに残る", async () => {
  setup();
  await respond(TOKEN, "decline", { declineReason: "縁がなかった" });
  assert.ok(db.rows.gw_hr_timeline.some((t) => t.event_key === "offer_declined" && t.detail === "縁がなかった"));
  assert.ok(logged.some((l) => l.action === "hr.offer_declined"));
});

await ok("すでに回答済みなら、二重に回答できない", async () => {
  setup();
  await respond(TOKEN, "accept");
  const r = await respond(TOKEN, "decline");
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "already_responded");
});

await ok("actionが不正なら断る", async () => {
  setup();
  const r = await respond(TOKEN, "maybe");
  assert.equal(r.statusCode, 400);
});

await ok("tokenが無効なら回答できない", async () => {
  setup();
  const r = await respond("b".repeat(43), "accept");
  assert.equal(r.statusCode, 404);
});

await ok("期限切れなら回答できない", async () => {
  setup();
  db.rows.gw_hr_offers[0].expires_at = PAST;
  const r = await respond(TOKEN, "accept");
  assert.equal(r.statusCode, 410);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
