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
  canOffice, canKeiei, isOwner,
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

{
  // どの権限を、どう組み合わせても、owner を持たない限り経営には入れない
  const all = ["hr", "manager", "recruiter", "sales", "finance", "it", "labor_advisor"];
  let leak = null;
  for (let mask = 0; mask < 1 << all.length && !leak; mask++) {
    const roles = all.filter((_, i) => mask & (1 << i));
    for (const extra of [{}, { isAdmin: true }, { isAdmin: true, isHr: true }]) {
      if (canKeiei({ roles, ...extra }) || isOwner({ roles, ...extra })) { leak = JSON.stringify({ roles, ...extra }); break; }
    }
  }
  check(!leak, `owner を持たない組み合わせ（${1 << all.length} 通り × 管理者の有無）は、経営に入れない${leak ? `（入れてしまう: ${leak}）` : ""}`);
  // 逆に、owner は、ほかの権限が無くても、どのツールにも入れる
  check(canRecruit({ roles: ["owner"] }) && canSell({ roles: ["owner"] }) && canOffice({ roles: ["owner"] }) && canKeiei({ roles: ["owner"] }),
    "owner だけを持つ人は、全ツールに入れる");
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
  check(/import \{ accessOf(, isHrOf)? \} from "\.\.\/lib\/gw\.js"/.test(src), "api/me は lib/gw.js の accessOf を使う");
  // アプリ利用権限（apps）も一緒に渡す（入口は gw_app_grants、中身は内部ロール。db/119）
  check(/access:\s*accessOf\(\{\s*isAdmin,\s*isHr:\s*gw\.isHr,\s*roles:\s*gw\.roles,\s*apps:\s*gw\.apps\s*\}\)/.test(src), "access を返している");
}

console.log("\n— 画面はサーバの判定を使う（役割を並べ直さない） —");
{
  const layout = read("js/layout.js");
  check(/hr:\s*me\?\.access \? Boolean\(me\.access\.recruit\)/.test(layout), "ヘッダーの HR は access.recruit");
  check(/sales:\s*me\?\.access \? Boolean\(me\.access\.sell\)/.test(layout), "ヘッダーの Sales は access.sell");
  check(/keiei:\s*me\?\.access \? Boolean\(me\.access\.keiei\)/.test(layout), "ヘッダーの経営は access.keiei（経営者だけ）");
  // access が無い古い応答のときの代替（役割で数える）も、サーバと同じ並び
  check(/\["owner", "manager", "hr", "recruiter"\]\.some/.test(layout), "access が無いときの HR の代替も owner / manager / hr / recruiter");
  check(/keiei:[^\n]*: gwRoles\.includes\("owner"\)/.test(layout), "access が無いときの経営の代替も owner だけ");
  check(/\$\{shortcutsHtml\(shows,/.test(layout), "メンバーの画面・メンバー表示でも同じ条件で出す");
  check(/const canRecruit = me\?\.access \? Boolean\(me\.access\.recruit\)/.test(read("js/hr-layout.js")),
    "/hr の入口は access.recruit");
  check(/const canSell = me\?\.access \? Boolean\(me\.access\.sell\)/.test(read("js/sales-layout.js")),
    "/sales の入口は access.sell");

  // Office：ヘッダーの近道は、Office に入れる人（サーバの access：officeHr／officeFinance／office のどれか）だけ。
  // 行き先も access で決める（人事・労務／経理・事務の人は Office のホーム、月末月初業務だけの人は /office/）。役割名は並べ直さない
  check(/officeEntry: me\?\.appRole !== "sr" && \(officeHr \|\| officeFinance \|\| Boolean\(me\?\.access\?\.office\) \|\| Boolean\(me\?\.access\?\.officeApp\)\)/.test(layout)
      && /if \(t\.key === "office"\) return Boolean\(shows\.officeEntry\);/.test(layout),
    "ヘッダーの Office は、サーバの access（officeApp＝Office の入口・officeHr・officeFinance・office）のどれかがある人だけ");
  // 担当別の入口は、サーバの判定（access.officeHr / officeFinance）。予備は管理者だけ。役割名は並べ直さない
  check(/const flag = \(k\) => me\?\.appRole !== "sr" && \(k in acc \? Boolean\(acc\[k\]\) : adminApp\)/.test(layout),
    "Office の人事・労務／経理・事務は access.officeHr / officeFinance（予備は管理者だけ）");
  const officeLayout = read("js/office-layout.js").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  // /office/ の入口は access.office だけ。枠は KPLayout（入れない人はホームへ送り返す）
  check(/function allows\(me\) \{ return Boolean\(me\?\.access\?\.office\); \}/.test(officeLayout)
      && /KPLayout\.init\(\{ active: ACTIVE\[opts\.active\] \|\| ACTIVE\.monthly, access: opts\.access \|\| "office" \}\)/.test(officeLayout),
    "/office の入口は access.office だけで決め（ホームだけ access を渡す）、無ければ KPLayout がホームへ送り返す");
  // /office/ 配下の各画面の入口：ホームは Office に入れる人の全員、それ以外（月次業務・請求・支払・勤務表・契約条件）は access.office
  {
    const home = read("office/index.html");
    check(/O\.init\(\{ active: "home", access: \["officeHr", "officeFinance", "office", "officeApp"\] \}\)/.test(home), "Office ホームは officeApp（入口）・officeHr・officeFinance・office のどれかで入れる");
    // ホームは、担当でない API を呼ばない（403 の行を作らない）
    check(/can\.hr \? safe\(API\.swr\(HR_KEY, \(\) => API\.hrList\(\)/.test(home) && /can\.app \? safe\(API\.swr\(OFFICE_KEY/.test(home)
      && /can\.fin && !can\.app \? safe\(API\.swr\(`office:closing:\$\{closingMonth\}`, \(\) => API\.closing\(/.test(home), "Office ホームは、担当の API だけ呼ぶ");
    // 枠を待たずに取りにいく（warm）のも、同じ担当の人だけ
    check(/KPLayout\.warm\("officeHr", HR_KEY, \(\) => API\.hrList\(\)\)/.test(home) && /API\.warm\(OFFICE_KEY, fetchOffice, O\.allows\)/.test(home),
      "Office ホームの先読みも、担当の人だけ（人事・労務＝officeHr、月末月初業務＝access.office）");
    for (const f of ["office/monthly.html", "office/billing.html", "office/timesheet.html", "office/terms.html"]) {
      const src = read(f);
      check(/O\.init\(\{ active: "\w+" \}\)/.test(src) && !/O\.init\(\{[^}]*access/.test(src), `${f} は access.office で入口を守る（access を広げない）`);
    }
  }
  check(!/["'](owner|manager|finance|hr|sales|recruiter)["']/.test(officeLayout), "/office の画面に役割名を書かない");
  check(!/appRole|isAdmin|\badmin\b|\bowner\b|ADMIN_NAV|GWへ戻る|of-back/.test(officeLayout), "/office の画面は、appRole・admin・owner で枠を分けない（専用ヘッダー・GWへ戻るを持たない）");
  // Office の左メニューの項目は、サーバの access のキー（または管理者・経営者の adminApp）だけで出し分ける
  const officeBlock = layout.slice(layout.indexOf("const OFFICE_TOP = ["), layout.indexOf("// 経営（チーム・会社全体の管理、判断）"));
  const whens = [...new Set([...officeBlock.matchAll(/when:\s*"(\w+)"/g)].map((m) => m[1]))];
  const allowed = ["officeHr", "officeFinance", "officeApp", "officeEntry", "officeMonthly", "adminApp"];
  // 月次業務の入口は、中のタブのどれかに入れる人（月末月初業務＝officeApp、月次締め・月初作業管理＝officeFinance）
  check(/officeMonthly: officeFinance \|\| Boolean\(me\?\.access\?\.office\),/.test(layout), "月次業務の入口（officeMonthly）＝ officeFinance か access.office");
  check(whens.length > 0 && whens.every((k) => allowed.includes(k)), `Office の左メニューの when は access 由来のキーだけ（いま ${whens.join("・")}）`);

  // 予備の判定（access が無い古い応答のときだけ使う）が、サーバの役割の並びとずれていない
  // （責任者が HR に入れる、という変更のあとに、画面だけ旧仕様のまま残さない）
  const fallback = (key) => {
    const m = layout.match(new RegExp(`${key}:\\s*me\\?\\.access \\? Boolean\\(me\\.access\\.\\w+\\)\\s*:\\s*\\[([^\\]]*)\\]`));
    return m ? [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]).sort().join(",") : null;
  };
  check(fallback("hr") === [...HR_ROLES].sort().join(","), `layout.js の予備判定（HR）= ${HR_ROLES.join("・")}（いま ${fallback("hr")}）`);
  check(fallback("sales") === [...SALES_ROLES].sort().join(","), `layout.js の予備判定（Sales）= ${SALES_ROLES.join("・")}（いま ${fallback("sales")}）`);
  const hrLayout = read("js/hr-layout.js");
  const hrFb = (hrLayout.match(/const canRecruit = me\?\.access \? Boolean\(me\.access\.recruit\)\s*:([^;]*);/) || [])[1] || "";
  check(HR_ROLES.every((r) => hrFb.includes(`"${r}"`)) && [...hrFb.matchAll(/"(\w+)"/g)].length === HR_ROLES.length,
    `hr-layout.js の予備判定 = ${HR_ROLES.join("・")}（いま ${[...hrFb.matchAll(/"(\w+)"/g)].map((x) => x[1]).join("・")}）`);
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
  const owner = last("gw_is_owner");
  // 最新の定義（db/094・db/099・db/103）が、lib/gw.js の HR_ROLES / SALES_ROLES / OFFICE_ROLES と同じ役割の並び
  const rolesIn = (body) => [...body.matchAll(/gw_has_role\(p_tenant,\s*'(\w+)'\)/g)].map((m) => m[1]).sort();
  check(/'hr'/.test(isHr) && /'owner'/.test(isHr) && /is_tenant_staff/.test(isHr), "gw_is_hr（人事の台帳など）は変えていない");
  check(rolesIn(rec).join(",") === [...HR_ROLES].sort().join(","),
    `gw_is_recruiting = ${HR_ROLES.join("・")}（いま ${rolesIn(rec).join("・")}）`);
  // Sales は db/130 から「owner ロール または Sales のアプリ権限」（lib/gw.js canSell と同じ）。
  // ロールの並び（SALES_ROLES）ではなく、API の判定そのものとそろっていることを見る
  const appsIn = (body) => [...body.matchAll(/gw_has_app\(p_tenant,\s*'(\w+)'\)/g)].map((m) => m[1]).sort();
  check(rolesIn(sales).join(",") === "owner" && appsIn(sales).join(",") === "sales",
    `gw_is_sales = owner ロール または Sales のアプリ権限（いま ロール ${rolesIn(sales).join("・") || "なし"}／アプリ ${appsIn(sales).join("・") || "なし"}）`);
  check(canSell({ roles: ["owner"], apps: [] }) && canSell({ roles: [], apps: ["sales"] })
        && !canSell({ roles: ["manager"], apps: [] }) && !canSell({ roles: ["sales"], apps: [] }),
    "API の canSell も同じ（経営者・Sales アプリは通る／manager・sales のロールだけでは通らない）");
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

  // Phase 3 の新しい表（105〜107）：読み取りだけを Office 権限に絞る。書き込みは API（service_role）だけ
  const phase3 = {
    "db/105_office_timesheet_base.sql": ["gw_office_events"],
    "db/106_office_contract_terms.sql": ["gw_site_contract_terms"],
    "db/107_office_timesheets.sql": ["gw_timesheets", "gw_timesheet_days"],
  };
  for (const [file, tables] of Object.entries(phase3)) {
    // コメント（「--」と「comment on … '説明文';」）は SQL の実体ではないので外して見る
    const sql = read(file).replace(/--.*$/gm, "").replace(/comment\s+on\s[^;]*;/gi, "");
    for (const t of tables) {
      check(new RegExp(`alter table public\\.${t}\\s+enable row level security;`).test(sql), `${file}：${t} の RLS を有効にしている`);
      const re = new RegExp(`create policy ${t}_office_select on public\\.${t}\\s+for select using \\(public\\.gw_is_office\\(tenant_id\\)\\);`);
      check(re.test(sql), `${file}：${t} は Office 権限（gw_is_office）の読み取りポリシーだけ`);
    }
    check(!/for (all|insert|update|delete)/i.test(sql), `${file} は書き込みのポリシーを足さない（書き込みは API だけ）`);
    check(!/gw_is_hr|is_tenant_staff|gw_is_recruiting|gw_is_sales|gw_is_keiei/.test(sql), `${file} は人事・営業・経営・会計の管理者に広げない`);
    check(!/\bunit_price\b|settlement_condition|alter table public\.gw_site_contracts/i.test(sql),
      `${file} は gw_site_contracts（unit_price・settlement_condition）に触れない`);
  }
  // 経営（/keiei）と、owner の付与・剥奪。owner だけ。管理者・人事を含めない（db/099）
  check(rolesIn(owner).join(",") === [...KEIEI_ROLES].sort().join(","),
    `gw_is_owner = ${KEIEI_ROLES.join("・")}（いま ${rolesIn(owner).join("・")}）`);
  check(!/is_tenant_staff|gw_is_hr/.test(owner), "gw_is_owner に会計の管理者・人事を含めない");
  // 給与を見られる人（db/100）。段階1は gw_is_hr、段階2は gw_is_owner に差し替える。どちらの段階でも
  // 採用担当・責任者・経理・IT・営業は入らない（gw_is_recruiting を使わない）
  const salaryFn = last("gw_can_see_salary");
  check(/gw_is_hr|gw_is_owner/.test(salaryFn) && !/gw_is_recruiting|gw_is_sales|gw_is_office|'manager'|'recruiter'/.test(salaryFn),
    "gw_can_see_salary は、人事・管理者・経営者（段階1）か経営者だけ（段階2）。採用担当・責任者を含めない");
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
  for (const f of walk("api/sales").filter((p) => !/\/r\.js$/.test(p) && !/\/timerex\/webhook\.js$/.test(p))) {
    check(/canSell/.test(read(f)), `${f} は canSell で判定`);
  }
  // Office（/api/office/*）は canAccessOffice。単価・請求額・支払を返すので、例外は作らない。
  // api/office/ はこれから作るので、無いあいだは何も見ない（作った瞬間から全ファイルが対象になる）
  if (existsSync(join(ROOT, "api/office"))) {
    for (const f of walk("api/office")) {
      const src = read(f);
      check(/canAccessOffice/.test(src), `${f} は canAccessOffice で判定（例外なし）`);
      // 二段階認証（MFA）は要求しない（2026-09-30 の決定）。権限（canAccessOffice）だけで通す。
      // requireMfa は強制日（2026-10-01）から strict でなくても aal2 を求めるので、置かない（lib/mfa.js の説明）
      check(!/requireMfa|lib\/mfa\.js/.test(src.replace(/^\s*\/\/.*$/gm, "")), `${f} は MFA を要求しない（requireMfa を使わない）`);
      check(/if \(!canAccessOffice\(ctx\)\) return json\(res, 403, \{ error: "forbidden" \}\)/.test(src), `${f} は権限が無ければ 403 forbidden`);
      // 何が許可されているかの読み方：他の系統の判定（HR・Sales・管理者）で通していない
      check(!/canRecruit|canSell|canAccessHr|canAccessSales|canManageHr/.test(src), `${f} は HR・Sales・人事の判定を混ぜない`);
    }
  }
}

console.log("\n— /keiei が呼ぶ API は、経営者だけ（二段階認証は要らない）—");
{
  const walk = (d) => readdirSync(join(ROOT, d)).flatMap((f) => {
    const p = `${d}/${f}`;
    return statSync(join(ROOT, p)).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
  });
  const files = walk("api/keiei");
  check(files.length > 0, `api/keiei に API がある（${files.length}本）`);

  // 入口は lib/keiei-gate.js ただ1つ。canKeiei（owner だけ）だけ。二段階認証（aal2）は要らない（任意のセキュリティ設定）
  const gate = read("lib/keiei-gate.js");
  check(/canKeiei\(ctx\)/.test(gate), "lib/keiei-gate.js は canKeiei（owner だけ）で判定");
  check(!/requireMfa|lib\/mfa\.js|aal2|aalOf/.test(gate.replace(/\/\/.*$/gm, "")), "lib/keiei-gate.js は、二段階認証（aal2）を求めない（経営者のロールだけで通す）");
  check(/if \(!canKeiei\(ctx\)\)[^\n]*403/.test(gate), "lib/keiei-gate.js は、経営者でない人に 403 を返す");
  check(!/isAdmin|canManageHr|canRecruit|canSell|canOffice/.test(gate.replace(/\/\/.*$/gm, "")),
    "lib/keiei-gate.js は、経営者以外の判定を混ぜない（下位の権限を継承しない）");

  for (const f of files) {
    const s = read(f);
    const code = s.replace(/\/\/.*$/gm, "");
    check(/await requireKeiei\(req, res\)/.test(code), `${f} は入口 requireKeiei（経営者だけ）を通る`);
    // 入口より前に、データを読まない（応答を返す前に、何かを読む・書くことがない）
    const head = code.slice(0, code.indexOf("requireKeiei(req, res)"));
    check(!/\.from\(|admin\(\)|userClient\(/.test(head.slice(head.indexOf("export default"))), `${f} は、入口より前に DB へ触れない`);
    check(!/isAdmin|canManageHr|canRecruit|canSell|canOffice/.test(code),
      `${f} は、経営者以外の判定を混ぜない（下位の権限を継承しない）`);
  }
}

console.log("\n— ヘッダーの切替は、データ駆動（TOOLS）で、access と同じキー —");
{
  const layout = read("js/layout.js");
  const block = layout.match(/const TOOLS = \[([\s\S]*?)\n  \];/)?.[1] || "";
  const tools = [...block.matchAll(/\{\s*key:\s*"(\w+)",\s*href:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*short:\s*"([^"]+)",\s*icon:\s*"(\w+)",\s*ready:\s*(true|false)/g)]
    .map((m) => ({ key: m[1], href: m[2], label: m[3], ready: m[6] === "true" }));
  check(tools.map((t) => t.key).join(",") === "hr,sales,office,keiei", `ツールの並びは HR・Sales・Office・経営（いま ${tools.map((t) => t.key)}）`);
  // ヘッダーは「採用HR｜Sales｜Office｜経営（＋⚙管理）」。Office は1つの名前に1つだけ
  // （月次業務は Office の中の機能で、ヘッダーに別名で出さない）
  check(tools.map((t) => t.label).join(",") === "採用HR,Sales,Office,経営", `表示は「採用HR ｜ Sales ｜ Office ｜ 経営」（いま ${tools.map((t) => t.label)}）`);
  check(!/月次業務/.test(block), "ヘッダーのツール定義に「月次業務」を置かない（Officeの中の機能）");
  const accessKeys = new Set(Object.keys(accessOf({ roles: [] })));
  const keyOfAccess = { hr: "recruit", sales: "sell", office: "office", keiei: "keiei" };
  check(tools.every((t) => accessKeys.has(keyOfAccess[t.key])), "TOOLS の各ツールに、サーバの access（accessOf）のキーがある");
  // Office は実装された（/office/）ので ready:true。未実装のツールを足すときは ready:false で足す（存在しないリンクを出さない）
  check(tools.every((t) => t.ready), "HR・Sales・Office・経営は ready:true（実装済み）");
  check(/TOOLS\.filter\(\(t\) => t\.ready && toolVisible\(t, shows\)\)/.test(layout), "出すのは ready かつ サーバの判定（shows）が true のツールだけ");
  // Office：/office に入れる人（access.office）か、管理画面を開ける管理者。入口は人によって変える（押して403を作らない）
  // Office：/office に入れる人（access.office）だけに出し、行き先は役割に関係なく /office/（管理者だけ別の入口、をやめた）
  check(/\boffice: Boolean\(me\?\.access\?\.office\),/.test(layout) && !/office: Boolean\(me\?\.access\?\.office\) \|\|/.test(layout),
    "Office の表示は access.office だけ（管理者かどうかで出し分けない）");
  const officeTool = block.match(/\{\s*key:\s*"office"[^}]*\}/)?.[0] || "";
  check(officeTool && !/altHref/.test(officeTool), "Office の定義に、役割別の行き先（altHref）を持たせない");
  check(!/t\.key === "office"\) return shows\.adminApp/.test(layout) && !/admin-dashboard/.test(officeTool), "Office の行き先を、管理者（adminApp）で分けない");
  check(tools.find((t) => t.key === "keiei")?.href === "/keiei/", "経営 → /keiei/");
}

console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
