// 電子署名の監査ログ。
//
// 「送った・開いた・署名した・落とした」を、そのつど1行足す。
// 更新も削除もしない。あとから見て、話の食い違いを埋められるようにするためのもの。
//
// api の中に置かなかったのは、api/ の下のファイルは Vercel では
// それぞれが1つの関数になるため。関数どうしで import し合うと、
// 片方に入れたつもりのフォント（6MB）がもう片方にも付いてくる。

import { admin } from "./supabase.js";

/**
 * @param {object} ctx    gwContext の結果（tenantId を使う）
 * @param {string} requestId gw_sign_requests.id
 * @param {"created"|"sent"|"viewed"|"signed"|"resent"|"cancelled"|"downloaded"} action
 * @param {object} req    Node の req（IP・ブラウザを取るため）
 * @param {{id?:string, name?:string}} actor
 * @param {object|null} detail
 */
export async function signEvent(ctx, requestId, action, req, actor, detail) {
  try {
    await admin().from("gw_sign_events").insert({
      tenant_id: ctx.tenantId,
      request_id: requestId,
      action,
      actor_id: actor?.id || null,
      actor_name: actor?.name || null,
      ip: ipOf(req),
      user_agent: uaOf(req),
      detail: detail || null,
    });
  } catch (e) {
    // ログが残らなくても、署名そのものは止めない。
    // 記録が1行欠けることより、署名できないことのほうが困る
    console.error("[sign] 監査ログを残せませんでした:", e?.message || e);
  }
}

/** 前段のプロキシを通るので、x-forwarded-for の先頭を見る */
export const ipOf = (req) =>
  String(req?.headers?.["x-forwarded-for"] || req?.socket?.remoteAddress || "")
    .split(",")[0].trim().slice(0, 64) || null;

export const uaOf = (req) =>
  String(req?.headers?.["user-agent"] || "").slice(0, 300) || null;
