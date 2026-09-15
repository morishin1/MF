// 機密個人情報に触れたことを残す。
//
// ■ 何を残すか
//
//   誰が・いつ・誰のぶんを・何を・どうした（見た／落とした／変えた／消した）。
//   gw_activity_log は「操作」の記録で、閲覧は残していなかった。
//   届出の住所や口座、提出書類、契約書は、見ただけでも残す。
//   閲覧の記録が無い仕組みは、本人から見れば監視ではなく放置に見える。
//
// ■ 本人が自分のぶんを見たときは残さない
//
//   自分の届出を自分で見るのは当然のことで、それまで残すと
//   本当に見てほしい行（他人が見た）が埋もれる。
//
// ■ ここで落ちても、元の操作は止めない
//
//   070 をまだ流していない環境で、書類が開けなくなるほうが困る。
//   ただし console には出す。残っていないことに気づけるように。

import { admin } from "./supabase.js";

export const KINDS = ["profile", "bank", "file", "contract", "mynumber", "export"];
export const ACTIONS = ["view", "download", "update", "delete", "export"];

/**
 * @param {object} e
 *   tenantId    事業者
 *   actor       { id, name }   誰が（auth.users.id と表示名）
 *   subjectId   誰のぶんか（gw_employees.id）。本人なら残さない判定に使う
 *   selfId      見ている人自身の gw_employees.id（あれば）
 *   kind        KINDS のどれか
 *   action      ACTIONS のどれか
 *   target      'file:<uuid>' など
 *   detail      任意
 *   req         あれば IP と UA を取る
 */
export async function logSensitive(e) {
  if (!e?.tenantId || !e?.kind || !e?.action) return;
  if (e.selfId && e.subjectId && e.selfId === e.subjectId) return;   // 自分のぶん
  try {
    const { error } = await admin().from("gw_sensitive_access_log").insert({
      tenant_id: e.tenantId,
      actor_id: e.actor?.id ?? null,
      actor_name: e.actor?.name ?? null,
      subject_id: e.subjectId ?? null,
      kind: e.kind,
      action: e.action,
      target: e.target ?? null,
      detail: e.detail ?? null,
      ip: e.req ? ipOf(e.req) : null,
      user_agent: e.req ? uaOf(e.req) : null,
    });
    if (error) throw error;
  } catch (err) {
    console.error("[sensitive-log] 残せませんでした:", err?.message || err);
  }
}

/** 複数人ぶんをまとめて残す（一覧で開いたとき）。自分のぶんは除く */
export async function logSensitiveMany(base, subjectIds) {
  const ids = [...new Set((subjectIds || []).filter((id) => id && id !== base.selfId))];
  if (!ids.length) return;
  try {
    const { error } = await admin().from("gw_sensitive_access_log").insert(ids.map((id) => ({
      tenant_id: base.tenantId,
      actor_id: base.actor?.id ?? null,
      actor_name: base.actor?.name ?? null,
      subject_id: id,
      kind: base.kind,
      action: base.action,
      target: base.target ?? null,
      detail: base.detail ?? null,
      ip: base.req ? ipOf(base.req) : null,
      user_agent: base.req ? uaOf(base.req) : null,
    })));
    if (error) throw error;
  } catch (err) {
    console.error("[sensitive-log] 残せませんでした:", err?.message || err);
  }
}

export const ipOf = (req) =>
  String(req?.headers?.["x-forwarded-for"] || req?.headers?.["x-real-ip"] || "")
    .split(",")[0].trim().slice(0, 64) || null;

export const uaOf = (req) => String(req?.headers?.["user-agent"] || "").slice(0, 300) || null;
