// MGNDigital の LP と /sales をつなぐ部品（lib/sales-lp.js）。DB を使わない決まりだけ。
import assert from "node:assert/strict";
import {
  withSalesRef, isMgnLp, senderAllowed, isLpHost, companyDomainOfEmail, normalizeLpLead, lpEventDetail, parseLpDetail, aggregateLp,
} from "../lib/sales-lp.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const ENV = {};

ok("sr を付けるのは MGNDigital の LP（/lp/）だけ", () => {
  assert.equal(withSalesRef("https://8grp.co.jp/lp/", "ABCDEFGH23", ENV), "https://8grp.co.jp/lp/?sr=ABCDEFGH23");
  assert.equal(withSalesRef("https://www.8grp.co.jp/lp/?utm_source=x", "ABCDEFGH23", ENV), "https://www.8grp.co.jp/lp/?utm_source=x&sr=ABCDEFGH23");
  assert.equal(withSalesRef("https://8grp.co.jp/lp", "ABCDEFGH23", ENV), "https://8grp.co.jp/lp?sr=ABCDEFGH23");
  assert.equal(withSalesRef("https://8grp.co.jp/lp/?sr=OLD", "ABCDEFGH23", ENV), "https://8grp.co.jp/lp/?sr=ABCDEFGH23", "古い sr は上書き");
  assert.equal(withSalesRef("https://8grp.co.jp/service/dx", "ABCDEFGH23", ENV), "https://8grp.co.jp/service/dx", "同じホストのほかのページには付けない");
  assert.equal(withSalesRef("https://8grp.co.jp/lpx/", "ABCDEFGH23", ENV), "https://8grp.co.jp/lpx/");
  assert.equal(withSalesRef("https://8grp.co.jp.evil.com/lp/", "ABCDEFGH23", ENV), "https://8grp.co.jp.evil.com/lp/", "似たホストに渡さない");
  assert.equal(withSalesRef("https://example.com/lp/", "ABCDEFGH23", ENV), "https://example.com/lp/");
});

ok("ホスト・パスは env で変えられる", () => {
  const env = { SALES_LP_HOSTS: "mgn.example.jp, 8grp.co.jp", SALES_LP_PATH: "/mgn/" };
  assert.ok(isMgnLp("https://mgn.example.jp/mgn/", env));
  assert.ok(!isMgnLp("https://mgn.example.jp/lp/", env));
  assert.ok(isLpHost("https://sub.8grp.co.jp/", env));
});

ok("会社の照合に使うメールのドメイン（フリーメールは使わない）", () => {
  assert.equal(companyDomainOfEmail("Tanaka@Sample.co.jp"), "sample.co.jp");
  assert.equal(companyDomainOfEmail("a@gmail.com"), null);
  assert.equal(companyDomainOfEmail("a@docomo.ne.jp"), null);
  assert.equal(companyDomainOfEmail("bad"), null);
});

ok("申込の形を確かめる・詳細の文を読み直せる", () => {
  const r = normalizeLpLead({ sr: "abcdefgh23", submissionId: "sub-12345678", email: "a@b.co.jp", tel: "03-1111-2222",
    services: ["A", "A", "B"], name: "田中\n太郎", attribution: { utm_source: "sales", utm_campaign: "fall" } });
  assert.equal(r.value.token, "ABCDEFGH23");
  assert.deepEqual(r.value.services, ["A", "B"]);
  assert.equal(r.value.name, "田中 太郎", "改行は詰める（詳細の1行1項目を壊さない）");
  const p = parseLpDetail(lpEventDetail(r.value, { via: "営業リンク" }));
  assert.deepEqual(p.services, ["A", "B"]);
  assert.equal(p.email, "a@b.co.jp");
  assert.equal(p.submissionId, "sub-12345678");
  assert.equal(normalizeLpLead({ submissionId: "sub-12345678", email: "x" }).error, "bad_email");
  assert.equal(normalizeLpLead([]).error, "invalid_body");
  const none = normalizeLpLead({ submissionId: "sub-12345678", email: "a@b.co.jp" }).value;
  assert.deepEqual(parseLpDetail(lpEventDetail(none)).services, []);
});

ok("会社ごとのまとめ：候補 → 確定 / 候補 → 別の会社", () => {
  const d = lpEventDetail(normalizeLpLead({ submissionId: "sub-12345678", email: "a@b.co.jp", services: ["X"] }).value);
  const m = aggregateLp([
    { company_id: "c1", event_key: "lp_candidate", detail: d, occurred_at: "2026-10-01T00:00:00Z" },
    { company_id: "c1", event_key: "lp_apply", detail: d, occurred_at: "2026-10-01T01:00:00Z" },
    { company_id: "c2", event_key: "lp_candidate", detail: d, occurred_at: "2026-10-01T00:00:00Z" },
    { company_id: "c2", event_key: "lp_reject", detail: null, occurred_at: "2026-10-01T02:00:00Z" },
    { company_id: "c3", event_key: "call", detail: null, occurred_at: "2026-10-01T02:00:00Z" },
  ]);
  assert.deepEqual(m.get("c1"), { appliedAt: "2026-10-01T01:00:00Z", services: ["X"], candidateAt: "2026-10-01T00:00:00Z", candidate: false });
  assert.equal(m.get("c2").candidate, false);
  assert.deepEqual(m.get("c2").services, []);
  assert.equal(m.has("c3"), false);
});

ok("送信元ごとの回数：窓の中だけ数える", () => {
  const m = new Map();
  const rule = { windowSec: 60, max: 2 };
  assert.ok(senderAllowed(m, "a", 0, rule) && senderAllowed(m, "a", 1000, rule));
  assert.ok(!senderAllowed(m, "a", 2000, rule));
  assert.ok(senderAllowed(m, "b", 2000, rule));
  assert.ok(senderAllowed(m, "a", 61500, rule), "60秒たてば、また受ける");
  assert.ok(senderAllowed(m, null, 0, rule), "送信元が分からないときは止めない");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
