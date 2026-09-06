// GET  /api/nippo/feed?date=YYYY-MM-DD … みんなの日報（AIが作った共有サマリー）
// POST /api/nippo/feed {shareId, action:"react"}    … 「参考になった」を押す／取り消す
// POST /api/nippo/feed {shareId, action:"comment", body} … ひとことコメント
// POST /api/nippo/feed {shareId, action:"visible", visible} … 自分のぶんを出す／隠す
//
// ■ 出すのは共有用サマリーだけ
//   日報そのもの（tc_nippo）はここでは一切読まない。
//   読むのは gw_nippo_shares で、この表には公開してよい4項目
//   （今日やったこと・成果・学び・明日やること）しか列が無い。
//
//   点数・未達理由・相談事項・個人評価・管理者コメントは、
//   「返さないようにしている」のではなく「この表に入っていない」。
//   選択の書き間違い1つで全部出てしまう、という状態にしない。
//
// ■ 誰が押したかは名前まで出す
//   社内なので匿名にする理由がなく、匿名だと「参考になった」の意味が薄れる。
//   ただし、押した数で人を並べることはしない（ランキングにしない）。

import { json, readJson, methodNotAllowed } from "../../lib/http.js";
import { requireUser } from "../../lib/auth.js";
import { gwContext } from "../../lib/gw.js";
import { admin } from "../../lib/supabase.js";
import { jstDate, isDate } from "../../lib/nippo.js";

const MAX_COMMENT = 400;

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  const ctx = await gwContext(user.id);
  if (!ctx.tenantId) return json(res, 403, { error: "no_membership" });
  if (!ctx.employee) return json(res, 403, { error: "no_employee" });

  if (req.method === "GET") return read(req, res, user, ctx);
  if (req.method === "POST") {
    const body = await readJson(req);
    if (!body?.shareId) return json(res, 400, { error: "invalid_body", required: ["shareId"] });
    if (body.action === "react")   return react(res, user, ctx, body);
    if (body.action === "comment") return comment(res, user, ctx, body);
    if (body.action === "visible") return setVisible(res, user, ctx, body);
    return json(res, 400, { error: "unknown_action" });
  }
  return methodNotAllowed(res, ["GET", "POST"]);
}

// ---- 一覧 -------------------------------------------------------------------
async function read(req, res, user, ctx) {
  const q = new URL(req.url, "http://localhost").searchParams;
  const date = isDate(q.get("date")) ? q.get("date") : jstDate();
  const sb = admin();

  const { data: shares } = await sb.from("gw_nippo_shares")
    .select("*")
    .eq("tenant_id", ctx.tenantId).eq("work_date", date)
    .order("created_at", { ascending: true }).limit(300);

  const list = (shares || [])
    // 本人が隠したものは、本人にだけ見える
    .filter((s) => s.visible || s.user_id === user.id);
  const ids = list.map((s) => s.id);

  let reactions = [];
  let comments = [];
  if (ids.length) {
    const [r, c] = await Promise.all([
      sb.from("gw_nippo_reactions").select("share_id, user_id, user_name")
        .in("share_id", ids).limit(3000),
      sb.from("gw_nippo_comments").select("*")
        .in("share_id", ids).order("created_at").limit(1000),
    ]);
    reactions = r.data || [];
    comments = c.data || [];
  }

  const byShare = (rows) => {
    const m = new Map(ids.map((i) => [i, []]));
    for (const x of rows) if (m.has(x.share_id)) m.get(x.share_id).push(x);
    return m;
  };
  const rBy = byShare(reactions);
  const cBy = byShare(comments);

  return json(res, 200, {
    date,
    me: { userId: user.id, name: ctx.employee.display_name },
    // ここで返している列が、公開してよいものの全部
    items: list.map((s) => ({
      id: s.id,
      userId: s.user_id,
      name: s.user_name,
      workDate: s.work_date,
      did: s.did,
      result: s.result,
      learn: s.learn,
      tomorrow: s.tomorrow,
      mine: s.user_id === user.id,
      visible: s.visible,
      helpful: (rBy.get(s.id) || []).length,
      helpfulBy: (rBy.get(s.id) || []).map((x) => x.user_name).filter(Boolean),
      reacted: (rBy.get(s.id) || []).some((x) => x.user_id === user.id),
      comments: (cBy.get(s.id) || []).map((x) => ({
        id: x.id, name: x.user_name, body: x.body,
        mine: x.user_id === user.id, createdAt: x.created_at,
      })),
    })),
  });
}

/** 対象の共有が、自分の会社のものかを確かめる。他社のidを渡されても動かさない */
async function shareOf(sb, ctx, shareId) {
  const { data } = await sb.from("gw_nippo_shares")
    .select("id, user_id, tenant_id").eq("id", shareId).maybeSingle();
  return data && data.tenant_id === ctx.tenantId ? data : null;
}

// ---- 「参考になった」。もう一度押すと取り消す --------------------------------
async function react(res, user, ctx, body) {
  const sb = admin();
  const share = await shareOf(sb, ctx, body.shareId);
  if (!share) return json(res, 404, { error: "share_not_found" });

  const { data: existing } = await sb.from("gw_nippo_reactions")
    .select("id").eq("share_id", share.id).eq("user_id", user.id)
    .eq("kind", "helpful").maybeSingle();

  if (existing) {
    await sb.from("gw_nippo_reactions").delete().eq("id", existing.id);
    return json(res, 200, { ok: true, reacted: false });
  }

  const { error } = await sb.from("gw_nippo_reactions").insert({
    share_id: share.id,
    user_id: user.id,                       // 画面から来た値は使わない
    user_name: ctx.employee.display_name,
    kind: "helpful",
  });
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });
  return json(res, 200, { ok: true, reacted: true });
}

// ---- ひとことコメント ---------------------------------------------------------
async function comment(res, user, ctx, body) {
  const text = String(body.body ?? "").trim().slice(0, MAX_COMMENT);
  if (!text) return json(res, 400, { error: "empty", hint: "コメントを入力してください" });

  const sb = admin();
  const share = await shareOf(sb, ctx, body.shareId);
  if (!share) return json(res, 404, { error: "share_not_found" });

  const { data, error } = await sb.from("gw_nippo_comments").insert({
    share_id: share.id,
    user_id: user.id,
    user_name: ctx.employee.display_name,
    body: text,
  }).select("*").single();
  if (error) return json(res, 500, { error: "db_insert_failed", detail: error.message });

  return json(res, 200, {
    ok: true,
    comment: { id: data.id, name: data.user_name, body: data.body, mine: true, createdAt: data.created_at },
  });
}

// ---- 自分のぶんを出す／隠す ----------------------------------------------------
// 出したくない日を1日も作れないと、書く内容のほうが薄くなる
async function setVisible(res, user, ctx, body) {
  const sb = admin();
  const share = await shareOf(sb, ctx, body.shareId);
  if (!share) return json(res, 404, { error: "share_not_found" });
  if (share.user_id !== user.id) {
    return json(res, 403, { error: "forbidden", hint: "自分の日報だけ切り替えられます" });
  }

  const { error } = await sb.from("gw_nippo_shares")
    .update({ visible: body.visible !== false, updated_at: new Date().toISOString() })
    .eq("id", share.id);
  if (error) return json(res, 500, { error: "db_update_failed", detail: error.message });
  return json(res, 200, { ok: true, visible: body.visible !== false });
}
