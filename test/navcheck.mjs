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
//   ・管理者は5グループ。1グループ6項目まで
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

const ADMIN_GROUPS = tableOf("ADMIN_GROUPS", "\n  /**\n   * tabs を書いた項目は");
const MEMBER_SIDE_NAV = tableOf("MEMBER_SIDE_NAV", "\n  /**\n   * 管理者: 左サイドメニュー");
const MEMBER_NAV = tableOf("MEMBER_NAV", "\n  /**\n   * メンバー: PCでの左サイドメニュー");

const adminItems = ADMIN_GROUPS.flatMap((g) => g.items);
const memberItems = MEMBER_SIDE_NAV.filter((n) => !n.section);

// ---- 1) 管理者は4グループ、1グループ6項目まで --------------------------------
// 「採用」は独立グループから人事・労務へ統合した（/hr は専用ヘッダーの別アプリ）
console.log("\n— 管理者 —");
check(ADMIN_GROUPS.length === 4, `グループは4つ（いま ${ADMIN_GROUPS.length}）`);
for (const g of ADMIN_GROUPS) {
  check(g.items.length <= 6, `${g.label} は6項目まで（いま ${g.items.length}）`);
}
check(adminItems.length <= 24, `左メニューの項目は全部で ${adminItems.length}`);

// 畳んだときに見出し5つ。開いても、いちばん大きいグループ＋見出し4つが
// PCの最初の画面に収まる高さかどうかの、おおまかな目安
{
  const biggest = Math.max(...ADMIN_GROUPS.map((g) => g.items.length));
  check(ADMIN_GROUPS.length + biggest <= 11,
    `開いた状態の行数の目安 ${ADMIN_GROUPS.length + biggest}（見出し5＋最大 ${biggest}）`);
}

// ---- 2) メンバーは8つ ---------------------------------------------------------
console.log("\n— メンバー —");
{
  // when（設備予約・会計）と urlKey（別システム）と入社手続きは、
  // 人によって出る／出ないもの。いつも出るものだけ数える
  const always = memberItems.filter((n) => !n.when && !n.urlKey && n.key !== "onboarding");
  check(always.length === 8,
    `いつも出るのは8つ（いま ${always.length}: ${always.map((n) => n.label).join("・")}）`);
  check(MEMBER_NAV.length === 5, `スマホの下タブは5つ（いま ${MEMBER_NAV.length}）`);
}

// メンバーと管理者は別の表。同じ配列を共有していない
check(MEMBER_SIDE_NAV !== ADMIN_GROUPS, "メンバーと管理者は別の表");
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
    const plain = /KPLayout\.init\(\{\s*active:\s*"([a-z_]+)"\s*,\s*roles:/.exec(src);
    if (plain) return [plain[1]];
    const ternary = /KPLayout\.init\(\{\s*active:[\s\S]*?\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)"\s*,\s*roles:/
      .exec(src);
    return ternary ? [ternary[1], ternary[2]] : null;
  };

  for (const f of readdirSync(ROOT).filter((x) => x.startsWith("admin-") && x.endsWith(".html"))) {
    const a = activeOf(f);
    check(a && a.every((k) => adminLit.has(k)), `${f} → ${a ? a.join(" | ") : "（読めない）"}`);
  }

  // メンバーが開く画面。管理画面と会計の画面は数えない
  const MEMBER_PAGES = [
    "home.html", "nippo.html", "tasks.html", "schedule.html", "messages.html",
    "timecard.html", "workflow.html", "requests.html", "expenses.html",
    "library.html", "notices.html", "directory.html", "mypage.html",
    "contracts.html", "booking.html", "onboarding.html",
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
        if (!f || f.includes("#") || f.includes("?")) continue;
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
