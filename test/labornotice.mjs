// 労働条件通知書（lib/labor-notice.js）と、入社手続きの段階判定への組み込み。純粋関数だけ（表も画面も使わない）。
//
// ■ 何を守るテストか
//   1. 版: 1行＝1版。本人に見せるのは「公開済みの最新版」だけ。下書き・古い版は見せない。差し替えると未確認から始まる
//   2. 確認: 公開済みの最新版だけ。読んでいるあいだに差し替えられたら断る。二重押しは成功（最初の日時を残す）
//   3. ファイル: PDFのみ（先頭 %PDF-）・15MBまで。置き場所は、この会社・この人の専用の場所だけ
//   4. 電子署名との関係: 有効な電子署名依頼があるあいだは、通知書の確認で STEP2（雇用契約）を完了にしない
//      電子署名がなく、通知書だけのときは、「確認しました」で STEP2 が完了し、入社情報の入力へ進む
//   5. 段階判定（computeStage・6ステップ・旧6STEP）が、同じ答えを出す（判定を2か所に書かない）
//   6. 管理できるのは owner・hr ロールだけ。会計側の管理者（isAdmin）・canManageHr は使わない
import assert from "node:assert/strict";
import {
  isNoticePath, noticePrefix, isPdfBytes, checkDeclared, checkBytes, cleanFilename, NOTICE_MAX_BYTES,
  sortVersions, currentOf, pendingOf, nextVersion, canPublish, adminState, selfState, canConfirm, noticeFact, listStatus,
  canManageNotice, NOTICE_MANAGER_ROLES,
} from "../lib/labor-notice.js";
import { computeStage, stageFlags } from "../lib/onboard-stage.js";
import { mapSix } from "../lib/onboard-six.js";
import { computeSteps } from "../lib/onboard-steps.js";

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const T = "11111111-1111-1111-1111-111111111111";
const E = "22222222-2222-2222-2222-222222222222";
const U = "33333333-3333-3333-3333-333333333333.pdf";
const row = (version, extra = {}) => ({ id: `n${version}`, version, filename: `v${version}.pdf`, ...extra });
const PUB = "2026-10-01T01:00:00Z";
const CONF = "2026-10-02T02:00:00Z";

console.log("— 管理できる人（owner・hr ロールだけ）—");

ok("owner・hr のロールを持つ人だけが管理できる", () => {
  assert.deepEqual(NOTICE_MANAGER_ROLES, ["owner", "hr"]);
  assert.equal(canManageNotice({ roles: ["owner"] }), true);
  assert.equal(canManageNotice({ roles: ["hr"] }), true);
  assert.equal(canManageNotice({ roles: ["finance", "hr"] }), true, "ほかのロールを持っていても、hr があれば");
});

ok("会計側の管理者（isAdmin）は、ロールが無ければ管理できない。isHr の旗にも頼らない", () => {
  assert.equal(canManageNotice({ isAdmin: true, roles: [] }), false);
  assert.equal(canManageNotice({ isAdmin: true, isHr: false, roles: ["finance"] }), false);
  assert.equal(canManageNotice({ isAdmin: false, isHr: true, roles: [] }), false, "旗だけでは通らない（ロールの中身を見る）");
  assert.equal(canManageNotice({ isAdmin: true, roles: ["hr"] }), true, "管理者でも、hr ロールを持てば管理できる（ロールを見ている）");
});

ok("経理・責任者・採用担当・営業・社労士・IT・一般・未ログインは管理できない", () => {
  for (const r of ["finance", "manager", "recruiter", "sales", "labor_advisor", "it"]) assert.equal(canManageNotice({ roles: [r] }), false, r);
  assert.equal(canManageNotice({ roles: [] }), false);
  assert.equal(canManageNotice({}), false);
  assert.equal(canManageNotice(null), false);
  assert.equal(canManageNotice(undefined), false);
  assert.equal(canManageNotice({ roles: "owner" }), false, "配列でなければ通さない");
});

console.log("— 置き場所・ファイル —");

ok("置き場所は、この会社・この人の専用の場所だけ（他人・他社・別の種類のパスは掴めない）", () => {
  assert.equal(noticePrefix(T, E), `${T}/labor-notice/${E}/`);
  assert.equal(isNoticePath(`${T}/labor-notice/${E}/${U}`, T, E), true);
  assert.equal(isNoticePath(`${T}/labor-notice/${E}/${U}`, T, "99999999-9999-9999-9999-999999999999"), false, "別の人");
  assert.equal(isNoticePath(`${T}/labor-notice/${E}/${U}`, "99999999-9999-9999-9999-999999999999", E), false, "別の会社");
  assert.equal(isNoticePath(`${T}/doc-order/${E}/${U}`, T, E), false, "別の種類の置き場所");
  assert.equal(isNoticePath(`${T}/esign/${E}/document.pdf`, T, E), false, "署名済みの契約書の場所");
  assert.equal(isNoticePath(`${T}/labor-notice/${E}/../x/${U}`, T, E), false, "上の階層へ出るパス");
  assert.equal(isNoticePath(`${T}/labor-notice/${E}/${U.replace(".pdf", ".docx")}`, T, E), false, "PDF以外の拡張子");
  assert.equal(isNoticePath("", T, E), false);
  assert.equal(isNoticePath(`${T}/labor-notice/${E}/${U}`, "", ""), false);
});

ok("PDFのみ。先頭 %PDF- を実体で確かめる。15MB を超えると断る。空も断る", () => {
  assert.equal(isPdfBytes(Buffer.from("%PDF-1.7\n...")), true);
  assert.equal(isPdfBytes(Buffer.from("PK\u0003\u0004word/")), false, "Word（zip）");
  assert.equal(isPdfBytes(Buffer.from("<html>")), false);
  assert.equal(isPdfBytes(Buffer.from("%PDF")), false, "短すぎる");
  assert.equal(checkBytes(Buffer.from("%PDF-1.4 x")).ok, true);
  assert.equal(checkBytes(Buffer.from("GIF89a")).error, "not_pdf");
  assert.equal(checkBytes(Buffer.alloc(0)).error, "no_file");
  const big = Buffer.alloc(NOTICE_MAX_BYTES + 1); big.write("%PDF-1.4");
  assert.equal(checkBytes(big).error, "file_too_large");
});

ok("申告の検査: PDF以外の Content-Type・0バイト・大きすぎるものは、置き場所を出す前に断る", () => {
  assert.equal(checkDeclared({ mimeType: "application/pdf", sizeBytes: 1000 }).ok, true);
  assert.equal(checkDeclared({ sizeBytes: 1000 }).ok, true, "Content-Type が空でも PDF として扱う（実体は、あとで確かめる）");
  assert.equal(checkDeclared({ mimeType: "image/png", sizeBytes: 1000 }).error, "unsupported_mime");
  assert.equal(checkDeclared({ mimeType: "application/msword", sizeBytes: 1000 }).error, "unsupported_mime");
  assert.equal(checkDeclared({ mimeType: "application/pdf", sizeBytes: 0 }).error, "no_file");
  assert.equal(checkDeclared({ mimeType: "application/pdf", sizeBytes: NOTICE_MAX_BYTES + 1 }).error, "file_too_large");
});

ok("ファイル名は、パス区切り・制御文字を落とす。空なら既定の名前", () => {
  assert.equal(cleanFilename("a/b\\c:d*e?.pdf"), "a_b_c_d_e_.pdf");
  assert.equal(cleanFilename("  "), "労働条件通知書.pdf");
  assert.equal(cleanFilename("x".repeat(500)).length, 160);
});

console.log("\n— 版・公開・確認 —");

ok("本人に見せるのは、公開済みの最新版だけ。下書きと古い版は見せない", () => {
  const rows = [row(1, { published_at: PUB }), row(2, { published_at: PUB }), row(3)];
  assert.equal(currentOf(rows).version, 2, "公開済みでいちばん新しい版");
  assert.equal(pendingOf(rows).version, 3, "未公開の新しい版（公開待ち）");
  assert.equal(selfState(rows).version, 2);
  assert.equal(currentOf([row(1)]), null, "公開した版が1つも無い");
  assert.equal(selfState([row(1)]).state, "none", "下書きだけなら、本人には『会社が準備中』");
  assert.equal(selfState([]).state, "none");
  assert.deepEqual(sortVersions(rows).map((r) => r.version), [3, 2, 1]);
});

ok("次の版番号は、いちばん大きい番号+1（版が飛んでも重ならない）", () => {
  assert.equal(nextVersion([]), 1);
  assert.equal(nextVersion([row(1), row(2)]), 3);
  assert.equal(nextVersion([row(1), row(5)]), 6);
});

ok("公開してよいのは、いちばん新しい版で、まだ公開していないものだけ", () => {
  const rows = [row(1, { published_at: PUB }), row(2), row(3)];
  assert.equal(canPublish(rows, "n3").ok, true);
  assert.equal(canPublish(rows, "n2").reason, "not_latest", "新しい下書き（第3版）がある。第2版は公開できない");
  assert.equal(canPublish(rows, "n1").reason, "not_latest");
  assert.equal(canPublish([row(1, { published_at: PUB })], "n1").reason, "already_published");
  assert.equal(canPublish(rows, "nope").reason, "not_latest");
});

ok("差し替えると、新しい版は未確認から始まる（確認済み → 未確認）。旧版の確認は、旧版に残る", () => {
  const v1 = row(1, { published_at: PUB, confirmed_at: CONF });
  assert.equal(selfState([v1]).state, "confirmed");
  assert.equal(selfState([v1]).confirmedAt, CONF);
  const v2draft = row(2);
  assert.equal(selfState([v1, v2draft]).state, "confirmed", "新しい版を足しただけ（未公開）なら、まだ前の版の確認済みのまま");
  const v2 = row(2, { published_at: "2026-10-05T01:00:00Z" });
  const s = selfState([v1, v2]);
  assert.equal(s.state, "unconfirmed", "新しい版を公開したら、未確認");
  assert.equal(s.version, 2);
  assert.equal(s.confirmedAt, null);
  assert.equal([v1, v2].find((r) => r.version === 1).confirmed_at, CONF, "旧版の確認の記録は残る");
});

ok("管理側の状態: 未登録 / 未公開 / 本人未確認 / 確認済み。差し替えの途中が分かる", () => {
  assert.equal(adminState([]).status, "none");
  assert.equal(adminState([row(1)]).status, "draft");
  assert.equal(adminState([row(1)]).statusLabel, "未公開");
  assert.equal(adminState([row(1, { published_at: PUB })]).status, "unconfirmed");
  assert.equal(adminState([row(1, { published_at: PUB })]).statusLabel, "本人未確認");
  assert.equal(adminState([row(1, { published_at: PUB, confirmed_at: CONF })]).status, "confirmed");
  const mid = adminState([row(1, { published_at: PUB, confirmed_at: CONF }), row(2)]);
  assert.equal(mid.status, "confirmed", "公開中の版（第1版）の状態");
  assert.equal(mid.replacing, true, "差し替えの途中（第2版が未公開）");
  assert.equal(mid.pending.version, 2);
  assert.equal(mid.current.version, 1);
  assert.equal(adminState([]).mode, "notice");
  assert.equal(adminState([], { esign: true }).mode, "esign");
});

ok("確認しました: 公開済みの最新版だけ。版が変わっていたら断る。二重押しは成功で、最初の日時を残す", () => {
  const rows = [row(1, { published_at: PUB }), row(2, { published_at: PUB })];
  assert.equal(canConfirm(rows, 2).ok, true);
  assert.equal(canConfirm(rows, 2).already, false);
  assert.equal(canConfirm(rows, 1).reason, "version_changed", "古い版は確認できない");
  assert.equal(canConfirm(rows, 3).reason, "version_changed");
  assert.equal(canConfirm([row(1)], 1).reason, "not_published", "下書きは確認できない");
  assert.equal(canConfirm([], 1).reason, "not_published");
  const done = [row(1, { published_at: PUB, confirmed_at: CONF })];
  const again = canConfirm(done, 1);
  assert.equal(again.ok, true);
  assert.equal(again.already, true, "二重押し");
  assert.equal(again.row.confirmed_at, CONF, "最初の確認日時のまま");
});

ok("電子署名の依頼があるあいだは、確認ボタンで締結にしない（確認できない・本人の状態は esign）", () => {
  const rows = [row(1, { published_at: PUB })];
  assert.equal(canConfirm(rows, 1, { esign: true }).reason, "esign_in_progress");
  assert.equal(selfState(rows, { esign: true }).state, "esign");
  assert.equal(selfState(rows, { esign: true }).mode, "esign");
});

ok("経営ハブ用の1行: 電子署名・作成依頼の流れにいる人は数えない。表が読めなければ unlinked", () => {
  assert.equal(listStatus(noticeFact([])), "none");
  assert.equal(listStatus(noticeFact([row(1)])), "draft");
  assert.equal(listStatus(noticeFact([row(1, { published_at: PUB })])), "unconfirmed");
  assert.equal(listStatus(noticeFact([row(1, { published_at: PUB, confirmed_at: CONF })])), "confirmed");
  assert.equal(listStatus(noticeFact([]), { esign: true }), "na");
  assert.equal(listStatus(noticeFact([]), { order: true }), "na", "社労士への作成依頼の流れにいる人");
  assert.equal(listStatus(noticeFact([row(1, { published_at: PUB })]), { order: true }), "unconfirmed", "通知書を公開したら、数える");
  assert.equal(listStatus(null), "unlinked");
});

console.log("\n— 入社手続きの段階判定（computeStage）—");

const base = { procedure: { status: "in_progress" }, items: [], consentsOk: true, orientationOk: true, profile: null };
const nf = (published, confirmed) => ({ published, confirmed, version: published ? 1 : null, hasAny: published });

ok("通知書を公開していない → これまでどおり（作成依頼がまだ）", () => {
  const s = computeStage({ ...base, notice: nf(false, false) });
  assert.equal(s.key, "conditions");
  assert.equal(computeStage({ ...base, notice: null }).key, "conditions", "表が無くても、これまでどおり");
});

ok("通知書を公開 → 本人の番（確認）。社労士への作成依頼は要らない", () => {
  const s = computeStage({ ...base, notice: nf(true, false) });
  assert.equal(s.key, "signing");
  assert.deepEqual(s.nextActors, ["employee"]);
  assert.deepEqual(s.blockers, ["労働条件通知書の確認がまだです"]);
});

ok("通知書を確認 → STEP2 が完了し、入社情報の入力へ進む", () => {
  const s = computeStage({ ...base, notice: nf(true, true) });
  assert.equal(s.key, "intake");
  assert.deepEqual(s.blockers, ["入社情報の入力がまだです"]);
});

ok("誓約書などの同意が残っていれば、通知書を確認しても、STEP2 は終わらない（これまでの決まりのまま）", () => {
  const s = computeStage({ ...base, consentsOk: false, notice: nf(true, true) });
  assert.equal(s.key, "signing");
  assert.deepEqual(s.blockers, ["誓約書・同意の確認がまだです"]);
});

ok("電子署名の依頼がある人: 通知書を確認しても、署名済みにならない。電子署名を優先する", () => {
  const sent = computeStage({ ...base, order: { status: "sent" }, sign: { status: "sent" }, notice: nf(true, true) });
  assert.equal(sent.key, "signing", "署名依頼が出ている（未署名）。通知書の確認だけでは進まない");
  assert.deepEqual(sent.blockers, ["労働条件通知書の締結がまだです"], "『確認』ではなく『締結』のまま");
  const x = stageFlags({ ...base, sign: { status: "sent" }, notice: nf(true, true) });
  assert.equal(x.signed, false);
  assert.equal(x.noticePath, false);
  const signed = computeStage({ ...base, order: { status: "signed" }, sign: { status: "signed" }, notice: nf(true, false) });
  assert.equal(signed.key, "intake", "電子署名が済んでいれば、通知書が未確認でも進む（電子署名の完了を優先する）");
});

ok("電子署名の依頼を取り消したら、通知書の確認が効く（取り消しは、無いものとして扱う）", () => {
  const s = computeStage({ ...base, sign: { status: "cancelled" }, notice: nf(true, true) });
  assert.equal(s.key, "intake");
});

ok("電子署名が済んだ人の判定は、通知書の有無で変わらない（これまでのテストの答えのまま）", () => {
  for (const notice of [null, nf(false, false), nf(true, false), nf(true, true)]) {
    const s = computeStage({ ...base, order: { status: "signed" }, sign: { status: "signed" }, notice });
    assert.equal(s.key, "intake");
  }
});

console.log("\n— 本人の6ステップ（mapSix）と、旧6STEP（computeSteps）—");

ok("本人の画面: 公開前『会社が準備中』→ 公開後『確認してください』→ 確認後 STEP2 完了。次にやること", () => {
  const six0 = mapSix({ facts: { ...base, notice: nf(false, false) }, audience: "self" });
  assert.equal(six0.steps[1].state, "current");
  assert.equal(six0.steps[1].note, "会社が労働条件通知書を準備しています");

  const six1 = mapSix({ facts: { ...base, notice: nf(true, false) }, audience: "self" });
  assert.equal(six1.steps[1].state, "current");
  assert.equal(six1.steps[1].actor, "employee");
  assert.equal(six1.steps[1].note, "労働条件通知書を確認してください");
  assert.equal(six1.next.label, "労働条件通知書の確認", "最上部の『次にやること』");
  assert.equal(six1.next.actor, "employee");

  const six2 = mapSix({ facts: { ...base, notice: nf(true, true) }, audience: "self" });
  assert.equal(six2.steps[1].state, "done");
  assert.equal(six2.steps[1].note, "労働条件通知書を確認済み");
  assert.equal(six2.next.label, "入社情報の入力");
});

ok("会社の画面（経営ハブ・入社準備の一覧）: 本人の確認待ちが分かる", () => {
  const six = mapSix({ facts: { ...base, notice: nf(true, false) }, audience: "company" });
  assert.equal(six.steps[1].note, "労働条件通知書の確認がまだです");
  assert.equal(six.next.label, "通知書の本人確認待ち");
  assert.deepEqual(six.waitingOn, ["employee"]);
});

ok("電子署名の依頼がある人の6ステップは、これまでどおり『締結』（通知書の確認では変わらない）", () => {
  const six = mapSix({ facts: { ...base, order: { status: "sent" }, sign: { status: "sent" }, notice: nf(true, true) }, audience: "self" });
  assert.equal(six.steps[1].state, "current");
  assert.equal(six.steps[1].note, "労働条件通知書と誓約書を確認して、締結してください");
  assert.equal(six.next.label, "労働条件通知書の締結");
});

ok("旧6STEP（入社手続きの画面）: 通知書だけの人は、確認で『本人契約』が終わる。電子署名の依頼がある人は、これまでどおり", () => {
  const f = { contracts: [], consents: [{ key: "pledge", title: "誓約書", agreed: true }], orientation: [], documents: [], profileStatus: null };
  const a = computeSteps({ ...f, notice: { published: true, confirmed: false } });
  assert.equal(a.steps.find((s) => s.key === "advisor_check").done, true, "公開した通知書は、社労士の確認の代わりになる");
  assert.equal(a.steps.find((s) => s.key === "contract").done, false);
  assert.equal(a.current, "contract");
  const b = computeSteps({ ...f, notice: { published: true, confirmed: true } });
  assert.equal(b.steps.find((s) => s.key === "contract").done, true);
  assert.equal(b.current, "profile");

  const withSign = { ...f, contracts: [{ id: "s1", title: "労働条件通知書", kind: "employment", status: "sent" }] };
  const c = computeSteps({ ...withSign, notice: { published: true, confirmed: true } });
  assert.equal(c.steps.find((s) => s.key === "contract").done, false, "電子署名が未署名なら、通知書を確認しても終わらない");
  const d = computeSteps({ ...withSign, contracts: [{ id: "s1", title: "労働条件通知書", kind: "employment", status: "signed" }], notice: null });
  assert.equal(d.steps.find((s) => s.key === "contract").done, true);
  const e = computeSteps({ ...f, notice: null });
  assert.equal(e.steps.find((s) => s.key === "advisor_check").done, false, "通知書も署名依頼も無ければ、これまでどおり");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
