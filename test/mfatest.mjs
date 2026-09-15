// 二段階認証（TOTP）の決まりが、決めたとおりに効くか。
//
// ■ 何を守るテストか
//
//   1. 対象が 管理者・経営者・人事・社労士 に限られること（一般社員は止めない）
//   2. 登録期間（〜2026-09-30）は止めず、強制日（2026-10-01〜）から止めること
//   3. 止めるのは、今回の入り方が aal2 でないときだけ（6桁で確かめた人は通す）
//   4. 止めたとき、登録済みか未登録かで、画面に出す言葉が変わること
//   5. サーバは秘密を持たず、トークンの aal だけを見ること
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const M = await import(join(ROOT, "lib/mfa.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

/** aal を入れた、それらしいトークン（署名は見ない） */
const token = (aal) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "u1", aal })}.sig`;
};
const req = (aal) => ({ headers: { authorization: aal ? `Bearer ${token(aal)}` : "" } });
const enrolled = { factors: [{ factor_type: "totp", status: "verified" }] };
const half = { factors: [{ factor_type: "totp", status: "unverified" }] };
const none = { factors: [] };

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};

console.log("\n=== 二段階認証：決めたとおりに効くか ===\n");

console.log("— 誰に要るか —");

await ok("管理者（会計側）は対象", async () => {
  assert.equal(M.needsMfa({ isAdmin: true, roles: [] }), true);
});
await ok("経営者・人事・社労士は対象", async () => {
  for (const r of ["owner", "hr", "labor_advisor"]) {
    assert.equal(M.needsMfa({ isAdmin: false, roles: [r] }), true, r);
  }
});
await ok("一般社員・IT・経理だけの人は対象外", async () => {
  assert.equal(M.needsMfa({ isAdmin: false, roles: [] }), false);
  assert.equal(M.needsMfa({ isAdmin: false, roles: ["it", "finance"] }), false);
  assert.equal(M.needsMfa(null), false);
});

console.log("— いつから止めるか —");

await ok("日付は 登録期間 2026-09-30 まで／強制 2026-10-01 から", async () => {
  assert.equal(M.ENROLL_UNTIL, "2026-09-30");
  assert.equal(M.ENFORCE_FROM, "2026-10-01");
});
await ok("登録期間のあいだは、未登録でも止めない（案内だけ）", async () => {
  const st = M.mfaState({ ctx: { isAdmin: true }, user: none, req: req("aal1"), today: "2026-09-30" });
  assert.equal(st.required, true);
  assert.equal(st.enrolled, false);
  assert.equal(st.enforced, false);
  assert.equal(st.blocked, false);
});
await ok("強制日からは、aal1 のままだと止める", async () => {
  const st = M.mfaState({ ctx: { isAdmin: true }, user: enrolled, req: req("aal1"), today: "2026-10-01" });
  assert.equal(st.enforced, true);
  assert.equal(st.blocked, true);
});
await ok("強制日でも、6桁で確かめた（aal2）なら通す", async () => {
  const st = M.mfaState({ ctx: { isAdmin: true }, user: enrolled, req: req("aal2"), today: "2026-10-01" });
  assert.equal(st.verified, true);
  assert.equal(st.blocked, false);
});
await ok("強制日でも、対象外の人は止めない", async () => {
  const st = M.mfaState({ ctx: { isAdmin: false, roles: [] }, user: none, req: req("aal1"), today: "2027-01-01" });
  assert.equal(st.blocked, false);
});

console.log("— トークンの読み方 —");

await ok("aal はトークンの中身から読む", async () => {
  assert.equal(M.aalOf(req("aal2")), "aal2");
  assert.equal(M.aalOf(req("aal1")), "aal1");
});
await ok("壊れたトークン・無いトークンは null（aal2 と誤らない）", async () => {
  assert.equal(M.aalOf(req(null)), null);
  assert.equal(M.aalOf({ headers: { authorization: "Bearer not.a" } }), null);
  assert.equal(M.aalOf({ headers: { authorization: "Bearer a.!!!.c" } }), null);
  assert.equal(M.aalOf({}), null);
});
await ok("登録済みは、verified の TOTP があるときだけ", async () => {
  assert.equal(M.enrolledOf(enrolled), true);
  assert.equal(M.enrolledOf(half), false);
  assert.equal(M.enrolledOf(none), false);
  assert.equal(M.enrolledOf({}), false);
  assert.equal(M.enrolledOf(null), false);
});

console.log("— API の入口 —");

// requireMfa は「今日」を固定できないので、環境変数で強制日を前後に動かして試す
const withDates = async (from, fn) => {
  const keep = process.env.MFA_ENFORCE_FROM;
  process.env.MFA_ENFORCE_FROM = from;
  try {
    // ENFORCE_FROM は読み込み時に決まる。値を変えて読み直す
    const fresh = await import(join(ROOT, `lib/mfa.js?${from}`));
    await fn(fresh);
  } finally {
    if (keep === undefined) delete process.env.MFA_ENFORCE_FROM;
    else process.env.MFA_ENFORCE_FROM = keep;
  }
};

await ok("強制前は通す（true を返し、何も書かない）", async () => {
  await withDates("2999-01-01", async (m) => {
    const r = res();
    assert.equal(await m.requireMfa(req("aal1"), r, { isAdmin: true }, none), true);
    assert.equal(r.statusCode, 0);
  });
});
await ok("強制後・未登録は 403 mfa_required と「登録して」の案内", async () => {
  await withDates("2000-01-01", async (m) => {
    const r = res();
    assert.equal(await m.requireMfa(req("aal1"), r, { isAdmin: true }, none), false);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.error, "mfa_required");
    assert.equal(r.body.enrolled, false);
    assert.match(r.body.hint, /登録/);
  });
});
await ok("強制後・登録済み・aal1 は 403 と「確かめて」の案内", async () => {
  await withDates("2000-01-01", async (m) => {
    const r = res();
    assert.equal(await m.requireMfa(req("aal1"), r, { isAdmin: true }, enrolled), false);
    assert.equal(r.statusCode, 403);
    assert.equal(r.body.enrolled, true);
    assert.match(r.body.hint, /確かめ/);
  });
});
await ok("強制後でも aal2 なら通す", async () => {
  await withDates("2000-01-01", async (m) => {
    const r = res();
    assert.equal(await m.requireMfa(req("aal2"), r, { isAdmin: true }, enrolled), true);
  });
});
await ok("強制後でも、対象外の一般社員は通す", async () => {
  await withDates("2000-01-01", async (m) => {
    const r = res();
    assert.equal(await m.requireMfa(req("aal1"), r, { isAdmin: false, roles: [] }, none), true);
  });
});

console.log("— 入口に置いてあるか —");

await ok("個人情報を返す API は、みな requireMfa を通る", async () => {
  const { readFileSync } = await import("node:fs");
  const files = [
    "api/hr/index.js", "api/onboarding/index.js", "api/onboarding/upload.js",
    "api/onboarding/items.js", "api/sign/index.js", "api/sign/orders.js", "api/sign/file.js",
    "api/sign/templates.js", "api/employees/index.js", "api/employees/roles.js",
    "api/employees/account.js", "api/devices/people.js", "api/devices/web.js",
    "api/contracts/index.js",
  ];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.match(src, /requireMfa\(req, res, ctx, user\)/, `${f} に requireMfa が無い`);
  }
});
await ok("ホーム・マイページ・タスクは止めない（登録へ行く道を塞がない）", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["api/me.js", "api/tasks/index.js", "api/news.js"]) {
    let src = "";
    try { src = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
    assert.doesNotMatch(src, /requireMfa\(/, `${f} で止めている`);
  }
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
