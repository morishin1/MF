// /api/office/timesheet（勤務表の受領・AI読取・確認・確定）を、偽の Supabase で通す。
//
// ■ 何を守るテストか
//
//   1. 入れるのは 経営者・責任者・経理 だけ。他は 403（表にも Storage にも触れない）。二段階認証（MFA）は要求しない
//   2. ファイル：置き場所は、サーバーが決めた形だけ。形式・大きさ・sha256 を確かめて登録する。
//      同じファイルは二重に登録しない／別の月・人に出ていたら承知のうえで
//   3. AI読取は下書きを作るだけ。確認済み・確定にならない。失敗は理由つきで、手入力に進める
//   4. 人の入力は、全部検査してから書く（1つでも読めなければ何も保存しない）。直した日は確認済みになる
//   5. 確定の条件（不明な日0・要確認は確認済み・合計不一致は承知のうえで）。確定・取消し・差し戻しで、既存の5つの印が同期する
//   6. 操作は履歴に残す。書き込みは service_role だけ（userClient で書くと RLS で落ちる）
//   7. ファイルの置き場所・単価・精算条件を、応答に含めない
//
// 判定関数（canAccessOffice）は本物。AI は、本物の readTimesheet に偽の client を差し込む
import assert from "node:assert/strict";
import {
  atRoot, mem, ctl, asked, logged, ai, call, OWNER, MANAGER, FINANCE, DENIED, P,
  uid, T1, T2, E_PP, E_BP, E_X, C_PP, C_BP, C_X, PC_1,
} from "./_officeharness.mjs";

const { default: sheetApi } = await import(atRoot("api/office/timesheet.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const M = "2026-10";     // 10/1 は木曜。10/12 は祝日。24:00 = 1440分
const BUCKET = "billing-submissions";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 7)]);
const PDF2 = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 9)]);
const sha = async (b) => (await import("node:crypto")).createHash("sha256").update(b).digest("hex");

const get = (contract = C_PP, month = M) => call(sheetApi, `/api/office/timesheet?contract=${contract}&month=${month}`);
const post = (action, extra = {}, o = {}) => call(sheetApi, "/api/office/timesheet", {
  method: "POST", body: { action, siteContractId: C_PP, month: M, ...extra }, ...o,
});
const rows = (t) => mem.rows[t] || [];
const sheetRow = () => rows("gw_timesheets").find((r) => r.employee_id === E_PP && r.target_month === M);
const dayRow = (d) => rows("gw_timesheet_days").find((r) => r.work_date === `${M}-${String(d).padStart(2, "0")}`);
const progress = () => rows("gw_billing_progress").find((r) => r.employee_id === E_PP && r.billing_month === M);
const events = (kind) => rows("gw_office_events").filter((e) => !kind || e.kind === kind);

function setup() {
  mem.reset();
  ctl.who = OWNER; ctl.aal = "aal2";
  ai.calls.length = 0; ai.reply = null; asked.length = 0; logged.length = 0;
  mem.rows.gw_employees = [
    { id: E_PP, tenant_id: T1, display_name: "田中 太郎", department: "常駐部", employee_kind: "proper", partner_company_id: null, note: "人事メモ" },
    { id: E_BP, tenant_id: T1, display_name: "鈴木 花子", department: null, employee_kind: "bp", partner_company_id: PC_1, note: null },
    { id: E_X, tenant_id: T2, display_name: "他社の人", employee_kind: "proper", partner_company_id: null },
  ];
  mem.rows.gw_site_contracts = [
    { id: C_PP, tenant_id: T1, employee_id: E_PP, engagement_kind: "pp", site_company: "顧客A社", prime_company: null,
      period_from: "2026-04-01", period_to: null, renewal_status: "confirmed",
      unit_price: 700000, unit_price_type: "月額", settlement_condition: "140h〜180h", note: "契約メモ" },
    { id: C_BP, tenant_id: T1, employee_id: E_BP, engagement_kind: "bp", site_company: "顧客B社", prime_company: null,
      period_from: "2026-04-01", period_to: null, renewal_status: "pending" },
    { id: C_X, tenant_id: T2, employee_id: E_X, engagement_kind: "pp", site_company: "他社の客先", period_from: "2026-01-01", period_to: null, renewal_status: "pending" },
  ];
}

// ファイルを1件、届いた状態にする（外部提出フォームの行のように、sha256・verified_at は空）
let seq = 100;
function seedFile({ contract = C_PP, employee = E_PP, month = M, bytes = PDF, tenant = T1, hash = false, put = true } = {}) {
  const id = uid(++seq);
  const path = `${tenant}/${employee}/${id}.pdf`;
  mem.rows.gw_submissions = [...rows("gw_submissions"), {
    id, tenant_id: tenant, employee_id: employee, site_contract_id: contract, target_month: month, kind: "timesheet",
    file_name: "田中_10月.pdf", mime_type: "application/pdf", size_bytes: bytes.length, storage_path: path,
    submitted_at: `2026-11-0${(seq % 8) + 1}T00:00:00Z`, source: "form",
    sha256: null, verified_at: null,
  }];
  if (hash) { const r = rows("gw_submissions").at(-1); r.sha256 = hashSync(bytes); r.verified_at = "2026-11-01T00:00:00Z"; }
  if (put) mem.put(BUCKET, path, bytes);
  return id;
}
import nodeCrypto from "node:crypto";
const hashSync = (b) => nodeCrypto.createHash("sha256").update(b).digest("hex");

// AI の返答：10月の勤務表。1・2・5日が 9:00〜18:00・休憩1:00・実働 8:00、ほかは「公休」と書かれた休み
const dayRowAi = (d, o = {}) => (
  [1, 2, 5].includes(d)
    ? { day: d, kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "high", ...o }
    : { day: d, kind: "off", blank: false, note: "公休", confidence: "high", ...o });
const sheetInput = (over = {}, dayOver = {}) => ({
  sheet_month: M, employee_name: "田中 太郎", total_worked: "24:00", break_column: "present",
  days: Array.from({ length: 31 }, (_, i) => dayRowAi(i + 1, dayOver[i + 1] || {})), ...over,
});
const toolReply = (input, extra = {}) => ({
  model: "claude-test-1", stop_reason: "tool_use",
  content: [{ type: "tool_use", id: "tu1", name: "read_timesheet", input }],
  usage: { input_tokens: 1000, output_tokens: 700 }, ...extra,
});
const withAi = (input, extra) => { ai.reply = toolReply(input, extra); };

// 読み取り済みの下書きを作る
async function readIt(input = sheetInput(), extra = {}) {
  seedFile();
  withAi(input);
  return post("read", extra);
}

console.log("— 入れる人：経営者・責任者・経理だけ。二段階認証（MFA）は要求しない —");

for (const [label, p] of [["経営者", OWNER], ["責任者", MANAGER], ["経理", FINANCE]]) {
  await ok(`${label} は見られる`, async () => {
    setup(); ctl.who = p;
    const r = await get();
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    assert.equal(r.headers["cache-control"], "no-store");
  });
}
const ACTIONS = ["upload", "attach", "read", "blank", "save", "bulk", "confirm", "reopen", "return", "progress"];
for (const [label, p] of Object.entries(DENIED)) {
  await ok(`${label} は GET も、すべての操作も 403。表・Storage に触れず、ログも残さない`, async () => {
    setup(); ctl.who = p;
    assert.equal((await get()).statusCode, 403);
    for (const a of ACTIONS) {
      const r = await post(a, { submissionId: uid(5), days: [{ workDate: `${M}-01`, break: "1:00" }], op: "review_flagged", reason: "x" });
      assert.equal(r.statusCode, 403, a);
      assert.equal(r.body.error, "forbidden", a);
    }
    assert.equal(asked.length, 0, "1つも読んでいない");
    assert.equal(mem.state.log.length, 0, "1つも書いていない");
    assert.equal(mem.uploadUrls.length, 0);
    assert.equal(logged.length, 0);
    assert.equal(ai.calls.length, 0, "AI を呼んでいない");
  });
}
await ok("MFA 未登録・aal1 でも通る：表示・アップロード・AI読取・修正・確定・確定の取消し・差し戻し（どれも 403 mfa_required にならない）", async () => {
  for (const [label, p] of [["経営者", OWNER], ["責任者", MANAGER], ["経理", FINANCE]]) {
    setup(); ctl.who = { ...p, factors: [] }; ctl.aal = "aal1";
    assert.equal((await get()).statusCode, 200, `${label} GET`);
    assert.equal((await post("upload", { mimeType: "application/pdf", sizeBytes: PDF.length })).statusCode, 200, `${label} upload`);
    const rd = await readIt();
    assert.equal(rd.statusCode, 200, `${label} read: ${JSON.stringify(rd.body)}`);
    assert.equal((await post("save", { days: [{ workDate: `${M}-01`, note: "確認" }] })).statusCode, 200, `${label} save`);
    assert.equal((await post("confirm")).statusCode, 200, `${label} confirm`);
    assert.equal((await post("reopen", { reason: "テスト" })).statusCode, 200, `${label} reopen`);
    assert.equal((await post("return", { reason: "テスト" })).statusCode, 200, `${label} return`);
  }
});
await ok("権限のない人は、aal1 でも aal2 でも 403 forbidden（MFA を求めない）", async () => {
  for (const aal of ["aal1", "aal2"]) {
    setup(); ctl.who = P(["sales"]);
    const r = await call(sheetApi, `/api/office/timesheet?contract=${C_PP}&month=${M}`, { aal });
    assert.equal(r.body.error, "forbidden", aal);
  }
});
await ok("GET・POST 以外は 405", async () => {
  setup();
  assert.equal((await call(sheetApi, "/api/office/timesheet", { method: "DELETE" })).statusCode, 405);
});

console.log("\n— 対象の指定 —");

await ok("契約・月が不正、他社の契約は 404／400（他社のデータを返さない）", async () => {
  setup();
  assert.equal((await get("not-a-uuid")).statusCode, 400);
  assert.equal((await get(C_PP, "2026-13")).statusCode, 400);
  assert.equal((await get(uid(777))).statusCode, 404, "存在しない契約");
  const x = await get(C_X);
  assert.equal(x.statusCode, 404, "他社の契約");
  assert.equal(x.body.error, "contract_not_found", "契約の時点で止める（API 自身が会社で絞る。DB の RLS は、その下の二重の備え）");
  assert.ok(!JSON.stringify(x.body).includes("他社"));
  assert.equal((await post("read", { siteContractId: C_X })).statusCode, 404);
  assert.equal(ai.calls.length, 0);
});
await ok("知らない操作は 400", async () => {
  setup();
  assert.equal((await post("delete_everything")).statusCode, 400);
});

console.log("\n— 提出状態 —");

await ok("何も無い → none（未提出）。ファイルだけ → submitted（提出済み・未読取）", async () => {
  setup();
  const a = await get();
  assert.equal(a.body.state, "none");
  assert.equal(a.body.stateLabel, "未提出");
  assert.equal(a.body.timesheet, null);
  assert.deepEqual(a.body.days, []);
  seedFile();
  const b = await get();
  assert.equal(b.body.state, "submitted");
  assert.equal(b.body.files.length, 1);
  assert.equal(b.body.files[0].verified, true, "外部フォームの行は、開いたときに中身を確かめる");
  assert.equal(b.body.files[0].dup.state, "unique");
  assert.equal(b.body.contract.employeeName, "田中 太郎");
});
await ok("他の月・他の人のファイルは、この月のファイルに混ざらない", async () => {
  setup();
  seedFile({ month: "2026-09" }); seedFile({ contract: C_BP, employee: E_BP });
  assert.equal((await get()).body.files.length, 0);
});
await ok("応答に、ファイルの置き場所・単価・精算条件・メモを含めない（契約に入っていても）", async () => {
  setup(); seedFile();
  const text = JSON.stringify((await get()).body);
  for (const w of ["storage_path", `${T1}/${E_PP}`, "unit_price", "settlement_condition", "140h", "契約メモ", "人事メモ", "700000"]) {
    assert.ok(!text.includes(w), `${w} が応答に入っている`);
  }
  // 契約・名簿・進捗から、単価・精算条件・メモを読んでいない（勤務表の日別の note 列は別物）
  const cols = asked.filter((s) => ["gw_site_contracts", "gw_employees", "gw_billing_progress"].includes(s.table)).map((s) => s.cols).join(",");
  assert.ok(!/unit_price|settlement_condition|\bnote\b/.test(cols), `読んでいる: ${cols}`);
});
await ok("Phase 3 の表が未作成なら 503 not_ready（SQL の案内つき）", async () => {
  setup();
  mem.state.missing = "gw_timesheets";
  const r = await get();
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, "not_ready");
  assert.match(r.body.message, /db\/107_office_timesheets\.sql/);
});

console.log("\n— ファイルの受け付け（upload → attach） —");

await ok("upload：置き場所は <tenant>/<人>/<uuid>.pdf。DB の行は、まだ作らない", async () => {
  setup();
  const r = await post("upload", { mimeType: "application/pdf", sizeBytes: 1000, filename: "a.pdf" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.match(r.body.path, new RegExp(`^${T1}/${E_PP}/[0-9a-f-]{36}\\.pdf$`));
  assert.equal(r.body.path, `${T1}/${E_PP}/${r.body.submissionId}.pdf`);
  assert.ok(r.body.uploadUrl && r.body.token);
  assert.equal(rows("gw_submissions").length, 0);
  assert.deepEqual(mem.uploadUrls, [{ bucket: BUCKET, path: r.body.path }]);
});
await ok("upload：PDF・JPEG・PNG 以外・空・10MB超は断る（置き場所を出さない）", async () => {
  setup();
  for (const b of [{ mimeType: "application/zip", sizeBytes: 10 }, { mimeType: "text/html", sizeBytes: 10 }, { mimeType: "application/pdf", sizeBytes: 0 },
    { mimeType: "application/pdf", sizeBytes: "x" }, { mimeType: "application/pdf", sizeBytes: 10 * 1024 * 1024 + 1 }]) {
    assert.equal((await post("upload", b)).statusCode, 400, JSON.stringify(b));
  }
  assert.equal(mem.uploadUrls.length, 0);
});
await ok("attach：形式・大きさ・sha256 を確かめて登録。source=office・誰が上げたか・受領の印・履歴", async () => {
  setup();
  const up = (await post("upload", { mimeType: "application/pdf", sizeBytes: PDF.length })).body;
  mem.put(BUCKET, up.path, PDF);
  const r = await post("attach", { submissionId: up.submissionId, filename: "田中_10月勤務表.pdf" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const row = rows("gw_submissions")[0];
  assert.equal(row.id, up.submissionId);
  assert.equal(row.sha256, await sha(PDF));
  assert.ok(row.verified_at);
  assert.equal(row.source, "office");
  assert.equal(row.uploaded_by, "u-1");
  assert.equal(row.kind, "timesheet");
  assert.equal(row.target_month, M);
  assert.equal(row.size_bytes, PDF.length);
  assert.equal(row.storage_path, up.path);
  assert.equal(row.mime_type, "application/pdf");
  assert.equal(r.body.state, "submitted");
  assert.equal(r.body.files[0].verified, true);
  // 既存の印：勤務表受領
  assert.equal(progress().timesheet_received, true);
  assert.ok(progress().timesheet_received_at);
  assert.equal(progress().work_confirmed, false);
  assert.deepEqual(events("timesheet.upload").map((e) => [e.employee_id, e.billing_month, e.actor_id]), [[E_PP, M, "u-1"]]);
  assert.deepEqual(events("timesheet.upload")[0].detail.marks, ["timesheet_received"]);
  assert.ok(logged.some((l) => l.action === "office.timesheet.upload"));
});
await ok("attach：進捗の行が既にあれば、更新する（行を増やさない。ほかの印は触らない）", async () => {
  setup();
  mem.rows.gw_billing_progress = [{ id: uid(500), tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, billing_month: M,
    timesheet_received: false, work_confirmed: false, board_created: true, sent: false, bp_invoice_received: false }];
  const up = (await post("upload", { mimeType: "application/pdf", sizeBytes: 10 })).body;
  mem.put(BUCKET, up.path, PDF);
  await post("attach", { submissionId: up.submissionId, filename: "a.pdf" });
  assert.equal(rows("gw_billing_progress").length, 1);
  assert.equal(progress().timesheet_received, true);
  assert.equal(progress().board_created, true, "ほかの印はそのまま");
});
await ok("attach：PDF・画像でない中身は断り、置かれたファイルを消す。DB に行を作らない", async () => {
  setup();
  const up = (await post("upload", { mimeType: "application/pdf", sizeBytes: 10 })).body;
  mem.put(BUCKET, up.path, Buffer.from("これは勤務表ではありません"));
  const r = await post("attach", { submissionId: up.submissionId, filename: "a.pdf" });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "unsupported_file");
  assert.equal(rows("gw_submissions").length, 0);
  assert.ok(mem.removed.some((x) => x.path === up.path), "置かれたファイルを消した");
  assert.equal(progress(), undefined, "印も立てない");
});
await ok("attach：10MB を超える実体は断って消す。置かれていなければ no_file", async () => {
  setup();
  const up = (await post("upload", { mimeType: "application/pdf", sizeBytes: 10 })).body;
  mem.put(BUCKET, up.path, Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]));
  const r = await post("attach", { submissionId: up.submissionId, filename: "a.pdf" });
  assert.equal(r.body.error, "file_too_large");
  assert.ok(mem.removed.length === 1);
  const none = await post("attach", { submissionId: uid(900), filename: "a.pdf" });
  assert.equal(none.statusCode, 400);
  assert.equal(none.body.error, "no_file");
  assert.equal((await post("attach", { submissionId: "zzz" })).statusCode, 400);
});
await ok("attach：他社・他人の置き場所は指せない（パスはサーバーが決める）", async () => {
  setup();
  const id = uid(901);
  mem.put(BUCKET, `${T2}/${E_X}/${id}.pdf`, PDF);            // 他社の場所に、同じ id で置かれている
  mem.put(BUCKET, `${T1}/${E_BP}/${id}.pdf`, PDF);           // 同じ会社の別の人の場所
  const r = await post("attach", { submissionId: id, filename: "a.pdf" });
  assert.equal(r.body.error, "no_file", "この人（田中）の場所には無い");
  assert.equal(rows("gw_submissions").length, 0);
});
await ok("attach：登録済みの submissionId を再送しても、二重に作らない（already）", async () => {
  setup();
  const up = (await post("upload", { mimeType: "application/pdf", sizeBytes: 10 })).body;
  mem.put(BUCKET, up.path, PDF);
  await post("attach", { submissionId: up.submissionId, filename: "a.pdf" });
  const again = await post("attach", { submissionId: up.submissionId, filename: "a.pdf" });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.already, true);
  assert.equal(rows("gw_submissions").length, 1);
  assert.equal(events("timesheet.upload").length, 1);
});
await ok("同じファイルを、同じ月・人・契約にもう一度 → 409 duplicate。登録せず、置かれたファイルを消す", async () => {
  setup();
  const a = (await post("upload", { mimeType: "application/pdf", sizeBytes: 10 })).body;
  mem.put(BUCKET, a.path, PDF);
  await post("attach", { submissionId: a.submissionId, filename: "a.pdf" });
  const b = (await post("upload", { mimeType: "application/pdf", sizeBytes: 10 })).body;
  mem.put(BUCKET, b.path, PDF);            // 中身は同じ
  const r = await post("attach", { submissionId: b.submissionId, filename: "a(1).pdf" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "duplicate");
  assert.equal(r.body.existingId, a.submissionId);
  assert.equal(rows("gw_submissions").length, 1);
  assert.ok(mem.removed.some((x) => x.path === b.path));
  assert.equal(events("timesheet.upload").length, 1);
});
await ok("同じファイルが別の人・別の月にもある → 409 duplicate_other（ファイルは残す）。承知して再送すれば登録し、両方に印", async () => {
  setup();
  seedFile({ contract: C_BP, employee: E_BP, hash: true });           // 鈴木さんの10月として出ている
  const up = (await post("upload", { mimeType: "application/pdf", sizeBytes: 10 })).body;   // 田中さんの10月として出そうとする
  mem.put(BUCKET, up.path, PDF);
  const r = await post("attach", { submissionId: up.submissionId, filename: "a.pdf" });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "duplicate_other");
  assert.equal(r.body.count, 1);
  assert.equal(rows("gw_submissions").length, 1, "まだ登録しない");
  assert.ok(mem.storageFiles.has(`${BUCKET}/${up.path}`), "ファイルは残る（アップロードし直さずに続けられる）");
  assert.equal(mem.removed.length, 0);

  const ok2 = await post("attach", { submissionId: up.submissionId, filename: "a.pdf", allowDuplicate: true });
  assert.equal(ok2.statusCode, 200, JSON.stringify(ok2.body));
  assert.equal(rows("gw_submissions").length, 2);
  assert.equal(ok2.body.files[0].dup.state, "cross");
  assert.equal(ok2.body.files[0].dup.crossCount, 1);
  assert.match(ok2.body.files[0].dup.label, /別の月・別の人/);
  assert.equal(events("timesheet.upload")[0].detail.duplicateOther, 1);
});
await ok("外部フォームの二重提出（sha256 が空）は、画面を開いたとき（AI読取の前）に中身を確かめて検知する", async () => {
  setup();
  seedFile(); seedFile();
  assert.ok(rows("gw_submissions").every((s) => !s.sha256), "届いた時点では、どちらも未確認");
  const r = await get();
  assert.equal(ai.calls.length, 0, "AI は呼んでいない（費用がかからない）");
  assert.deepEqual(r.body.files.map((f) => f.dup.state).sort(), ["duplicate", "original"]);
  assert.ok(r.body.files.every((f) => f.verified));
  assert.ok(rows("gw_submissions").every((s) => s.sha256 === hashSync(PDF) && s.verified_at));
});
await ok("外部フォームの別々のファイルは、それぞれ unique。別の人に同じ中身があれば cross（開いた時点で分かる）", async () => {
  setup();
  seedFile(); seedFile({ bytes: PDF2 });
  assert.deepEqual((await get()).body.files.map((f) => f.dup.state), ["unique", "unique"]);
  setup();
  seedFile(); seedFile({ contract: C_BP, employee: E_BP });          // 鈴木さんの10月として、同じ中身
  const g = await get();
  assert.equal(g.body.files[0].dup.state, "cross", "開いたとき、同じ月の他の人のファイルも確かめるので、流用がすぐ分かる");
  assert.equal(g.body.files[0].dup.crossCount, 1);
  assert.equal((await get(C_BP)).body.files[0].dup.state, "cross", "相手側にも印が付く");
});
await ok("確かめられないファイル（置かれていない・PDF／画像でない）は、未確認のまま。画面は開く", async () => {
  setup();
  seedFile({ put: false }); seedFile({ bytes: Buffer.from("ただの文字") });
  const r = await get();
  assert.equal(r.statusCode, 200);
  assert.ok(r.body.files.every((f) => !f.verified && f.dup.state === "unchecked"));
  assert.ok(rows("gw_submissions").every((s) => !s.sha256));
});
await ok("確かめるのは、この月の勤務表だけ（他の月のファイルは触らない）。1回に10件まで。確かめ済みは読み直さない", async () => {
  setup();
  seedFile({ month: "2026-09" });
  for (let i = 0; i < 12; i++) seedFile({ bytes: Buffer.concat([PDF, Buffer.from([i])]) });
  const before = mem.state.log.filter((l) => l.table === "gw_submissions" && l.op === "update").length;
  await get();
  const verified = rows("gw_submissions").filter((s) => s.sha256);
  assert.equal(verified.length, 10, "10件まで");
  assert.ok(!rows("gw_submissions").find((s) => s.target_month === "2026-09").sha256, "他の月は確かめない");
  await get();
  assert.equal(rows("gw_submissions").filter((s) => s.sha256).length, 12, "残りは次に開いたときに確かめる");
  const n = mem.state.log.filter((l) => l.table === "gw_submissions" && l.op === "update").length - before;
  assert.equal(n, 12, "確かめ済みの行を、もう一度書かない");
});

console.log("\n— AI読取（下書きを作るだけ） —");

await ok("読取：31日ぶんの下書き（draft）。確認済み・確定にならない。合計・要確認は、日別から計算して保存", async () => {
  setup();
  const r = await readIt();
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, "draft");
  assert.equal(r.body.stateLabel, "確認待ち");
  assert.equal(r.body.days.length, 31);
  const d1 = r.body.days.find((d) => d.workDate === `${M}-01`);
  assert.deepEqual([d1.kind, d1.startMin, d1.endMin, d1.breakMin, d1.sheetWorkedMin, d1.worked], ["work", 540, 1080, 60, 480, 480]);
  assert.deepEqual(d1.flags, []);
  assert.equal(d1.reviewed, false);
  assert.equal(r.body.days.find((d) => d.workDate === `${M}-03`).kind, "off");
  assert.equal(r.body.summary.totalMinutes, 1440);
  assert.equal(r.body.summary.workDays, 3);
  assert.equal(r.body.summary.unresolvedCount, 0);
  assert.equal(r.body.summary.totalCheck.status, "match");
  assert.equal(r.body.confirm.ok, true, "条件は満たしているが、確定は人の操作");
  assert.equal(r.body.timesheet.status, "draft");
  assert.equal(r.body.timesheet.readState, "ok");
  assert.equal(r.body.timesheet.nameMatch, true);
  assert.equal(r.body.timesheet.confirmedAt, null);

  const t = sheetRow();
  assert.equal(t.status, "draft");
  assert.equal(t.confirmed_at ?? null, null);
  assert.equal(t.ai_model, "claude-test-1");
  assert.equal(t.total_minutes, 1440);
  assert.equal(t.sheet_total_min, 1440);
  assert.equal(rows("gw_timesheet_days").length, 31);
  assert.ok(rows("gw_timesheet_days").every((d) => d.source === "ai" && !d.reviewed_at && d.edited === false && d.ai_snapshot));
  // 確認・確定の印は、ここでは立たない
  assert.equal(progress()?.work_confirmed ?? false, false);
  const ev = events("timesheet.read")[0];
  assert.deepEqual([ev.detail.ok, ev.detail.model, ev.detail.days, ev.detail.flagged, ev.detail.unresolved, ev.detail.inputTokens], [true, "claude-test-1", 31, 0, 0, 1000]);
});
await ok("AI に渡すもの：この月・このファイルの中身。tool_choice・thinking を付けない", async () => {
  setup();
  await readIt();
  assert.equal(ai.calls.length, 1);
  const p = ai.calls[0].params;
  assert.equal(p.messages[0].content[0].source.data, PDF.toString("base64"));
  assert.match(p.messages[0].content[1].text, /2026年10月/);
  assert.ok(!("tool_choice" in p) && !("thinking" in p));
});
await ok("AI が確定・確認済みを返しても取り込まない。読めない項目・自信のない行・書かれていない日は、要確認の印つき", async () => {
  setup();
  const input = sheetInput({ status: "confirmed", confirmed: true }, {
    3: { kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "low", reason: "手書き", status: "confirmed", reviewed: true },
    5: { break: null },              // 休憩が書かれていない
    6: { kind: "unknown", confidence: "low", reason: "判読不能" },
  });
  input.days = input.days.filter((d) => d.day !== 7);      // 7日の行が無い
  const r = await readIt(input);
  const d = (n) => r.body.days.find((x) => x.workDate === `${M}-${String(n).padStart(2, "0")}`);
  assert.equal(r.body.state, "draft");
  assert.equal(sheetRow().status, "draft");
  assert.equal(d(3).reviewed, false, "AI が reviewed を返しても、確認済みにしない");
  assert.ok(d(3).flags.some((f) => f.code === "low_confidence" && f.origin === "ai"));
  assert.equal(d(3).needsReview, true);
  assert.equal(d(5).breakMin, null, "休憩は補完しない");
  assert.equal(d(5).blocking, true);
  assert.equal(d(5).worked, null);
  assert.equal(d(6).kind, null);
  assert.equal(d(6).blocking, true);
  assert.deepEqual(d(7).flags.map((f) => f.code), ["kind_missing", "not_read"].filter((c) => d(7).flags.some((f) => f.code === c)));
  assert.equal(d(7).blocking, true);
  assert.ok(r.body.summary.unresolved.includes(`${M}-05`) && r.body.summary.unresolved.includes(`${M}-07`));
  assert.equal(r.body.summary.totalMinutes, 1440, "1・2・3日（3日は確認待ちだが実働は出る）。5日は休憩が不明なので入れない");
  assert.equal(r.body.confirm.ok, false);
  assert.ok(r.body.confirm.blockers.length >= 2);
});
await ok("勤務表の氏名が登録と違えば、name_mismatch の注意（別の人の勤務表の可能性）", async () => {
  setup();
  const r = await readIt(sheetInput({ employee_name: "佐藤 次郎" }));
  assert.equal(r.body.timesheet.nameMatch, false);
  assert.ok(r.body.timesheet.readWarnings.some((w) => w.code === "name_mismatch" && /佐藤 次郎/.test(w.text)));
  assert.equal(sheetRow().sheet_employee_name, "佐藤 次郎");
});
await ok("休憩の欄が無い勤務表：注意を出し、休憩は補完しない", async () => {
  setup();
  const input = sheetInput({ break_column: "absent" });
  for (const d of input.days) if (d.kind === "work") d.break = null;
  const r = await readIt(input);
  assert.ok(r.body.timesheet.readWarnings.some((w) => w.code === "no_break_column"));
  assert.equal(r.body.summary.unresolvedCount, 3);
  assert.equal(r.body.summary.totalMinutes, 0);
});
await ok("AI が読み取れない → 422 と理由。下書きの行に失敗を残し、手入力に進める（blank）", async () => {
  setup(); seedFile();
  ai.reply = { stop_reason: "end_turn", content: [{ type: "text", text: "読めません" }] };
  const r = await post("read");
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.error, "read_failed");
  assert.equal(r.body.code, "no_tool");
  assert.ok(r.body.message);
  assert.equal(sheetRow().read_state, "failed");
  assert.equal(sheetRow().ai_message, r.body.message);
  assert.equal(rows("gw_timesheet_days").length, 0);
  const g = await get();
  assert.equal(g.body.state, "draft");
  assert.equal(g.body.timesheet.readState, "failed");
  assert.equal(events("timesheet.read")[0].detail.ok, false);
  // もう一度読める
  withAi(sheetInput());
  const again = await post("read");
  assert.equal(again.statusCode, 200);
  assert.equal(sheetRow().read_state, "ok");
  assert.equal(sheetRow().ai_message, null);
});
await ok("API のエラーは 422 で理由を返す。エラーの生の文（detail）は画面に出さない", async () => {
  setup(); seedFile();
  ai.reply = Object.assign(new Error("invalid_request_error: sk-ant-secret"), { status: 400 });
  const r = await post("read");
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.code, "rejected");
  assert.ok(!JSON.stringify(r.body).includes("sk-ant"));
});
await ok("勤務表の年月が違う → 422 wrong_month。日別を取り込まない", async () => {
  setup();
  const r = await readIt(sheetInput({ sheet_month: "2026-09" }));
  assert.equal(r.statusCode, 422);
  assert.equal(r.body.code, "wrong_month");
  assert.equal(rows("gw_timesheet_days").length, 0);
});
await ok("ファイルが無い／置かれていない／中身が変わった／PDF・画像でない → AI を呼ばない", async () => {
  setup();
  const none = await post("read");
  assert.equal(none.statusCode, 404);
  assert.equal(none.body.error, "no_file");
  const id = seedFile({ put: false });
  const miss = await post("read");
  assert.equal(miss.statusCode, 404);
  assert.equal(miss.body.error, "file_missing");
  mem.put(BUCKET, `${T1}/${E_PP}/${id}.pdf`, Buffer.from("ただの文字"));
  assert.equal((await post("read")).body.error, "unsupported_file");
  mem.put(BUCKET, `${T1}/${E_PP}/${id}.pdf`, PDF);
  rows("gw_submissions")[0].sha256 = "f".repeat(64);
  assert.equal((await post("read")).body.error, "file_changed");
  assert.equal(ai.calls.length, 0);
});
await ok("外部フォームの行（sha256 が空）は、読むときに中身を確かめて sha256・verified_at を埋める", async () => {
  setup();
  await readIt();
  const s = rows("gw_submissions")[0];
  assert.equal(s.sha256, await sha(PDF));
  assert.ok(s.verified_at);
});
await ok("人が直した下書きは、黙って上書きしない（409 has_edits）。承知（overwrite）なら、読み直して直しを消す", async () => {
  setup();
  await readIt(sheetInput({}, { 5: { break: null } }));
  await post("save", { days: [{ workDate: `${M}-05`, break: "1:00" }] });
  assert.equal(sheetRow().edit_count, 1);
  withAi(sheetInput());
  const r = await post("read");
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "has_edits");
  assert.equal(dayRow(5).break_min, 60, "まだ直しは残っている");
  const o = await post("read", { overwrite: true });
  assert.equal(o.statusCode, 200);
  assert.equal(sheetRow().edit_count, 0);
  assert.equal(dayRow(5).reviewed_at, null);
  assert.equal(dayRow(5).edited, false);
});
await ok("確定済みは読み取り直せない（先に確定を取り消す）", async () => {
  setup();
  await readIt();
  await post("confirm");
  withAi(sheetInput());
  const r = await post("read", { overwrite: true });
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "already_confirmed");
});

console.log("\n— 手入力・直す・まとめて直す —");

await ok("blank：全日が空の下書き（手入力）。全日が「実働を出せない」。2回目は 409", async () => {
  setup();
  const r = await post("blank");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.state, "draft");
  assert.equal(r.body.days.length, 31);
  assert.equal(r.body.summary.unresolvedCount, 31);
  assert.ok(rows("gw_timesheet_days").every((d) => d.source === "manual" && d.kind === null));
  assert.equal(r.body.confirm.ok, false);
  assert.equal((await post("blank")).statusCode, 409);
});
await ok("save：値を直すと、実働・合計を再計算し、その日は確認済み・edited。直した項目の数を数える", async () => {
  setup();
  await readIt(sheetInput({}, { 5: { break: null } }));
  assert.equal(dayRow(5).break_min, null);
  const r = await post("save", { days: [{ workDate: `${M}-05`, break: "1:00" }], reviewSeconds: 42 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const d5 = r.body.days.find((d) => d.workDate === `${M}-05`);
  assert.equal(d5.breakMin, 60);
  assert.equal(d5.worked, 480);
  assert.equal(d5.reviewed, true);
  assert.equal(d5.edited, true);
  assert.equal(r.body.summary.totalMinutes, 1440);
  assert.equal(r.body.summary.unresolvedCount, 0);
  assert.equal(dayRow(5).break_min, 60);
  assert.equal(dayRow(5).edited, true);
  assert.ok(dayRow(5).reviewed_at);
  assert.equal(sheetRow().edit_count, 1);
  assert.equal(sheetRow().review_seconds, 42);
  assert.equal(sheetRow().total_minutes, 1440);
  assert.deepEqual([events("timesheet.save")[0].detail.days, events("timesheet.save")[0].detail.fields], [1, 1]);
});
await ok("save：AI の元の値（ai_snapshot）は残る。直したかは snapshot と比べられる", async () => {
  setup();
  await readIt(sheetInput({}, { 5: { break: null } }));
  await post("save", { days: [{ workDate: `${M}-05`, break: "1:00" }] });
  assert.equal(dayRow(5).ai_snapshot.breakMin, null);
});
await ok("save：全部検査してから書く。1つでも読めなければ 400 で、何も保存しない（日付ごとの理由つき）", async () => {
  setup();
  await readIt();
  const r = await post("save", { days: [
    { workDate: `${M}-01`, start: "10:00" },                      // 正しい
    { workDate: `${M}-06`, start: "9:5" },                        // 読めない
    { workDate: `${M}-07`, break: "1" },                          // 単位が無い
    { workDate: "2026-09-30", start: "9:00" },                    // 対象月ではない
  ] });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "invalid_input");
  assert.deepEqual(Object.keys(r.body.errors).sort(), ["2026-09-30", `${M}-06`, `${M}-07`]);
  assert.match(r.body.errors[`${M}-06`][0], /開始/);
  assert.equal(dayRow(1).start_min, 540, "正しい入力も保存されていない");
  assert.equal(sheetRow().edit_count, 0);
  assert.equal(events("timesheet.save").length, 0);
});
await ok("save：同じ値を入れ直しても変更にしない。reviewed:true だけなら確認済みにする", async () => {
  setup();
  await readIt(sheetInput({}, { 3: { kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "low", reason: "かすれ" } }));
  const same = await post("save", { days: [{ workDate: `${M}-03`, start: "9:00" }] });
  assert.equal(same.statusCode, 200);
  assert.equal(sheetRow().edit_count, 0);
  assert.equal(dayRow(3).reviewed_at, null);
  assert.equal(same.body.days.find((d) => d.workDate === `${M}-03`).needsReview, true);
  const rv = await post("save", { days: [{ workDate: `${M}-03`, reviewed: true }] });
  assert.equal(rv.body.days.find((d) => d.workDate === `${M}-03`).needsReview, false);
  assert.ok(dayRow(3).reviewed_at);
  assert.equal(sheetRow().edit_count, 0, "見ただけなら、直した数には入らない");
});
await ok("save：休みにすると時刻・休憩を空にする。読めない kind は 400", async () => {
  setup();
  await readIt();
  const r = await post("save", { days: [{ workDate: `${M}-05`, kind: "off" }] });
  const d = r.body.days.find((x) => x.workDate === `${M}-05`);
  assert.deepEqual([d.kind, d.startMin, d.endMin, d.breakMin], ["off", null, null, null]);
  assert.equal(r.body.summary.totalMinutes, 960);
  assert.equal((await post("save", { days: [{ workDate: `${M}-05`, kind: "holiday" }] })).statusCode, 400);
});
await ok("save：days が無い・多すぎる・下書きが無い・確定済み・差し戻し中は断る", async () => {
  setup();
  assert.equal((await post("save", { days: [{ workDate: `${M}-01`, start: "9:00" }] })).statusCode, 404, "下書きが無い");
  await readIt();
  assert.equal((await post("save", {})).statusCode, 400);
  assert.equal((await post("save", { days: [] })).statusCode, 400);
  assert.equal((await post("save", { days: Array.from({ length: 63 }, () => ({ workDate: `${M}-01`, note: "a" })) })).statusCode, 400);
  await post("confirm");
  const c = await post("save", { days: [{ workDate: `${M}-01`, start: "10:00" }] });
  assert.equal(c.statusCode, 409);
  assert.equal(c.body.error, "already_confirmed");
});
await ok("確認にかかった秒数は積み上げる（1回あたり上限 1800 秒。負数・文字は 0）", async () => {
  setup();
  await readIt();
  await post("save", { days: [{ workDate: `${M}-01`, note: "a" }], reviewSeconds: 100 });
  await post("save", { days: [{ workDate: `${M}-01`, note: "b" }], reviewSeconds: 99999 });
  await post("save", { days: [{ workDate: `${M}-01`, note: "c" }], reviewSeconds: -5 });
  await post("save", { days: [{ workDate: `${M}-01`, note: "d" }], reviewSeconds: "abc" });
  assert.equal(sheetRow().review_seconds, 100 + 1800);
});
await ok("bulk fill_break：勤務で休憩が空の日にだけ入れる（休憩がある日は触らない）。fill_break の '1' は断る", async () => {
  setup();
  const input = sheetInput({}, { 1: { break: null }, 2: { break: "0:30" }, 5: { break: null } });
  await readIt(input);
  assert.equal((await post("bulk", { op: "fill_break", minutes: "1" })).statusCode, 400);
  const r = await post("bulk", { op: "fill_break", minutes: "1:00" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.changedDays, 2);
  assert.equal(dayRow(1).break_min, 60);
  assert.equal(dayRow(2).break_min, 30);
  assert.equal(dayRow(5).break_min, 60);
  assert.equal(r.body.summary.unresolvedCount, 0);
  assert.equal(events("timesheet.save")[0].detail.op, "fill_break");
});
await ok("bulk mark_off_unread：読み取れなかった日（not_read）を休みにする。値のある日は触らない", async () => {
  setup();
  const input = sheetInput();
  input.days = input.days.filter((d) => d.day !== 8 && d.day !== 9);
  await readIt(input);
  assert.equal(dayRow(8).kind, null);
  const r = await post("bulk", { op: "mark_off_unread" });
  assert.equal(r.body.changedDays, 2);
  assert.equal(dayRow(8).kind, "off");
  assert.equal(dayRow(1).kind, "work");
  assert.equal(r.body.summary.unresolvedCount, 0);
});
await ok("bulk mark_off_dates：指定日を休みに。対象月にない日は 400。review_flagged：要確認を確認済みに（実働を出せない日は触らない）", async () => {
  setup();
  await readIt(sheetInput({}, {
    3: { kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "low", reason: "かすれ" },
    5: { break: null },
  }));
  assert.equal((await post("bulk", { op: "mark_off_dates", dates: ["2026-09-30"] })).statusCode, 400);
  assert.equal((await post("bulk", { op: "nope" })).statusCode, 400);
  const rv = await post("bulk", { op: "review_flagged" });
  assert.equal(rv.body.changedDays, 1);
  assert.ok(dayRow(3).reviewed_at);
  assert.equal(dayRow(5).reviewed_at, null, "実働を出せない日は、確認済みにならない");
  assert.equal(rv.body.summary.reviewCount, 0);
  assert.equal(rv.body.summary.unresolvedCount, 1);
  const off = await post("bulk", { op: "mark_off_dates", dates: [`${M}-05`] });
  assert.equal(dayRow(5).kind, "off");
  assert.equal(off.body.summary.unresolvedCount, 0);
});

console.log("\n— 確定（既存の5つの印と同期） —");

await ok("確定：条件を満たした下書きだけ。確定・確定者・合計を保存し、受領・稼働確認の印を立て、履歴を残す", async () => {
  setup();
  await readIt();
  const r = await post("confirm", { reviewSeconds: 75 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, "confirmed");
  assert.equal(r.body.timesheet.status, "confirmed");
  assert.equal(r.body.timesheet.confirmed.totalMinutes, 1440);
  const t = sheetRow();
  assert.equal(t.status, "confirmed");
  assert.equal(t.confirmed_by, "u-1");
  assert.ok(t.confirmed_at);
  assert.equal(t.total_minutes, 1440);
  assert.equal(t.work_days, 3);
  assert.equal(t.review_seconds, 75);
  assert.equal(progress().timesheet_received, true);
  assert.equal(progress().work_confirmed, true);
  assert.ok(progress().work_confirmed_at);
  assert.equal(progress().board_created, false, "請求の印は触らない");
  const ev = events("timesheet.confirm")[0];
  assert.deepEqual([ev.detail.totalMinutes, ev.detail.workDays, ev.detail.reviewSeconds], [1440, 3, 75]);
  assert.deepEqual(ev.detail.marks.sort(), ["timesheet_received", "work_confirmed"]);
  assert.ok(logged.some((l) => l.action === "office.timesheet.confirm"));
  assert.equal(ev.actor_name, "経理 花子");
});
await ok("確定：受領の印が既にあれば、そのまま（時刻を上書きしない）", async () => {
  setup();
  mem.rows.gw_billing_progress = [{ id: uid(500), tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, billing_month: M,
    timesheet_received: true, timesheet_received_at: "2026-11-01T00:00:00Z", work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false }];
  await readIt();
  await post("confirm");
  assert.equal(progress().timesheet_received_at, "2026-11-01T00:00:00Z");
  assert.equal(progress().work_confirmed, true);
  assert.deepEqual(events("timesheet.confirm")[0].detail.marks, ["work_confirmed"]);
});
await ok("確定できない：不明な日／要確認が未確認／行が無い → 409 not_ready（理由つき）。何も書かない", async () => {
  setup();
  await readIt(sheetInput({ total_worked: null }, {
    3: { kind: "work", start: "09:00", end: "18:00", break: "1:00", worked: "8:00", confidence: "low", reason: "かすれ" },
    5: { break: null },
  }));
  const r = await post("confirm");
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "not_ready");
  assert.match(r.body.blockers.join(), /実働を出せない日が 1 日/);
  assert.match(r.body.blockers.join(), /要確認の日が 1 日/);
  assert.equal(sheetRow().status, "draft");
  assert.equal(progress()?.work_confirmed ?? false, false);
  assert.equal(events("timesheet.confirm").length, 0);
  // 直して確認済みにすれば、確定できる
  await post("save", { days: [{ workDate: `${M}-05`, break: "1:00" }, { workDate: `${M}-03`, reviewed: true }] });
  assert.equal((await post("confirm")).statusCode, 200);
});
await ok("勤務表の合計と計算が違う → 409 ack_required。承知（ack）を付ければ確定でき、履歴に残る", async () => {
  setup();
  await readIt(sheetInput({ total_worked: "25:00" }));
  const r = await post("confirm");
  assert.equal(r.statusCode, 409);
  assert.equal(r.body.error, "ack_required");
  assert.deepEqual(r.body.acks, ["total_mismatch"]);
  assert.match(r.body.ackLabels.total_mismatch, /合計/);
  assert.equal(sheetRow().status, "draft");
  assert.equal((await post("confirm", { ack: ["something_else"] })).statusCode, 409);
  const ok2 = await post("confirm", { ack: ["total_mismatch"] });
  assert.equal(ok2.statusCode, 200);
  assert.deepEqual(events("timesheet.confirm")[0].detail.acks, ["total_mismatch"]);
});
await ok("下書きが無い・確定済み・差し戻し中は確定できない", async () => {
  setup();
  assert.equal((await post("confirm")).statusCode, 404);
  await readIt();
  await post("confirm");
  const again = await post("confirm");
  assert.equal(again.statusCode, 409);
  assert.equal(again.body.error, "already_confirmed");
  assert.equal(events("timesheet.confirm").length, 1);
});
await ok("契約条件（時給 4,500円）があれば、確定した稼働時間から精算を返す。24h × 4,500 = 108,000円", async () => {
  setup();
  mem.rows.gw_site_contract_terms = [{ id: uid(600), tenant_id: T1, site_contract_id: C_PP, valid_from: "2026-04-01", valid_to: null,
    pricing_type: "hourly", sales_unit_price: 4500, purchase_unit_price: 3800, amount_rounding: null, prorate: false }];
  await readIt();
  const draft = await get();
  assert.equal(draft.body.settlement, null, "確定前は精算を出さない");
  assert.equal(draft.body.terms.status, "ok");
  assert.equal(draft.body.terms.description, "時給 4,500円");
  const r = await post("confirm");
  assert.equal(r.body.settlement.status, "calculated");
  assert.equal(r.body.settlement.amount, 108000);
  assert.equal(sheetRow().terms_id, uid(600));
});
await ok("契約条件が無ければ、精算は none（金額を出さない）。確定は妨げない", async () => {
  setup();
  await readIt();
  const r = await post("confirm");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.settlement.status, "none");
  assert.equal(r.body.settlement.amount, null);
});
await ok("契約条件の丸め（30分・切捨て・月合計）を、確定の合計に使い、確定時の条件を控える。あとで条件が変わったら changedAfterConfirm", async () => {
  setup();
  mem.rows.gw_site_contract_terms = [{ id: uid(601), tenant_id: T1, site_contract_id: C_PP, valid_from: "2026-04-01", valid_to: null,
    pricing_type: "monthly", settlement_mode: "fixed", sales_unit_price: 700000, settle_unit_minutes: 30, rounding_mode: "floor", rounding_scope: "month" }];
  // 実働 8:10・8:10・8:00 = 490 + 490 + 480 = 1460分 → 30分単位・切捨て（月合計）→ 1440
  const input = sheetInput({ total_worked: null }, { 1: { end: "18:10", worked: null }, 2: { end: "18:10", worked: null }, 5: { worked: null } });
  await readIt(input);
  const d = await get();
  assert.equal(d.body.summary.rawMinutes, 1460);
  assert.equal(d.body.summary.totalMinutes, 1440);
  await post("confirm");
  assert.deepEqual([sheetRow().rounding_unit, sheetRow().rounding_mode, sheetRow().rounding_scope, sheetRow().total_minutes], [30, "floor", "month", 1440]);
  assert.equal((await get()).body.terms.changedAfterConfirm, false);
  mem.rows.gw_site_contract_terms[0].settle_unit_minutes = 15;
  const after = await get();
  assert.equal(after.body.terms.changedAfterConfirm, true, "確定した合計は動かさず、条件が変わったことを知らせる");
  assert.equal(after.body.timesheet.confirmed.totalMinutes, 1440);
});
await ok("月の途中で条件が変わる（2件）→ 精算は要確認（自動で選ばない）", async () => {
  setup();
  mem.rows.gw_site_contract_terms = [
    { id: uid(602), tenant_id: T1, site_contract_id: C_PP, valid_from: "2026-04-01", valid_to: "2026-10-15", pricing_type: "hourly", sales_unit_price: 4500 },
    { id: uid(603), tenant_id: T1, site_contract_id: C_PP, valid_from: "2026-10-16", valid_to: null, pricing_type: "hourly", sales_unit_price: 4800 },
  ];
  await readIt();
  const r = await post("confirm");
  assert.equal(r.body.terms.status, "multiple");
  assert.equal(r.body.terms.candidates.length, 2);
  assert.equal(r.body.settlement.status, "review");
  assert.equal(r.body.settlement.amount, null);
});
await ok("前月の月末が翌月にかかる勤務（前月の下書き）を、今月の繰越として足す", async () => {
  setup();
  // 9月の勤務表：9/30 22:00〜翌6:00（休憩1:00）→ 10月側に 6h 分（休憩は9月側から引く）→ 6:00 − 0 = 360
  mem.rows.gw_timesheets = [{ id: uid(700), tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, target_month: "2026-09", status: "confirmed" }];
  mem.rows.gw_timesheet_days = [{ tenant_id: T1, timesheet_id: uid(700), work_date: "2026-09-30", kind: "work", start_min: 1320, end_min: 1800, break_min: 60, source: "manual", ai_flags: [], edited: false, reviewed_at: null }];
  await readIt(sheetInput({ total_worked: null }));
  const d = await get();
  assert.equal(d.body.carryInMinutes, 360);
  assert.equal(d.body.summary.totalMinutes, 1440 + 360);
});

console.log("\n— 確定の取消し・差し戻し —");

await ok("reopen：理由が要る。確定を下書きに戻し、稼働確認の印を外す（受領の印は残す）。履歴に理由を残す", async () => {
  setup();
  await readIt();
  await post("confirm");
  assert.equal((await post("reopen")).body.error, "reason_required");
  assert.equal((await post("reopen", { reason: "あ".repeat(201) })).statusCode, 400);
  const r = await post("reopen", { reason: "休憩の入力ミス" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, "draft");
  assert.equal(sheetRow().status, "draft");
  assert.equal(sheetRow().confirmed_at, null);
  assert.equal(progress().work_confirmed, false);
  assert.equal(progress().work_confirmed_at, null);
  assert.equal(progress().timesheet_received, true);
  assert.equal(events("timesheet.reopen")[0].detail.reason, "休憩の入力ミス");
  assert.deepEqual(events("timesheet.reopen")[0].detail.marks, ["work_confirmed"]);
  // 直して、もう一度確定できる
  assert.equal((await post("confirm")).statusCode, 200);
});
await ok("reopen：請求書の作成・送付の印があれば断る（その稼働時間で請求している）。確定は動かさない", async () => {
  for (const mark of ["board_created", "sent"]) {
    setup();
    await readIt();
    await post("confirm");
    progress()[mark] = true;
    const r = await post("reopen", { reason: "やり直し" });
    assert.equal(r.statusCode, 409, mark);
    assert.equal(r.body.error, "invoiced");
    assert.equal(sheetRow().status, "confirmed");
    assert.equal(progress().work_confirmed, true);
    assert.equal(events("timesheet.reopen").length, 0);
  }
});
await ok("reopen：確定していなければ 409", async () => {
  setup();
  await readIt();
  assert.equal((await post("reopen", { reason: "x" })).statusCode, 409);
});
await ok("return：理由が要る。下書き → 差し戻し中。受領の印を外して再提出を待つ。メールは送らない", async () => {
  setup();
  await readIt();
  mem.rows.gw_billing_progress = [...(mem.rows.gw_billing_progress || [])];
  progress() || mem.rows.gw_billing_progress.push({ id: uid(501), tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, billing_month: M, timesheet_received: true, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false });
  assert.equal((await post("return")).body.error, "reason_required");
  const r = await post("return", { reason: "10/15〜10/20 の記入が抜けています。再提出をお願いします" });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, "returned");
  assert.equal(r.body.timesheet.returnReason, "10/15〜10/20 の記入が抜けています。再提出をお願いします");
  assert.equal(sheetRow().status, "returned");
  assert.equal(progress().timesheet_received, false);
  assert.equal(events("timesheet.return").length, 1);
  assert.equal(mem.state.log.filter((l) => l.table === "notifications").length, 0, "通知（メール）を作らない");
  // 差し戻し中は、保存・確定できない。新しい勤務表を読み取れば、下書きに戻る
  assert.equal((await post("save", { days: [{ workDate: `${M}-01`, note: "a" }] })).body.error, "returned");
  assert.equal((await post("confirm")).body.error, "returned");
  withAi(sheetInput());
  const again = await post("read", { overwrite: true });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.state, "draft");
  assert.equal(sheetRow().return_reason, null);
});
await ok("return：ファイルだけ届いていて下書きが無いときも差し戻せる。何も届いていなければ 409。確定済みは 409", async () => {
  setup();
  assert.equal((await post("return", { reason: "x" })).statusCode, 409);
  seedFile();
  const r = await post("return", { reason: "読めない画像です" });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.state, "returned");
  setup();
  await readIt();
  await post("confirm");
  const c = await post("return", { reason: "x" });
  assert.equal(c.statusCode, 409);
  assert.equal(c.body.error, "already_confirmed");
});
await ok("newerFile：下書きの読取元より新しいファイルが届いたら知らせる（自動では読み替えない）", async () => {
  setup();
  const first = seedFile();
  withAi(sheetInput());
  await post("read", { submissionId: first });
  assert.equal((await get()).body.newerFile, null);
  const second = seedFile({ bytes: PDF2 });
  const g = await get();
  assert.equal(g.body.newerFile.id, second);
  assert.equal(g.body.timesheet.submissionId, first, "読取元は変えない");
  assert.equal(g.body.files.find((f) => f.id === second).isLatest, true);
  assert.equal(g.body.files.find((f) => f.id === first).isSource, true);
});

console.log("\n— 書き込みは service_role だけ・履歴 —");

await ok("ログインした人の権限（userClient）で書こうとすると、RLS が止める（API は書き込みに userClient を使わない）", async () => {
  setup();
  const uc = mem.userClient(FINANCE);
  for (const [t, row] of [["gw_timesheets", { tenant_id: T1, employee_id: E_PP, site_contract_id: C_PP, target_month: M, status: "draft" }],
    ["gw_timesheet_days", { tenant_id: T1, timesheet_id: uid(1), work_date: `${M}-01` }],
    ["gw_office_events", { tenant_id: T1, billing_month: M, kind: "x.y" }],
    ["gw_site_contract_terms", { tenant_id: T1, site_contract_id: C_PP, valid_from: "2026-10-01", pricing_type: "hourly" }]]) {
    const r = await uc.from(t).insert(row);
    assert.equal(r.error?.code, "42501", t);
  }
});
await ok("履歴には、金額・単価・氏名などの個人情報を入れない（時間・件数・理由だけ）", async () => {
  setup();
  mem.rows.gw_site_contract_terms = [{ id: uid(600), tenant_id: T1, site_contract_id: C_PP, valid_from: "2026-04-01", pricing_type: "hourly", sales_unit_price: 4500, purchase_unit_price: 3800 }];
  await readIt();
  await post("confirm");
  // 乱数の UUID・日時の数字が、たまたま 4500 などを含むことがある。それらを除いてから探す（値として入っていないか）
  const text = (JSON.stringify(rows("gw_office_events")) + JSON.stringify(logged))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>");
  for (const w of ["4500", "3800", "108000", "田中"]) assert.ok(!text.includes(w), `${w} が履歴に入っている`);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
