// 採用HR（/hr）・Sales（/sales）・Office（/office）の「入れるか」が、どこでも同じ条件か。
//
// ヘッダーに近道が出たのに、開いたら 403（または /hr から追い返される）を作らない。
// Office は単価・請求額・支払を扱うので、隠すだけでなく API と DB でも同じ条件で守る。
// そのために、次の4か所がそろっていることを機械で見る。
//   1. サーバの判定（lib/gw.js canAccessHr / canAccessSales / canAccessOffice と、それを返す accessOf）
//   2. /api/me が返す access（ヘッダーの近道は、この値だけで出し分ける）
//   3. /hr・/sales の画面の入口（js/hr-layout.js・js/sales-layout.js）
//   4. DB の関数（gw_is_recruiting・gw_is_sales・gw_is_office）と、各 API が使う判定
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  accessOf, canRecruit, canSell, canDecideHire, canForceAttack,
  canAccessHr, canAccessSales, canAccessOffice, canAccessKeiei,
  HR_ROLES, SALES_ROLES, OFFICE_ROLES, KEIEI_ROLES, RECRUIT_ROLES,
} from "../lib/gw.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

console.log("— 指示どおりの条件（権限表） —");
// 正式な設定元はメンバー管理の「社内権限」（gw_role_grants）。
//   HR: owner / manager / hr / recruiter
//   Sales: owner / manager / sales
//   Office: owner / manager / finance（新しいロールは作らず、既存の「経理」を使う）
// 会計側の管理者（isAdmin）・IT・管理（it）・社労士だけでは、どれにも入れない。
// 経営者（owner）と責任者（manager）は3つすべて使える
const cases = [
  //  ctx                                       HR     Sales  Office
  [{ isAdmin: true, roles: [] },               false, false, false, "会計側の管理者だけ（社内権限なし）"],
  [{ isAdmin: true, isHr: true, roles: [] },   false, false, false, "会計側の管理者（isHr 扱い）でも社内権限なしなら入れない"],
  [{ roles: ["it"] },                          false, false, false, "IT・管理だけ"],
  [{ isAdmin: true, roles: ["it"] },           false, false, false, "会計の管理者＋IT・管理"],
  [{ roles: ["labor_advisor"] },               false, false, false, "社労士（HR全体にも入れない。共有された手続きだけ）"],
  [{ roles: [] },                              false, false, false, "一般メンバー"],
  [{ roles: ["it", "labor_advisor"] },         false, false, false, "IT・社労士"],
  [{ roles: ["owner"], isHr: true },           true,  true,  true,  "owner（経営者）は3つとも"],
  [{ roles: ["manager"] },                     true,  true,  true,  "manager（責任者）は3つとも"],
  [{ roles: ["hr"], isHr: true },              true,  false, false, "hr（人事）はHRだけ"],
  [{ roles: ["recruiter"] },                   true,  false, false, "recruiter（採用担当）はHRだけ"],
  [{ roles: ["sales"] },                       false, true,  false, "sales（営業担当）はSalesだけ"],
  [{ roles: ["finance"] },                     false, false, true,  "finance（経理）はOfficeだけ"],
  [{ isAdmin: true, roles: ["finance"] },      false, false, true,  "会計の管理者＋経理 → Officeだけ"],
  [{ isAdmin: true, roles: ["recruiter"] },    true,  false, false, "会計の管理者＋採用担当 → HRだけ"],
  [{ roles: ["hr", "finance"] },               true,  false, true,  "人事＋経理 → HR と Office（ヘッダー: ホーム｜HR｜Office）"],
  [{ roles: ["sales", "finance"] },            false, true,  true,  "営業担当＋経理 → Sales と Office（ヘッダー: ホーム｜Sales｜Office）"],
  [{ roles: ["recruiter", "sales"] },          true,  true,  false, "採用担当＋営業担当"],
  [{ roles: ["it", "finance", "labor_advisor"] }, false, false, true, "IT・経理・社労士 → 経理の分だけ Office"],
];
const mark = (b) => (b ? "○" : "×");
for (const [ctx, hr, sell, office, label] of cases) {
  const a = accessOf(ctx);
  check(a.recruit === hr && a.sell === sell && a.office === office,
    `${label} → HR ${mark(hr)} / Sales ${mark(sell)} / Office ${mark(office)}`
    + `（いま ${mark(a.recruit)} / ${mark(a.sell)} / ${mark(a.office)}）`);
  const full = { isAdmin: false, isHr: false, roles: [], ...ctx };
  check(a.recruit === Boolean(canAccessHr(full)) && a.sell === Boolean(canAccessSales(full))
      && a.office === Boolean(canAccessOffice(full)),
    `${label}: accessOf は canAccessHr / canAccessSales / canAccessOffice と同じ`);
  check(Boolean(canRecruit(full)) === a.recruit && Boolean(canSell(full)) === a.sell,
    `${label}: 前の呼び名 canRecruit / canSell も同じ結果`);
}
check(RECRUIT_ROLES === HR_ROLES, "RECRUIT_ROLES（前の呼び名）は HR_ROLES と同じ並び");
check(!OFFICE_ROLES.includes("it") && !OFFICE_ROLES.includes("hr") && !OFFICE_ROLES.includes("labor_advisor"),
  "Office の役割に IT・管理・人事・社労士を含めない（金額情報を見せない）");
check(OFFICE_ROLES.includes("finance") && !OFFICE_ROLES.includes("office"),
  "Office 専用のロールは作らない（既存の「経理」= finance を使う）");

console.log("\n— 経営 /keiei は経営者だけ（責任者にも公開しない） —");
// 4つの条件を混同しない：責任者は HR・Sales・Office を使えるが、/keiei には入れない
for (const [ctx, want, label] of [
  [{ roles: ["owner"], isHr: true },               true,  "経営者"],
  [{ roles: ["manager"] },                         false, "責任者（HR・Sales・Office は使えるが /keiei は不可）"],
  [{ roles: ["finance"] },                         false, "経理"],
  [{ roles: ["hr"], isHr: true },                  false, "人事"],
  [{ roles: ["sales"] },                           false, "営業担当"],
  [{ roles: ["it", "labor_advisor"] },             false, "IT・社労士"],
  [{ isAdmin: true, roles: [] },                   false, "会計側の管理者だけ"],
  [{ roles: [] },                                  false, "一般メンバー"],
]) {
  const a = accessOf(ctx);
  check(a.keiei === want, `${label} → /keiei ${mark(want)}（いま ${mark(a.keiei)}）`);
  check(Boolean(canAccessKeiei({ isAdmin: false, roles: [], ...ctx })) === a.keiei, `${label}: accessOf.keiei は canAccessKeiei と同じ`);
}
check(KEIEI_ROLES.length === 1 && KEIEI_ROLES[0] === "owner", "KEIEI_ROLES は owner だけ");
check(!KEIEI_ROLES.includes("manager"), "責任者（manager）を KEIEI_ROLES に入れない");
{
  // 責任者は3つ使えて /keiei だけ使えない、という組を、1つの表として固定する
  const m = accessOf({ roles: ["manager"] });
  check(m.recruit && m.sell && m.office && !m.keiei, "責任者：HR・Sales・Office ○、/keiei ×");
  const o = accessOf({ roles: ["owner"] });
  check(o.recruit && o.sell && o.office && o.keiei, "経営者：HR・Sales・Office・/keiei すべて ○");
}

console.log("\n— 採用判断・強行は、使える人の中の上乗せ権限 —");
check(!canDecideHire({ isAdmin: true, roles: [] }), "会計の管理者だけでは採用判断もできない");
check(canDecideHire({ isAdmin: false, roles: ["owner"] }), "経営者は採用判断ができる");
check(!canDecideHire({ isAdmin: false, roles: ["recruiter"] }), "採用担当だけでは採用判断はできない");
check(!canDecideHire({ isAdmin: false, roles: ["manager"] }), "責任者はHRに入れるが、採用判断まではできない");
check(!canForceAttack({ isAdmin: true, roles: [] }), "会計の管理者だけでは強行アタックもできない");
check(canForceAttack({ isAdmin: false, roles: ["owner"] }), "経営者は強行アタックができる");

console.log("\n— /api/me がサーバの判定をそのまま返す —");
{
  const src = read("api/me.js");
  check(/import \{ accessOf \} from "\.\.\/lib\/gw\.js"/.test(src), "api/me は lib/gw.js の accessOf を使う");
  check(/access:\s*accessOf\(\{\s*isAdmin,\s*isHr:\s*gw\.isHr,\s*roles:\s*gw\.roles\s*\}\)/.test(src), "access を返している");
}

console.log("\n— 画面はサーバの判定を使う（役割を並べ直さない） —");
{
  const layout = read("js/layout.js");
  check(/hr:\s*me\?\.access \? Boolean\(me\.access\.recruit\)/.test(layout), "ヘッダーの採用HRは access.recruit");
  check(/sales:\s*me\?\.access \? Boolean\(me\.access\.sell\)/.test(layout), "ヘッダーの Sales は access.sell");
  check(/\$\{shortcutsHtml\(shows\)\}/.test(layout), "メンバーの画面・メンバー表示でも同じ条件で出す");
  check(/const canRecruit = me\?\.access \? Boolean\(me\.access\.recruit\)/.test(read("js/hr-layout.js")),
    "/hr の入口は access.recruit");
  check(/const canSell = me\?\.access \? Boolean\(me\.access\.sell\)/.test(read("js/sales-layout.js")),
    "/sales の入口は access.sell");
}

console.log("\n— DB の関数も同じ役割 —");
{
  const sql = readdirSync(join(ROOT, "db")).filter((f) => /^\d{3}_.*\.sql$/.test(f) && f !== "000_install_fresh.sql")
    .sort().map((f) => read(`db/${f}`)).join("\n");
  const last = (name) => {
    const all = [...sql.matchAll(new RegExp(`function public\\.${name}\\(p_tenant uuid\\)[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, "g"))];
    return all.length ? all[all.length - 1][1] : "";
  };
  const isHr = last("gw_is_hr");
  const rec = last("gw_is_recruiting");
  const sales = last("gw_is_sales");
  const office = last("gw_is_office");
  // 最新の定義（db/094・db/099）が、lib/gw.js の HR_ROLES / SALES_ROLES / OFFICE_ROLES と同じ役割の並び
  const rolesIn = (body) => [...body.matchAll(/gw_has_role\(p_tenant,\s*'(\w+)'\)/g)].map((m) => m[1]).sort();
  check(/'hr'/.test(isHr) && /'owner'/.test(isHr) && /is_tenant_staff/.test(isHr), "gw_is_hr（人事の台帳など）は変えていない");
  check(rolesIn(rec).join(",") === [...HR_ROLES].sort().join(","),
    `gw_is_recruiting = ${HR_ROLES.join("・")}（いま ${rolesIn(rec).join("・")}）`);
  check(rolesIn(sales).join(",") === [...SALES_ROLES].sort().join(","),
    `gw_is_sales = ${SALES_ROLES.join("・")}（いま ${rolesIn(sales).join("・")}）`);
  check(office !== "" && rolesIn(office).join(",") === [...OFFICE_ROLES].sort().join(","),
    `gw_is_office = ${OFFICE_ROLES.join("・")}（いま ${rolesIn(office).join("・") || "未定義"}）`);
  check(!/is_tenant_staff|gw_is_hr/.test(rec), "gw_is_recruiting に会計の管理者（is_tenant_staff）を含めない");
  check(!/is_tenant_staff/.test(sales), "gw_is_sales に会計の管理者（is_tenant_staff）を含めない");
  check(!/is_tenant_staff|gw_is_hr/.test(office), "gw_is_office に会計の管理者・人事（is_tenant_staff / gw_is_hr）を含めない");
  check(!/'it'|'labor_advisor'/.test(rec + sales + office), "IT・管理（it）・社労士はどの入口にも入っていない");
  const keiei = last("gw_is_keiei");
  check(keiei !== "" && rolesIn(keiei).join(",") === [...KEIEI_ROLES].sort().join(","),
    `gw_is_keiei = ${KEIEI_ROLES.join("・")}（いま ${rolesIn(keiei).join("・") || "未定義"}）`);
  check(!/is_tenant_staff|gw_is_hr|gw_is_office|'manager'/.test(keiei), "gw_is_keiei に責任者・人事・会計の管理者を含めない");

  // Office（/api/office）が読む表：Office 権限の読み取りだけが足されている（書き込み・人事は足さない）
  const office100 = read("db/100_office_access.sql").replace(/--.*$/gm, "");
  for (const t of ["gw_site_contracts", "gw_billing_progress", "gw_submissions", "gw_partner_companies"]) {
    const re = new RegExp(`create policy ${t}_office_select on public\\.${t}\\s+for select using \\(public\\.gw_is_office\\(tenant_id\\)\\);`);
    check(re.test(office100), `${t}：Office 権限（gw_is_office）の読み取りポリシーがある`);
  }
  check(!/for (all|insert|update|delete)/i.test(office100), "db/100 は書き込みのポリシーを足さない（読み取りだけ）");
  check(!/gw_is_hr|is_tenant_staff|gw_is_recruiting/.test(office100), "db/100 は人事・会計の管理者に広げない（方針A）");
}

console.log("\n— /hr・/sales が呼ぶ API は、同じ判定で守られている —");
{
  const walk = (d) => readdirSync(join(ROOT, d)).flatMap((f) => {
    const p = `${d}/${f}`;
    return statSync(join(ROOT, p)).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
  });
  // 応募者・面談・内定（/hr の画面が使うもの）は canRecruit
  for (const f of walk("api/hr").filter((p) => /api\/hr\/(applicants|interviews|offers)\//.test(p))) {
    const s = read(f);
    // 候補者に送る公開リンク（ログイン不要）は対象外
    if (/public/.test(f)) continue;
    // 本採用へ進める（社員化）は、採用HRの中でも社長・管理者だけ（canDecideHire）。
    // 画面（hr/applicants.html）も canDecide のときだけボタンを出すので、403 にはならない
    if (/advance\.js$/.test(f)) {
      check(/canDecideHire/.test(s), `${f} は canDecideHire（社長・管理者だけ。画面でもボタンを出し分け）`);
      continue;
    }
    check(/canRecruit/.test(s), `${f} は canRecruit で判定`);
  }
  // 営業（/sales の画面が使うもの）は canSell。クリック計測のリダイレクト（公開）は対象外
  for (const f of walk("api/sales").filter((p) => !/\/r\.js$/.test(p))) {
    check(/canSell/.test(read(f)), `${f} は canSell で判定`);
  }
  // Office（/api/office/*）は canAccessOffice。単価・請求額・支払を返すので、例外は作らない。
  // api/office/ はこれから作るので、無いあいだは何も見ない（作った瞬間から全ファイルが対象になる）
  if (existsSync(join(ROOT, "api/office"))) {
    for (const f of walk("api/office")) {
      const src = read(f);
      check(/canAccessOffice/.test(src), `${f} は canAccessOffice で判定（例外なし）`);
      // 単価・請求額・支払を扱うので、強制日を待たず最初から二段階認証（lib/mfa.js の strict）
      check(/requireMfa\(req, res, ctx, user, \{ strict: true \}\)/.test(src), `${f} は requireMfa(…, { strict: true }) を通る`);
      // 権限の判定が、MFA より先（権限のない人を、MFA の登録画面へ誘導しない）
      check(src.indexOf("canAccessOffice(ctx)") !== -1 && src.indexOf("canAccessOffice(ctx)") < src.indexOf("requireMfa("),
        `${f} は権限判定（canAccessOffice）のあとに MFA を見る`);
      // 何が許可されているかの読み方：他の系統の判定（HR・Sales・管理者）で通していない
      check(!/canRecruit|canSell|canAccessHr|canAccessSales|canManageHr/.test(src), `${f} は HR・Sales・人事の判定を混ぜない`);
    }
  }
}

console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
