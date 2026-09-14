// 会社貸与か私物か、と私物PCの事前承認。実際の画面で通す。
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const me = { email: "zimu@8grp.co.jp", appRole: "admin", shows: {},
  gw: { employee: { id: "emp-0", display_name: "事務" },
        roles: ["hr"], isAdmin: true, tenantId: "t1", stage: null } };

const dev = (over = {}) => ({
  id: "d1", label: "8GRP-PC-01", hostname: "8GRP-PC-01", source: "agent",
  os: "Windows 11", status: "active", confirmed: true, installed: true,
  lastSeen: "3分前", firstSeenAt: "2026-09-01T00:00:00Z",
  employee: { id: "emp-1", name: "田中 太郎" },
  openAlerts: { critical: 0, warn: 0 },
  state: { key: "ok", label: "正常" },
  ownership: "company", own: { key: "ok", label: "会社貸与", note: "" },
  links: [], browsers: [], ...over,
});

const LIST = {
  devices: [
    dev(),
    dev({ id: "d2", label: "Windows 11 の Chrome", source: "browser", hostname: null,
      employee: { id: "emp-2", name: "佐藤 花子" },
      ownership: "personal",
      own: { key: "banned", label: "私物（承認なし）",
             note: "業務利用は禁止です。必要なら事前承認を出してください" } }),
    dev({ id: "d3", label: "Mac の Safari", source: "browser", hostname: null,
      employee: { id: "emp-3", name: "鈴木 一郎" },
      ownership: "unknown",
      own: { key: "check", label: "未確認", note: "確かめて区分を付けてください" } }),
  ],
  folded: 0, alerts: [],
  summary: { total: 3, agents: 1, active: 3, waiting: 0, stale: 0, silent: 0,
             unknown: 1, openAlerts: 0, unmanaged: 1, banned: 1 },
  people: [{ id: "emp-1", name: "田中 太郎", department: "営業" },
           { id: "emp-2", name: "佐藤 花子", department: "開発" }],
  ownerships: [{ key: "company", label: "会社貸与" },
               { key: "personal", label: "私物" },
               { key: "unknown", label: "未確認" }],
};

const EXC = { exceptions: [
  { id: "x1", employee: { id: "emp-2", name: "佐藤 花子" }, deviceNote: "自宅の MacBook",
    reason: "貸与PCの修理中", expiresOn: "2026-09-30", revokedAt: null, note: null,
    state: { key: "live", label: "有効" } },
  { id: "x2", employee: { id: "emp-3", name: "鈴木 一郎" }, deviceNote: null,
    reason: "出張中の緊急対応", expiresOn: "2026-08-01", revokedAt: null, note: null,
    state: { key: "expired", label: "期限切れ" } },
]};

const br = await launch();
const page = await br.newPage({ viewport: { width: 1400, height: 1100 }, timezoneId: "Asia/Tokyo" });
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => m.type() === "error"
  && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest/i.test(m.text()) && errs.push(m.text()));

const sent = [];
await page.route("**/api/**", (r) => {
  const req = r.request();
  const url = req.url();
  const send = (b) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (req.method() !== "GET") { sent.push({ url, ...(JSON.parse(req.postData() || "{}")) }); return send({ ok: true }); }
  if (/\/api\/devices\/exceptions/.test(url)) return send(EXC);
  if (/\/api\/me\b/.test(url)) return send(me);
  if (/\/api\/devices\/alerts/.test(url)) return send({ alerts: [] });
  if (/\/api\/devices\?/.test(url)) return send(LIST);
  if (/\/api\/devices/.test(url)) return send(LIST);
  if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
  if (/\/api\/badges/.test(url)) return send({ badges: {}, devices: { alerts: 0, waiting: 0 } });
  return send({});
});
await page.addInitScript(() => {
  localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
  localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
});

await page.goto(`${BASE}/admin-devices.html`);
await page.waitForTimeout(1600);
await page.click("#t-list");
await page.waitForTimeout(300);

console.log("— 一覧 —");
{
  // 通常の一覧は、登録済みを1台1行で出すだけ。
  // 区分の話は「要確認」に集めてある（正常なものに印を並べない）
  const t = await page.locator("#d-rows").textContent();
  check(!t.includes("私物（承認なし）"), "正常な一覧に、区分の印を並べない");
}
{
  await page.click("#t-check");
  await page.waitForTimeout(400);
  const t = await page.locator("#c-rows").textContent();
  check(/会社貸与か私物か.*決まっていません/.test(t), "区分が付いていないものが出る");
  check(t.includes("私物PCが業務に使われています"), "承認の無い私物PCは、はっきり出す");
  const btns = await page.locator("#c-rows button").allInnerTexts();
  check(btns.includes("会社貸与にする") && btns.includes("私物として扱う"),
    "その場で区分を決められる");
  await page.click("#t-list");
  await page.waitForTimeout(300);
}
check((await page.locator("#d-sum").textContent()).includes("要確認"),
  "まとめにも台数が出る");
// 絞り込みのチップは廃止。区分の要るものは「要確認」に集まる
{
  await page.click("#t-check");
  await page.waitForTimeout(400);
  const t = await page.locator("#c-rows").textContent();
  check(!t.includes("8GRP-PC-01"), "会社貸与のものは出てこない");
  check(t.includes("Windows 11 の Chrome") && t.includes("Mac の Safari"),
    "私物と未確認だけが並ぶ");
  await page.click("#t-list");
  await page.waitForTimeout(300);
}

console.log("— 私物PCの承認 —");
await page.click("#t-exceptions");
await page.waitForTimeout(900);
{
  const t = await page.locator("#p-exceptions").textContent();
  check(t.includes("私物PCでの業務利用は禁止"), "禁止であることを、承認の画面にも書く");
  check(t.includes("黙って使われます"), "なぜ通る道を残すのかを書く");
  check(t.includes("貸与PCの修理中"), "出ている承認が読める");
  check(t.includes("有効") && t.includes("期限切れ"), "生きているものと切れたものが分かる");
}
check(await page.locator("#x-until").inputValue() !== "", "期限が既定で入る（無期限を作らない）");
check((await page.locator("#x-emp option").count()) === 2, "対象の社員を選べる");

// 理由を書かずに押しても、送らない
sent.length = 0;
await page.click("#p-exceptions button:has-text('承認する')");
await page.waitForTimeout(500);
check(sent.length === 0, "理由が無ければ送らない");
check((await page.locator("#x-msg").textContent()).includes("理由"), "何が足りないか言う");

await page.fill("#x-reason", "貸与PCの修理中。2週間だけ自宅のPCで受注処理を行うため");
await page.fill("#x-dev", "自宅の MacBook");
await page.click("#p-exceptions button:has-text('承認する')");
await page.waitForTimeout(700);
{
  const p = sent.find((x) => /exceptions/.test(x.url));
  check(p && p.reason.includes("修理中"), "理由を送る");
  check(p && p.expiresOn, "期限を送る");
  check(p && p.deviceNote === "自宅の MacBook", "端末の説明も送る");
}

await page.screenshot({ path: shotPath("owner.png"), fullPage: true });
await br.close();
if (errs.length) { console.log("エラー:", errs); bad++; }
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
