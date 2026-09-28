// 印鑑管理と、署名依頼での印鑑の選択を、実際の画面（admin-esign.html）で通す。
//
// ■ 何を守りたいのか
//   ・「印鑑」タブは owner / admin にだけ出る（人事には出さない）
//   ・一覧：画像・名前・種類・使用中/無効、[編集] [無効化]
//   ・登録はモーダル。案内文・プレビューがあり、PNG / JPEG / WebP を選べる
//     WebP はブラウザで PNG にしてから置く（PDF に埋め込めるのは PNG/JPEG だけ）
//   ・2MB 超・不正形式は、置く前に止める
//   ・送るとき「押印しない」と有効な印鑑だけが選べ、選んだものが sealId で届く
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";
import { png } from "../_img.mjs";

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

const OWNER = {
  email: "o@8grp.co.jp", appRole: "owner", isAdmin: false,
  gw: { employee: { id: "emp-0", display_name: "森田", status: "active" },
        roles: ["owner"], isAdmin: false, isHr: true, tenantId: "t1", stage: null },
};
// 管理画面は開けるが、印鑑マスタは触れない人（人事）
const HR_ADMIN = {
  email: "h@8grp.co.jp", appRole: "admin", isAdmin: false,
  gw: { employee: { id: "emp-9", display_name: "人事", status: "active" },
        roles: ["hr"], isAdmin: false, isHr: true, tenantId: "t1", stage: null },
};

const TYPES = [
  { key: "representative", label: "代表者印" }, { key: "square", label: "角印" },
  { key: "contract", label: "契約用印" }, { key: "other", label: "その他" },
];
const IMG = `data:image/png;base64,${png(40, 40).toString("base64")}`;

let seals, calls, puts;
const reset = () => {
  seals = [
    { id: "s1", name: "代表者印", sealType: "representative", isActive: true, imageUrl: IMG },
    { id: "s2", name: "角印", sealType: "square", isActive: true, imageUrl: IMG },
    { id: "s3", name: "古い契約印", sealType: "contract", isActive: false, imageUrl: IMG },
  ];
  calls = [];
  puts = [];
};

async function open(me, path = "admin-esign.html") {
  const page = await br.newPage({ viewport: { width: 1400, height: 1000 }, timezoneId: "Asia/Tokyo" });
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("dialog", (d) => d.accept());
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.removeItem("kp_layout");
    localStorage.removeItem("kp_me");
  });
  await page.route("**/__upload/**", async (route) => {
    const req = route.request();
    puts.push({ type: req.headers()["content-type"], body: req.postDataBuffer() });
    return route.fulfill({ status: 200, body: "{}" });
  });
  await page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = req.postData() ? JSON.parse(req.postData()) : {};
    if (/\/api\/me\b/.test(url)) return send(me);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/sign\/seals/.test(url)) {
      const manage = me === OWNER;
      if (req.method() === "POST") {
        calls.push(body);
        if (!manage) return send({ error: "forbidden" }, 403);
        if (body.action === "upload") {
          return send({ path: `t1/seals/new.${body.mimeType === "image/jpeg" ? "jpg" : "png"}`,
                        uploadUrl: `${BASE}/__upload/t1/seals/new`, token: "t" });
        }
        if (body.action === "create") {
          seals.push({ id: `s${seals.length + 1}`, name: body.name, sealType: body.sealType,
                       isActive: body.isActive !== false, imageUrl: IMG });
          return send({ seal: seals[seals.length - 1] });
        }
        if (body.action === "update") {
          const s = seals.find((x) => x.id === body.id);
          if (typeof body.isActive === "boolean") s.isActive = body.isActive;
          if (body.name) s.name = body.name;
          return send({ seal: s });
        }
      }
      return send({ seals: manage ? seals : seals.filter((s) => s.isActive), types: TYPES,
                    canManage: manage, limits: { maxBytes: 2 * 1024 * 1024 } });
    }
    if (/\/api\/sign\/templates/.test(url)) {
      return send({ templates: [{ id: "t1", name: "雇用契約書", doc_kind: "employment", version: 1, due_days: 7, body: "x" }],
                    kinds: [], mergeFields: [], starters: {} });
    }
    if (/\/api\/sign\/orders/.test(url)) return send({ orders: [], counts: {}, kinds: [], fields: [], statuses: [] });
    if (/\/api\/sign\b/.test(url)) {
      if (req.method() === "POST") { calls.push({ send: body }); return send({ sent: [{ id: "r9", name: "山田 太郎" }], failed: [] }); }
      return send({ requests: [], counts: {}, kinds: [], mergeFields: [] });
    }
    if (/\/api\/employees/.test(url)) {
      return send({ employees: [{ id: "emp-1", display_name: "山田 太郎", department: "制作部", status: "active", user_id: "u1" }] });
    }
    return send({});
  });
  await page.goto(`${BASE}/${path}`);
  await page.waitForTimeout(900);
  return page;
}

/** ブラウザに本物の画像を作らせる（WebP・JPEG） */
const encode = (page, type) => page.evaluate(async (t) => {
  const c = document.createElement("canvas");
  c.width = 64; c.height = 64;
  const g = c.getContext("2d");
  g.strokeStyle = "rgba(200,30,30,1)"; g.lineWidth = 6;
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.stroke();
  const blob = await new Promise((ok) => c.toBlob(ok, t, 0.9));
  const buf = new Uint8Array(await blob.arrayBuffer());
  return { type: blob.type, bytes: Array.from(buf) };
}, type);

console.log("— owner：印鑑タブと一覧 —");
{
  reset();
  const page = await open(OWNER, "admin-esign.html?tab=seal");
  check(await page.locator("#tab-seal").isVisible(), "「印鑑」タブが出る");
  check(await page.locator("#pane-seal").isVisible(), "?tab=seal で印鑑タブが開く");
  const cards = await page.locator("#seal-list [data-seal]").count();
  check(cards === 3, `一覧に3件（いま ${cards}）`);
  const first = await page.locator('[data-seal="s1"]').innerText();
  check(first.includes("代表者印") && first.includes("使用中") && first.includes("編集") && first.includes("無効化"),
    "代表者印：名前・使用中・[編集][無効化]");
  const off = await page.locator('[data-seal="s3"]').innerText();
  check(off.includes("無効") && off.includes("有効にする"), "無効の印鑑は「無効」「有効にする」");
  check(await page.locator('[data-seal="s1"] img.es-seal-img').count() === 1, "画像が出る");

  // 無効化
  await page.click('[data-seal="s2"] button:has-text("無効化")');
  await page.waitForTimeout(300);
  check(calls.some((c) => c.action === "update" && c.id === "s2" && c.isActive === false), "無効化が届く");
  check((await page.locator('[data-seal="s2"]').innerText()).includes("有効にする"), "無効に切り替わる");
  await page.click('[data-seal="s2"] button:has-text("有効にする")');
  await page.waitForTimeout(300);
  check(calls.some((c) => c.action === "update" && c.id === "s2" && c.isActive === true), "有効化が届く");

  await page.screenshot({ path: shotPath("seal-list.png") });

  console.log("\n— 登録モーダル：PNG —");
  await page.click("#seal-add");
  const modal = page.locator(".es-modal");
  check(await modal.isVisible(), "モーダルが開く");
  const text = await modal.innerText();
  check(text.includes("背景透過PNGを推奨します。") && text.includes("契約書に使用する印鑑画像を登録してください。"), "案内文");
  for (const x of ["印鑑名", "種類", "印鑑画像", "使用する", "無効"]) check(text.includes(x), `入力項目「${x}」`);
  await page.fill("#sm-name", "契約印");
  await page.selectOption("#sm-type", "contract");
  await page.setInputFiles("#sm-file", { name: "seal.png", mimeType: "image/png", buffer: png(40, 40) });
  await page.waitForTimeout(200);
  check(await page.locator("#sm-preview").isVisible(), "選ぶとプレビューが出る");
  await page.screenshot({ path: shotPath("seal-modal.png") });
  await page.click("#sm-save");
  await page.waitForTimeout(500);
  const created = calls.find((c) => c.action === "create");
  check(created && created.name === "契約印" && created.sealType === "contract" && created.isActive === true
    && created.path === "t1/seals/new.png", "登録が届く（名前・種類・使用する・置いたパス）");
  check(puts[0]?.type === "image/png" && puts[0].body.subarray(0, 4).toString("latin1") === "\x89PNG", "PNG をそのまま置く");
  check(!(await page.locator(".es-modal").count()), "保存したらモーダルを閉じる");
  check(await page.locator("#seal-list [data-seal]").count() === 4, "一覧に増える");

  console.log("\n— 登録モーダル：JPEG・WebP —");
  const jpg = await encode(page, "image/jpeg");
  puts.length = 0; calls.length = 0;
  await page.click("#seal-add");
  await page.fill("#sm-name", "角印2");
  await page.setInputFiles("#sm-file", { name: "k.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpg.bytes) });
  await page.click("#sm-save");
  await page.waitForTimeout(500);
  check(puts[0]?.type === "image/jpeg", "JPEG はそのまま JPEG で置く");
  check(calls.some((c) => c.action === "upload" && c.mimeType === "image/jpeg"), "JPEG として申告");

  const wp = await encode(page, "image/webp");
  check(wp.type === "image/webp", "（前提）ブラウザが WebP を作れる");
  puts.length = 0; calls.length = 0;
  await page.click("#seal-add");
  await page.fill("#sm-name", "WebP印");
  await page.setInputFiles("#sm-file", { name: "w.webp", mimeType: "image/webp", buffer: Buffer.from(wp.bytes) });
  await page.waitForTimeout(400);
  check(await page.locator("#sm-preview").isVisible(), "WebP もプレビューが出る");
  await page.click("#sm-save");
  await page.waitForTimeout(500);
  check(puts[0]?.type === "image/png" && puts[0].body.subarray(0, 4).toString("latin1") === "\x89PNG",
    "WebP は PNG に変換して置く");
  check(calls.some((c) => c.action === "upload" && c.mimeType === "image/png"), "PNG として申告");

  console.log("\n— 登録モーダル：拒否 —");
  puts.length = 0; calls.length = 0;
  await page.click("#seal-add");
  await page.fill("#sm-name", "大きい");
  await page.setInputFiles("#sm-file", { name: "big.png", mimeType: "image/png",
    buffer: Buffer.concat([png(), Buffer.alloc(2 * 1024 * 1024)]) });
  await page.waitForTimeout(200);
  check((await page.locator("#sm-msg").innerText()).includes("2MB"), "2MB 超は選んだ時点で止める");
  await page.setInputFiles("#sm-file", { name: "x.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
  await page.waitForTimeout(200);
  check((await page.locator("#sm-msg").innerText()).includes("PNG・JPEG・WebP"), "GIF は止める");
  await page.click("#sm-save");
  await page.waitForTimeout(200);
  check(!puts.length && !calls.some((c) => c.action === "upload"), "止めたものは置かない");
  await page.click(".es-modal button:has-text('閉じる')");

  console.log("\n— 送る：使用する印鑑 —");
  await page.click("#tab-send");
  const opts = await page.locator("#s-seal label").allInnerTexts();
  check(opts[0].trim() === "押印しない", "先頭は「押印しない」");
  check(await page.locator('input[name="s-seal"][value=""]').isChecked(), "既定は押印しない");
  check(!opts.some((o) => o.includes("古い契約印")), "無効な印鑑は選べない");
  check(opts.some((o) => o.includes("代表者印")) && opts.some((o) => o.includes("角印")), "有効な印鑑が並ぶ");

  await page.selectOption("#s-template", "t1");
  await page.locator("#s-who input[type=checkbox]").first().check();
  calls.length = 0;
  await page.click("button:has-text('署名依頼を送る')");
  await page.waitForTimeout(400);
  const noSeal = calls.find((c) => c.send)?.send;
  check(noSeal && !("sealId" in noSeal), "押印しないで送ると sealId を付けない");

  await page.locator("#s-who input[type=checkbox]").first().check();
  await page.check('input[name="s-seal"][value="s1"]');
  calls.length = 0;
  await page.click("button:has-text('署名依頼を送る')");
  await page.waitForTimeout(400);
  const withSeal = calls.find((c) => c.send)?.send;
  check(withSeal?.sealId === "s1", "代表者印を選んで送ると sealId が届く");
  await page.screenshot({ path: shotPath("seal-send.png") });
  await page.close();
}

console.log("\n— 人事（印鑑マスタは触れない）—");
{
  reset();
  const page = await open(HR_ADMIN);
  check(!(await page.locator("#tab-seal").isVisible()), "「印鑑」タブを出さない");
  const opts = await page.locator("#s-seal label").allInnerTexts();
  check(opts.some((o) => o.includes("代表者印")), "送るときに有効な印鑑は選べる");
  await page.goto(`${BASE}/admin-esign.html?tab=seal`);
  await page.waitForTimeout(700);
  check(!(await page.locator("#pane-seal").isVisible()), "?tab=seal で直接開いても出さない");
  await page.close();
}

console.log("\n— スマホ幅：モーダルがはみ出さない —");
{
  reset();
  const page = await open(OWNER, "admin-esign.html?tab=seal");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.click("#seal-add");
  const box = await page.locator(".es-modal").boundingBox();
  check(box && box.x >= 0 && box.x + box.width <= 390, "モーダルが画面内");
  await page.close();
}

check(!errs.length, `画面のエラーなし${errs.length ? `: ${errs.slice(0, 3).join(" / ")}` : ""}`);
await br.close();
console.log(bad ? `${bad} 件 失敗` : "すべて通過");
process.exit(bad ? 1 : 0);
