// 二段階認証（TOTP）は**任意**。決めたとおりに効くか（2026-10-01 に「必須」から変更）。
//
// ■ 何を守るテストか
//
//   1. 誰にも必須にしない。どの役割でも、どの日付でも（2026-10-01 以降も）、どのトークン（aal1・aal2・なし）でも、
//      未登録でも登録済みでも、止めない（requireMfa は常に通す。mfaState の blocked / required / enforced は false）
//   2. 登録していないことを、エラー・警告にしない（共通ヘッダの案内帯・マイページの赤/黄の警告・期限の文言が無い）
//   3. 登録する機能は残っている（マイページ・/api/mfa の登録・確認・解除・リセット・ログインの6桁）
//   4. 自分で解除するときだけ、直前に6桁で確かめた（aal2）ことを要る（パスワードだけで、登録を外されないように）。
//      「強制期間中は外せない」はない
//   5. 機密の API を守るのは、ロールの判定（canManageHr など）。二段階認証には頼らない
//   6. サーバは秘密を持たず、トークンの aal だけを見ること。出入りは、すべて記録に残ること
//   7. Office（/office・/api/office/*）は、二段階認証を見ないこと
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const M = await import(join(ROOT, "lib/mfa.js"));
const read = (f) => readFileSync(join(ROOT, f), "utf8");
/** コメントを除いたコード（// の行と、行末の空白つき //。文字列の中の http:// は消さない） */
const code = (f) => read(f).replace(/(^|[ \t])\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

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

const ROLES = [[], ["owner"], ["manager"], ["finance"], ["hr"], ["labor_advisor"], ["it"], ["sales"], ["recruiter"], ["owner", "hr", "manager", "finance", "labor_advisor"]];
const CTXS = [...ROLES.map((roles) => ({ isAdmin: false, roles })), { isAdmin: true, roles: [] }, { isAdmin: true, roles: ["owner"] }, null];
const TOKENS = [null, "aal1", "aal2"];
const USERS = [none, half, enrolled, null];
const DATES = ["2026-09-29", "2026-09-30", "2026-10-01", "2026-12-31", "2027-06-01", "2099-01-01"];

console.log("\n=== 二段階認証：任意（必須にしない・強制もしない） ===\n");

console.log("— 誰にも必須でない —");

await ok("needsMfa は、どの役割でも false（管理者・経営者・責任者・経理・人事・社労士も）", async () => {
  for (const ctx of CTXS) assert.equal(M.needsMfa(ctx), false, JSON.stringify(ctx));
  assert.equal(M.needsMfa(), false);
});
await ok("mfaState は、どの役割・トークン・登録状況・日付でも、required / enforced / blocked が false。期限の日付を返さない", async () => {
  let n = 0;
  for (const ctx of CTXS) for (const t of TOKENS) for (const user of USERS) for (const today of DATES) {
    const st = M.mfaState({ ctx, user, req: req(t), today });
    assert.deepEqual([st.required, st.enforced, st.blocked], [false, false, false], JSON.stringify({ ctx, t, today }));
    assert.deepEqual([st.enrollUntil, st.enforceFrom], [null, null]);
    n++;
  }
  assert.equal(n, CTXS.length * TOKENS.length * USERS.length * DATES.length);
  assert.ok(n > 900, `${n} 通り`);
});
await ok("mfaState は、事実（登録済みか・6桁で確かめたか）は、そのまま返す（画面の表示に使う）", async () => {
  assert.equal(M.mfaState({ user: enrolled, req: req("aal2") }).enrolled, true);
  assert.equal(M.mfaState({ user: enrolled, req: req("aal2") }).verified, true);
  assert.equal(M.mfaState({ user: enrolled, req: req("aal1") }).verified, false);
  assert.equal(M.mfaState({ user: half, req: req("aal1") }).enrolled, false, "確認前の登録は、登録済みではない");
  assert.equal(M.mfaState({ user: none, req: req(null) }).enrolled, false);
  assert.equal(M.mfaState().enrolled, false);
});
await ok("requireMfa は、常に通す。応答を書かない（403 mfa_required を返さない）。昔の呼び出し（strict つき）でも", async () => {
  for (const ctx of CTXS) for (const t of TOKENS) for (const user of USERS) {
    for (const opts of [undefined, {}, { strict: true }]) {
      const r = res();
      assert.equal(await M.requireMfa(req(t), r, ctx, user, opts), true, JSON.stringify({ ctx, t }));
      assert.equal(r.statusCode, 0, "何も書かない");
      assert.equal(r.body, null);
    }
  }
});

console.log("— 2026-10-01 以降の強制をしない —");

await ok("強制日・対象のロール・登録期間の定数が、lib/mfa.js に無い（強制の処理が残っていない）", async () => {
  for (const k of ["ENFORCE_FROM", "ENROLL_UNTIL", "REQUIRED_ROLES", "todayJst", "requireMfaStrict"]) assert.equal(k in M, false, k);
  const src = code("lib/mfa.js");
  assert.ok(!/2026-10-01|2026-09-30|MFA_ENFORCE|MFA_ENROLL|process\.env|strict/.test(src), "強制日・環境変数・strict がコードに残っている");
});
await ok("強制日を環境変数で過去にしても、止めない（環境変数を読まない）", async () => {
  const keep = process.env.MFA_ENFORCE_FROM;
  process.env.MFA_ENFORCE_FROM = "2000-01-01";
  try {
    const fresh = await import(join(ROOT, `lib/mfa.js?env${Date.now()}`));
    const r = res();
    assert.equal(await fresh.requireMfa(req("aal1"), r, { isAdmin: true, roles: ["owner"] }, none), true);
    assert.equal(r.statusCode, 0);
    assert.equal(fresh.mfaState({ ctx: { isAdmin: true }, user: none, req: req("aal1") }).blocked, false);
  } finally {
    if (keep === undefined) delete process.env.MFA_ENFORCE_FROM; else process.env.MFA_ENFORCE_FROM = keep;
  }
});
await ok("昔の強制日（2026-10-01）より後の日付に、時計を進めても、同じ（日付を見ない）", async () => {
  const RealDate = Date;
  try {
    for (const d of ["2026-10-01T00:00:00+09:00", "2027-03-01T00:00:00+09:00"]) {
      globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [d])); } static now() { return new RealDate(d).getTime(); } };
      const r = res();
      assert.equal(await M.requireMfa(req("aal1"), r, { isAdmin: true, roles: ["owner", "hr"] }, none), true, d);
      assert.equal(M.mfaState({ ctx: { isAdmin: true }, user: none, req: req("aal1") }).blocked, false, d);
    }
  } finally { globalThis.Date = RealDate; }
});

console.log("— 登録していないことを、エラー・警告にしない —");

await ok("共通ヘッダに、二段階認証の案内帯（mfaNudge・kp-mfa-nudge）が無い", async () => {
  const src = read("js/layout.js");
  assert.ok(!/mfaNudge|kp-mfa-nudge|二段階認証を .*登録してください|から必須/.test(src));
});
await ok("api/me.js は、二段階認証の状態を返す（事実だけ。required / blocked は false）", async () => {
  const src = read("api/me.js");
  assert.match(src, /mfa: mfaState\(/);
});
await ok("マイページは「任意」。必須・強制・期限・登録しないと開けない、の文言が無い。登録していなくても赤/黄の警告にしない", async () => {
  const html = read("mypage.html");
  assert.match(html, /二段階認証（任意のセキュリティ設定）/);
  assert.match(html, /任意の設定です。登録しなくても、これまでどおり使えます/);
  const start = html.indexOf("// ---- 二段階認証"), end = html.indexOf("function render(ctx)");
  // コメント（「必須にしない」と説明している行）は除く。画面に出る文言と処理だけを見る
  const mfa = html.slice(start, end).replace(/^\s*\/\/.*$/gm, "");
  for (const w of ["必須", "強制", "enrollUntil", "enforceFrom", "開けなくなります", "開けません", "までの登録", "mfaInfo?.required", "banner err", "banner warn"]) {
    assert.ok(!mfa.includes(w), `マイページの二段階認証に「${w}」が残っている`);
  }
});

console.log("— 登録する機能は、残っている —");

await ok("マイページ：登録を始める・確認して登録・登録を外す が残っている", async () => {
  const html = read("mypage.html");
  for (const w of ["mfaStart(", "mfaFinish(", "mfaOff(", "登録を始める", "確認して登録", "登録を外す", "登録済みです"]) assert.ok(html.includes(w), w);
});
await ok("/api/mfa：enroll・verify・unenroll・reset が残っている。画面（api-client）は /api/mfa を通す", async () => {
  const src = read("api/mfa.js");
  for (const a of ["enroll", "verify", "unenroll", "reset"]) assert.match(src, new RegExp(`case "${a}"`), a);
  const c = read("js/api-client.js");
  assert.doesNotMatch(c, /auth\/v1\/factors/, "画面から直接叩いている");
  for (const f of ["mfaEnroll", "mfaVerify", "mfaUnenroll", "mfaReset", "mfaStatus", "mfaFactors"]) assert.ok(c.includes(f), f);
});
await ok("ログイン：登録している人には、6桁を聞く（登録した人だけ。登録していない人は、そのまま入れる）", async () => {
  const src = read("index.html");
  assert.match(src, /API\.mfaFactors\(\)/);
  assert.match(src, /認証アプリの6桁/);
});
await ok("mfa_required を返す API が来ても、マイページへ送る画面の部品は残っている（js/api-client.js）。使うのは、これから MFA を要る機能を作るとき", async () => {
  assert.match(read("js/api-client.js"), /mfa_required/);
});

console.log("— 自分で外せるか（再認証だけ）—");

await ok("直前に6桁で確かめていれば（aal2）、どの役割でも外せる", async () => {
  for (const ctx of CTXS) assert.deepEqual(M.selfUnenroll({ ctx, req: req("aal2"), today: "2026-10-01" }), { ok: true });
  assert.deepEqual(M.selfUnenroll({ req: req("aal2") }), { ok: true });
});
await ok("確かめていなければ（aal1・トークンなし）外せない。理由は reauth で、「6桁でもう一度」の案内。「強制期間中は外せない（locked）」はない", async () => {
  for (const ctx of CTXS) for (const t of [null, "aal1"]) for (const today of DATES) {
    const r = M.selfUnenroll({ ctx, req: req(t), today });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "reauth");
    assert.match(r.hint, /6桁/);
    assert.ok(!/強制|管理者/.test(r.hint), r.hint);
  }
});

console.log("— 機密の API は、ロールで守る —");

await ok("給与・人件費・権限の変更・アカウント・名簿・MFA のリセットの API は、ロールの判定（canManageHr）を通る", async () => {
  for (const f of ["api/hr/payroll.js", "api/employees/roles.js", "api/employees/account.js", "api/employees/index.js", "api/mfa.js"]) {
    assert.match(code(f), /canManageHr\(ctx\)/, `${f} にロールの判定が無い`);
  }
});
await ok("ホーム・マイページ・タスクは止めない（登録へ行く道を塞がない）", async () => {
  for (const f of ["api/me.js", "api/tasks/index.js", "api/news.js"]) {
    let src = "";
    try { src = read(f); } catch { continue; }
    assert.doesNotMatch(src, /requireMfa\(/, `${f} で止めている`);
  }
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

console.log("— Office は、二段階認証を見ない —");

await ok("Office の API（api/office/*.js）は、requireMfa も lib/mfa.js も使わない。権限（canAccessOffice）だけで通す", async () => {
  const files = readdirSync(join(ROOT, "api/office")).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 4, "index・timesheet・terms・file");
  for (const f of files) {
    const src = code(`api/office/${f}`);
    assert.doesNotMatch(src, /requireMfa|lib\/mfa\.js|mfaState|aalOf/, `api/office/${f} が MFA を見ている`);
    assert.match(src, /canAccessOffice\(ctx\)/, `api/office/${f} に権限判定が無い`);
  }
});
await ok("Office の画面（office/*.html・js/office-layout.js）は、MFA の状態を見て止めない", async () => {
  const pages = readdirSync(join(ROOT, "office")).filter((f) => f.endsWith(".html")).map((f) => `office/${f}`);
  for (const f of [...pages, "js/office-layout.js"]) {
    assert.doesNotMatch(read(f), /mfaStatus|mfa_required|aal2|mfaState/i, `${f} が MFA を見ている`);
  }
});

console.log("— 出入りが記録に残るか —");

await ok("登録・解除・リセット・再登録は、すべて記録する", async () => {
  const src = read("api/mfa.js");
  for (const a of ["mfa.enroll", "mfa.unenroll", "mfa.reset", "mfa.reenroll"]) {
    assert.ok(src.includes(`"${a}"`), `${a} を残していません`);
  }
});
await ok("自分のリセットは断る（パスワードだけで、登録を外せてしまうため）", async () => {
  assert.match(read("api/mfa.js"), /self_reset/);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
