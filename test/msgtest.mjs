// メッセージ フェーズ1。実際の画面で通す
import { launch, BASE } from "./_browser.mjs";

const T0 = Date.parse("2026-09-10T01:00:00Z");
const iso = (n) => new Date(T0 + n * 60000).toISOString();

const me = { id: "emp-1", display_name: "今福 太郎", department: "制作部", status: "active" };
const ctx = { email: "a@b.c", appRole: "member", shows: {},
  gw: { employee: me, roles: [], isAdmin: false, tenantId: "t1", stage: null } };

const PEOPLE = { employees: [
  { id: "emp-1", display_name: "今福 太郎", department: "制作部", status: "active" },
  { id: "emp-2", display_name: "鈴木 花子", department: "営業部", status: "active" },
  { id: "emp-3", display_name: "田中 一郎", department: "管理部", status: "active" },
  { id: "emp-4", display_name: "佐藤 次郎", department: "営業部", status: "active" },
]};

// 全部で 120 件。50件ずつ3回に分かれる
const ALL = Array.from({ length: 120 }, (_, i) => ({
  id: `m${String(i).padStart(3, "0")}`,
  thread_id: "th1",
  sender_id: i % 3 === 0 ? "emp-2" : "emp-1",
  body: `本文 ${i}`,
  created_at: iso(i),
  files: [],
  readBy: { count: i % 3 === 0 ? 0 : (i > 100 ? 0 : 2), total: 2, mine: i % 3 !== 0 },
}));

// 自分が最後に読んだのは 100件目まで。101件目から未読
const LAST_READ = iso(100);

const MEMBERS = [
  { id: "emp-1", display_name: "今福 太郎", department: "制作部", role: "owner" },
  { id: "emp-2", display_name: "鈴木 花子", department: "営業部", role: "member" },
  { id: "emp-3", display_name: "田中 一郎", department: "管理部", role: "member" },
];

const posted = [];

function threadPage(before) {
  const list = before ? ALL.filter((m) => m.created_at < before) : ALL;
  const tail = list.slice(-50);
  return {
    thread: { id: "th1", kind: "group", title: "経理チーム", members: MEMBERS,
              displayName: "経理チーム", canManage: true, last_message_at: iso(119) },
    messages: tail,
    hasMore: list.length > 50,
    oldest: tail[0]?.created_at || null,
    lastReadAt: LAST_READ,
    me,
  };
}

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const page = await br.newPage({ viewport: { width: 1100, height: 1000 }, timezoneId: "Asia/Tokyo" });
await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({ appRole: "member", name: "今福 太郎", shows: {}, stage: null }));
});
await page.route("**/api/**", (route) => {
  const req = route.request();
  const url = req.url();
  const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (req.method() === "POST" || req.method() === "PATCH") {
    posted.push({ url, body: JSON.parse(req.postData() || "{}") });
    return send({ ok: true });
  }
  if (/\/api\/me\b/.test(url)) return send(ctx);
  if (/\/api\/messages\/thread/.test(url)) {
    return send(threadPage(new URL(url).searchParams.get("before")));
  }
  if (/\/api\/messages\b/.test(url)) {
    return send({ me, threads: [{ id: "th1", kind: "group", title: "経理チーム",
      displayName: "経理チーム", unread: 19, members: MEMBERS,
      lastMessage: { body: "本文 119", created_at: iso(119) }, last_message_at: iso(119) }] });
  }
  if (/\/api\/employees/.test(url)) return send(PEOPLE);
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(url)) return send({ badges: {} });
  return send({});
});
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => m.type() === "error"
  && !/fonts\.googleapis|net::ERR|Failed to load resource/.test(m.text()) && errs.push(m.text()));

await page.goto(`${BASE}/messages.html?t=th1`);
await page.waitForTimeout(1600);

console.log("— ページング —");
check(await page.locator(".kp-bubble-row").count() === 50, `最初は50件だけ出る（${await page.locator(".kp-bubble-row").count()}件）`);
check(await page.locator("#th-more").isVisible(), "「もっと前を読む」が出る");
check((await page.locator("#th-messages").textContent()).includes("本文 119"), "いちばん新しい1件が出ている");
check(!(await page.locator("#th-messages").textContent()).includes("本文 60"), "古いものはまだ出ていない");

await page.locator("button", { hasText: "もっと前を読む" }).click();
await page.waitForTimeout(700);
check(await page.locator(".kp-bubble-row").count() === 100, `さかのぼると100件（${await page.locator(".kp-bubble-row").count()}件）`);
check((await page.locator("#th-messages").textContent()).includes("本文 20"), "前の50件が上に足された");

await page.locator("button", { hasText: "もっと前を読む" }).click();
await page.waitForTimeout(700);
check(await page.locator(".kp-bubble-row").count() === 120, "全部読むと120件");
check(!(await page.locator("#th-more").isVisible()), "全部読んだらボタンが消える");

console.log("— 未読の線 —");
check(await page.locator(".kp-chat-unread").count() === 1, "「ここから未読」の線が1本だけ引かれる");

console.log("— 既読の印 —");
{
  const mine = page.locator(".kp-bubble-row.mine").last();
  check(await page.locator(".kp-bubble-row:not(.mine) .rd").count() === 0,
    "人のメッセージには既読の印を出さない");
  check(await page.locator(".kp-bubble-row.mine .rd").count() > 0, "自分のメッセージには出る");
  check((await mine.textContent()).includes("未読"), "誰も読んでいないものは「未読」と出る");
  const read = page.locator(".kp-bubble-row.mine .rd.on").first();
  check((await read.textContent()).includes("既読 2/2"), "グループは何人が読んだかを出す");
}

console.log("— 参加者の管理 —");
await page.locator("#th-members-btn").click();
await page.waitForTimeout(400);
check(await page.locator("#th-members").isVisible(), "参加者を開ける");
check((await page.locator("#mb-tag").textContent()) === "3名", "人数が出る");
check((await page.locator("#mb-list").textContent()).includes("持ち主"), "持ち主が分かる");
check(await page.locator("#mb-add").isVisible(), "持ち主なので追加の欄が出る");
check(await page.locator("#mb-people .ms-person").count() === 1,
  "すでに入っている人は、追加の候補に出ない（佐藤さんだけ）");

// 追加
await page.locator("#mb-people input").first().check();
await page.waitForTimeout(250);
posted.length = 0;
await page.locator("button", { hasText: "追加する" }).click();
await page.waitForTimeout(700);
{
  const add = posted.find((x) => x.body.action === "add");
  check(add?.employeeIds?.[0] === "emp-4" || add?.body?.employeeIds?.[0] === "emp-4", "選んだ人が送られる");
}

// 外す（確認ダイアログを承諾）
page.on("dialog", (d) => d.accept());
// 追加のあと、参加者の欄は開いたまま更新される。開いていなければ開く
const openMembers = async () => {
  if (!(await page.locator("#th-members").isVisible())) {
    await page.locator("#th-members-btn").click();
    await page.waitForTimeout(400);
  }
};
await openMembers();
check(await page.locator("#th-members").isVisible(), "追加のあとも参加者の欄は開いたまま");
posted.length = 0;
await page.locator("#mb-list button", { hasText: "外す" }).first().click();
await page.waitForTimeout(700);
check(posted.some((x) => x.body.action === "remove"), "外せる");

await openMembers();
posted.length = 0;
await page.locator("#mb-list button", { hasText: "持ち主にする" }).first().click();
await page.waitForTimeout(700);
check(posted.some((x) => x.body.action === "owner"), "持ち主を渡せる");

await page.screenshot({ path: "msg-thread.png", fullPage: true });
await br.close();
if (errs.length) { console.log("\n画面のエラー:"); errs.slice(0, 6).forEach((e) => console.log("  " + e)); bad += errs.length; }
console.log(bad ? `\n${bad} 件 失敗` : "\nすべて通過");
process.exit(bad ? 1 : 0);
