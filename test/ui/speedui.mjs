// 画面が出るまでの速さ。
//
// ■ 何を守りたいのか
//
//   「読み込み中…」が長い、の中身はたいてい待ち方の問題で、
//   サーバが遅いことではない。
//
//     ① /api/me を待ってから /api/public-config を呼ぶ（直列）
//     ② その2つが終わってから、やっとその画面のデータを取りにいく
//
//   ①②が積み上がると、1本あたりの往復が短くても、
//   画面に何か出るまでに往復3本ぶん待つことになる。
//
//   ここでは、わざと1本 300ms かかるようにして
//     ・/api/me と /api/public-config が同時に出ること
//     ・2回目以降は、その画面のデータが /api/me を待たずに出ること
//   を見る。往復の本数は、回線が細いほど効く。
//
// ■ 秒数そのものは測らない
//
//   走る機械によって変わる数字をしきい値にすると、
//   速くしたいのか、テストを通したいのか分からなくなる。
//   見るのは「何本目に出たか」と「誰を待ったか」。
import { launch, BASE } from "../_browser.mjs";

const LAG = 300;                       // 1本あたりの往復（わざと遅くする）

const me = {
  email: "zimu@8grp.co.jp", appRole: "member", shows: {},
  gw: { employee: { id: "emp-1", display_name: "山田 太郎", status: "active" },
        roles: [], isAdmin: false, tenantId: "t1", stage: null },
};

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

/**
 * 1ページ開いて、通信の出た順と時刻を返す。
 * @param {object} page
 * @param {string} path
 */
async function visit(page, path) {
  const calls = [];
  const t0 = Date.now();
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url()).pathname;
    calls.push({ url, at: Date.now() - t0 });
    await new Promise((r) => setTimeout(r, LAG));
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json",
                                        body: JSON.stringify(b) });
    if (/\/api\/me$/.test(url)) return send(me);
    if (/public-config/.test(url)) {
      return send({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon" });
    }
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    return send({});
  });
  await page.goto(`${BASE}${path}`);
  await page.waitForTimeout(LAG * 6);
  await page.unroute("**/api/**");
  return calls;
}

const newPage = async () => {
  const p = await br.newPage({ viewport: { width: 1280, height: 900 },
                               timezoneId: "Asia/Tokyo" });
  await p.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({
      access_token: "x", email: "a@b.c",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }));
  });
  return p;
};

// ---- 1回目（何も覚えていない） -------------------------------------------------
console.log("— はじめて開いたとき —");
{
  const page = await newPage();
  const calls = await visit(page, "/home.html");
  const at = (re) => calls.find((c) => re.test(c.url))?.at ?? -1;

  const meAt = at(/\/api\/me$/);
  const cfgAt = at(/public-config/);
  check(meAt >= 0, "/api/me を呼ぶ");
  check(cfgAt >= 0, "/api/public-config を呼ぶ");
  // 直列なら、後ろのほうが 1往復ぶん遅れて出る
  check(cfgAt >= 0 && Math.abs(cfgAt - meAt) < LAG,
    `身元と設定は同時に出す（差 ${cfgAt - meAt}ms）`);

  // その画面のデータ（ホームなら日報・タスク・お知らせ）。
  // 測るのは /api/me からの差。goto からの絶対値には、
  // HTML・CSS・JS を読む時間が混ざっていて、走る機械で変わる
  const own = calls.filter((c) => !/\/api\/(me|public-config)$/.test(c.url));
  check(own.length > 0, "画面のデータも取りにいく");
  const lag = (own[0]?.at ?? Infinity) - meAt;
  check(lag < LAG * 1.5,
    `はじめてでも、待つのは身元の1往復だけ（+${Math.round(lag)}ms）`);

  await page.close();
}

// ---- 2回目（覚えている） -------------------------------------------------------
console.log("\n— 2回目からは、身元を待たない —");
{
  const page = await newPage();
  await visit(page, "/home.html");        // 1回目で覚えさせる
  const calls = await visit(page, "/tasks.html");
  const at = (re) => calls.find((c) => re.test(c.url))?.at ?? -1;
  const meAt = at(/\/api\/me$/);
  const own = calls.filter((c) =>
    !/\/api\/(me|public-config|badges|devices\/me|notifications)$/.test(c.url));
  const lag = (own[0]?.at ?? Infinity) - meAt;

  check(meAt >= 0, "/api/me は、裏では必ず確かめる");
  check(Math.abs(lag) < LAG * 0.5,
    `画面のデータが、身元の返事を待たずに出る（差 ${Math.round(lag)}ms）`);

  // バッジと端末の合図は、その画面のデータより後ろ。
  // 先に投げると、本文がそのぶん並んで待つ
  const badgeAt = at(/badges/);
  check(badgeAt < 0 || badgeAt >= (own[0]?.at ?? 0),
    `バッジは画面のデータより後（${badgeAt - (own[0]?.at ?? 0)}ms）`);
  await page.close();
}

// ---- 人が入れ替わったとき -------------------------------------------------------
console.log("\n— 別の人が入ったら、覚えているぶんは使わない —");
{
  const page = await newPage();
  await visit(page, "/home.html");                 // 覚えさせる
  // ログアウトせずに別の人が入る道（前の人のセッションが切れた直後など）。
  // 覚えているのは前の人のぶん、いま入っているのは別の人、という形にする。
  // （kp_session は毎回 addInitScript で入れ直されるので、覚えているほうを変える）
  const swapped = await page.evaluate(() => {
    const v = JSON.parse(localStorage.getItem("kp_me") || "null");
    if (!v) return false;
    v.email = "mae-no-hito@8grp.co.jp";
    localStorage.setItem("kp_me", JSON.stringify(v));
    return true;
  });
  check(swapped, "覚えているぶんに、誰のものかが入っている");
  const calls = await visit(page, "/tasks.html");
  const at = (re) => calls.find((c) => re.test(c.url))?.at ?? -1;
  const meAt = at(/\/api\/me$/);
  const own = calls.filter((c) =>
    !/\/api\/(me|public-config|badges|devices\/me|notifications)$/.test(c.url));
  const lag = (own[0]?.at ?? Infinity) - meAt;
  check(lag >= LAG * 0.5,
    `前の人のぶんで動き出さない（身元を待っている：+${Math.round(lag)}ms）`);
  await page.close();
}

// ---- 文字が出るまで -------------------------------------------------------------
console.log("\n— 「読み込み中…」が残らないこと —");
{
  const page = await newPage();
  await visit(page, "/home.html");
  const calls = await visit(page, "/home.html");
  const txt = await page.locator("#greet").innerText();
  check(!/読み込み中/.test(txt), `名前が出ている（${txt}）`);
  // 覚えているぶんは、待たずに出す
  check(calls.length > 0, "通信そのものは、裏で続けている");
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
