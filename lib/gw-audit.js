// 社内の操作ログ（gw_activity_log）。
//
// 会計側の audit_log とは別テーブルにしている。audit_log は顧問先ロールの
// ユーザーからも読めるため、人事や権限の操作を混ぜると社外に漏れる。
//
// 何を残すか
//   後から「誰がいつ変えたか」を追えないと困るものだけを残す。
//   具体的には、権限の付け外し・アカウントの作成と紐づけ・社員の在籍状態・
//   人事書類の社労士への共有可否・会社設定の変更。
//   一覧の閲覧やメッセージの本文は残さない（量が多く、追跡の役にも立たない）。
//
// 書き込みは失敗しても本処理を止めない。ログが残らないことより、
// 操作そのものが通らないことのほうが困るため。

import { admin } from "./supabase.js";

/**
 * @param {object} entry { tenantId, actorId, action, target?, detail? }
 */
export async function gwLog(entry) {
  if (!entry?.action) return;
  try {
    await admin().from("gw_activity_log").insert({
      tenant_id: entry.tenantId ?? null,
      actor_id: entry.actorId ?? null,
      action: entry.action,
      target: entry.target ?? null,
      detail: entry.detail ?? null,
    });
  } catch (e) {
    console.error("[gw-audit] failed:", e?.message || e);
  }
}
