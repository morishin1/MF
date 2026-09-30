// db/office_phase3_test_seed.sql・db/office_phase3_test_cleanup.sql（本番の Office 操作確認用テストデータの作成・削除）を守るテスト。
//
// ■ なぜ要るのか
//   この2本の SQL は、本番の Supabase で人が流す。「既存データを変えない」「メール等を送らない」「実請求・実支払につながらない」
//   「後から完全に消せる」を、言葉ではなく検査で守る。PostgreSQL 上での実行確認は別に行っている（DB を使わないので、ここでは静的な検査と、
//   同じ値を偽の DB に入れて、/office の一覧から、勤務表の追加・AI読取・修正・確定まで、実際の API を通す）。
//
// ■ 守ること
//   1. seed は INSERT だけ（4表・4行）。update・delete・drop・alter・create が無い。owner の権限・ログインの所属には触れない
//   2. 名前は【Office Phase3 TEST】を含む。id は固定で、cleanup と同じ。ガードは「含む」で判定する（客先名は末尾にタグ）
//   3. 社員行は「メール・ログイン・入社日」を入れない（定期処理・通知の対象にならない）。契約は終了日なし・単価なし（unit_price は使わない）。
//      仕入単価は入れない。月次進捗は5つの印がすべて「未」
//   4. seed は ①作成前確認 → ②INSERT → ③作成後確認。既存データのハッシュを ① と ③ で同じ式で出す（既存の社員・契約・進捗・owner の権限・所属）
//   5. cleanup は ④-a 削除前確認 → ④-b DELETE → ④-c 削除後確認。消すのは固定 id のテスト行だけ。
//      storage.objects は読むだけ（SQL からは消さない）。名前・ログイン・別の契約・Storage の残りがあれば、何も消さずに止まる
//   6. 同じ値を偽の DB に入れると、/office の一覧（2026年10月）に1行出る。9月には出ない
//   7. 勤務表を追加 → AI読取 → 空欄を人が埋める → 確定、で、最初からある月次進捗の行が「更新」され（増えない）、
//      一覧の現在工程が「請求作成待ち」に進む。合計は 154:45 で、契約条件の精算は 700,000円
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  atRoot, mem, ctl, ai, call, OWNER, uid, T1, T2,
} from "./_officeharness.mjs";

const { default: indexApi } = await import(atRoot("api/office/index.js"));
const { default: sheetApi } = await import(atRoot("api/office/timesheet.js"));
const { nameMatches } = await import(atRoot("lib/office-timesheet.js"));
const { normalizeTerms, termsForMonth, settle } = await import(atRoot("lib/office-calc.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

const SEED = fs.readFileSync(atRoot("db/office_phase3_test_seed.sql"), "utf8");
const CLEAN = fs.readFileSync(atRoot("db/office_phase3_test_cleanup.sql"), "utf8");
const code = (s) => s.replace(/--.*$/gm, "");           // コメントを除いた、実際に動く部分
const SEED_CODE = code(SEED);
const CLEAN_CODE = code(CLEAN);

const TAG = "【Office Phase3 TEST】";
const EMP = "e13db73f-3d85-45ca-ac0a-7f26a5d53610";
const CON = "3688ccc1-bf24-4fcd-81fa-50e4a2086c7b";
const TERMS = "73c4e190-160b-4ea9-b697-f7afe7a26b45";
const PROG = "d309c095-8c2a-4a21-b713-ba43acd61698";

// insert 文の（テーブル名 → 列名の並び）
const insertCols = (sql) => {
  const out = {};
  for (const m of sql.matchAll(/insert\s+into\s+public\.(\w+)\s*\(([^)]*)\)/gi)) out[m[1]] = m[2].split(",").map((s) => s.trim());
  return out;
};

console.log("— SQL の中身 —");

await ok("seed は INSERT だけ：4表・4行。update・delete・truncate・drop・alter・create・grant が、動く部分に無い", async () => {
  for (const w of ["update", "delete", "truncate", "drop", "alter", "create", "grant", "revoke", "storage\\.objects", "net\\.http"]) {
    assert.ok(!new RegExp(`\\b${w}\\b`, "i").test(SEED_CODE), `seed に ${w} がある`);
  }
  const t = insertCols(SEED_CODE);
  assert.deepEqual(Object.keys(t).sort(), ["gw_billing_progress", "gw_employees", "gw_site_contract_terms", "gw_site_contracts"]);
  assert.equal((SEED_CODE.match(/insert\s+into/gi) || []).length, 4, "INSERT はちょうど4本");
  // owner の権限・ログインの所属・認証には、書き込まない（読んでハッシュを出すだけ）
  for (const tbl of ["gw_role_grants", "memberships", "users", "tenants"]) {
    assert.ok(!new RegExp(`insert\\s+into\\s+(public|auth)\\.${tbl}\\b`, "i").test(SEED_CODE), `${tbl} に書かない`);
  }
});

await ok("seed は ①作成前確認 → ②INSERT（1つの DO ブロック）→ ③作成後確認 の順。既存データのハッシュを ① と ③ で同じ式で出す", async () => {
  const i1 = SEED.indexOf("① 作成前確認"), i2 = SEED.indexOf("② INSERT"), i3 = SEED.indexOf("③ 作成後確認");
  assert.ok(i1 > 0 && i2 > i1 && i3 > i2, "①②③の順");
  assert.equal((SEED_CODE.match(/^do \$\$/gm) || []).length, 1, "DO ブロックは1つ（途中で失敗したら何も残らない）");
  const HASH = /md5\(coalesce\(string_agg\(t::text, '\|' order by t::text\), ''\)\) from public\.(\w+) t/g;
  const before = [...SEED_CODE.slice(SEED_CODE.indexOf("select 順"), SEED_CODE.indexOf("do $$")).matchAll(HASH)].map((m) => m[1]);
  const after = [...SEED_CODE.slice(SEED_CODE.lastIndexOf("select 順")).matchAll(HASH)].map((m) => m[1]);
  assert.deepEqual(before, ["gw_employees", "gw_site_contracts", "gw_billing_progress", "gw_role_grants", "memberships"]);
  assert.deepEqual(after, before, "③は①と同じ表・同じ式");
});

await ok("固定 id が seed と cleanup で同じ（社員・契約・条件・進捗）。UUID の形。id を毎回変えない", async () => {
  for (const id of [EMP, CON, TERMS, PROG]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(SEED.includes(id), `seed に ${id}`);
    assert.ok(CLEAN.includes(id), `cleanup に ${id}`);
  }
  assert.ok(!/gen_random_uuid|uuid_generate/i.test(SEED_CODE));
});

await ok("名前は【Office Phase3 TEST】を含む（要員・客先・メモ）。客先は末尾にタグ。判定は「含む」（strpos）", async () => {
  assert.ok(SEED_CODE.includes(`v_tag    constant text := '${TAG}'`));
  assert.match(SEED_CODE, /values \(v_emp, v_tenant, v_tag \|\| 'テスト 太郎'/);
  assert.match(SEED_CODE, /'株式会社テスト' \|\| v_tag/);
  assert.match(SEED_CODE, /v_tag \|\| 'Office の操作確認用。実請求・実支払には使わない/);
  assert.match(SEED_CODE, /values \(v_prog, v_tenant, v_emp, v_con, '2026-10', v_tag \|\| 'Office の操作確認用'\)/);
  assert.ok(!/starts_with\(\s*(display_name|site_company)/i.test(SEED_CODE + CLEAN_CODE), "先頭一致にしない（客先は末尾にタグ）");
});

await ok("社員行に メール・ログイン・入社日 を入れない。契約は終了日なし・単価なし・更新確認済み。仕入単価は入れない。進捗は5つの印を触らない", async () => {
  const cols = insertCols(SEED_CODE);
  for (const banned of ["email", "user_id", "joined_on", "left_on", "employment_type", "manager_id", "partner_company_id"]) {
    assert.ok(!cols.gw_employees.includes(banned), `gw_employees に ${banned} を入れない`);
  }
  assert.deepEqual(cols.gw_employees, ["id", "tenant_id", "display_name", "department", "status", "employee_kind"]);
  assert.match(SEED_CODE, /'active', 'proper'\)/);
  const con = SEED_CODE.match(/insert into public\.gw_site_contracts[\s\S]*?;\s*\n/i)[0];
  assert.match(con, /date '2026-10-01', null,\s*\n\s*null, 'confirmed'/, "終了日なし・unit_price なし・更新確認済み（45日前のタスクを作らない）");
  const terms = SEED_CODE.match(/insert into public\.gw_site_contract_terms[\s\S]*?;\s*\n/i)[0];
  assert.match(terms, /date '2026-10-01', null, 'monthly', 700000, null,\s*\n\s*'range', 8400, 10800, null, null, null,\s*\n\s*4000, 3500, false, 'floor'/, "月額・売上700,000・仕入なし・140〜180h・超過4,000/控除3,500・切捨て");
  assert.deepEqual(cols.gw_billing_progress, ["id", "tenant_id", "employee_id", "site_contract_id", "billing_month", "note"], "5つの印は既定（未）のまま");
});

await ok("メール・Slack・通知・Webhook・外部通信の語が、動く部分に無い（seed・cleanup とも）", async () => {
  for (const s of [SEED_CODE, CLEAN_CODE]) assert.ok(!/slack|notify|webhook|smtp|resend|pg_net|net\.http|https?:|listen\b|pg_notify/i.test(s), "送信・通信につながる語がある");
  assert.ok(!/insert\s+into\s+public\.(gw_activity_log|gw_notifications|gw_messages|gw_push)/i.test(SEED_CODE), "通知・ログを作らない");
});

await ok("seed の止まる条件：105〜107 が無い／tenant が名簿にちょうど1つでない／すでにある。tenant は名簿のものを使う", async () => {
  assert.match(SEED_CODE, /to_regclass\('public\.gw_site_contract_terms'\) is null or to_regclass\('public\.gw_timesheets'\) is null/);
  assert.match(SEED_CODE, /if v_n <> 1 then\s+raise exception/);
  assert.match(SEED_CODE, /select tenant_id into v_tenant from public\.gw_employees group by tenant_id limit 1/);
  assert.match(SEED_CODE, /テストデータは、すでに入っています/);
});

await ok("cleanup は ④-a 削除前確認 → ④-b DELETE（1つの DO）→ ④-c 削除後確認。消すのは固定 id のテスト行だけ。storage.objects は読むだけ", async () => {
  const a = CLEAN.indexOf("④-a"), b = CLEAN.indexOf("④-b DELETE"), c = CLEAN.indexOf("④-c 削除後確認");
  assert.ok(a > 0 && b > a && c > b, "④-a → ④-b → ④-c");
  assert.equal((CLEAN_CODE.match(/^do \$\$/gm) || []).length, 1);
  const dels = [...CLEAN_CODE.matchAll(/delete\s+from\s+public\.(\w+)([\s\S]*?);/gi)];
  assert.deepEqual(dels.map((m) => m[1]), ["gw_activity_log", "gw_office_events", "gw_employees"]);
  for (const m of dels) assert.match(m[2], /\bwhere\b/i, `${m[1]} の delete に where がある`);
  assert.match(dels[1][2], /employee_id = v_emp or site_contract_id = v_con/);
  assert.match(dels[2][2], /where id = v_emp and strpos\(display_name, v_tag\) > 0/);
  assert.ok(!/delete\s+from\s+storage/i.test(CLEAN_CODE), "Storage は SQL から消さない");
  assert.ok(!/\b(truncate|drop|alter|update|insert)\b/i.test(CLEAN_CODE), "cleanup に update・insert・truncate・drop・alter が無い");
  // 社員を消せば、連鎖で契約・条件・進捗・提出記録・勤務表・日別が消える（外部キー）
  const mig = ["076_site_contracts", "077_billing_progress", "080_billing_submission", "106_office_contract_terms", "107_office_timesheets"].map((f) => fs.readFileSync(atRoot(`db/${f}.sql`), "utf8")).join("\n");
  for (const re of [
    /employee_id\s+uuid not null references public\.gw_employees\(id\) on delete cascade/,
    /site_contract_id\s+uuid not null references public\.gw_site_contracts\(id\) on delete cascade/,
    /timesheet_id\s+uuid not null references public\.gw_timesheets\(id\) on delete cascade/,
  ]) assert.match(mig, re);
  // 削除後確認は、seed の ① と同じ5つのハッシュを出す（既存データが変わっていないこと）
  const after = CLEAN_CODE.slice(CLEAN_CODE.lastIndexOf("select 順"));
  for (const t of ["gw_employees", "gw_site_contracts", "gw_billing_progress", "gw_role_grants", "memberships"]) {
    assert.ok(new RegExp(`from public\\.${t} t`).test(after), `④-c に ${t} のハッシュ`);
  }
});

await ok("cleanup が何も消さずに止まる条件：名前が違う・ログインが紐づく・別の契約がある・Storage にファイルが残っている", async () => {
  assert.match(CLEAN_CODE, /if strpos\(v_name, v_tag\) = 0 then\s+raise exception/);
  assert.match(CLEAN_CODE, /if v_user is not null then\s+raise exception/);
  assert.match(CLEAN_CODE, /employee_id = v_emp and id <> v_con\)\s+then\s+raise exception/);
  assert.match(CLEAN_CODE, /storage\.objects where bucket_id = \$1 and starts_with\(name, \$2\)/);
  assert.match(CLEAN_CODE, /v_tenant::text \|\| '\/' \|\| v_emp::text \|\| '\/'/, "Storage の場所は tenant/社員id/");
  const api = fs.readFileSync(atRoot("api/office/timesheet.js"), "utf8");
  assert.match(api, /`\$\{ctx\.tenantId\}\/\$\{k\.employeeId\}\/\$\{submissionId\}\.\$\{ext\}`/, "アップロード先の形と同じ");
});

// ---- 同じ値を偽の DB に入れて、実際の API を通す -------------------------------------------------------
const M = "2026-10";
const BUCKET = "billing-submissions";
const EXPECTED = JSON.parse(fs.readFileSync(atRoot("test/fixtures/office-timesheet/expected.json"), "utf8"));
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(300, 7)]);

function seedLikeSql() {
  mem.reset();
  ctl.who = OWNER; ctl.aal = "aal2";
  ai.calls.length = 0; ai.reply = null;
  mem.rows.gw_employees = [
    { id: EMP, tenant_id: T1, display_name: `${TAG}テスト 太郎`, department: "Office Phase3 TEST", status: "active", employee_kind: "proper", partner_company_id: null },
    { id: uid(11), tenant_id: T1, display_name: "山田 花子", department: null, status: "active", employee_kind: "proper", partner_company_id: null },
  ];
  mem.rows.gw_site_contracts = [
    { id: CON, tenant_id: T1, employee_id: EMP, engagement_kind: "pp", site_company: `株式会社テスト${TAG}`, prime_company: null,
      period_from: "2026-10-01", period_to: null, unit_price: null, unit_price_type: "月額", renewal_status: "confirmed", note: `${TAG}Office の操作確認用` },
  ];
  mem.rows.gw_site_contract_terms = [
    { id: TERMS, tenant_id: T1, site_contract_id: CON, valid_from: "2026-10-01", valid_to: null, pricing_type: "monthly",
      sales_unit_price: "700000.00", purchase_unit_price: null, settlement_mode: "range", settle_min_minutes: 8400, settle_max_minutes: 10800,
      settle_unit_minutes: null, rounding_mode: null, rounding_scope: null, over_rate_per_hour: "4000.00", under_rate_per_hour: "3500.00",
      prorate: false, amount_rounding: "floor" },
  ];
  mem.rows.gw_billing_progress = [
    { id: PROG, tenant_id: T1, employee_id: EMP, site_contract_id: CON, billing_month: M, note: `${TAG}Office の操作確認用`,
      timesheet_received: false, work_confirmed: false, board_created: false, sent: false, bp_invoice_received: false },
  ];
}
const rowsOf = (t) => mem.rows[t] || [];
const list = (month = M) => call(indexApi, `/api/office?month=${month}`);
const post = (action, extra = {}) => call(sheetApi, "/api/office/timesheet", { method: "POST", body: { action, siteContractId: CON, month: M, ...extra } });
const testRow = (r) => r.body.rows.find((x) => x.employeeName.includes(TAG));

// サンプル勤務表（expected.json の printed）を、AI が返す形にする。読めない所（10/14 休憩・10/21 終了）は null のまま
const clock = (m) => (m == null ? null : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`);
const aiInput = () => ({
  sheet_month: M, employee_name: EXPECTED.employee, total_worked: clock(EXPECTED.totalWorkedMin), break_column: "present",
  days: EXPECTED.days.map((e) => {
    const p = e.printed;
    const row = p.kind === "off"
      ? { day: e.day, kind: "off", blank: !e.note, note: e.note, confidence: "high" }
      : { day: e.day, kind: "work", start: clock(p.start), end: clock(p.end), break: clock(p.break), worked: clock(p.worked), note: e.note, confidence: "high" };
    if (EXPECTED.unreadable.includes(e.date)) { row.confidence = "low"; row.reason = "文字が読めない"; }
    return row;
  }),
});

console.log("— 偽の DB に入れて、実際の API を通す —");

await ok("/office の一覧（2026年10月）に、テスト行が1行出る：勤務表待ち・PP・契約条件あり・月次進捗あり。9月には出ない", async () => {
  seedLikeSql();
  const r = await list();
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.rows.length, 1, "契約はテスト分だけ");
  const row = testRow(r);
  assert.ok(row);
  assert.equal(row.siteCompany, `株式会社テスト${TAG}`);
  assert.equal(row.kindLabel, "PP（自社）");
  assert.equal(row.stage, "timesheet", "現在工程は勤務表待ち");
  assert.equal(row.terms?.status, "ok", "契約条件が効いている");
  assert.equal((await list("2026-09")).body.rows.length, 0, "契約は10/1から。9月には出ない");
});

await ok("勤務表追加 → AI読取 → 空欄を人が埋める → 確定：最初からある月次進捗の行が更新され（増えない）、現在工程が「請求作成待ち」に進む", async () => {
  seedLikeSql();
  // 勤務表を追加（署名つきURLでアップロード → attach）
  const up = (await post("upload", { mimeType: "application/pdf", sizeBytes: PDF.length })).body;
  mem.put(BUCKET, up.path, PDF);
  const at = await post("attach", { submissionId: up.submissionId, filename: "sample-2026-10.pdf" });
  assert.equal(at.statusCode, 200, JSON.stringify(at.body));
  assert.equal(rowsOf("gw_billing_progress").length, 1, "月次進捗は増えない");
  assert.equal(rowsOf("gw_billing_progress")[0].id, PROG, "seed の行を更新している");
  assert.equal(rowsOf("gw_billing_progress")[0].timesheet_received, true);
  assert.equal(rowsOf("gw_billing_progress")[0].work_confirmed, false);
  assert.equal(testRow(await list()).stage, "work", "受領の印が立ち、稼働確認待ちへ");

  // AI 読取：下書きになるだけ。確定にならない。読めない2か所は空のまま
  ai.reply = { model: "claude-test", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tu1", name: "read_timesheet", input: aiInput() }], usage: { input_tokens: 1, output_tokens: 1 } };
  const rd = await post("read");
  assert.equal(rd.statusCode, 200, JSON.stringify(rd.body));
  assert.equal(rd.body.timesheet.status, "draft");
  assert.equal(rowsOf("gw_billing_progress")[0].work_confirmed, false, "読み取っただけでは、稼働確認の印は立たない");
  const d14 = rowsOf("gw_timesheet_days").find((d) => d.work_date === "2026-10-14");
  const d21 = rowsOf("gw_timesheet_days").find((d) => d.work_date === "2026-10-21");
  assert.equal(d14.break_min, null, "休憩の空欄を、空欄のまま");
  assert.equal(d21.end_min, null, "隠れた終了を、補わない");
  assert.equal(rd.body.summary.unresolvedCount, 2, "人の入力が必要なのは2日");
  const early = await post("confirm");
  assert.equal(early.statusCode, 409, "空欄が残っているうちは、確定できない");

  // 人が、書いた人の知っている値（expected.json の truth）を入れる → 確定
  const truth = (date) => EXPECTED.days.find((d) => d.date === date).truth;
  const sv = await post("save", { reviewSeconds: 90, days: [
    { workDate: "2026-10-14", break: clock(truth("2026-10-14").break) },
    { workDate: "2026-10-21", end: clock(truth("2026-10-21").end) },
  ] });
  assert.equal(sv.statusCode, 200, JSON.stringify(sv.body));
  assert.equal(sv.body.summary.unresolvedCount, 0);
  const cf = await post("confirm", { reviewSeconds: 60 });
  assert.equal(cf.statusCode, 200, JSON.stringify(cf.body));
  assert.equal(cf.body.timesheet.status, "confirmed");
  assert.equal(cf.body.timesheet.confirmed.totalMinutes, 154 * 60 + 45, "合計は 154:45（サンプルの正解と同じ）");

  // 既存の5つの印：受領・稼働確認が立つ。同じ行のまま。それ以外は触らない
  assert.equal(rowsOf("gw_billing_progress").length, 1);
  const p = rowsOf("gw_billing_progress")[0];
  assert.equal(p.id, PROG);
  assert.deepEqual([p.timesheet_received, p.work_confirmed, p.board_created, p.sent, p.bp_invoice_received], [true, true, false, false, false]);
  const row = testRow(await list());
  assert.equal(row.stage, "invoice_create", "現在工程は「請求作成待ち」");
  assert.equal(row.settle?.status, "calculated");
  assert.equal(row.settle?.amount, 700000, "精算：幅の中で 700,000円");
  // 請求書・支払には進まない（印は立たず、行も作られない）
  assert.ok(!rowsOf("gw_billing_progress").some((x) => x.sent || x.board_created));
});

await ok("サンプル勤務表の氏名「テスト 太郎」と、登録名が照合で合う（氏名不一致の警告を出さない）。別人の名前は合わない", async () => {
  assert.equal(nameMatches("テスト 太郎", `${TAG}テスト 太郎`), true);
  assert.equal(nameMatches("テスト　太郎", `${TAG}テスト 太郎`), true, "全角スペースでも合う");
  assert.equal(nameMatches("山田 花子", `${TAG}テスト 太郎`), false);
});

await ok("契約条件は、サンプル勤務表の合計 154:45 で「精算幅の中・700,000円」。修正前の 138:45 は控除、185:00 は超過。9月の条件としては効かない", async () => {
  seedLikeSql();
  const rows = [normalizeTerms(rowsOf("gw_site_contract_terms")[0])];
  const terms = termsForMonth(rows, M);
  assert.equal(terms.status, "ok"); assert.equal(terms.partial, false);
  const a = settle({ terms, minutes: 154 * 60 + 45 });
  assert.equal(a.status, "calculated"); assert.equal(a.band, "within"); assert.equal(a.amount, 700000);
  const b = settle({ terms, minutes: 138 * 60 + 45 });     // 隠れた2日（16:00）が空のまま = 下限 140:00 に 1:15 足りない
  assert.equal(b.band, "under"); assert.equal(b.underMinutes, 75); assert.equal(b.amount, 695625);
  const c = settle({ terms, minutes: 185 * 60 });
  assert.equal(c.band, "over"); assert.equal(c.amount, 720000);
  assert.equal(termsForMonth(rows, "2026-09").status, "none");
  assert.equal(EXPECTED.totalWorkedMin, 154 * 60 + 45);
  assert.equal(EXPECTED.employee, "テスト 太郎");
  assert.equal(EXPECTED.month, M);
});

await ok("他社（別 tenant）の行は、この会社の一覧に出ない", async () => {
  seedLikeSql();
  mem.rows.gw_employees.push({ id: uid(13), tenant_id: T2, display_name: "他社の人", status: "active", employee_kind: "proper", partner_company_id: null });
  mem.rows.gw_site_contracts.push({ id: uid(23), tenant_id: T2, employee_id: uid(13), engagement_kind: "pp", site_company: "他社の客先", period_from: "2026-01-01", period_to: null, renewal_status: "pending" });
  assert.equal((await list()).body.rows.length, 1);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
