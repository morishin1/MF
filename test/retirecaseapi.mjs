// 退職手続きの1画面（api/employees/retire-case.js・lib/retire-case.js・db/123）。
//
// ■ 何を守るテストか
//   1. 人事・管理者だけ。一般メンバー・他社・退職者本人は触れない
//   2. 退職日（社員名簿の left_on）・最終出勤日・担当者の保存。実在しない日付・最終出勤日 > 退職日を断る。
//      ほかの担当者の更新を上書きしない（競合）。保存したら変更前→変更後が履歴に出る
//   3. 日付の変更だけで、止まっている人を戻さない／使っている人をすぐ止めない（確認が要る）。在籍状態・アカウントは変えない
//   4. 発行済みの書類は書き換えず、再発行を案内するだけ
//   5. 貸与品は対象者のものをサーバーで絞る（ほかの人の 600 件があっても欠けない）。返却の確認で台帳の貸出先が外れ、
//      ほかの人へ貸し出された後も、何を返したかが残る
//   6. アカウント：読めない＝取得失敗（停止済みにしない）。手動のサービスは記録が無ければ未確認。停止済は担当者の確認
//   7. 本人の閲覧は本人の操作だけ（管理者のプレビューは数えない）。受領・署名は記録なし
//   8. 案内文：退職理由・社内メモ・管理者用 URL を入れない。退職日前の人に退職者ページの URL を案内しない。コピーは送信ではない
//   9. db/123 が未適用でも、画面は開く（その部分だけ準備未完了）。書き込みは 503
import assert from "node:assert/strict";
import { db, logs, current, rpcCalls, RC, api, setup, ymdOffset, TODAY, YESTERDAY, TOMORROW, NEXTWEEK, LASTWEEK } from "./_retireharness.mjs";

const res = () => { const r = { statusCode: 0, body: null, headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } }; return r; };
const call = async (req) => { const r = res(); await api({ headers: { authorization: "Bearer x", host: "gw.example.com" }, method: "GET", ...req }, r); return r; };
const get = (id) => call({ url: `/api/employees/retire-case?employeeId=${id}` });
const post = (body) => call({ method: "POST", url: "/api/employees/retire-case", body });
const as = (id) => { current.userId = `u-${id}`; };
let pass = 0, fail = 0;
const ok = async (name, fn) => { try { await fn(); pass++; console.log("  ok", name); } catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); } };

console.log("[1] 権限");
setup();
await ok("一般メンバーは 403", async () => { as("member"); const r = await get("e-soon"); assert.equal(r.statusCode, 403); });
await ok("他社の人は 404（存在も教えない）", async () => { as("hr"); const r = await get("e-other"); assert.equal(r.statusCode, 404); });
await ok("退職者本人は使えない（account_left）", async () => { as("left"); const r = await get("e-left"); assert.equal(r.statusCode, 403); });
await ok("書き込みも、一般メンバーは 403", async () => { as("member"); const r = await post({ action: "account", employeeId: "e-soon", service: "slack", state: "stopped" }); assert.equal(r.statusCode, 403); });

console.log("[2] 1画面の中身");
setup();
await ok("人事は、基本情報・次にやること・書類・アカウント・貸与品・案内文・履歴を1回で受け取る", async () => {
  as("hr"); const r = await get("e-soon");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.employee.leftOn, NEXTWEEK); assert.equal(r.body.employee.reasonLabel, "自己都合");
  assert.equal(r.body.employee.updatedAt, "2026-10-01T00:00:00.000001+00:00"); assert.ok(r.body.employee.caseUpdatedAt);
  assert.deepEqual(r.body.ready, { docs: true, case: true, cert: true });
  for (const k of ["next", "self", "docs", "accounts", "assets", "guide", "remind", "history", "staff"]) assert.ok(k in r.body, k);
});
await ok("貸与品は対象者のものだけ（ほかの人の 600 件があっても欠けない・混ざらない）", async () => {
  as("hr"); const r = await get("e-soon");
  assert.deepEqual(r.body.assets.map((a) => a.assetId).sort(), ["a-key", "a-pc"]);
  assert.ok(r.body.next.some((n) => n.text.includes("PC返却待ち（MacBook 01）")));
});
await ok("次にやること：未公開の書類・未発行の書類・未確認のサービス（実データから）", async () => {
  as("hr"); const r = await get("e-soon"); const t = r.body.next.map((n) => n.text);
  assert.ok(t.includes("源泉徴収票未公開")); assert.ok(t.includes("離職票未発行")); assert.ok(!t.some((x) => x.startsWith("退職証明書")));
  assert.ok(t.some((x) => x.startsWith("Slack") && x.includes("未確認")));
});
await ok("アカウント：退職日前は自動停止予定（翌日）。手動のサービスは記録が無ければ未確認（対象外と決めつけない）", async () => {
  as("hr"); const r = await get("e-soon"); const by = Object.fromEntries(r.body.accounts.map((a) => [a.key, a]));
  assert.equal(by.groupware.state, "scheduled"); assert.equal(by.groupware.auto, true); assert.equal(by.groupware.scheduledOn, ymdOffset(8));
  assert.equal(by.lms.state, "scheduled"); assert.equal(by.timecard.state, "scheduled"); assert.equal(by.accounting.state, "scheduled");
  for (const k of ["google", "slack", "github", "vercel"]) { assert.equal(by[k].state, "unknown", k); assert.equal(by[k].how, "manual"); }
  assert.equal(r.body.accounts.filter((a) => a.key === "google").length, 1, "Gmail と会社メールを別々に持たない");
});
await ok("アカウント：読めなかったら取得失敗（停止済みにしない）", async () => {
  db.failRead.add("profiles");
  try { as("hr"); const r = await get("e-soon"); const lms = r.body.accounts.find((a) => a.key === "lms"); assert.equal(lms.state, "error"); assert.ok(r.body.next.some((n) => n.text.includes("無限道場の状態を確認できません"))); }
  finally { db.failRead.clear(); }
});
await ok("アカウント：退職済みなのに利用中は警告。停止に失敗した記録があれば、そう出す", async () => {
  db.rows.gw_activity_log.push({ tenant_id: "t1", target: "employee:e-left", action: "employee.status", actor_id: null, ts: "2026-10-01T00:05:00Z",
    detail: { status: "left", auto: true, systems: { lms: { ok: false, detail: "x" }, timecard: { ok: true } } } });
  as("hr"); const r = await get("e-left"); const by = Object.fromEntries(r.body.accounts.map((a) => [a.key, a]));
  assert.equal(by.lms.state, "active"); assert.equal(by.lms.warn, true); assert.match(by.lms.note, /停止に失敗/);
  assert.equal(by.timecard.state, "stopped"); assert.equal(by.groupware.state, "stopped");
  assert.ok(r.body.history.some((h) => h.whoKind === "system" && h.text.includes("停止に失敗：無限道場")));
});
await ok("本人の閲覧は本人の操作だけ（管理者のプレビューは数えない）。受領・署名は記録なし（null）", async () => {
  setup();
  db.rows.gw_activity_log.push({ tenant_id: "t1", target: "employee:e-soon", action: "retire.admin_view", actor_id: "u-hr", ts: "2026-10-04T00:00:00Z", detail: { docId: "d-cert", kind: "certificate", version: 1 } });
  as("hr"); let r = await get("e-soon"); let cert = r.body.self.find((s) => s.kind === "certificate");
  assert.equal(cert.published, true); assert.equal(cert.openedAt, null); assert.equal(cert.received, null); assert.equal(cert.signed, null);
  db.rows.gw_activity_log.push({ tenant_id: "t1", target: "employee:e-soon", action: "retire.view", actor_id: "u-soon", ts: "2026-10-05T00:00:00Z", detail: { docId: "d-cert", kind: "certificate", version: 1 } });
  r = await get("e-soon"); cert = r.body.self.find((s) => s.kind === "certificate");
  assert.equal(cert.openedAt, "2026-10-05T00:00:00Z");
  const hist = r.body.history.map((h) => `${h.whoKind}:${h.text}`);
  assert.ok(hist.includes("self:書類を開いた（本人）：退職証明書（第1版）")); assert.ok(hist.includes("admin:書類をプレビュー（管理者）：退職証明書（第1版）"));
});
await ok("案内文：退職理由・社内メモ・管理者用 URL を入れない。退職日前の人には退職者ページではなく、いつもの入口", async () => {
  setup(); as("hr"); const r = await get("e-soon"); const g = r.body.guide;
  for (const bad of ["家庭の事情", "社内メモ", "自己都合", "/admin", "employeeId", "retire-case", "signed"]) assert.ok(!(g.email + g.slack).includes(bad), bad);
  assert.equal(g.url, "https://gw.example.com/"); assert.ok(!g.email.includes("/retiree/"));
  assert.ok(g.email.includes("退職証明書")); assert.ok(!g.email.includes("源泉徴収票"), "未公開の書類は案内しない");
  assert.ok(g.email.includes("退職届の提出")); assert.ok(!g.email.includes("社内の作業"), "本人の作業だけ");
  assert.ok(g.email.includes("PC：MacBook 01"));
  assert.ok(!/送信済/.test(JSON.stringify(r.body)), "コピーを送信済みとしない");
});
await ok("案内文：退職者として扱う人には、退職者ページの URL", async () => {
  as("hr"); const r = await get("e-past"); assert.equal(r.body.guide.url, "https://gw.example.com/retiree/");
});
await ok("再通知の文面は、未完了の項目だけ", async () => {
  as("hr"); const r = await get("e-soon");
  assert.ok(r.body.remind.email.includes("まだお済みでない")); assert.ok(r.body.remind.email.includes("退職届の提出")); assert.ok(!r.body.remind.email.includes("ご確認いただける書類"));
});

console.log("[3] 退職日・最終出勤日・担当者");
const saveDates = async (id, o) => { as("hr"); const g = await get(id); return post({ action: "dates", employeeId: id, expect: { employee: g.body.employee.updatedAt, case: g.body.employee.caseUpdatedAt }, ...o }); };
setup();
await ok("保存できる。在籍状態は変えず、アカウントにも触れない。変更前→変更後が履歴に出る", async () => {
  const before = JSON.stringify([db.rows.profiles, db.rows.tc_profiles, db.rows.memberships]);
  const r = await saveDates("e-soon", { leftOn: ymdOffset(10), lastWorkOn: ymdOffset(9), ownerId: "e-hr" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const e = db.rows.gw_employees.find((x) => x.id === "e-soon");
  assert.equal(e.left_on, ymdOffset(10)); assert.equal(e.status, "leaving");
  assert.equal(JSON.stringify([db.rows.profiles, db.rows.tc_profiles, db.rows.memberships]), before, "アカウントは変わらない");
  assert.deepEqual(r.body.reissue, ["退職証明書", "源泉徴収票"], "発行済みの書類は、再発行を案内する（書き換えない）");
  assert.equal(db.rows.gw_retire_docs.find((d) => d.id === "d-cert").state, "issued");
  const g = await get("e-soon");
  assert.equal(g.body.employee.lastWorkOn, ymdOffset(9)); assert.equal(g.body.employee.owner.name, "名前hr");
  assert.ok(g.body.history.some((h) => h.whoKind === "admin" && h.text.includes(`退職日 ${NEXTWEEK} → ${ymdOffset(10)}`)));
});
await ok("実在しない日付は断る（2月30日）", async () => { const r = await saveDates("e-soon", { leftOn: "2027-02-30" }); assert.equal(r.statusCode, 400); assert.equal(r.body.error, "invalid_date"); });
await ok("最終出勤日が退職日より後なら断る（説明つき）", async () => {
  const r = await saveDates("e-soon", { leftOn: ymdOffset(10), lastWorkOn: ymdOffset(11) }); assert.equal(r.statusCode, 400); assert.match(r.body.hint, /最終出勤日/);
});
await ok("ほかの担当者が先に更新していたら、上書きしない（409）", async () => {
  as("hr"); const g = await get("e-soon");
  db.rows.gw_employees.find((x) => x.id === "e-soon").updated_at = "2026-10-06T09:00:00.000009+00:00";   // 誰かが先に保存した
  const r = await post({ action: "dates", employeeId: "e-soon", leftOn: ymdOffset(20), expect: { employee: g.body.employee.updatedAt, case: g.body.employee.caseUpdatedAt } });
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, "conflict");
  assert.equal(db.rows.gw_employees.find((x) => x.id === "e-soon").left_on, ymdOffset(10));
});
await ok("止まっている人の退職日を先に動かして、元に戻すことはできない（would_reopen）", async () => {
  const r = await saveDates("e-past", { leftOn: NEXTWEEK }); assert.equal(r.statusCode, 409); assert.equal(r.body.error, "would_reopen");
  assert.equal(db.rows.gw_employees.find((x) => x.id === "e-past").left_on, LASTWEEK);
});
await ok("使っている人の退職日を過去にするときは、確認が要る（すぐ止まるため）", async () => {
  let r = await saveDates("e-noday", { leftOn: YESTERDAY }); assert.equal(r.statusCode, 409); assert.equal(r.body.error, "would_stop_now");
  assert.equal(db.rows.gw_employees.find((x) => x.id === "e-noday").left_on, null);
  r = await saveDates("e-noday", { leftOn: YESTERDAY, confirmImmediate: true }); assert.equal(r.statusCode, 200);
  assert.equal(db.rows.gw_employees.find((x) => x.id === "e-noday").status, "leaving", "状態は変えない（確定は自動処理・メンバー管理）");
});
await ok("退職済みの人の日付の訂正はできる（止まったまま）。在籍中の人はここでは扱わない", async () => {
  let r = await saveDates("e-left", { leftOn: ymdOffset(-8) }); assert.equal(r.statusCode, 200);
  r = await saveDates("e-left", { leftOn: null }); assert.equal(r.statusCode, 400);
  r = await saveDates("e-member", { leftOn: NEXTWEEK }); assert.equal(r.statusCode, 409); assert.equal(r.body.error, "not_retiring");
});

console.log("[4] 貸与品");
setup();
await ok("返却を依頼（返却予定日）。台帳の在庫の状態は変えない", async () => {
  as("hr"); const r = await post({ action: "asset_request", employeeId: "e-soon", assetId: "a-pc", dueOn: NEXTWEEK });
  assert.equal(r.statusCode, 200); assert.equal(db.rows.gw_assets.find((a) => a.id === "a-pc").status, "assigned");
  const g = await get("e-soon"); const pc = g.body.assets.find((a) => a.assetId === "a-pc");
  assert.equal(pc.state, "requested"); assert.equal(pc.dueOn, NEXTWEEK);
});
await ok("返却を確認：台帳の貸出先が外れて在庫へ。返却の記録は残る", async () => {
  as("hr"); const r = await post({ action: "asset_return", employeeId: "e-soon", assetId: "a-pc" });
  assert.equal(r.statusCode, 200);
  const a = db.rows.gw_assets.find((x) => x.id === "a-pc"); assert.equal(a.assigned_to, null); assert.equal(a.status, "in_stock"); assert.equal(a.returned_on, TODAY);
  const g = await get("e-soon"); const pc = g.body.assets.find((x) => x.assetId === "a-pc");
  assert.equal(pc.state, "returned"); assert.ok(pc.returnedAt); assert.equal(pc.name, "MacBook 01");
  assert.ok(!g.body.next.some((n) => n.text.includes("MacBook")));
  assert.ok(g.body.history.some((h) => h.text === "返却を確認：MacBook 01"));
});
await ok("次の人へ貸し出された後も、この退職で何を返したか分かる", async () => {
  Object.assign(db.rows.gw_assets.find((x) => x.id === "a-pc"), { assigned_to: "e-member", status: "assigned", name: "MacBook 01（改名）" });
  as("hr"); const g = await get("e-soon"); const pc = g.body.assets.find((x) => x.assetId === "a-pc");
  assert.equal(pc.state, "returned"); assert.equal(pc.name, "MacBook 01");
});
await ok("返却済みをもう一度・ほかの人の貸与品は断る", async () => {
  as("hr");
  let r = await post({ action: "asset_return", employeeId: "e-soon", assetId: "a-pc" }); assert.equal(r.statusCode, 409);
  r = await post({ action: "asset_return", employeeId: "e-soon", assetId: "a-mine" }); assert.equal(r.statusCode, 409); assert.equal(r.body.error, "not_assigned");
  assert.equal(db.rows.gw_assets.find((x) => x.id === "a-mine").assigned_to, "e-member");
});

console.log("[5] サービス別アカウント（担当者の記録）");
setup();
await ok("自動のサービス（無限道場など）は、ここでは記録できない", async () => {
  as("hr"); const r = await post({ action: "account", employeeId: "e-soon", service: "lms", state: "stopped" }); assert.equal(r.statusCode, 400);
});
await ok("停止予定は日付が要る。停止済は「担当者による停止確認」と日時・担当者が残る", async () => {
  as("hr");
  let r = await post({ action: "account", employeeId: "e-soon", service: "slack", state: "scheduled" }); assert.equal(r.statusCode, 400);
  r = await post({ action: "account", employeeId: "e-soon", service: "slack", state: "scheduled", scheduledOn: NEXTWEEK }); assert.equal(r.statusCode, 200);
  let g = await get("e-soon"); let s = g.body.accounts.find((a) => a.key === "slack");
  assert.equal(s.state, "scheduled"); assert.equal(s.scheduledOn, NEXTWEEK);
  assert.ok(g.body.next.some((n) => n.text.includes("Slackの停止が未確認") && n.text.includes("手動対応")), "手動の予定は自動停止と書かない");
  r = await post({ action: "account", employeeId: "e-soon", service: "slack", state: "stopped" }); assert.equal(r.statusCode, 200);
  g = await get("e-soon"); s = g.body.accounts.find((a) => a.key === "slack");
  assert.equal(s.state, "stopped"); assert.ok(s.stoppedAt); assert.equal(s.stoppedBy, "名前hr"); assert.equal(s.confirmLabel, "担当者による停止確認");
  assert.ok(g.body.history.some((h) => h.text.includes("Slack：停止予定 → 停止済（担当者による停止確認）")));
});
await ok("一部だけ止めた：止めたサービスだけ停止済。ほかは未確認のまま（全部完了にしない）", async () => {
  as("hr"); const g = await get("e-soon"); const by = Object.fromEntries(g.body.accounts.map((a) => [a.key, a.state]));
  assert.equal(by.slack, "stopped"); assert.equal(by.google, "unknown"); assert.equal(by.github, "unknown");
});

console.log("[6] db/123 が未適用");
setup();
for (const t of ["gw_retire_events", "gw_retire_asset_returns", "gw_retire_accounts"]) db.absent.add(t);
await ok("画面は開く（その部分だけ準備未完了）。手動のサービスは取得失敗", async () => {
  as("hr"); const r = await get("e-soon"); assert.equal(r.statusCode, 200); assert.equal(r.body.ready.case, false); assert.equal(r.body.ready.docs, true);
  assert.equal(r.body.accounts.find((a) => a.key === "slack").state, "error");
});
await ok("書き込みは 503（SQL の案内）", async () => {
  as("hr"); let r = await post({ action: "account", employeeId: "e-soon", service: "slack", state: "stopped" }); assert.equal(r.statusCode, 503);
  r = await saveDates("e-soon", { leftOn: ymdOffset(12) }); assert.equal(r.statusCode, 503); assert.match(r.body.message, /db\/123/);
  assert.equal(db.rows.gw_employees.find((x) => x.id === "e-soon").left_on, NEXTWEEK, "日付も変わらない");
});

console.log("[7] lib/retire-case.js");
await ok("isRealDate", () => { assert.ok(RC.isRealDate("2028-02-29")); assert.ok(!RC.isRealDate("2027-02-29")); assert.ok(!RC.isRealDate("2026-13-01")); assert.ok(!RC.isRealDate("x")); });
await ok("checkDates：日付を空にして最終出勤日だけは不可", () => {
  assert.equal(RC.checkDates({ status: "leaving", left_on: NEXTWEEK }, { leftOn: null, lastWorkOn: TODAY }, TODAY).error, "left_on_required");
});

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
