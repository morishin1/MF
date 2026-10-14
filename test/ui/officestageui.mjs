// Office（/office/）を、在籍中の一般社員（appRole "member"）が開けるか（2026-10-07 野澤さんの件）。
//
// ■ 何が起きていたか
//   Office ON・人事（hr）／経理（finance）でも、/office/ を開くとホームへ戻された。
//   js/layout.js が、在籍の段階の表（lib/stages.js の allowed）を access の判定より先に見ていて、
//   その表に Office の鍵（office_home など）が無かったため。権限（/api/me の access）は正しかった。
//
// ■ 何を守るテストか（初めて開く・覚えている身元で開き直す、の両方）
//   1. 在籍中 + Office ON + 人事 → /office/ を開ける
//   2. 在籍中 + Office ON + 経理 → /office/ を開ける
//   3. 在籍中 + Office なし（人事の役割だけ） → ホームへ戻される（これまでどおり）
//   4. 入社準備中（invited）+ Office ON + 人事 → 入社準備へ戻される（段階の制限はこれまでどおり）
//   5. 退職手続き中（leaving）+ Office ON + 経理 → 開ける
//   6. 退職（left） → 退職者ポータルへ（これまでどおり）
//   7. 在籍中でも、グループウェアの画面の段階の制限は変わらない（入社準備中は「全員のタスク」等へは入れない）
import { launch, BASE } from "../_browser.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

// 画面が受け取る値の「正解」は、サーバ（lib/gw.js・lib/stages.js）
const GW = await import("../../lib/gw.js");
const ST = await import("../../lib/stages.js");

function meOf({ status = "active", roles = [], apps = [] }) {
  return {
    email: "nozawa@example.jp", appRole: "member", isAdmin: false, roles: [], memberships: [],
    gw: { employee: { id: "e1", display_name: "野澤 テスト", status }, roles, tenantId: "t1",
          stage: ST.stageInfo({ status }) },
    access: GW.memberAccessOf({ roles, apps }),
  };
}

async function open(path, me, { revisit = false } = {}) {
  const page = await br.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "nozawa@example.jp" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open", "kp_view"]) localStorage.removeItem(k);
  });
  await page.route("**/api/**", (r) => {
    const u = r.request().url();
    const send = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(u)) return send(me);
    if (/\/api\/notifications/.test(u)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  // 送り返された先は読み込まず、行き先だけ記録する（行き先の画面のテストではない）
  const moved = [];
  await page.route(/\/(home\.html|onboarding\/|retiree\/)(\?.*)?$/, (route) => {
    if (route.request().isNavigationRequest()) { moved.push(new URL(route.request().url()).pathname); return route.fulfill({ status: 200, contentType: "text/html", body: "<title>戻り先</title>" }); }
    return route.continue();
  });
  await page.goto(`${BASE}${path}`);
  await page.waitForTimeout(1200);
  if (revisit) {
    // 覚えている身元（kp_layout・kp_me）で開き直す。先に描く判定（okStage）も同じ規則か
    await page.goto(`${BASE}${path}`);
    await page.waitForTimeout(1200);
  }
  const at = new URL(page.url()).pathname;
  await page.close();
  return { at, moved };
}

const CASES = [
  ["在籍中 + Office ON + 人事 → 開ける", { status: "active", roles: ["hr"], apps: ["office"] }, "/office/", "/office/"],
  ["在籍中 + Office ON + 経理 → 開ける", { status: "active", roles: ["finance"], apps: ["office"] }, "/office/", "/office/"],
  ["在籍中 + Office ON + 責任者 → 開ける", { status: "active", roles: ["manager"], apps: ["office"] }, "/office/", "/office/"],
  ["在籍中 + Office なし（人事の役割だけ） → 戻される", { status: "active", roles: ["hr"], apps: [] }, "/office/", "/home.html"],
  ["在籍中 + 何も無し → 戻される", { status: "active", roles: [], apps: [] }, "/office/", "/home.html"],
  ["入社準備中 + Office ON + 人事 → 入社準備へ戻される", { status: "invited", roles: ["hr"], apps: ["office"] }, "/office/", "/onboarding/"],
  ["退職手続き中 + Office ON + 経理 → 開ける", { status: "leaving", roles: ["finance"], apps: ["office"] }, "/office/", "/office/"],
  ["退職 → 退職者ポータルへ", { status: "left", roles: ["hr"], apps: ["office"] }, "/office/", "/retiree/"],
  ["在籍中 + Office ON + 経理 → 月次業務（/office/monthly.html）も段階で止まらない", { status: "active", roles: ["finance"], apps: ["office"] }, "/office/monthly.html", "/office/monthly.html"],
  ["入社準備中は、グループウェアの開いていない画面（日報）へは入れない", { status: "invited", roles: [], apps: [] }, "/nippo.html", "/onboarding/"],
  ["在籍中は、グループウェアの画面（日報）を開ける", { status: "active", roles: [], apps: [] }, "/nippo.html", "/nippo.html"],
];

for (const revisit of [false, true]) {
  console.log(`\n=== ${revisit ? "覚えている身元で開き直す" : "初めて開く"} ===`);
  for (const [label, who, path, want] of CASES) {
    const { at, moved } = await open(path, meOf(who), { revisit });
    const got = moved.length ? moved[moved.length - 1] : at;
    check(got === want, `${label}（いま ${got}）`);
  }
}

await br.close();
console.log(bad ? `\nNG ${bad}` : "\nall ok");
process.exit(bad ? 1 : 0);
