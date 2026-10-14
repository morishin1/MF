// 退職者ポータル（/retiree/）と、メンバー管理の「退職手続き」を、実際のブラウザで見る。
//
// ■ 何を守りたいのか
//   [本人の画面 /retiree/]
//   ・社内のナビ（左メニュー・ヘッダーの業務切替）が出ない。名前・退職日・書類4つ（退職証明書・源泉徴収票・離職票・健康保険 資格喪失証明書）
//   ・発行済みだけ [PDFを見る] [ダウンロード]。手続き中・準備中にはボタンが無い
//   ・押すと、書類の id だけを渡して署名付き URL を取りにいく（保存先のパスは画面に来ない）
//   ・退職者ではない人が開いたら、ふだんの画面へ送る。ログインしていなければログイン画面へ
//   ・1280 / 768 / 390px で横にはみ出さない
//   [退職者が他の画面を開いたら]
//   ・home.html など、共通の枠（js/layout.js）を使う画面は、退職者ポータルへ送る。ログイン後の行き先（homeFor）も同じ
//   [管理側 admin-members.html]
//   ・退職手続き中・退職の人のドロワーにだけ「退職手続き」が出る。在籍中の人には出ない
//   ・書類ごとの状態（未登録・手続き中・発行済み・公開中）と、押せる操作が状態に合っている
//   ・390px でも崩れない
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const br = await launch();
let bad = 0;
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const LEFT_ME = { email: "ex@8grp.co.jp", userId: "u-left", appRole: "member", isAdmin: false, roles: [], memberships: [],
  gw: { available: true, tenantId: "t1", employee: { id: "e-left", display_name: "山田 太郎", status: "left", left_on: "2026-09-30" },
    stage: { key: "left", label: "退職", note: "", allowed: [], preparingOnly: [], unlocked: false }, roles: [], apps: [], isHr: false, isOwner: false, left: true },
  access: { recruit: false, sell: false, office: false, keiei: false } };
const ACTIVE_ME = { email: "m@8grp.co.jp", appRole: "member", isAdmin: false, roles: [], memberships: [],
  gw: { available: true, tenantId: "t1", employee: { id: "e-m", display_name: "在籍 花子", status: "active" }, roles: [], apps: [], stage: { key: "member", label: "メンバー", allowed: ["home"], preparingOnly: [], unlocked: false } },
  access: { recruit: false, sell: false, office: false, keiei: false } };
const DOCS = [
  { kind: "certificate", label: "退職証明書", icon: "badge", state: "issued", id: "d-cert", issuedOn: "2026-10-01", expectedOn: null },
  { kind: "withholding", label: "源泉徴収票", icon: "request_quote", state: "preparing", id: null, issuedOn: null, expectedOn: "2026-10-20" },
  { kind: "separation", label: "離職票", icon: "assignment_return", state: "processing", id: null, issuedOn: null, expectedOn: null },
  { kind: "insurance_loss", label: "健康保険 資格喪失証明書", icon: "health_and_safety", state: "issued", id: "d-ins", issuedOn: "2026-10-02", expectedOn: null },
];

async function open(path, { me = LEFT_ME, width = 1280, noSession = false, meStatus = 200 } = {}) {
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  const calls = { file: [], retiree: 0 };
  await page.addInitScript((ns) => {
    if (!ns) localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "ex@8grp.co.jp" }));
    for (const k of ["kp_layout", "kp_me", "kp_nav_open"]) localStorage.removeItem(k);
    window.__opened = [];
    window.open = (u) => { window.__opened.push(u); return { opener: null, close() {}, location: { set href(v) { window.__opened.push("nav:" + v); } } }; };
  }, noSession);
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (!url.startsWith(BASE)) return route.abort();
    if (!/\/api\//.test(url)) return route.continue();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/me\b/.test(url)) return send(me, meStatus);
    if (/\/api\/retiree\/file/.test(url)) { calls.file.push(new URL(url).search); return send({ url: `${BASE}/img/logo.svg`, filename: "退職証明書.pdf", expiresIn: 300 }); }
    if (/\/api\/retiree\b/.test(url)) { calls.retiree++; return send({ name: "山田 太郎", leftOn: "2026-09-30", docs: DOCS }); }
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}${path}`);
  await page.waitForTimeout(1200);
  page.calls = calls;
  return page;
}

console.log("— 本人の画面 —");
{
  const page = await open("/retiree/");
  check(await page.locator("h1.rt-h").innerText() === "山田 太郎 様", "名前（様）が出る");
  check((await page.locator(".rt-meta").innerText()).includes("2026年9月30日"), "退職日が出る");
  const rows = await page.locator(".rt-row").evaluateAll((ns) => ns.map((n) => ({ kind: n.dataset.kind, state: n.dataset.state, name: n.querySelector(".rt-name").innerText, st: n.querySelector(".rt-st").innerText, btns: [...n.querySelectorAll("button")].map((b) => b.innerText.trim()) })));
  check(rows.map((r) => r.name).join("|") === "退職証明書|源泉徴収票|離職票|健康保険 資格喪失証明書", `書類は4つ、この順（${rows.map((r) => r.name).join("|")}）`);
  check(rows[0].st.startsWith("発行済み") && rows[0].st.includes("2026/10/01"), `退職証明書: 発行済み＋日付（${rows[0].st}）`);
  check(rows[0].btns.join(",") === "visibilityPDFを見る,downloadダウンロード".replace(/visibility|download(?=ダ)/g, "").replace("PDFを見る,ダウンロード", "PDFを見る,ダウンロード") || rows[0].btns.some((b) => b.includes("PDFを見る")) && rows[0].btns.some((b) => b.includes("ダウンロード")), "発行済みには [PDFを見る] [ダウンロード]");
  check(rows[1].st.includes("準備中") && rows[1].st.includes("2026/10/20") && rows[1].btns.length === 0, `源泉徴収票: 準備中＋発行予定、ボタン無し（${rows[1].st}）`);
  check(rows[2].st === "手続き中" && rows[2].btns.length === 0, "離職票: 手続き中、ボタン無し");
  check(rows[3].btns.length === 2, "資格喪失証明書（発行済み）にもボタン");
  check(await page.locator(".kp-sidebar, .kp-tabbar, .topbar, .kp-officenav, .hr-bar, .sl-bar").count() === 0, "社内のナビ（左メニュー・ヘッダー・業務切替）が出ない");
  const html = await page.content();
  check(!/t1\/retire|storage_path|sha256|signed\.example/.test(html), "保存先のパス・ハッシュは、画面に来ていない");
  const font = await page.evaluate(() => [getComputedStyle(document.body).fontFamily, getComputedStyle(document.body).backgroundColor]);
  check(font[0].includes("Zen Kaku Gothic New") && font[1] === "rgb(246, 246, 242)", `Zen Kaku Gothic New・背景 #f6f6f2（${font[0].split(",")[0]} / ${font[1]}）`);
  // 見る：書類の id だけを渡す。ダウンロード：download=1
  await page.locator('.rt-row[data-kind="certificate"] button[data-act="view"]').click();
  await page.waitForTimeout(400);
  check(page.calls.file.length === 1 && page.calls.file[0] === "?id=d-cert", `PDFを見る → id だけで取りにいく（${page.calls.file[0]}）`);
  check((await page.evaluate(() => window.__opened)).length >= 1, "別タブで開く");
  await page.locator('.rt-row[data-kind="insurance_loss"] button[data-act="download"]').click();
  await page.waitForTimeout(500);
  check(page.calls.file.at(-1) === "?id=d-ins&download=1", `ダウンロード → download=1（${page.calls.file.at(-1)}）`);
  await page.close();
}

console.log("— 画面の幅（横にはみ出さない） —");
for (const w of [1280, 768, 390]) {
  const page = await open("/retiree/", { width: w });
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 0, `${w}px: 横にはみ出さない（${over}）`);
  const btnsOk = await page.locator(".rt-row button").evaluateAll((ns) => ns.every((b) => { const r = b.getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.height >= 30; }));
  check(btnsOk, `${w}px: ボタンが画面に収まり、押せる大きさ`);
  await page.screenshot({ path: shotPath(`retiree-${w}.png`), fullPage: true });
  await page.close();
}

console.log("— 退職者ではない人・ログインしていない人 —");
{
  const page = await open("/retiree/", { me: ACTIVE_ME });
  check(new URL(page.url()).pathname === "/home.html", `在籍中の人は、ふだんの画面へ（${new URL(page.url()).pathname}）`);
  check(page.calls.retiree === 0, "在籍中の人は、書類の一覧を取りにいかない");
  await page.close();
  const p2 = await open("/retiree/", { noSession: true });
  check(new URL(p2.url()).pathname === "/index.html", `ログインしていなければ、ログイン画面へ（${new URL(p2.url()).pathname}）`);
  await p2.close();
}

console.log("— 退職者が他の画面を開いたら —");
for (const path of ["/home.html", "/tasks.html", "/mypage.html", "/admin-members.html"]) {
  const page = await open(path);
  check(new URL(page.url()).pathname.replace(/\/$/, "") === "/retiree", `${path} → 退職者ポータルへ（${new URL(page.url()).pathname}）`);
  await page.close();
}
// ログイン画面を開いたとき、ログイン済みなら行き先（KPLayout.homeFor）へ送られる
{
  const p1 = await open("/index.html", { me: LEFT_ME });
  check(new URL(p1.url()).pathname.replace(/\/$/, "") === "/retiree", `ログイン済みの退職者が / を開くと、退職者ポータルへ（${new URL(p1.url()).pathname}）`);
  await p1.close();
  const p2 = await open("/index.html", { me: ACTIVE_ME });
  check(new URL(p2.url()).pathname === "/home.html", `在籍中の人の行き先は、これまでどおり home.html（${new URL(p2.url()).pathname}）`);
  await p2.close();
}

console.log("— 管理側：メンバー管理の「退職手続き」 —");
const empRow = (id, name, status, left_on = null) => ({ id, display_name: name, email: `${id}@8grp.co.jp`, user_id: `u-${id}`, department: "開発", employment_type: "アルバイト",
  status, left_on, joined_on: "2025-04-01", employee_kind: "proper", partner_company_id: null, roles: [], accounts: {}, apps: { hr: false, sales: false, office: false, keiei: false }, appLocks: {}, access: {}, accessMeta: {} });
async function openAdmin({ width = 1280, canStamp = true, seals = [{ id: "seal-cert", name: "証明書発行用印" }] } = {}) {
  const page = await br.newPage({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  const posts = [];
  const certPosts = [];
  await page.addInitScript(() => { localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "own@8grp.co.jp" })); for (const k of ["kp_layout", "kp_me", "kp_nav_open"]) localStorage.removeItem(k); });
  page.on("dialog", (d) => d.accept());
  const OWNER_ME = { email: "own@8grp.co.jp", appRole: "owner", isAdmin: false, roles: [], memberships: [], gw: { employee: { id: "e-own", display_name: "経営 太郎", status: "active" }, roles: ["owner"], tenantId: "t1", stage: null }, access: { recruit: true, sell: true, office: true, keiei: true, officeHr: true, officeFinance: true, officeApp: true } };
  const KINDS = [
    { kind: "certificate", label: "退職証明書", icon: "badge", adminState: "published", current: { id: "d-cert", version: 2, issuedOn: "2026-10-01", expectedOn: null }, history: [] },
    { kind: "withholding", label: "源泉徴収票", icon: "request_quote", adminState: "none", current: null, history: [] },
    { kind: "separation", label: "離職票", icon: "assignment_return", adminState: "processing", current: { id: "d-sep", version: 1, issuedOn: null, expectedOn: "2026-10-30" }, history: [] },
    { kind: "insurance_loss", label: "健康保険 資格喪失証明書", icon: "health_and_safety", adminState: "issued", current: { id: "d-ins", version: 1, issuedOn: "2026-10-02", expectedOn: null }, history: [] },
  ];
  await page.route("**/api/**", async (route) => {
    const req = route.request(); const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (/\/api\/employees\/retire-cert/.test(url)) {
      const b = JSON.parse(req.postData() || "{}"); certPosts.push(b);
      if (b.action === "draft") {
        return send({ body: `山田 太郎 殿\n\n下記のとおり、当社を退職したことを証明します。\n\n退職日：2026年9月30日${b.includeReason ? "\n退職の事由：契約期間満了" : ""}`, unresolved: [],
          employee: { id: "e-left", name: "山田 太郎", leftOn: "2026-09-30", status: "left" }, company: { name: "株式会社エイト", representative: "代表取締役 森田 太郎", address: "東京都千代田区1-1-1", ready: true },
          reason: { code: "contract_end", label: "契約期間満了" }, templates: [{ id: "tpl-1", name: "退職証明書（標準）" }], seals, canStamp });
      }
      if (b.action === "preview") return send({ pdfBase64: Buffer.from("%PDF-1.4\n%%EOF").toString("base64") });
      if (b.action === "issue") return send({ document: { id: "d-new", issuedNo: "RET-2026-0013", version: 3 } });
      return send({ ok: true });
    }
    if (/\/api\/employees\/retire/.test(url)) {
      if (req.method() === "POST") { posts.push(JSON.parse(req.postData() || "{}")); return send({ ok: true }); }
      return send({ employee: { id: "e-left", name: "山田 太郎", leftOn: "2026-09-30", status: "left" }, reason: { code: "contract_end", note: "" },
        reasons: [{ key: "contract_end", label: "契約期間満了" }, { key: "personal", label: "自己都合" }], kinds: KINDS,
        progress: { done: 3, total: 6, steps: [{ label: "退職日", done: true }, { label: "システム停止", done: true }, { label: "退職証明書", done: true }, { label: "源泉徴収票", done: false }, { label: "離職票", done: false }, { label: "健康保険 資格喪失証明書", done: false }] } });
    }
    if (/\/api\/employees\b/.test(url) && req.method() === "GET") return send({ employees: [empRow("e-left", "山田 太郎", "left", "2026-09-30"), empRow("e-act", "在籍 花子", "active")], canManage: true, canGrantRoles: true, canGrantOwner: true, appsState: "table", systems: {}, kindReady: true });
    if (/\/api\/partners\b/.test(url)) return send({ companies: [], canManage: true });
    if (/\/api\/me\b/.test(url)) return send(OWNER_ME);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    return send({});
  });
  await page.goto(`${BASE}/admin-members.html`);
  await page.waitForTimeout(1300);
  page.posts = posts; page.certPosts = certPosts;
  return page;
}
{
  const page = await openAdmin();
  await page.evaluate(() => startEdit("e-act"));
  await page.waitForTimeout(400);
  check(await page.locator("#e-retire").isHidden(), "在籍中の人のドロワーには、退職手続きが出ない");
  await page.evaluate(() => closeAdd());
  await page.evaluate(() => startEdit("e-left"));
  await page.waitForSelector("#e-retire .rt-docrow");
  check(await page.locator("#e-retire").isVisible(), "退職の人のドロワーには、退職手続きが出る");
  const rows = await page.locator("#e-retire .rt-docrow").evaluateAll((ns) => ns.map((n) => ({ kind: n.dataset.kind, st: n.querySelector(".st").innerText, acts: [...n.querySelectorAll("button")].map((b) => b.innerText.trim()) })));
  check(rows.length === 4, "書類は4つ");
  check(rows[0].st.includes("本人に公開中") && rows[0].st.includes("第2版") && rows[0].acts.join(",") === "PDFを見る,公開停止,再発行（作り直す）,再登録", `退職証明書: 公開中・第2版・[PDFを見る][公開停止][再発行（作り直す）][再登録]（${rows[0].st} / ${rows[0].acts}）`);
  check(rows[1].st === "未登録" && rows[1].acts.join(",") === "登録,手続き中にする", `源泉徴収票: 未登録・[登録][手続き中にする]（${rows[1].acts}）`);
  check(rows[2].st.includes("手続き中") && rows[2].st.includes("2026/10/30") && rows[2].acts.join(",") === "登録,未登録に戻す", `離職票: 手続き中・発行予定・[登録][未登録に戻す]（${rows[2].acts}）`);
  check(rows[3].st.includes("本人には未公開") && rows[3].acts.join(",") === "PDFを見る,本人に公開,再登録", `資格喪失証明書: 発行済み未公開・[PDFを見る][本人に公開][再登録]（${rows[3].acts}）`);
  check((await page.locator("#e-retire .rt-prog").innerText()).includes("3 / 6"), "進捗 3 / 6");
  check(await page.locator("#e-reason-code").inputValue() === "contract_end", "退職理由が選ばれている");
  await page.locator('#e-retire .rt-docrow[data-kind="insurance_loss"] button', { hasText: "本人に公開" }).click();
  await page.waitForTimeout(400);
  check(page.posts.some((p) => p.action === "publish" && p.docId === "d-ins"), "「本人に公開」→ publish を送る");
  await page.locator('#e-retire .rt-docrow[data-kind="withholding"] button', { hasText: "手続き中にする" }).click();
  await page.waitForTimeout(400);
  check(page.posts.some((p) => p.action === "progress" && p.kind === "withholding" && p.state === "processing"), "「手続き中にする」→ progress を送る");
  await page.locator("#e-reason-code").selectOption("personal");
  await page.locator("#e-retire button", { hasText: "退職理由を保存" }).click();
  await page.waitForTimeout(400);
  check(page.posts.some((p) => p.action === "reason" && p.reasonCode === "personal"), "退職理由を保存 → reason を送る");
  await page.close();
}
console.log("— 管理側：退職証明書の作成 —");
{
  const page = await openAdmin();
  await page.evaluate(() => startEdit("e-left"));
  await page.waitForSelector("#e-retire .rt-docrow");
  const certRowBtns = await page.locator('#e-retire .rt-docrow[data-kind="certificate"] button').allInnerTexts();
  check(certRowBtns.includes("再発行（作り直す）"), `退職証明書の行に [再発行（作り直す）]（${certRowBtns}）`);
  const certOther = await page.locator('#e-retire .rt-docrow[data-kind="withholding"] button').allInnerTexts();
  check(!certOther.some((t) => t.includes("証明書を作成") || t.includes("再発行")), "ほかの書類には、証明書の作成ボタンは無い");
  await page.locator('#e-retire .rt-docrow[data-kind="certificate"] button', { hasText: "再発行" }).click();
  await page.waitForSelector("#e-cert-card");
  check((await page.locator("#c-body").inputValue()).includes("山田 太郎 殿"), "差し込み済みの本文が出る（編集できる）");
  check(!(await page.locator("#c-body").inputValue()).includes("退職の事由"), "退職理由は、既定では本文に入らない");
  await page.locator("#c-reason").check();
  await page.waitForTimeout(500);
  check((await page.locator("#c-body").inputValue()).includes("退職の事由：契約期間満了"), "「退職理由を含める」を選ぶと本文に入る");
  check(page.certPosts.some((p) => p.action === "draft" && p.includeReason === true), "含める → draft を作り直す");
  check((await page.locator("#e-cert-card .note").innerText()).includes("証明書発行用印"), "押印に使う印鑑は、証明書発行用の名前だけが出る（画像は出ない）");
  check(await page.locator("#e-cert-card img").count() === 0, "印影の画像は、画面に出ない");
  await page.locator("#e-cert-card button", { hasText: "プレビュー" }).click();
  await page.waitForTimeout(500);
  check(page.certPosts.some((p) => p.action === "preview" && p.body.includes("山田 太郎 殿")), "プレビュー → 本文を送って PDF を受け取る");
  check(await page.locator("#c-issue").isEnabled(), "経営者・管理者（canStamp）は [発行・押印] を押せる");
  await page.locator("#c-issue").click();
  await page.waitForTimeout(600);
  check(page.certPosts.some((p) => p.action === "issue" && p.includeReason === true), "発行・押印 → issue を送る");
  check((await page.locator("#mb-toast").innerText()).includes("RET-2026-0013"), "発行番号が出る");
  await page.close();

  const p2 = await openAdmin({ canStamp: false });
  await p2.evaluate(() => startEdit("e-left")); await p2.waitForSelector("#e-retire .rt-docrow");
  await p2.locator('#e-retire .rt-docrow[data-kind="certificate"] button', { hasText: "再発行" }).click();
  await p2.waitForSelector("#e-cert-card");
  check(await p2.locator("#c-issue").isDisabled(), "押せない人（人事だけ）は [発行・押印] が押せない");
  check((await p2.locator("#e-cert-card .note").innerText()).includes("経営者・管理者だけ"), "押せない理由が出る");
  await p2.close();

  const p3 = await openAdmin({ seals: [] });
  await p3.evaluate(() => startEdit("e-left")); await p3.waitForSelector("#e-retire .rt-docrow");
  await p3.locator('#e-retire .rt-docrow[data-kind="certificate"] button', { hasText: "再発行" }).click();
  await p3.waitForSelector("#e-cert-card");
  check(await p3.locator("#c-issue").isDisabled() && (await p3.locator("#e-cert-card .note").innerText()).includes("登録されていません"), "証明書用の印鑑が無ければ、発行できず、登録の案内が出る");
  await p3.close();
}

for (const w of [768, 390]) {
  const page = await openAdmin({ width: w });
  await page.evaluate(() => startEdit("e-left"));
  await page.waitForSelector("#e-retire .rt-docrow");
  const m = await page.evaluate(() => { const d = document.getElementById("e-drawer"); const r = d.getBoundingClientRect(); const b = document.querySelector("#e-retire"); return { drawerRight: r.right, w: window.innerWidth, bodyOver: document.documentElement.scrollWidth - window.innerWidth, bodyScrollW: document.querySelector(".mb-dr-body").scrollWidth, bodyClientW: document.querySelector(".mb-dr-body").clientWidth }; });
  check(m.drawerRight <= m.w + 1, `${w}px: ドロワーが画面に収まる`);
  check(m.bodyScrollW <= m.bodyClientW + 1, `${w}px: 退職手続きの中身が、ドロワーの横にはみ出さない（${m.bodyScrollW}/${m.bodyClientW}）`);
  await page.locator('#e-retire .rt-docrow[data-kind="certificate"] button', { hasText: "再発行" }).click();
  await page.waitForSelector("#e-cert-card");
  const m2 = await page.evaluate(() => ({ sw: document.querySelector(".mb-dr-body").scrollWidth, cw: document.querySelector(".mb-dr-body").clientWidth }));
  check(m2.sw <= m2.cw + 1, `${w}px: 証明書の作成欄もはみ出さない（${m2.sw}/${m2.cw}）`);
  await page.screenshot({ path: shotPath(`retire-cert-${w}.png`) });
  await page.screenshot({ path: shotPath(`retire-admin-${w}.png`) });
  await page.close();
}

await br.close();
console.log(bad ? `\n${bad} 件 NG` : "\nすべて通過");
process.exit(bad ? 1 : 0);
