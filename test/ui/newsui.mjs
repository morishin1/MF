// サイトのお知らせの画面を、実際に触って通す。
import { launch, BASE } from "../_browser.mjs";
import { shotPath } from "../_shot.mjs";

const meAdmin = {
  email: "zimu@8grp.co.jp", appRole: "admin", isAdmin: true, shows: {},
  gw: { employee: { id: "emp-0", display_name: "事務", status: "active" },
        roles: ["owner"], isAdmin: true, tenantId: "t1", stage: null },
};

const KINDS = [
  { key: "エイトブログ", prefix: "blog-vol", cat: "BLOG" },
  { key: "お知らせ", prefix: "eight-news-vol", cat: "NEWS" },
  { key: "プレスリリース", prefix: "press-vol", cat: "PRESS" },
];

let items = [];
const posted = [];

const reset = () => {
  items = [
    { id: "a1", articleId: 152, slug: "blog-vol152", title: "シフト調整に週5時間",
      kind: "エイトブログ", cat: "BLOG", summary: "概要です。", body: "<p>本文</p>",
      status: "published", view: { key: "published", label: "公開中" },
      publishedOn: "2026-08-30", source: "notion",
      url: "https://8grp.co.jp/news/blog-vol152/" },
    { id: "a2", articleId: 153, slug: "blog-vol153", title: "書きかけの下書き",
      kind: "エイトブログ", cat: "BLOG", summary: "まだ途中。", body: "<h2>見出し</h2><p>中身</p>",
      status: "draft", view: { key: "draft", label: "下書き" },
      publishedOn: null, source: "portal",
      url: "https://8grp.co.jp/news/blog-vol153/" },
    { id: "a3", articleId: 154, slug: "press-vol3", title: "来月出すお知らせ",
      kind: "プレスリリース", cat: "PRESS", summary: "予定。", body: "<p>予定</p>",
      status: "published", view: { key: "planned", label: "公開予定" },
      publishedOn: "2099-10-01", source: "portal",
      url: "https://8grp.co.jp/news/press-vol3/" },
  ];
  posted.length = 0;
};

const br = await launch();
let bad = 0;
const errs = [];
const check = (c, m) => { if (!c) { console.log("NG:", m); bad++; } else console.log("  ok", m); };

function wire(page) {
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => m.type() === "error"
    && !/fonts\.googleapis|net::ERR|Failed to load resource|manifest/i.test(m.text())
    && errs.push(m.text()));

  return page.route("**/api/**", (route) => {
    const req = route.request();
    const url = req.url();
    const send = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    const body = req.postData() ? JSON.parse(req.postData()) : {};

    if (/\/api\/me\b/.test(url)) return send(meAdmin);
    if (/\/api\/notifications/.test(url)) return send({ notifications: [], unread: 0 });
    if (/\/api\/badges/.test(url)) return send({ badges: {} });
    if (/\/api\/config/.test(url)) return send({});

    if (/\/api\/site-news/.test(url)) {
      if (req.method() === "POST") {
        posted.push({ m: "POST", ...body });
        const made = {
          id: "new1", articleId: 155, slug: body.slug, title: body.title,
          kind: body.kind, cat: "BLOG", summary: body.summary, body: body.body,
          status: body.status,
          view: body.status === "published"
            ? { key: "published", label: "公開中" } : { key: "draft", label: "下書き" },
          publishedOn: body.publishedOn, source: "portal",
          url: `https://8grp.co.jp/news/${body.slug}/`,
        };
        items = [made, ...items];
        return send({ item: made, sync: { at: "2026-09-13 08:00", inHours: 20 } });
      }
      if (req.method() === "PATCH") {
        posted.push({ m: "PATCH", ...body });
        items = items.map((a) => {
          if (a.id !== body.id) return a;
          if (body.action === "publish") {
            return { ...a, status: "published", view: { key: "published", label: "公開中" },
                     publishedOn: "2026-09-12" };
          }
          if (body.action === "unpublish") {
            return { ...a, status: "draft", view: { key: "draft", label: "下書き" } };
          }
          return { ...a, ...body, view: a.view };
        });
        return send({ item: items.find((a) => a.id === body.id),
                      sync: { at: "2026-09-13 08:00", inHours: 20 } });
      }
      if (req.method() === "DELETE") {
        const id = new URL(url).searchParams.get("id");
        posted.push({ m: "DELETE", id });
        items = items.filter((a) => a.id !== id);
        return send({ ok: true });
      }
      return send({
        items,
        counts: {
          draft: items.filter((a) => a.view.key === "draft").length,
          planned: items.filter((a) => a.view.key === "planned").length,
          published: items.filter((a) => a.view.key === "published").length,
        },
        kinds: KINDS,
        sync: { at: "2026-09-13 08:00", inHours: 20 },
        today: "2026-09-12",
        maxBody: 200000,
      });
    }
    return send({});
  });
}

{
  reset();
  const page = await br.newPage({ viewport: { width: 1500, height: 1100 }, timezoneId: "Asia/Tokyo" });
  await page.addInitScript(() => {
    localStorage.setItem("kp_session", JSON.stringify({ access_token: "x", email: "a@b.c" }));
    localStorage.setItem("kp_layout", JSON.stringify({ appRole: "admin", name: "事務", shows: {}, stage: null }));
  });
  await wire(page);
  page.on("dialog", (d) => d.accept("https://8grp.co.jp/"));

  await page.goto(`${BASE}/admin-site-news.html`);
  await page.waitForTimeout(1400);

  console.log("— 一覧 —");
  check(await page.locator("#l-rows tr").count() === 3, "お知らせごとに1行");
  {
    const t = await page.locator("#l-rows").textContent();
    check(t.includes("公開中") && t.includes("下書き") && t.includes("公開予定"),
      "3つの状態が出しわけられる");
    check(t.includes("/news/blog-vol152/"), "サイトでのURLが出る");
    check(t.includes("Notion"), "Notion から取り込んだものが分かる");
  }
  check((await page.locator(".banner.warn").textContent()).includes("すぐ出ません"),
    "すぐサイトに出ないことを先に書く");
  check((await page.locator("#s-next").textContent()).includes("2026-09-13 08:00"),
    "次の同期がいつか出る");
  check((await page.locator("#c-draft").textContent()).trim() === "1", "下書きの件数が出る");

  console.log("— 絞り込み —");
  await page.locator("#pane-list .tab:has-text('下書き')").click();
  await page.waitForTimeout(300);
  check(await page.locator("#l-rows tr").count() === 1, "下書きだけになる");
  await page.locator("#pane-list .tab:has-text('すべて')").click();
  await page.waitForTimeout(300);
  await page.locator("#l-find").fill("press");
  await page.waitForTimeout(300);
  check(await page.locator("#l-rows tr").count() === 1, "URLでも絞り込める");
  await page.locator("#l-find").fill("");
  await page.waitForTimeout(300);

  console.log("— 新しく書く —");
  await page.locator("button:has-text('新しく書く')").click();
  await page.waitForTimeout(400);
  check(!(await page.locator("#pane-edit").isHidden()), "書く画面が開く");
  check(await page.locator("#e-date").inputValue() === "2026-09-12", "公開日に今日が入る");

  await page.locator("#e-t").fill("AIで棚卸しを半分にする");
  await page.waitForTimeout(300);
  check(await page.locator("#e-slug").inputValue() === "blog-vol155",
    `題名を入れるとURLが決まる（${await page.locator("#e-slug").inputValue()}）`);
  check((await page.locator("#e-url").textContent()).includes("https://8grp.co.jp/news/blog-vol155/"),
    "できあがるURLが見える");

  await page.locator("#e-kind").selectOption("プレスリリース");
  await page.waitForTimeout(300);
  check(await page.locator("#e-slug").inputValue() === "press-vol155",
    "種別を変えるとURLの頭も変わる");
  await page.locator("#e-kind").selectOption("エイトブログ");
  await page.waitForTimeout(200);

  console.log("— 本文と、できあがり —");
  await page.locator("#e-sum").fill("棚卸しの手順をAIに任せる進め方をまとめました。");
  await page.locator("#e-body").fill(
    '<h2>見出し</h2><p>本文です。</p><ul><li>ひとつ<li>ふたつ</ul>'
    + '<script>alert(1)</script><p onclick="x()">危ないの</p>');
  await page.waitForTimeout(500);
  {
    const html = await page.locator("#e-prev").innerHTML();
    check(!/alert|onclick/i.test(html), `使えないものは出来上がりに出ない（${html.slice(0, 80)}）`);
    check(html.includes("<h2>見出し</h2>"), "見出しはそのまま出る");
    check(await page.locator("#e-prev li").count() === 2, "閉じ忘れの箇条書きも2つに見える");
    check(html.includes("危ないの"), "文字は残る");
  }
  check(Number(await page.locator("#e-body-n").textContent()) > 0, "文字数が出る");

  console.log("— 書きやすさ —");
  await page.locator("#e-body").fill("");
  await page.locator("button.sn-tag:has-text('見出し')").first().click();
  await page.waitForTimeout(200);
  check((await page.locator("#e-body").inputValue()).includes("<h2></h2>"), "押すとタグが入る");
  await page.locator("#e-body").fill('<h2>見出し</h2><p>本文です。</p>');
  await page.waitForTimeout(300);

  console.log("— 下書きとして保存 —");
  await page.locator("#e-save").click();
  await page.waitForTimeout(900);
  {
    const p = posted.filter((x) => x.m === "POST").pop();
    check(p && p.status === "draft", "下書きとして送られる");
    check(p && p.slug === "blog-vol155", "URLが付いて送られる");
    check(p && p.title === "AIで棚卸しを半分にする", "タイトルが送られる");
    check((await page.locator("#e-msg").textContent()).includes("下書きとして保存"),
      "保存できたことが出る");
    check(await page.locator("#e-title").textContent() === "直す",
      "保存したあとは、そのまま直せる状態になる");
  }

  console.log("— 公開にする（確認を挟む） —");
  let asked = "";
  page.removeAllListeners("dialog");
  page.on("dialog", (d) => { asked = d.message(); d.accept(); });
  await page.locator("#e-pub").click();
  await page.waitForTimeout(900);
  check(/毎朝8時|公開にします/.test(asked), `押す前に確認する（${asked.slice(0, 40)}）`);
  check((await page.locator("#e-msg").textContent()).includes("2026-09-13 08:00"),
    "いつサイトに出るかを、保存のあとにも出す");

  console.log("— 一覧からの操作 —");
  await page.locator("#tab-list").click();
  await page.waitForTimeout(500);
  check(await page.locator("#l-rows tr:has-text('書きかけの下書き') button:has-text('公開にする')").count() === 1,
    "下書きには「公開にする」が出る");
  check(await page.locator("#l-rows tr:has-text('シフト調整') button:has-text('下書きに戻す')").count() === 1,
    "公開中には「下書きに戻す」が出る");
  check(await page.locator("#l-rows tr:has-text('シフト調整') a:has-text('サイトで見る')").count() === 1,
    "公開中はサイトで見られる");
  check(await page.locator("#l-rows tr:has-text('シフト調整') button[title='消す']").count() === 0,
    "公開中は消せない（先に下書きに戻す）");

  posted.length = 0;
  await page.locator("#l-rows tr:has-text('書きかけの下書き') button:has-text('公開にする')").click();
  await page.waitForTimeout(900);
  {
    const p = posted.find((x) => x.m === "PATCH");
    check(p && p.action === "publish" && p.id === "a2", "公開にできる");
  }

  await page.locator("#tab-list").click();
  await page.waitForTimeout(300);
  posted.length = 0;
  await page.locator("#l-rows tr:has-text('シフト調整') button:has-text('下書きに戻す')").click();
  await page.waitForTimeout(900);
  check(posted.some((x) => x.action === "unpublish"), "下書きに戻せる");

  console.log("— 既存の下書きを直す —");
  await page.locator("#l-rows tr:has-text('来月出すお知らせ') button:has-text('直す')").click();
  await page.waitForTimeout(600);
  check(await page.locator("#e-t").inputValue() === "来月出すお知らせ", "中身が入って開く");
  check(await page.locator("#e-slug").inputValue() === "press-vol3", "URLはそのまま");
  await page.locator("#e-t").fill("来月出すお知らせ（改）");
  await page.waitForTimeout(400);
  check(await page.locator("#e-slug").inputValue() === "press-vol3",
    "題名を直しても、既にあるURLは変えない（リンクが切れるため）");

  await page.screenshot({ path: shotPath("news-edit.png") });
  await page.locator("#tab-list").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shotPath("news-list.png") });

  console.log("— メニュー —");
  check(await page.locator(".kp-side-item:has-text('サイトのお知らせ')").count() === 1,
    "サイドメニューに出る");
  check(await page.locator(".kp-side-item.on:has-text('サイトのお知らせ')").count() === 1,
    "開いている項目として選ばれている");

  await page.close();
}

await br.close();
if (errs.length) { console.log("\n画面のエラー:"); for (const e of new Set(errs)) console.log("  -", e); bad += new Set(errs).size; }
console.log(bad ? `\nNG ${bad} 件` : "\nすべて通過");
process.exit(bad ? 1 : 0);
