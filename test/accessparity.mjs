// 業務ツール（HR・Sales・Office・経営）の「入れるか」が、どこでも同じ条件か。
//
//   HR     … owner / manager / hr / recruiter
//   Sales  … owner / manager / sales
//   Office … owner / manager / finance      （画面は未実装。判定だけ先に置く）
//   経営   … owner だけ                      （他の権限から自動で継承しない）
//
// ヘッダーに切替が出たのに、開いたら 403（または画面から追い返される）を作らない。
// そのために、次の4か所がそろっていることを機械で見る。
//   1. サーバの判定（lib/gw.js canRecruit / canSell / canOffice / canKeiei と、それを返す accessOf）
//   2. /api/me が返す access（ヘッダーの切替は、この値だけで出し分ける）
//   3. 画面の入口（js/layout.js の TOOLS・js/hr-layout.js・js/sales-layout.js・js/keiei-layout.js）
//   4. DB の関数（gw_is_recruiting・gw_is_sales・gw_is_office・gw_is_owner）と、各 API が使う判定
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  accessOf, canRecruit, canSell, canOffice, canKeiei, isOwner, canDecideHire, canForceAttack,
  RECRUIT_ROLES, SALES_ROLES, OFFICE_ROLES, KEIEI_ROLES,
} from "../lib/gw.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

console.log("— 指示どおりの条件 —");
// 正式な設定元はメンバー管理の「社内権限」（gw_role_grants）。
//   HR: owner / manager / hr / recruiter、Sales: owner / manager / sales、
//   Office: owner / manager / finance、経営: owner だけ。
// 会計側の管理者（isAdmin）・IT・管理（it）だけでは、どれにも入れない。
// 経営者（owner）は、全ツールに入れる（最上位）。下位の権限は、経営を継承しない
const cases = [
  // [ctx, HR, Sales, Office, 経営, label]
  [{ isAdmin: true, roles: [] }, false, false, false, false, "会計側の管理者だけ（社内権限なし）"],
  [{ isAdmin: true, isHr: true, roles: [] }, false, false, false, false, "会計側の管理者（isHr 扱い）でも社内権限なしなら入れない"],
  [{ roles: ["it"] }, false, false, false, false, "IT・管理だけ"],
  [{ isAdmin: true, roles: ["it"] }, false, false, false, false, "会計の管理者＋IT・管理"],
  [{ isAdmin: true, roles: ["recruiter"] }, true, false, false, false, "会計の管理者＋採用担当 → HRだけ"],
  [{ roles: ["owner"], isHr: true }, true, true, true, true, "owner（経営者）→ 全ツール"],
  [{ roles: ["hr"], isHr: true }, true, false, false, false, "hr（人事）→ HRだけ"],
  [{ roles: ["recruiter"] }, true, false, false, false, "recruiter（採用担当）→ HRだけ"],
  [{ roles: ["manager"] }, true, true, true, false, "manager（責任者）→ HR・Sales・Office（経営は入れない）"],
  [{ roles: ["sales"] }, false, true, false, false, "sales（営業担当）→ Salesだけ"],
  [{ roles: ["finance"] }, false, false, true, false, "finance（経理）→ Officeだけ"],
  [{ roles: ["recruiter", "sales"] }, true, true, false, false, "採用担当＋営業担当"],
  [{ roles: ["hr", "finance", "sales", "recruiter"], isAdmin: true, isHr: true }, true, true, true, false, "経営者以外の権限を全部集めても、経営には入れない"],
  [{ roles: ["owner", "hr"], isHr: true }, true, true, true, true, "owner＋hr（経営者は、ほかの権限を持っていても全ツール）"],
  [{ roles: [] }, false, false, false, false, "一般メンバー"],
  [{ roles: ["labor_advisor"] }, false, false, false, false, "社労士"],
  [{ roles: ["it", "labor_advisor"] }, false, false, false, false, "IT・社労士"],
];
const yn = (b) => (b ? "○" : "×");
for (const [ctx, hr, sell, office, keiei, label] of cases) {
  const a = accessOf(ctx);
  check(a.recruit === hr && a.sell === sell && a.office === office && a.keiei === keiei,
    `${label} → HR ${yn(hr)} / Sales ${yn(sell)} / Office ${yn(office)} / 経営 ${yn(keiei)}`
    + `（いま ${yn(a.recruit)} / ${yn(a.sell)} / ${yn(a.office)} / ${yn(a.keiei)}）`);
  const full = { isAdmin: false, isHr: false, roles: [], ...ctx };
  check(a.recruit === Boolean(canRecruit(full)) && a.sell === Boolean(canSell(full))
        && a.office === Boolean(canOffice(full)) && a.keiei === Boolean(canKeiei(full)),
    `${label}: accessOf は canRecruit / canSell / canOffice / canKeiei と同じ`);
}

console.log("\n— 経営者は最上位、経営は経営者だけ —");
check(JSON.stringify(KEIEI_ROLES) === JSON.stringify(["owner"]), `KEIEI_ROLES は owner だけ（いま ${KEIEI_ROLES}）`);
for (const [name, list] of [["HR", RECRUIT_ROLES], ["Sales", SALES_ROLES], ["Office", OFFICE_ROLES]]) {
  check(list.includes("owner"), `${name} は経営者（owner）を含む（経営者が入れなくなる制御にしない）`);
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
  check(/hr:\s*me\?\.access \? Boolean\(me\.access\.recruit\)/.test(layout), "ヘッダーの HR は access.recruit");
  check(/sales:\s*me\?\.access \? Boolean\(me\.access\.sell\)/.test(layout), "ヘッダーの Sales は access.sell");
  check(/office:\s*me\?\.access \? Boolean\(me\.access\.office\)/.test(layout), "ヘッダーの Office は access.office");
  check(/keiei:\s*me\?\.access \? Boolean\(me\.access\.keiei\)/.test(layout), "ヘッダーの経営は access.keiei（経営者だけ）");
  // access が無い古い応答のときの代替（役割で数える）も、サーバと同じ並び
  check(/\["owner", "manager", "hr", "recruiter"\]\.some/.test(layout), "access が無いときの HR の代替も owner / manager / hr / recruiter");
  check(/keiei:[^\n]*: gwRoles\.includes\("owner"\)/.test(layout), "access が無いときの経営の代替も owner だけ");
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
  const owner = last("gw_is_owner");
  // 最新の定義（db/094・db/103）が、lib/gw.js の RECRUIT_ROLES / SALES_ROLES / OFFICE_ROLES と同じ役割の並び
  const rolesIn = (body) => [...body.matchAll(/gw_has_role\(p_tenant,\s*'(\w+)'\)/g)].map((m) => m[1]).sort();
  check(/'hr'/.test(isHr) && /'owner'/.test(isHr) && /is_tenant_staff/.test(isHr), "gw_is_hr（人事の台帳など）は変えていない");
  check(rolesIn(rec).join(",") === [...RECRUIT_ROLES].sort().join(","),
    `gw_is_recruiting = ${RECRUIT_ROLES.join("・")}（いま ${rolesIn(rec).join("・")}）`);
  check(rolesIn(sales).join(",") === [...SALES_ROLES].sort().join(","),
    `gw_is_sales = ${SALES_ROLES.join("・")}（いま ${rolesIn(sales).join("・")}）`);
  check(!/is_tenant_staff|gw_is_hr/.test(rec), "gw_is_recruiting に会計の管理者（is_tenant_staff）を含めない");
  check(!/is_tenant_staff/.test(sales), "gw_is_sales に会計の管理者（is_tenant_staff）を含めない");
  check(!/'it'/.test(rec + sales + office), "IT・管理（it）はどれにも入っていない");
  check(rolesIn(office).join(",") === [...OFFICE_ROLES].sort().join(","),
    `gw_is_office = ${OFFICE_ROLES.join("・")}（いま ${rolesIn(office).join("・")}）`);
  check(!/is_tenant_staff|gw_is_hr/.test(office), "gw_is_office に会計の管理者（is_tenant_staff）を含めない");
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
  for (const f of walk("api/sales").filter((p) => !/\/r\.js$/.test(p))) {
    check(/canSell/.test(read(f)), `${f} は canSell で判定`);
  }
}

console.log("\n— /keiei が呼ぶ API は、経営者だけ・二段階認証つき —");
{
  const walk = (d) => readdirSync(join(ROOT, d)).flatMap((f) => {
    const p = `${d}/${f}`;
    return statSync(join(ROOT, p)).isDirectory() ? walk(p) : p.endsWith(".js") ? [p] : [];
  });
  const files = walk("api/keiei");
  check(files.length > 0, `api/keiei に API がある（${files.length}本）`);

  // 入口は lib/keiei-gate.js ただ1つ。canKeiei（owner だけ）→ requireMfaStrict の順
  const gate = read("lib/keiei-gate.js");
  check(/canKeiei\(ctx\)/.test(gate), "lib/keiei-gate.js は canKeiei（owner だけ）で判定");
  check(/requireMfaStrict\(req, res, ctx, user\)/.test(gate), "lib/keiei-gate.js は requireMfaStrict（強制日を待たず二段階認証を求める）");
  // 権限のない人に、二段階認証の案内を先に見せない（登録を促さない）
  check(gate.indexOf("canKeiei(ctx)") < gate.indexOf("requireMfaStrict("), "lib/keiei-gate.js は、権限の確認のあとに二段階認証を確かめる");
  check(!/isAdmin|canManageHr|canRecruit|canSell|canOffice/.test(gate.replace(/\/\/.*$/gm, "")),
    "lib/keiei-gate.js は、経営者以外の判定を混ぜない（下位の権限を継承しない）");

  for (const f of files) {
    const s = read(f);
    const code = s.replace(/\/\/.*$/gm, "");
    check(/await requireKeiei\(req, res\)/.test(code), `${f} は入口 requireKeiei（経営者だけ・二段階認証つき）を通る`);
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
  check(tools.map((t) => t.label).join(",") === "HR,Sales,Office,経営", `表示は「HR ｜ Sales ｜ Office ｜ 経営」（いま ${tools.map((t) => t.label)}）`);
  const accessKeys = new Set(Object.keys(accessOf({ roles: [] })));
  const keyOfAccess = { hr: "recruit", sales: "sell", office: "office", keiei: "keiei" };
  check(tools.every((t) => accessKeys.has(keyOfAccess[t.key])), "TOOLS の各ツールに、サーバの access（accessOf）のキーがある");
  check(tools.find((t) => t.key === "office")?.ready === false, "Office は未実装のあいだ ready:false（存在しないリンクを出さない）");
  check(tools.filter((t) => t.key !== "office").every((t) => t.ready), "HR・Sales・経営は ready:true");
  check(/TOOLS\.filter\(\(t\) => t\.ready && shows\[t\.key\]\)/.test(layout), "出すのは ready かつ サーバの判定（shows）が true のツールだけ");
  check(tools.find((t) => t.key === "keiei")?.href === "/keiei/", "経営 → /keiei/");
}

console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
