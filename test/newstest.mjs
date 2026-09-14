// サイトのお知らせ。本文の掃除と、APIの判断を通す。
//
// 本文は 8grp.co.jp のページへ **エスケープされずに** 入る
// （scripts/news-sync/sync.py が {a["body_html"]} をそのまま埋める）。
// つまりこの掃除が抜けると、公開ページでそのまま動く。ここを厚く見る。
import assert from "node:assert/strict";
import { mock } from "node:test";

import { fileURLToPath } from "node:url";
import { dirname, join as _join } from "node:path";
const _HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(_HERE);
const atRoot = (p) => _join(ROOT, p);

// ---- 偽の Supabase --------------------------------------------------------
const db = { rows: {}, writes: [] };
const DEFAULTS = {
  news_articles: { status: "draft", source: "portal", kind: "エイトブログ" },
};

function table(name) {
  const f = [];
  const q = {
    select() { return q; },
    eq(k, v) { f.push([k, v]); return q; },
    order() { return q; },
    limit() { return q; },
    maybeSingle() { return Promise.resolve({ data: copy(pick(name, f)), error: err(name) }); },
    single() { return Promise.resolve({ data: copy(pick(name, f)), error: err(name) }); },
    then(fn) {
      return Promise.resolve({ data: match(name, f).map(copy), error: err(name) }).then(fn);
    },
    insert(row) {
      if (err(name)) {
        const r = { select: () => r, single: () => Promise.resolve({ data: null, error: err(name) }) };
        return r;
      }
      // article_id / slug は一意。本物と同じようにぶつける
      const clash = (db.rows[name] || []).some(
        (x) => x.slug === row.slug || (row.article_id && x.article_id === row.article_id));
      if (clash) {
        const e = { code: "23505", message: "duplicate key value violates unique constraint" };
        const r = { select: () => r, single: () => Promise.resolve({ data: null, error: e }) };
        return r;
      }
      const made = { ...(DEFAULTS[name] || {}), id: `n${(db.rows[name] || []).length + 1}`, ...row };
      db.writes.push({ op: "insert", table: name, row: made });
      (db.rows[name] = db.rows[name] || []).push(made);
      const r = { select: () => r, single: () => Promise.resolve({ data: made, error: null }) };
      return r;
    },
    update(row) {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        select: () => r,
        single: () => {
          const cur = pick(name, g);
          if (cur) Object.assign(cur, row);
          db.writes.push({ op: "update", table: name, row, where: g });
          return Promise.resolve({ data: cur ? { ...cur } : null, error: err(name) });
        },
      };
      return r;
    },
    delete() {
      const g = [];
      const r = {
        eq: (k, v) => { g.push([k, v]); return r; },
        then: (fn) => {
          const keep = (db.rows[name] || []).filter((x) => !g.every(([k, v]) => x[k] === v));
          db.rows[name] = keep;
          db.writes.push({ op: "delete", table: name, where: g });
          return Promise.resolve({ data: [], error: err(name) }).then(fn);
        },
      };
      return r;
    },
  };
  return q;
}
const err = (name) => (db.missing === name
  ? { code: "PGRST205", message: "Could not find the table" } : null);
const match = (name, filters) =>
  (db.rows[name] || []).filter((r) => filters.every(([k, v]) => r[k] === v));
const pick = (name, filters) => match(name, filters)[0] || null;
const copy = (r) => (r ? { ...r } : r);

mock.module(atRoot("lib/supabase.js"), {
  namedExports: { admin: () => ({ from: table }), userClient: () => ({ from: table }) },
});
mock.module(atRoot("lib/auth.js"), {
  namedExports: { requireUser: async () => ({ id: "u-1", email: "zimu@8grp.co.jp" }),
                  getMemberships: async () => [] },
});
let isAdmin = true;
mock.module(atRoot("lib/gw.js"), {
  namedExports: {
    gwContext: async () => ({
      tenantId: "t1", isAdmin, roles: isAdmin ? ["owner"] : ["hr"],
      employee: { id: "emp-0", display_name: "事務 花子" },
    }),
    canManageHr: () => true,
  },
});
const logged = [];
mock.module(atRoot("lib/gw-audit.js"), {
  namedExports: { gwLog: async (e) => { logged.push(e); } },
});
const slacked = [];
mock.module(atRoot("lib/slack.js"), {
  namedExports: { notifySlack: async (m) => { slacked.push(m); } },
});

const { default: news } = await import(atRoot("api/site-news/index.js"));
const {
  sanitizeHtml, plain, makeSlug, viewState, nextSync, jstToday, prefixOf, catOf, SLUG_RE,
} = await import(atRoot("lib/site-news.js"));

const res = () => {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { try { r.body = JSON.parse(b); } catch { r.body = b; } };
  return r;
};
const req = (method, body, qs = "") => ({
  method, url: `/api/site-news${qs}`, body, headers: { authorization: "Bearer x" },
});
const call = async (r) => { const o = res(); await news(r, o); return o; };

const reset = () => {
  db.rows = { news_articles: [] };
  db.writes = []; db.missing = null;
  logged.length = 0; slacked.length = 0; isAdmin = true;
};

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log("  ok", name); };

// =============================================================================
console.log("\n== 本文の掃除：入れてはいけないもの ==");
// =============================================================================
const S = sanitizeHtml;

await ok("script は中身ごと消す", () => {
  const out = S('<p>前</p><script>alert(1)</script><p>後</p>');
  assert.equal(out, "<p>前</p><p>後</p>");
  assert.ok(!/alert/.test(out), "中身が本文として残っている");
});
await ok("style も中身ごと消す", () => {
  assert.equal(S("<style>body{display:none}</style><p>あ</p>"), "<p>あ</p>");
});
await ok("iframe・object・embed・form を消す", () => {
  for (const t of ["iframe", "object", "embed", "form", "svg", "noscript"]) {
    const out = S(`<${t}>わるいもの</${t}><p>本文</p>`);
    assert.equal(out, "<p>本文</p>", `${t} が残った`);
  }
});
await ok("onclick などの属性は落とす", () => {
  const out = S('<p onclick="alert(1)" onmouseover="x()">あ</p>');
    assert.equal(out, "<p>あ</p>");
});
await ok("javascript: のリンクは href を外す", () => {
  const out = S('<a href="javascript:alert(1)">押して</a>');
  assert.ok(!/javascript/i.test(out), out);
  assert.ok(out.includes("押して"), "文字まで消してしまっている");
});
await ok("data: のリンクも外す", () => {
  assert.ok(!/data:/.test(S('<a href="data:text/html,<script>x</script>">x</a>')));
});
await ok("大文字や空白で隠した javascript: も外す", () => {
  for (const h of ["JaVaScRiPt:alert(1)", "  javascript:alert(1)", "java\tscript:alert(1)"]) {
    const out = S(`<a href="${h}">x</a>`);
    assert.ok(!/alert/.test(out), `${h} → ${out}`);
  }
});
await ok("img は残さない（外部の読み込みを本文から作らせない）", () => {
  assert.equal(S('<img src="https://x/y.png" onerror="alert(1)">あ'), "あ");
});
await ok("script に見せかけた壊れたタグも通さない", () => {
  const out = S('<scr<script>ipt>alert(1)</script>');
  assert.ok(!/<script/i.test(out), out);
});
await ok("タグに見えない < は文字として出す", () => {
  assert.equal(S("5 < 10 かつ 10 > 5"), "5 &lt; 10 かつ 10 &gt; 5");
});
await ok("コメントは消す", () => {
  assert.equal(S("<p>あ</p><!-- ないしょ --><p>い</p>"), "<p>あ</p><p>い</p>");
});

// =============================================================================
console.log("\n== 本文の掃除：残してよいもの ==");
// =============================================================================
await ok("見出し・段落・箇条書きはそのまま", () => {
  const src = "<h2>見出し</h2>\n<p>本文です。</p>\n<ul><li>ひとつ</li><li>ふたつ</li></ul>";
  assert.equal(S(src), src);
});
await ok("太字・強調・引用・表", () => {
  const src = "<p><strong>強</strong><em>斜</em></p><blockquote><p>引用</p></blockquote>"
    + "<table><thead><tr><th>頭</th></tr></thead><tbody><tr><td>身</td></tr></tbody></table>";
  assert.equal(S(src), src);
});
await ok("http/https/mailto/tel のリンクは残る", () => {
  assert.equal(S('<a href="https://8grp.co.jp/">エイト</a>'),
               '<a href="https://8grp.co.jp/">エイト</a>');
  assert.ok(S('<a href="mailto:a@b.jp">mail</a>').includes("mailto:a@b.jp"));
  assert.ok(S('<a href="/news/blog-vol1/">中</a>').includes('href="/news/blog-vol1/"'));
});
await ok("別のタブで開くリンクには rel を付ける", () => {
  const out = S('<a href="https://x.jp/" target="_blank">x</a>');
  assert.ok(out.includes('target="_blank"'), out);
  assert.ok(out.includes('rel="noopener noreferrer"'), out);
});
await ok("書いた rel を鵜呑みにしない", () => {
  const out = S('<a href="https://x.jp/" target="_blank" rel="opener">x</a>');
  assert.ok(!out.includes('rel="opener"'), out);
});
await ok("colspan / rowspan は数だけ通す", () => {
  assert.ok(S('<table><tr><td colspan="2">あ</td></tr></table>').includes('colspan="2"'));
  assert.ok(!S('<table><tr><td colspan="abc">あ</td></tr></table>').includes("colspan"));
});
await ok("許可外のタグは、タグだけ外して文字は残す", () => {
  assert.equal(S("<div><p>中身</p></div>"), "<p>中身</p>");
  assert.equal(S("<span>ただの文字</span>"), "ただの文字");
});
await ok("br はそのまま。閉じタグを増やさない", () => {
  assert.equal(S("<p>1行目<br>2行目</p>"), "<p>1行目<br>2行目</p>");
  assert.equal(S("<p>1行目<br />2行目</p>"), "<p>1行目<br>2行目</p>");
});
await ok("閉じ忘れは、こちらで閉じる", () => {
  assert.equal(S("<p>閉じ忘れ"), "<p>閉じ忘れ</p>");
});
await ok("閉じずに次が始まっても、入れ子にしない", () => {
  // ブラウザと同じ読み方にする。入れ子にすると箇条書きが一段ずれて出る
  assert.equal(S("<ul><li>あ<li>い</ul>"), "<ul><li>あ</li><li>い</li></ul>");
  assert.equal(S("<p>あ<p>い"), "<p>あ</p><p>い</p>");
  assert.equal(S("<p>本文<h2>見出し</h2>"), "<p>本文</p><h2>見出し</h2>");
  assert.equal(S("<table><tr><td>1<td>2<tr><td>3</table>"),
               "<table><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></table>");
});
await ok("余計な閉じタグは捨てる", () => {
  assert.equal(S("<p>あ</p></p></div>"), "<p>あ</p>");
});
await ok("&amp; はそのまま。二重にしない", () => {
  assert.equal(S("<p>A&amp;B と A&B</p>"), "<p>A&amp;B と A&amp;B</p>");
});
await ok("空の本文は空", () => {
  assert.equal(S(""), "");
  assert.equal(S(null), "");
  assert.equal(S(undefined), "");
});
await ok("何度掃除しても同じ形になる", () => {
  const src = '<div onclick="x"><p>あ<a href="javascript:1" target="_blank">い</a></p><script>y</script></div>';
  const once = S(src);
  assert.equal(S(once), once, `1回目 ${once} / 2回目 ${S(once)}`);
});
await ok("長すぎる本文は切る", () => {
  const out = S("<p>" + "あ".repeat(300000) + "</p>");
  assert.ok(out.length <= 200100, out.length);
});

console.log("\n== 文字だけの欄 ==");
await ok("タイトル・概要からタグを落とす", () => {
  assert.equal(plain("<b>太い</b>題名"), "太い 題名");
  assert.equal(plain("<script>alert(1)</script>題名"), "alert(1) 題名");
});
await ok("改行と連続する空白はひとつに", () => {
  assert.equal(plain("あ\n\n  い"), "あ い");
});

console.log("\n== URL と種別 ==");
await ok("種別ごとにURLの頭が決まる", () => {
  assert.equal(prefixOf("エイトブログ"), "blog-vol");
  assert.equal(prefixOf("お知らせ"), "eight-news-vol");
  assert.equal(prefixOf("プレスリリース"), "press-vol");
  assert.equal(prefixOf("採用コラム"), "recruit-vol");
  assert.equal(prefixOf("知らない種別"), "eight-news-vol");
});
await ok("カテゴリ表示も種別で決まる", () => {
  assert.equal(catOf("エイトブログ"), "BLOG");
  assert.equal(catOf("プレスリリース"), "PRESS");
});
await ok("題名の vol.N を使う。無ければ記事番号", () => {
  assert.equal(makeSlug("エイトブログ", 153, "vol.99 のはなし"), "blog-vol99");
  assert.equal(makeSlug("エイトブログ", 153, "ふつうの題名"), "blog-vol153");
});
await ok("URL の形を確かめる", () => {
  assert.ok(SLUG_RE.test("blog-vol152"));
  assert.ok(!SLUG_RE.test("Blog-Vol152"));
  assert.ok(!SLUG_RE.test("blog vol152"));
  assert.ok(!SLUG_RE.test("../etc"));
});

console.log("\n== 状態の見せ方 ==");
await ok("公開日が先なら「公開予定」", () => {
  assert.equal(viewState({ status: "published", published_on: "2099-01-01" }).key, "planned");
  assert.equal(viewState({ status: "published", published_on: "2000-01-01" }).key, "published");
  assert.equal(viewState({ status: "draft", published_on: "2000-01-01" }).key, "draft");
});
await ok("次の同期は、翌朝8時（日本時間）", () => {
  // 日本時間 9/12 の 10:00 → 次は 9/13 08:00
  const s = nextSync(Date.parse("2026-09-12T01:00:00Z"));
  assert.equal(s.at, "2026-09-13 08:00", s.at);
  // 日本時間 9/12 の 03:00 → その日の 08:00
  assert.equal(nextSync(Date.parse("2026-09-11T18:00:00Z")).at, "2026-09-12 08:00");
});

// =============================================================================
console.log("\n== API ==");
// =============================================================================
const FULL = {
  title: "シフト調整に週5時間、中小企業のAI勤怠管理活用法",
  kind: "エイトブログ",
  summary: "シフト作成が担当者の勘に頼りきりの現場に、AIで一次案を作る手順を紹介します。",
  body: "<h2>見出し</h2><p>本文です。</p>",
};

await ok("管理者・経営者でなければ触れない", async () => {
  reset(); isAdmin = false;
  const r = await call(req("GET"));
  assert.equal(r.statusCode, 403);
});
await ok("表が無ければ、どこのSQLかを言う", async () => {
  reset(); db.missing = "news_articles";
  const r = await call(req("GET"));
  assert.equal(r.statusCode, 503);
  assert.match(r.body.message, /8grp-site/);
  assert.match(r.body.message, /articles\.sql/);
});
await ok("下書きとして書ける", async () => {
  reset();
  const r = await call(req("POST", { ...FULL, status: "draft" }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.item.status, "draft");
  assert.equal(r.body.item.slug, "blog-vol1", r.body.item.slug);
  assert.equal(r.body.item.url, "https://8grp.co.jp/news/blog-vol1/");
  assert.equal(r.body.item.source, "portal");
  assert.ok(logged.some((l) => l.action === "site_news.create"));
  assert.equal(slacked.length, 0, "下書きでは知らせない");
});
await ok("押した人の名前が残る", async () => {
  reset();
  await call(req("POST", { ...FULL, status: "draft" }));
  const row = db.rows.news_articles[0];
  assert.equal(row.created_by, "事務 花子");
  assert.equal(row.updated_by, "事務 花子");
});
await ok("タイトルが無ければ断る", async () => {
  reset();
  const r = await call(req("POST", { ...FULL, title: "" }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "no_title");
});
await ok("概要が無ければ断る（検索結果に出る文なので）", async () => {
  reset();
  const r = await call(req("POST", { ...FULL, summary: "" }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "no_summary");
});
await ok("本文が空のままでは公開できない", async () => {
  reset();
  const r = await call(req("POST", { ...FULL, body: "<p>   </p>", status: "published" }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "no_body");
});
await ok("本文は保存の前に掃除される", async () => {
  reset();
  await call(req("POST", {
    ...FULL, status: "draft",
    body: '<p onclick="x">あ</p><script>alert(1)</script><a href="javascript:1">い</a>',
  }));
  const saved = db.rows.news_articles[0].body_html;
  assert.ok(!/alert|onclick|javascript/i.test(saved), saved);
  assert.ok(saved.includes("あ") && saved.includes("い"), saved);
});
await ok("URL の形が違えば断る", async () => {
  reset();
  const r = await call(req("POST", { ...FULL, slug: "Blog Vol 1" }));
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, "bad_slug");
});
await ok("同じ URL があれば、どれとぶつかったか言う", async () => {
  reset();
  await call(req("POST", { ...FULL, slug: "blog-vol9" }));
  const r = await call(req("POST", { ...FULL, slug: "blog-vol9", title: "べつの記事" }));
  assert.equal(r.statusCode, 409);
  assert.match(r.body.hint, /シフト調整/);
});
await ok("記事番号は、いまの最大の次", async () => {
  reset();
  db.rows.news_articles = [{ id: "x", article_id: 152, slug: "blog-vol152", status: "published" }];
  const r = await call(req("POST", { ...FULL, status: "draft" }));
  assert.equal(r.body.item.articleId, 153);
  assert.equal(r.body.item.slug, "blog-vol153");
});
await ok("公開にすると、公開日が入り、Slackにも流れる", async () => {
  reset();
  const r = await call(req("POST", { ...FULL, status: "published" }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.item.publishedOn, jstToday());
  assert.equal(r.body.item.view.key, "published");
  assert.equal(slacked.length, 1);
  assert.match(slacked[0].lines.join(" "), /毎朝8時/);
  assert.ok(r.body.sync.at, "いつサイトに出るかを返す");
});
await ok("公開日を先にすると「公開予定」", async () => {
  reset();
  const r = await call(req("POST", { ...FULL, status: "published", publishedOn: "2099-12-01" }));
  assert.equal(r.body.item.view.key, "planned");
});

console.log("\n-- 直す --");
const seed = async (over = {}) => {
  reset();
  await call(req("POST", { ...FULL, status: "draft" }));
  Object.assign(db.rows.news_articles[0], over);
  return db.rows.news_articles[0];
};

await ok("下書きを直せる", async () => {
  const a = await seed();
  const r = await call(req("PATCH", { id: a.id, title: "書き直した題名", body: "<p>新しい本文</p>" }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.item.title, "書き直した題名");
  assert.equal(r.body.item.body, "<p>新しい本文</p>");
  assert.equal(r.body.item.slug, a.slug, "URL は勝手に変えない");
});
await ok("直すときも本文は掃除される", async () => {
  const a = await seed();
  await call(req("PATCH", { id: a.id, body: '<p>あ</p><script>alert(1)</script>' }));
  assert.ok(!/alert/.test(db.rows.news_articles[0].body_html));
});
await ok("公開にできる（本文は触らない）", async () => {
  const a = await seed();
  const r = await call(req("PATCH", { id: a.id, action: "publish" }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.item.status, "published");
  assert.equal(r.body.item.publishedOn, jstToday());
  assert.ok(logged.some((l) => l.action === "site_news.publish"));
  assert.equal(slacked.length, 1);
});
await ok("本文が空なら公開にさせない", async () => {
  const a = await seed({ body_html: "" });
  const r = await call(req("PATCH", { id: a.id, action: "publish" }));
  assert.equal(r.statusCode, 400);
});
await ok("下書きに戻せる（サイトから下ろすのはこれ）", async () => {
  const a = await seed({ status: "published", published_on: "2026-09-01" });
  const r = await call(req("PATCH", { id: a.id, action: "unpublish" }));
  assert.equal(r.body.item.status, "draft");
  assert.ok(logged.some((l) => l.action === "site_news.unpublish"));
});
await ok("無い記事は404", async () => {
  reset();
  const r = await call(req("PATCH", { id: "ないid", action: "publish" }));
  assert.equal(r.statusCode, 404);
});

console.log("\n-- 消す --");
await ok("公開中のものは、そのままでは消せない", async () => {
  const a = await seed({ status: "published" });
  const r = await call(req("DELETE", null, `?id=${a.id}`));
  assert.equal(r.statusCode, 409);
  assert.match(r.body.hint, /下書きに戻す/);
  assert.equal(db.rows.news_articles.length, 1, "消えてしまっている");
});
await ok("下書きは消せる", async () => {
  const a = await seed();
  const r = await call(req("DELETE", null, `?id=${a.id}`));
  assert.equal(r.statusCode, 200);
  assert.equal(db.rows.news_articles.length, 0);
  assert.ok(logged.some((l) => l.action === "site_news.delete"));
});

console.log("\n-- 一覧 --");
await ok("状態ごとの数を返す", async () => {
  reset();
  db.rows.news_articles = [
    { id: "a", slug: "s1", title: "下書き", kind: "エイトブログ", status: "draft" },
    { id: "b", slug: "s2", title: "公開中", kind: "エイトブログ", status: "published",
      published_on: "2020-01-01" },
    { id: "c", slug: "s3", title: "公開予定", kind: "エイトブログ", status: "published",
      published_on: "2099-01-01" },
  ];
  const r = await call(req("GET"));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.counts, { draft: 1, planned: 1, published: 1 });
  assert.ok(r.body.kinds.length >= 6, "種別の一覧も返す");
  assert.ok(r.body.sync.at, "次の同期も返す");
});
await ok("Notion から来たものも一覧に出る", async () => {
  reset();
  db.rows.news_articles = [{ id: "a", slug: "blog-vol152", title: "取り込んだ記事",
    kind: "エイトブログ", status: "published", published_on: "2026-08-30", source: "notion" }];
  const r = await call(req("GET"));
  assert.equal(r.body.items[0].source, "notion");
  assert.equal(r.body.items[0].url, "https://8grp.co.jp/news/blog-vol152/");
});

console.log(`\n合計 ${n} 件 通過`);
