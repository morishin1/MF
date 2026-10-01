// 労働条件通知書：管理側（api/onboarding/notice.js・経営者と人事）と、本人側（api/onboarding/start.js）。
// 同じ DB・同じ Storage（偽物）の上で、管理者のアップロード → 公開 → 本人の閲覧・確認 → 差し替え、まで通す。
//
// ■ 何を守るテストか
//   管理側
//   1. 経営者・人事・管理者だけ。ほかの役割（責任者・採用担当・営業・経理・社労士・一般）は 403。二段階認証は要らない
//   2. 他社の人・他社の版は 404。置き場所は、この会社・この人の専用の場所だけ（他人・他社のパスを掴めない）
//   3. PDFのみ（中身で確かめる）・15MBまで。違うものは断り、置いたファイルも消す。同じファイルの再登録は新しい版にならない
//   4. 差し替えは、新しい版を足す（旧版の行も、旧版のファイルも消さない・書き換えない）。公開は、いちばん新しい版を一度だけ
//   5. 公開すると、本人に通知が届き、入社手続きの段階が進む。署名付きURLは、DB・監査ログ・通知のどこにも残らない
//   本人側
//   6. 見せるのは、自分の「公開済みの最新版」だけ。下書き・古い版・他人の分は見せない。employee_id は、ログインから決まる
//   7. 書類を見る: 署名付きURLは5分。版が変わっていたら断る。URL は、DB・監査ログに残らない
//   8. 確認しました: 最新版だけ。二重押しは成功（最初の日時が残る）。確認すると、入社情報の入力へ進める
//   9. 差し替えて公開すると、新しい版は未確認から始まる。旧版の確認は残る
//  10. 電子署名の依頼があるあいだは、確認ボタンで署名済みにならない。gw_sign_requests は、どの操作でも書き換わらない
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  db, storage, logged, notices, setPersona, adm, admGet, me, meGet, ctxOf, OWNER, HR, HIRE, HIRE2, asAdmin, asHire,
  pdf, daysAgo, setup, put, publish, confirmIt, agreeAll, snapshotSign, everything,
} from "./_noticeharness.mjs";

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== 管理側：権限（経営者・人事・管理者だけ。二段階認証は要らない）===\n");

await ok("経営者・人事・管理者は読める・登録できる（パスワードだけのログイン aal1 で）", async () => {
  setup();
  for (const c of [OWNER, HR, ctxOf("a1", [], { isAdmin: true })]) {
    asAdmin(c);
    const r = await admGet("employeeId=e1");
    assert.equal(r.statusCode, 200, `${c.roles.join() || "admin"}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.notice.status, "none");
    assert.equal(r.headers["cache-control"], "no-store");
  }
});

await ok("責任者・採用担当・営業・経理・社労士・一般メンバー・未ログインは、読めない・書けない（403 / 401）", async () => {
  setup();
  for (const roles of [["manager"], ["recruiter"], ["sales"], ["finance"], ["labor_advisor"], ["it"], []]) {
    asAdmin(ctxOf("x", roles));
    assert.equal((await admGet("employeeId=e1")).statusCode, 403, roles.join() || "一般");
    assert.equal((await adm({ action: "upload", employeeId: "e1", mimeType: "application/pdf", sizeBytes: 10 })).statusCode, 403);
    assert.equal((await adm({ action: "publish", employeeId: "e1", id: "n" })).statusCode, 403);
  }
  assert.deepEqual(db.rows.gw_labor_notices, []);
  setPersona(null, null);
  assert.equal((await admGet("employeeId=e1")).statusCode, 401);
});

await ok("本人（入社予定者）は、管理側の入口を使えない（自分の通知書も、本人の入口から見る）", async () => {
  setup(); asHire();
  assert.equal((await admGet("employeeId=e1")).statusCode, 403);
});

await ok("他社の人は 404。他社の版のプレビューも 404。employeeId なしは 400。知らない action は 400", async () => {
  setup(); asAdmin();
  assert.equal((await admGet("employeeId=ex")).statusCode, 404);
  assert.equal((await adm({ action: "upload", employeeId: "ex", mimeType: "application/pdf", sizeBytes: 10 })).statusCode, 404);
  db.rows.gw_labor_notices.push({ id: "nx", tenant_id: "t2", employee_id: "ex", version: 1, filename: "x.pdf", storage_path: "t2/labor-notice/ex/a.pdf" });
  assert.equal((await admGet("file=nx")).statusCode, 404, "他社の版");
  assert.equal((await admGet("")).statusCode, 400);
  assert.equal((await adm({ action: "nope", employeeId: "e1" })).statusCode, 400);
  assert.equal((await adm({ action: "upload" })).statusCode, 400);
});

console.log("\n=== 管理側：アップロード・登録（PDFのみ・実体で確かめる）===\n");

await ok("置き場所の発行: この会社・この人の専用の場所。PDF以外・大きすぎる・退職者は断る。この時点では行を作らない", async () => {
  setup(); asAdmin();
  const up = await adm({ action: "upload", employeeId: "e1", mimeType: "application/pdf", sizeBytes: 1000 });
  assert.equal(up.statusCode, 200);
  assert.match(up.body.path, /^t1\/labor-notice\/e1\/[0-9a-f-]{36}\.pdf$/);
  assert.ok(up.body.uploadUrl.startsWith("https://storage.test/upload/"));
  assert.equal((await adm({ action: "upload", employeeId: "e1", mimeType: "image/png", sizeBytes: 1000 })).body.error, "unsupported_mime");
  assert.equal((await adm({ action: "upload", employeeId: "e1", mimeType: "application/pdf", sizeBytes: 16 * 1024 * 1024 })).body.error, "file_too_large");
  assert.equal((await adm({ action: "upload", employeeId: "e1", mimeType: "application/pdf", sizeBytes: 0 })).body.error, "no_file");
  const left = await adm({ action: "upload", employeeId: "eL", mimeType: "application/pdf", sizeBytes: 100 });
  assert.equal(left.statusCode, 409);
  assert.equal(db.rows.gw_labor_notices.length, 0);
});

await ok("登録: 中身が PDF でなければ断り、置いたファイルも消す（拡張子・Content-Type を名乗るだけでは通らない）", async () => {
  setup(); asAdmin();
  const up = await adm({ action: "upload", employeeId: "e1", mimeType: "application/pdf", sizeBytes: 100 });
  storage.objects.set(up.body.path, Buffer.from("PK\u0003\u0004word/document.xml"));   // Word を .pdf と名乗って置いた
  const r = await adm({ action: "attach", employeeId: "e1", path: up.body.path, filename: "偽物.pdf" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "not_pdf");
  assert.equal(db.rows.gw_labor_notices.length, 0, "行は作らない");
  assert.ok(storage.removed.includes(up.body.path), "置いたファイルも消す");
  assert.ok(!storage.objects.has(up.body.path));
  const miss = await adm({ action: "attach", employeeId: "e1", path: "t1/labor-notice/e1/00000000-0000-0000-0000-000000000000.pdf", filename: "x.pdf" });
  assert.equal(miss.body.error, "no_file", "置いていないファイル");
});

await ok("登録: 他人・他社・別の種類の置き場所は掴めない（403）。他人の通知書を、この人の版にできない", async () => {
  setup(); asAdmin();
  const other = await adm({ action: "upload", employeeId: "e2", mimeType: "application/pdf", sizeBytes: 100 });
  storage.objects.set(other.body.path, pdf());
  assert.equal((await adm({ action: "attach", employeeId: "e1", path: other.body.path, filename: "x.pdf" })).statusCode, 403, "e2 の置き場所を e1 に");
  for (const path of ["t2/labor-notice/e1/00000000-0000-0000-0000-000000000000.pdf", "t1/esign/e1/document.pdf", "t1/doc-order/e1/00000000-0000-0000-0000-000000000000.pdf",
    "t1/labor-notice/e1/../e2/00000000-0000-0000-0000-000000000000.pdf", ""]) {
    storage.objects.set(path, pdf());
    assert.equal((await adm({ action: "attach", employeeId: "e1", path, filename: "x.pdf" })).statusCode, 403, path || "（空）");
  }
  assert.equal(db.rows.gw_labor_notices.length, 0);
});

await ok("登録: 第1版が下書きとして入る（未公開）。ハッシュ・大きさ・登録した人が残る。同じファイルの再登録は、新しい版にならない", async () => {
  setup();
  const bytes = pdf(2);
  const { state, row, path } = await put("e1", bytes, "通知書_山田.pdf");
  assert.equal(row.version, 1);
  assert.equal(row.published_at, null, "登録しただけでは、公開しない");
  assert.equal(row.confirmed_at, null);
  assert.equal(row.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(row.size_bytes, bytes.length);
  assert.equal(row.uploaded_by, "u-own1");
  assert.equal(row.filename, "通知書_山田.pdf");
  assert.equal(state.notice.status, "draft");
  assert.equal(state.notice.statusLabel, "未公開");
  assert.equal(state.notice.pending.version, 1);
  assert.equal(state.notice.current, null);
  // 同じファイルをもう一度登録（二重押し・再送）
  const again = await adm({ action: "attach", employeeId: "e1", path, filename: "通知書_山田.pdf" });
  assert.equal(again.statusCode, 200);
  assert.equal(db.rows.gw_labor_notices.length, 1, "新しい版にならない");
  const log = logged.find((l) => l.action === "labor_notice.upload");
  assert.deepEqual(log.detail, { version: 1, filename: "通知書_山田.pdf", size: bytes.length });
});

console.log("\n=== 管理側：公開・差し替え（旧版は消さない・書き換えない）===\n");

await ok("公開: 本人に通知が届き（URL なし）、入社手続きの段階が『本人の番』に進む。公開は一度だけ", async () => {
  setup();
  const { row } = await put("e1", pdf());
  assert.equal(db.rows.gw_procedures[0].stage, null);
  const r = await publish("e1", row.id);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.notice.status, "unconfirmed");
  assert.equal(r.body.notice.statusLabel, "本人未確認");
  assert.equal(r.body.notice.current.version, 1);
  const saved = db.rows.gw_labor_notices[0];
  assert.ok(saved.published_at);
  assert.equal(saved.published_by, "u-own1");
  assert.equal(saved.confirmed_at, null);
  const n = notices.find((x) => x.dedupeKey === `labor-notice:${row.id}`);
  assert.equal(n.employeeId, "e1");
  assert.equal(n.link, "/onboarding/");
  assert.ok(!JSON.stringify(n).includes("storage.test"), "通知に URL を載せない");
  assert.equal(db.rows.gw_procedures[0].stage, "signing", "段階が進む（通知書を公開 → 本人の確認待ち）");
  const again = await publish("e1", row.id);
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.error, "already_published");
  assert.equal(db.rows.gw_labor_notices[0].published_at, saved.published_at, "公開日時は変わらない");
  assert.ok(logged.some((l) => l.action === "labor_notice.publish"));
});

await ok("人事も、アップロード・公開できる（入社管理は、経営者だけの画面ではない）", async () => {
  setup();
  const { row } = await put("e1", pdf(), "hr.pdf", HR);
  assert.equal(db.rows.gw_labor_notices[0].uploaded_by, "u-hr1");
  assert.equal((await publish("e1", row.id, HR)).statusCode, 200);
  assert.equal(db.rows.gw_labor_notices[0].published_by, "u-hr1");
});

await ok("差し替え: 新しい版を足す。旧版の行も、旧版のファイルも、消さない・書き換えない。公開するまで、本人には前の版", async () => {
  setup();
  const v1 = await put("e1", pdf(1), "v1.pdf");
  await publish("e1", v1.row.id);
  const before = JSON.stringify(db.rows.gw_labor_notices[0]);
  const v2 = await put("e1", pdf(2), "v2.pdf");
  assert.equal(v2.row.version, 2);
  assert.equal(db.rows.gw_labor_notices.length, 2);
  assert.equal(JSON.stringify(db.rows.gw_labor_notices[0]), before, "旧版の行は、1文字も変わらない");
  assert.ok(storage.objects.has(v1.path), "旧版のファイルは残る");
  assert.deepEqual(storage.removed, [], "どのファイルも消していない");
  assert.equal(v2.state.notice.replacing, true, "差し替えの途中");
  assert.equal(v2.state.notice.current.version, 1);
  assert.equal(v2.state.notice.pending.version, 2);
  // 本人には、まだ前の版
  asHire();
  const s = await meGet();
  assert.equal(s.body.notice.version, 1);
});

await ok("公開は、いちばん新しい版だけ。古い下書きは公開できない（版の取り違えを防ぐ）", async () => {
  setup();
  const a = await put("e1", pdf(1)); const b = await put("e1", pdf(2));       // 第1版・第2版（どちらも未公開）
  const old = await publish("e1", a.row.id);
  assert.equal(old.statusCode, 409);
  assert.equal(old.body.error, "not_latest");
  assert.equal((await publish("e1", b.row.id)).statusCode, 200);
  assert.equal(db.rows.gw_labor_notices.find((r) => r.version === 1).published_at, null, "第1版は公開されないまま履歴に残る");
});

await ok("管理側の応答は、置き場所（storage_path）を返さない。版の履歴・状態・名前・確認日時が分かる", async () => {
  setup();
  const v1 = await put("e1", pdf(1), "v1.pdf"); await publish("e1", v1.row.id);
  asHire(); await meGet(); await confirmIt(1);
  const v2 = await put("e1", pdf(2), "v2.pdf");
  asAdmin();
  const r = await admGet("employeeId=e1");
  const s = JSON.stringify(r.body);
  assert.ok(!s.includes("storage_path") && !s.includes("labor-notice/") && !s.includes("storage.test"), "置き場所・URL を返さない");
  assert.deepEqual(r.body.notice.versions.map((v) => [v.version, v.phase, v.isCurrent]), [[2, "draft", false], [1, "confirmed", true]]);
  const cur = r.body.notice.current;
  assert.equal(cur.uploadedByName, "経営者");
  assert.equal(cur.publishedByName, "経営者");
  assert.equal(cur.confirmedByName, "山田 太郎", "確認した人（本人）の名前");
  assert.ok(cur.confirmedAt);
  assert.equal(r.body.notice.status, "confirmed");
  assert.ok(v2.row.id);
});

await ok("注意書き: 電子署名の依頼がある・作成依頼がある・ログインアカウントが無い・退職済み。管理側には、注意として出す", async () => {
  setup(); asAdmin();
  db.rows.gw_sign_requests.push({ id: "s1", tenant_id: "t1", employee_id: "e1", doc_kind: "employment", status: "sent" });
  let r = await admGet("employeeId=e1");
  assert.equal(r.body.esign.active, true);
  assert.ok(r.body.warnings.some((w) => /電子署名/.test(w)));
  assert.equal(r.body.notice.mode, "esign");
  db.rows.gw_sign_requests = [];
  db.rows.gw_doc_orders.push({ id: "o1", tenant_id: "t1", employee_id: "e2", doc_kind: "employment", status: "requested" });
  r = await admGet("employeeId=e2");
  assert.ok(r.body.warnings.some((w) => /作成依頼/.test(w)));
  r = await admGet("employeeId=eN");
  assert.equal(r.body.employee.hasAccount, false);
  assert.ok(r.body.warnings.some((w) => /アカウント/.test(w)));
  r = await admGet("employeeId=eL");
  assert.ok(r.body.warnings.some((w) => /退職/.test(w)));
});

await ok("プレビュー（管理側）: 署名付きURLは5分。開いた記録（誰が・誰の・何版）を残す。URL は残さない。自分の分は残さない", async () => {
  setup();
  const v1 = await put("e1", pdf()); asAdmin(HR);
  const r = await admGet(`file=${v1.row.id}`);
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.url.startsWith("https://storage.test/sign/hr/t1/labor-notice/e1/"));
  assert.equal(r.body.expiresInSec, 300);
  assert.equal(storage.signed.at(-1).ttl, 300);
  assert.equal(storage.signed.at(-1).bucket, "hr", "非公開バケット hr");
  const sens = db.rows.gw_sensitive_access_log.at(-1);
  assert.equal(sens.actor_id, "u-hr1");
  assert.equal(sens.subject_id, "e1");
  assert.equal(sens.kind, "contract");
  assert.equal(sens.action, "view");
  assert.deepEqual(sens.detail, { version: 1, filename: "労働条件通知書.pdf" });
  assert.ok(!everything().includes("SECRET"), "署名付きURLのトークンが、DB・監査ログ・通知のどこにも残っていない");
  assert.ok(!everything().includes("storage.test/sign"));
});

await ok("表が無い（db/110 未適用）: 読むと linked:false（落ちない）。書くと 503 で、何を流すかを案内する", async () => {
  setup(); asAdmin(); db.missing.add("gw_labor_notices");
  const g = await admGet("employeeId=e1");
  assert.equal(g.statusCode, 200);
  assert.equal(g.body.linked, false);
  assert.match(g.body.hint, /db\/110_labor_notices\.sql/);
  const up = await adm({ action: "upload", employeeId: "e1", mimeType: "application/pdf", sizeBytes: 100 });
  const path = up.body.path;
  storage.objects.set(path, pdf());
  const at = await adm({ action: "attach", employeeId: "e1", path, filename: "x.pdf" });
  assert.equal(at.statusCode, 503);
  assert.equal(at.body.error, "not_ready");
  assert.equal((await adm({ action: "publish", employeeId: "e1", id: "n1" })).statusCode, 503);
});

console.log("\n=== 本人側：自分の「公開済みの最新版」だけ ===\n");

await ok("通知書が無い・下書きだけ → 『会社が準備中』。置き場所も、版の番号も返さない", async () => {
  setup(); asHire();
  let r = await meGet();
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.notice, { linked: true, mode: "notice", state: "none", version: null, publishedAt: null, confirmedAt: null, filename: null });
  assert.equal(r.body.six.steps[1].note, "会社が労働条件通知書を準備しています");
  await put("e1", pdf());                                    // 下書き（未公開）
  asHire();
  r = await meGet();
  assert.equal(r.body.notice.state, "none", "下書きは、本人には見えない");
  const s = await me({ action: "view_notice", version: 1 });
  assert.equal(s.statusCode, 404, "下書きのファイルは、開けない");
  assert.equal(s.body.error, "not_published");
  assert.equal(storage.signed.length, 0, "署名付きURLを作っていない");
});

await ok("公開後 → 『確認してください』。最上部の『次にやること』は、通知書の確認。押す先は、この画面の中", async () => {
  setup();
  const v1 = await put("e1", pdf(), "山田様_労働条件通知書.pdf"); await publish("e1", v1.row.id);
  asHire();
  const r = await meGet();
  assert.equal(r.body.notice.state, "unconfirmed");
  assert.equal(r.body.notice.version, 1);
  assert.equal(r.body.notice.filename, "山田様_労働条件通知書.pdf");
  assert.equal(r.body.notice.confirmedAt, null);
  assert.equal(r.body.six.next.label, "労働条件通知書の確認");
  assert.equal(r.body.six.next.actor, "employee");
  assert.deepEqual(r.body.six.next.cta, { label: "労働条件通知書を確認する", action: "notice" });
  assert.equal(r.body.six.steps[1].cta.action, "notice");
  const s = JSON.stringify(r.body);
  assert.ok(!s.includes("storage_path") && !s.includes("labor-notice/") && !s.includes("storage.test"), "置き場所・URL を返さない");
});

await ok("書類を見る: 署名付きURLは5分・非公開バケット。版が変わっていたら断る。URL も置き場所も、DB・監査ログ・通知に残らない", async () => {
  setup();
  const v1 = await put("e1", pdf(), "n.pdf"); await publish("e1", v1.row.id);
  asHire();
  const r = await me({ action: "view_notice", version: 1 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(r.body.url.startsWith("https://storage.test/sign/hr/t1/labor-notice/e1/"));
  assert.equal(r.body.expiresInSec, 300);
  assert.equal(r.body.version, 1);
  assert.equal(storage.signed.at(-1).ttl, 300);
  assert.equal(r.headers["cache-control"], "no-store");
  const log = logged.find((l) => l.action === "labor_notice.view");
  assert.deepEqual(log.detail, { version: 1 }, "見た記録は、版だけ");
  assert.ok(!everything().includes("SECRET") && !everything().includes("storage.test/sign"), "URL が残っていない");
  const old = await me({ action: "view_notice", version: 7 });
  assert.equal(old.statusCode, 409);
  assert.equal(old.body.error, "version_changed");
  const noVersion = await me({ action: "view_notice" });
  assert.equal(noVersion.statusCode, 200, "版を渡さなくても、最新版が開く（別タブのビューア）");
});

await ok("他人の通知書は、見えない・開けない・確認できない（employee_id は、ログインから決まる。画面の値は使わない）", async () => {
  setup();
  const v1 = await put("e1", pdf(), "e1.pdf"); await publish("e1", v1.row.id);
  asHire(HIRE2);                                           // e2 でログイン
  let r = await meGet();
  assert.equal(r.body.notice.state, "none", "e1 の通知書は、e2 には見えない");
  r = await me({ action: "view_notice", version: 1, employeeId: "e1" });
  assert.equal(r.statusCode, 404, "employeeId を渡しても使わない");
  r = await me({ action: "confirm_notice", version: 1, employeeId: "e1", id: v1.row.id });
  assert.equal(r.statusCode, 409);
  assert.equal(db.rows.gw_labor_notices[0].confirmed_at, null, "e1 の版は、変わらない");
  assert.equal(storage.signed.length, 0);
});

console.log("\n=== 本人側：確認しました ===\n");

await ok("確認: 公開済みの最新版に、日時と確認した人が付く。入社情報の入力へ進める（段階が進む）。確認日が画面に出る", async () => {
  setup(); agreeAll("e1");
  const v1 = await put("e1", pdf()); await publish("e1", v1.row.id);
  const r = await confirmIt(1);
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.notice.state, "confirmed");
  assert.ok(r.body.notice.confirmedAt);
  const row = db.rows.gw_labor_notices[0];
  assert.ok(row.confirmed_at);
  assert.equal(row.confirmed_by, "u-e1");
  assert.equal(row.tenant_id, "t1");
  assert.equal(row.employee_id, "e1");
  assert.equal(r.body.six.steps[1].state, "done", "STEP2 が完了");
  assert.equal(r.body.six.steps[1].note, "労働条件通知書を確認済み");
  assert.equal(r.body.six.next.label, "入社情報の入力");
  assert.equal(db.rows.gw_procedures[0].stage, "intake", "入社手続きの段階が進む");
  assert.ok(logged.some((l) => l.action === "labor_notice.confirm" && l.detail.version === 1));
});

await ok("二重押しは成功。最初の確認日時が残り、行は書き換わらず、記録も増えない", async () => {
  setup();
  const v1 = await put("e1", pdf()); await publish("e1", v1.row.id);
  const first = await confirmIt(1);
  const at = db.rows.gw_labor_notices[0].confirmed_at;
  const logs = logged.filter((l) => l.action === "labor_notice.confirm").length;
  await new Promise((r) => setTimeout(r, 5));
  const second = await confirmIt(1);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.notice.confirmedAt, first.body.notice.confirmedAt);
  assert.equal(db.rows.gw_labor_notices[0].confirmed_at, at, "最初の日時のまま");
  assert.equal(logged.filter((l) => l.action === "labor_notice.confirm").length, logs, "記録が増えない");
});

await ok("確認できるのは、公開済みの最新版だけ。古い版・下書き・まだ無いものは、断る", async () => {
  setup();
  let r = await confirmIt(1);
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "not_published");
  const v1 = await put("e1", pdf(1));
  r = await confirmIt(1);
  assert.equal(r.body.error, "not_published", "下書き");
  await publish("e1", v1.row.id);
  r = await confirmIt(2);
  assert.equal(r.body.error, "version_changed", "知らない版");
  assert.equal(db.rows.gw_labor_notices[0].confirmed_at, null);
});

await ok("読んでいるあいだに、会社が差し替えて公開した → 確認は断られ、新しい版を読み直す。確認は、新しい版に付く", async () => {
  setup();
  const v1 = await put("e1", pdf(1)); await publish("e1", v1.row.id);
  asHire(); await meGet();                                   // 本人は、第1版を開いている
  const v2 = await put("e1", pdf(2)); await publish("e1", v2.row.id);
  const stale = await confirmIt(1);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.error, "version_changed");
  assert.equal(db.rows.gw_labor_notices.every((r) => r.confirmed_at === null), true, "どの版も、確認済みにならない");
  const fresh = await confirmIt(2);
  assert.equal(fresh.statusCode, 200);
  assert.equal(db.rows.gw_labor_notices.find((r) => r.version === 2).confirmed_at !== null, true);
  assert.equal(db.rows.gw_labor_notices.find((r) => r.version === 1).confirmed_at, null);
});

console.log("\n=== 差し替えると、新しい版は未確認 ===\n");

await ok("確認済みのあとで差し替えて公開 → 新しい版は未確認。旧版の確認は残る。管理側で、版ごとの確認が分かる", async () => {
  setup(); agreeAll("e1");
  const v1 = await put("e1", pdf(1), "v1.pdf"); await publish("e1", v1.row.id);
  await confirmIt(1);
  assert.equal(db.rows.gw_procedures[0].stage, "intake", "確認で、入社情報の入力へ進んでいた");
  const at1 = db.rows.gw_labor_notices[0].confirmed_at;
  const v2 = await put("e1", pdf(2), "v2.pdf");
  asHire();
  assert.equal((await meGet()).body.notice.state, "confirmed", "公開するまでは、前の版の確認済みのまま");
  await publish("e1", v2.row.id);
  asHire();
  const r = await meGet();
  assert.equal(r.body.notice.state, "unconfirmed", "確認済み → 未確認");
  assert.equal(r.body.notice.version, 2);
  assert.equal(r.body.notice.confirmedAt, null);
  assert.equal(r.body.six.next.label, "労働条件通知書の確認");
  assert.equal(db.rows.gw_labor_notices.find((x) => x.version === 1).confirmed_at, at1, "旧版の確認は残る");
  assert.equal(db.rows.gw_procedures[0].stage, "signing", "STEP2 が、確認待ちに戻る");
  // 新しい版を見ると、新しいファイル
  const view = await me({ action: "view_notice", version: 2 });
  assert.ok(view.body.url.includes(v2.path), "本人に開くのは、第2版のファイル");
  assert.ok(storage.objects.has(v1.path), "第1版のファイルも残っている");
  asAdmin();
  const adminView = await admGet("employeeId=e1");
  assert.equal(adminView.body.notice.status, "unconfirmed");
  assert.deepEqual(adminView.body.notice.versions.map((v) => [v.version, !!v.confirmedAt]), [[2, false], [1, true]]);
  const ok2 = await confirmIt(2);
  assert.equal(ok2.body.notice.state, "confirmed");
  asAdmin();
  assert.equal((await admGet("employeeId=e1")).body.notice.status, "confirmed");
});

console.log("\n=== 電子署名との関係（別の事実）===\n");

await ok("電子署名の依頼があるあいだは、確認ボタンで署名済みにならない。gw_sign_requests は書き換わらない。STEP2 は電子署名のまま", async () => {
  setup();
  db.rows.gw_sign_requests.push({ id: "s1", tenant_id: "t1", employee_id: "e1", title: "労働条件通知書", doc_kind: "employment", status: "sent", sent_at: daysAgo(1) });
  db.rows.gw_doc_orders.push({ id: "o1", tenant_id: "t1", employee_id: "e1", doc_kind: "employment", status: "sent" });
  const before = snapshotSign();
  const v1 = await put("e1", pdf()); await publish("e1", v1.row.id);
  asHire();
  const g = await meGet();
  assert.equal(g.body.notice.mode, "esign");
  assert.equal(g.body.notice.state, "esign", "通知書の確認は出さない");
  assert.equal(g.body.six.steps[1].state, "current");
  assert.equal(g.body.six.steps[1].note, "労働条件通知書と誓約書を確認して、締結してください");
  assert.equal(g.body.six.next.label, "労働条件通知書の締結");
  assert.equal(g.body.six.next.cta.href, "/contracts.html", "押す先は、これまでの契約の画面");
  const c = await confirmIt(1);
  assert.equal(c.statusCode, 409);
  assert.equal(c.body.error, "esign_in_progress");
  const v = await me({ action: "view_notice", version: 1 });
  assert.equal(v.statusCode, 409, "電子署名の流れでは、ここからの閲覧も出さない");
  assert.equal(db.rows.gw_labor_notices[0].confirmed_at, null);
  assert.equal(snapshotSign(), before, "gw_sign_requests は、1文字も変わらない");
  assert.notEqual(db.rows.gw_procedures[0].stage, "intake", "確認では、入社情報の入力に進めない");
});

await ok("誓約書などの同意が残っていれば、通知書を確認しても STEP2 は『誓約書などを確認してください』が残る（これまでの決まり）", async () => {
  setup();
  const v1 = await put("e1", pdf()); await publish("e1", v1.row.id);
  const c = await confirmIt(1);
  assert.equal(c.body.notice.state, "confirmed", "通知書の確認そのものは済み（確認済み・確認日が出る）");
  assert.equal(c.body.six.steps[1].state, "current");
  assert.equal(c.body.six.steps[1].note, "誓約書などを確認してください");
  assert.equal(c.body.six.next.cta.href, "/onboarding.html#consents-card", "押す先は、誓約書などの確認");
  assert.equal(db.rows.gw_procedures[0].stage, "signing");
  agreeAll("e1");
  asHire();
  const after = await meGet();
  assert.equal(after.body.six.steps[1].state, "done");
  assert.equal(after.body.six.next.label, "入社情報の入力");
});

await ok("通知書だけの人は、確認で STEP2 が完了する。電子署名の依頼を取り消せば、通知書の確認が効く", async () => {
  setup(); agreeAll("e1");
  db.rows.gw_sign_requests.push({ id: "s1", tenant_id: "t1", employee_id: "e1", doc_kind: "employment", status: "cancelled" });
  const v1 = await put("e1", pdf()); await publish("e1", v1.row.id);
  const c = await confirmIt(1);
  assert.equal(c.statusCode, 200, "取り消した署名依頼は、無いものとして扱う");
  assert.equal(c.body.six.steps[1].state, "done");
});

await ok("通知書の操作（アップロード・公開・閲覧・確認）は、gw_sign_requests・gw_doc_orders を、読むだけで書かない", async () => {
  setup();
  db.rows.gw_sign_requests.push({ id: "s9", tenant_id: "t1", employee_id: "e2", doc_kind: "employment", status: "signed", signed_at: daysAgo(3) });
  db.rows.gw_doc_orders.push({ id: "o9", tenant_id: "t1", employee_id: "e2", doc_kind: "employment", status: "signed" });
  const before = JSON.stringify([db.rows.gw_sign_requests, db.rows.gw_doc_orders]);
  const v1 = await put("e1", pdf()); await publish("e1", v1.row.id); await confirmIt(1);
  asAdmin(); await admGet("employeeId=e1"); await admGet("employeeId=e2");
  assert.equal(JSON.stringify([db.rows.gw_sign_requests, db.rows.gw_doc_orders]), before);
});

console.log("\n=== 本人側：表が無いとき・アカウントが無いとき ===\n");

await ok("db/110 が未適用でも、入社準備の画面は落ちない（通知書は『未連携』。STEP2 は、これまでの判定）。確認・閲覧は 503", async () => {
  setup(); asHire(); db.missing.add("gw_labor_notices");
  const r = await meGet();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.notice.linked, false);
  assert.equal(r.body.six.steps[1].state, "current");
  assert.equal((await me({ action: "confirm_notice", version: 1 })).statusCode, 503);
  assert.equal((await me({ action: "view_notice", version: 1 })).statusCode, 503);
});

await ok("本人側は、本人（社員名簿に行がある人）だけ。名簿に無い人・未ログインは入れない。知らない action は 400", async () => {
  setup();
  setPersona(ctxOf("zz", [], { employee: null }), { id: "u-zz" });
  assert.equal((await meGet()).statusCode, 403);
  setPersona(ctxOf("zz", [], { employee: null }), null);
  assert.equal((await meGet()).statusCode, 401);
  asHire();
  assert.equal((await me({ action: "nope" })).statusCode, 400);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
