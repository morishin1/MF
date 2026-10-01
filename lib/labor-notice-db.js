// 労働条件通知書（db/110_labor_notices.sql）を、表から読む部品。API（管理側・本人側）が同じ読み方をする。
//
// ■ 表が無い（未適用）ときは、落とさない
//   linked: false を返す。画面は「データ未連携」と出し、ほかの入社の機能は止めない。
//
// ■ storage_path は、画面へ返さない
//   署名付きURLを作るために、サーバの中でだけ使う（NOTICE_COLS_FILE）。応答には載せない。

import { dbSetupHint } from "./http.js";
import { NOTICE_BUCKET, NOTICE_TTL } from "./labor-notice.js";

export const NOTICE_SQL = "db/110_labor_notices.sql";
export const NOTICE_COLS =
  "id, tenant_id, employee_id, version, filename, size_bytes, sha256, uploaded_by, uploaded_at, "
  + "published_by, published_at, confirmed_by, confirmed_at";
export const NOTICE_COLS_FILE = `${NOTICE_COLS}, storage_path`;

/**
 * その人の通知書の版を、全部読む（順不同）。
 * @returns {Promise<{rows:object[], linked:boolean, error:object|null}>}
 */
export async function loadNoticeRows(sb, tenantId, employeeId, cols = NOTICE_COLS) {
  const { data, error } = await sb.from("gw_labor_notices").select(cols)
    .eq("tenant_id", tenantId).eq("employee_id", employeeId).order("version", { ascending: false });
  if (error) return { rows: [], linked: !dbSetupHint(error, NOTICE_SQL), error };
  return { rows: data || [], linked: true, error: null };
}

/**
 * 電子署名の流れにいるか。
 *   esign … 有効な署名依頼（gw_sign_requests・労働条件・取り消し以外）がある。あるあいだは、通知書の確認で締結扱いにしない
 *   order … 社労士への作成依頼（gw_doc_orders・取り消し以外）がある（経営ハブの数え方と、管理側の注意に使う）
 * 表が無い会社（電子署名を使っていない）は、どちらも false
 */
export async function esignState(sb, tenantId, employeeId) {
  const soft = async (q) => { try { const r = await q; return r?.error ? [] : (r?.data || []); } catch { return []; } };
  const [signs, orders] = await Promise.all([
    soft(sb.from("gw_sign_requests").select("id, status").eq("tenant_id", tenantId).eq("employee_id", employeeId)
      .eq("doc_kind", "employment").neq("status", "cancelled").limit(1)),
    soft(sb.from("gw_doc_orders").select("id, status").eq("tenant_id", tenantId).eq("employee_id", employeeId)
      .eq("doc_kind", "employment").neq("status", "cancelled").limit(1)),
  ]);
  return { esign: signs.length > 0, signStatus: signs[0]?.status || null, order: orders.length > 0 };
}

/** 閲覧用の署名付きURL（数分だけ有効）。URL は、DB・監査ログ・console に残さない */
export async function signedNoticeUrl(sb, path, { download } = {}) {
  const { data, error } = await sb.storage.from(NOTICE_BUCKET)
    .createSignedUrl(path, NOTICE_TTL, download ? { download } : undefined);
  if (error || !data?.signedUrl) return { url: null, error: error?.message || "no_url" };
  return { url: data.signedUrl, error: null };
}
