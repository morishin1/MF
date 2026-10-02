// 二段階認証（TOTP）の決まりが、決めたとおりに効くか。
//
// ■ 何を守るテストか
//
//   1. 対象が 管理者・経営者・責任者・経理・人事・社労士 に限られること（一般社員は止めない）
//      Office（経営者・責任者・経理）と /keiei（経営者）に入れる人は、対象に入っていること
//      （Office は MFA を要求しない。対象に残すのは、支払・給与・請求書送信など、MFA を残す機能のため）
//   2. 登録期間（〜2026-09-30）は止めず、強制日（2026-10-01〜）から止めること
//   3. 止めるのは、今回の入り方が aal2 でないときだけ（6桁で確かめた人は通す）
//   4. 止めたとき、登録済みか未登録かで、画面に出す言葉が変わること
//   5. サーバは秘密を持たず、トークンの aal だけを見ること
//   6. strict（/keiei・これから作る支払・給与用）：強制日を待たず、最初から aal2 でないと通さないこと
//   7. Office（/office・/api/office/*）は MFA を要求しない（2026-09-30 の決定）。requireMfa を置かない
//      置くと、強制日（2026-10-01）から、strict でなくても経営者・責任者・経理が入れなくなる
//      MFA を残すもの（給与・権限変更・MFA/パスワードのリセットなど）は、今までどおり requireMfa を通ること
//   8. 任意（2026-10-01 の決定）：MFA_ENABLED が "true" でなければ（既定）、誰も止めない（strict も）。
//      登録していないことを警告にしない（案内帯・必須・期限の文言を出さない）。登録・認証・解除の機能は残し、登録した人にはログインで6桁を聞く。
//      MFA_ENABLED=true に戻せば、上の 1〜7 がそのまま効く
//
// 1〜7 は「MFA_ENABLED=true（再開したとき）」の決まりとして確かめる。8 は最後に OFF にして確かめる
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const M = await import(join(ROOT, "lib/mfa.js"));
const ENABLED_BEFORE = process.env.MFA_ENABLED;
process.env.MFA_ENABLED = "true";

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
await ok("経営者・責任者・経理・人事・社労士は対象（Office と /keiei に入れる人を含む）", async () => {
  for (const r of ["owner", "manager", "finance", "hr", "labor_advisor"]) {
    assert.equal(M.needsMfa({ isAdmin: false, roles: [r] }), true, r);
  }
});
await ok("一般社員・IT・営業・採用担当だけの人は対象外", async () => {
  assert.equal(M.needsMfa({ isAdmin: false, roles: [] }), false);
  assert.equal(M.needsMfa({ isAdmin: false, roles: ["it", "sales", "recruiter"] }), false);
  assert.equal(M.needsMfa(null), false);
});
await ok("Office・/keiei に入れる役割（経営者・責任者・経理）は、二段階認証の対象に入っている（支払・給与などで使う）", async () => {
  const { OFFICE_ROLES, KEIEI_ROLES } = await import(join(ROOT, "lib/gw.js"));
  for (const r of [...OFFICE_ROLES, ...KEIEI_ROLES]) {
    assert.ok(M.REQUIRED_ROLES.includes(r), `${r} が REQUIRED_ROLES に無い`);
  }
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

console.log("— strict（強制日を待たない。/keiei・これから作る支払・給与用） —");

await ok("strict：強制日の前でも、対象の人が aal1 なら止める", async () => {
  const st = M.mfaState({ ctx: { roles: ["finance"] }, user: enrolled, req: req("aal1"), today: "2026-09-29", strict: true });
  assert.equal(st.enforced, false, "画面に出す強制日の判定は日付のまま");
  assert.equal(st.blocked, true);
});
await ok("strict でも、aal2 なら通す／対象外の人は止めない", async () => {
  const a = M.mfaState({ ctx: { roles: ["finance"] }, user: enrolled, req: req("aal2"), today: "2026-09-29", strict: true });
  assert.equal(a.blocked, false);
  const b = M.mfaState({ ctx: { roles: [] }, user: none, req: req("aal1"), today: "2026-09-29", strict: true });
  assert.equal(b.blocked, false);
});
await ok("strict でなければ、これまでどおり強制日までは止めない", async () => {
  const st = M.mfaState({ ctx: { roles: ["finance"] }, user: enrolled, req: req("aal1"), today: "2026-09-29" });
  assert.equal(st.blocked, false);
});
await ok("requireMfa({ strict: true })：強制日の前でも、未登録・aal1 は 403 mfa_required", async () => {
  await withDates("2999-01-01", async (m) => {
    for (const roles of [["owner"], ["manager"], ["finance"]]) {
      const r = res();
      assert.equal(await m.requireMfa(req("aal1"), r, { isAdmin: false, roles }, none, { strict: true }), false, String(roles));
      assert.equal(r.statusCode, 403);
      assert.equal(r.body.error, "mfa_required");
      assert.match(r.body.hint, /登録/);
    }
    const ok2 = res();
    assert.equal(await m.requireMfa(req("aal2"), ok2, { isAdmin: false, roles: ["finance"] }, enrolled, { strict: true }), true);
    assert.equal(ok2.statusCode, 0);
  });
});
await ok("requireMfa（strict なし）は、強制日の前なら通す（既存の API は変わらない）", async () => {
  await withDates("2999-01-01", async (m) => {
    const r = res();
    assert.equal(await m.requireMfa(req("aal1"), r, { isAdmin: false, roles: ["finance"] }, none), true);
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

console.log("— Office は MFA を要求しない／MFA を残すもの —");

await ok("Office の API（api/office/*.js）は、requireMfa も lib/mfa.js も使わない。権限（canAccessOffice）だけで通す", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const files = readdirSync(join(ROOT, "api/office")).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 4, "index・timesheet・terms・file");
  for (const f of files) {
    const src = readFileSync(join(ROOT, "api/office", f), "utf8").replace(/^\s*\/\/.*$/gm, "");   // コメントは除く
    assert.doesNotMatch(src, /requireMfa|lib\/mfa\.js|mfaState|aalOf/, `api/office/${f} が MFA を見ている`);
    assert.match(src, /canAccessOffice\(ctx\)/, `api/office/${f} に権限判定が無い`);
  }
});
await ok("Office の画面（office/*.html・js/office-layout.js）は、MFA の状態を見て止めない", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const pages = readdirSync(join(ROOT, "office")).filter((f) => f.endsWith(".html")).map((f) => `office/${f}`);
  for (const f of [...pages, "js/office-layout.js"]) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.doesNotMatch(src, /mfaStatus|mfa_required|aal2|mfaState/i, `${f} が MFA を見ている`);
  }
});
await ok("MFA を残すもの（給与・人件費／権限変更／MFA・パスワードのリセット）は、今までどおり requireMfa を通る", async () => {
  const { readFileSync } = await import("node:fs");
  const keep = {
    "api/hr/payroll.js": "給与・人件費",
    "api/employees/roles.js": "権限変更",
    "api/employees/account.js": "アカウント（メール・パスワードの変更）",
    "api/mfa.js": "MFA のリセット",
  };
  for (const [f, what] of Object.entries(keep)) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.match(src, /requireMfa\(req, res, ctx, user/, `${f}（${what}）に requireMfa が無い`);
  }
});
await ok("strict の仕組みは残してある（/keiei・これから作る支払・給与用）。Office は、強制日を過ぎても、strict なしの requireMfa の対象にならない", async () => {
  // 強制日を過去にした lib/mfa.js では、経営者・責任者・経理が aal1 のとき、requireMfa は止める。だから Office には置かない
  await withDates("2000-01-01", async (m) => {
    for (const roles of [["owner"], ["manager"], ["finance"]]) {
      const r = res();
      assert.equal(await m.requireMfa(req("aal1"), r, { isAdmin: false, roles }, enrolled), false, `${roles}：強制日以降は、非 strict でも止まる`);
    }
  });
});

console.log("— 自分で外せるか —");

await ok("強制前・6桁で確かめていれば外せる", async () => {
  const r = M.selfUnenroll({ ctx: { isAdmin: true }, req: req("aal2"), today: "2026-09-20" });
  assert.equal(r.ok, true);
});
await ok("強制前でも、確かめていなければ外せない（再認証）", async () => {
  const r = M.selfUnenroll({ ctx: { isAdmin: true }, req: req("aal1"), today: "2026-09-20" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "reauth");
  assert.match(r.hint, /6桁/);
});
await ok("強制後・対象の人は、自分では外せない（管理者のリセットだけ）", async () => {
  const r = M.selfUnenroll({ ctx: { isAdmin: true }, req: req("aal2"), today: "2026-10-01" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "locked");
  assert.match(r.hint, /管理者/);
});
await ok("強制後でも、対象外の人は外せる", async () => {
  const r = M.selfUnenroll({ ctx: { isAdmin: false, roles: ["it"] }, req: req("aal2"), today: "2027-01-01" });
  assert.equal(r.ok, true);
});

console.log("— /keiei（経営）は、二段階認証を見ない（ロール＝経営者だけ。2026-10-01 に必須→任意）—");

{
  const { readFileSync } = await import("node:fs");
  const read = (f) => readFileSync(join(ROOT, f), "utf8");
  /** コメントを除いたコード（// の行と、行末の空白つき //。文字列の中の http:// は消さない） */
  const code = (f) => read(f).replace(/(^|[ \t])\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  await ok("経営の入口（lib/keiei-gate.js）は、ロール（canKeiei）だけで通す。二段階認証・aal を見ない", async () => {
    const src = code("lib/keiei-gate.js");
    assert.match(src, /canKeiei\(ctx\)/, "経営者の判定が無い");
    assert.doesNotMatch(src, /requireMfa|lib\/mfa\.js|mfaState|aalOf|aal2|enrolledOf/, "経営の入口が MFA を見ている");
  });
  await ok("api/mfa.js のリセットは、aal2 を求める入口（requireMfaStrict）を呼ばない。owner の保護（owner_only・self_reset）は残る", async () => {
    const src = code("api/mfa.js");
    assert.doesNotMatch(src, /requireMfaStrict|aal2/, "api/mfa.js が aal2 を要求している");
    assert.match(src, /guardOwnerTarget/);
    assert.match(src, /self_reset/);
  });
  await ok("経営の画面・API に、「二段階認証が必要です」「未登録」の警告・案内が残っていない", async () => {
    for (const f of ["keiei/index.html", "api/keiei/index.js", "lib/keiei-hub.js", "lib/keiei-hub-read.js"]) {
      assert.doesNotMatch(code(f), /mfa_missing|mfaUnknown|mfaPolicy|mfaBox|二段階認証が必要です|二段階認証が未登録/, `${f} に、MFA 必須の名残がある`);
    }
    assert.doesNotMatch(code("keiei/index.html"), /kei-pill warn">未登録|mfa_required/, "経営画面が、未登録を警告にしている");
    assert.doesNotMatch(code("api/keiei/index.js"), /ENFORCE_FROM|ENROLL_UNTIL/, "経営の API が強制日を見ている");
  });
}

console.log("— 出入りが記録に残るか —");

await ok("登録・解除・リセット・再登録は、すべて記録する", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(ROOT, "api/mfa.js"), "utf8");
  for (const a of ["mfa.enroll", "mfa.unenroll", "mfa.reset", "mfa.reenroll"]) {
    assert.ok(src.includes(`"${a}"`), `${a} を残していません`);
  }
});
await ok("画面から Supabase の factors を直接叩かない（記録が残らなくなる）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(ROOT, "js/api-client.js"), "utf8");
  assert.doesNotMatch(src, /auth\/v1\/factors/, "画面から直接叩いています");
  assert.match(src, /"\/api\/mfa"/, "/api/mfa を通していません");
});
await ok("自分のリセットは断る（強制の意味が無くなる）", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(ROOT, "api/mfa.js"), "utf8");
  assert.match(src, /self_reset/);
});

console.log("— 一時停止（MFA_ENABLED が true でない） —");

for (const off of ["false", undefined, ""]) {
  const label = off === undefined ? "未設定" : `"${off}"`;
  await ok(`MFA_ENABLED=${label}：強制日を過ぎても、対象の役割（未登録・aal1）を止めない。required・blocked・enforced は false`, async () => {
    if (off === undefined) delete process.env.MFA_ENABLED; else process.env.MFA_ENABLED = off;
    assert.equal(M.mfaEnabled(), false);
    for (const ctx of [{ isAdmin: true, roles: [] }, ...["owner", "manager", "finance", "hr", "labor_advisor"].map((r) => ({ isAdmin: false, roles: [r] }))]) {
      const st = M.mfaState({ ctx, user: none, req: req("aal1"), today: "2027-01-01" });
      assert.equal(st.enabled, false);
      assert.equal(st.required, false, JSON.stringify(ctx));
      assert.equal(st.blocked, false, JSON.stringify(ctx));
      assert.equal(st.enforced, false, "期限の警告を出さない");
      const r = res();
      assert.equal(await M.requireMfa(req("aal1"), r, ctx, none), true, JSON.stringify(ctx));
      assert.equal(r.statusCode, 0, "403 mfa_required を返さない");
    }
  });
}
await ok("一時停止中は strict: true の API（/keiei・支払・給与用）も止めない（MFA_ENFORCE_FROM を未来日にするだけでは止まるもの）", async () => {
  process.env.MFA_ENABLED = "false";
  for (const roles of [["owner"], ["manager"], ["finance"]]) {
    const st = M.mfaState({ ctx: { isAdmin: false, roles }, user: none, req: req("aal1"), today: "2026-09-29", strict: true });
    assert.equal(st.blocked, false, String(roles));
    const r = res();
    assert.equal(await M.requireMfa(req("aal1"), r, { isAdmin: false, roles }, none, { strict: true }), true, String(roles));
    assert.equal(r.statusCode, 0);
  }
});
await ok("一時停止中も、登録済み・今回の認証（aal2）の状態はそのまま返す（登録済みの factor は消さない・触らない）", async () => {
  process.env.MFA_ENABLED = "false";
  const st = M.mfaState({ ctx: { roles: ["hr"] }, user: enrolled, req: req("aal2") });
  assert.equal(st.enrolled, true);
  assert.equal(st.verified, true);
  const { readFileSync } = await import("node:fs");
  assert.doesNotMatch(readFileSync(join(ROOT, "lib/mfa.js"), "utf8"), /factors\/.*delete|admin\/users.*factors/i, "lib/mfa.js が factor を消している");
});
await ok("MFA_ENABLED=true に戻すと、これまでどおり止める（強制日以降の aal1・strict）", async () => {
  process.env.MFA_ENABLED = "true";
  const st = M.mfaState({ ctx: { roles: ["hr"] }, user: none, req: req("aal1"), today: "2026-10-01" });
  assert.equal(st.enabled, true);
  assert.equal(st.blocked, true);
  const r = res();
  assert.equal(await M.requireMfa(req("aal1"), r, { roles: ["finance"] }, none, { strict: true }), false);
  assert.equal(r.body.error, "mfa_required");
});
await ok("画面：必須にしていない間（enabled=false）も、マイページの設定欄は「任意のセキュリティ設定」として出す。必須・期限の案内は出さない", async () => {
  const { readFileSync } = await import("node:fs");
  const my = readFileSync(join(ROOT, "mypage.html"), "utf8");
  assert.doesNotMatch(my, /el\("mfa"\)\.hidden = true/, "mypage.html が MFA 欄を隠している");
  assert.match(my, /二段階認証（任意のセキュリティ設定）/, "見出しが「任意のセキュリティ設定」でない");
  assert.match(my, /任意の設定です。登録しなくても、これまでどおり使えます/, "「登録しなくても使える」の説明が無い");
  // 必須・期限の案内は、サーバが required を返したときだけ（required の分岐の中にだけある）
  assert.match(my, /const note = required\n/, "必須の案内が required の分岐になっていない");
  // 登録を促す帯（js/layout.js mfaNudge）は required が false なら出ない。必須にしない間の mfaState は required=false
  assert.match(readFileSync(join(ROOT, "js/layout.js"), "utf8"), /if \(!mfa\?\.required \|\| mfa\.enrolled\) return;/);
});
await ok("画面：登録した人は、必須を止めている間（enabled=false）も、ログインで6桁を聞く（任意の設定として、ちゃんと効く）", async () => {
  const { readFileSync } = await import("node:fs");
  const login = readFileSync(join(ROOT, "index.html"), "utf8");
  assert.doesNotMatch(login, /enabled === false/, "index.html が enabled=false で6桁を飛ばしている");
  assert.match(login, /const factors = st\?\.factors \|\| \[\];/, "index.html が登録済みの factor で6桁を聞いていない");
});
await ok("必須を止めている間も、自分で登録を外すには、直前に6桁で確かめる（パスワードだけで、登録を外されない）", async () => {
  process.env.MFA_ENABLED = "false";
  const ctx = { isAdmin: false, roles: ["hr"] };
  assert.deepEqual(M.selfUnenroll({ ctx, req: req("aal1"), today: "2027-01-01" }).reason, "reauth");
  assert.equal(M.selfUnenroll({ ctx, req: req("aal2"), today: "2027-01-01" }).ok, true, "強制期間中の「外せない」は無い");
});

if (ENABLED_BEFORE === undefined) delete process.env.MFA_ENABLED; else process.env.MFA_ENABLED = ENABLED_BEFORE;

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
