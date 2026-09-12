// GET    /api/site-news            … お知らせの一覧（下書きも含む）
// POST   /api/site-news            … 新しく書く
// PATCH  /api/site-news {id, …}    … 直す／公開する／下書きに戻す
// DELETE /api/site-news?id=…       … 消す
//
// 自社サイト（8grp.co.jp）のお知らせ。保存先はもとからある public.news_articles で、
// 毎朝8時の同期（8grp-site の news-sync）が公開中の行を読んでページを作る。
//
// ■ 表は作らない
//   8grp-site の 8/zimu/news/articles.sql で既にある。同じ行を同じ形で書く。
//   別の表を作ると、同じお知らせが2か所にできて、どちらが正か分からなくなる。
//
// ■ 本文はサーバで掃除してから入れる
//   同期スクリプトは body_html をエスケープせずにページへ入れる。
//   つまりここに入った HTML は、そのまま 8grp.co.jp で動く。
//   ブラウザ側の掃除は、画面を通らない書き込みには効かないので、
//   この口を通るものは必ず lib/site-news.js の sanitizeHtml を通す。
//
// ■ 押した人を残す
//   表の created_by / updated_by は文字列なので名前を入れ、
//   誰のアカウントが押したかは gw_activity_log 側に残す。

import { json, readJson, methodNotAllowed, dbSetupHint } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { gwLog } from "../../lib/gw-audit.js";
import { notifySlack } from "../../lib/slack.js";
import {
  KINDS, KIND_KEYS, catOf, makeSlug, SLUG_RE, sanitizeHtml, plain,
  viewState, urlOf, jstToday, nextSync, MAX_BODY,
} from "../../lib/site-news.js";

const TABLE = "news_articles";
// この表は 8grp-site 側で作る。mf には流すものが無い
const SQL = "8grp-site の 8/zimu/news/articles.sql";
const FIELDS =
  "id, article_id, slug, title, kind, summary, body_html, status, "
  + "published_on, notion_url, source, created_by, updated_by, created_at, updated_at";

// サイトに出るものなので、経営者・管理者だけ。人事の権限では触れない
const canManage = (ctx) => ctx.isAdmin || ctx.roles.includes("owner");

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!canManage(ctx)) return json(res, 403, { error: "forbidden" });

  if (req.method === "GET") return list(req, res);
  if (req.method === "POST") return create(req, res, ctx, user);
  if (req.method === "PATCH") return update(req, res, ctx, user);
  if (req.method === "DELETE") return remove(req, res, ctx, user);
  return methodNotAllowed(res, ["GET", "POST", "PATCH", "DELETE"]);
}

const shape = (a) => ({
  id: a.id,
  articleId: a.article_id,
  slug: a.slug,
  title: a.title,
  kind: a.kind,
  cat: catOf(a.kind),
  summary: a.summary || "",
  body: a.body_html || "",
  status: a.status,
  view: viewState(a),
  publishedOn: a.published_on,
  notionUrl: a.notion_url,
  // portal … この画面か事務ポータルで書いた / notion … Notion から取り込んだ
  source: a.source,
  createdBy: a.created_by,
  updatedBy: a.updated_by,
  updatedAt: a.updated_at,
  url: urlOf(a.slug),
});

// ---- 一覧 ---------------------------------------------------------------------
async function list(req, res) {
  const sb = admin();
  const q = new URL(req.url, "http://localhost").searchParams;

  let query = sb.from(TABLE).select(FIELDS)
    .order("published_on", { ascending: false, nullsFirst: false })
    .limit(500);
  if (q.get("status") === "draft" || q.get("status") === "published") {
    query = query.eq("status", q.get("status"));
  }

  const { data, error } = await query;
  if (error) {
    const hint = dbSetupHint(error, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: error.message });
  }

  const items = (data || []).map(shape);
  return json(res, 200, {
    items,
    counts: {
      draft: items.filter((a) => a.view.key === "draft").length,
      planned: items.filter((a) => a.view.key === "planned").length,
      published: items.filter((a) => a.view.key === "published").length,
    },
    kinds: KINDS,
    // 「公開にしたのにサイトに出ない」と言われないように、次の同期を出す
    sync: nextSync(),
    today: jstToday(),
    maxBody: MAX_BODY,
  });
}

// ---- 書く ---------------------------------------------------------------------
async function create(req, res, ctx, user) {
  const body = await readJson(req);
  const sb = admin();

  const built = await build(sb, body, null);
  if (built.error) return json(res, built.status || 400, built);

  // 記事番号がぶつかったら採り直す。
  // 2人が同時に「新しく書く」を押すと、同じ番号を見てしまう
  let saved = null;
  let lastErr = null;
  for (let n = 0; n < 3; n++) {
    const row = {
      ...built.row,
      article_id: built.row.article_id + n,
      source: "portal",
      created_by: who(ctx),
      updated_by: who(ctx),
    };
    if (n > 0 && !body.slug) row.slug = makeSlug(row.kind, row.article_id, row.title);

    const { data, error } = await sb.from(TABLE).insert(row).select(FIELDS).single();
    if (!error) { saved = data; break; }
    lastErr = error;
    if (error.code !== "23505") break;      // 一意制約以外は、採り直しても直らない
  }
  if (!saved) {
    const hint = dbSetupHint(lastErr, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    if (lastErr?.code === "23505") {
      return json(res, 409, { error: "duplicate", hint: "同じ URL のお知らせがあります" });
    }
    return json(res, 500, { error: "db_insert_failed", detail: lastErr?.message });
  }

  await log(ctx, user, saved, saved.status === "published" ? "publish" : "create");
  if (saved.status === "published") await tellSlack(saved);
  return json(res, 200, { item: shape(saved), sync: nextSync() });
}

// ---- 直す・公開する・下書きに戻す ---------------------------------------------
async function update(req, res, ctx, user) {
  const body = await readJson(req);
  if (!body?.id) return json(res, 400, { error: "invalid_body", required: ["id"] });

  const sb = admin();
  const { data: cur, error: e1 } = await sb.from(TABLE).select(FIELDS)
    .eq("id", body.id).maybeSingle();
  if (e1) {
    const hint = dbSetupHint(e1, SQL);
    if (hint) return json(res, 503, { error: "not_ready", message: hint });
    return json(res, 500, { error: "db_query_failed", detail: e1.message });
  }
  if (!cur) return json(res, 404, { error: "not_found" });

  // 公開・下書きの切り替えだけのとき。本文は触らない
  if (body.action === "publish" || body.action === "unpublish") {
    const status = body.action === "publish" ? "published" : "draft";
    if (status === "published" && !plain(cur.body_html)) {
      return json(res, 400, { error: "no_body", hint: "本文が空のままでは公開できません" });
    }
    const patch = { status, updated_by: who(ctx) };
    // 公開日が入っていなければ今日。入れずに公開すると、一覧の並びが崩れる
    if (status === "published" && !cur.published_on) patch.published_on = jstToday();

    const { data, error } = await sb.from(TABLE).update(patch)
      .eq("id", cur.id).select(FIELDS).single();
    if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });

    await log(ctx, user, data, body.action);
    if (status === "published") await tellSlack(data);
    return json(res, 200, { item: shape(data), sync: nextSync() });
  }

  const built = await build(sb, body, cur);
  if (built.error) return json(res, built.status || 400, built);

  const { data, error } = await sb.from(TABLE)
    .update({ ...built.row, updated_by: who(ctx) })
    .eq("id", cur.id).select(FIELDS).single();
  if (error) {
    if (error.code === "23505") {
      return json(res, 409, { error: "duplicate", hint: "同じ URL のお知らせがあります" });
    }
    return json(res, 500, { error: "db_update_failed", detail: error.message });
  }

  const wentLive = cur.status !== "published" && data.status === "published";
  await log(ctx, user, data, wentLive ? "publish" : "update");
  if (wentLive) await tellSlack(data);
  return json(res, 200, { item: shape(data), sync: nextSync() });
}

// ---- 消す ---------------------------------------------------------------------
async function remove(req, res, ctx, user) {
  const id = new URL(req.url, "http://localhost").searchParams.get("id");
  if (!id) return json(res, 400, { error: "invalid_query", required: ["id"] });

  const sb = admin();
  const { data: cur } = await sb.from(TABLE).select(FIELDS).eq("id", id).maybeSingle();
  if (!cur) return json(res, 404, { error: "not_found" });

  // 公開中のものを消すと、同期は「もう出さない」を知る手がかりを失う。
  // Notion から取り込んだ記事なら、翌朝また出てしまう
  if (cur.status === "published") {
    return json(res, 409, {
      error: "still_published",
      hint: "先に「下書きに戻す」を押してください。公開中のまま消すと、サイトから下りません",
    });
  }

  const { error } = await sb.from(TABLE).delete().eq("id", id);
  if (error) return json(res, 500, { error: "db_delete_failed", detail: error.message });

  await log(ctx, user, cur, "delete");
  return json(res, 200, { ok: true });
}

// ---- 中身をそろえる -----------------------------------------------------------
/**
 * 画面から来たものを、表に入れる形にする。
 * 本文の掃除も、URL の重複も、ここで通す。
 * cur が null なら新しく書くとき
 */
async function build(sb, body, cur) {
  const title = plain(body.title ?? cur?.title, 200);
  if (!title) return { error: "no_title", hint: "タイトルを入れてください" };

  const summary = plain(body.summary ?? cur?.summary, 400);
  if (!summary) {
    return { error: "no_summary", hint: "概要を入れてください。検索結果に出る文です" };
  }

  const kind = KIND_KEYS.includes(body.kind) ? body.kind
    : (cur?.kind && KIND_KEYS.includes(cur.kind) ? cur.kind : KIND_KEYS[0]);

  const status = body.status === "published" ? "published" : "draft";

  const rawBody = body.body ?? cur?.body_html ?? "";
  if (String(rawBody).length > MAX_BODY) {
    return { error: "too_long", hint: `本文が長すぎます（${MAX_BODY.toLocaleString()}文字まで）` };
  }
  const html = sanitizeHtml(rawBody);
  if (status === "published" && !plain(html)) {
    return { error: "no_body", hint: "本文が空のままでは公開できません" };
  }

  const publishedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.publishedOn || ""))
    ? body.publishedOn
    : (cur?.published_on || (status === "published" ? jstToday() : null));

  // 記事番号。新しく書くときだけ採る
  let articleId = cur?.article_id || 0;
  if (!articleId) {
    const { data } = await sb.from(TABLE).select("article_id")
      .order("article_id", { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    articleId = (data?.article_id || 0) + 1;
  }

  let slug = String(body.slug || "").trim().toLowerCase();
  if (!slug) slug = cur?.slug || makeSlug(kind, articleId, title);
  if (!SLUG_RE.test(slug)) {
    return { error: "bad_slug", hint: "URL は英小文字・数字・ハイフンだけで入れてください" };
  }

  // 同じ URL が無いか。表の一意制約にも当たるが、
  // 先に見たほうが「どれとぶつかったか」を出せる
  const { data: dup } = await sb.from(TABLE).select("id, title").eq("slug", slug).maybeSingle();
  if (dup && dup.id !== cur?.id) {
    return { error: "duplicate", status: 409,
             hint: `同じ URL のお知らせがあります（${dup.title}）` };
  }

  return {
    row: {
      article_id: articleId,
      slug, title, kind, summary,
      body_html: html,
      status,
      published_on: publishedOn,
    },
  };
}

// ---- 記録 ---------------------------------------------------------------------
const who = (ctx) => ctx.employee?.display_name || "mf";

const ACTION_LABEL = {
  create: "下書きを作りました", update: "直しました",
  publish: "公開にしました", unpublish: "下書きに戻しました", delete: "消しました",
};

async function log(ctx, user, row, action) {
  await gwLog({
    tenantId: ctx.tenantId, actorId: user.id,
    action: `site_news.${action}`,
    target: `news_article:${row.id}`,
    detail: { slug: row.slug, title: row.title, kind: row.kind, status: row.status },
  });
}

/** 公開にしたときだけ知らせる。サイトに出るものなので、気づける場所に流す */
async function tellSlack(row) {
  const on = String(row.published_on || "").slice(0, 10);
  await notifySlack({
    text: `:newspaper: サイトのお知らせを公開にしました　${row.title}`,
    lines: [
      `${row.kind}　${on}${on > jstToday() ? "（公開予定）" : ""}`,
      urlOf(row.slug),
      `サイトに出るのは次の同期（毎朝8時）です`,
    ],
    link: "admin-site-news.html",
  });
}
