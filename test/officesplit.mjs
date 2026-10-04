// Office の権限を、業務ごとに分ける（人事・労務 officeHr／経理・事務 officeFinance）。
//
//   officeHr      … 人事・労務。管理者・経営者・人事（hr）
//   officeFinance … 経理・事務。管理者・経営者・経理（finance）
//   office        … 月末月初（/office/）。経営者・責任者・経理。意味は変えない（canAccessOffice）
//
// 画面・API・DB が同じ基準かを、4か所で見る。
//   1. サーバの判定（lib/gw.js）と /api/me の access
//   2. 各 API の入口（担当の判定関数）
//   3. 画面（admin-*.html の入口と、左メニューのグループの when）
//   4. DB（db/115_office_split.sql）
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { accessOf, canOfficeHr, canOfficeFinance, canOfficeAny, canAccessOffice, canManageHr } from "../lib/gw.js";
import { canReviewExpense, canReviewRequest } from "../lib/expenses.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log("  ok", name); }
  catch (e) { fail++; console.log("  NG", name, "\n     ", e.message); }
};
const mark = (b) => (b ? "○" : "×");

console.log("— 1. 誰がどの業務に入れるか（サーバの判定）—");

// gwContext が作る形: isHr は hr / owner のとき true。isAdmin は会計側の管理者（memberships の admin / staff）
const cases = [
  //  ctx                                                  HR     経理   月末月初  header(Office)
  [{ roles: [] },                                          false, false, false, "一般メンバー"],
  [{ roles: ["hr"], isHr: true },                          true,  false, false, "人事（hr）だけ → 人事・労務だけ。Office は出る"],
  [{ roles: ["finance"] },                                 false, true,  true,  "経理（finance）だけ → 経理・事務（と月末月初）だけ"],
  [{ roles: ["manager"] },                                 false, false, true,  "責任者（manager）→ 月末月初（/office/）だけ。Office は出る"],
  [{ roles: ["recruiter"] },                               false, false, false, "採用担当だけ"],
  [{ roles: ["sales"] },                                   false, false, false, "営業担当だけ"],
  [{ roles: ["it"] },                                      false, false, false, "IT・管理だけ"],
  [{ roles: ["labor_advisor"] },                           false, false, false, "社労士だけ"],
  [{ roles: ["owner"], isHr: true },                       true,  true,  true,  "経営者（owner）→ 全部"],
  [{ isAdmin: true, roles: [] },                           true,  true,  false, "会計側の管理者（admin/staff）→ 人事・労務と経理・事務の両方。月末月初は社内権限が無いので入れない"],
  [{ roles: ["hr", "finance"], isHr: true },               true,  true,  true,  "人事＋経理 → 両方"],
  [{ roles: ["hr", "manager"], isHr: true },               true,  false, true,  "人事＋責任者 → 人事・労務と月末月初"],
  [{ roles: ["recruiter", "sales", "it"] },                false, false, false, "採用担当＋営業＋IT → どれも入れない"],
];
for (const [ctx, hr, fin, app, label] of cases) {
  ok(`${label}  → 人事 ${mark(hr)} / 経理 ${mark(fin)} / 月末月初 ${mark(app)}`, () => {
    const a = accessOf(ctx);
    assert.equal(a.officeHr, hr, "officeHr");
    assert.equal(a.officeFinance, fin, "officeFinance");
    assert.equal(a.office, app, "office（月末月初）");
    const full = { isAdmin: false, isHr: false, roles: [], ...ctx };
    assert.equal(canOfficeHr(full), hr);
    assert.equal(canOfficeFinance(full), fin);
    assert.equal(canOfficeAny(full), hr || fin);
    assert.equal(Boolean(canAccessOffice(full)), app, "canAccessOffice の意味は変えない");
  });
}

ok("accessOf が返す officeHr / officeFinance は、API が使う判定（canOfficeHr / canOfficeFinance）そのもの", () => {
  const roles = ["hr", "finance", "manager", "owner", "recruiter", "sales", "it", "labor_advisor"];
  for (let mask = 0; mask < 1 << roles.length; mask++) {
    const r = roles.filter((_, i) => mask & (1 << i));
    for (const isAdmin of [false, true]) {
      const ctx = { isAdmin, isHr: r.includes("hr") || r.includes("owner"), roles: r };
      const a = accessOf(ctx);
      assert.equal(a.officeHr, canOfficeHr(ctx), JSON.stringify(ctx));
      assert.equal(a.officeFinance, canOfficeFinance(ctx), JSON.stringify(ctx));
    }
  }
});

ok("人事の権限は変えていない: canOfficeHr は、これまでの canManageHr と同じ（管理者・人事・経営者）", () => {
  for (const ctx of [{ roles: ["hr"], isHr: true }, { isAdmin: true, roles: [] }, { roles: ["owner"], isHr: true }, { roles: ["finance"] }, { roles: ["manager"] }, { roles: [] }]) {
    const full = { isAdmin: false, isHr: false, roles: [], ...ctx };
    assert.equal(canOfficeHr(full), Boolean(canManageHr(full)), JSON.stringify(ctx));
  }
});

ok("責任者（manager）は officeHr にも officeFinance にも入らない（権限拡張しない）", () => {
  const m = { isAdmin: false, isHr: false, roles: ["manager"] };
  assert.equal(canOfficeHr(m), false);
  assert.equal(canOfficeFinance(m), false);
});

console.log("\n— 2. 経費は経理・事務、休暇・稟議は人事・労務（承認の判定）—");

ok("経費の承認: 管理者・経営者・経理。人事（hr）だけの人は外れる", () => {
  const f = (ctx) => canReviewExpense({ isAdmin: false, isHr: false, roles: [], ...ctx });
  assert.equal(f({ roles: ["finance"] }), true);
  assert.equal(f({ roles: ["owner"], isHr: true }), true);
  assert.equal(f({ isAdmin: true }), true);
  assert.equal(f({ roles: ["hr"], isHr: true }), false, "人事は経理・事務に入らない");
  assert.equal(f({ roles: ["manager"] }), false);
});

ok("休暇・稟議の承認: 管理者・経営者・人事（これまでどおり）。経理だけの人は外れる", () => {
  const f = (ctx) => canReviewRequest({ isAdmin: false, isHr: false, roles: [], ...ctx });
  assert.equal(f({ roles: ["hr"], isHr: true }), true);
  assert.equal(f({ roles: ["owner"], isHr: true }), true);
  assert.equal(f({ isAdmin: true }), true);
  assert.equal(f({ roles: ["finance"] }), false, "経理は人事・労務に入らない");
});

console.log("\n— 3. API の入口が、担当の判定を使っている —");

const gateOf = (p) => strip(read(p));
// 経理・事務のAPI: canOfficeFinance。人事の判定（canManageHr）で守らない
for (const f of ["api/closing/index.js", "api/billing-submission/index.js", "api/billing-submission/file.js",
  "api/expenses/settings.js", "api/templates/index.js", "api/library/index.js"]) {
  ok(`${f} は経理・事務（canOfficeFinance）。人事（canManageHr）では守らない`, () => {
    const src = gateOf(f);
    assert.match(src, /canOfficeFinance\(ctx\)/);
    assert.doesNotMatch(src, /canManageHr/);
  });
}
for (const f of ["api/expenses/index.js", "api/expenses/decide.js", "api/expenses/upload.js"]) {
  ok(`${f} は経費の承認（canReviewExpense ＝ 経理・事務）`, () => {
    const src = gateOf(f);
    assert.match(src, /canReviewExpense\(ctx\)/);
    assert.doesNotMatch(src, /canReviewRequest|canManageHr/);
  });
}
ok("lib/expenses.js: canReviewExpense は canOfficeFinance、canReviewRequest は canOfficeHr", () => {
  const src = gateOf("lib/expenses.js");
  assert.match(src, /export const canReviewExpense = \(ctx\) => canOfficeFinance\(ctx\)/);
  assert.match(src, /export const canReviewRequest = \(ctx\) => canOfficeHr\(ctx\)/);
});
for (const f of ["api/requests/index.js", "api/requests/decide.js"]) {
  ok(`${f} は休暇・稟議の承認（canReviewRequest ＝ 人事・労務）`, () => {
    const src = gateOf(f);
    assert.match(src, /canReviewRequest\(ctx\)/);
    assert.doesNotMatch(src, /canReviewExpense/);
  });
}
ok("api/billing-progress は共有データ（人事・労務／経理・事務のどちらか: canOfficeAny）", () => {
  assert.match(gateOf("api/billing-progress/index.js"), /!canOfficeAny\(ctx\)/);
});
// 人事・労務のAPIは、これまでどおり canManageHr（変えていない）
for (const f of ["api/hr/index.js", "api/timecard/index.js", "api/contracts/index.js", "api/sign/index.js", "api/employees/index.js", "api/requests/grants.js"]) {
  ok(`${f} は人事・労務のまま（canManageHr）`, () => {
    assert.match(gateOf(f), /canManageHr|isAdmin|canOfficeHr/);
  });
}
ok("経理・事務のAPIに、管理者・経営者・人事が通る道（isHr だけ）が残っていない", () => {
  for (const f of ["api/closing/index.js", "api/expenses/settings.js", "api/templates/index.js"]) {
    assert.doesNotMatch(gateOf(f), /ctx\.isHr/, f);
  }
});

console.log("\n— 4. 画面（admin-*.html）の入口と、左メニューのグループ —");

// layout.js から表を読む（navcheck.mjs と同じやり方。実際に評価して読む）
const layoutSrc = read("js/layout.js");
function tableOf(name, endMark) {
  const from = layoutSrc.indexOf(`const ${name} = [`);
  const to = layoutSrc.indexOf(endMark, from);
  if (from < 0 || to < 0) throw new Error(`${name} を読めません`);
  const body = layoutSrc.slice(from + `const ${name} = `.length, to);
  return Function(`"use strict"; return (${body.slice(0, body.lastIndexOf("];") + 1)});`)();
}
const OFFICE_GROUPS = tableOf("OFFICE_GROUPS", "\n  // 経営（チーム・会社全体の管理、判断）");
const OFFICE_TOP = tableOf("OFFICE_TOP", "\n  const OFFICE_GROUPS");

ok("左メニューの項目の when: 人事・労務は officeHr、経理・事務・社内文書は officeFinance、月末月初業務・請求・支払は officeApp、会計・お知らせ配信は adminApp", () => {
  const whenOf = (k) => OFFICE_GROUPS.flatMap((g) => g.items).find((i) => i.key === k)?.when;
  const tabWhen = (item, tab) => OFFICE_GROUPS.flatMap((g) => g.items).find((i) => i.key === item)?.tabs?.find((t) => t.key === tab)?.when;
  for (const g of OFFICE_GROUPS.filter((x) => x.key === "office-hr")) for (const i of g.items) assert.equal(i.when, "officeHr", i.key);
  // 月次業務は、中のタブのどれかに入れる人（月末月初業務＝officeApp、月次締め・月初作業管理＝officeFinance）
  assert.equal(whenOf("office_monthly"), "officeMonthly");
  assert.equal(tabWhen("office_monthly", "office_monthly"), "officeApp");
  assert.equal(tabWhen("office_monthly", "closing"), "officeFinance");
  assert.equal(tabWhen("office_monthly", "monthstart"), "officeFinance");
  assert.equal(whenOf("office_billing"), "officeApp");
  assert.equal(whenOf("expenses"), "officeFinance");
  assert.equal(whenOf("templates"), "officeFinance");
  assert.equal(whenOf("accounting"), "adminApp");
  assert.equal(whenOf("notices"), "adminApp");
  assert.equal(OFFICE_TOP[0].when, "officeEntry", "ホームは Office に入れる人（人事・労務／経理・事務／月末月初業務のどれか）");
});

const initOf = (file) => (read(file).match(/KPLayout\.init\(\{[\s\S]*?\}\)/) || [""])[0];
const accessOfPage = (file) => {
  const init = initOf(file);
  const m = init.match(/access:\s*(\[[^\]]*\]|"[^"]*")/);
  return m ? m[1].replace(/\s/g, "") : null;
};

ok("左メニューの各グループの画面は、そのグループの access で入口を守っている（出した入口が 403 にならない）", () => {
  const bad = [];
  for (const g of OFFICE_GROUPS) {
    for (const it of g.items) {
      // 管理者・経営者のままの項目（会計・お知らせ配信）は、画面も roles（admin/owner）のまま。
      // タブに when があれば、そのタブの画面はタブの when で守る（月次業務の中の月次締め・月初作業管理）
      const pages = [[it.href, it.when], ...(it.tabs || []).map((t) => [t.href, t.when || it.when])]
        .filter(([h]) => /^admin-[a-z-]+\.html/.test(h)).map(([h, w]) => [h.replace(/[?#].*$/, ""), w]);
      for (const [h, when] of new Map(pages)) {
        if (when === "adminApp") {
          if (!/roles:\s*\["admin",\s*"owner"\]/.test(initOf(h))) bad.push(`${h}: 管理者・経営者の画面のはずが roles が違う`);
          continue;
        }
        const want = `"${when}"`;
        if (accessOfPage(h) !== want) bad.push(`${h}: access が ${accessOfPage(h)}（${want} のはず）`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

ok("Office ホーム（/office/）は、人事・労務／経理・事務／月末月初業務のどれかで入れる。旧ダッシュボードは /office/ へ送る", () => {
  assert.match(read("office/index.html"), /O\.init\(\{ active: "home", access: \["officeHr", "officeFinance", "office"\] \}\)/);
  assert.match(read("admin-dashboard.html"), /location\.replace\("\/office\/"/);
});

ok("Office の画面に、役割（roles: admin/owner）だけの入口が残っていない（管理者・経営者のままの画面を除く）", () => {
  const adminOnly = new Set(["admin-notices.html", "admin-site-news.html"]);
  const bad = [];
  for (const g of OFFICE_GROUPS) for (const it of g.items) {
    for (const h of [it.href, ...(it.tabs || []).map((t) => t.href)].filter((x) => /^admin-[a-z-]+\.html/.test(x)).map((x) => x.replace(/[?#].*$/, ""))) {
      if (adminOnly.has(h)) continue;
      if (/roles:\s*\["admin",\s*"owner"\]/.test(initOf(h))) bad.push(h);
    }
  }
  assert.deepEqual(bad, []);
});

ok("Office ホームの数字は、担当の分だけ読む・出す（担当でないAPIを呼んで 403 の行を作らない）", () => {
  const src = read("office/index.html");
  assert.match(src, /hr: KPLayout\.hasAccess\(me, "officeHr"\)/);
  assert.match(src, /fin: KPLayout\.hasAccess\(me, "officeFinance"\)/);
  assert.match(src, /app: O\.allows\(me\)/);
  assert.match(src, /can\.hr \? safe\(API\.swr\(HR_KEY, \(\) => API\.hrList\(\)/);
  assert.match(src, /can\.fin && !can\.app \? safe\(API\.swr\(`office:closing:\$\{closingMonth\}`, \(\) => API\.closing\(closingMonth\)/);
  assert.match(src, /KPLayout\.warm\("officeHr", HR_KEY, \(\) => API\.hrList\(\)\)/);
  assert.match(src, /can\.app \? safe\(API\.swr\(OFFICE_KEY/);
  assert.match(src, /if \(can\.hr\) \{/);
  assert.match(src, /if \(can\.fin\) \{/);
  assert.match(src, /if \(can\.app && od\) \{/);
});

ok("Office は1つの左メニュー（ホーム／人事・労務／経理・事務／社内管理）。⚙管理は設定系だけ。/office/ も同じ枠（専用ヘッダー・GWへ戻るなし）", () => {
  assert.deepEqual(OFFICE_GROUPS.map((g) => g.label), ["人事・労務", "経理・事務", "社内管理"]);
  assert.equal(OFFICE_TOP[0].label, "ホーム");
  const lay = strip(read("js/layout.js"));
  // ⚙管理は管理者・経営者だけ、中身は設定系（SETTINGS_ITEMS）だけ。業務の入口は置かない
  assert.match(lay, /const showGear = showAdminTools;/);
  assert.match(lay, /\$\{SETTINGS_ITEMS\.map\(/);
  assert.doesNotMatch(lay, /ADMIN_CONSOLE/);
  assert.match(lay, /officeHr: officeHr,/);
  assert.match(lay, /officeFinance: officeFinance,/);
  // /office/ の画面は KPLayout（共通の枠）で描く。専用ヘッダー・GWへ戻るは持たない
  const ol = strip(read("js/office-layout.js"));
  assert.match(ol, /KPLayout\.init\(\{ active: ACTIVE\[opts\.active\] \|\| ACTIVE\.monthly, access: opts\.access \|\| "office" \}\)/);
  assert.doesNotMatch(ol, /GWへ戻る|of-back|of-bar|admin-/);
});

console.log("\n— 5. DB（db/115_office_split.sql）—");

const sql = strip(read("db/115_office_split.sql").replace(/^--.*$/gm, ""));
const fnBody = (name) => (sql.match(new RegExp(`function public\\.${name}\\(p_tenant uuid\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`)) || [])[1] || "";

ok("gw_is_office_finance = 管理者（is_tenant_staff）・経営者（owner）・経理（finance）。人事・責任者は含めない", () => {
  const b = fnBody("gw_is_office_finance");
  assert.match(b, /is_tenant_staff/);
  assert.match(b, /'owner'/);
  assert.match(b, /'finance'/);
  assert.doesNotMatch(b, /gw_is_hr|'hr'|'manager'/);
});
ok("gw_request_can_review は、これまでの gw_expense_can_review と同じ（管理者・人事・経営者）", () => {
  const b = fnBody("gw_request_can_review");
  assert.match(b, /is_tenant_staff/);
  assert.match(b, /gw_is_hr/);
  assert.match(b, /'owner'/);
});
ok("gw_expense_can_review は経理・事務の判定（gw_is_office_finance）に変わる", () => {
  assert.match(fnBody("gw_expense_can_review"), /gw_is_office_finance\(p_tenant\)/);
  assert.doesNotMatch(fnBody("gw_expense_can_review"), /gw_is_hr/);
});
ok("休暇・稟議の表（gw_requests・gw_leave_grants）は専用の判定へ。人事の権限は変わらない", () => {
  for (const p of ["gw_requests_select", "gw_requests_update", "gw_requests_delete", "gw_leave_grants_select"]) {
    const m = sql.match(new RegExp(`create policy ${p} on[\\s\\S]*?;`));
    assert.ok(m, `${p} が無い`);
    assert.match(m[0], /gw_request_can_review/, p);
    assert.doesNotMatch(m[0], /gw_expense_can_review/, p);
  }
  // 申請の判定を先に切り分けてから、経費の判定を切り替える（途中で人事の休暇・稟議が見えなくならない）
  assert.ok(sql.indexOf("create policy gw_requests_select") < sql.indexOf("replace function public.gw_expense_can_review") || sql.indexOf("gw_requests_select") < sql.lastIndexOf("function public.gw_expense_can_review"),
    "申請の切り分けが、経費の切り替えより先");
  assert.ok(/begin;/.test(sql) && /commit;/.test(sql), "1つのトランザクションの中");
});
ok("請求・社内文書・雛形の表は、経理・事務（gw_is_office_finance）。社員は公開済みの文書を読める", () => {
  for (const p of ["gw_billing_progress_finance", "gw_submission_links_finance", "gw_doc_templates_select", "gw_doc_templates_write", "gw_library_select", "gw_library_write"]) {
    const m = sql.match(new RegExp(`create policy ${p} on[\\s\\S]*?;`));
    assert.ok(m, `${p} が無い`);
    assert.match(m[0], /gw_is_office_finance/, p);
  }
  assert.match(sql.match(/create policy gw_library_select on[\s\S]*?;/)[0], /published and public\.gw_employee_id/, "公開済みは社員が読める");
});
ok("人事の台帳（gw_is_hr）・/office の読み取り（gw_is_office）は変えない。責任者は経理・事務に入れない", () => {
  assert.doesNotMatch(sql, /create or replace function public\.gw_is_hr|create or replace function public\.gw_is_office\b/);
  assert.doesNotMatch(sql, /'manager'/);
});

console.log(`\n合計 ${pass + fail} 件中 ${pass} 件 通過`);
process.exit(fail ? 1 : 0);
