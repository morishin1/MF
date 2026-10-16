// 採用HR → Office への引き渡し（lib/hire-handoff.js）。
//
// ■ 何を守るのか
//   1. 引き渡した版（handoff_at が入っている）だけ読む。承諾しただけ・正式契約の途中の版は、Office に出ない
//   2. 承諾済み・取り消し／辞退でない版だけ。育成枠・区分なしは、Office へ引き渡さない（handoff_at が入っていても出さない）
//   3. Office に出すのは「承諾した事実」と「HR で終えた正式契約の状態」と「誰が・いつ引き渡したか」だけ。
//      給与・連絡先・承諾の IP・トークン・LegalSign の URL を返さない
//   4. 別のテナントの版は読まない（service role で読むので、tenant_id で必ず絞る）。応募者を絞って読める（100件ずつ）
import assert from "node:assert/strict";
import { handoffFactsOf, readHandoffOffers, handoffActorNames } from "../lib/hire-handoff.js";

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

// 偽の Supabase：eq / not / is / in / order / limit を実際に効かせる
function fakeSb(rows) {
  const calls = [];
  return {
    calls,
    from(name) {
      const f = [];
      let lim = Infinity;
      const q = {
        select() { return q; },
        eq(k, v) { calls.push(["eq", name, k, v]); f.push((r) => r[k] === v); return q; },
        not(k, op, v) { f.push((r) => (op === "is" && v === null ? r[k] != null : true)); return q; },
        is(k, v) { f.push((r) => (v === null ? r[k] == null : r[k] === v)); return q; },
        in(k, vs) { calls.push(["in", k, vs.length]); f.push((r) => vs.includes(r[k])); return q; },
        order() { return q; },
        limit(n) { lim = n; return q; },
        then(fn) {
          const data = (rows[name] || []).filter((r) => f.every((p) => p(r))).slice(0, lim);
          return Promise.resolve({ data, error: null }).then(fn);
        },
      };
      return q;
    },
  };
}

const T = "t1";
const ACC = "2026-10-10T01:00:00Z";
const HAND = "2026-10-12T06:00:00Z";
const offer = (o = {}) => ({ id: "o1", tenant_id: T, applicant_id: "a1", version: 1, offer_type: "contractor", accepted_at: ACC, handoff_at: HAND, handoff_by: "u-hr", ...o });
const APP = { id: "a1", name: "高木 沙綾", job_title: "エンジニア", employment_type: "正社員" };

await ok("引き渡した版（handoff_at あり）だけ読む。承諾しただけ・承諾前・辞退・無効化・区分なし・育成枠・別テナントは読まない", async () => {
  const sb = fakeSb({ gw_hr_offers: [
    offer({ id: "ok1" }),
    offer({ id: "accepted-only", handoff_at: null }),
    offer({ id: "pending", accepted_at: null, handoff_at: null }),
    offer({ id: "declined", declined_at: "2026-10-11T00:00:00Z" }),
    offer({ id: "revoked", revoked_at: "2026-10-11T00:00:00Z" }),
    offer({ id: "legacy", offer_type: null }),
    offer({ id: "training", offer_type: "training", formal_contract_required: false }),
    offer({ id: "training-formal", offer_type: "training", formal_contract_required: true }),
    offer({ id: "other-tenant", tenant_id: "t2" }),
  ] });
  const r = await readHandoffOffers(sb, T);
  assert.equal(r.ready, true);
  assert.deepEqual(r.offers.map((o) => o.id), ["ok1"]);
});

await ok("承諾しただけの人は、Office の「HRから引き渡し」に載らない（handoff_at が空）", async () => {
  const sb = fakeSb({ gw_hr_offers: [offer({ id: "a", handoff_at: null }), offer({ id: "b", handoff_at: null, formal_contract_required: false })] });
  const r = await readHandoffOffers(sb, T);
  assert.deepEqual([r.ready, r.offers], [true, []]);
});

await ok("tenant_id で必ず絞る（service role で読むため）。tenant が空なら読まない", async () => {
  const sb = fakeSb({ gw_hr_offers: [offer()] });
  await readHandoffOffers(sb, T);
  assert.ok(sb.calls.some(([k, t, col, v]) => k === "eq" && t === "gw_hr_offers" && col === "tenant_id" && v === T), "tenant_id で絞る");
  const none = await readHandoffOffers(fakeSb({ gw_hr_offers: [offer()] }), null);
  assert.deepEqual([none.ready, none.offers], [false, []]);
});

await ok("応募者を絞って読める（100件ずつ）", async () => {
  const ids = Array.from({ length: 230 }, (_, i) => `a${i}`);
  const sb = fakeSb({ gw_hr_offers: ids.map((id) => offer({ id: `o-${id}`, applicant_id: id })) });
  const r = await readHandoffOffers(sb, T, { applicantIds: ids });
  assert.equal(r.offers.length, 230);
  assert.deepEqual(sb.calls.filter(([k]) => k === "in").map((c) => c[2]), [100, 100, 30]);
  const none = await readHandoffOffers(fakeSb({ gw_hr_offers: [offer()] }), T, { applicantIds: ["zz"] });
  assert.deepEqual(none.offers, []);
});

await ok("読めなかった（表が無い・権限）ときは ready=false。空と区別する", async () => {
  const sb = { from: () => { const q = { select: () => q, eq: () => q, not: () => q, is: () => q, order: () => q, limit: () => q, in: () => q,
    then: (fn) => Promise.resolve({ data: null, error: { code: "42P01", message: "no table" } }).then(fn) }; return q; } };
  const r = await readHandoffOffers(sb, T);
  assert.deepEqual([r.ready, r.offers], [false, []]);
});

await ok("引き渡された情報：入社準備に必要なメール・電話もOfficeへ渡す。給与・承諾の記録・LegalSign URLは返さない", async () => {
  const f = handoffFactsOf(offer({
    job_title: "デザイナー", employment_type: "業務委託", join_date: "2026-11-15", viewed_at: "2026-10-09T23:00:00Z",
    notice_title: "業務委託条件通知書", notice_pdf_path: "t1/n.pdf", accepted_pdf_path: "t1/a.pdf",
    formal_contract_required: true, formal_signed_at: "2026-10-11T08:00:00Z", formal_sent_at: "2026-10-11T01:00:00Z", legalsign_url: "https://sign.example.test/c",
    wage_amount: 480000, accept_ip: "203.0.113.9", accept_ua: "UA", accept_email: "x@example.test", token_hash: "SECRET", offer_terms: { duties: "営業" },
  }), { ...APP, email: "saya@example.test", phone: "090-0000-0000" }, { byName: "人事 花子" });
  assert.deepEqual(Object.keys(f).sort(), [
    "acceptedAt", "acceptedPdf", "applicantId", "email", "employmentType", "formalRequired", "formalSignedAt", "handoffAt", "handoffByName",
    "joinDate", "jobTitle", "name", "noticeConfirmedAt", "noticePdf", "noticeTitle", "offerId", "offerType", "offerTypeLabel", "phone", "version",
  ].sort());
  assert.deepEqual([f.name, f.email, f.phone, f.jobTitle, f.employmentType, f.joinDate, f.acceptedAt, f.offerTypeLabel],
    ["高木 沙綾", "saya@example.test", "090-0000-0000", "デザイナー", "業務委託", "2026-11-15", ACC, "業務委託"], "連絡先は応募者、条件はオファーの値を優先");
  assert.deepEqual([f.formalRequired, f.formalSignedAt, f.handoffAt, f.handoffByName], [true, "2026-10-11T08:00:00Z", HAND, "人事 花子"]);
  assert.equal(f.noticeConfirmedAt, "2026-10-09T23:00:00Z", "通知書の確認＝本人が最初に開いた日時");
  const text = JSON.stringify(f);
  for (const s of ["480000", "203.0.113.9", "UA", "x@example.test", "SECRET", "営業", "sign.example", "u-hr"]) assert.equal(text.includes(s), false, `${s} を返さない`);
  assert.ok(text.includes("saya@example.test") && text.includes("090-0000-0000"), "Officeへ本人連絡先は引き継ぐ");
});

await ok("職種・雇用区分はオファーに無ければ応募者の値。通知書の確認日時が無ければ承諾の日時", async () => {
  const f = handoffFactsOf(offer({ notice_pdf_path: null }), APP);
  assert.deepEqual([f.jobTitle, f.employmentType, f.noticeConfirmedAt, f.noticePdf, f.handoffByName], ["エンジニア", "正社員", ACC, false, null]);
});

await ok("正式契約の要否：オファーの値 → 無ければ区分の既定（育成枠だけ不要）。引き渡された版は HR で終えている", async () => {
  assert.equal(handoffFactsOf(offer({ formal_signed_at: "2026-10-11T00:00:00Z" }), APP).formalRequired, true, "業務委託の既定は 必要");
  assert.equal(handoffFactsOf(offer({ formal_contract_required: false }), APP).formalRequired, false);
  assert.equal(handoffFactsOf(offer({ formal_contract_required: false }), APP).formalSignedAt, null);
});

await ok("引き渡した人の名前：ログインの ID から名簿の表示名を引く。名簿に無ければ出さない。tenant で絞る", async () => {
  const sb = fakeSb({ gw_employees: [
    { id: "e1", tenant_id: T, user_id: "u-hr", display_name: "人事 花子" },
    { id: "e2", tenant_id: "t2", user_id: "u-x", display_name: "他社 太郎" },
  ] });
  const m = await handoffActorNames(sb, T, ["u-hr", "u-x", null, "u-hr"]);
  assert.equal(m.get("u-hr"), "人事 花子");
  assert.equal(m.has("u-x"), false, "別のテナントの名前は引かない");
  assert.equal((await handoffActorNames(sb, T, [])).size, 0);
  assert.equal((await handoffActorNames({ from() { throw new Error("db down"); } }, T, ["u-hr"])).size, 0, "引けなくても止めない");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
