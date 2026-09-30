// db/office_phase3_test_seed.sql・db/office_phase3_test_cleanup.sql（本番の Office 操作確認用テストデータの作成・削除）を守るテスト。
//
// ■ なぜ要るのか
//   この2本の SQL は、本番の Supabase で人が流す。「既存データを変えない」「メール等を送らない」「実請求・実支払につながらない」
//   「後から完全に消せる」を、言葉ではなく検査で守る。PostgreSQL 上での実行確認は別に行っている（DB を使わないので、ここでは静的な検査と、
//   同じ値を偽の DB に入れて /api/office の一覧が正しく出るかを見る）。
//
// ■ 守ること
//   1. seed は INSERT だけ（update・delete・drop・alter・create が無い）。既存の行に触れる文が無い
//   2. seed が入れる社員・契約・契約条件の名前は、すべて【Office Phase3 TEST】で始まる。id は固定で、cleanup と同じ
//   3. 社員行は「メール・ログイン・入社日」を入れない（定期処理・通知の対象にならない）。契約は終了日なし・単価なし（unit_price は使わない）
//   4. 月次進捗（gw_billing_progress）・提出ファイル・勤務表は、seed では作らない（画面の操作で作られる）
//   5. cleanup が消すのは、固定 id のテスト行だけ。storage.objects は読むだけ（SQL からは消さない）。
//      名前・ログイン・別の契約・Storage の残りがあれば、何も消さずに止まる
//   6. 同じ値を偽の DB に入れると、/office の一覧に出て（勤務表待ち・契約条件あり）、サンプル勤務表の氏名と照合が合う
//   7. 契約条件は、サンプル勤務表の合計（154:45）で「精算幅の中・700,000円」になる
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  atRoot, mem, ctl, ai, call, OWNER, uid, T1, T2,
} from "./_officeharness.mjs";

const { default: indexApi } = await import(atRoot("api/office/index.js"));
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

// insert 文の（テーブル名 → 列名の並び）
const insertCols = (sql) => {
  const out = {};
  for (const m of sql.matchAll(/insert\s+into\s+public\.(\w+)\s*\(([^)]*)\)/gi)) out[m[1]] = m[2].split(",").map((s) => s.trim());
  return out;
};

await ok("seed は INSERT だけ：update・delete・truncate・drop・alter・create が、動く部分に無い", async () => {
  for (const w of ["update", "delete", "truncate", "drop", "alter", "create", "grant", "revoke", "storage\\.objects", "net\\.http"]) {
    assert.ok(!new RegExp(`\\b${w}\\b`, "i").test(SEED_CODE), `seed に ${w} がある`);
  }
  const t = insertCols(SEED_CODE);
  assert.deepEqual(Object.keys(t).sort(), ["gw_employees", "gw_site_contract_terms", "gw_site_contracts"]);
  assert.equal((SEED_CODE.match(/insert\s+into/gi) || []).length, 3, "INSERT はちょうど3本");
});

await ok("固定 id が seed と cleanup で同じ。UUID の形で、実在する行とぶつからないよう固定してある", async () => {
  for (const id of [EMP, CON, TERMS]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.ok(SEED.includes(id), `seed に ${id}`);
    assert.ok(CLEAN.includes(id), `cleanup に ${id}`);
  }
  assert.ok(!/gen_random_uuid|uuid_generate/i.test(SEED_CODE), "id を毎回変えない");
});

await ok("名前はすべて【Office Phase3 TEST】で始まる（社員・客先・メモ）", async () => {
  assert.ok(SEED_CODE.includes(`v_tag    constant text := '${TAG}'`));
  assert.match(SEED_CODE, /values \(v_emp, v_tenant, v_tag \|\| 'テスト 太郎'/);
  assert.match(SEED_CODE, /v_tag \|\| 'テスト客先'/);
  assert.match(SEED_CODE, /v_tag \|\| 'Office の操作確認用/);
});

await ok("社員行に メール・ログイン・入社日・区分の細工 を入れない。契約は終了日なし・単価なし・更新確認済み", async () => {
  const cols = insertCols(SEED_CODE);
  for (const banned of ["email", "user_id", "joined_on", "left_on", "employment_type", "manager_id", "partner_company_id"]) {
    assert.ok(!cols.gw_employees.includes(banned), `gw_employees に ${banned} を入れない`);
  }
  assert.deepEqual(cols.gw_employees, ["id", "tenant_id", "display_name", "department", "status", "employee_kind"]);
  assert.match(SEED_CODE, /'active', 'proper'\)/);
  // 現場契約：unit_price は null、period_to は null、renewal_status は confirmed（45日前のタスクを作らない）
  const con = SEED_CODE.match(/insert into public\.gw_site_contracts[\s\S]*?;\s*\n/i)[0];
  assert.match(con, /period_from, period_to,\s*\n\s*unit_price, renewal_status, note/);
  assert.match(con, /date '2026-04-01', null,\s*\n\s*null, 'confirmed'/);
});

await ok("月次進捗・提出ファイル・勤務表・操作履歴は、seed で作らない（画面の操作で作られる）", async () => {
  for (const t of ["gw_billing_progress", "gw_submissions", "gw_timesheets", "gw_timesheet_days", "gw_office_events", "gw_activity_log", "gw_partner_companies", "gw_contracts"]) {
    assert.ok(!new RegExp(`insert\\s+into\\s+public\\.${t}\\b`, "i").test(SEED_CODE), `${t} に入れない`);
  }
});

await ok("メール・Slack・通知・Webhook の語が、動く部分に無い（seed・cleanup とも）", async () => {
  for (const s of [SEED_CODE, CLEAN_CODE]) assert.ok(!/mail|slack|notify|push|webhook|http/i.test(s.replace(/starts_with/gi, "")), "送信につながる語がある");
});

await ok("seed の安全装置：105〜107 が無ければ止まる／tenant は名簿にちょうど1つのときだけ自動／二重に作らない", async () => {
  assert.match(SEED_CODE, /to_regclass\('public\.gw_site_contract_terms'\) is null or to_regclass\('public\.gw_timesheets'\) is null/);
  assert.match(SEED_CODE, /count\(distinct tenant_id\)[\s\S]*?if v_n <> 1 then\s+raise exception/);
  assert.match(SEED_CODE, /テストデータは、すでに入っています/);
  assert.match(SEED_CODE, /^do \$\$/m, "1つの DO ブロック（途中で失敗したら何も残らない）");
});

await ok("cleanup が消すのは、固定 id のテスト行だけ：delete は3文。where が固定 id・タグで縛られている。storage.objects は読むだけ", async () => {
  const dels = [...CLEAN_CODE.matchAll(/delete\s+from\s+public\.(\w+)([\s\S]*?);/gi)];
  assert.deepEqual(dels.map((m) => m[1]), ["gw_activity_log", "gw_office_events", "gw_employees"]);
  for (const m of dels) assert.match(m[2], /\bwhere\b/i, `${m[1]} の delete に where がある`);
  assert.match(dels[1][2], /employee_id = v_emp or site_contract_id = v_con/);
  assert.match(dels[2][2], /where id = v_emp and starts_with\(display_name, v_tag\)/);
  assert.ok(!/delete\s+from\s+storage/i.test(CLEAN_CODE), "Storage は SQL から消さない");
  assert.ok(!/\b(truncate|drop|alter|update)\b/i.test(CLEAN_CODE), "cleanup に update・truncate・drop・alter が無い");
  // 固定 id の社員を消せば、連鎖で現場契約・契約条件・月次進捗・提出ファイル・勤務表・日別が消える（外部キー）
  const mig = ["105_office_timesheet_base", "106_office_contract_terms", "107_office_timesheets"].map((f) => fs.readFileSync(atRoot(`db/${f}.sql`), "utf8")).join("\n");
  assert.match(mig, /site_contract_id\s+uuid not null references public\.gw_site_contracts\(id\) on delete cascade/);
  assert.match(mig, /employee_id\s+uuid not null references public\.gw_employees\(id\) on delete cascade/);
  assert.match(mig, /timesheet_id\s+uuid not null references public\.gw_timesheets\(id\) on delete cascade/);
});

await ok("cleanup が何も消さずに止まる条件：名前が違う・ログインが紐づく・別の契約がある・Storage にファイルが残っている", async () => {
  assert.match(CLEAN_CODE, /if not starts_with\(v_name, v_tag\) then\s+raise exception/);
  assert.match(CLEAN_CODE, /if v_user is not null then\s+raise exception/);
  assert.match(CLEAN_CODE, /employee_id = v_emp and id <> v_con\)\s+then\s+raise exception/);
  assert.match(CLEAN_CODE, /storage\.objects where bucket_id = \$1 and starts_with\(name, \$2\)/);
  assert.match(CLEAN_CODE, /v_tenant::text \|\| '\/' \|\| v_emp::text \|\| '\/'/, "Storage の場所は tenant/社員id/（api/office/timesheet.js の保存先と同じ）");
  // 実際のアップロード先の形と同じか
  const api = fs.readFileSync(atRoot("api/office/timesheet.js"), "utf8");
  assert.match(api, /`\$\{ctx\.tenantId\}\/\$\{k\.employeeId\}\/\$\{submissionId\}\.\$\{ext\}`/);
});

// ---- 同じ値を偽の DB に入れて、API に通す ---------------------------------------------------------------
const M = "2026-10";
function seedLikeSql() {
  mem.reset();
  ctl.who = OWNER; ctl.aal = "aal2";
  ai.calls.length = 0; ai.reply = null;
  mem.rows.gw_employees = [
    { id: EMP, tenant_id: T1, display_name: `${TAG}テスト 太郎`, department: "Office Phase3 TEST", status: "active", employee_kind: "proper", partner_company_id: null },
    { id: uid(11), tenant_id: T1, display_name: "山田 花子", department: null, status: "active", employee_kind: "proper", partner_company_id: null },
  ];
  mem.rows.gw_site_contracts = [
    { id: CON, tenant_id: T1, employee_id: EMP, engagement_kind: "pp", site_company: `${TAG}テスト客先`, prime_company: null,
      period_from: "2026-04-01", period_to: null, unit_price: null, unit_price_type: "月額", renewal_status: "confirmed", note: `${TAG}Office の操作確認用` },
  ];
  mem.rows.gw_site_contract_terms = [
    { id: TERMS, tenant_id: T1, site_contract_id: CON, valid_from: "2026-04-01", valid_to: null, pricing_type: "monthly",
      sales_unit_price: "700000.00", purchase_unit_price: null, settlement_mode: "range", settle_min_minutes: 8400, settle_max_minutes: 10800,
      settle_unit_minutes: null, rounding_mode: null, rounding_scope: null, over_rate_per_hour: "4000.00", under_rate_per_hour: "3500.00",
      prorate: false, amount_rounding: "floor" },
  ];
}

await ok("/office の一覧（2026年10月）にテスト行が出る：勤務表待ち・PP・契約条件あり。9月にも出る（契約は4月から）", async () => {
  seedLikeSql();
  const r = await call(indexApi, `/api/office?month=${M}`);
  assert.equal(r.statusCode, 200);
  const row = r.body.rows.find((x) => x.employeeName.startsWith(TAG));
  assert.ok(row, "テスト行が一覧に出る");
  assert.equal(row.siteCompany, `${TAG}テスト客先`);
  assert.equal(row.kindLabel, "PP（自社）");
  assert.equal(row.stage, "timesheet", "現在工程は勤務表待ち");
  assert.equal(row.terms?.status, "ok", "契約条件が効いている");
  assert.equal(r.body.rows.length, 1, "他の人の契約は無い（この偽DBには、契約はテスト分だけ）");
  const sep = await call(indexApi, "/api/office?month=2026-09");
  assert.ok(sep.body.rows.some((x) => x.employeeName.startsWith(TAG)));
});

await ok("サンプル勤務表の氏名「テスト 太郎」と、登録名が照合で合う（氏名不一致の警告を出さない）。別人の名前は合わない", async () => {
  assert.equal(nameMatches("テスト 太郎", `${TAG}テスト 太郎`), true);
  assert.equal(nameMatches("テスト　太郎", `${TAG}テスト 太郎`), true, "全角スペースでも合う");
  assert.equal(nameMatches("山田 花子", `${TAG}テスト 太郎`), false);
});

await ok("契約条件は、サンプル勤務表の合計 154:45 で「精算幅の中・700,000円」。修正前の 138:45 は控除、185:00 は超過", async () => {
  seedLikeSql();
  const terms = termsForMonth([normalizeTerms(mem.rows.gw_site_contract_terms[0])], M);
  assert.equal(terms.status, "ok"); assert.equal(terms.partial, false);
  const a = settle({ terms, minutes: 154 * 60 + 45 });
  assert.equal(a.status, "calculated"); assert.equal(a.band, "within"); assert.equal(a.amount, 700000);
  const b = settle({ terms, minutes: 138 * 60 + 45 });     // 隠れた2日（16:00）が空のまま = 下限 140:00 に 1:15 足りない
  assert.equal(b.band, "under"); assert.equal(b.underMinutes, 75); assert.equal(b.amount, 695625);
  const c = settle({ terms, minutes: 185 * 60 });
  assert.equal(c.band, "over"); assert.equal(c.amount, 720000);
  // サンプルの正解合計と同じ数字か
  const exp = JSON.parse(fs.readFileSync(atRoot("test/fixtures/office-timesheet/expected.json"), "utf8"));
  assert.equal(exp.totalWorkedMin, 154 * 60 + 45);
  assert.equal(exp.employee, "テスト 太郎");
  assert.equal(exp.month, M);
});

await ok("他社（別 tenant）のテスト行は、この会社の一覧に出ない", async () => {
  seedLikeSql();
  mem.rows.gw_employees.push({ id: uid(13), tenant_id: T2, display_name: "他社の人", status: "active", employee_kind: "proper", partner_company_id: null });
  mem.rows.gw_site_contracts.push({ id: uid(23), tenant_id: T2, employee_id: uid(13), engagement_kind: "pp", site_company: "他社の客先", period_from: "2026-01-01", period_to: null, renewal_status: "pending" });
  const r = await call(indexApi, `/api/office?month=${M}`);
  assert.equal(r.body.rows.length, 1);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
