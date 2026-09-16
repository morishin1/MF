// 保存期限と削除、MF給与の取込CSV。
//
// ■ 何を守るか
//   1. 期限は「起点 ＋ 月数」。起点が来ていない人には期限が無い
//   2. 月末の足し算で日付が飛ばない（1/31 に1か月 → 2/28）
//   3. 消すものが無い人は一覧に出ない
//   4. 自動削除は、付けた種別だけ
//   5. 削除は、消したものと同じ数だけ記録が残る
//   6. CSV に、出さないと決めた個人情報が混ざらない
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const R = await import(join(ROOT, "lib/retention.js"));
const P = await import(join(ROOT, "lib/payroll-csv.js"));

let pass = 0, fail = 0;
const ok = async (name, fn) => {
  try { await fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};

console.log("\n=== 保存期限と削除 ===\n");
console.log("— 期限の出し方 —");

await ok("種別は5つ。履歴書・本人確認・口座・契約・届出", () => {
  assert.deepEqual(R.RETENTION_KEYS, ["resume", "identity", "bank", "contract", "profile"]);
});

await ok("月を足す。月末を越えたら、その月の末日", () => {
  assert.equal(R.addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(R.addMonths("2026-03-15", 12), "2027-03-15");
  assert.equal(R.addMonths("2026-12-01", 1), "2027-01-01");
  assert.equal(R.addMonths("", 3), null);
});

await ok("既定に、会社の上書きを重ねる", () => {
  const rules = R.rulesWith([{ kind: "resume", months: 12, auto_delete: true }]);
  const resume = rules.find((r) => r.key === "resume");
  assert.equal(resume.months, 12);
  assert.equal(resume.autoDelete, true);
  assert.equal(resume.defaultMonths, 36);
  // 上書きしていない種別は既定のまま
  assert.equal(rules.find((r) => r.key === "contract").months, 60);
  assert.equal(rules.find((r) => r.key === "contract").autoDelete, false);
});

await ok("在籍中の人には、退職起点の期限が付かない", () => {
  const rules = R.rulesWith([]);
  const people = [{ id: "e1", name: "山田", leftOn: null, completedOn: "2026-04-01",
                    counts: { resume: 2, identity: 1, bank: 1, contract: 1, profile: 1 } }];
  const s = R.scheduleOf(rules, people, "2026-09-16");
  // 退職起点（履歴書・口座・契約・届出）は出ない。完了起点の本人確認だけ
  assert.deepEqual(s.map((x) => x.kind), ["identity"]);
  assert.equal(s[0].dueOn, "2027-04-01");
  assert.equal(s[0].expired, false);
});

await ok("消すものが無い種別は出さない", () => {
  const people = [{ id: "e1", name: "山田", leftOn: "2020-03-31", completedOn: "2019-04-01",
                    counts: { resume: 0, identity: 0, bank: 0, contract: 0, profile: 0 } }];
  assert.deepEqual(R.scheduleOf(R.rulesWith([]), people, "2026-09-16"), []);
});

await ok("期限を過ぎたものは expired。日数も出す", () => {
  const people = [{ id: "e1", name: "山田", leftOn: "2020-03-31", completedOn: null,
                    counts: { resume: 1, identity: 0, bank: 1, contract: 0, profile: 0 } }];
  const s = R.scheduleOf(R.rulesWith([]), people, "2026-09-16");
  assert.equal(s.length, 2);
  assert.ok(s.every((x) => x.expired));
  assert.ok(s[0].daysLeft < 0);
  // 期限の早い順
  assert.ok(s[0].dueOn <= s[1].dueOn);
});

await ok("自動削除は、付けた種別だけ true", () => {
  const rules = R.rulesWith([{ kind: "bank", months: 12, auto_delete: true }]);
  const people = [{ id: "e1", name: "山田", leftOn: "2020-03-31", completedOn: null,
                    counts: { resume: 1, identity: 0, bank: 1, contract: 0, profile: 0 } }];
  const s = R.scheduleOf(rules, people, "2026-09-16");
  assert.equal(s.find((x) => x.kind === "bank").autoDelete, true);
  assert.equal(s.find((x) => x.kind === "resume").autoDelete, false);
});

await ok("消すものの数は、書類・口座・契約から数える", () => {
  const c = R.countTargets({
    files: [{ item_key: "doc_resume" }, { item_key: "doc_pension" }, { item_key: "doc_contract" }],
    profile: { bank_number: "123", address: "東京都" },
    contracts: [{ status: "signed" }],
  });
  assert.equal(c.resume, 1);
  assert.equal(c.identity, 1);
  assert.equal(c.bank, 1);
  assert.equal(c.contract, 2);       // 書類1 ＋ 契約書1
  assert.equal(c.profile, 1);
});

await ok("口座も住所も無ければ、数えない", () => {
  const c = R.countTargets({ files: [], profile: { status: "draft" }, contracts: [] });
  assert.equal(c.bank, 0);
  assert.equal(c.profile, 0);
});

console.log("— 消すとき —");

/** 消す先の偽の Supabase。消した行と、残した記録を見る */
function fakeDb(seed) {
  const db = { ...seed, removed: [] };
  const storage = { from: () => ({ remove: async (paths) => { db.removed.push(...paths); return { error: null }; } }) };
  const table = (name) => {
    const f = [];
    const rows = () => (db[name] || []).filter((r) => f.every(([k, v]) =>
      (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
    const q = {
      select() { return q; },
      eq(k, v) { f.push([k, v]); return q; },
      in(k, v) { f.push([k, v]); return q; },
      limit() { return q; },
      order() { return q; },
      maybeSingle: () => Promise.resolve({ data: rows()[0] || null, error: null }),
      single: () => Promise.resolve({ data: rows()[0] || null, error: null }),
      then: (fn) => Promise.resolve({ data: rows(), error: null }).then(fn),
      insert(row) {
        db[name] = (db[name] || []).concat([].concat(row));
        return { then: (fn) => Promise.resolve({ data: row, error: null }).then(fn) };
      },
      update(patch) {
        const g = [];
        const r = {
          eq: (k, v) => { g.push([k, v]); return r; },
          then: (fn) => {
            for (const row of (db[name] || []).filter((x) => g.every(([k, v]) => x[k] === v))) {
              Object.assign(row, patch);
            }
            return Promise.resolve({ data: [], error: null }).then(fn);
          },
        };
        return r;
      },
      delete() {
        const g = [];
        const r = {
          eq: (k, v) => { g.push([k, v]); return r; },
          then: (fn) => {
            const hit = (db[name] || []).filter((x) => g.every(([k, v]) => x[k] === v));
            db[name] = (db[name] || []).filter((x) => !hit.includes(x));
            return Promise.resolve({ data: hit, error: null }).then(fn);
          },
        };
        return r;
      },
    };
    return q;
  };
  return { sb: { from: table, storage }, db };
}

const seed = () => ({
  gw_employees: [{ id: "e1", tenant_id: "t1", display_name: "山田 太郎" }],
  gw_procedures: [{ id: "p1", tenant_id: "t1", employee_id: "e1" }],
  gw_procedure_items: [
    { id: "i1", procedure_id: "p1", item_key: "doc_resume", title: "履歴書" },
    { id: "i2", procedure_id: "p1", item_key: "doc_pension", title: "年金手帳" },
  ],
  gw_procedure_files: [
    { id: "f1", item_id: "i1", filename: "rireki.pdf", storage_path: "t1/hr/f1.pdf" },
    { id: "f2", item_id: "i2", filename: "nenkin.jpg", storage_path: "t1/hr/f2.jpg" },
  ],
  gw_onboard_profiles: [{ id: "pf1", employee_id: "e1", bank_number: "1234567",
                          bank_name: "みずほ", address: "東京都", phone: "090" }],
  gw_sign_requests: [{ id: "s1", tenant_id: "t1", employee_id: "e1", title: "雇用契約書",
                       pdf_path: "t1/esign/s1.pdf", signed_pdf_path: "t1/esign/s1s.pdf",
                       body_snapshot: "本文", status: "signed" }],
  gw_doc_orders: [{ id: "o1", tenant_id: "t1", employee_id: "e1", title: "依頼", file_path: "t1/o1.pdf" }],
  gw_retention_log: [],
});

await ok("履歴書を消すと、実体も行も消えて、記録が1行残る", async () => {
  const { sb, db } = fakeDb(seed());
  const r = await R.deleteFor(sb, { tenantId: "t1", employeeId: "e1", kind: "resume",
                                    actor: { id: "u1", name: "事務" }, reason: "manual" });
  assert.equal(r.deleted, 1);
  assert.equal(r.log, 1);
  assert.deepEqual(db.removed, ["t1/hr/f1.pdf"]);
  assert.equal(db.gw_procedure_files.length, 1);          // 年金手帳は残る
  assert.equal(db.gw_retention_log.length, 1);
  assert.equal(db.gw_retention_log[0].subject_name, "山田 太郎");
  assert.equal(db.gw_retention_log[0].label, "rireki.pdf");
  assert.equal(db.gw_retention_log[0].reason, "manual");
});

await ok("口座は、口座欄だけ空にする（住所は残す）", async () => {
  const { sb, db } = fakeDb(seed());
  const r = await R.deleteFor(sb, { tenantId: "t1", employeeId: "e1", kind: "bank",
                                    actor: null, reason: "expired" });
  assert.equal(r.deleted, 1);
  const pf = db.gw_onboard_profiles[0];
  assert.equal(pf.bank_number, null);
  assert.equal(pf.bank_name, null);
  assert.equal(pf.address, "東京都", "住所まで消してはいけない");
  assert.equal(db.gw_retention_log[0].target, "profile:bank");
  assert.equal(db.gw_retention_log[0].deleted_by, null, "自動削除は実行者なし");
});

await ok("届出を消すと、住所も口座も空になる", async () => {
  const { sb, db } = fakeDb(seed());
  await R.deleteFor(sb, { tenantId: "t1", employeeId: "e1", kind: "profile", actor: null, reason: "expired" });
  const pf = db.gw_onboard_profiles[0];
  assert.equal(pf.address, null);
  assert.equal(pf.bank_number, null);
  assert.equal(pf.phone, null);
});

await ok("契約書は、PDFを消して行は残す（締結した事実は消さない）", async () => {
  const { sb, db } = fakeDb(seed());
  const r = await R.deleteFor(sb, { tenantId: "t1", employeeId: "e1", kind: "contract",
                                    actor: { id: "u1", name: "事務" }, reason: "manual" });
  assert.ok(db.removed.includes("t1/esign/s1.pdf"));
  assert.ok(db.removed.includes("t1/esign/s1s.pdf"));
  assert.equal(db.gw_sign_requests.length, 1, "行は残す");
  assert.equal(db.gw_sign_requests[0].pdf_path, null);
  assert.equal(db.gw_sign_requests[0].status, "signed", "締結の記録は残す");
  assert.match(db.gw_sign_requests[0].body_snapshot, /削除しました/);
  assert.equal(db.gw_doc_orders[0].file_path, null);
  assert.equal(r.log, db.gw_retention_log.length);
});

await ok("知らない種別では何もしない", async () => {
  const { sb, db } = fakeDb(seed());
  const r = await R.deleteFor(sb, { tenantId: "t1", employeeId: "e1", kind: "nothing", actor: null });
  assert.equal(r.deleted, 0);
  assert.equal(db.removed.length, 0);
  assert.ok(r.errors.length);
});

console.log("\n=== MF給与の取込CSV ===\n");

const row = () => ({
  employee: { id: "e1", employee_code: "E-01", display_name: "山田 太郎",
              email: "yamada@8grp.co.jp", department: "営業", position: "主任",
              employment_type: "正社員", joined_on: "2026-10-01" },
  profile: {
    name_kana: "ヤマダ タロウ", birth_date: "1995-04-01", postal_code: "100-0001",
    address: "東京都千代田区1-1", commute_cost: 12000,
    bank_name: "みずほ銀行", bank_branch: "東京営業部", bank_type: "普通",
    bank_number: "1234567", bank_holder: "ヤマダ タロウ",
    pension_number: "1234-567890", employment_ins_number: "1234-567890-1",
    has_dependents: true, dependents: [{ name: "山田 花子" }, { name: "山田 一郎" }],
    // 出さないと決めたもの
    phone: "090-1111-2222", emg_name: "山田 母", emg_relation: "母", emg_phone: "090-3333-4444",
    commute_from: "新宿駅", commute_route: "新宿→東京", dependents_note: "来月から同居",
    greeting: "よろしくお願いします",
  },
  contract: { wage_type: "月給", wage_amount: 300000 },
});

await ok("氏名は姓と名に分ける（全角の空白でも）", () => {
  assert.deepEqual(P.splitName("山田 太郎"), ["山田", "太郎"]);
  assert.deepEqual(P.splitName("山田　太郎"), ["山田", "太郎"]);
  assert.deepEqual(P.splitName("山田"), ["山田", ""]);
  assert.deepEqual(P.splitName(""), ["", ""]);
});

await ok("見出しと値の数が合う", () => {
  const csv = P.buildCsv([row()]);
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].split(",").length, P.HEADERS.length);
  assert.equal(lines[1].split(",").length, P.HEADERS.length);
});

await ok("必要な値が入る", () => {
  const csv = P.buildCsv([row()]);
  for (const v of ["山田", "太郎", "ヤマダ", "1995/04/01", "2026/10/01", "みずほ銀行",
                   "1234567", "1234-567890", "300000", "12000"]) {
    assert.ok(csv.includes(v), `${v} が入っていません`);
  }
  // 扶養親族数は最後の列。人数だけ（家族の氏名は出さない）
  const cells = csv.replace(/^﻿/, "").trim().split("\r\n")[1].split(",");
  assert.equal(cells[P.HEADERS.indexOf("扶養親族数")], "2");
});

await ok("出さないと決めた個人情報は、1つも入らない", () => {
  const csv = P.buildCsv([row()]);
  for (const v of ["090-1111-2222", "山田 母", "090-3333-4444", "新宿駅", "新宿→東京",
                   "来月から同居", "よろしくお願いします"]) {
    assert.ok(!csv.includes(v), `${v} が混ざっています`);
  }
  // 扶養家族の氏名も出さない（人数だけ）
  assert.ok(!csv.includes("山田 花子"));
});

await ok("マイナンバーの列は無い", () => {
  assert.ok(!P.HEADERS.some((h) => /マイナンバー|個人番号/.test(h)));
});

await ok("式に見えるセルは、そのまま実行されない形にする", () => {
  const r = row();
  r.employee.display_name = "=cmd|calc 太郎";
  const csv = P.buildCsv([r]);
  assert.ok(csv.includes("'=cmd|calc"), "先頭の = を守っていません");
});

await ok("区切りや改行が入っても、列がずれない", () => {
  const r = row();
  r.profile.address = "東京都, 千代田区\n1-1";
  const csv = P.buildCsv([r]);
  assert.ok(csv.includes('"東京都, 千代田区\n1-1"'));
});

await ok("Excel で開けるよう、先頭に BOM を付ける", () => {
  assert.ok(P.buildCsv([]).startsWith("﻿"));
});

await ok("ファイル名に氏名を入れない", () => {
  const name = P.csvFileName("2026-09-16", 3);
  assert.equal(name, "mf_payroll_20260916_3.csv");
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
