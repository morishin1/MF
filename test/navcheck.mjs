// 左メニューの情報設計を、機械で見張る。
//
// ■ なぜ要るのか
//
//   メニューは「1つ足すだけ」で増える。1つずつなら誰も止めないので、
//   気づくと24項目あって、毎日押すものと半年に一度のものが
//   同じ重さで並ぶ。実際にそうなっていた。
//
//   決めたことを、足すたびに人が思い出す運用は続かない。
//   守りたい形を、ここに書いておく。
//
// ■ 守る形
//
//   ・左は自分の仕事（全員同じ）、上は担当業務（ヘッダー）。管理者も左メニューはメンバーと同じ
//   ・Office（人事・労務・経理・事務だけ）は 専用の左メニュー: ダッシュボード＋2グループ・1グループ6項目まで
//   ・経営（チーム状況・全員のタスク・全員の日報）と管理（⚙。AIナレッジを含む）は平らな別の表
//   ・メンバーは8項目（条件付きで出るものを除く）
//   ・2階層目は左メニューに出さず、ページの上のタブ（tabs）にする
//   ・メンバーと管理者は、別の表にする（権限で出し分けない）
//   ・どの画面を開いても、メニューのどこかが光る
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// ---- layout.js から表を読む -------------------------------------------------
//
// 実際に評価して読む。正規表現で拾うと、書き方を変えたとたんに
// 「0項目なので全部OK」という、いちばん困る通り方をする
const src = readFileSync(join(ROOT, "js/layout.js"), "utf8");

function tableOf(name, endMark) {
  const from = src.indexOf(`const ${name} = [`);
  const to = src.indexOf(endMark, from);
  if (from < 0 || to < 0) throw new Error(`${name} を読めません`);
  const body = src.slice(from + `const ${name} = `.length, to);
  // 最後の ]; までを式として評価する
  const expr = body.slice(0, body.lastIndexOf("];") + 1);
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${expr});`)();
}

const OFFICE_TOP = tableOf("OFFICE_TOP", "\n  const OFFICE_GROUPS");
const OFFICE_GROUPS = tableOf("OFFICE_GROUPS", "\n  // 経営（チーム・会社全体の管理、判断）");
const KEIEI_ITEMS = tableOf("KEIEI_ITEMS", "\n  // 管理（⚙）");
const SETTINGS_ITEMS = tableOf("SETTINGS_ITEMS", "\n  /**\n   * いま開いている画面が");
const MEMBER_SIDE_NAV = tableOf("MEMBER_SIDE_NAV", "\n  /**\n   * 「左は自分の仕事、上は担当業務」");
const MEMBER_NAV = tableOf("MEMBER_NAV", "\n  /**\n   * 入社準備中（入社日前で");
const PREPARING_NAV = tableOf("PREPARING_NAV", "\n  /**\n   * 本人（入社する人・メンバー）の画面に出すエラー文。");

const adminItems = [...OFFICE_TOP, ...OFFICE_GROUPS.flatMap((g) => g.items), ...KEIEI_ITEMS, ...SETTINGS_ITEMS];
const memberItems = MEMBER_SIDE_NAV.filter((n) => !n.section);

// ---- 1) Office はホーム＋4グループ（各6項目まで）・管理（⚙）は設定系だけ -----------------
// 2026-10-03 の Office UI/UX 再設計：⚙管理にあった業務メニューを Office の左メニューへ移した
// 「採用」は独立グループから人事・労務へ統合した（/hr は専用ヘッダーの別アプリ）。
// ホーム・管理（⚙）はヘッダーで領域を切り替える前提なので、グループに畳まず平らなまま
console.log("\n— 管理者 —");
check(OFFICE_TOP.length === 1 && OFFICE_TOP[0].key === "office_home" && OFFICE_TOP[0].label === "ホーム" && OFFICE_TOP[0].href === "/office/",
  "Officeの先頭はホーム1つ（/office/）");
check(SETTINGS_ITEMS.length <= 6, `管理（⚙）は6項目まで（いま ${SETTINGS_ITEMS.length}）`);
// 2026-10-07 メニュー整理・権限分担：Office は 人・組織／請求・支払／契約・書類／端末・貸与品（日常の事務運用）。
// 判断・承認・重要な権限（権限・アクセス分析）は経営、システム設定は⚙
check(OFFICE_GROUPS.length === 4, `Officeは4グループ（人・組織／請求・支払／契約・書類／端末・貸与品。いま ${OFFICE_GROUPS.length}）`);
{
  // 新方針にない分類（全社運営など）で、Officeを何でも置く場所にしない
  const labels = OFFICE_GROUPS.map((g) => g.label).join("/");
  check(labels === "人・組織/請求・支払/契約・書類/端末・貸与品", `Officeのグループは人・組織・請求・支払・契約・書類・端末・貸与品だけ（いま ${labels}）`);
  const keys = OFFICE_GROUPS.flatMap((g) => g.items.map((i) => i.key));
  for (const k of ["tasks", "ai_admin", "team", "roles", "analytics", "settings"]) check(!keys.includes(k), `Officeに「${k}」を置かない`);
  check(OFFICE_GROUPS.find((g) => g.label === "契約・書類")?.items.some((i) => i.key === "notices"), "お知らせ配信は契約・書類（Office）");
  const ops = OFFICE_GROUPS.find((g) => g.label === "請求・支払")?.items || [];
  check(ops.map((i) => i.label).join("/") === "請求・支払/経費精算/月次業務/会計", `請求・支払は 請求・支払／経費精算／月次業務／会計（いま ${ops.map((i) => i.label).join("/")}）`);
  check(ops.some((i) => i.key === "office_monthly" && i.href === "/office/monthly.html"), "月次業務（/office/monthly.html）は請求・支払（Office）");
  check(ops.some((i) => i.key === "office_billing" && i.href === "/office/billing.html"), "請求・支払（/office/billing.html）は請求・支払（Office）");
  const hrItems = OFFICE_GROUPS.find((g) => g.label === "人・組織")?.items || [];
  check(hrItems.map((i) => i.label).join("/") === "日報・勤怠/メンバー/入退社/勤怠管理/評価・キャリア", `人・組織は 日報・勤怠／メンバー／入退社／勤怠管理／評価・キャリア（いま ${hrItems.map((i) => i.label).join("/")}）`);
  check(hrItems[0]?.key === "nippo" && hrItems[0]?.href === "admin-nippo.html", "人・組織の初めは日報・勤怠（admin-nippo.html）");
  const docs = OFFICE_GROUPS.find((g) => g.label === "契約・書類")?.items || [];
  check(docs.map((i) => i.label).join("/") === "雇用契約/社内文書/お知らせ配信", `契約・書類は 雇用契約／社内文書／お知らせ配信（いま ${docs.map((i) => i.label).join("/")}）`);
  const dev = OFFICE_GROUPS.find((g) => g.label === "端末・貸与品")?.items || [];
  check(dev.length === 1 && dev[0].key === "devices" && dev[0].when === "officeHr" && (dev[0].tabs || []).map((t) => t.href).join(",") === "admin-devices.html,admin-assets.html",
    "端末・貸与品（端末管理・アカウント・貸与品）は Office（人事の権限＝api/devices・api/assets と同じ）");
  // ⚙管理（設定系）の項目を Office に置かない・Office の業務を ⚙管理 に置かない
  const settingKeys = SETTINGS_ITEMS.map((i) => i.key);
  check(!keys.some((k) => settingKeys.includes(k)), "Office と ⚙管理 に同じ項目を置かない");
}
check(KEIEI_ITEMS.map((i) => i.key).join(",") === "keiei_home,team,tasks,analytics", `経営の表（いま ${KEIEI_ITEMS.map((i) => i.key)}）`);
check(SETTINGS_ITEMS.map((i) => i.key).join(",") === "ai_admin,settings", `⚙はAIナレッジ・システム設定だけ（権限は経営、端末・貸与品は Office、アクセス分析は経営。いま ${SETTINGS_ITEMS.map((i) => i.key)}）`);
check(SETTINGS_ITEMS.some((i) => i.key === "ai_admin"), "AIナレッジは⚙管理");
for (const g of OFFICE_GROUPS) {
  check(g.items.length <= 6, `Office「${g.label}」は6項目まで（いま ${g.items.length}）`);
}
check(adminItems.length <= 24, `左メニューの項目は全部で ${adminItems.length}`);

// Officeを開いても、いちばん大きいグループ＋見出し2つが
// PCの最初の画面に収まる高さかどうかの、おおまかな目安（先頭のダッシュボード1行を含む）
{
  const biggest = Math.max(...OFFICE_GROUPS.map((g) => g.items.length));
  check(1 + OFFICE_GROUPS.length + biggest <= 11,
    `Officeを開いた状態の行数の目安 ${1 + OFFICE_GROUPS.length + biggest}（ホーム1＋見出し${OFFICE_GROUPS.length}＋最大 ${biggest}）`);
}

// ---- 2) メンバーは7つ ---------------------------------------------------------
//   ホーム・今日やること・社内AI・勤怠・申請・キャリア・社内情報・マイページ
//   （評価・キャリア再設計 §3・§37。スペース予約は通常メニューから外した）
console.log("\n— メンバー —");
{
  // when（設備予約・会計）と urlKey（別システム）と入社手続きは、
  // 人によって出る／出ないもの。いつも出るものだけ数える
  const always = memberItems.filter((n) => !n.when && !n.urlKey && n.key !== "onboarding");
  check(always.length === 7,
    `いつも出るのは7つ（いま ${always.length}: ${always.map((n) => n.label).join("・")}）`);
  check(MEMBER_NAV.length === 5, `スマホの下タブは5つ（いま ${MEMBER_NAV.length}）`);

// ---- 入社準備中のメニュー --------------------------------------------------------
// 入社前の人には、通常メンバー向けの機能を並べない。ホーム／入社準備／給与管理／設定・セキュリティ の4つだけ。
// 行き先は、入社準備中に開いている画面（lib/stages.js ALLOWED.preparing）だけ。開けない画面への入口は置かない
{
  const { ALLOWED, PREPARING_ONLY } = await import("../lib/stages.js");
  const items = PREPARING_NAV.filter((n) => !n.section);
  check(items.map((n) => n.label).join("／") === "ホーム／入社準備／給与管理／設定・セキュリティ",
    `入社準備中のメニューは4つ（いま ${items.map((n) => n.label).join("／")}）`);
  const fileOf = (href) => href.replace(/^\//, "").replace(/[?#].*$/, "").replace(/\/$/, "") || "index";
  const screenOf = { "home.html": "home", "onboarding": "onboarding", "mypage.html": "mypage", "contracts.html": "contracts" };
  for (const n of items) {
    const f = fileOf(n.href);
    check(screenOf[f] && ALLOWED.preparing.includes(screenOf[f]), `入社準備中のメニュー「${n.label}」は、入社準備中に開ける画面へ（${n.href}）`);
  }
  check(PREPARING_ONLY.includes("onboarding"), "入社準備は、入社準備中だけの画面");
  // 通常メンバーの機能（今日やること・勤怠・キャリア・社内情報…）は、入社準備中のメニューに並べない
  const normal = ["tasks", "nippo", "timecard", "requests", "expenses", "career", "notices", "messages", "dojo"];
  check(!items.some((n) => normal.includes(n.key)), "入社準備中のメニューに、通常メンバーの機能を並べない");
}
}

// 採用HR（/hr/）・Sales（/sales/）の入口は共通ヘッダーの近道だけ。左メニューにも置くと二重導線になる。
// 月末月初業務（/office/）は Office の中の画面なので、Office の左メニュー（経理・事務）にだけ置く。メンバーの表には置かない
for (const [navs, who] of [[adminItems, "管理者"], [memberItems, "メンバー"]]) {
  const dup = navs.filter((n) => /^\/?(hr|sales)\/$/.test(String(n.href || "")) || (who === "メンバー" && /^\/?office\//.test(String(n.href || ""))));
  check(!dup.length, `${who}の左メニューに採用HR・Salesを置かない${dup.length ? `（${dup.map((n) => n.label).join("・")}）` : ""}`);
}
{
  // 左メニューの行にも、ページ上部の帯（tabs）にも出さない。直接URL・タスク・個別の導線から開く
  const bookings = [...adminItems, ...memberItems].flatMap((n) => [n, ...(n.tabs || [])])
    .filter((n) => /booking/.test(String(n.href || "")));
  check(!bookings.length, "スペース予約は左メニューにも帯にも置かない（直接URL・個別の導線から開く）");
}

// メンバーと管理者は別の表。同じ配列を共有していない
check(MEMBER_SIDE_NAV !== OFFICE_TOP, "メンバーと管理者は別の表");
{
  // 管理側の画面が、メンバーの表に混ざっていないこと
  const leaked = memberItems.filter((n) => String(n.href || "").startsWith("admin-"));
  check(!leaked.length,
    `メンバーの表に管理画面が入っていない${leaked.length ? `（${leaked.map((n) => n.href).join("・")}）` : ""}`);
}

// ---- 3) 2階層目は、左メニューに出さない ---------------------------------------
console.log("\n— 2階層目はページの上のタブへ —");
for (const navs of [adminItems, memberItems]) {
  const top = new Set(navs.map((n) => n.key));
  for (const n of navs) {
    for (const t of n.tabs || []) {
      // タブの1つ目は、その項目そのもの。2つ目以降が左に並んでいたら、
      // 「まとめた」ことにならない
      if (t.key === n.key) continue;
      check(!top.has(t.key),
        `${n.label} の中の「${t.label}」は左メニューに出さない`);
    }
  }
}

// tabs を書いた項目は、その鍵で選ばれた状態になること（match の自動生成）
for (const n of [...adminItems, ...memberItems]) {
  if (!n.tabs) continue;
  check(n.tabs[0].key === n.key,
    `${n.label} の最初のタブは、その項目自身（いま ${n.tabs[0].key}）`);
}
check(/if \(n\.tabs && !n\.match\) n\.match = n\.tabs\.map/.test(src),
  "tabs から match を自動で作っている（手で二重に書かせない）");
check(/function renderSubnav\(/.test(src), "ページの上の帯を描く口がある");
check(/renderSubnav\(active,/.test(src), "描くところから呼んでいる");

// ---- 4) どの画面を開いても、どこかが光る --------------------------------------
console.log("\n— 開いた画面が、メニューのどこかで光るか —");
{
  const lit = (navs) => {
    const set = new Set();
    for (const n of navs) {
      if (n.key) set.add(n.key);
      for (const t of n.tabs || []) set.add(t.key);
      for (const m of n.match || []) set.add(m);
    }
    return set;
  };
  const adminLit = lit(adminItems);
  const memberLit = lit(memberItems);

  // 「active: "esign"」のような単純な形だけでなく、
  // 「active: cond ? "esign_order" : "esign"」のように、同じ画面の中で
  // どのタブを選ぶかを実行時に決めている画面もある（admin-esign.html）。
  // active: から roles: の手前までに出てくる文字列リテラルを全部拾い、
  // そのすべてがナビの鍵になっていればよいとする
  const activeOf = (f) => {
    const src = readFileSync(join(ROOT, f), "utf8");
    // 単純な「active: "esign"」か、「active: 何か ? "esign_order" : "esign"」の
    // どちらか。後者は三項演算の左右（実際にactiveへ入る側）だけを拾い、
    // 条件式の中の文字列（例: "order"）は候補に入れない
    // roles（appRole）か access（canManageHr 等、roles では表せない権限）のどちらかで入口を絞る
    const plain = /KPLayout\.init\(\{\s*active:\s*"([a-z_]+)"\s*,\s*(?:roles|access):/.exec(src);
    if (plain) return [plain[1]];
    const ternary = /KPLayout\.init\(\{\s*active:[\s\S]*?\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"\s*,\s*(?:roles|access):/
      .exec(src);
    return ternary ? [ternary[1], ternary[2]] : null;
  };

  // admin-dashboard.html は旧URLの互換（/office/ へ送るだけ）。枠を持たないので数えない
  const redirectOnly = (f) => /^\s*<script>location\.replace\("\/office\/"/m.test(readFileSync(join(ROOT, f), "utf8"));
  for (const f of readdirSync(ROOT).filter((x) => x.startsWith("admin-") && x.endsWith(".html") && !redirectOnly(x))) {
    const a = activeOf(f);
    check(a && a.every((k) => adminLit.has(k)), `${f} → ${a ? a.join(" | ") : "（読めない）"}`);
  }

  // メンバーが開く画面。管理画面と会計の画面は数えない
  const MEMBER_PAGES = [
    "home.html", "nippo.html", "tasks.html", "schedule.html", "messages.html",
    "timecard.html", "workflow.html", "requests.html", "expenses.html",
    "library.html", "notices.html", "directory.html", "mypage.html",
    "contracts.html", "booking.html", "onboarding.html", "career.html",
  ];
  for (const f of MEMBER_PAGES) {
    const a = activeOf(f);
    check(a && a.every((k) => memberLit.has(k) || k === "menu"), `${f} → ${a ? a.join(" | ") : "（読めない）"}`);
  }
}

// ---- 5) 見出しと、まとまりの名前がそろっているか ------------------------------
//
//   帯のすぐ上に別の名前が出ていると、どちらが現在地なのか分からなくなる。
//   見出しは「まとまりの名前」、帯は「いまどこか」。役割を分ける
console.log("\n— 見出しとまとまりの名前 —");
{
  const h1Of = (f) => {
    const m = /<h1 class="kp-greet"[^>]*>([^<]*)<\/h1>/
      .exec(readFileSync(join(ROOT, f), "utf8"));
    return m ? m[1].trim() : null;
  };
  const pageOf = (key, navs) => {
    for (const n of navs) {
      for (const t of n.tabs || []) if (t.key === key) return t.href;
    }
    return null;
  };
  for (const [navs, who] of [[adminItems, "管理"], [memberItems, "メンバー"]]) {
    for (const n of navs) {
      for (const t of n.tabs || []) {
        const f = pageOf(t.key, navs);
        // #… は同じ画面の別ビュー、?… は同じ画面の別タブ（例: admin-esign.html?tab=order）。
        // どちらも「別のHTMLファイル」ではないので、見出し比較の対象外
        // "/office/" のような別アプリへの入口も、別のHTMLファイルではないので対象外
        if (!f || f.includes("#") || f.includes("?") || f.startsWith("/")) continue;
        const h = h1Of(f);
        check(h === n.label,
          `${who} ${f} の見出しは「${n.label}」（いま「${h}」）`);
      }
    }
  }
}

// ---- 6) 名前は短く -------------------------------------------------------------
console.log("\n— メニュー名 —");
for (const n of [...adminItems, ...memberItems]) {
  if (!n.label) continue;
  check(n.label.length <= 9, `「${n.label}」（${n.label.length}字）`);
}

console.log(bad ? `\n${bad} 件 NG` : "\n左メニューの形は、決めたとおりです");
process.exit(bad ? 1 : 0);
