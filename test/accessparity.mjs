// 採用HR（/hr）・Sales（/sales）の「入れるか」が、どこでも同じ条件か。
//
// ヘッダーに近道が出たのに、開いたら 403（または /hr から追い返される）を作らない。
// そのために、次の4か所がそろっていることを機械で見る。
//   1. サーバの判定（lib/gw.js canRecruit / canSell と、それを返す accessOf）
//   2. /api/me が返す access（ヘッダーの近道は、この値だけで出し分ける）
//   3. /hr・/sales の画面の入口（js/hr-layout.js・js/sales-layout.js）
//   4. DB の関数（gw_is_recruiting・gw_is_sales）と、各 API が使う判定
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { accessOf, canRecruit, canSell } from "../lib/gw.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

console.log("— 指示どおりの条件 —");
// 採用HR: owner / admin / hr / recruiter、Sales: owner / admin / manager / sales
const cases = [
  [{ isAdmin: true, roles: [] }, true, true, "admin（会計側の管理者）"],
  [{ roles: ["owner"], isHr: true }, true, true, "owner"],
  [{ roles: ["hr"], isHr: true }, true, false, "hr"],
  [{ roles: ["recruiter"] }, true, false, "recruiter（採用担当）"],
  [{ roles: ["manager"] }, false, true, "manager"],
  [{ roles: ["sales"] }, false, true, "sales（営業担当）"],
  [{ roles: ["recruiter", "sales"] }, true, true, "採用担当＋営業担当"],
  [{ roles: [] }, false, false, "一般メンバー"],
  [{ roles: ["it", "finance", "labor_advisor"] }, false, false, "IT・経理・社労士"],
];
for (const [ctx, recruit, sell, label] of cases) {
  const a = accessOf(ctx);
  check(a.recruit === recruit && a.sell === sell,
    `${label} → 採用HR ${recruit ? "○" : "×"} / Sales ${sell ? "○" : "×"}（いま ${a.recruit ? "○" : "×"} / ${a.sell ? "○" : "×"}）`);
  const full = { isAdmin: false, isHr: false, roles: [], ...ctx };
  check(a.recruit === Boolean(canRecruit(full)) && a.sell === Boolean(canSell(full)),
    `${label}: accessOf は canRecruit / canSell と同じ`);
}

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
  check(/'hr'/.test(isHr) && /'owner'/.test(isHr) && /is_tenant_staff/.test(isHr), "gw_is_hr = hr・owner・管理者");
  check(/gw_is_hr\(p_tenant\)/.test(rec) && /'recruiter'/.test(rec), "gw_is_recruiting = gw_is_hr ＋ recruiter");
  check(["is_tenant_staff", "'owner'", "'manager'", "'sales'"].every((k) => sales.includes(k)),
    "gw_is_sales = 管理者・owner・manager・sales");
  check(!/'hr'|'recruiter'/.test(sales), "gw_is_sales に hr・recruiter は入っていない");
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

console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
